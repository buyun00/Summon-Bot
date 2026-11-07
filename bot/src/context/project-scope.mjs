// A local authorization scope is independent of a native executor's project ID.
// Callers must resolve directory access with the ordinary file capability first.
export function directoryProject(cwd) {
  if (typeof cwd !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(cwd)) throw new Error('An authorized absolute directory is required');
  let path = cwd.replaceAll('\\', '/').replace(/\/+$/, '');
  if (/^[A-Za-z]:$/.test(path)) path += '/';
  if (!path) path = '/';
  const key = /^(?:[A-Za-z]:|\/\/)/.test(path) ? path.toLowerCase() : path;
  return { id: `directory:${key}`, cwd, hostId: 'local', kind: 'directory', nativeRegistration: 'unconfirmed' };
}
