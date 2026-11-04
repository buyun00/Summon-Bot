import { modelError } from '../../bot/src/agent/connections.mjs';
import { guideReply } from './guide.mjs';

/** Only progress and the real handoff live on the host. Bootstrap dialogue stays in the client. */
export class OnboardingService {
  constructor({ store, models, manager, chatroom, emit }) { Object.assign(this, { store, models, manager, chatroom, emit }); }
  async initialize() {
    if (!this.store.get('onboarding', 'main')) {
      const model = this.models.runtimeModel();
      const configured = model && (model.allowNoKey || await this.models.credentials.read(model.id).catch(() => null));
      this.store.save('onboarding', { id: 'main', status: configured ? 'complete' : 'pending', reason: configured ? 'existing-model' : 'first-run' });
    }
    return this;
  }
  state() {
    const progress = this.store.get('onboarding', 'main');
    return { required: progress?.status === 'pending', status: progress?.status || 'pending', roomId: progress?.roomId || null };
  }
  async snapshot() {
    const modelSettings = await this.models.snapshot();
    return { ...this.state(), modelSettings, configured: modelSettings.connections.some(entry => entry.active && entry.configured) };
  }
  reply(input) { return guideReply(this, input); }
  start(input = {}) {
    if (this.starting) return this.starting;
    this.starting = this.handoff(input).finally(() => { this.starting = null; });
    return this.starting;
  }
  async handoff(input) {
    const progress = this.store.get('onboarding', 'main');
    const selection = this.models.runtimeModel();
    if (!selection || !selection.allowNoKey && !await this.models.credentials.read(selection.id).catch(() => null)) throw new Error('请先接上一个聊天模型，再让主 Bot 继续引导。');
    if (progress?.status === 'complete' && progress.roomId && this.chatroom.store.get('rooms', progress.roomId)) {
      const kickoff = this.chatroom.messages(progress.roomId).find(message => message.clientId === 'summon-onboarding-start');
      const delivery = kickoff && this.chatroom.jobs(progress.roomId).find(job => job.messageId === kickoff.id && !job.retryOf);
      if (delivery && ['failed', 'interrupted'].includes(delivery.status)) await this.chatroom.retry(delivery.id);
      return this.state();
    }
    const bot = this.manager.list().find(entry => entry.presetId === 'entry') || this.manager.list().find(entry => entry.id === 'bot-entry');
    if (!bot || bot.status !== 'active') throw new Error('主 Bot 暂不可用，请先在成员设置中恢复主 Bot。');
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (message.length > 4000 || /\b(?:sk-|xai-)[\w-]{12,}|\beyJ[\w-]+\.[\w-]+\.[\w-]+/.test(message)) throw new Error('请在模型连接的安全输入中填写密钥，不要发送到聊天里。');
    const room = await this.chatroom.createRoom({ id: 'room-onboarding', kind: 'dm', name: `与 ${bot.name} 的私聊`, members: ['user', bot.id] });
    this.store.save('onboarding', { id: 'main', status: 'pending', roomId: room.id });
    try {
      await this.chatroom.post(room.id, { clientId: 'summon-onboarding-start', toBotId: bot.id,
        content: `聊天模型的配置已经保存，带我熟悉一下 Summon Bot 吧。${message && !/^(开始|继续|好|好的|开始吧|继续吧)[。！!\s]*$/.test(message) ? `\n\n${message}` : ''}`,
        sourceRefs: ['summon:onboarding'] });
    } catch (error) { throw new Error(modelError(error)); }
    this.store.save('onboarding', { id: 'main', status: 'complete', roomId: room.id, connectionId: selection.id });
    this.emit('onboarding.changed', {});
    return this.state();
  }
}
