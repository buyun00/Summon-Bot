import { join, parse, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { assertPathPolicy, createPathAccess, insideProtectedDirectory, pathWithin, samePath, sensitivePath } from '../../bot/src/capabilities/file-policy.mjs';
import { reject } from '../platform/contract.mjs';
import { checkedNativeArguments, hasExplicitFileScope } from './native-file-arguments.mjs';
import { localExecutable, nativeArgs, nativeCommand, nativeEnvironment } from './native-host.mjs';
import { checkedNativeReference } from './native-references.mjs';
import { plain, validateNativePaths } from './connection-records.mjs';

export const codexBridge = fileURLToPath(new URL('../codex/app-server.mjs', import.meta.url));
const programRoot = fileURLToPath(new URL('../../', import.meta.url));
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
  if (effort && !model) reject('invalid_codex_input', 'Select an explicit model with the reasoning effort');
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
  const checked = createPathAccess({ workspace: root, project: root, base: root, projectOnly: true, protectedDirectories, accessPolicy });
  const cwd = await checked(target, { directory: true, operations: ['read'], alternative: true });
  const connectionRoot = entry.config.workspace_root && await realpath(entry.config.workspace_root);
  if (connectionRoot && !pathWithin(connectionRoot, cwd)) reject('workspace_forbidden', 'The workspace is outside the connection’s granted directory', 403);
  const isReadOnly = scope?.write === false || entry.config.workspace_write === false || (accessPolicy.grants || [])
    .some(grant => grant.operations.includes('write') && !pathWithin(grant.path, cwd));
  if (samePath(cwd, parse(cwd).root) || samePath(cwd, dataRoot) || pathWithin(cwd, dataRoot) ||
      pathWithin(cwd, releaseRoot) || pathWithin(releaseRoot, cwd))
    reject('workspace_forbidden', 'The execution workspace overlaps a protected host directory', 403);
  if (!isReadOnly) await checked(cwd, { directory: true, operations: ['write'], alternative: true });
  return { cwd, checked, accessPolicy, isReadOnly, hasFileScope: hasExplicitFileScope(requestedPolicy) };
}

export async function connectionExecutable(entry, cwd, dataRoot, policy = {}) {
  validateNativePaths(entry.config);
  const { file, canonical_file: expected } = entry.config;
  const operations = ['execute'];
  assertPathPolicy(file, policy, { operations, alternative: true });
  const actual = await localExecutable(file);
  if (!samePath(actual.canonicalFile, expected))
    reject('executable_binding_changed', 'The registered executable points to a different installation', 409);
  if ([file, actual.canonicalFile].some(path => sensitivePath(path, cwd) || insideProtectedDirectory(path, cwd, [dataRoot, programRoot])))
    reject('executable_forbidden', 'The executable resolves to a protected host path', 403);
  assertPathPolicy(actual.canonicalFile, policy, { operations, alternative: true });
  return actual.canonicalFile;
}

export async function prepareProcess({ host, entry, session, call, input, prior, guard }) {
  const { cwd, checked, accessPolicy, isReadOnly, hasFileScope } = await executionWorkspace(session, entry, host);
  const executable = await connectionExecutable(entry, cwd, host.dataRoot, accessPolicy);
  const storePath = host.store.path;
  if (entry.kind === 'codex') {
    if (hasFileScope)
      reject('scoped_process_unsupported', 'Codex cannot confirm these explicit file path restrictions in its native configuration', 403);
    const expected = prior?.binding;
    if (prior && (!expected?.model || !expected?.effort)) reject('codex_binding_unavailable', 'The original Codex model and effort are unavailable', 409);
    const payload = codexInput(input, entry.config, expected);
    if (host.clean(payload.text) !== payload.text) reject('invalid_codex_input', 'Use configured credentials for Codex execution');
    return { file: process.execPath, args: [codexBridge, executable], cwd, guard, storePath, keepInput: true, protocol: 'codex',
      sessionId: prior?.thread_id || null,
      input: JSON.stringify({ summonStart: { ...payload, sessionId: prior?.thread_id || null, ...(isReadOnly ? { readOnly: true } : {}),
        callId: call.id, guard, storePath } }) + '\n' };
  }
  if (!plain(input) || Object.keys(input).some(key => !['method', 'parameters', 'args', 'stdin', 'keep_input', 'file_args'].includes(key)))
    reject('invalid_cli_input', 'CLI input accepts a method or explicit arguments and optional stdin');
  if (input.method !== undefined && (typeof input.method !== 'string' || input.args !== undefined || input.file_args !== undefined))
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
  if (stdin !== undefined) {
    requireText(stdin, 32_768);
    if (host.clean(stdin) !== stdin) reject('invalid_cli_input', 'Use configured credential references for process input');
  }
  if (isReadOnly)
    reject('scoped_process_unsupported', 'This CLI process cannot enforce the workspace’s read-only grant', 403);
  if (hasFileScope &&
      (method?.script || keepInput || stdin !== undefined || /\.(?:cmd|bat|ps1)$/i.test(executable)))
    reject('scoped_process_unsupported', 'This process input mode cannot enforce the Session’s file restrictions', 403);
  const args = await checkedNativeArguments({ argv, templateArgs, fileArgs, effect: method?.effect === 'read' ? 'read' : 'write', cwd,
    policy: accessPolicy, checkedPath: checked, resolveReference: id => checkedNativeReference(id,
      { policy: accessPolicy, protectedDirectories: [host.dataRoot] }) });
  if (args.some(value => host.clean(value) !== value)) reject('invalid_cli_input', 'Use configured credential references for process arguments');
  let file = executable;
  if (method?.script) {
    const root = join(host.dataRoot, 'capabilities', 'skills', entry.id);
    if (!pathWithin(join(root, 'scripts'), resolve(root, method.script)))
      reject('invalid_script', 'The registered script path escapes its connection directory', 403);
    const script = await createPathAccess({ workspace: root, projectOnly: true })(method.script, { file: true });
    file = process.execPath;
    args.unshift(script);
  }
  const authorizedEnv = entry.config.credential_refs || [];
  nativeEnvironment(method?.env, authorizedEnv);
  nativeCommand(file, args);
  return { file, args, cwd, guard, storePath, input: stdin, keepInput, protocol, env: method?.env, authorizedEnv };
}
