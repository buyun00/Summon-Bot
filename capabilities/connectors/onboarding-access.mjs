import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { reject } from '../platform/contract.mjs';
import { bindingOf, httpMethods, httpTarget, pathKey, protocolOf, serviceUrl } from '../services/connection-binding.mjs';
import { plain } from '../services/connection-records.mjs';
import { credentialNames } from '../services/service-connection.mjs';
import { sshBinding } from '../services/ssh-binding.mjs';

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const record = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const strings = (items, valid) => Array.isArray(items) && items.length <= 128 &&
  items.every(item => typeof item === 'string' && item.length <= 4096 && !item.includes('\0') && valid(item));

function localPath(path, directory) {
  try {
    if (typeof path === 'string' && isAbsolute(path)) {
      const actual = realpathSync(path);
      const info = statSync(actual);
      if (directory ? info.isDirectory() : info.isFile()) return actual;
    }
  } catch { /* Give one error for unavailable host paths. */ }
  reject('invalid_onboarding_access', 'Use existing absolute host paths for onboarding grants');
}

function targetOf(target) {
  const account = target?.account ?? null;
  const credential_refs = target?.credential_refs ?? [];
  if (account !== null && (typeof account !== 'string' || !account.trim() || account.length > 120) ||
      !strings(credential_refs, item => environmentName.test(item)))
    reject('invalid_onboarding_access', 'Specify a valid service account and credential references');
  if (target?.protocol === 'ssh') {
    if (!record(target, ['protocol', 'executable', 'ssh'])) reject('invalid_onboarding_access', 'Specify a fixed SSH program and target');
    return { protocol: 'ssh', executable: localPath(target.executable, false), ssh: sshBinding(target.ssh) };
  }
  if (target?.protocol === 'http' && record(target, ['protocol', 'service_url', 'account', 'methods', 'credential_refs'])) {
    const url = serviceUrl(target.service_url);
    if (url && Array.isArray(target.methods) && target.methods.length && target.methods.length <= 128) {
      const methods = target.methods.map(item => record(item, ['url', 'method']) && httpTarget(item));
      if (methods.every(item => item?.url && ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(item.method)))
        return { protocol: 'http', service_url: url, account, methods, credential_refs };
    }
  }
  if (target?.protocol === 'mcp' && target.transport === 'http' &&
      record(target, ['protocol', 'transport', 'url', 'account', 'credential_refs'])) {
    const url = serviceUrl(target.url);
    if (url) return { protocol: 'mcp', transport: 'http', url, account, credential_refs };
  }
  if (target?.protocol === 'mcp' && target.transport === 'stdio' &&
      record(target, ['protocol', 'transport', 'command', 'args', 'workspace_root', 'account', 'env', 'credential_refs'])) {
    const args = target.args ?? [], env = target.env ?? {};
    if (strings(args, () => true) && plain(env) && Object.entries(env).every(([key, ref]) =>
      environmentName.test(key) && record(ref, ['env']) && credential_refs.includes(ref.env)))
      return { protocol: 'mcp', transport: 'stdio', command: localPath(target.command, false), args,
        workspace_root: localPath(target.workspace_root, true), account, env, credential_refs };
  }
  reject('invalid_onboarding_access', 'Specify the exact HTTP methods, MCP launch or SSH target allowed by the host');
}

export function normalizeOnboardingAccess(input) {
  if (input === null) return null;
  if (!record(input, ['discover', 'executables', 'targets', 'credential_refs', 'submit', 'assign_maintainer']))
    reject('invalid_onboarding_access', 'Specify an execution onboarding grant');
  const { discover = {}, executables = [], targets = [], credential_refs = [], submit = false, assign_maintainer = false } = input;
  const { path = false, directories = [] } = discover ?? {};
  if (!record(discover, ['path', 'directories']) || typeof path !== 'boolean' ||
      !strings(directories, isAbsolute) || !strings(executables, isAbsolute) || !strings(credential_refs, item => environmentName.test(item)) ||
      !Array.isArray(targets) || targets.length > 128 || typeof submit !== 'boolean' || typeof assign_maintainer !== 'boolean')
    reject('invalid_onboarding_access', 'Invalid discovery or registration scope');
  return { discover: { path, directories: [...new Set(directories.map(dir => localPath(dir, true)))] },
    executables: [...new Set(executables.map(file => localPath(file, false)))],
    targets: targets.map(targetOf), credential_refs: [...new Set(credential_refs)], submit, assign_maintainer };
}

export function targetAllows(policy, entry) {
  const protocol = protocolOf(entry);
  const config = entry.config;
  if (protocol === 'cli' || protocol === 'codex') return policy.executables.some(file => pathKey(file) === pathKey(config.canonical_file)) &&
    credentialNames(entry).every(name => policy.credential_refs.includes(name));
  const identity = bindingOf(entry);
  if (!identity) return false;
  return policy.targets.some(target => {
    if (target.protocol !== protocol) return false;
    if (protocol === 'ssh') {
      const ssh = sshBinding(config.ssh);
      return pathKey(target.executable) === pathKey(config.canonical_file) && target.ssh.host === ssh.host &&
        target.ssh.port === ssh.port && target.ssh.user === ssh.user &&
        pathKey(target.ssh.identity_file) === pathKey(ssh.identity_file) &&
        ssh.operations.every(operation => target.ssh.operations.some(item => item.id === operation.id && item.command === operation.command &&
          isDeepStrictEqual(item.parameters ?? {}, operation.parameters ?? {})));
    }
    const { methods, credential_refs, service_url, workspace_root, command, ...bind } = target;
    const binding = { ...bind, ...(service_url ? { url: service_url } : {}),
      ...(command ? { command: pathKey(command), workspace: pathKey(workspace_root) } : {}) };
    if (!isDeepStrictEqual(binding, identity) || !credentialNames(entry).every(name => credential_refs.includes(name))) return false;
    return protocol !== 'http' || httpMethods(config).every(method => methods.some(item => isDeepStrictEqual(item, httpTarget(method))));
  });
}
