import { basename, extname, isAbsolute } from 'node:path';
import { reject, validateAdapterRecipe, validateLaunchArguments } from '../platform/contract.mjs';
import { connectorFor } from '../connectors/registry.mjs';
import { sshBinding } from './ssh-binding.mjs';

export const connectionRecords = 'platform-connections';
export const executionRecords = 'platform-sessions';
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const canSupplyProcessArguments = (entry, actor) =>
  !entry.config.ssh && (actor?.kind === 'user' || entry.config.allow_arguments === true);
const kinds = ['cli', 'codex', 'http', 'mcp'];
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function connectionAllowed(entry, actor) {
  return Boolean(entry && (actor?.kind === 'user' || actor?.kind === 'bot' && entry.enabled));
}

export function connectionAuthorized(entry, actor, getConnection, seen = new Set()) {
  if (!entry?.enabled || seen.has(entry.id) || !connectionAllowed(entry, actor)) return false;
  const visited = new Set([...seen, entry.id]);
  const adapter = entry.config.adapter;
  if (adapter?.source !== undefined) {
    const runner = adapter.runner && getConnection(adapter.runner.id);
    if (runner?.kind !== 'cli' || runner.config.adapter || (runner.binding_version ?? 1) !== adapter.runner.binding_version ||
        !entry.dependencies?.includes(runner.id) || !canSupplyProcessArguments(runner, actor)) return false;
  }
  return (entry.dependencies || []).every(id => {
    const dependency = getConnection(id);
    return connectionAuthorized(dependency, actor, getConnection, visited);
  });
}

export function validateNativePaths({ file, canonical_file, workspace_root }) {
  const absolute = path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0');
  if (!absolute(file) || !absolute(canonical_file))
    reject('invalid_connection', 'The connection must be bound to a registered absolute executable path');
  if (workspace_root && !absolute(workspace_root))
    reject('invalid_connection', 'The working directory must be an absolute host path');
}

export function validateConnection(entry) {
  if (!kinds.includes(entry.kind) || !plain(entry.config)) reject('invalid_connection', 'Invalid connection kind or configuration');
  if (typeof entry.enabled !== 'boolean') reject('invalid_connection', 'Connection enabled must be a boolean');
  if (entry.dependencies && (!Array.isArray(entry.dependencies) || entry.dependencies.some(id => typeof id !== 'string' || !id))) {
    reject('invalid_connection', 'Invalid connection dependencies');
  }
  if (entry.kind === 'cli' || entry.kind === 'codex') {
    validateNativePaths(entry.config);
    const { credential_refs, methods, adapter, app_server_stdio, launch_arguments, allow_arguments, workspace_write, model, effort } = entry.config;
    if (entry.config.ssh !== undefined) {
      const file = entry.config.canonical_file;
      if (entry.kind !== 'cli' || adapter || methods || allow_arguments || credential_refs?.length ||
          basename(file, extname(file)).toLowerCase() !== 'ssh' || process.platform === 'win32' && extname(file).toLowerCase() !== '.exe')
        reject('invalid_ssh_binding', 'SSH uses fixed operations for its registered target');
      sshBinding(entry.config.ssh);
    }
    if (credential_refs !== undefined && (!Array.isArray(credential_refs) ||
        credential_refs.some(name => typeof name !== 'string' || !envName.test(name)))) reject('invalid_connection', 'Invalid native credential references');
    if (allow_arguments !== undefined && typeof allow_arguments !== 'boolean' || workspace_write !== undefined && typeof workspace_write !== 'boolean')
      reject('invalid_connection', 'Invalid native workspace or argument access');
    if (methods !== undefined && (!Array.isArray(methods) || methods.some(method => !plain(method) ||
        typeof method.id !== 'string' || !method.id || !Array.isArray(method.args) ||
        method.args.some(arg => typeof arg !== 'string') || method.env !== undefined && !plain(method.env)) ||
        new Set(methods.map(method => method.id)).size !== methods.length))
      reject('invalid_connection', 'Native methods need an identity and argument template');
    if (adapter !== undefined) {
      const builtIn = connectorFor(adapter?.connector);
      const format = adapter?.source !== undefined ? 'script' : adapter?.recipe !== undefined ? 'recipe' : 'builtin';
      if (entry.kind !== 'cli' || !plain(adapter) || typeof adapter.resume !== 'boolean')
        reject('invalid_connection', 'Invalid CLI adapter binding');
      if (format === 'script' && (typeof adapter.source !== 'string' || !adapter.source.trim() || adapter.source.length > 48_000 || adapter.source.includes('\0') ||
          !plain(adapter.runner) || typeof adapter.runner.id !== 'string' || !Number.isSafeInteger(adapter.runner.binding_version) ||
          !entry.dependencies?.includes(adapter.runner.id) || adapter.runner.id === entry.id || adapter.recipe !== undefined))
        reject('invalid_connection', 'A script requires a registered native runner grant');
      if (format === 'recipe') {
        validateAdapterRecipe(adapter.recipe);
        if (adapter.resume && !adapter.recipe.resume_args) reject('invalid_connection', 'Resuming requires an argument mapping for the same session');
      }
      if (format !== 'script' && adapter.runner) reject('invalid_connection', 'Only an adapter script uses a native runner grant');
      if (format === 'builtin' && (!builtIn?.invocation || !plain(adapter.settings)))
        reject('invalid_connection', 'Use a built-in connector or a registered adapter script');
    }
    if (app_server_stdio !== undefined && (entry.kind !== 'codex' || !['flag', 'listen', 'default'].includes(app_server_stdio)))
      reject('invalid_connection', 'Invalid app-server stdio transport');
    if (launch_arguments !== undefined) validateLaunchArguments(launch_arguments,
      entry.kind === 'codex' ? connectorFor(entry.kind) : adapter?.recipe || adapter?.source !== undefined ? null : connectorFor(adapter?.connector));
    if (entry.kind === 'codex' && (model !== undefined && (typeof model !== 'string' || !model.trim()) ||
        effort !== undefined && (typeof effort !== 'string' || !effort.trim())))
      reject('invalid_connection', 'Codex defaults must be non-empty strings');
  }
}
