import { guideReply, looksLikeSecret, option } from './guide.mjs';
import { fail } from '../shared/validation.mjs';
import { readRemoteAccess } from '../../scripts/installation/remote-config.mjs';

const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const startId = 'summon-onboarding-start';
const guideSource = 'summon:onboarding';
const skip = option('跳过这一步', 'skip');
const later = option('稍后继续', 'pause');
const next = option('下一步', 'next');

export class OnboardingService {
  constructor({ store, models, manager, chatroom, emit }) { Object.assign(this, { store, models, manager, chatroom, emit }); }

  async initialize() {
    if (!this.record()) {
      const model = this.models.runtimeModel();
      const configured = model && (model.allowNoKey || await this.models.credentials.read(model.id).catch(() => null));
      this.save({ status: configured ? 'complete' : 'pending', reason: configured ? 'existing-model' : 'first-run' });
    }
    const progress = this.record();
    if (progress.status === 'complete' && progress.roomId && !progress.step) {
      const kickoff = this.kickoff(progress.roomId, startId);
      this.save({ kickoffId: startId, status: kickoff.reply ? 'complete' : kickoff.active ? 'starting' : 'failed',
        step: kickoff.reply ? 'done' : 'intent' });
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

  kickoff(roomId, clientId) {
    const messages = this.chatroom.messages(roomId);
    const trigger = messages.find(message => message.senderId === 'user' && message.clientId === clientId);
    const jobs = trigger ? this.chatroom.jobs(roomId).filter(job => job.messageId === trigger.id && job.botId === trigger.toBotId) : [];
    const reply = trigger && messages.find(message => message.replyTo === trigger.id && message.senderId === trigger.toBotId
      && message.kind !== 'error' && message.content?.trim() && jobs.some(job => job.id === message.jobId && job.status === 'completed'));
    return { trigger, reply, latest: jobs.at(-1), active: jobs.some(job => !terminal.has(job.status)) };
  }

  state() {
    let progress = this.record();
    if (progress.status === 'starting' && !this.submitting) {
      const { reply, latest, active } = this.kickoff(progress.roomId, progress.kickoffId);
      if (reply) progress = this.save({ status: 'guiding', step: 'intent', error: null, script: null });
      else if (latest && !active) progress = this.save({ status: 'failed',
        error: '聊天模型没有返回可用回复。请检查授权、额度和连接，或换一个模型后重试。' });
    }
    const { status, roomId, step, error } = progress;
    const bot = this.bot();
    return { required: ['pending', 'starting', 'failed'].includes(status), status, roomId: roomId || null,
      step: step || null, error: error || null, bot: { id: bot?.id || 'bot-entry', name: bot?.name || '主 Bot' } };
  }

  async snapshot() {
    const state = await this.publicState();
    const modelSettings = await this.models.snapshot();
    return { ...state, modelSettings, configured: modelSettings.connections.some(entry => entry.active && entry.configured) };
  }

  async publicState() {
    const state = this.state();
    return { ...state, guide: await this.guide(state) };
  }

  async guide(state = this.state()) {
    if (state.status !== 'guiding') return null;
    let text, options, localControl;
    switch (state.step) {
      case 'intent':
        text = '你想先用 Summon Bot 做什么？';
        options = [option('先聊一句', 'chat'), option('把工作交给 Codex', 'codex'), option('从其他设备访问', 'remote'), skip];
        break;
      case 'chat': {
        const { trigger } = this.kickoff(state.roomId, this.record().kickoffId);
        const sent = this.chatroom.messages(state.roomId).some(message => message.senderId === 'user'
          && message.createdAt > trigger?.createdAt && !message.sourceRefs?.includes(guideSource));
        text = sent ? '你的消息已发给主 Bot。接下来可以看看怎样委托独立工作。' : '在输入框里发一条消息，试着问主 Bot 一件你关心的事。';
        options = sent ? [next, skip] : [skip];
        break;
      }
      case 'work':
        text = '想把一件事交给我时，在这里说出目标和限制。委托后可以从「工作」查看进展和结果，从「模型与引擎」切换聊天模型。';
        options = [next, skip];
        break;
      case 'codex': {
        const executor = this.models.summary().executors.find(item => item.id === 'codex-desktop');
        text = executor?.enabled ? 'Codex 已获得 WORK 执行授权。聊天仍使用你选择的 CHAT 模型。'
          : 'CHAT 负责日常对话，WORK 可以独立委托给 Codex。先在部署机上打开 Codex，再明确授权接入。';
        options = executor?.enabled ? [next] : [option('允许接入 Codex 执行器', 'connect-codex'), skip];
        break;
      }
      case 'remote':
        text = '从其他设备访问时，可以用公开的 Cloudflare Tunnel，或通过 Tailscale Serve 在自己的私网里访问。';
        options = [option('Cloudflare Tunnel', 'cloudflare'), option('Tailscale Serve', 'tailscale'), skip];
        break;
      case 'cloudflare':
      case 'tailscale': {
        const entry = (await readRemoteAccess(this.models.dataRoot))[state.step];
        const title = state.step === 'cloudflare' ? 'Cloudflare Tunnel' : 'Tailscale Serve';
        text = entry?.origin && !entry.pending ? title + ' 地址已登记。' : '请在部署机上准备并确认 ' + title + '。完成外部授权后可以回来继续。';
        localControl = { provider: state.step, status: entry?.origin && !entry.pending ? 'registered' : 'needs-local-setup', origin: entry?.pending ? null : entry?.origin || null };
        options = [option('刷新配置状态', 'check'), ...(localControl.origin ? [next] : [skip])];
        break;
      }
      default: return null;
    }
    return { step: state.step, text, options: [...options, later], localControl, error: state.error };
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

  async handoff(input) {
    const state = this.state(), progress = this.record();
    if (state.status === 'guiding') return state;
    if (['paused', 'complete'].includes(state.status) && state.roomId && this.chatroom.store.get('rooms', state.roomId)) {
      this.save({ status: 'guiding', step: state.status === 'paused' ? state.step : 'intent', error: null });
      return this.state();
    }
    const selection = this.models.runtimeModel();
    if (!selection || !selection.allowNoKey && !await this.models.credentials.read(selection.id).catch(() => null)) {
      fail('请先接上一个聊天模型，再让主 Bot 继续引导。', 409);
    }
    const bot = this.bot();
    if (!bot || bot.status !== 'active') fail('主 Bot 暂不可用，请先在成员设置中恢复。', 409);
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message.length > 4000 || looksLikeSecret(message)) fail('请在模型连接的安全输入中填写密钥。', 400);
    const room = state.roomId && this.chatroom.store.get('rooms', state.roomId) ||
      await this.chatroom.createRoom({ id: 'room-onboarding', kind: 'dm', name: '与 ' + bot.name + ' 的私聊', members: ['user', bot.id] });
    let attempt = progress.attempt || 0, kickoffId = progress.kickoffId || startId;
    const { latest, active } = this.kickoff(room.id, kickoffId);
    if (active) return this.state();
    if (latest && ['completed', 'cancelled'].includes(latest.status)) {
      kickoffId = startId + '-' + ++attempt;
    }
    this.submitting = true;
    this.save({ status: 'starting', roomId: room.id, kickoffId, attempt, connectionId: selection.id, error: null });
    try {
      if (latest && ['failed', 'interrupted'].includes(latest.status)) await this.chatroom.retry(latest.id);
      else await this.chatroom.post(room.id, { clientId: kickoffId, toBotId: bot.id,
        content: '聊天模型已接好。请带我熟悉 Summon Bot，先问我最想做什么。' +
          (message && !/^(开始|继续|好|好的|开始吧|继续吧)[。！!\s]*$/.test(message) ? '\n\n' + message : ''),
        sourceRefs: [guideSource] });
    } catch {
      this.save({ status: 'failed', error: '首条消息暂未开始。请确认主 Bot 可用后重试。' });
    } finally { this.submitting = false; }
    return this.state();
  }

  advance(input = {}) {
    return this.serialize(async () => {
      const state = this.state(), guide = await this.guide(state);
      if (!guide || guide.step !== input.step) return this.snapshot();
      if (!guide.options.some(option => option.action === input.action)) fail('请先完成当前步骤，或使用跳过。', 409);
      const action = input.action;
      if (action === 'check') return this.snapshot();
      if (action === 'pause') this.save({ status: 'paused', error: null });
      else if (action === 'connect-codex') {
        try { await this.models.setExecutor('codex-desktop', true); this.save({ error: null }); }
        catch (error) { this.save({ error: error.expose ? error.message : 'Codex 暂未接入。请在部署机打开 Codex 后重试，也可以继续使用 Pi。' }); }
      } else {
        const step = ({ intent: action === 'skip' ? 'done' : action, chat: 'work', work: 'codex', codex: 'remote',
          remote: action === 'skip' ? 'done' : action, cloudflare: 'done', tailscale: 'done' })[guide.step];
        if (step !== 'done' && action !== 'skip' && action !== 'next') {
          const bot = this.bot();
          await this.chatroom.post(state.roomId, { toBotId: bot.id, clientId: 'summon-onboarding-' + guide.step + '-' + step,
            sourceRefs: [guideSource], content: guide.options.find(option => option.action === action).label + '。请只带我做当前这一小步。' });
        }
        this.save({ status: step === 'done' ? 'complete' : 'guiding', step, error: null });
      }
      return this.snapshot();
    });
  }
}
