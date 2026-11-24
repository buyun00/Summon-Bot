import { join, parse, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertPathPolicy, createPathAccess, insideProtectedDirectory, pathWithin, samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { appServerArgs, codexBridge } from '../connectors/codex.mjs';
import { launchArguments } from '../connectors/registry.mjs';
import { usesPromptFile } from '../connectors/recipe.mjs';
import { reject } from '../platform/contract.mjs';
import { codexCredentials, localExecutable, nativeArgs, nativeCommand, nativeEnvironment, redactNativeCredentials } from './native-host.mjs';
import { canSupplyProcessArguments, plain, validateNativePaths } from './connection-records.mjs';
import { sshArguments, sshBinding } from './ssh-binding.mjs';

const programRoot = fileURLToPath(new URL('../../', import.meta.url));
const headlessBridge = fileURLToPath(new URL('../connectors/headless.mjs', import.meta.url));
async function hostCredentialPaths(dataRoot) {
  const home = homedir();
  const paths = [join(dataRoot, 'config'), resolve(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json'),
    process.env.GROK_AUTH_PATH || resolve(process.env.GROK_HOME || join(home, '.grok'), 'auth.json'),
    resolve(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json'), join(home, '.claude.json'),
    ...['.ssh', '.aws', '.azure', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/gcloud'].map(name => join(home, name))];
  const resolved = await Promise.all(paths.map(path => realpath(path).catch(() => null)));
  return [...paths, ...resolved.filter(Boolean)];
}
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

const codexSandboxes = new Set(['danger-full-access', 'workspace-write', 'read-only', 'inherit']);
const codexApprovalPolicies = new Set(['never', 'on-request', 'untrusted', 'on-failure', 'inherit']);

export function codexInput(input, configured = {}, binding) {
  const data = typeof input === 'string' ? { text: input } : input;
  if (!plain(data) || Object.keys(data).some(key => !['text', 'model', 'effort', 'sandbox', 'approval_policy', 'approvalPolicy'].includes(key)))
    reject('invalid_codex_input', 'Codex accepts text and optional model, effort, sandbox, and approval_policy');
  for (const key of ['model', 'effort']) {
    if (data[key] !== undefined) requireText(data[key], key === 'model' ? 128 : 40);
    if (binding?.[key] && data[key] !== undefined && data[key] !== binding[key])
      reject('session_binding_conflict', 'This Codex thread already has a fixed model and effort', 409);
  }
  const requestedSandbox = data.sandbox ?? configured.sandbox;
  const requestedApproval = data.approval_policy ?? data.approvalPolicy ?? configured.approval_policy ?? configured.approvalPolicy;
  if (requestedSandbox !== undefined && !codexSandboxes.has(requestedSandbox))
    reject('invalid_codex_input', 'Codex sandbox must be danger-full-access, workspace-write, read-only, or inherit');
  if (requestedApproval !== undefined && !codexApprovalPolicies.has(requestedApproval))
    reject('invalid_codex_input', 'Codex approval_policy must be never, on-request, untrusted, on-failure, or inherit');
  const model = binding?.model || data.model || configured.model;
  const effort = binding?.effort || data.effort || configured.effort;
  const sandbox = requestedSandbox ?? 'danger-full-access';
  const approvalPolicy = requestedApproval ?? 'never';
  return { text: requireText(data.text, 100_000), model, effort, sandbox, approvalPolicy };
}

export async function executionWorkspace(session, entry, { workspace, dataRoot }) {
  const scope = session.workspace;
  const selected = scope?.path;
  if (!selected && (entry.kind === 'cli' || entry.kind === 'codex'))
    reject('workspace_required', 'This native Session needs a working directory', 409);
  const root = scope?.root || entry.config.workspace_root || workspace;
  const target = selected || root;
  const requestedPolicy = session.path_policy || scope?.path_policy || {};
  const releaseRoot = await realpath(programRoot);
  const protectedDirectories = [dataRoot, releaseRoot];
  const credentialPaths = await hostCredentialPaths(dataRoot);
  const checked = createPathAccess({ workspace: root, project: root, base: root, protectedDirectories,
    protectedPath: path => credentialPaths.some(cred => pathWithin(cred, path)), accessPolicy: requestedPolicy });
  const cwd = await checked(target, { directory: true, operations: ['read'], alternative: true });
  const isReadOnly = scope?.write === false || entry.config.workspace_write === false;
  if (pathWithin(dataRoot, cwd) || pathWithin(releaseRoot, cwd))
    reject('workspace_forbidden', 'The execution directory cannot be inside a protected Summon runtime directory', 403);
  return { cwd, checked, accessPolicy: requestedPolicy, isReadOnly, credentialPaths, hasFileScope: false };
}

export async function connectionExecutable(entry, cwd, dataRoot, policy = {}, credentialPaths) {
  validateNativePaths(entry.config);
  const { file } = entry.config;
  const operations = ['execute'];
  assertPathPolicy(file, policy, { operations, alternative: true });
  const actual = await localExecutable(file);
  credentialPaths ??= await hostCredentialPaths(dataRoot);
  if ([file, actual.canonicalFile].some(path => insideProtectedDirectory(path, cwd, [dataRoot, programRoot]) ||
      credentialPaths.some(root => pathWithin(root, path))))
    reject('executable_forbidden', 'The executable resolves to a protected host path', 403);
  assertPathPolicy(actual.canonicalFile, policy, { operations, alternative: true });
  return actual.canonicalFile;
}

export async function registeredScript(dataRoot, id, path) {
  const data = await realpath(dataRoot);
  const root = join(data, 'capabilities', 'skills', id);
  const scripts = join(root, 'scripts');
  const scriptPath = resolve(root, path);
  if (!pathWithin(scripts, scriptPath))
    reject('invalid_script', 'The registered script path escapes its connection directory', 403);
  const script = await createPathAccess({ workspace: data, projectOnly: true })(scriptPath, { file: true });
  if (!pathWithin(scripts, script)) reject('invalid_script', 'The registered script resolves outside its connection directory', 403);
  return script;
}

export async function prepareProcess({ host, entry, session, call, input, prior, guard }) {
  const { cwd, accessPolicy, isReadOnly, credentialPaths } = await executionWorkspace(session, entry, host);
  const executable = await connectionExecutable(entry, cwd, host.dataRoot, accessPolicy, credentialPaths);
  const storePath = host.store.path;
  if (entry.config.ssh) {
    return { ...nativeCommand(executable, sshArguments(sshBinding(entry.config.ssh), input)),
      cwd, guard, storePath, keepInput: false, protocol: 'stdin', method: input?.method };
  }
  if (entry.kind === 'codex') {
    const payload = codexInput(input, entry.config, prior?.binding);
    const { env, authorizedEnv } = codexCredentials(entry.config);
    const { secrets } = nativeEnvironment(env, authorizedEnv, { codex: true });
    const mode = entry.config.app_server_stdio;
    const additional = launchArguments(entry.config.launch_arguments, Boolean(prior?.thread_id));
    requireCredentialReferences([payload.text, ...additional], secrets);
    nativeCommand(executable, nativeArgs([...appServerArgs(mode), ...additional]));
    const bridgeArgs = additional.length || mode && mode !== 'flag' ? [mode ?? 'flag', ...additional] : [];
    return { file: process.execPath, args: [codexBridge, executable, ...bridgeArgs],
      cwd, guard, storePath, keepInput: true, protocol: 'codex',
      appServerLaunch: { mode: mode ?? 'flag', args: additional },
      sessionId: prior?.thread_id || null, env, authorizedEnv,
      input: JSON.stringify({ summonStart: { ...payload, sessionId: prior?.thread_id || null, ...(isReadOnly ? { readOnly: true } : {}),
        callId: call.id, guard, storePath } }) + '\n' };
  }
  if (entry.config.adapter) {
    const data = typeof input === 'string' ? { text: input } : input;
    if (!plain(data) || Object.keys(data).some(key => !['text', 'args'].includes(key)))
      reject('invalid_cli_input', 'This connector accepts a text prompt and optional args array');
    const adapter = entry.config.adapter;
    const text = requireText(data.text, 100_000);
    const extraArgs = data.args !== undefined ? nativeArgs(data.args) : [];
    const { env, authorizedEnv } = codexCredentials(entry.config);
    const { secrets } = nativeEnvironment(env, authorizedEnv);
    const sessionId = prior?.original_native_id ?? prior?.requested_native_id ?? null;
    requireCredentialReferences([text, ...launchArguments(entry.config.launch_arguments, Boolean(sessionId)), ...extraArgs], secrets);
    const scripted = adapter.source !== undefined;
    let interpreter = process.execPath;
    if (scripted) {
      const runner = host.get(adapter.runner?.id);
      for (const actor of [session.execution_actor, call.submitted_by, call.initiating_principal].filter(Boolean))
        host.requireUsable(entry, actor);
      await executionWorkspace(session, runner, host);
      interpreter = await connectionExecutable(runner, cwd, host.dataRoot, accessPolicy, credentialPaths);
    }
    return { file: interpreter, args: scripted ? [] : [headlessBridge], cwd, guard, storePath, keepInput: false, protocol: 'summon-jsonl',
      adapterSource: adapter.source, managedAdapter: true,
      usesPromptFile: !scripted && (adapter.recipe ? usesPromptFile(adapter.recipe) : adapter.settings.promptFile === true),
      sessionId, env, authorizedEnv, input: JSON.stringify({ summonStart: {
        executable, text, sessionId, connector: adapter.connector, settings: adapter.settings, recipe: adapter.recipe,
        launchOptions: entry.config.launch_arguments, extraArgs,
      } }) + '\n' };
  }
  if (!plain(input) || Object.keys(input).some(key => !['method', 'parameters', 'args', 'stdin', 'keep_input'].includes(key)))
    reject('invalid_cli_input', 'CLI input accepts a method or explicit arguments and optional stdin');
  if (input.method !== undefined && (typeof input.method !== 'string' || !input.method || input.args !== undefined))
    reject('invalid_cli_input', 'Supply either a configured method or explicit arguments');
  if (input.parameters !== undefined && !plain(input.parameters)) reject('invalid_cli_input', 'CLI method parameters must be an object');
  const method = input.method && entry.config.methods?.find(item => item.id === input.method);
  if (input.method && !method) reject('method_not_found', 'The configured CLI method is unavailable', 404);
  if (typeof (input.keep_input ?? false) !== 'boolean') reject('invalid_cli_input', 'keep_input must be boolean');
  const parameters = input.parameters || {};
  const templateArgs = method?.args;
  const argv = nativeArgs(templateArgs ? templateArgs.map(value => template(value, parameters)) : input.args);
  const stdin = input.stdin ?? template(method?.input, parameters);
  const keepInput = method?.keep_input ?? input.keep_input === true;
  const protocol = method?.protocol === 'summon-jsonl' ? 'summon-jsonl' : 'stdin';
  if (stdin !== undefined) requireText(stdin, 32_768);
  const args = [...argv];
  let file = executable;
  if (method?.script) {
    file = process.execPath;
    args.unshift(await registeredScript(host.dataRoot, entry.id, method.script));
  }
  const authorizedEnv = entry.config.credential_refs || [];
  const { secrets } = nativeEnvironment(method?.env, authorizedEnv);
  requireCredentialReferences([...args, stdin], secrets);
  nativeCommand(file, args);
  return { file, args, cwd, guard, storePath, input: stdin, keepInput, protocol, method: method?.id, env: method?.env, authorizedEnv };
}
