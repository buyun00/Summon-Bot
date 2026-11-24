import { isAbsolute } from 'node:path';

// All registered workspaces and arbitrary host absolute directories are accessible.
// Only Summon's own runtime/install stores and host credential files remain protected.
export function workspaceGranted(get, actor, id) {
  if (actor?.kind === 'user') return true;
  return Boolean(id && (get('platform-workspaces', id) || isAbsolute(id)));
}
