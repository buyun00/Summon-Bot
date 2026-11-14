import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeRecords as R } from './runtime-records.mjs';

const decode = row => row ? JSON.parse(row.data) : null;
const historyRecordKinds = [R.event, R.delivery, R.route, R.conversation, R.run, R.wait, R.call, R.transcript, R.checkpoint, R.batch, R.input, R.materialView];

/** SQLite stores original transcript entries and their independent processing positions. */
export class BotStore {
  constructor(path, { readOnly = false } = {}) {
    if (path !== ':memory:' && !readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version > 1) throw new Error(`Unsupported Bot data schema ${version}`);
      if (!readOnly) {
        this.db.exec(`PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
          CREATE INDEX IF NOT EXISTS runtime_route_state ON records(json_extract(data,'$.state')) WHERE kind='inbox-route';
          CREATE INDEX IF NOT EXISTS runtime_route_event ON records(json_extract(data,'$.event_id')) WHERE kind='inbox-route';
          CREATE INDEX IF NOT EXISTS runtime_run_conversation ON records(json_extract(data,'$.conversation_id')) WHERE kind='run';
          PRAGMA user_version=1;`);
      }
    } catch (error) { this.db.close(); throw error; }
  }

  transaction(work) {
    if (this.inTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const value = work();
      if (value?.then) throw new TypeError('SQLite transactions must be synchronous');
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.inTransaction = false; }
  }

  putRecord(kind, record) {
    if (typeof kind !== 'string' || !kind || typeof record?.id !== 'string' || !record.id) throw new TypeError('Record requires kind and ID');
    this.db.prepare('INSERT INTO records(kind,id,data) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data')
      .run(kind, record.id, JSON.stringify(record));
    return record;
  }

  getRecord(kind, id) { return decode(this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id)); }

  deleteRecord(kind, id) { return this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id).changes > 0; }
  listRecords(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid').all(kind).map(decode); }

  clearHistory() {
    return this.transaction(() => {
      const tables = {}, records = {};
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
