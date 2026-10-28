import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { FramedPipe } from './framed-pipe.js';
import { ApiError, unavailable } from './errors.js';

export const ALLOWED_TOOLS = new Set(['get_usage_limits', 'list_threads', 'list_archived_threads', 'read_thread', 'wait_threads', 'list_projects', 'create_thread', 'send_message_to_thread', 'set_thread_title', 'set_thread_archived', 'set_thread_read_state']);

export function discoverToolsPipe(explicit) {
  if (explicit) return explicit;
  if (process.platform !== 'win32') throw unavailable('Automatic desktop discovery currently supports Windows only.');
  const names = readdirSync('\\\\.\\pipe\\').filter(name => /^codex-app-tools-[0-9a-f-]+$/i.test(name));
  if (names.length !== 1) throw unavailable(names.length ? 'Multiple desktops found; configure toolsPipe explicitly.' : 'No Codex desktop tool pipe found.');
  return `\\\\.\\pipe\\${names[0]}`;
}

export class AppTools {
  constructor(config) { this.config = config; this.catalog = []; }
  async connect() {
    if (this.closed) throw unavailable('Bridge is shutting down.');
    if (this.pipe?.connected && this.catalog.length) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const pipe = new FramedPipe(discoverToolsPipe(this.config.toolsPipe), { maxBytes: 8 * 1024 * 1024, timeoutMs: this.config.requestTimeoutMs });
      this.pipe?.close(); this.pipe = pipe;
      await pipe.connect();
      const response = await pipe.request({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/list', params: { threadStartKind: 'all' } });
      if (!Array.isArray(response.result?.tools)) throw new ApiError(502, 'protocol_mismatch', 'Desktop tool catalog is incompatible.');
      this.catalog = response.result.tools;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async call(tool, args = {}) {
    if (!ALLOWED_TOOLS.has(tool)) throw new ApiError(403, 'tool_not_allowed', 'This tool is not exposed by the API.');
    await this.connect();
    if (!this.catalog.some(entry => entry.namespace === 'codex_app' && entry.name === tool)) throw new ApiError(501, 'unsupported_capability', `Desktop does not advertise ${tool}.`);
    if (!this.config.callerThreadId) throw new ApiError(503, 'caller_thread_required', 'Set callerThreadId to an existing local Codex chat for desktop tool context.');
    const id = randomUUID();
    const response = await this.pipe.request({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      namespace: 'codex_app', tool, arguments: args, callerSource: 'codex', hostId: 'local',
      threadId: this.config.callerThreadId, turnId: `desktop-api-${id}`, callId: `desktop-api-${id}`,
    } }, this.config.requestTimeoutMs);
    const result = response.result;
    if (!result || result.success !== true) {
      const detail = result?.contentItems?.filter(item => typeof item.text === 'string').map(item => item.text).join('\n') || 'Desktop tool reported failure.';
      throw new ApiError(/invalid arguments/.test(detail) ? 400 : 502, 'desktop_tool_failed', detail.slice(0, 4000));
    }
    const content = result.contentItems ?? [];
    const texts = content.filter(item => item.type === 'inputText' || item.type === 'text').map(item => item.text);
    for (const text of texts) { try { return JSON.parse(text); } catch {} }
    return { content };
  }
  close() { this.closed = true; this.pipe?.close(); }
}

// Keep desktop payload interpretation inside the protocol adapter.
export function normalizeUsage(payload, observedAt = new Date().toISOString()) {
  const notes = ['Quota is percent capacity (100), not an absolute token/message allowance.',
    'observedAt is bridge receipt time, not an upstream measurement timestamp.',
    'periodStart is derived from periodEnd minus windowDurationMins.'];
  const byId = payload?.rateLimitsByLimitId;
  const buckets = byId && typeof byId === 'object' && !Array.isArray(byId) && Object.keys(byId).length
    ? Object.entries(byId) : payload?.rateLimits ? [[payload.rateLimits.limitId ?? 'legacy', payload.rateLimits]] : [];
  const weekly = [];
  for (const [limitId, bucket] of buckets) {
    for (const window of ['primary', 'secondary']) {
      const value = bucket?.[window];
      if (value?.windowDurationMins !== 10080) continue;
      const used = typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 ? value.usedPercent : null;
      const endMs = typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) && value.resetsAt >= 0 ? value.resetsAt * 1000 : NaN;
      const validEnd = Number.isFinite(new Date(endMs).getTime());
      const missing = [];
      if (used === null) missing.push('Invalid or missing usedPercent; used and remaining are null.');
      if (!validEnd) missing.push('Invalid or missing resetsAt; period boundaries are null.');
      weekly.push({ limitId, window, limit: 100, used, remaining: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
        unit: 'percent', windowDurationMins: 10080, periodStart: validEnd ? new Date(endMs - 10080 * 60000).toISOString() : null,
        periodEnd: validEnd ? new Date(endMs).toISOString() : null, periodStartDerived: validEnd, notes: missing });
    }
  }
  if (!weekly.length) notes.push('No identifiable weekly window (10080 minutes); weekly is null. Missing usage is not zero usage.');
  return { source: 'desktop_get_usage_limits', hostId: 'local', observedAt, weekly: weekly.length ? weekly : null, notes };
}
