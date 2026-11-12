import { randomUUID } from 'node:crypto';
import { fail, now, required, safeId } from '../shared/validation.mjs';
import { inspectNative } from './native-host.mjs';

const sources = 'native-display-sources';
const history = 'native-display-observations';
const statuses = new Set(['ready', 'loading', 'login-required', 'stale', 'error', 'unsupported']);
const types = new Set(['quota', 'amount', 'number', 'status', 'progress', 'text', 'table', 'file']);
const date = value => {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(Date.parse(value))) fail('Invalid observation timestamp');
  return new Date(value).toISOString();
};

function metrics(items = []) {
  if (!Array.isArray(items) || items.length > 40) fail('Expected at most 40 metrics');
  return items.map(item => {
    if (!item || !types.has(item.kind)) fail('Invalid metric kind');
    const kind = item.kind, label = required(item.label, 'metric label', 200);
    if (['quota', 'amount', 'number', 'progress'].includes(kind)) {
      const { value, unit, limit } = item;
      if (value !== null && !Number.isFinite(value)) fail('Metric value must be finite or null');
      const result = { kind, label, value, unit: required(unit, 'metric unit', 30), scope: String(item.scope || '').slice(0, 200) };
      if (kind === 'quota') {
        if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) fail('Quota limit must be a positive number');
        if (item.durationMinutes !== undefined && (!Number.isFinite(item.durationMinutes) || item.durationMinutes <= 0)) fail('Invalid quota window duration');
        if (!['used', 'remaining'].includes(item.direction)) fail('Quota direction must be used or remaining');
        Object.assign(result, { limit, direction: item.direction, durationMinutes: item.durationMinutes, resetsAt: date(item.resetsAt) });
      }
      return result;
    }
    if (kind === 'table') {
      if (!Array.isArray(item.columns) || !item.columns.length || item.columns.length > 12 || !Array.isArray(item.rows) || item.rows.length > 80 ||
        item.rows.some(row => !Array.isArray(row) || row.length !== item.columns.length)) fail('Invalid table dimensions');
      return { kind, label, columns: item.columns.map(value => String(value).slice(0, 200)), rows: item.rows.map(row => row.map(value => String(value ?? '').slice(0, 1000))) };
    }
    return { kind, label, text: required(item.text, 'metric text', 4000), ...(kind === 'file' && item.ref ? { ref: String(item.ref).slice(0, 500) } : {}) };
  });
}

function displayUsage(source, current) {
  const values = current?.metrics || [];
  const windows = values.filter(item => item.kind === 'quota').map(item => {
    const limit = item.limit || (item.unit === '%' ? 100 : null);
    const percentage = limit && item.value !== null ? 100 * item.value / limit : null;
    return { name: item.label, limitId: item.scope || item.label, durationMinutes: item.durationMinutes, resetsAt: item.resetsAt,
      remainingPercent: percentage === null ? null : Math.max(0, Math.min(100, item.direction === 'remaining' ? percentage : 100 - percentage)) };
  });
  const balances = values.filter(item => item.kind === 'amount' && item.value !== null && /^[A-Z]{3}$/.test(item.unit))
    .map(item => ({ amount: item.value, currency: item.unit }));
  const credits = values.find(item => item.kind === 'number' && item.unit === 'credits')?.value;
  const stale = current?.status === 'stale' || current?.validUntil && Date.parse(current.validUntil) <= Date.now();
  return { status: stale ? 'error' : current?.status === 'login-required' ? 'error' : current?.status || 'loading',
    stale: Boolean(stale || current?.status === 'error' && current?.checkedAt), unsupported: current?.status === 'unsupported',
    checkedAt: current?.checkedAt || current?.observedAt, windows, balances, credits, source: source.label, note: current?.note,
    error: current?.error };
}

export class NativeSources {
  constructor(native) { this.native = native; this.store = native.store; this.pending = new Map(); }
  key(id, sourceId) { return JSON.stringify([id, sourceId]); }

  register(args, actor) {
    const entry = this.native.owner(args.id, actor), sourceId = safeId(args.sourceId), id = this.key(entry.id, sourceId);
    const prior = this.store.get(sources, id), accountRef = args.accountRef || null, actions = args.actions || [];
    if (actions.length > 12 || new Set(actions.map(action => action.id)).size !== actions.length) fail('Display actions need unique identities');
    for (const action of actions) {
      safeId(action.id); required(action.label, 'action label', 120);
      if (action.methodId && !entry.native?.methods?.some(method => method.id === action.methodId && method.resourceRevision === entry.native.resourceRevision && method.effect === 'read' && !method.keepInput && !method.input))
        fail('Direct display actions require a current non-interactive read method');
    }
    this.native.catalog.safeText(JSON.stringify({ accountRef, actions, label: args.label }));
    const changed = prior && (prior.accountRef !== accountRef || prior.resourceRevision !== entry.native?.resourceRevision);
    const value = this.store.save(sources, { id, sourceId, resourceId: entry.id, label: required(args.label, 'source label', 120),
      accountRef, ownerBotId: entry.ownerBotId, hostId: entry.native?.hostId || this.native.host.hostId, actions,
      resourceRevision: entry.native?.resourceRevision || entry.revision, revision: (prior?.revision || 0) + 1,
      current: changed ? null : prior?.current || null });
    this.native.emit('models.usage', {});
    return this.public(value);
  }

  publish(args, actor) {
    const entry = this.native.owner(args.id, actor), id = this.key(entry.id, safeId(args.sourceId)), source = this.store.get(sources, id);
    if (!source) fail('Display source not registered', 404);
    const observation = this.native.observations({ id: entry.id, observationId: args.observationId }, actor);
    const stamp = date(args.observedAt), until = date(args.validUntil);
    if (!stamp || until && until < stamp || !statuses.has(args.status)) fail('Invalid observation status or time range');
    const values = metrics(args.metrics);
    this.native.catalog.safeText(JSON.stringify({ values, note: args.note, error: args.error }), 320 * 1024);
    const record = this.store.save(history, { id: randomUUID(), sourceKey: id, ownerBotId: actor, revision: args.revision, sourceRevision: args.sourceRevision,
      resourceRevision: observation.resourceRevision, observationId: observation.id, status: args.status,
      observedAt: stamp, validUntil: until, metrics: values, note: args.note, error: args.error });
    if (source.revision === args.sourceRevision && args.revision === entry.revision && observation.resourceRevision === (entry.native?.resourceRevision || entry.revision) &&
      (!source.current?.observedAt || stamp >= source.current.observedAt)) {
      const keep = ['error', 'stale', 'loading'].includes(args.status) && !values.length && source.current?.metrics?.length;
      this.store.save(sources, { id, resourceRevision: observation.resourceRevision, current: {
        ...record, metrics: keep ? source.current.metrics : values, checkedAt: keep ? source.current.checkedAt || source.current.observedAt : stamp,
      } });
      this.native.emit('models.usage', {});
      return { accepted: true, current: true, observation: record };
    }
    return { accepted: true, current: false, observation: record };
  }

  public(source) {
    const { current, id, ...fields } = source;
    const entry = this.native.catalog.entry(source.resourceId);
    const effective = source.resourceRevision === (entry.native?.resourceRevision || entry.revision) ? current : null;
    const status = effective?.validUntil && Date.parse(effective.validUntil) <= Date.now() ? 'stale' : effective?.status;
    return { ...fields, id, name: source.label, kind: entry.kind, resourceName: entry.name, status: status || (source.actions.length ? 'loading' : 'unsupported'),
      actions: source.actions.map(({ id, label }) => ({ id, label })), metrics: effective?.metrics || [], observationId: effective?.observationId,
      observedAt: effective?.checkedAt || effective?.observedAt, validUntil: effective?.validUntil, note: effective?.note,
      usage: displayUsage(source, effective || (!source.actions.length && { status: 'unsupported' })) };
  }

  list(actor = 'controller') {
    return this.store.list(sources).flatMap(source => {
      const entry = this.store.get('catalog-entries', source.resourceId);
      return entry?.enabled && this.native.catalog.permitted(entry, actor) ? [this.public(source)] : [];
    });
  }

  async refresh(entryId, sourceId, actionId = 'refresh') {
    const id = this.key(entryId, sourceId), source = this.store.get(sources, id), entry = this.native.entry(entryId, 'controller');
    if (!source || !entry.enabled) fail('Display source unavailable', 404);
    const action = source.actions.find(item => item.id === actionId);
    if (!action) fail('Display action not registered', 404);
    if (this.pending.has(id)) return this.pending.get(id);
    const run = this.refreshAction(entry, source, action).finally(() => this.pending.delete(id));
    this.pending.set(id, run);
    return run;
  }

  async refreshAction(entry, source, action) {
    const method = entry.native?.methods?.find(item => item.id === action.methodId && item.resourceRevision === entry.native.resourceRevision);
    if (!method) {
      const pending = source.lastActionId && this.store.get('catalog-delegations', JSON.stringify(['controller', entry.id, source.lastActionId]));
      if (pending && !pending.returnedAt) return { status: 'loading', ownerWorkId: pending.ownerWorkId };
      const operationId = 'display:' + randomUUID();
      this.store.save(sources, { id: source.id, lastActionId: operationId });
      return this.native.catalog.handoff(entry.id, { operationId, message: '用户请求 ' + source.label + ' / ' + action.label +
        '。读取 catalog_get 中的展示来源修订，使用当前原生接口取得真实结果，向 ' + source.sourceId + ' 发布已观测的结果或真实等待原因。' });
    }
    return this.native.catalog.serial('native-resource:' + entry.id, async () => {
      const fresh = await this.native.check(this.native.catalog.entry(entry.id), { force: true });
      if (fresh.native?.resourceRevision !== method.resourceRevision) fail('Display method is stale and has been sent to maintenance', 409);
      if (this.native.executions.forResource(entry.id).some(item => item.effect === 'update' && !['completed', 'failed', 'stopped', 'superseded'].includes(item.status))) fail('Tool update is in progress', 409);
      let result, value, error;
      try {
        if (entry.kind === 'cli') {
          const launch = this.native.invocation(fresh, method, { parameters: action.parameters });
          result = await inspectNative(launch.file, launch.args, this.native.workspace, { env: launch.env, authorizedEnv: launch.authorizedEnv });
          if (result.exitCode !== 0 || result.timeout) throw new Error(result.error || result.stderr || 'Display observation failed');
          value = JSON.parse(result.stdout);
        } else {
          result = await this.native.catalog.execute(entry.id, { tool: method.tool, arguments: this.native.expand(method.arguments, action.parameters || {}) }, entry.ownerBotId);
          if (result.isError) throw new Error('Display observation failed');
          value = result.structuredContent || result.details || JSON.parse(result.content.find(item => item.type === 'text').text);
        }
        if (!value || !Array.isArray(value.metrics)) throw new Error('Observation did not return metrics');
        value.metrics = metrics(value.metrics);
        if (value.validUntil) date(value.validUntil);
        if (value.status !== undefined && !statuses.has(value.status)) throw new Error('Invalid display status');
      } catch (cause) { error = this.native.catalog.clean(cause.message); }
      const current = this.native.catalog.entry(entry.id);
      const observed = this.native.observation(current, 'display-refresh', { result, error }, 'controller');
      if (error) this.native.enqueue(current, 'display-failure', observed);
      return this.publish({ id: entry.id, sourceId: source.sourceId, revision: fresh.revision, sourceRevision: source.revision, observationId: observed.id,
        status: error ? 'error' : value.status || 'ready', observedAt: observed.observedAt,
        error, validUntil: error ? undefined : value.validUntil, metrics: error ? [] : value.metrics, note: error ? null : value.note }, 'controller');
    });
  }

  tick() {
    for (const source of this.store.list(sources)) {
      if (this.pending.has(source.id) || Date.now() - Date.parse(source.lastAutoRefreshAt || '1970-01-01') < 60_000) continue;
      const entry = this.store.get('catalog-entries', source.resourceId);
      if (!entry?.enabled || !source.actions.some(action => action.id === 'refresh' && action.methodId && entry.native?.methods?.some(method =>
        method.id === action.methodId && method.resourceRevision === entry.native.resourceRevision))) continue;
      this.store.save(sources, { id: source.id, lastAutoRefreshAt: now() });
      void this.refresh(source.resourceId, source.sourceId).catch(() => {});
    }
  }

  async refreshAll() {
    await Promise.allSettled(this.list().filter(source => source.actions.some(action => action.id === 'refresh'))
      .map(source => this.refresh(source.resourceId, source.sourceId)));
    return this.list();
  }

  async close() { await Promise.allSettled(this.pending.values()); }
}
