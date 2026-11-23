// Host-registered execution directories form a shared workspace pool for all Bots.
// Physical OS directory protection and read-only/writable flags remain enforced at the file & launch boundary.
export function workspaceGranted(get, actor, id) {
  if (actor?.kind === 'user') return true;
  return Boolean(id && get('platform-workspaces', id));
}
