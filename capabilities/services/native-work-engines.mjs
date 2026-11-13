import { fileURLToPath } from 'node:url';
import { dirname, parse } from 'node:path';
import { readConnectionCatalog } from '../../bot/src/agent/connections.mjs';
import { assertPathPolicy, insideProtectedDirectory, pathWithin, samePath } from '../../bot/src/capabilities/file-policy.mjs';
import { inspectNative } from './native-host.mjs';

const bridge = fileURLToPath(new URL('./codex-work-bridge.mjs', import.meta.url));
const version = /^codex-cli 0\.167\.\d+(?:[ -]|$)/;
export const workAdapters = [{
  id: 'codex-app-server',
  executable: 'codex',
  name: 'Codex',
  aliases: ['codex', 'codex-cli'],
  methodId: 'work-session',
  args: ['app-server', '--stdio'],
  helpArgs: ['app-server', '--help'],
  matches: value => version.test(value || ''),
  account: (file, cwd, signal) => inspectNative(process.execPath, [bridge, file, 'account'], cwd, { signal, timeoutMs: 12_000 }),
  launch: (file, input) => ({ file: process.execPath, args: [bridge, file], input: JSON.stringify({ summonStart: input }) + '\n',
    keepInput: true, protocol: 'summon-jsonl', engine: true }),
}];
export const workAdapter = entry => workAdapters.find(adapter => [entry.config?.executableName, ...(entry.native?.aliases || [])].includes(adapter.executable));

const pi = { id: 'pi', kind: 'pi', name: 'Pi', role: 'executor', status: 'ready', enabled: true, configured: true,
  label: '已接入', usage: { status: 'shared', note: 'Pi 使用已连接的聊天模型。' } };
export function workEngineMethod(entry) {
  const current = (entry.native?.methods || []).filter(method => method.role === 'work-engine' &&
    method.resourceRevision === entry.native.resourceRevision);
  return current.find(method => !method.adapter) || current[0];
}

export function workEngineChoices(entries, configuredId, catalogState, sources = []) {
  const executors = entries.flatMap(entry => {
    const method = workEngineMethod(entry), adapter = workAdapter(entry);
    const previous = entry.native?.methods?.some(item => item.role === 'work-engine');
    if (!adapter && !method && !previous) return [];
    const account = entry.native.workEngineAccount;
    const available = catalogState(entry).available && entry.enabled;
    const authenticated = account?.resourceRevision === entry.native.resourceRevision && account.status === 'connected';
    const enabled = Boolean(available && method);
    const status = !available ? 'unavailable' : !method ? 'method-needed' :
      authenticated ? 'ready' : account?.status === 'login-required' ? 'login-required' : 'account-unconfirmed';
    const label = { ready: '已接入', 'method-needed': '待补齐执行方法', 'login-required': '待登录',
      'account-unconfirmed': '账号待确认', unavailable: '不可用' }[status];
    const usage = sources.find(source => source.resourceId === entry.id && source.usage)?.usage ||
      { status: 'unsupported', unsupported: true, note: account?.note || label };
    return [{ id: entry.id, kind: 'native', name: adapter?.name || entry.name, role: 'executor',
      resourceId: entry.id, ownerBotId: entry.ownerBotId, aliases: [...new Set([entry.name, entry.config.executableName, ...(adapter?.aliases || [])])],
      enabled: status === 'ready', methodAvailable: enabled, configured: status === 'ready', status, label, usage }];
  });
  const selected = [pi, ...executors].find(item => item.id === configuredId ||
    item.aliases?.some(name => name.toLowerCase() === String(configuredId || '').toLowerCase()));
  const preferred = selected || executors.find(item => item.configured) || executors.find(item => item.methodAvailable) ||
    (executors.length === 1 ? executors[0] : null);
  return { defaultId: preferred?.id || null, executors: [pi, ...executors] };
}

export function workEngineConfig(model) {
  if (!model?.connectionStore) return null;
  try { return readConnectionCatalog(model.connectionStore).workExecutorId || null; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

export async function nativeWorkScope(context, operation, protectedRoot) {
  const { cwd, checkedPath, policy, config, work } = context;
  const filesystem = {}, grants = policy?.grants || [], denies = policy?.deniedPaths || [];
  const explicitOutputs = grants.some(grant => grant.operations.includes('write') || grant.operations.includes('publish'));
  const workRoot = await checkedPath(cwd, { directory: true, operations: ['read'], alternative: true });
  // Published inputs and explicit output scopes remain enforced when the agent
  // calls a shell inside Codex. The adapter cannot approve sandbox escapes.
  for (const { path, kind, operations } of grants) {
    if (!operations.includes('read') && !operations.includes('write')) continue;
    const access = operations.includes('write') ? 'write' : 'read';
    const actual = await checkedPath(path, { directory: kind === 'directory', file: kind === 'file',
      operations: access === 'write' ? ['write'] : ['read'], exists: access !== 'write', alternative: true });
    filesystem[actual] = access;
  }
  for (const deny of denies) {
    if (deny.operations?.every(op => op === 'publish')) continue;
    const access = !deny.operations || deny.operations.some(op => op === 'read' || op === 'execute') ? 'deny' : 'read';
    if (access === 'read' && !pathWithin(workRoot, deny.path) && !Object.entries(filesystem).some(([root, value]) =>
      value === 'write' && pathWithin(root, deny.path))) continue;
    filesystem[deny.path] = access;
  }
  if (insideProtectedDirectory(workRoot, config.workspace, [protectedRoot]) || samePath(workRoot, parse(workRoot).root))
    throw new Error('The selected working directory is outside the usable native work scope');
  if (!pathWithin(protectedRoot, workRoot) && pathWithin(workRoot, protectedRoot)) filesystem[protectedRoot] = 'deny';
  if (!operation?.handoffFile || !operation.resultFile || !operation.outputDirectory)
    throw new Error('The accepted work has no saved native handoff or delivery scope');
  const handoff = await checkedPath(operation.handoffFile, { file: true, operations: ['read'], alternative: true });
  const output = await checkedPath(dirname(operation.resultFile), { directory: true, operations: ['read'], alternative: true });
  if (parse(dirname(handoff)).name !== '.summon-handoffs' || parse(output).name !== '.summon-deliverables' ||
      !samePath(dirname(dirname(handoff)), dirname(output)) || !pathWithin(output, operation.outputDirectory))
    throw new Error('The saved handoff or delivery is outside this Bot workspace');
  for (const path of [operation.resultFile, operation.outputDirectory]) assertPathPolicy(path, policy, { operations: ['write'], alternative: true });
  const workspaceMode = explicitOutputs ? 'read' : 'write';
  return { filesystem, workspaceMode, handoffRoot: dirname(handoff), outputRoot: output, project: work.project?.id || null };
}
