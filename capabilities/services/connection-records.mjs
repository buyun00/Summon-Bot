import { isAbsolute } from 'node:path';
import { reject } from '../platform/contract.mjs';

export const connectionRecords = 'platform-connections';
export const executionRecords = 'platform-sessions';
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = ['cli', 'codex', 'http', 'mcp'];
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function connectionAllowed(entry, actor) {
  return Boolean(entry && actor && (actor.kind === 'user' || entry.allowed_bot_ids?.includes('*') || entry.allowed_bot_ids?.includes(actor.id)));
}

export function connectionAuthorized(entry, actor, getConnection, seen = new Set()) {
  if (!entry?.enabled || seen.has(entry.id) || !connectionAllowed(entry, actor)) return false;
  const visited = new Set([...seen, entry.id]);
  return (entry.dependencies || []).every(id => {
    const dependency = getConnection(id);
    return (dependency?.workspaceProfileId ?? null) === (entry.workspaceProfileId ?? null) &&
      connectionAuthorized(dependency, actor, getConnection, visited);
  });
}

export function validateNativePaths({ file, canonical_file, workspace_root }) {
  const absolute = path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0');
  if (!absolute(file) || !absolute(canonical_file))
    reject('invalid_connection', 'The connection must be bound to a registered absolute executable path');
  if (workspace_root && !absolute(workspace_root))
    reject('invalid_connection', 'Workspace root must be an absolute host path');
}

export function validateConnection(entry) {
  if (!kinds.includes(entry.kind) || !plain(entry.config)) reject('invalid_connection', 'Invalid connection kind or configuration');
  if (!Array.isArray(entry.allowed_bot_ids) || entry.allowed_bot_ids.some(id => typeof id !== 'string' || !id)) {
    reject('invalid_connection', 'Specify the granted Bot identities');
  }
  if (typeof entry.enabled !== 'boolean') reject('invalid_connection', 'Connection enabled must be a boolean');
  if (entry.dependencies && (!Array.isArray(entry.dependencies) || entry.dependencies.some(id => typeof id !== 'string' || !id))) {
    reject('invalid_connection', 'Invalid connection dependencies');
  }
  if (entry.kind === 'cli' || entry.kind === 'codex') {
    validateNativePaths(entry.config);
    const { credential_refs, methods, allow_arguments, workspace_write, model, effort } = entry.config;
    if (credential_refs !== undefined && (!Array.isArray(credential_refs) ||
        credential_refs.some(name => typeof name !== 'string' || !envName.test(name)))) reject('invalid_connection', 'Invalid native credential references');
    if (allow_arguments !== undefined && typeof allow_arguments !== 'boolean' || workspace_write !== undefined && typeof workspace_write !== 'boolean')
      reject('invalid_connection', 'Invalid native workspace or argument access');
    if (methods !== undefined && (!Array.isArray(methods) || methods.some(method => !plain(method) ||
        typeof method.id !== 'string' || !method.id || !Array.isArray(method.args) ||
        method.args.some(arg => typeof arg !== 'string') || method.env !== undefined && !plain(method.env))))
      reject('invalid_connection', 'Native methods need an identity and argument template');
    if (entry.kind === 'codex' && (model !== undefined && (typeof model !== 'string' || !model.trim()) ||
        effort !== undefined && (typeof effort !== 'string' || !effort.trim() || !model)))
      reject('invalid_connection', 'Codex defaults require an explicit model and reasoning effort');
  }
}
