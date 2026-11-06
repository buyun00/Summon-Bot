import { randomUUID } from 'node:crypto';
import { guideReply, looksLikeSecret, option } from './guide.mjs';
import { fail } from '../shared/validation.mjs';
import { readRemoteAccess } from '../../scripts/installation/remote-config.mjs';

const engines = new Map([
  ['codex', { id: 'codex-cli', name: 'Codex' }],
  ['grok', { id: 'grok', name: 'Grok' }],
  ['claude-code', { id: 'claude-code', name: 'Claude Code' }],
]);
const remoteProviders = new Map([['tailscale', 'Tailscale Serve'], ['cloudflare', 'Cloudflare Tunnel']]);
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
  if (step === 'remote-provider') return '你希望只在自己的设备之间访问，还是需要一个公开网址？私网用 Tailscale，公开网址用 Cloudflare。';
  return '请在部署机上完成 ' + remoteProviders.get(step) + ' 的设置。完成后就能在这里查看入口。';
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
  constructor({ store, models, manager, chatroom, emit }) { Object.assign(this, { store, models, manager, chatroom, emit }); }

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
    let options, localControl;
    if (step === 'engine') options = [...engines].map(([action, { name }]) => option(name, action));
    else if (step === 'remote') options = [option('配置远程访问', 'remote-provider'), localOnly];
    else if (step === 'remote-provider') options = [...remoteProviders].map(([action, name]) => option(name, action)).concat(localOnly);
    else if (engines.has(step)) {
      options = [option(step === 'codex' ? '同意并接入 Codex' : '确认接入 ' + engines.get(step).name, 'connect-engine'), usePi];
    } else if (remoteProviders.has(step)) {
      const entry = (await readRemoteAccess(this.models.dataRoot))[step];
      localControl = { provider: step, origin: !entry?.pending && entry?.origin || null };
      options = localControl.origin ? [option('完成引导', 'next')] : [option('查看配置状态', 'check'), localOnly];
    } else return null;
    return { step, text: question(step), options, localControl, messageId: questionId, error };
  }

  serialize(operation) {
    const pending = (this.operation || Promise.resolve()).catch(() => {}).then(operation);
    this.operation = pending;
    return pending.finally(() => { if (this.operation === pending) this.operation = null; });
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

  async move(step) {
    this.save({ status: step === 'done' ? 'complete' : 'guiding', step,
      questionId: step === 'done' ? null : randomUUID(), error: null });
    await this.ensureQuestion();
  }

  async applyChoice(action, guide) {
    if (action === 'check') return;
    const preferred = engines.get(action);
    if (preferred && this.models.summary().executors.some(item => item.id === preferred.id && item.enabled)) {
      await this.models.selectWorkExecutor(preferred.id);
      return this.move('remote');
    }
    if (action === 'connect-engine') {
      try { await this.models.setExecutor(engines.get(guide.step).id, true, { select: true }); }
      catch (error) {
        this.save({ error: error.expose ? error.message : '暂时无法接入工作引擎，请检查部署机的安装和登录状态后重试。' });
        return;
      }
      return this.move('remote');
    }
    if (action === 'use-pi') {
      await this.models.selectWorkExecutor('pi');
      return this.move('remote');
    }
    return this.move(action === 'local-only' || action === 'next' ? 'done' : action);
  }

  configureExecutor(id, enabled, useForWork = false) {
    return this.serialize(async () => {
      const state = this.state();
      const select = enabled === true && state.status === 'guiding' && engines.get(state.step)?.id === id;
      const result = await this.models.setExecutor(id, enabled, { select: select || useForWork === true });
      if (select) await this.move('remote');
      return result;
    });
  }

  postMessage(roomId, input) {
    const current = this.record();
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (current.status !== 'guiding' || current.roomId !== roomId || !content) return this.chatroom.post(roomId, input);
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
        await this.applyChoice(action, guide);
        return sent;
      }
      const instruction = '回应用户这条消息。当前在配置引导，实际选项在主 Bot 的引导消息中。' + guide.text +
        ' 只解释当前一步，不索要密钥或令牌，也不自行改变配置。';
      return this.chatroom.post(roomId, { ...input, toBotId: state.bot.id }, 'user', { instruction });
    });
  }

  advance(input = {}) {
    return this.serialize(async () => {
      const state = this.state(), guide = await this.guide(state);
      if (!guide || guide.step !== input.step || input.messageId && input.messageId !== guide.messageId) return this.snapshot();
      const choice = guide.options.find(item => item.action === input.action);
      if (!choice) fail('请从当前引导消息中选择。', 409);
      await this.ensureQuestion(state);
      if (!['check', 'connect-engine'].includes(choice.action)) {
        await this.chatroom.append(state.roomId, { clientId: 'summon-guide-choice:' + state.questionId + ':' + choice.action,
          content: choice.label, replyTo: state.questionId }, 'user');
      }
      await this.applyChoice(choice.action, guide);
      return this.snapshot();
    });
  }
}
