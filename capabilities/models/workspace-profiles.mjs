import { reject } from '../platform/contract.mjs';

export const profileRecords = 'platform-workspace-profiles';
export const validProfile = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export class WorkspaceProfiles {
  constructor(store) { this.store = store; }

  get(id) {
    if (!validProfile(id)) reject('workspace_not_found', 'The selected workspace is unavailable', 404);
    const record = this.store.get(profileRecords, id);
    if (!record) reject('workspace_not_found', 'The selected workspace is unavailable', 404);
    return record;
  }

  list() { return this.store.list(profileRecords); }

  create(id) {
    if (!validProfile(id)) reject('invalid_workspace', 'Invalid workspace ID');
    return this.store.get(profileRecords, id) ?? this.store.save(profileRecords, { id, name: '新工作区' });
  }
}
