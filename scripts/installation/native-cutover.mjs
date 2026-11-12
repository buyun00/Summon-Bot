import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const priorKinds = new Set(['codex', 'codex-cli', 'grok', 'claude-code']);
const now = () => new Date().toISOString();
const safeDirectory = value => typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) && !value.includes('\0');

async function rewrite(path, convert) {
  if (!existsSync(path)) return;
  const value = JSON.parse(await readFile(path, 'utf8')), next = convert(value);
  if (!next) return;
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

/** Offline conversion inside the full-install path. Every legacy row and
 * original event is retained. Only immutable historical data and recovery
 * pointers are produced; no former request is sent during installation. */
export async function migrateNativeExecution(dataRoot, { RecordStore, BotStore }) {
  const legacyPath = join(dataRoot, 'capabilities', 'codex', 'state.sqlite');
  const legacy = existsSync(legacyPath) ? new RecordStore(legacyPath) : null;
  const gateway = new RecordStore(join(dataRoot, 'capabilities', 'gateway', 'state.sqlite'));
  try {
    const recordId = 'pi-native-execution-v1';
    if (gateway.get('data-conversions', recordId)?.status === 'completed') return { applied: false };
    const works = legacy?.list('works') || [], operationRows = legacy?.list('desktopOperations') || [], eventRows = legacy?.list('workEvents') || [];
    const bound = new Map(works.filter(item => item.workId && item.botId).map(item => [item.botId + ':' + item.workId, item]));
    const known = new Set();
    let converted = 0;
    for (const entry of await readdir(join(dataRoot, 'bots'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const path = join(dataRoot, 'bots', entry.name, 'state.sqlite');
      if (!entry.isDirectory() || !existsSync(path)) continue;
      const bot = new BotStore(path);
      try {
        bot.transaction(() => {
          for (const work of bot.listRecords('works')) {
            const key = entry.name + ':' + work.id, remote = bound.get(key);
            const desktop = work.bindings?.findLast(item => item.type === 'codex-desktop');
            const priorCli = work.bindings?.findLast(item => /^cli(?:-|$)/.test(item.type || ''));
            if (remote) known.add(remote.id);
            if (work.bindings?.some(item => item.type === 'native-recovery')) continue;
            if (!remote && !desktop && !priorCli && !priorKinds.has(work.executor?.kind)) continue;
            const legacyBinding = desktop || priorCli;
            const operationId = remote?.operationId || legacyBinding?.operationId || work.waiting?.operationId || null;
            const nativeSessionId = remote?.externalThreadId || legacyBinding?.externalThreadId || legacyBinding?.sessionId ||
              work.executionOutcome?.sessionId || null;
            const operations = remote ? operationRows.filter(item => item.workId === remote.id) : legacyBinding?.operations || [];
            const events = remote ? eventRows.filter(item => item.workId === remote.id) : [];
            const task = (operationId && bot.getRecord('work-events', operationId)?.receipt?.taskId) || work.lastTaskId;
            const requiredRecovery = !['completed', 'cancelled'].includes(work.status) ||
              operations.some(item => ['unknown', 'submitting', 'sending'].includes(item.status)) || remote && !terminal.has(remote.status);
            const source = { priorExecutor: work.executor, priorBinding: legacyBinding, remote, operations, events,
              priorWait: work.waiting, priorStop: work.externalStop, priorOutcome: work.executionOutcome };
            const archiveId = 'cutover:' + key;
            gateway.save('execution-cutover-archives', { id: archiveId, botId: entry.name, workId: work.id, ...source });
            const binding = { id: legacyBinding?.id || archiveId, type: 'native-recovery', origin: 'pre-cutover',
              taskId: task, operationId, nativeSessionId, archiveId, hostId: remote?.hostId || legacyBinding?.hostId || 'local',
              resourceName: remote || desktop ? 'Codex' : work.executor?.kind,
              priorState: remote?.status || legacyBinding?.status || null, lastObservedAt: remote?.observedAt || legacyBinding?.observation?.observedAt || null,
              status: requiredRecovery ? 'recovery-required' : 'historical', observedAt: now(),
              ...(remote?.turnId || desktop?.turnId ? { originalTurnId: remote?.turnId || desktop?.turnId } : {}) };
            const target = work.executor?.target, candidateCwd = work.project?.cwd || target?.cwd || remote?.cwd;
            const project = safeDirectory(candidateCwd) ? { ...work.project, id: work.project?.id || 'directory:' + candidateCwd, cwd: candidateCwd } : work.project;
            const patch = { ...work, executor: { kind: 'pi', ...(project?.cwd ? { target: { type: 'directory', cwd: project.cwd } } : {}) },
              project, bindings: [...(work.bindings || []).filter(item => item !== legacyBinding), binding],
              revision: (work.revision || 0) + 1, updatedAt: now() };
            if (work.externalStop?.status === 'pending') patch.externalStop = { ...work.externalStop, status: 'recovery-required' };
            if (requiredRecovery && !['paused', 'cancelled', 'completed'].includes(work.status)) {
              patch.status = 'waiting';
              patch.waiting = { kind: 'native-recovery', operationId, reason: '保留原会话、进度和产物，待核对原生会话与已发生效果' };
            }
            bot.putRecord('works', patch);
            if (requiredRecovery) for (const accepted of bot.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.workId === work.id))
              bot.updateTask(accepted.id, { status: 'interrupted', error: { code: 'NATIVE_CUTOVER', message: 'Original action retained for reconciliation' } });
            for (const event of bot.listRecords('work-events').filter(item => item.workId === work.id && /^codex_/.test(item.transport?.name || ''))) {
              const historical = { ...event, legacyTransport: event.transport };
              delete historical.transport;
              if (!event.receipt && event.status === 'pending') historical.status = 'historical-unknown';
              bot.putRecord('work-events', historical);
            }
            bot.appendEvent('work.native-cutover', { archiveId, nativeSessionId, status: binding.status, priorStatus: work.status }, { workId: work.id, conversationId: work.conversationId });
            converted++;
          }
        });
      } finally { bot.close(); }
    }
    for (const work of works.filter(item => !known.has(item.id))) {
      gateway.save('historical-executions', { ...work, id: work.id, historical: true, status: terminal.has(work.status) ? work.status : 'blocked',
        priorStatus: work.status, events: eventRows.filter(event => event.workId === work.id),
        operations: operationRows.filter(operation => operation.workId === work.id) });
    }
    for (const [kind, rows] of [['historical-native-works', works], ['historical-native-operations', operationRows], ['historical-native-events', eventRows]]) {
      gateway.transaction(() => { for (const row of rows) gateway.import(kind, row); });
    }
    await rewrite(join(dataRoot, 'config', 'model-connections.json'), value => {
      if (!Object.hasOwn(value, 'executors') && !Object.hasOwn(value, 'workExecutorId')) return null;
      const { executors, workExecutorId, ...current } = value;
      if (executors || workExecutorId) gateway.save('execution-cutover-settings', { id: recordId, executors, workExecutorId });
      return current;
    });
    await rewrite(join(dataRoot, 'config', 'model-usage.json'), value => {
      const current = Object.fromEntries(Object.entries(value).filter(([id]) => !['codex-desktop', 'codex-cli'].includes(id)));
      return Object.keys(current).length === Object.keys(value).length ? null : current;
    });
    await rewrite(join(dataRoot, 'config', 'deployment.json'), value => {
      if (!Object.hasOwn(value, 'codexPath')) return null;
      const { codexPath, ...current } = value;
      return current;
    });
    const oldSteps = new Set(['engine', 'codex', 'grok', 'claude-code']);
    for (const guide of gateway.list('onboarding').filter(item => oldSteps.has(item.step))) {
      gateway.save('onboarding-history', { ...guide, id: 'pre-native:' + guide.id });
      gateway.save('onboarding', { id: guide.id, step: guide.status === 'complete' ? 'done' : 'discover', questionId: randomUUID(), questionText: null, setup: null, error: null });
    }
    gateway.save('data-conversions', { id: recordId, status: 'completed', converted, historical: works.length });
    return { applied: true, converted, historical: works.length };
  } finally { legacy?.close(); gateway.close(); }
}
