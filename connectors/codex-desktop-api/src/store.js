import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ApiError, modelPreflightUnavailable, publicError } from './errors.js';

export class Store {
  constructor(file, retention = 10000) {
    this.db = new DatabaseSync(file); this.retention = retention;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, thread_id TEXT, host_id TEXT, at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_thread ON events(thread_id, host_id, id);
      CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      UPDATE operations SET state='unknown' WHERE state='pending';`);
  }
  append(type, data, threadId = null, hostId = null) {
    const at = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO events(type,thread_id,host_id,at,data) VALUES(?,?,?,?,?)').run(type, threadId, hostId, at, JSON.stringify(data));
    const id = Number(result.lastInsertRowid);
    if (id % 100 === 0) {
      this.db.prepare('DELETE FROM events WHERE id <= ?').run(id - this.retention);
      this.db.exec(`DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id,SUM(length(CAST(data AS BLOB))) OVER (ORDER BY id DESC) AS bytes FROM events) WHERE bytes > 67108864);`);
    }
    return { id, type, threadId, hostId, at, data };
  }
  bounds() { return this.db.prepare('SELECT MIN(id) AS first,MAX(id) AS last FROM events').get(); }
  replay(after, threadId, hostId) {
    const { first, last } = this.bounds();
    if ((first && after < first - 1) || (after > (last || 0))) throw new ApiError(409, 'event_cursor_expired', 'Event cursor is outside the retained journal. Fetch current state and reconnect without Last-Event-ID.', { first, last });
    const rows = threadId
      ? this.db.prepare('SELECT * FROM events WHERE id>? AND thread_id=? AND host_id=? ORDER BY id').all(after, threadId, hostId || 'local')
      : this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id').all(after);
    return rows.map(row => ({ id: row.id, type: row.type, threadId: row.thread_id, hostId: row.host_id, at: row.at, data: JSON.parse(row.data) }));
  }
  operation(key) {
    const row = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key);
    if (!row) throw new ApiError(404, 'operation_not_found', 'Operation not found.');
    return { key, state: row.state, status: row.status, result: row.result ? JSON.parse(row.result) : null, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async mutate(key, request, action, retryCreatePreflight = false) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApiError(400, 'idempotency_key_required', 'Supply an Idempotency-Key header containing 8..128 letters, digits, dots, colons, hyphens or underscores.');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const existing = this.db.prepare('SELECT * FROM operations WHERE key=?').get(key);
    let preflightRecovery;
    if (existing) {
      if (existing.hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'This key has already been used for a different request.');
      if (['pending', 'unknown'].includes(existing.state)) throw new ApiError(409, 'operation_uncertain', 'Check the operation and desktop before retrying; the original action is never submitted again.', { operationKey: key, state: existing.state });
      const body = JSON.parse(existing.result), error = body?.error;
      if (!retryCreatePreflight || existing.state !== 'failed' || existing.status !== 503 || body.preflightRecovery ||
        error?.code !== modelPreflightUnavailable || error.details?.outcome !== 'not-submitted' || !error.details.permissionMode)
        return { status: existing.status, body, replayed: true };
      preflightRecovery = { code: error.code, failedAt: existing.updated_at, permissionMode: error.details.permissionMode };
    } else if (retryCreatePreflight) {
      throw new ApiError(409, 'create_recovery_missing', 'The original create preflight was not found. Inspect the original operation key.');
    }
    const now = new Date().toISOString();
    if (preflightRecovery)
      this.db.prepare("UPDATE operations SET state='pending',status=NULL,result=?,updated_at=? WHERE key=?").run(JSON.stringify({ preflightRecovery }), now, key);
    else this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run(key, hash, 'pending', null, null, now, now);
    let status, body, state, progress;
    const report = (phase, detail) => {
      progress = { phase, ...detail, at: new Date().toISOString() };
      this.db.prepare("UPDATE operations SET result=?,updated_at=? WHERE key=? AND state='pending'")
        .run(JSON.stringify({ progress, preflightRecovery }), progress.at, key);
    };
    try { const result = await action(report, preflightRecovery); status = result.status ?? 200; body = result.body; state = 'completed'; }
    catch (error) {
      status = error.status || 500; body = { error: publicError(error), ...(progress ? { progress } : {}) };
      state = error.details?.outcome === 'unknown' ? 'unknown' : 'failed';
    }
    if (preflightRecovery) body = { ...body, preflightRecovery };
    this.db.prepare('UPDATE operations SET state=?,status=?,result=?,updated_at=? WHERE key=?').run(state, status, JSON.stringify(body), new Date().toISOString(), key);
    return { status, body, replayed: false };
  }
  close() { this.db.close(); }
}
