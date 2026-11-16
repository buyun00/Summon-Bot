import { samePath } from '../../bot/src/capabilities/file-policy.mjs';

export function executableScope({ session, conversation }) {
  return session?.executable_scope ?? conversation?.connection_setup?.executables;
}

export function allowsExecutable(scope, canonicalFile) {
  return scope === undefined || Boolean(canonicalFile && scope.some(item => item.canonical_file && samePath(item.canonical_file, canonicalFile)));
}

export function allowsConnection(scope, entry, getConnection) {
  if (scope === undefined) return true;
  if (!entry || !['cli', 'codex'].includes(entry.kind) || !allowsExecutable(scope, entry.config.canonical_file)) return false;
  const runner = entry.config.adapter?.runner;
  return !runner || allowsExecutable(scope, getConnection(runner.id)?.config.canonical_file);
}

export function enclosesExecutableScope(scope, child) {
  return scope === undefined || child !== undefined && child.every(item => !item.canonical_file || allowsExecutable(scope, item.canonical_file));
}
