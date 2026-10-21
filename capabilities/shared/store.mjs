import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** A capability owns its database; collections are local implementation details. */
export class RecordStore {
  constructor(path) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind,created_at);`);
  }
  get(kind,id) { const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind,String(id)); return row ? JSON.parse(row.data) : undefined; }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY created_at,rowid').all(kind).map(row => JSON.parse(row.data)); }
  save(kind,value) {
    const id = String(value.id || randomUUID()), before = this.get(kind,id), now = new Date().toISOString();
    const record = { ...before, ...value, id, createdAt: before?.createdAt || value.createdAt || now, updatedAt: now };
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET updated_at=excluded.updated_at,data=excluded.data').run(kind,id,record.createdAt,now,JSON.stringify(record));
    return record;
  }
  import(kind,record) {
    if(typeof record?.id!=='string'||!record.id)throw new TypeError('Imported record requires id');
    const createdAt=record.createdAt||new Date().toISOString(),updatedAt=record.updatedAt||createdAt;
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET created_at=excluded.created_at,updated_at=excluded.updated_at,data=excluded.data').run(kind,record.id,createdAt,updatedAt,JSON.stringify(record));
    return record;
  }
  remove(kind,id) { return this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id).changes > 0; }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const value = fn(); if (value?.then) throw new Error('Transactions must be synchronous'); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this.inTransaction = false; }
  }
  close() { this.db.close(); }
}
