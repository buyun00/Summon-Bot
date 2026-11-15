import { join, parse, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertPathPolicy, createPathAccess, insideProtectedDirectory, pathWithin, samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { reject } from '../platform/contract.mjs';
import { checkedNativeArguments, hasExplicitFileScope } from './native-file-arguments.mjs';
import { codexCredentials, localExecutable, nativeArgs, nativeCommand, nativeEnvironment, redactNativeCredentials } from './native-host.mjs';
import { checkedNativeReference } from './native-references.mjs';
import { plain, validateNativePaths } from './connection-records.mjs';

export const codexBridge = fileURLToPath(new URL('../codex/app-server.mjs', import.meta.url));
const programRoot = fileURLToPath(new URL('../../', import.meta.url));
async function hostCredentialPaths(dataRoot) {
  const home = homedir();
  const paths = [join(dataRoot, 'config'), resolve(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json'),
    ...['.ssh', '.aws', '.azure', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/gcloud'].map(name => join(home, name))];
  const resolved = await Promise.all(paths.map(path => realpath(path).catch(() => null)));
  return [...paths, ...resolved.filter(Boolean)];
}
export const canSupplyProcessArguments = (entry, actor) =>
  actor.kind === 'user' || entry.config.allow_arguments === true || entry.direct_bot_ids?.includes(actor.id) === true;

function template(value, parameters) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
    if (!Object.hasOwn(parameters, name) || !['string', 'number', 'boolean'].includes(typeof parameters[name]))
      reject('invalid_arguments', `Missing scalar CLI parameter ${name}`);
    return String(parameters[name]);
  });
}

function requireText(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.includes('\0'))
    reject('invalid_arguments', `Input must contain 1–${max} characters without NUL`);
  return value;
}

function requireCredentialReferences(values, secrets) {
  if (secrets.length && values.some(value => typeof value === 'string' && redactNativeCredentials(value, secrets) !== value))
    reject('inline_credential_forbidden', 'Use the configured process credential reference');
}

export function codexInput(input, configured = {}, binding) {
  const data = typeof input === 'string' ? { text: input } : input;
  if (!plain(data) || Object.keys(data).some(key => !['text', 'model', 'effort'].includes(key)))
    reject('invalid_codex_input', 'Codex accepts text and optional model and effort');
  for (const key of ['model', 'effort']) {
    if (data[key] !== undefined) requireText(data[key], key === 'model' ? 128 : 40);
    if (binding?.[key] && data[key] !== undefined && data[key] !== binding[key])
      reject('session_binding_conflict', 'This Codex thread already has a fixed model and effort', 409);
  }
  const model = binding?.model || data.model || configured.model;
  const effort = binding?.effort || data.effort || configured.effort;
  if (effort && !model && !binding?.effort) reject('invalid_codex_input', 'Select an explicit model with the reasoning effort');
  return { text: requireText(data.text, 100_000), model, effort };
}

export async function executionWorkspace(session, entry, { workspace, dataRoot }, { fromSession = false } = {}) {
  const scope = session.workspace;
  const selected = scope?.path;
  const granted = session.workspace_ref?.kind === 'workspace' && session.resource_refs?.some(ref =>
    ref.kind === 'workspace' && ref.id === session.workspace_ref.id);
  if (!selected && (entry.kind === 'cli' || entry.kind === 'codex'))
    reject('workspace_required', 'This native Session has no persisted workspace grant', 409);
  if (selected && !granted) reject('workspace_forbidden', 'The workspace has no persisted execution grant', 403);
  if (!selected && session.sharing && entry.kind !== 'http' && !(entry.kind === 'mcp' && entry.config.transport === 'http'))
    reject('workspace_forbidden', 'This shared connection requires an explicit workspace grant', 403);
  if (!selected && !entry.config.workspace_root && entry.kind === 'mcp' && entry.config.transport === 'stdio' &&
      (fromSession || session.origin_execution?.kind === 'session'))
    reject('workspace_required', 'Select an authorized workspace or use an MCP stdio connection with a configured working directory', 409);
  const root = scope?.root || entry.config.workspace_root || workspace;
  const target = selected || root;
  const requestedPolicy = session.path_policy || scope?.path_policy || {};
  const accessPolicy = scope?.write === false || entry.config.workspace_write === false ? {
    ...requestedPolicy, deniedPaths: [...(requestedPolicy.deniedPaths || []), { path: root, operations: ['write', 'publish'] }],
  } : requestedPolicy;
  const releaseRoot = await realpath(programRoot);
  const protectedDirectories = [dataRoot, releaseRoot];
  const credentialPaths = await hostCredentialPaths(dataRoot);
  // These paths designate the host stores. Workspace file names have no bearing on their authority.
  const checked = createPathAccess({ workspace: root, project: root, base: root, projectOnly: true, protectedDirectories,
    protectedPath: path => credentialPaths.some(root => pathWithin(root, path)), accessPolicy });
  const cwd = await checked(target, { directory: true, operations: ['read'], alternative: true });
  const connectionRoot = entry.config.workspace_root && await realpath(entry.config.workspace_root);
  if (connectionRoot && !pathWithin(connectionRoot, cwd)) reject('workspace_forbidden', 'The workspace is outside the connection’s granted directory', 403);
  const isReadOnly = scope?.write === false || entry.config.workspace_write === false;
  if (samePath(cwd, parse(cwd).root) || pathWithin(cwd, dataRoot) || pathWithin(cwd, releaseRoot) || pathWithin(releaseRoot, cwd))
    reject('workspace_forbidden', 'The execution workspace overlaps a protected host directory', 403);
  if (!isReadOnly) await checked(cwd, { directory: true, operations: ['write'], alternative: true });
  return { cwd, checked, accessPolicy, isReadOnly, credentialPaths, hasFileScope: hasExplicitFileScope(requestedPolicy) };
}

export async function connectionExecutable(entry, cwd, dataRoot, policy = {}, credentialPaths) {
  validateNativePaths(entry.config);
  const { file, canonical_file: expected } = entry.config;
  const operations = ['execute'];
  assertPathPolicy(file, policy, { operations, alternative: true });
  const actual = await localExecutable(file);
  if (!samePath(actual.canonicalFile, expected))
    reject('executable_binding_changed', 'The registered executable points to a different installation', 409);
  credentialPaths ??= await hostCredentialPaths(dataRoot);
  if ([file, actual.canonicalFile].some(path => insideProtectedDirectory(path, cwd, [dataRoot, programRoot]) ||
      credentialPaths.some(root => pathWithin(root, path))))
    reject('executable_forbidden', 'The executable resolves to a protected host path', 403);
  assertPathPolicy(actual.canonicalFile, policy, { operations, alternative: true });
  return actual.canonicalFile;
}

export async function prepareProcess({ host, entry, session, call, input, prior, guard }) {
  const { cwd, checked, accessPolicy, isReadOnly, credentialPaths, hasFileScope } = await executionWorkspace(session, entry, host);
  const executable = await connectionExecutable(entry, cwd, host.dataRoot, accessPolicy, credentialPaths);
  const storePath = host.store.path;
  if (entry.kind === 'codex') {
    if (hasFileScope)
      reject('scoped_process_unsupported', 'Codex cannot confirm these explicit file path restrictions in its native configuration', 403);
    const payload = codexInput(input, prior ? {} : entry.config, prior?.binding);
    const { env, authorizedEnv } = codexCredentials(entry.config);
    const { secrets } = nativeEnvironment(env, authorizedEnv, { codex: true });
    requireCredentialReferences([payload.text], secrets);
    nativeCommand(executable, ['app-server', '--stdio']);
    return { file: process.execPath, args: [codexBridge, executable], cwd, guard, storePath, keepInput: true, protocol: 'codex',
      sessionId: prior?.thread_id || null, env, authorizedEnv,
      input: JSON.stringify({ summonStart: { ...payload, sessionId: prior?.thread_id || null, ...(isReadOnly ? { readOnly: true } : {}),
        callId: call.id, guard, storePath } }) + '\n' };
  }
  if (!plain(input) || Object.keys(input).some(key => !['method', 'parameters', 'args', 'stdin', 'keep_input', 'file_args'].includes(key)))
    reject('invalid_cli_input', 'CLI input accepts a method or explicit arguments and optional stdin');
  if (input.method !== undefined && (typeof input.method !== 'string' || !input.method || input.args !== undefined || input.file_args !== undefined))
    reject('invalid_cli_input', 'Supply either a configured method or explicit arguments');
  if (input.parameters !== undefined && !plain(input.parameters)) reject('invalid_cli_input', 'CLI method parameters must be an object');
  const method = input.method && entry.config.methods?.find(item => item.id === input.method);
  if (input.method && !method) reject('method_not_found', 'The configured CLI method is unavailable', 404);
  if (typeof (input.keep_input ?? false) !== 'boolean') reject('invalid_cli_input', 'keep_input must be boolean');
  if ((!method || input.stdin !== undefined && !method.keep_input) &&
      (!canSupplyProcessArguments(entry, call.submitted_by) || !canSupplyProcessArguments(entry, session.execution_actor))) {
    reject('process_arguments_forbidden', 'This connection has only configured method access for the caller', 403);
  }
  const parameters = input.parameters || {};
  const templateArgs = method?.args;
  const argv = nativeArgs(templateArgs ? templateArgs.map(value => template(value, parameters)) : input.args);
  const stdin = input.stdin ?? template(method?.input, parameters);
  const keepInput = method?.keep_input ?? input.keep_input === true;
  const fileArgs = method?.file_args ?? input.file_args;
  const protocol = method?.protocol === 'summon-jsonl' ? 'summon-jsonl' : 'stdin';
  if (stdin !== undefined) requireText(stdin, 32_768);
  if (isReadOnly)
    reject('scoped_process_unsupported', 'This CLI process cannot enforce the workspace’s read-only grant', 403);
  if (hasFileScope &&
      (method?.script || keepInput || stdin !== undefined || /\.(?:cmd|bat|ps1)$/i.test(executable)))
    reject('scoped_process_unsupported', 'This process input mode cannot enforce the Session’s file restrictions', 403);
  const args = await checkedNativeArguments({ argv, fileArgs, effect: method?.effect === 'read' ? 'read' : 'write', cwd, hasFileScope,
    checkedPath: checked, resolveReference: id => checkedNativeReference(id,
      { policy: accessPolicy, protectedDirectories: [host.dataRoot] }) });
  let file = executable;
  if (method?.script) {
    const root = join(host.dataRoot, 'capabilities', 'skills', entry.id);
    const scripts = join(root, 'scripts');
    const scriptPath = resolve(root, method.script);
    if (!pathWithin(scripts, scriptPath))
      reject('invalid_script', 'The registered script path escapes its connection directory', 403);
    const script = await createPathAccess({ workspace: scripts, projectOnly: true })(scriptPath, { file: true });
    file = process.execPath;
    args.unshift(script);
  }
  const authorizedEnv = entry.config.credential_refs || [];
  const { secrets } = nativeEnvironment(method?.env, authorizedEnv);
  requireCredentialReferences([...args, stdin], secrets);
  nativeCommand(file, args);
  return { file, args, cwd, guard, storePath, input: stdin, keepInput, protocol, env: method?.env, authorizedEnv };
}
