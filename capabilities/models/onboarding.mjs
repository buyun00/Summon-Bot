import { randomUUID } from 'node:crypto';
import { guideReply, looksLikeSecret, option } from './guide.mjs';
import { fail } from '../shared/validation.mjs';
import { readRemoteAccess } from '../../scripts/installation/remote-config.mjs';

const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const startId = 'summon-onboarding-start';
const setupStartId = 'summon-onboarding-conversation';
const guideSource = 'summon:onboarding';
const skip = option('跳过这一步', 'skip');
const later = option('稍后继续', 'pause');
const next = option('下一步', 'next');
const remoteQuestion = '你想从手机或另一台电脑访问这个工作区吗？也可以先在本机使用。';
const dialogueInstruction = '这是主 Bot 的新手引导。先回应用户这一句，再用自然的话推进当前一步，每次只问一个问题。用户可以直接在对话里回答。只描述已确认的配置状态。需要本机设置时，告诉用户用对话里的设置入口并回来说一声。请勿索要密钥、访问令牌，也不要自行改动接入配置。';

function guideUpdate(state, guide, content) {
  const answer = content.replace(/^(?:好|好的|是的|可以|要)[，,、]\s*/, '').replace(/[。！!.\s]+$/, '');
  const selection = answer.match(/^(?:我)?(?:想用|要用|想接入|用|就用|先用|选|选择|接|接入|配置)?\s*(cloudflare(?:\s+tunnel)?|tailscale(?:\s+serve)?|codex(?:\s+desktop)?|pi)(?:吧|就好|就行)?$/i);
  const choice = selection?.[1].toLowerCase().split(/\s+/)[0];
  const skipStep = /^(?:我)?(?:先)?(?:跳过(?:这一步)?|(?:不用|不需要|不要)(?:远程(?:访问|链接)?|codex)?|不接(?:入)?\s*codex|不了|只在(?:本机|这台电脑上)(?:用|使用)?|no|skip)$/i.test(answer);
  const yes = /^(?:是|是的|好|好的|要|需要|想|想要|可以|行|yes)$/i.test(answer);
  const wantsRemote = /^(?:我)?(?:想|要|希望)(?:从|在|用)(?:手机|另一台电脑|其他设备)(?:上)?(?:访问|用|使用)?(?:工作区)?$/.test(answer);
  const ready = /^(?:好了|配好了|配置好了|已配置|配置完成|完成了|继续|下一步|done|next)$/i.test(answer);
  if (/^(?:暂停(?:引导)?|稍后(?:继续)?|晚点再配)$/.test(answer)) return { status: 'paused' };
  if (state.step === 'codex') {
    const enabled = guide.options.some(item => item.action === 'next');
    if (skipStep || choice === 'pi' || enabled && (yes || ready || choice === 'codex')) return { status: 'complete', step: 'done' };
    return choice === 'codex' || yes ? { codexRequested: true } : {};
  }
  if (skipStep || guide.localControl?.origin && ready) return { step: 'codex' };
  if (choice === 'cloudflare' || /^(?:用|要)?(?:公网|公开网址)$/.test(answer)) return { step: 'cloudflare' };
  if (choice === 'tailscale' || /^(?:用|要)?(?:私网|只在自己的设备上用)$/.test(answer)) return { step: 'tailscale' };
  return state.step === 'remote' && (yes || wantsRemote) ? { remoteRequested: true } : {};
}

export class OnboardingService {
  constructor({ store, models, manager, chatroom, emit }) { Object.assign(this, { store, models, manager, chatroom, emit }); }

  async initialize() {
    if (!this.record()) {
      const model = this.models.runtimeModel();
      const configured = model && (model.allowNoKey || await this.models.credentials.read(model.id).catch(() => null));
      this.save({ status: configured ? 'complete' : 'pending', reason: configured ? 'existing-model' : 'first-run' });
    }
    let progress = this.record();
    if (progress.status === 'complete' && progress.roomId && !progress.step) {
      const kickoff = this.kickoff(progress.roomId, startId);
      progress = this.save({ kickoffId: startId, status: kickoff.reply ? 'complete' : kickoff.active ? 'starting' : 'failed',
        step: kickoff.reply ? 'done' : 'remote' });
    }
    if (progress.roomId && !progress.conversationFlow && ['starting', 'guiding'].includes(progress.status)) {
      this.save({ status: 'starting', step: 'remote', kickoffId: setupStartId, conversationFlow: true, error: null });
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
    const trigger = messages.find(message => message.clientId === clientId && (message.senderId === 'user'
      || message.senderId === 'system' && message.sourceRefs?.includes(guideSource)));
    const jobs = trigger ? this.chatroom.jobs(roomId).filter(job => job.messageId === trigger.id && job.botId === trigger.toBotId) : [];
    const reply = trigger && messages.find(message => message.replyTo === trigger.id && message.senderId === trigger.toBotId
      && message.kind !== 'error' && message.content?.trim() && jobs.some(job => job.id === message.jobId && job.status === 'completed'));
    return { trigger, reply, latest: jobs.at(-1), active: jobs.some(job => !terminal.has(job.status)) };
  }

  state() {
    let progress = this.record();
    if (progress.pendingGuide && !this.postingGuide) {
      const { clientId, update } = progress.pendingGuide;
      const sent = this.chatroom.messages(progress.roomId).find(message => message.senderId === 'user' && message.clientId === clientId);
      if (sent) progress = this.save({ ...update, guideMessageId: sent.id, pendingGuide: null });
    }
    if (progress.status === 'starting' && !this.submitting) {
      const { reply, latest, active } = this.kickoff(progress.roomId, progress.kickoffId);
      if (reply) progress = this.save({ status: 'guiding', step: 'remote', error: null, script: null });
      else if (latest && !active) progress = this.save({ status: 'failed',
        error: '聊天模型没有返回可用回复。请检查授权、额度和连接，或换一个模型后重试。' });
    }
    const { status, roomId, step, error, remoteRequested, codexRequested } = progress;
    const bot = this.bot();
    return { required: ['pending', 'starting', 'failed'].includes(status), status, roomId: roomId || null,
      step: step || null, error: error || null, remoteRequested, codexRequested,
      bot: { id: bot?.id || 'bot-entry', name: bot?.name || '主 Bot' } };
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
      case 'codex': {
        const executor = this.models.summary().executors.find(item => item.id === 'codex-desktop');
        if (executor?.enabled) text = 'Codex 执行器已接入。你想开始聊天或委托一个工作吗？';
        else if (state.codexRequested) {
          text = '请在部署机打开 Codex，然后从这条消息进入本机设置。确认接入后回来告诉我。';
          localControl = { provider: 'codex', status: 'needs-local-setup' };
        } else text = '内置 Pi 可以直接执行工作。你也可以接入本机 Codex 来执行独立工作。你想接入 Codex 吗？';
        options = executor?.enabled ? [next] : [option('允许接入 Codex 执行器', 'connect-codex'), skip];
        break;
      }
      case 'remote':
        text = state.remoteRequested
          ? '你希望只在自己的设备之间访问，还是需要一个公开网址？私网可以用 Tailscale Serve，公开网址可以用 Cloudflare Tunnel。'
          : remoteQuestion;
        options = [option('Cloudflare Tunnel', 'cloudflare'), option('Tailscale Serve', 'tailscale'), skip];
        break;
      case 'cloudflare':
      case 'tailscale': {
        const entry = (await readRemoteAccess(this.models.dataRoot))[state.step];
        const title = state.step === 'cloudflare' ? 'Cloudflare Tunnel' : 'Tailscale Serve';
        text = entry?.origin && !entry.pending ? title + ' 地址已登记，回复“继续”就可以看执行引擎。'
          : '请用这条消息里的本机设置入口完成 ' + title + '，配置好后回来告诉我。';
        localControl = { provider: state.step, status: entry?.origin && !entry.pending ? 'registered' : 'needs-local-setup', origin: entry?.pending ? null : entry?.origin || null };
        options = [option('刷新配置状态', 'check'), ...(localControl.origin ? [next] : [skip])];
        break;
      }
      default: return null;
    }
    const promptId = this.record().guideMessageId;
    const messageId = localControl && promptId && this.chatroom.messages(state.roomId)
      .findLast(message => message.replyTo === promptId && message.senderId === state.bot.id && message.kind !== 'error')?.id;
    return { step: state.step, text, options: [...options, later], localControl, messageId, error: state.error };
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
    if (state.status === 'paused' && progress.conversationFlow && state.roomId && this.chatroom.store.get('rooms', state.roomId)) {
      this.save({ status: 'guiding', error: null });
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
    let attempt = progress.attempt || 0, kickoffId = progress.conversationFlow && progress.kickoffId || setupStartId;
    const { latest, active } = this.kickoff(room.id, kickoffId);
    if (active) return this.state();
    if (latest && ['completed', 'cancelled'].includes(latest.status)) {
      kickoffId = setupStartId + '-' + ++attempt;
    }
    this.submitting = true;
    this.save({ status: 'starting', step: 'remote', roomId: room.id, kickoffId, attempt, connectionId: selection.id,
      conversationFlow: true, remoteRequested: false, codexRequested: false, guideMessageId: null, pendingGuide: null, error: null });
    try {
      if (latest && ['failed', 'interrupted'].includes(latest.status)) await this.chatroom.retry(latest.id);
      else {
        const original = message && !/^(开始|继续|好|好的|开始吧|继续吧)[。！!\s]*$/.test(message) ? message : '';
        await this.chatroom.post(room.id, { clientId: kickoffId, toBotId: bot.id,
          content: original || '聊天模型已接通。', kind: original ? 'message' : 'event',
          sourceRefs: [guideSource] }, original ? 'user' : 'system',
        { instruction: dialogueInstruction + ' 简短欢迎，然后在这条回复里问远程访问。' + remoteQuestion });
      }
    } catch {
      this.save({ status: 'failed', error: '首条消息暂未开始。请确认主 Bot 可用后重试。' });
    } finally { this.submitting = false; }
    return this.state();
  }

  postMessage(roomId, input) {
    const current = this.record();
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (current.status !== 'guiding' || current.roomId !== roomId || !content) return this.chatroom.post(roomId, input);
    return this.serialize(async () => {
      const state = this.state();
      const clientId = input.clientId || randomUUID();
      const existing = this.chatroom.messages(roomId).find(message => message.senderId === 'user' && message.clientId === clientId);
      if (existing) return existing;
      const guide = state.roomId === roomId && await this.guide(state);
      if (!guide) return this.chatroom.post(roomId, input);
      if (looksLikeSecret(content)) fail('请使用本机设置里的安全输入填写密钥。', 400);
      const update = { ...guideUpdate(state, guide, content), error: null };
      const following = await this.guide({ ...state, ...update });
      const instruction = dialogueInstruction + '\n' + (following?.text || (update.status === 'paused'
        ? '引导已暂停。简短回应用户，等他回来继续。'
        : '配置引导已结束。根据用户的意愿开始聊天，或简单介绍如何委托一项工作。'));
      this.postingGuide = true;
      try {
        this.store.save('onboarding', { id: 'main', pendingGuide: { clientId, update } });
        const sent = await this.chatroom.post(roomId, { ...input, clientId, toBotId: state.bot.id }, 'user', { instruction });
        this.save({ ...update, guideMessageId: sent.id, pendingGuide: null });
        return sent;
      } finally { this.postingGuide = false; }
    });
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
        const step = ({ codex: 'done', remote: action === 'skip' ? 'codex' : action,
          cloudflare: 'codex', tailscale: 'codex' })[guide.step];
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
