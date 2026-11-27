import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STALE_AFTER_MS = 6 * 3600 * 1000;

function clamp(v) {
  return Math.min(100, Math.max(0, v));
}

function isoOrNull(value) {
  if (!value) return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function candidateSnapshotPaths() {
  const home = homedir();
  const geminiBase = join(home, '.gemini');
  const list = [];
  const envDir = String(process.env.USAGE_MONITOR_DATA_DIR || '').trim();
  if (envDir) list.push(join(envDir, 'cli-status-snapshot.json'));
  list.push(
    join(geminiBase, 'antigravity', 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'),
    join(geminiBase, 'antigravity-cli', 'sidecar_data', 'usage-monitor', 'panel', 'data', 'cli-status-snapshot.json'),
    join(geminiBase, 'config', 'plugins', 'usage-monitor', 'sidecars', 'panel', 'data', 'cli-status-snapshot.json'),
  );
  return [...new Set(list)];
}

function readFreshestSnapshot() {
  let best = null;
  let bestTs = -1;
  for (const file of candidateSnapshotPaths()) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const ts = Number(parsed.quotas?.meta?.fetchedAtMs || parsed.updatedAtMs || 0);
      if (!best || ts > bestTs) {
        best = parsed;
        bestTs = ts;
      }
    } catch {}
  }
  return best;
}

function poolMatchesModel(pool, modelId) {
  const m = String(modelId || '').toLowerCase();
  const key = String(pool?.poolKey || pool?.poolLabel || '').toLowerCase();
  if (!m) return key === 'gemini';
  if (/claude|gpt|opus|sonnet|haiku/i.test(m)) return /claude|gpt/i.test(key);
  if (/argon/i.test(m) && /argon/i.test(key)) return true;
  if (/carbon/i.test(m) && /carbon/i.test(key)) return true;
  return key === 'gemini';
}

export async function readQuota({ model = '' } = {}) {
  const snap = readFreshestSnapshot();
  const quotas = snap?.quotas;
  if (!quotas || quotas.meta?.hasOfficialData !== true) {
    return {
      source: 'Antigravity (AGY)',
      windows: [],
      unsupported: true,
      note: '未检测到本地 usage-monitor 配额快照',
    };
  }

  const pools = Array.isArray(quotas.pools) && quotas.pools.length
    ? quotas.pools
    : (quotas.activePool ? [quotas.activePool] : []);
  if (!pools.length) {
    return { source: 'Antigravity (AGY)', windows: [], unsupported: true };
  }

  const primaryPool = pools.find(p => poolMatchesModel(p, model)) || quotas.activePool || pools[0];
  const ordered = [primaryPool, ...pools.filter(p => p !== primaryPool)];
  const windows = [];

  for (const pool of ordered) {
    const label = pool.poolLabel || pool.poolKey || 'Antigravity';
    const limitId = pool === primaryPool ? 'primary' : (pool.poolKey || label);
    const weeklyPct = Number.isFinite(Number(pool.weeklyRemainingPct))
      ? Number(pool.weeklyRemainingPct)
      : (Number.isFinite(Number(pool.weeklyRemainingFraction)) ? Number(pool.weeklyRemainingFraction) * 100 : null);
    const fiveHourPct = Number.isFinite(Number(pool.remainingPct))
      ? Number(pool.remainingPct)
      : (Number.isFinite(Number(pool.remainingFraction)) ? Number(pool.remainingFraction) * 100 : null);

    if (pool.hasWeekly !== false && weeklyPct !== null) {
      windows.push({
        name: `${label} · 每周`,
        limitId,
        durationMinutes: 10080,
        remainingPercent: clamp(weeklyPct),
        resetsAt: isoOrNull(pool.weeklyResetTime),
      });
    }
    if (pool.has5h !== false && fiveHourPct !== null) {
      windows.push({
        name: `${label} · 每 5 小时`,
        limitId,
        durationMinutes: 300,
        remainingPercent: clamp(fiveHourPct),
        resetsAt: isoOrNull(pool.resetTime),
      });
    }
  }

  const fetchedMs = Number(quotas.meta?.fetchedAtMs || snap.updatedAtMs || 0);
  const isStale = Boolean(quotas.meta?.isStale) || (fetchedMs > 0 && Date.now() - fetchedMs > STALE_AFTER_MS);

  return {
    source: 'Antigravity 订阅',
    windows,
    ...(fetchedMs > 0 ? { checkedAt: new Date(fetchedMs).toISOString() } : {}),
    ...(isStale ? { stale: true } : {}),
  };
}
