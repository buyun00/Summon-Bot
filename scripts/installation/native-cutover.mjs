import { existsSync } from 'node:fs';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { externalExecution, HISTORICAL_WORK_DELIVERIES } from '../../bot/src/context/execution-evidence.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const priorKinds = new Set(['codex', 'codex-cli', 'grok', 'claude-code']);
const legacyKindPrefix = 'historical-native-codex:';
const now = () => new Date().toISOString();
const safeDirectory = value => typeof value === 'string' && /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(value) && !value.includes('\0');
const ownerKey = (botId, workId) => JSON.stringify([botId, workId]);

async function rewrite(path, convert) {
  if (!existsSync(path)) return;
  const value = JSON.parse(await readFile(path, 'utf8')), next = convert(value);
  if (!next) return;
  const temporary = path + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

function archiveLegacyRecords(legacy, gateway) {
  const tables = legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'").all();
  const columns = legacy.prepare('PRAGMA table_xinfo(records)').all();
  if (tables.length !== 1 || tables[0].name !== 'records' ||
      columns.map(column => column.name).join(',') !== 'kind,id,created_at,updated_at,data' || columns[0].pk !== 1 || columns[1].pk !== 2)
    throw new Error('The legacy Codex database contains an unsupported table layout. The source database has been retained.');

  const source = legacy.prepare('SELECT kind,id,created_at,updated_at,data FROM records ORDER BY rowid');
  const insert = gateway.db.prepare('INSERT INTO records(kind,id,created_at,updated_at,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO NOTHING');
  const unchanged = gateway.db.prepare('SELECT 1 FROM records WHERE kind=? AND id=? AND created_at=? AND updated_at=? AND data=?');
  return gateway.transaction(() => {
    let count = 0;
    // The destination kind identifies the source database and original kind.
    // Keep the source identity, timestamps and serialized payload intact.
    for (const row of source.iterate()) {
      const values = [legacyKindPrefix + row.kind, row.id, row.created_at, row.updated_at, row.data];
      if (!insert.run(...values).changes && !unchanged.get(...values))
        throw new Error('A legacy Codex archive identity already has different data. The source database has been retained.');
      count++;
    }
    return count;
  });
}

function relatedRows(db, kind) {
  const rows = new Map();
  if (!db) return rows;
  for (const { id, workId } of db.prepare("SELECT id,json_extract(data,'$.workId') AS workId FROM records WHERE kind=? ORDER BY created_at,rowid").iterate(kind)) {
    const ids = rows.get(workId) || [];
    ids.push(id);
    rows.set(workId, ids);
  }
  return rows;
}

function retainDeliveryEvidence(bot, work, binding) {
  const execution = externalExecution(work), outcome = work.executionOutcome;
  const confirmed = execution.bindingId === binding.id && execution.startedConfirmed && execution.externalReceived &&
    execution.operationId === execution.currentOperationId && execution.status === 'completed' && outcome?.kind === 'execution-ended' &&
    outcome.finalConfirmed && outcome.operationId === execution.operationId && outcome.turnId === execution.turnId;
  const receipts = (binding.operations || []).filter(item => item.status === 'received' && item.threadId === binding.externalThreadId)
    .map(({ operationId, verificationOnly, precedingTurn }) => ({ operationId, verificationOnly,
      ...(precedingTurn ? { precedingTurn: { operationId: precedingTurn.operationId, turnId: precedingTurn.turnId, status: precedingTurn.status } } : {}) }));
  bot.putRecord(HISTORICAL_WORK_DELIVERIES, { id: work.id, botId: work.botId, bindingId: binding.id, originalWorkRevision: work.revision,
    source: { referenceType: 'codex', observationSource: 'codex-desktop-connector' }, receipts,
    ...(confirmed ? { final: { operationId: execution.operationId, threadId: execution.threadId, turnId: execution.turnId,
      observedAt: execution.observation.observedAt } } : {}) });
}

/** Offline conversion inside the full-install path. Every legacy row and
 * original event is retained. Only immutable historical data and recovery
 * pointers are produced; no former request is sent during installation. */
export async function migrateNativeExecution(dataRoot, { RecordStore, BotStore }) {
  const legacyPath = join(dataRoot, 'capabilities', 'codex', 'state.sqlite');
  const gateway = new RecordStore(join(dataRoot, 'capabilities', 'gateway', 'state.sqlite'));
  let legacy;
  try {
    const recordId = 'pi-native-execution-v1';
    const previous = gateway.get('data-conversions', recordId);
    if (existsSync(legacyPath)) legacy = new DatabaseSync(legacyPath, { readOnly: true });
    else if (previous?.status !== 'completed' && ['-wal', '-journal'].some(suffix => existsSync(legacyPath + suffix)))
      throw new Error('The legacy Codex database is missing and its transaction files are still present.');
    const archivedRecords = legacy ? archiveLegacyRecords(legacy, gateway) : 0;
    if (previous?.status === 'completed') return { applied: false, ...(legacy ? { archivedRecords } : {}) };

    const works = legacy?.prepare(`SELECT id,created_at AS createdAt,updated_at AS updatedAt,
      json_extract(data,'$.botId') AS botId,json_extract(data,'$.workId') AS workId,
      json_extract(data,'$.roomId') AS roomId,json_extract(data,'$.status') AS status
      FROM records WHERE kind='works' ORDER BY created_at,rowid`).all() || [];
    const bound = new Map(works.filter(item => item.workId && item.botId).map(item => [ownerKey(item.botId, item.workId), item.id]));
    const operationsByWork = relatedRows(legacy, 'desktopOperations'), eventsByWork = relatedRows(legacy, 'workEvents');
    const originalRow = legacy?.prepare('SELECT data FROM records WHERE kind=? AND id=?');
    const readOriginal = (kind, id) => {
      const row = id && originalRow?.get(kind, id);
      return row ? JSON.parse(row.data) : undefined;
    };
    const known = new Set();
    let converted = 0;
    for (const entry of await readdir(join(dataRoot, 'bots'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
      const path = join(dataRoot, 'bots', entry.name, 'state.sqlite');
      if (!entry.isDirectory() || !existsSync(path)) continue;
      const bot = new BotStore(path);
      try {
        bot.transaction(() => {
          for (const work of bot.listRecords('works')) {
            const key = ownerKey(entry.name, work.id), remoteId = bound.get(key);
            const desktop = work.bindings?.findLast(item => item.type === 'codex-desktop');
            const priorCli = work.bindings?.findLast(item => /^cli(?:-|$)/.test(item.type || ''));
            if (remoteId) known.add(remoteId);
            if (work.bindings?.some(item => item.type === 'native-recovery' && item.origin === 'pre-cutover')) { converted++; continue; }
            if (!remoteId && !desktop && !priorCli && !priorKinds.has(work.executor?.kind)) continue;
            const remote = readOriginal('works', remoteId);
            const legacyBinding = desktop || priorCli;
            const legacyBindings = (work.bindings || []).filter(item => item.type === 'codex-desktop' || /^cli(?:-|$)/.test(item.type || ''));
            const operationId = remote?.operationId || legacyBinding?.operationId || work.waiting?.operationId || null;
            const nativeSessionId = remote?.externalThreadId || legacyBinding?.externalThreadId || legacyBinding?.sessionId ||
              work.executionOutcome?.sessionId || null;
            const operations = remote ? (operationsByWork.get(remoteId) || []).map(id => readOriginal('desktopOperations', id)) : legacyBinding?.operations || [];
            const operationTaskId = id => id && (bot.getRecord('work-events', id)?.receipt?.taskId || bot.getTool(id)?.taskId);
            const sourceTaskId = operationTaskId(operationId) || operationTaskId(remote?.executionOperationId || legacyBinding?.executionOperationId) || legacyBinding?.taskId;
            const originalTask = sourceTaskId && bot.getTask(sourceTaskId);
            const taskId = originalTask?.workId === work.id ? sourceTaskId : work.lastTaskId;
            const priorState = remote?.status || legacyBinding?.status || null;
            const unsettledExecution = priorState && !terminal.has(priorState);
            const unsettledWrite = operations.some(item => !item.appliedAt && (item.attemptedAt || item.status === 'received'));
            const unsettledStop = work.externalStop?.status === 'pending';
            const requiredRecovery = unsettledExecution || unsettledWrite || unsettledStop;
            const automaticRecovery = ['active', 'waiting'].includes(work.status) &&
              (work.waiting?.kind === 'external' || work.status === 'active' && !work.waiting) &&
              priorState !== 'waiting_for_input' && !unsettledStop && originalTask?.workId === work.id &&
              (unsettledWrite || nativeSessionId && unsettledExecution);
            const source = { priorExecutor: work.executor, priorBindings: legacyBindings, operations, eventIds: eventsByWork.get(remoteId) || [],
              priorStatus: work.status, priorProject: work.project, priorWait: work.waiting, priorStop: work.externalStop, priorOutcome: work.executionOutcome };
            const archiveId = 'cutover:' + key;
            gateway.save('execution-cutover-archives', { id: archiveId, botId: entry.name, workId: work.id, remoteId, ...source });
            const migratedAt = now();
            const binding = { id: legacyBinding?.id || archiveId, type: 'native-recovery', origin: 'pre-cutover',
              taskId, operationId, nativeSessionId, archiveId, hostId: remote?.hostId || legacyBinding?.hostId || 'local',
              resourceName: remote || desktop ? 'Codex' : work.executor?.kind,
              priorState, lastObservedAt: remote?.observedAt || legacyBinding?.observation?.observedAt || null,
              status: requiredRecovery ? 'recovery-required' : 'historical', migratedAt, observedAt: migratedAt,
              ...(remote?.turnId || desktop?.turnId ? { originalTurnId: remote?.turnId || desktop?.turnId } : {}) };
            const target = work.executor?.target, candidateCwd = work.project?.cwd || target?.cwd || remote?.cwd;
            const project = safeDirectory(candidateCwd) ? { ...work.project, id: work.project?.id || 'directory:' + candidateCwd, cwd: candidateCwd } : work.project;
            const patch = { ...work, executor: { kind: 'pi', ...(project?.cwd ? { target: { type: 'directory', cwd: project.cwd } } : {}) },
              project, bindings: [...(work.bindings || []).filter(item => !legacyBindings.includes(item)), binding],
              revision: (work.revision || 0) + 1, updatedAt: now() };
            if (unsettledStop) patch.externalStop = { ...work.externalStop, status: 'recovery-required' };
            if (automaticRecovery) {
              patch.status = 'waiting';
              patch.waiting = { kind: 'native-recovery', bindingId: binding.id, operationId, reason: '保留原会话、进度和产物，待核对原生会话与已发生效果' };
            }
            if (desktop) retainDeliveryEvidence(bot, work, desktop);
            bot.putRecord('works', patch);
            if (automaticRecovery) for (const accepted of bot.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.workId === work.id))
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
      // This collection feeds the public work list. Raw records are kept in the private archive.
      gateway.import('historical-executions', { ...work, goal: '历史执行记录', historical: true,
        status: terminal.has(work.status) ? work.status : 'blocked' });
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
    gateway.save('data-conversions', { id: recordId, status: 'completed', converted, historical: works.length, archivedRecords });
    return { applied: true, converted, historical: works.length, archivedRecords };
  } finally { legacy?.close(); gateway.close(); }
}
