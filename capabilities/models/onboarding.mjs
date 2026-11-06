import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { guideReply, looksLikeSecret, option } from './guide.mjs';
import { fail, within } from '../shared/validation.mjs';
import { probeRemoteOrigin, readRemoteAccess, registerCustomRemote } from '../../scripts/installation/remote-config.mjs';
import { applyRemote, prepareRemote, remoteStatus } from '../../scripts/installation/remote-access.mjs';
import { startRemoteBridge, stopRemoteBridge } from '../../scripts/installation/auxiliaries.mjs';

const engines = new Map([
  ['codex', { id: 'codex-cli', name: 'Codex' }],
  ['grok', { id: 'grok', name: 'Grok' }],
  ['claude-code', { id: 'claude-code', name: 'Claude Code' }],
]);
const remoteProviders = new Map([['tailscale', 'Tailscale Serve'], ['cloudflare', 'Cloudflare Tunnel'], ['custom', '临时访问或其他方案']]);
const guideSource = 'summon:onboarding';
const localOnly = option('先只在这台电脑上用', 'local-only');
const usePi = option('先用内置 Pi', 'use-pi');

function question(step) {
  if (step === 'engine') return '我是你的主 Bot，可以帮你把事交给能独立执行的工作同伴，比如查资料、改代码、整理文件、定时提醒，做完结果会直接回到这里。你现在是用 Codex、Grok，还是 Claude Code？';
  if (step === 'codex') return '允许我使用这台电脑上已登录的 Codex 订阅执行工作吗？确认后，我会在每次工作时自动创建独立会话，完成后把结果带回这里。';
  if (engines.has(step)) {
    const { name } = engines.get(step);
    return '请在运行 Summon Bot 的电脑上安装并登录 ' + (step === 'grok' ? 'Grok Build' : name) + '，然后在这条消息里确认接入。';
  }
  if (step === 'remote') return '你想从手机或另一台电脑访问这个工作区吗？还是先只在这台电脑上用？';
  if (step === 'remote-provider') return '你想使用 Tailscale、Cloudflare，还是先开一个临时入口？也可以直接告诉我其他远程方案，我来配置。';
  if (step === 'custom') return '我来准备远程入口。可以先用临时地址，也可以直接告诉我你想用的方案，需要的桥接脚本由我来处理。';
  return '我来配置 ' + remoteProviders.get(step) + '。我会先检查这台电脑的安装和登录情况，遇到问题会继续修复，需要你登录时会在这里告诉你。';
}

function typedChoice(guide, text) {
  const answer = text.toLowerCase().trim().replace(/[。！!.]+$/, '');
  const direct = guide.options.find(choice => choice.label.toLowerCase() === answer);
  if (direct) return direct.action;
  if (guide.step === 'engine') return ({ codex: 'codex', grok: 'grok', 'grok build': 'grok', 'claude code': 'claude-code', claudecode: 'claude-code' })[answer.replace(/^(?:我)?(?:想用|用|选|选择)\s*/, '')];
  if (guide.step === 'remote' || guide.step === 'remote-provider') {
    if (/^(?:先)?(?:不用|只在本机(?:用|使用)?|不需要远程|跳过)$/.test(answer)) return 'local-only';
    if (guide.step === 'remote' && /^(?:要|需要|可以|想)$/.test(answer)) return 'remote-provider';
  }
  return null;
}

export class OnboardingService {
  constructor({ store, models, manager, chatroom, emit, ensureSetupAccess }) { Object.assign(this, { store, models, manager, chatroom, emit, ensureSetupAccess }); }

  async initialize() {
    const saved = this.record();
    if (!saved) {
      const model = this.models.runtimeModel();
      const configured = model && (model.allowNoKey || await this.models.credentials.read(model.id).catch(() => null));
      this.save({ status: configured ? 'complete' : 'pending', reason: configured ? 'existing-model' : 'first-run' });
    } else if (saved.roomId && !saved.questionId && ['starting', 'guiding', 'paused', 'failed'].includes(saved.status)) {
      this.save({ status: saved.status === 'paused' ? 'paused' : 'guiding', step: 'engine', questionId: randomUUID(), error: null, script: null });
    }
    return this;
  }

  record() { return this.store.get('onboarding', 'main'); }
  save(value) {
    const result = this.store.save('onboarding', { id: 'main', ...value });
    this.emit('onboarding.changed', {});
    return result;
  }
  bot() { return this.manager.list().find(entry => entry.presetId === 'entry' || entry.id === 'bot-entry'); }

  state() {
    const { status, roomId, step, questionId, error } = this.record();
    const bot = this.bot();
    return { required: status === 'pending', status, roomId: roomId || null,
      step: step || null, questionId: questionId || null, error: error || null,
      bot: { id: bot?.id || 'bot-entry', name: bot?.name || '主 Bot' } };
  }

  async snapshot() {
    const state = await this.publicState();
    const modelSettings = await this.models.snapshot();
    return { ...state, modelSettings, configured: modelSettings.connections.some(entry => entry.active && entry.configured) };
  }

  async publicState() {
    const state = this.state();
    await this.ensureQuestion(state);
    return { ...state, guide: await this.guide(state) };
  }

  async ensureQuestion(state = this.state()) {
    if (state.status !== 'guiding' || !state.questionId || this.chatroom.store.get('messages', state.questionId)) return;
    await this.chatroom.append(state.roomId, { id: state.questionId, content: question(state.step), sourceRefs: [guideSource] }, state.bot.id);
  }

  async guide(state = this.state()) {
    if (state.status !== 'guiding') return null;
    const { step, questionId, error } = state;
    const setup = this.record().setup;
    const work = setup?.questionId === questionId && await this.manager.readState(state.bot.id, db => db?.getRecord('works', setup.workId));
    let options, localControl;
    if (step === 'engine') options = [...engines].map(([action, { name }]) => option(name, action));
    else if (step === 'remote') options = [option('配置远程访问', 'remote-provider'), localOnly];
    else if (step === 'remote-provider') options = [...remoteProviders].map(([action, name]) => option(name, action)).concat(localOnly);
    else if (engines.has(step)) {
      options = [option(setup?.questionId === questionId ? '继续配置 ' + engines.get(step).name
        : step === 'codex' ? '同意并接入 Codex' : '确认接入 ' + engines.get(step).name, 'connect-engine'), usePi];
    } else if (remoteProviders.has(step)) {
      const entry = (await readRemoteAccess(this.models.dataRoot))[step];
      localControl = { provider: step, origin: !entry?.pending && entry?.origin || null };
      options = localControl.origin ? [option('完成引导', 'next')] : [option('继续配置', 'check'), localOnly];
    } else return null;
    return { step, text: question(step), options, localControl, messageId: questionId, error,
      setup: setup?.questionId === questionId ? { workId: setup.workId, status: error ? 'blocked' : work?.status || 'queued', progress: work?.progress || '' } : null };
  }

  serialize(operation) {
    const pending = (this.operation || Promise.resolve()).catch(() => {}).then(operation);
    this.operation = pending;
    return pending.finally(() => { if (this.operation === pending) this.operation = null; });
  }

  interruptSetup(action, questionId) {
    if (['local-only', 'use-pi', 'next'].includes(action) && this.pendingSetup?.questionId === questionId) {
      this.pendingSetup.controller.abort(new Error('当前配置已取消。'));
    }
  }

  reply(input) {
    return this.serialize(async () => {
      const result = await guideReply(this, input);
      const { login, ...script } = result;
      if (!['hello', 'progress'].includes(input?.action) || !this.record().script) {
        if (['choose', 'provider', 'endpoint', 'protocol', 'model', 'key', 'login', 'ready'].includes(script.phase)) {
          this.store.save('onboarding', { id: 'main', script });
        } else if (this.record().script) this.store.save('onboarding', { id: 'main', script: null });
      }
      return result;
    });
  }

  start(input = {}) { return this.serialize(() => this.handoff(input)); }

  async handoff() {
    const state = this.state();
    if (state.status !== 'guiding') {
      const selection = this.models.runtimeModel();
      if (!selection || !selection.allowNoKey && !await this.models.credentials.read(selection.id).catch(() => null)) {
        fail('请先保存一个聊天模型。', 409);
      }
      const bot = this.bot();
      if (!bot || bot.status !== 'active') fail('主 Bot 暂不可用，请先在成员设置中恢复。', 409);
      const room = state.roomId && this.chatroom.store.get('rooms', state.roomId) ||
        await this.chatroom.createRoom({ id: 'room-onboarding', kind: 'dm', name: '与 ' + bot.name + ' 的私聊', members: ['user', bot.id] });
      this.save({ status: 'guiding', roomId: room.id, step: state.status === 'paused' && state.step || 'engine',
        questionId: state.status === 'paused' && state.questionId || randomUUID(), error: null, script: null });
    }
    await this.ensureQuestion();
    return this.state();
  }

  async move(step, { cancelSetup = true } = {}) {
    const setup = this.record().setup;
    if (setup && cancelSetup) {
      const botId = this.state().bot.id;
      const work = await this.manager.readState(botId, db => db?.getRecord('works', setup.workId));
      if (work && !['completed', 'cancelled'].includes(work.status)) await this.manager.request(botId,
        '/works/' + encodeURIComponent(work.id), { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      await stopRemoteBridge(JSON.parse(await readFile(join(this.models.dataRoot, 'config', 'deployment.json'), 'utf8')), setup.workId);
    }
    this.save({ status: step === 'done' ? 'complete' : 'guiding', step,
      questionId: step === 'done' ? null : randomUUID(), error: null, setup: null });
    await this.ensureQuestion();
  }

  async startSetup(guide, input = {}) {
    const state = this.state(), previous = this.record().setup;
    const messageId = input.id || randomUUID(), workId = 'onboarding-' + state.questionId;
    if (!this.bot().allowedTools?.includes('workspace_setup')) await this.ensureSetupAccess(this.bot());
    const message = await this.chatroom.append(state.roomId, { ...input, id: messageId, toBotId: state.bot.id,
      content: input.content || '请继续完成当前配置。', sourceRefs: [...new Set([...(input.sourceRefs || []), guideSource])] }, 'user');
    this.save({ error: null, setup: { questionId: state.questionId, workId,
      sourceIds: [...new Set([...(previous?.questionId === state.questionId ? previous.sourceIds : []), messageId])] } });
    const instruction = `当前用户正在配置 ${engines.get(state.step)?.name || remoteProviders.get(state.step)}。当前问题：${guide.text}\n`
      + '你正在这一步的独立 Pi 工作中。先调用 workspace_setup status 读取真实配置。按当前用户授权完成安装、登录状态检查和配置；缺组件就安装，接口不匹配就修复或在自己的工作目录编写 Node CLI 桥，再用 workspace_setup 完成接入。'
      + '失败后根据真实错误继续处理，不把预置入口缺失当成不能配置的理由。涉及用户账号登录、外部授权或秘密输入时，只让用户完成所缺的那一步，随后续接同一工作。'
      + '接入工作引擎只检查安装、登录和非生成式握手，不运行 codex exec、试聊或演示任务。接入成功由 workspace_setup connect-engine 判定，不能为了验证接入而调用模型。用户明确提出的限制在后续排障中持续有效。'
      + 'run_command 用于有期限的前台诊断，其子进程会随命令结束回收。需要持续运行的远程桥一律交给 workspace_setup start-remote 管理。'
      + '不要索要普通聊天中的密钥。已有成功或未知结果先查状态，避免重复操作。workspace_setup 成功会标记当前配置工作完成并自动推进下一条引导问题，直接结束当前工作，不追加已接通或询问想做什么的消息。';
    const sourceIds = new Set(this.record().setup.sourceIds);
    const requests = this.chatroom.messages(state.roomId).filter(item => item.senderId === 'user' && sourceIds.has(item.id));
    const requirements = instruction + '\n当前步骤的用户原始要求（按时间顺序，后续补充持续生效）：\n'
      + requests.map(item => item.content).join('\n');
    try {
      await this.manager.start(state.bot.id);
      const work = await this.manager.request(state.bot.id, '/works', { method: 'POST', body: JSON.stringify({ id: workId,
        goal: '完成 ' + (engines.get(state.step)?.name || remoteProviders.get(state.step)) + ' 配置', requirements, executor: { kind: 'pi' } }) });
      if (work.requirements !== requirements) await this.manager.request(state.bot.id, '/works/' + encodeURIComponent(workId),
        { method: 'PATCH', body: JSON.stringify({ requirements }) });
      await this.manager.send(state.bot.id, { id: 'setup:' + messageId, kind: 'request', workId,
        content: { type: 'workspace_setup', step: state.step, userMessage: message.content, instruction },
        metadata: { actor: 'user', roomId: state.roomId, originMessageId: messageId, resume: true, priority: 'foreground' } });
    } catch (error) {
      this.save({ error: 'Pi 配置工作尚未启动，请继续重试。' });
      throw error;
    }
    return message;
  }

  setupAction(input, context) {
    return this.serialize(async () => {
      const state = this.state(), setup = this.record().setup, { actor, task, work, source } = context;
      const completed = work && this.store.get('setup-completions', work.id);
      if (completed?.botId === actor && completed.sourceIds.includes(source?.replyTo) && source?.actor === 'user') {
        return { completed: true, nextStep: completed.nextStep, questionAlreadyPublished: true };
      }
      if (state.status !== 'guiding' || actor !== state.bot.id || work?.id !== setup?.workId || work?.executor?.kind !== 'pi'
        || setup.questionId !== state.questionId || source?.actor !== 'user' || source.roomId !== state.roomId || !setup.sourceIds.includes(source.replyTo)) {
        fail('当前工作不属于已授权的这一步配置。请回到当前引导问题继续。', 403);
      }
      const pending = { questionId: state.questionId, controller: new AbortController() };
      this.pendingSetup = pending;
      const signal = pending.controller.signal;
      try {
        const config = JSON.parse(await readFile(join(this.models.dataRoot, 'config', 'deployment.json'), 'utf8'));
        const botConfig = await this.manager.config(actor), engine = engines.get(state.step);
        const privateFile = async (path, bridge = false) => {
          if (typeof path !== 'string' || !isAbsolute(path)) fail('请提供当前工作目录内文件的绝对路径。');
          const file = await realpath(path), root = await realpath(botConfig.workspace), info = await stat(file);
          if (!within(root, file) || !info.isFile() || bridge && !['.mjs', '.cjs', '.js'].includes(extname(file))) fail('文件必须位于当前 Bot 工作目录中。');
          if (!bridge && info.size > 16384) fail('私有令牌文件过长。');
          return file;
        };
        const finish = async next => {
          signal.throwIfAborted();
          await this.manager.request(actor, '/works/' + encodeURIComponent(work.id), { method: 'PATCH', body: JSON.stringify({
            status: 'completed', executionOutcome: { ...work.executionOutcome, onboardingCompletedTaskId: task.id } }) });
          this.store.save('setup-completions', { id: work.id, botId: actor, sourceIds: setup.sourceIds, nextStep: next });
          await this.move(next, { cancelSetup: false });
          return { completed: true, nextStep: next, questionAlreadyPublished: true };
        };
        if (input.action === 'status') return { step: state.step, engineId: engine?.id, workId: work.id,
          platform: process.platform, workspace: botConfig.workspace, runtimeRoot: this.manager.releaseRoot,
          setupCli: join(this.manager.releaseRoot, 'scripts', 'installation', 'desktop.mjs'), dataRoot: this.models.dataRoot,
          executors: this.models.summary().executors,
          remote: state.step === 'custom' ? (await readRemoteAccess(config.dataRoot)).custom || null
            : remoteProviders.has(state.step) ? await remoteStatus(config, state.step) : null,
          bridgeProtocol: engine ? 'Node CLI bridge receives the same arguments as the chosen official CLI. During setup, verify only login status for Codex (report ChatGPT), auth status --json for Claude, or --no-auto-update --help for Grok. Do not run codex exec, a generated reply, or any sample work. workspace_setup connect-engine is the authoritative connection check. For later user work the adapter must implement the installed runtime cli-work-engine.mjs protocol; read that file only when implementing the adapter.'
            : 'For a temporary Cloudflare Quick Tunnel, call start-remote with no bridgePath. If cloudflared is missing, install or download it and pass its absolute path as arguments[0]. For another provider, write a Node bridge in your workspace, then pass bridgePath and arguments to start-remote. The bridge receives SUMMON_WEB_URL, stays running, and sends process.send({type:"remote-ready",origin:"https://..."}) when its public route is ready. The service owns and stops its process tree. Existing external routes can use register-remote with origin, label and temporary. Preserve Host and support ordinary HTTP; the webpage polls when SSE is unavailable.' };
        if (input.action === 'connect-engine' && engine) {
          const bridgePath = input.bridgePath ? await privateFile(input.bridgePath, true) : undefined;
          await this.models.setExecutor(engine.id, true, { select: true, bridgePath, signal });
          return finish('remote');
        }
        if (!remoteProviders.has(state.step)) fail('请先完成当前工作引擎的配置。');
        if (input.action === 'start-remote') {
          const bridgePath = input.bridgePath ? await privateFile(input.bridgePath, true) : undefined;
          const result = await startRemoteBridge(config, { ...input, bridgePath, workId: work.id }, { signal });
          return { ...result, ...await finish('done') };
        }
        if (input.action === 'register-remote') {
          const result = await registerCustomRemote(config, { origin: input.origin, label: input.label, temporary: input.temporary }, { signal });
          return result.reachable ? { ...result, ...await finish('done') } : result;
        }
        if (state.step === 'custom') {
          const custom = (await readRemoteAccess(config.dataRoot)).custom;
          const reachable = custom?.origin && await probeRemoteOrigin(config, custom.origin);
          if (input.action === 'check-remote') return reachable ? { ...custom, ...await finish('done') } : { ...custom, state: 'unreachable', reachable: false };
          fail('自定义方案可用 start-remote 启动桥接脚本，或用 register-remote 接入已有地址。');
        }
        if (input.action === 'prepare-remote') return prepareRemote(config, state.step, { origin: input.origin, owner: input.owner, port: input.port });
        let result;
        if (input.action === 'apply-remote') {
          const token = input.tokenFile ? (await readFile(await privateFile(input.tokenFile), 'utf8')).trim() : undefined;
          result = await applyRemote(config, state.step, { planId: input.planId, confirm: true, token });
        } else if (input.action === 'check-remote') result = await remoteStatus(config, state.step);
        else fail('未知的配置操作。');
        if (['registered', 'reachable'].includes(result.state) && result.reachable !== false) return { ...result, ...await finish('done') };
        return result;
      } finally {
        if (this.pendingSetup === pending) this.pendingSetup = null;
      }
    });
  }

  async applyChoice(action, guide, message) {
    if (action === 'check') return this.startSetup(guide, message);
    const preferred = engines.get(action);
    if (preferred && this.models.summary().executors.some(item => item.id === preferred.id && item.enabled)) {
      await this.models.selectWorkExecutor(preferred.id);
      return this.move('remote');
    }
    if (action === 'connect-engine') return this.startSetup(guide, message);
    if (action === 'use-pi') {
      await this.models.selectWorkExecutor('pi');
      return this.move('remote');
    }
    await this.move(action === 'local-only' || action === 'next' ? 'done' : action);
    if (remoteProviders.has(action)) return this.startSetup(await this.guide(), message);
  }

  configureExecutor(id, enabled, useForWork = false) {
    return this.serialize(async () => {
      const state = this.state();
      const select = enabled === true && state.status === 'guiding' && engines.get(state.step)?.id === id;
      if (select) { await this.startSetup(await this.guide(), { content: '同意并接入 ' + engines.get(state.step).name }); return this.models.snapshot(); }
      const result = await this.models.setExecutor(id, enabled, { select: select || useForWork === true });
      return result;
    });
  }

  async postMessage(roomId, input) {
    const current = this.record();
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (current.status !== 'guiding' || current.roomId !== roomId || !content) return this.chatroom.post(roomId, input);
    const currentGuide = await this.guide();
    const currentAction = currentGuide && !input.attachments?.length && typedChoice(currentGuide, content);
    if (currentGuide?.options.some(choice => choice.action === currentAction)) this.interruptSetup(currentAction, currentGuide.messageId);
    return this.serialize(async () => {
      const existing = input.clientId && this.chatroom.messages(roomId)
        .find(message => message.senderId === 'user' && message.clientId === input.clientId);
      if (existing) return existing;
      const state = this.state();
      const guide = state.roomId === roomId && await this.guide(state);
      if (!guide) return this.chatroom.post(roomId, input);
      if (looksLikeSecret(content)) fail('请使用设置里的安全输入填写密钥。', 400);
      await this.ensureQuestion(state);
      const action = !input.attachments?.length && typedChoice(guide, content);
      if (action && guide.options.some(choice => choice.action === action)) {
        const sent = await this.chatroom.append(roomId, input, 'user');
        await this.applyChoice(action, guide, sent);
        return sent;
      }
      if (this.record().setup?.questionId === state.questionId) return this.startSetup(guide, input);
      if (['remote', 'remote-provider'].includes(state.step)) {
        const sent = await this.chatroom.append(roomId, input, 'user');
        await this.move('custom');
        return this.startSetup(await this.guide(), sent);
      }
      const instruction = '回应用户这条消息。当前在配置引导，实际选项在主 Bot 的引导消息中。' + guide.text +
        ' 结合真实情况说明当前步骤，需要配置时引导用户确认接入，后续配置与排障由 Pi 工作完成。密钥通过安全输入提供。';
      return this.chatroom.post(roomId, { ...input, toBotId: state.bot.id }, 'user', { instruction });
    });
  }

  async advance(input = {}) {
    const currentGuide = await this.guide();
    if (currentGuide?.step === input.step && (!input.messageId || input.messageId === currentGuide.messageId)
      && currentGuide.options.some(choice => choice.action === input.action)) this.interruptSetup(input.action, currentGuide.messageId);
    return this.serialize(async () => {
      const state = this.state(), guide = await this.guide(state);
      if (!guide || guide.step !== input.step || input.messageId && input.messageId !== guide.messageId) return this.snapshot();
      const choice = guide.options.find(item => item.action === input.action);
      if (!choice) fail('请从当前引导消息中选择。', 409);
      await this.ensureQuestion(state);
      let message;
      if (!['check', 'connect-engine'].includes(choice.action)) {
        message = await this.chatroom.append(state.roomId, { clientId: 'summon-guide-choice:' + state.questionId + ':' + choice.action,
          content: choice.label, replyTo: state.questionId }, 'user');
      }
      await this.applyChoice(choice.action, guide, message || { id: input.requestId || randomUUID(), content: choice.label, replyTo: state.questionId });
      return this.snapshot();
    });
  }
}
