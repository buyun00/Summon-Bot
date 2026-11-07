// Display metadata is not part of the Desktop execution protocol.
export function codexTarget(value) {
  const target = typeof value === 'string' ? { type: 'project', projectId: value } : value;
  if (!target || typeof target !== 'object') return undefined;
  const type = target.type || (target.cwd || target.path ? 'directory' : target.projectId ? 'project' : undefined);
  if (type === 'directory') return { type, cwd: target.cwd || target.path };
  if (type === 'project') return { type, projectId: target.projectId,
    ...(target.environment ? { environment: { type: target.environment.type } } : {}) };
  if (type === 'projectless') return { type, ...(target.directoryName ? { directoryName: target.directoryName } : {}) };
  return { type };
}

// Directory authority is checked by the same physical-path boundary as file
// tools. The Desktop connector resolves it to a real native project itself.
export async function resolveCodexTarget(value, services, task) {
  const target = codexTarget(value || (services.workspace ? { type: 'directory', cwd: services.workspace } : null));
  if (target?.type !== 'directory') return target;
  if (typeof target.cwd !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(target.cwd))
    throw new Error('Codex directory target requires an authorized absolute cwd');
  const directory = await services.capability('list_files', { path: target.cwd, maxEntries: 1, maxDepth: 0 }, task);
  if (!directory.path) throw new Error('The authorized directory could not be resolved');
  return { type: 'directory', cwd: directory.path };
}
