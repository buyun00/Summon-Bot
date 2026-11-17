import { usageRange } from '../../bot/src/agent/usage.mjs';
import { protocolOf } from '../services/connection-binding.mjs';
import { keyOf, page, reject, sameRef } from './contract.mjs';

const chinaOffset = 8 * 60 * 60_000;
const dayOf = time => new Date(Date.parse(time) + chinaOffset).toISOString().slice(0, 10);
const counts = () => ({ total: 0, succeeded: 0, failed: 0, unknown: 0, not_started: 0, stopped: 0, pending: 0 });

function count(totals, status) {
  totals.total++;
  if (status === 'completed') totals.succeeded++;
  else if (status === 'failed') totals.failed++;
  else if (status === 'unknown') totals.unknown++;
  else if (status === 'not_submitted' || status === 'unsupported') totals.not_started++;
  else if (status === 'stopped' || status === 'cancelled') totals.stopped++;
  else totals.pending++;
}

function rangeOf(period = 'yesterday') {
  if (typeof period === 'string' && ['yesterday', 'today', '7d'].includes(period)) return usageRange(period);
  if (period && typeof period === 'object' && [period.from, period.to].every(value =>
    typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/i.test(value))) {
    const from = Date.parse(period.from), to = Date.parse(period.to);
    if (Number.isFinite(from) && Number.isFinite(to) && from < to)
      return { period: 'custom', timezone: 'Asia/Shanghai', from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  }
  reject('invalid_usage_period', 'Use yesterday, today, 7d, or a from/to range with timezone offsets');
}

export class ConnectionUsage {
  constructor(platform) {
    this.platform = platform;
    this.records = platform.store.db.prepare(`
      SELECT data FROM records WHERE kind='session-operations' AND created_at>=? AND created_at<?
      UNION ALL
      SELECT json_object('id',p.id,'session_id',json_extract(p.data,'$.target.id'),'status','not_submitted','createdAt',p.created_at)
      FROM records p LEFT JOIN records o ON o.kind='session-operations' AND o.id=p.id
      WHERE p.kind='platform-calls' AND p.created_at>=? AND p.created_at<? AND o.id IS NULL
        AND json_extract(p.data,'$.target.kind')='session'
        AND json_extract(p.data,'$.tool') IN ('open_session','send_input')
        AND json_extract(p.data,'$.status') IN ('failed','not_submitted')
        AND NOT COALESCE(json_extract(p.data,'$.external'),0)
    `);
  }

  query({ scope, period, query, cursor }, context) {
    if (scope && !['room', 'connection', 'session'].includes(scope.kind))
      reject('invalid_usage_scope', 'Connection usage accepts a room, connection or session scope');
    const { platform } = this;
    const range = rangeOf(period);
    const term = query?.trim().toLowerCase();
    const totals = counts(), groups = new Map(), permitted = new Map();
    for (const { data } of this.records.iterate(range.from, range.to, range.from, range.to)) {
      const operation = JSON.parse(data);
      const target = { kind: 'session', id: operation.session_id };
      const session = platform.executions.record(target);
      const id = operation.connection_id ?? session?.engine;
      if (!session || !id || id === 'pi' || scope?.kind === 'connection' && scope.id !== id ||
          scope?.kind === 'session' && scope.id !== session.id) continue;
      const workRoom = session.group_work?.room;
      if (scope?.kind === 'room' && !sameRef(scope, workRoom) && !sameRef(scope, session.space)) continue;
      if (!platform.executions.permission(target, session, context) && !platform.canReadSpace(context.actor, workRoom, context)) continue;
      if (!permitted.has(id)) {
        const entry = platform.connections.get(id);
        const accessible = entry && platform.canUseConnection(context.actor, id, context) && platform.connections.authorized(entry, context.actor);
        permitted.set(id, accessible ? entry : null);
      }
      const entry = permitted.get(id);
      if (!entry) continue;
      const method = operation.method ?? operation.work_method ?? null;
      if (term && ![id, entry.name, method, protocolOf(entry)].some(value => value?.toLowerCase().includes(term))) continue;
      const day = dayOf(operation.createdAt);
      const version = operation.connection_version ?? null;
      const key = keyOf(day, id, method, version);
      if (!groups.has(key)) groups.set(key, { id: key, date: day, connection: { kind: 'connection', id }, name: entry.name,
        protocol: protocolOf(entry), method, version, registered_version: platform.connections.summary(entry).version ?? null, counts: counts() });
      count(groups.get(key).counts, operation.status);
      count(totals, operation.status);
    }
    const items = [...groups.values()].sort((a, b) => b.date.localeCompare(a.date) || b.counts.total - a.counts.total ||
      a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { ...page(items, cursor), range, scope: scope ?? null, totals,
      basis: { unit: 'call_id', time: 'call_created_at', access: 'current_connection_grant_and_visible_session_or_room_work' } };
  }
}
