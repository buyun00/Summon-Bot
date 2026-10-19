import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

const KINDS = new Set(['bots', 'rooms', 'messages', 'jobs', 'memories', 'nodes', 'edges', 'routines', 'works', 'workEvents', 'agentRuns', 'toolRuns']);

/** One database owns all durable state. JSON keeps the first version's records editable. */
export class Store {
  constructor(path = '.relay/relay.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS records_kind_created ON records(kind, created_at);
      CREATE INDEX IF NOT EXISTS records_room ON records(kind, json_extract(data, '$.roomId'));
      CREATE INDEX IF NOT EXISTS records_status ON records(kind, json_extract(data, '$.status'));
    `);
    this.read = this.db.prepare('SELECT data FROM records WHERE kind = ? AND id = ?');
    this.all = this.db.prepare('SELECT data FROM records WHERE kind = ? ORDER BY created_at, rowid');
    this.write = this.db.prepare(`INSERT INTO records(kind,id,created_at,updated_at,data) VALUES(?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data`);
    this.delete = this.db.prepare('DELETE FROM records WHERE kind = ? AND id = ?');
    this.transactionDepth = 0;
  }

  check(kind) {
    if (!KINDS.has(kind)) throw new Error(`Unknown collection: ${kind}`);
  }

  get(kind, id) {
    this.check(kind);
    const row = this.read.get(kind, String(id));
    return row ? JSON.parse(row.data) : undefined;
  }

  list(kind) {
    this.check(kind);
    return this.all.all(kind).map(row => JSON.parse(row.data));
  }

  save(kind, object) {
    this.check(kind);
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new TypeError('A record must be an object');
    const id = object.id ? String(object.id) : randomUUID();
    const previous = this.get(kind, id);
    const now = new Date().toISOString();
    const record = { ...previous, ...object, id, createdAt: previous?.createdAt || object.createdAt || now, updatedAt: now };
    this.write.run(kind, id, record.createdAt, record.updatedAt, JSON.stringify(record));
    return JSON.parse(JSON.stringify(record));
  }

  remove(kind, id) {
    this.check(kind);
    return this.delete.run(kind, String(id)).changes > 0;
  }

  transaction(fn) {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = fn();
      if (result?.then) throw new TypeError('Store transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  close() { this.db.close(); }
}
