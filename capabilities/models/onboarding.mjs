import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { guideReply, looksLikeSecret, option } from './guide.mjs';
import { fail, within } from '../shared/validation.mjs';
import { probeRemoteOrigin, readRemoteAccess, registerCustomRemote } from '../../scripts/installation/remote-config.mjs';
import { applyRemote, prepareRemote, remoteStatus } from '../../scripts/installation/remote-access.mjs';
import { checkRemoteBridge, startRemoteBridge, stopRemoteBridge } from '../../scripts/installation/auxiliaries.mjs';

const remoteProviders = new Map([['tailscale', 'Tailscale Serve'], ['cloudflare', 'Cloudflare Tunnel'], ['custom', '临时访问或其他方案']]);
const guideSource = 'summon:onboarding';
const localOnly = option('先只在这台电脑上用', 'local-only');
const setupConfirmation = () => '远程访问已准备好。';

function question(step) {
  if (step === 'discover') return '聊天模型已保存。Pi 正在读取这台电脑的工具入口和实际帮助，整理可复用的本机工具资料。';
  if (step === 'remote') return '你想从手机或另一台电脑访问这个工作区吗？还是先只在这台电脑上用？';
  if (step === 'remote-provider') return '你想使用 Tailscale、Cloudflare，还是先开一个临时入口？也可以直接告诉我其他远程方案，我来配置。';
  if (step === 'custom') return '我来准备远程入口。可以先用临时地址，也可以直接告诉我你想用的方案，需要的桥接脚本由我来处理。';
  return '我来配置 ' + remoteProviders.get(step) + '。我会先检查这台电脑的安装和登录情况，遇到问题会继续修复，需要你登录时会在这里告诉你。';
}

function typedChoice(guide, text) {
  const answer = text.toLowerCase().trim().replace(/[。！!.]+$/, '');
  const direct = guide.options.find(choice => choice.label.toLowerCase() === answer);
  if (direct) return direct.action;
  if (guide.step === 'remote' || guide.step === 'remote-provider') {
    if (/^(?:先)?(?:不用|只在本机(?:用|使用)?|不需要远程|跳过)$/.test(answer)) return 'local-only';
    if (guide.step === 'remote' && /^(?:要|需要|可以|想)$/.test(answer)) return 'remote-provider';
  }
  return null;
}

export class OnboardingService {
  constructor({ store, models, manager, chatroom, emit, ensureSetupAccess, native, profileId, botId }) { Object.assign(this, { store, models, manager, chatroom, emit, ensureSetupAccess, native, profileId, botId }); }

  async initialize() {
    const saved = this.record();
    if (!saved) {
      const model = this.models.runtimeModel();
      const configured = model && (model.allowNoKey || await this.models.credentials.read(model.id).catch(() => null));
      this.save({ status: configured ? 'complete' : 'pending', reason: configured ? 'existing-model' : 'first-run' });
    } else if (saved.roomId && !saved.questionId && ['starting', 'guiding', 'paused', 'failed'].includes(saved.status)) {
      this.save({ status: saved.status === 'paused' ? 'paused' : 'guiding', step: 'discover', questionId: randomUUID(), error: null, script: null });
    }
    return this;
  }

  record() { return this.store.get('onboarding', this.profileId || 'main'); }
  save(value) {
    const result = this.store.save('onboarding', { id: this.profileId || 'main', ...value });
    this.emit('onboarding.changed', {});
    return result;
  }
  bot() { if (this.botId) return this.manager.get(this.botId); return this.manager.list().find(entry => entry.presetId === 'entry' || entry.id === 'bot-entry'); }

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
    const completed = state.status === 'complete' && state.step === 'done';
    if ((!completed && state.status !== 'guiding') || !state.questionId || this.chatroom.store.get('messages', state.questionId)) return;
    const { questionText, replyTo } = this.record();
    await this.chatroom.append(state.roomId, { id: state.questionId, content: questionText || question(state.step), replyTo, sourceRefs: [guideSource] }, state.bot.id);
  }

  async guide(state = this.state()) {
    if (state.status !== 'guiding') return null;
    const { step, questionId, error } = state;
    const { setup, questionText } = this.record();
    const work = setup?.questionId === questionId && await this.manager.readState(state.bot.id, db => db?.getRecord('works', setup.workId));
    let options, localControl;
    if (step === 'discover') options = error ? [option('继续工具初始化', 'retry-discovery'), option('更换聊天模型', 'change-model')] : [];
    else if (step === 'remote') options = [option('配置远程访问', 'remote-provider'), localOnly];
    else if (step === 'remote-provider') options = [...remoteProviders].map(([action, name]) => option(name, action)).concat(localOnly);
    else if (remoteProviders.has(step)) {
      const entry = (await readRemoteAccess(this.models.dataRoot))[step];
      localControl = { provider: step, origin: !entry?.pending && entry?.origin || null };
      options = localControl.origin ? [option('完成引导', 'next')] : [option('继续配置', 'check'), localOnly];
    } else return null;
    const discovered = step === 'discover' && setup?.discovery ? this.discoveryStatus(setup).discovered : null;
    const progress = work?.progress || (discovered === null ? '' : '已发现 ' + discovered + ' 个候选入口');
    return { step, text: questionText || question(step), options, localControl, messageId: questionId, error,
      setup: setup?.questionId === questionId ? { workId: setup.workId, status: error ? 'blocked' : work?.status || 'queued', progress } : null };
  }

  serialize(operation) {
    const pending = (this.operation || Promise.resolve()).catch(() => {}).then(operation);
    this.operation = pending;
    return pending.finally(() => { if (this.operation === pending) this.operation = null; });
  }

  interruptSetup(action, questionId) {
    if (['local-only', 'next'].includes(action) && this.pendingSetup?.questionId === questionId) {
      this.pendingSetup.controller.abort(new Error('当前配置已取消。'));
    }
  }

  reply(input) {
    return this.serialize(async () => {
      const result = await guideReply(this, input);
      const { login, ...script } = result;
      if (!['hello', 'progress'].includes(input?.action) || !this.record().script) {
        if (['choose', 'provider', 'endpoint', 'protocol', 'model', 'key', 'login', 'ready'].includes(script.phase)) {
          this.store.save('onboarding', { id: this.profileId || 'main', script });
        } else if (this.record().script) this.store.save('onboarding', { id: this.profileId || 'main', script: null });
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
        await this.chatroom.createRoom({ id: this.profileId ? 'room-onboarding-' + this.profileId : 'room-onboarding', workspaceProfileId: this.profileId, kind: 'dm', name: '与 ' + bot.name + ' 的私聊', members: ['user', bot.id] });
      this.save({ status: 'guiding', roomId: room.id, step: state.status === 'paused' && state.step || 'discover',
        questionId: state.status === 'paused' && state.questionId || randomUUID(), questionText: null, replyTo: null, error: null, script: null });
    }
    await this.ensureQuestion();
    if (this.state().step === 'discover' && !this.record().setup?.discovery) await this.startDiscovery();
    return this.state();
  }

  async startDiscovery() {
    const state = this.state(), previous = this.record().setup;
    if (state.step !== 'discover') fail('当前并非工具初始化步骤', 409);
    const workId = 'onboarding-' + state.questionId;
    const attempt = (previous?.attempt || 0) + 1;
    const instruction = [
      '这是当前工作区连接模型后的首次本机工具初始化。通过 catalog_native_discover 实际检查当前主机 PATH、安装目录与项目入口，分页读取实际候选。',
      '使用 catalog_search 查已有工具。对实际发现且可用的 CLI 调用 catalog_native_enroll，复用既有专属 Bot。根据工具的实际入口及用途识别命令行工具。由维护者查本机版本和帮助并保存适用的方法。不要生成试聊或演示任务。',
      '现有工具资料只在适用时复用。未确定用途、登录或版本的工具如实留作环境待办。调用 workspace_setup status 读取真实发现与维护进度，再调用 finish-discovery；平台按记录处理未完成的学习工作。'
    ].join('\n');
    this.save({ error: null, setup: { discovery: true, questionId: state.questionId, workId, attempt } });
    try {
      const bot = this.bot();
      if (!bot.allowedTools?.includes('workspace_setup')) await this.ensureSetupAccess(bot);
      await this.manager.start(bot.id);
      const work = await this.manager.request(bot.id, '/works', { method: 'POST', body: JSON.stringify({
        id: workId, goal: '发现并接入本机工具', requirements: instruction, sources: [{ roomId: state.roomId, replyTo: state.questionId, source: 'controller' }],
      }) });
      if (work.status === 'blocked') await this.manager.request(bot.id, '/works/' + encodeURIComponent(workId), { method: 'PATCH', body: JSON.stringify({ status: 'active', waiting: null }) });
      const receipt = await this.manager.send(bot.id, { id: 'environment:' + workId + ':' + attempt, kind: 'request', workId,
        content: { type: 'native-environment-initialization', instruction },
        metadata: { actor: 'system', sourceType: 'workspace-onboarding', roomId: state.roomId, originMessageId: state.questionId, priority: 'foreground' } });
      this.save({ setup: { ...this.record().setup, taskId: receipt.taskId } });
    } catch (error) { this.save({ error: 'Pi 初始化尚未启动。' }); throw error; }
  }

  discoveryStatus(setup = this.record().setup) {
    const actor = this.state().bot.id;
    const key = JSON.stringify([actor, setup?.workId]);
    const discovery = this.native.store.get('native-discovery-runs', key);
    const jobs = this.native.store.list('native-maintenance').filter(job => job.actor === actor && job.workId === setup?.workId && job.kind === 'initial-learning');
    const resourceIds = [...new Set([...(discovery?.resources || []), ...jobs.map(job => job.entryId)])];
    const entries = resourceIds.map(id => this.native.catalog.entry(id)).map(entry => ({
      id: entry.id, name: entry.name, status: entry.native?.status, ownerBotId: entry.ownerBotId,
    }));
    return { discovered: discovery?.count ?? null, ready: entries.filter(entry => entry.status === 'ready').length,
      remaining: jobs.filter(job => !job.finishedAt).length, entries, host: this.native.host };
  }

  async finishDiscovery(work, task) {
    const setup = this.record().setup, state = this.state(), progress = this.discoveryStatus(setup);
    if (progress.discovered === null) fail('请先在当前工作实际发现工具。', 409);
    if (!progress.ready && progress.remaining) {
      await this.manager.request(state.bot.id, '/works/' + encodeURIComponent(work.id), { method: 'PATCH', body: JSON.stringify({
        status: 'waiting', waiting: { kind: 'tool-environment', reason: '等待工具维护 Bot 读取本机接口并登记方法' },
        progress: '发现 ' + progress.discovered + ' 个候选入口，' + progress.remaining + ' 个工具待维护者接入。',
      }) });
      this.save({ setup: { ...setup, awaitingOwners: true } });
      return { ...progress, completed: false, waiting: true };
    }
    const message = '已在本机发现 ' + progress.discovered + ' 个候选入口。' +
      (progress.ready ? '已有 ' + progress.ready + ' 个工具登记了可复用方法。' : '目前由 Pi 执行工作。') +
      (progress.remaining ? '另有 ' + progress.remaining + ' 个工具在继续接入。' : '');
    await this.manager.request(state.bot.id, '/works/' + encodeURIComponent(work.id), { method: 'PATCH', body: JSON.stringify({
      status: 'completed', progress: message, executionOutcome: { ...work.executionOutcome, onboardingCompletedTaskId: task?.id || setup.taskId },
    }) });
    await this.move('remote', { cancelSetup: false, replyTo: state.questionId, confirmation: message });
    return { ...progress, completed: true };
  }

  async tick() {
    const saved = this.record(), setup = saved.setup;
    if (saved.status !== 'guiding' || saved.step !== 'discover' || !setup?.taskId) return;
    await this.serialize(async () => {
      const current = this.record();
      if (current.setup?.taskId !== setup.taskId || current.step !== 'discover') return;
      const { work, task } = await this.manager.readState(this.bot().id, db => ({ work: db?.getRecord('works', setup.workId), task: db?.getTask(setup.taskId) }));
      if (!work || ['paused', 'cancelled'].includes(work.status)) return;
      if (setup.awaitingOwners) {
        const progress = this.discoveryStatus(setup);
        if (progress.ready || !progress.remaining) await this.finishDiscovery(work, task);
        return;
      }
      if (['failed', 'interrupted', 'cancelled'].includes(task?.status) && !current.error)
        this.save({ error: task?.status === 'failed' ? 'Pi 未能完成初始化。请检查聊天模型连接，或继续当前工作。' : '初始化已中断。可以继续原工作。' });
      else if (task?.status === 'completed' && !current.error) {
        const progress = this.discoveryStatus(setup);
        if (progress.discovered !== null) await this.finishDiscovery(work, task);
        else this.save({ error: '本机工具扫描尚未完成。请继续初始化。' });
      }
    });
  }

  async move(step, { cancelSetup = true, replyTo = null, confirmation = '' } = {}) {
    const setup = this.record().setup;
    if (setup && cancelSetup) {
      const botId = this.state().bot.id;
      const work = await this.manager.readState(botId, db => db?.getRecord('works', setup.workId));
      if (work && !['completed', 'cancelled'].includes(work.status)) await this.manager.request(botId,
        '/works/' + encodeURIComponent(work.id), { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      await stopRemoteBridge(JSON.parse(await readFile(join(this.models.dataRoot, 'config', 'deployment.json'), 'utf8')), setup.workId);
    }
    const complete = step === 'done';
    let questionText = null;
    if (complete) {
      const lobby = this.chatroom.store.get('rooms', 'room-lobby');
      const group = lobby?.members?.includes('user') ? `左侧「${lobby.name}」` : '左侧的群聊';
      questionText = `配置结束。${confirmation}\n\n${group}可以和伙伴一起讨论项目。在群里用 @ 指定一位伙伴，也可以从左侧点选伙伴单独私聊。左下角的「工作」可以看委托进度，「知识」里能找到已保存的资料。`;
    } else if (confirmation) questionText = `${confirmation}\n\n${question(step)}`;
    this.save({ status: complete ? 'complete' : 'guiding', step, questionId: randomUUID(), questionText, replyTo, error: null, setup: null });
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
    const instruction = `当前用户正在配置 ${remoteProviders.get(state.step)}。当前问题：${guide.text}\n`
      + '你正在这一步的独立 Pi 工作中。先调用 workspace_setup status 读取真实配置。按当前用户授权完成安装、登录状态检查和配置；缺组件就安装，接口不匹配就修复或在自己的工作目录编写 Node CLI 桥，再用 workspace_setup 完成接入。'
      + '失败后根据真实错误继续处理，不把预置入口缺失当成不能配置的理由。涉及用户账号登录、外部授权或秘密输入时，只让用户完成所缺的那一步，随后续接同一工作。'
      + '当前配置工作的完成状态只由 workspace_setup 核实成功后写入，不自行调用 work_update completed 或 cancelled。尚缺条件时使用 work_wait，后续沿同一工作接续。'
      + '报错不会扩大用户授权。用户若限定供应商、内置入口、命令或禁止事项，重试和诊断仍须遵守；不能擅自替换供应商、绕过指定入口或另起临时 HTTP 服务。确需改变用户限定的方法时，在同一工作中说明所缺条件并用 work_wait 等待用户补充。没有这类限制时，继续自主完成已授权的安装和桥接。'
      + 'run_command 用于有期限的前台诊断，其子进程会随命令结束回收。需要持续运行的远程桥一律交给 workspace_setup start-remote 管理。'
      + '不要索要普通聊天中的密钥。已有成功或未知结果先查状态，避免重复操作。workspace_setup 会统一发布接入结果和下一步引导，成功后直接结束当前工作。';
    const sourceIds = new Set(this.record().setup.sourceIds);
    const requests = this.chatroom.messages(state.roomId).filter(item => item.senderId === 'user' && sourceIds.has(item.id));
    const requirements = instruction + '\n当前步骤的用户原始要求（按时间顺序，后续补充持续生效）：\n'
      + requests.map(item => item.content).join('\n');
    try {
      await this.manager.start(state.bot.id);
      const work = await this.manager.request(state.bot.id, '/works', { method: 'POST', body: JSON.stringify({ id: workId,
        goal: '完成 ' + (remoteProviders.get(state.step)) + ' 配置', requirements, executor: { kind: 'pi' } }) });
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
      if (state.step === 'discover') {
        if (actor !== state.bot.id || work?.id !== setup?.workId || !setup.discovery || source?.metadata?.sourceType !== 'workspace-onboarding')
          fail('当前工作并非这次工具初始化', 403);
        if (input.action === 'status') return this.discoveryStatus(setup);
        if (input.action === 'finish-discovery') return this.finishDiscovery(work, task);
        fail('请完成当前工具初始化', 409);
      }
      const completed = work && this.store.get('setup-completions', work.id);
      if (completed?.botId === actor && completed.sourceIds.includes(source?.replyTo) && source?.actor === 'user') {
        if (state.status === 'guiding' && setup?.workId === work.id) await this.move(completed.nextStep, {
          cancelSetup: false, replyTo: completed.replyTo || source.replyTo, confirmation: setupConfirmation(state.step),
        });
        else await this.ensureQuestion(state);
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
        const botConfig = await this.manager.config(actor);
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
          this.store.save('setup-completions', { id: work.id, botId: actor, sourceIds: setup.sourceIds, nextStep: next, replyTo: source.replyTo });
          await this.move(next, { cancelSetup: false, replyTo: source.replyTo, confirmation: setupConfirmation(state.step) });
          return { completed: true, nextStep: next, questionAlreadyPublished: true };
        };
        if (input.action === 'status') return { step: state.step, workId: work.id,
          userInstructions: this.chatroom.messages(state.roomId).filter(message => setup.sourceIds.includes(message.id) && message.senderId === 'user').map(message => message.content),
          authorization: 'Follow these original user instructions throughout diagnosis and retries. An error does not authorize a different provider, a prohibited command, or a temporary HTTP server. If the user limited the method, keep that method or use work_wait for the missing condition; an alternative requires the user to authorize it in this work.',
          platform: process.platform, workspace: botConfig.workspace, runtimeRoot: this.manager.releaseRoot,
          setupCli: join(this.manager.releaseRoot, 'scripts', 'installation', 'desktop.mjs'), dataRoot: this.models.dataRoot,
          remote: state.step === 'custom' ? (await readRemoteAccess(config.dataRoot)).custom || null
            : remoteProviders.has(state.step) ? await remoteStatus(config, state.step) : null,
          bridgeProtocol: 'For a temporary Cloudflare Quick Tunnel, call start-remote with no bridgePath. If cloudflared is missing, install or download it and pass its absolute path as arguments[0]. A waiting result keeps the managed bridge alive: use check-remote to verify that same route while DNS propagates. Do not repeatedly start new tunnels for DNS failures. Call start-remote again only when the managed process has stopped or a script or launch configuration has been repaired and must restart. When the user authorizes another provider or a custom bridge, write a Node bridge in your workspace, then pass bridgePath and arguments to start-remote. Do not substitute this for an explicitly requested built-in route. The bridge receives SUMMON_WEB_URL, stays running, and sends process.send({type:"remote-ready",origin:"https://..."}) when its public route is ready. The service owns and stops its process tree. Existing external routes can use register-remote with origin, label and temporary. Preserve Host and support ordinary HTTP; the webpage polls when SSE is unavailable.' };
        if (!remoteProviders.has(state.step)) fail('当前没有待执行的远程访问配置。');
        if (input.action === 'start-remote') {
          const bridgePath = input.bridgePath ? await privateFile(input.bridgePath, true) : undefined;
          const result = await startRemoteBridge(config, { ...input, bridgePath, workId: work.id }, { signal });
          return result.reachable ? { ...result, ...await finish('done') } : result;
        }
        if (input.action === 'register-remote') {
          const result = await registerCustomRemote(config, { origin: input.origin, label: input.label, temporary: input.temporary }, { signal });
          return result.reachable ? { ...result, ...await finish('done') } : result;
        }
        if (input.action === 'check-remote') {
          const managed = await checkRemoteBridge(config, work.id, { signal });
          if (managed) return managed.reachable ? { ...managed, ...await finish('done') } : managed;
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
    if (action === 'retry-discovery') return this.startDiscovery();
    if (action === 'change-model') {
      await this.models.mutate(catalog => { catalog.activeId = null; });
      this.save({ status: 'pending', step: null, questionId: null, setup: null, script: null, error: null });
      return;
    }
    if (action === 'local-only' || action === 'next') return this.move('done', { replyTo: message?.id,
      confirmation: action === 'local-only' ? '这次先跳过远程访问。' : '可以在设置中查看已保存的远程入口。' });
    await this.move(action);
    if (remoteProviders.has(action)) return this.startSetup(await this.guide(), message);
  }

  async postMessage(roomId, input) {
    const current = this.record();
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (current.status !== 'guiding' || current.roomId !== roomId || !content)
      return this.chatroom.post(roomId, input, 'user', { fromUser: true });
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
      if (state.step === 'discover') return this.chatroom.post(roomId, input, 'user', { fromUser: true });
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
      if (!['check', 'retry-discovery'].includes(choice.action)) {
        message = await this.chatroom.append(state.roomId, { clientId: 'summon-guide-choice:' + state.questionId + ':' + choice.action,
          content: choice.label, replyTo: state.questionId }, 'user');
      }
      await this.applyChoice(choice.action, guide, message || { id: input.requestId || randomUUID(), content: choice.label, replyTo: state.questionId });
      return this.snapshot();
    });
  }
}
