import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const now = () => new Date().toISOString();
const encode = value => JSON.stringify(value ?? null);
const decode = row => row ? JSON.parse(row.data) : null;
export const terminalTaskStates = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const historyTables = ['messages', 'tasks', 'sessions', 'tools', 'events', 'outbox'];
const historyRecordKinds = new Set(['messages', 'tasks', 'sessions', 'tools', 'events', 'outbox', 'receipts', 'requests',
  'agentSessions', 'agentRuns', 'toolRuns', 'jobs', 'works', 'work-events', 'conversations', 'imported-events', 'imported-requests', 'imported-sessions', 'imported-tool_runs', 'imported-kv_state']);
const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT', status: 409 });

/** SQLite is the sole authority for transcripts, task receipts and state. */
export class BotStore {
  constructor(databasePath, { readOnly = false } = {}) {
    this.path = databasePath; this.readOnly = readOnly; this.closed = false;
    if (databasePath !== ':memory:' && !readOnly) mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error(`Unsupported Bot data schema ${version}`);
      if (!readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL;');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL, UNIQUE(source,source_id));
          CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS tools(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS tools_task ON tools(task_id);
          CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, task_id TEXT, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS state(scope TEXT NOT NULL,key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(scope,key));
          CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
          PRAGMA user_version=1;
        `);
      }
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(work) {
    if (this.inTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true; this.pendingEvents = [];
    try {
      const value = work();
      if (value?.then) throw new TypeError('SQLite transactions must be synchronous');
      this.db.exec('COMMIT');
      this.inTransaction = false;
      const events = this.pendingEvents; this.pendingEvents = [];
      for (const event of events) { try { this.onEvent?.(event); } catch {} }
      return value;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; this.pendingEvents = []; }
  }
  get(table, id) { return decode(this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id)); }
  list(table) { return this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all().map(decode); }
  put(table, record) {
    if (typeof record?.id !== 'string' || !record.id) throw new TypeError('Record requires id');
    this.db.prepare(`INSERT INTO ${table}(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(record.id, encode(record));
    return record;
  }
  acceptMessage(message, source, bootId) {
    return this.transaction(() => {
      const existing = decode(this.db.prepare('SELECT data FROM messages WHERE source=? AND source_id=?').get(source, message.id));
      if (existing) return { duplicate: true, message: existing, task: this.getTask(existing.taskId) };
      const id = randomUUID(), taskId = randomUUID(), at = now();
      const work = message.workId ? this.getRecord('works', message.workId) : null;
      if (message.workId && !work) throw Object.assign(new Error('Unknown work'), { status: 404 });
      const conversationId = work?.conversationId || message.conversationId || message.sessionId || `peer:${source}`;
      const sessionId = conversationId;
      const conversation = this.getRecord('conversations', conversationId);
      this.putRecord('conversations', { ...conversation, id: conversationId, kind: work ? 'work' : 'chat', workId: work?.id || null,
        createdAt: conversation?.createdAt || at, updatedAt: at });
      const stored = { ...message, id, sourceMessageId: message.id, from: source, taskId, sessionId, conversationId, workId: work?.id || null, receivedAt: at };
      const task = { id: taskId, taskId, runId: randomUUID(), messageId: id, source, sessionId, conversationId, workId: work?.id || null, kind: work ? 'work' : 'chat', status: 'accepted',
        input: message.content, metadata: message.metadata || null, bootId, createdAt: at, updatedAt: at, cancelRequested: false };
      this.db.prepare('INSERT INTO messages(id,source,source_id,task_id,data) VALUES(?,?,?,?,?)').run(id, source, message.id, taskId, encode(stored));
      this.db.prepare('INSERT INTO tasks(id,session_id,status,data) VALUES(?,?,?,?)').run(taskId, sessionId, task.status, encode(task));
      this.appendEvent('task.accepted', { task }, { taskId, sessionId });
      return { duplicate: false, message: stored, task };
    });
  }
  getMessage(id) { return this.get('messages', id); }
  listMessages() { return this.list('messages'); }
  getTask(id) { return this.get('tasks', id); }
  listTasks({ status, limit = 100 } = {}) {
    return this.list('tasks').filter(task => !status || task.status === status).slice(-Math.max(1, Math.min(10000, limit)));
  }
  listUnfinishedTasks() {
    return this.db.prepare("SELECT data FROM tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY rowid").all().map(decode);
  }
  updateTask(id, patch) {
    return this.transaction(() => {
      const prior = this.getTask(id);
      if (!prior) throw new Error(`Unknown task ${id}`);
      if (terminalTaskStates.has(prior.status)) return prior;
      const task = { ...prior, ...patch, id, taskId: id, runId: prior.runId, updatedAt: now() };
      this.db.prepare('UPDATE tasks SET status=?,data=? WHERE id=?').run(task.status, encode(task), id);
      if (task.status !== prior.status) this.appendEvent(`task.${task.status}`, { task }, { taskId: id, sessionId: task.sessionId });
      else if (task.cancelRequested && !prior.cancelRequested) this.appendEvent('task.cancel_requested', { taskId: id }, { taskId: id });
      return task;
    });
  }
  getSession(id) { return this.get('sessions', id); }
  listSessions() { return this.list('sessions'); }
  saveSession(input) {
    const id = input.id || input.sessionId;
    if (!id || !Array.isArray(input.messages)) throw new TypeError('Session requires id and messages');
    return this.transaction(() => {
      const previous = this.getSession(id);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (previous?.revision || 0)) throw conflict('Session revision changed');
      const { expectedRevision, ...record } = input;
      const saved = this.put('sessions', { ...previous, ...record, id, sessionId: id, revision: (previous?.revision || 0) + 1,
        createdAt: previous?.createdAt || input.createdAt || now(), updatedAt: now() });
      this.appendEvent('session.updated', { sessionId: id, revision: saved.revision }, { sessionId: id });
      return saved;
    });
  }
  getTool(id) { return this.get('tools', id); }
  listTools(taskId) { return taskId ? this.db.prepare('SELECT data FROM tools WHERE task_id=? ORDER BY rowid').all(taskId).map(decode) : this.list('tools'); }
  saveTool(input) {
    return this.transaction(() => {
      const previous = this.getTool(input.id);
      const record = { ...previous, ...input };
      this.db.prepare('INSERT INTO tools(id,task_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id, record.taskId || record.runId, encode(record));
      this.appendEvent(`tool.${record.status === 'running' ? 'started' : record.status}`, { tool: record }, { taskId: record.taskId || record.runId, sessionId: record.sessionId });
      return record;
    });
  }
  getState(scope, key) { return decode(this.db.prepare('SELECT data FROM state WHERE scope=? AND key=?').get(scope, key)); }
  listState(scope) { return (scope === undefined ? this.db.prepare('SELECT data FROM state').all() : this.db.prepare('SELECT data FROM state WHERE scope=?').all(scope)).map(decode); }
  setState(scope, key, value, { expectedRevision } = {}) {
    return this.transaction(() => {
      const previous = this.getState(scope, key);
      if (expectedRevision !== undefined && expectedRevision !== (previous?.revision || 0)) throw conflict('State revision changed');
      const record = { scope, key, value, revision: (previous?.revision || 0) + 1, updatedAt: now() };
      this.db.prepare('INSERT INTO state(scope,key,data) VALUES(?,?,?) ON CONFLICT(scope,key) DO UPDATE SET data=excluded.data').run(scope, key, encode(record));
      return record;
    });
  }
  getMemory(id) { return this.get('memories', id); }
  listMemories() { return this.list('memories'); }
  putMemory(input) {
    return this.transaction(() => {
      const id = input.id || randomUUID(), previous = this.getMemory(id);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (previous?.revision || 0)) throw conflict('Memory revision changed');
      const { expectedRevision, ...values } = input;
      const record = { ...previous, ...values, id, revision: (previous?.revision || 0) + 1,
        createdAt: previous?.createdAt || input.createdAt || now(), updatedAt: now() };
      if (typeof record.text !== 'string') throw new TypeError('Memory requires text');
      this.put('memories', record); this.appendEvent('memory.updated', { id, revision: record.revision }); return record;
    });
  }
  deleteMemory(id, expectedRevision) {
    return this.transaction(() => {
      const previous = this.getMemory(id);
      if (!previous) return false;
      if (expectedRevision !== previous.revision) throw conflict('Memory revision changed');
      this.db.prepare('DELETE FROM memories WHERE id=?').run(id); this.appendEvent('memory.deleted', { id }); return true;
    });
  }
  getOutbox(id) { return this.get('outbox', id); }
  listOutbox() { return this.list('outbox'); }
  saveOutbox(record) { return this.put('outbox', { ...this.getOutbox(record.id), ...record, updatedAt: now() }); }
  saveArtifact(record) { return this.put('artifacts', record); }
  getArtifact(id) { return this.get('artifacts', id); }
  listArtifacts() { return this.list('artifacts'); }
  putRecord(kind, record) {
    if (typeof kind !== 'string' || !kind || typeof record?.id !== 'string' || !record.id) throw new TypeError('Record requires kind and id');
    this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, record.id, encode(record)); return record;
  }
  getRecord(kind, id) { return decode(this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id)); }
  listRecords(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(decode); }
  appendEvent(type, payload, refs = {}) {
    const event = { type, payload, ...refs, createdAt: now() };
    const result = this.db.prepare('INSERT INTO events(type,task_id,data) VALUES(?,?,?)').run(type, refs.taskId || refs.requestId || null, encode(event));
    const saved = { ...event, seq: Number(result.lastInsertRowid) };
    if (this.inTransaction) this.pendingEvents.push(saved);
    else { try { this.onEvent?.(saved); } catch {} }
    return saved;
  }
  listEvents({ after = 0, limit = 200, taskId, workId } = {}) {
    limit = Math.max(1, Math.min(1000, Number(limit) || 200));
    if (workId) return this.db.prepare("SELECT seq,data FROM events WHERE seq>? AND json_extract(data,'$.workId')=? ORDER BY seq DESC LIMIT ?")
      .all(after, workId, limit).reverse().map(row => ({ ...decode(row), seq: row.seq }));
    const rows = taskId ? this.db.prepare('SELECT seq,data FROM events WHERE seq>? AND task_id=? ORDER BY seq LIMIT ?').all(after, taskId, limit)
      : this.db.prepare('SELECT seq,data FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    return rows.map(row => ({ ...decode(row), seq: row.seq }));
  }
  recover(bootId) {
    return this.transaction(() => {
      for (const task of this.list('tasks')) if (!terminalTaskStates.has(task.status) && task.status !== 'accepted') this.updateTask(task.id, { status: 'interrupted',
        error: { code: 'PROCESS_RESTARTED', message: 'Previous execution is unconfirmed; automatic replay disabled', recoveredByBootId: bootId } });
      for (const tool of this.listTools()) if (['running', 'queued'].includes(tool.status)) this.saveTool({ ...tool, status: 'unknown', finishedAt: now(), error: { message: 'Process stopped before a durable tool result' } });
      for (const item of this.listOutbox()) if (item.status === 'sending') this.saveOutbox({ ...item, status: 'unknown' });
    });
  }
  /** Storage primitive. External maintenance must hold the Bot's data lease.
   * Durable facts, arbitrary user state, configuration and artifact metadata stay intact. */
  clearHistory() {
    return this.transaction(() => {
      const tables = {}, records = {};
      for (const table of historyTables) tables[table] = Number(this.db.prepare(`DELETE FROM ${table}`).run().changes);
      const remove = this.db.prepare('DELETE FROM records WHERE kind=?');
      for (const kind of historyRecordKinds) {
        const count = Number(remove.run(kind).changes);
        if (count) records[kind] = count;
      }
      return { tables, records };
    });
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}
