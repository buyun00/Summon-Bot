import { createHmac, randomUUID } from 'node:crypto';
import { appendFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';

export const WEBHOOK_DEFAULTS = Object.freeze({ enabled: false, url: '', secret: '',
  events: ['thread.status:idle', 'thread.status:completed', 'thread.status:failed', 'waiting_for_input', 'desktop.disconnected'],
  debounceMs: 300, minIntervalMs: 1000, timeoutMs: 5000, maxAttempts: 3, retryDelayMs: 1000, maxQueue: 256 });
export function webhookConfig(value = {}) {
  const config = { ...WEBHOOK_DEFAULTS, ...value };
  if (typeof config.enabled !== 'boolean') throw new Error('webhook.enabled must be boolean.');
  const allowed = [...WEBHOOK_DEFAULTS.events, 'thread.status', 'thread.status:waiting_for_input'];
  if (!Array.isArray(config.events) || config.events.some(x => !allowed.includes(x))) throw new Error('Invalid webhook.events.');
  for (const [key, min, max] of [['debounceMs', 0, 60000], ['minIntervalMs', 0, 60000], ['timeoutMs', 1, 60000], ['maxAttempts', 1, 5], ['retryDelayMs', 0, 60000], ['maxQueue', 1, 4096]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid webhook.${key}.`);
  }
  if (config.enabled) {
    let url; try { url = new URL(config.url); } catch { throw new Error('Invalid webhook.url.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('webhook.url must be HTTP(S) without credentials.');
    if (typeof config.secret !== 'string' || !config.secret.length) throw new Error('Enabled webhook requires webhook.secret.');
  }
  return config;
}

// Consumes the same journal events as SSE, without replaying old notifications.
export class Webhook {
  constructor(broker, config, dataDir, { fetchImpl = fetch, logger } = {}) {
    this.config = webhookConfig(config); this.broker = broker; this.fetch = fetchImpl;
    this.queue = new Map(); this.seen = new Map(); this.lastAttempt = 0; this.closed = false;
    this.logFile = path.join(dataDir, 'webhook.log'); this.logChain = Promise.resolve();
    this.logger = logger || (entry => {
      this.logChain = this.logChain.then(async () => {
        if ((await stat(this.logFile).catch(() => null))?.size > 1048576) await rename(this.logFile, this.logFile + '.1');
        await appendFile(this.logFile, JSON.stringify(entry) + '\n');
      }).catch(() => console.error('Webhook log write failed.'));
    });
    this.onEvent = event => this.receive(event);
    if (this.config.enabled) broker.on('event', this.onEvent);
  }
  receive(event) {
    if (this.closed || !this.config.enabled) return;
    const data = event.data || {}, key = `${event.hostId || 'local'}:${event.threadId || 'desktop'}`;
    let status = data.status;
    if (event.type === 'thread.status' || event.type === 'thread.snapshot') {
      if (data.stale || status === 'unknown') return;
      if (status !== 'waiting_for_input' && ['completed', 'failed'].includes(data.currentTurn?.status)) status = data.currentTurn.status;
      const signature = JSON.stringify([status, data.currentTurn?.id]);
      const previous = this.seen.get(key); this.seen.delete(key); this.seen.set(key, signature);
      if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
      if (previous === signature || (!previous && event.type === 'thread.snapshot' && status !== 'waiting_for_input')) return;
      if (!['idle', 'completed', 'failed', 'waiting_for_input'].includes(status)) return;
      if (!this.config.events.some(x => x === 'thread.status' || x === `thread.status:${status}` || (x === 'waiting_for_input' && status === x))) return;
    } else if (event.type !== 'desktop.disconnected' || !this.config.events.includes(event.type)) return;
    const slot = this.broker.subscriptions?.get(key)?.normalized || {};
    const payload = { id: randomUUID(), eventId: event.id, eventType: event.type === 'thread.snapshot' ? 'thread.status' : event.type,
      threadId: event.threadId ?? null, hostId: event.hostId ?? null, title: data.title ?? slot.title ?? null,
      cwd: data.cwd ?? slot.cwd ?? null, status: status ?? null, turnId: data.currentTurn?.id ?? null, at: event.at };
    if (!this.queue.has(key) && this.queue.size >= this.config.maxQueue) { this.log(payload, 0, 'queue_full'); return; }
    const pending = this.queue.get(key);
    this.queue.set(key, { payload, readyAt: pending?.readyAt ?? Date.now() + this.config.debounceMs });
    this.kick();
  }
  log(payload, attempt, result) { this.logger({ at: new Date().toISOString(), deliveryId: payload.id, eventId: payload.eventId, attempt, result }); }
  kick() {
    if (this.running || this.closed) return;
    this.running = this.drain().finally(() => { this.running = null; if (this.queue.size && !this.closed) this.kick(); });
  }
  async pause(ms) {
    if (ms <= 0 || this.closed) return;
    await new Promise(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, ms); });
    this.wake = null;
  }
  async drain() {
    while (this.queue.size && !this.closed) {
      const [key, pending] = this.queue.entries().next().value;
      await this.pause(pending.readyAt - Date.now());
      if (this.closed) break;
      const { payload } = this.queue.get(key); this.queue.delete(key);
      const body = JSON.stringify(payload);
      const signature = 'sha256=' + createHmac('sha256', this.config.secret).update(body).digest('hex');
      for (let attempt = 1; attempt <= this.config.maxAttempts && !this.closed; attempt++) {
        await this.pause(this.lastAttempt + this.config.minIntervalMs - Date.now());
        if (this.closed) break;
        this.lastAttempt = Date.now(); this.abort = new AbortController();
        const timeout = setTimeout(() => this.abort?.abort(), this.config.timeoutMs);
        try {
          const response = await this.fetch(this.config.url, { method: 'POST', body, redirect: 'error',
            signal: this.abort.signal, headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature, 'X-Webhook-Id': payload.id } });
          await response.body?.cancel();
          this.log(payload, attempt, `http_${response.status}`);
          if (response.ok || (response.status < 500 && ![408, 429].includes(response.status))) break;
        } catch { if (!this.closed) this.log(payload, attempt, 'network_error_or_timeout'); }
        finally { clearTimeout(timeout); this.abort = null; }
        if (attempt < this.config.maxAttempts) await this.pause(this.config.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  async close() {
    this.closed = true; this.broker.off('event', this.onEvent); this.queue.clear();
    clearTimeout(this.timer); this.wake?.(); this.abort?.abort();
    await this.running; await this.logChain;
  }
}
