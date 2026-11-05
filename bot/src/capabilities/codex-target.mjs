// Display metadata is not part of the Desktop execution protocol.
export function codexTarget(value) {
  const target = typeof value === 'string' ? { type: 'project', projectId: value } : value;
  if (!target || typeof target !== 'object') return undefined;
  const type = target.type || (target.projectId ? 'project' : undefined);
  if (type === 'project') return { type, projectId: target.projectId,
    ...(target.environment ? { environment: { type: target.environment.type } } : {}) };
  if (type === 'projectless') return { type, ...(target.directoryName ? { directoryName: target.directoryName } : {}) };
  return { type };
}
