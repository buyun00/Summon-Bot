import { randomUUID } from 'node:crypto';
import { keyOf, reject } from './contract.mjs';

export const defaultPeriodMs = 3600000;

export class HostResources {
  constructor(store, { period_ms = defaultPeriodMs } = {}) {
    this.store = store;
    this.periodMs = Number.isSafeInteger(period_ms) && period_ms >= 1000 ? period_ms : defaultPeriodMs;
    this.store.db.exec(`CREATE INDEX IF NOT EXISTS platform_usage_end ON records (json_extract(data,'$.ended_at')) WHERE kind='platform-usage'`);
    this.currentUsage = this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-usage' AND
      (json_extract(data,'$.ended_at') IS NULL OR json_extract(data,'$.ended_at')>=?)`);
  }

  bounds(time = Date.now()) {
    const number = Math.floor(time / this.periodMs);
    return { from: number * this.periodMs, until: (number + 1) * this.periodMs };
  }

  recordCurrentUsage(time = Date.now()) {
    const { from, until } = this.bounds(time);
    const all = this.currentUsage.all(from).map(row => JSON.parse(row.data));
    const pending = all.filter(item => item.ended_at == null);
    const period = all.filter(item => item.began_at >= from && item.began_at < until);
    return {
      pending,
      calls: period.length,
      tokens: period.reduce((total, item) => total + (item.tokens ?? item.reserved_tokens), 0),
      active_ms: all.reduce((total, item) => total + Math.max(0, Math.min(time, item.ended_at ?? time) - Math.max(from, item.began_at)), 0),
      resets_at: new Date(until).toISOString(),
      period_ms: this.periodMs,
    };
  }

  acquire(kind, source, { id = randomUUID(), reserve_tokens = 0 } = {}) {
    if (!['models', 'external', 'message'].includes(kind)) throw new Error('Unknown host resource');
    if (!Number.isSafeInteger(reserve_tokens) || reserve_tokens < 0) throw new Error('Invalid token reservation');
    return this.store.transaction(() => {
      const leaseId = keyOf(kind, id);
      if (this.store.get('platform-usage', leaseId)) reject('usage_id_conflict', 'This call already has a resource reservation', 409);
      const time = Date.now();
      const record = this.store.save('platform-usage', { id: leaseId, resource: kind, charge_account: 'host', source,
        began_at: time, ended_at: null, reserved_tokens: reserve_tokens, tokens: null, outcome: 'running' });
      return { id: record.id, finish: result => this.finish(record.id, result) };
    });
  }

  finish(id, result = {}) {
    return this.store.transaction(() => {
      const lease = this.store.get('platform-usage', id);
      if (!lease || lease.ended_at != null) return lease;
      const tokens = Number.isSafeInteger(result.tokens) && result.tokens >= 0 ? result.tokens : null;
      return this.store.save('platform-usage', { id, ended_at: Date.now(), tokens, outcome: result.outcome || 'complete' });
    });
  }

  recoverModels() {
    for (const item of this.store.list('platform-usage')) {
      if (item.resource !== 'external' && item.ended_at == null) this.finish(item.id, { outcome: 'unknown' });
    }
  }

  snapshot() {
    const { pending, ...totals } = this.recordCurrentUsage();
    return { ...totals, running_models: pending.filter(item => item.resource === 'models').length,
      running_external: pending.filter(item => item.resource === 'external').length };
  }
}
