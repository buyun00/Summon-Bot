import { normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sshBinding } from './ssh-binding.mjs';

export const pathKey = path => typeof path === 'string' ? (process.platform === 'win32' ?
  normalize(path).toLowerCase() : normalize(path)) : null;
export const protocolOf = entry => entry.config.ssh ? 'ssh' : entry.kind;

export function serviceUrl(value) {
  try {
    if (typeof value !== 'string' || !value.trim()) return null;
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash &&
      ![...url.searchParams.keys()].some(key => /token|secret|password|api.?key/i.test(key)) ? url.href : null;
  } catch { return null; }
}

export const httpMethods = config => config.tools ?? [config];
export const httpTarget = method => ({ url: serviceUrl(method.url), method: String(method.method || 'POST').toUpperCase() });

export function bindingOf(entry) {
  const protocol = protocolOf(entry);
  const config = entry.config;
  const workspace = pathKey(config.workspace_root);
  if (protocol === 'http') {
    const url = serviceUrl(config.service_url || (httpMethods(config).length === 1 ? httpMethods(config)[0]?.url : null));
    return url && { protocol, url, account: config.account ?? null };
  }
  if (protocol === 'mcp') {
    const identity = { protocol, transport: config.transport, account: config.account ?? null };
    if (config.transport === 'stdio') return { ...identity, command: pathKey(config.canonical_command ?? config.command), args: config.args ?? [],
      workspace, env: config.env ?? {} };
    const url = serviceUrl(config.url);
    return url && { ...identity, url };
  }
  const identity = { protocol, file: pathKey(config.canonical_file), workspace, workspace_write: config.workspace_write !== false,
    account: config.account ?? null, credentials: [...new Set(config.credential_refs || [])].sort() };
  if (protocol === 'ssh') {
    const { host, port, user, identity_file } = sshBinding(config.ssh);
    return { ...identity, host, port, user, identity_file: pathKey(identity_file) };
  }
  return { ...identity, session_protocol: protocol === 'codex' ? 'app-server' : config.adapter ? 'summon-jsonl' : 'arguments' };
}

export function sameBinding(left, right) {
  const binding = bindingOf(left);
  return Boolean(binding && isDeepStrictEqual(binding, bindingOf(right)));
}
