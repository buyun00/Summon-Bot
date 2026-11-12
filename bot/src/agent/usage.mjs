const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const USAGE_PRICING = { currency: 'USD', checkedAt: '2026-11-03', source: 'https://api-docs.deepseek.com/quick_start/pricing/',
  note: '按官方低峰至高峰单价给出参考区间，实际扣费以供应商账单为准。',
  models: { 'deepseek-flash': { cacheHit: [0.003, 0.006], cacheMiss: [0.15, 0.3], output: [0.6, 1.2] },
    'deepseek-v4-pro': { cacheHit: [0.022, 0.044], cacheMiss: [0.66, 1.32], output: [1.98, 3.96] } } };

// Missing usage is unknown, including a disconnected request that may be billed.
export function reportedUsage(source) {
  const inputTokens = count(source?.prompt_tokens), outputTokens = count(source?.completion_tokens);
  let cacheHitTokens = count(source?.prompt_cache_hit_tokens ?? source?.prompt_tokens_details?.cached_tokens);
  let cacheMissTokens = count(source?.prompt_cache_miss_tokens);
  if (inputTokens !== null) {
    if (cacheHitTokens === null && cacheMissTokens !== null && cacheMissTokens <= inputTokens) cacheHitTokens = inputTokens - cacheMissTokens;
    if (cacheMissTokens === null && cacheHitTokens !== null && cacheHitTokens <= inputTokens) cacheMissTokens = inputTokens - cacheHitTokens;
    if (cacheHitTokens !== null && cacheMissTokens !== null && cacheHitTokens + cacheMissTokens !== inputTokens) cacheHitTokens = cacheMissTokens = null;
  }
  return { usageReported: inputTokens !== null && outputTokens !== null, inputTokens, outputTokens,
    totalTokens: count(source?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cacheHitTokens, cacheMissTokens, reasoningTokens: count(source?.completion_tokens_details?.reasoning_tokens) };
}

export function referenceCost(usage, model, official) {
  const rates = official && USAGE_PRICING.models[model];
  if (!rates || !usage.usageReported || usage.cacheHitTokens === null || usage.cacheMissTokens === null) return null;
  const price = index => (usage.cacheHitTokens * rates.cacheHit[index] + usage.cacheMissTokens * rates.cacheMiss[index] + usage.outputTokens * rates.output[index]) / 1e6;
  return { min: price(0), max: price(1), currency: 'USD', pricingDate: USAGE_PRICING.checkedAt };
}

/** Billing survives conversation cleanup and deletion of a temporary Bot. */
export class UsageLedger {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS model_usage(id TEXT NOT NULL,bot_id TEXT NOT NULL,started_at TEXT NOT NULL,purpose TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,room_id TEXT,data TEXT NOT NULL,PRIMARY KEY(bot_id,id));
      CREATE INDEX IF NOT EXISTS model_usage_started ON model_usage(started_at);
      CREATE INDEX IF NOT EXISTS model_usage_room ON model_usage(room_id,started_at);
      CREATE TABLE IF NOT EXISTS usage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_usage(id TEXT PRIMARY KEY,day TEXT NOT NULL,data TEXT NOT NULL);`);
    this.db.prepare("INSERT OR IGNORE INTO usage_meta VALUES('collectionStartedAt',?)").run(new Date().toISOString());
  }
  save(record) {
    this.db.prepare(`INSERT INTO model_usage(id,bot_id,started_at,purpose,model,status,room_id,data) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(bot_id,id) DO UPDATE SET model=excluded.model,status=excluded.status,data=excluded.data`)
      .run(record.id,record.botId,record.startedAt,record.purpose||'other',record.model||'unknown',record.status,record.roomId||null,JSON.stringify(record));
  }
  recoverBot(botId) {
    for (const row of this.db.prepare("SELECT data FROM model_usage WHERE bot_id=? AND status='pending'").all(botId)) {
      const record = JSON.parse(row.data); this.save({ ...record, status: 'unknown', error: '进程停止前未收到完整回执，实际扣费未知' });
    }
  }
  coverage(range) {
    const startedAt = this.db.prepare("SELECT value FROM usage_meta WHERE key='collectionStartedAt'").get().value;
    return { collectionStartedAt: startedAt, includesUntrackedHistory: !range.from || range.from < startedAt };
  }
  saveProviderReport(report) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(report.day) || !Number.isSafeInteger(report.calls) || report.calls < 0 || !Number.isSafeInteger(report.totalTokens) || report.totalTokens < 0 || !Number.isFinite(report.amount) || report.amount < 0) throw new Error('Invalid provider usage report');
    this.db.prepare('INSERT INTO provider_usage VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,data=excluded.data').run(report.id,report.day,JSON.stringify(report));
  }
  providerReports(range) {
    const day = at => new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(0,10);
    const from = range.from ? day(range.from) : '', to = day(new Date(Date.parse(range.to) - 1).toISOString());
    return this.db.prepare('SELECT data FROM provider_usage WHERE day>=? AND day<=? ORDER BY day').all(from,to).map(row=>JSON.parse(row.data));
  }
  snapshot(read) {
    this.db.exec('BEGIN');
    try { const result=read(); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}

export function usageRoomId(task, store) {
  const input = task?.input?.current || task?.input;
  const direct = task?.metadata?.roomId || input?.metadata?.roomId || input?.room?.id;
  if (direct) return direct;
  const conversation = task?.conversationId || task?.sessionId;
  if (conversation?.startsWith('room:')) return conversation.slice(5);
  const work = task?.workId && store?.getRecord('works', task.workId);
  const rooms = [...new Set((work?.sources || []).map(source => source.roomId).filter(Boolean))];
  // A work spanning several rooms has no single owner unless the trigger says so.
  return rooms.length === 1 ? rooms[0] : null;
}

export function usageRange(period = 'today', at = Date.now()) {
  if (!['today', 'yesterday', '7d', 'all'].includes(period)) throw Object.assign(new Error('无效的用量时间范围'), { status: 400 });
  const day = 86400000, midnight = Math.floor((at + 8 * 3600000) / day) * day - 8 * 3600000;
  return { period, timezone: 'Asia/Shanghai', from: period === 'all' ? '' : new Date(midnight - (period === 'yesterday' ? day : period === '7d' ? 6 * day : 0)).toISOString(),
    to: new Date(period === 'yesterday' ? midnight : at).toISOString() };
}

export function emptyUsageTotals() {
  return { calls: 0, succeeded: 0, failed: 0, cancelled: 0, pending: 0, unknown: 0, reportedCalls: 0, unreportedCalls: 0,
    inputTokens: 0, inputReportedCalls: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cacheKnownInputTokens: 0,
    reasoningTokens: 0, reasoningReportedCalls: 0, pricedCalls: 0, costMin: 0, costMax: 0, latencyMs: 0, timedCalls: 0, historicalCalls: 0 };
}
export function finishUsageTotals(totals) {
  return { ...totals, cacheHitRate: totals.cacheKnownInputTokens > 0 ? totals.cacheHitTokens / totals.cacheKnownInputTokens : null,
    cacheCoverage: totals.inputTokens > 0 ? totals.cacheKnownInputTokens / totals.inputTokens : null,
    averageInputTokens: totals.inputReportedCalls ? totals.inputTokens / totals.inputReportedCalls : null,
    averageLatencyMs: totals.timedCalls ? totals.latencyMs / totals.timedCalls : null };
}
export function combineUsageTotals(groups) {
  const totals = emptyUsageTotals();
  for (const group of groups) for (const key of Object.keys(totals)) totals[key] += group[key] || 0;
  return finishUsageTotals(totals);
}

const sums = `COUNT(*) AS calls,
  SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed,SUM(status='cancelled') AS cancelled,SUM(status='pending') AS pending,SUM(status='unknown') AS unknown,
  SUM(COALESCE(json_extract(data,'$.usageReported'),0)) AS reportedCalls,
  SUM(NOT COALESCE(json_extract(data,'$.usageReported'),0)) AS unreportedCalls,
  SUM(COALESCE(json_extract(data,'$.inputTokens'),0)) AS inputTokens,SUM(COALESCE(json_extract(data,'$.outputTokens'),0)) AS outputTokens,
  SUM(json_extract(data,'$.inputTokens') IS NOT NULL) AS inputReportedCalls,
  SUM(COALESCE(json_extract(data,'$.totalTokens'),0)) AS totalTokens,
  SUM(COALESCE(json_extract(data,'$.cacheHitTokens'),0)) AS cacheHitTokens,SUM(COALESCE(json_extract(data,'$.cacheMissTokens'),0)) AS cacheMissTokens,
  SUM(CASE WHEN json_extract(data,'$.cacheHitTokens') IS NOT NULL AND json_extract(data,'$.cacheMissTokens') IS NOT NULL THEN COALESCE(json_extract(data,'$.inputTokens'),0) ELSE 0 END) AS cacheKnownInputTokens,
  SUM(COALESCE(json_extract(data,'$.reasoningTokens'),0)) AS reasoningTokens,SUM(json_extract(data,'$.reasoningTokens') IS NOT NULL) AS reasoningReportedCalls,
  SUM(json_extract(data,'$.cost') IS NOT NULL) AS pricedCalls,SUM(COALESCE(json_extract(data,'$.cost.min'),0)) AS costMin,SUM(COALESCE(json_extract(data,'$.cost.max'),0)) AS costMax,
  SUM(COALESCE(json_extract(data,'$.latencyMs'),0)) AS latencyMs,SUM(json_extract(data,'$.latencyMs') IS NOT NULL) AS timedCalls,
  SUM(COALESCE(json_extract(data,'$.historical'),0)) AS historicalCalls`;

export function readUsage(db, range, { offset = 0, limit = 25, detail = true, roomId, botId, botIds, excludeBotIds } = {}) {
  const empty = { totals: finishUsageTotals(emptyUsageTotals()), purposes: [], models: [], days: [], rooms: [], bots: [], requests: [], offset, limit, hasMore: false, firstRecordAt: null };
  if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_usage'").get()) return empty;
  if (botIds?.length === 0) return empty;
  const allowed = botIds ? ` AND bot_id IN (${botIds.map(() => '?').join(',')})`
    : excludeBotIds?.length ? ` AND bot_id NOT IN (${excludeBotIds.map(() => '?').join(',')})` : '';
  const filter = (roomId !== undefined ? ' AND room_id IS ?' : '') + (botId ? ' AND bot_id=?' : '') + allowed;
  const filterArgs = [...(roomId !== undefined ? [roomId] : []), ...(botId ? [botId] : []), ...(botIds || excludeBotIds || [])];
  const where = 'started_at>=? AND started_at<?' + filter, args = [range.from, range.to, ...filterArgs];
  const normalize = row => finishUsageTotals(Object.fromEntries(Object.keys(emptyUsageTotals()).map(key => [key, Number(row[key] || 0)])));
  const totals = normalize(db.prepare(`SELECT ${sums} FROM model_usage WHERE ${where}`).get(...args));
  const coverage = db.prepare(`SELECT MIN(started_at) AS firstRecordAt FROM model_usage WHERE 1=1${filter}`).get(...filterArgs);
  const groups = field => {
    const names = field === 'bot_id' ? ",MAX(json_extract(data,'$.botName')) AS name" : field === 'room_id' ? ",MAX(json_extract(data,'$.roomName')) AS name,MAX(json_extract(data,'$.roomKind')) AS kind" : '';
    return db.prepare(`SELECT ${field} AS key${names},${sums} FROM model_usage WHERE ${where} GROUP BY key ORDER BY totalTokens DESC`).all(...args)
      .map(row => ({ key: row.key, ...(names ? { name: row.name, kind: row.kind } : {}), ...normalize(row) }));
  };
  const rooms = groups('room_id');
  if (!detail) return { ...empty, totals, rooms, ...coverage };
  const requests = db.prepare(`SELECT data FROM model_usage WHERE ${where} ORDER BY started_at DESC,bot_id,id DESC LIMIT ? OFFSET ?`).all(...args, limit + 1, offset).map(row => JSON.parse(row.data));
  return { totals, rooms, bots: groups('bot_id'), ...coverage, purposes: groups('purpose'), models: groups('model'),
    days: groups("date(started_at,'+8 hours')").sort((a, b) => a.key.localeCompare(b.key)),
    requests: requests.slice(0, limit), offset, limit, hasMore: requests.length > limit };
}
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
