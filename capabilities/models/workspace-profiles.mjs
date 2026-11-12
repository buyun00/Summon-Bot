import { randomUUID } from 'node:crypto';
import { fail, safeId } from '../shared/validation.mjs';
import { ModelConnections } from './service.mjs';
import { OnboardingService } from './onboarding.mjs';

/** A logical workspace owns its onboarding conversation and model connection.
 * It uses the same gateway, host catalog, ports and formal data root. */
export class WorkspaceProfiles {
  constructor({ store, dataRoot, manager, chatroom, emit, ensureSetupAccess, native }) {
    Object.assign(this, { store, dataRoot, manager, chatroom, emit, ensureSetupAccess, native });
    this.instances = new Map();
  }

  list() { return this.store.list('workspace-profiles').map(({ id, name, botId, createdAt }) => ({ id, name, botId, createdAt })); }

  async create(input = {}) {
    const id = input.id || randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail('Invalid workspace identity');
    const record = this.store.get('workspace-profiles', id) || this.store.save('workspace-profiles', { id, botId: 'bot-workspace-' + id, name: '新工作区' });
    await this.get(record.id);
    return { id: record.id, name: record.name, botId: record.botId };
  }

  get(id) {
    safeId(id);
    const profile = this.store.get('workspace-profiles', id);
    if (!profile) fail('工作区不存在。请从应用的工作区选择入口重新打开。', 404);
    let pending = this.instances.get(id);
    if (!pending) {
      pending = this.open(profile).catch(error => { this.instances.delete(id); throw error; });
      this.instances.set(id, pending);
    }
    return pending;
  }

  async open(profile) {
    const { id, botId } = profile;
    const models = await new ModelConnections({ dataRoot: this.dataRoot, profileId: id, emit: this.emit }).initialize();
    try {
      await this.manager.create({ id: botId, roleId: 'entry', workspaceProfileId: id, modelConfig: { connectionStore: models.path } });
      const onboarding = await new OnboardingService({ store: this.store, models, manager: this.manager, chatroom: this.chatroom,
        emit: this.emit, ensureSetupAccess: this.ensureSetupAccess, native: this.native, profileId: id, botId }).initialize();
      return { profile, models, onboarding };
    } catch (error) { await models.close(); throw error; }
  }

  async forWork(workId) {
    const row = this.store.list('onboarding').find(record => record.setup?.workId === workId);
    if (!row || row.id === 'main') return null;
    return this.get(row.id);
  }

  async restore() {
    const pending = this.store.list('onboarding').filter(item => item.id !== 'main' && item.status === 'guiding' && item.setup);
    for (const record of pending) await this.get(record.id);
  }

  async tick() {
    const items = await Promise.allSettled(this.instances.values());
    await Promise.allSettled(items.filter(item => item.status === 'fulfilled').map(item => item.value.onboarding.tick()));
  }

  async close() {
    const items = await Promise.allSettled(this.instances.values());
    await Promise.allSettled(items.filter(item => item.status === 'fulfilled').map(item => item.value.models.close()));
  }
}
