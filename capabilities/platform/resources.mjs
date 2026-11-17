import { randomUUID } from 'node:crypto';
import { keyOf, reject } from './contract.mjs';

export const defaultLimits = Object.freeze({
  sessions: 48, models: 8, external: 8, queue: 512, reserved_calls: 128,
  period_ms: 3600000, calls: 2000, tokens: 10000000, active_ms: 28800000,
});
export const hostLimitsRecord = 'platform-host-limits';

export function normalizeLimits(input, fallback = defaultLimits) {
  return Object.fromEntries(Object.entries(fallback).map(([key, defaultValue]) => {
    const value = input[key] ?? defaultValue;
    if (!Number.isSafeInteger(value) || value < (key === 'period_ms' ? 1000 : 0)) {
      reject('invalid_resource_limit', `Invalid host resource limit ${key}`);
    }
    return [key, value];
  }));
}

export class HostResources {
  constructor(store, limits = {}) {
    this.store = store;
    this.limits = normalizeLimits(store.get(hostLimitsRecord, 'host')?.limits || {}, normalizeLimits(limits));
    this.store.db.exec(`CREATE INDEX IF NOT EXISTS platform_usage_end ON records (json_extract(data,'$.ended_at')) WHERE kind='platform-usage'`);
    this.currentUsage = this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-usage' AND
      (json_extract(data,'$.ended_at') IS NULL OR json_extract(data,'$.ended_at')>=?)`);
  }

  readLimits() {
    return { revision: this.store.get(hostLimitsRecord, 'host')?.revision ?? 0, limits: { ...this.limits } };
  }

  configure({ revision, limits }) {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
        Object.keys(limits).some(key => !Object.hasOwn(defaultLimits, key) || !Number.isSafeInteger(limits[key]))) {
      reject('invalid_resource_limit', 'Invalid host resource limits');
    }
    const updated = this.store.transaction(() => {
      const current = this.readLimits();
      if (current.revision !== revision) reject('revision_conflict', 'The host resource settings changed', 409, current);
      return this.store.save(hostLimitsRecord, { id: 'host', revision: revision + 1, limits: normalizeLimits(limits, current.limits) });
    });
    this.limits = updated.limits;
    return { revision: updated.revision, limits: { ...updated.limits } };
  }

  bounds(time = Date.now()) {
    const number = Math.floor(time / this.limits.period_ms);
    return { from: number * this.limits.period_ms, until: (number + 1) * this.limits.period_ms };
  }

  assertCapacity(key, used, count = 1) {
    if (used + count > this.limits[key]) {
      reject('resource_limit', `Host ${key} limit reached`, 429, { resource: key, limit: this.limits[key],
        ...(key === 'queue' || key === 'sessions' || key === 'reserved_calls' ? {} : { resets_at: new Date(this.bounds().until).toISOString() }) });
    }
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
    };
  }

  acquire(kind, source, { id = randomUUID(), reserve_tokens = 0 } = {}) {
    if (!['models', 'external', 'message'].includes(kind)) throw new Error('Unknown host resource');
    if (!Number.isSafeInteger(reserve_tokens) || reserve_tokens < 0) throw new Error('Invalid token reservation');
    return this.store.transaction(() => {
      const leaseId = keyOf(kind, id);
      if (this.store.get('platform-usage', leaseId)) reject('usage_id_conflict', 'This call already has a resource reservation', 409);
      const time = Date.now();
      const current = this.recordCurrentUsage(time);
      if (kind !== 'message') this.assertCapacity(kind, current.pending.filter(item => item.resource === kind).length);
      this.assertCapacity('calls', current.calls);
      this.assertCapacity('tokens', current.tokens, reserve_tokens);
      this.assertCapacity('active_ms', current.active_ms);
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
    return { limits: { ...this.limits }, ...totals, running_models: pending.filter(item => item.resource === 'models').length,
      running_external: pending.filter(item => item.resource === 'external').length };
  }
}
