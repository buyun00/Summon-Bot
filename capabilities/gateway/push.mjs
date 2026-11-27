import { connect } from 'node:http2';
import { createPrivateKey, sign, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../shared/validation.mjs';
import { reject } from '../platform/contract.mjs';

const uuid = /^[a-f0-9-]{36}$/i;
const topic = 'org.lin0.summon';
const ttl = 24 * 60 * 60 * 1000;
const maxApnsPayloadBytes = 3800;

function truncateCodePoints(text, maxChars) {
  const chars = Array.from(String(text || ''));
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

function cleanMarkdownPreview(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => ` ${String(code || '').trim()} `)
    .replace(/```[a-zA-Z0-9_-]*/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => (alt.trim() ? `[图片: ${alt.trim()}]` : '[图片]'))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/(\*\*|__|~~)(.*?)\1/g, '$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatMessagePreview(message, redact) {
  const safe = text => (typeof redact === 'function' && text ? String(redact(text)) : String(text || ''));
  const cleaned = cleanMarkdownPreview(safe(message?.content || ''));
  if (cleaned) return truncateCodePoints(cleaned, 240);

  if (message?.prompt && typeof message.prompt === 'object') {
    const label = cleanMarkdownPreview(safe(
      message.prompt.title || message.prompt.description || message.prompt.questions?.[0]?.label || '',
    ));
    const prefix = message.prompt.kind === 'permission' ? '[需要授权]'
      : message.prompt.kind === 'confirm' ? '[需要确认]'
      : message.prompt.kind === 'secret' ? '[需要输入凭据]'
      : '[等待回复]';
    return truncateCodePoints(label ? `${prefix} ${label}` : prefix, 240);
  }

  if (Array.isArray(message?.attachments) && message.attachments.length) {
    const allImages = message.attachments.every(file => typeof file?.mimeType === 'string' && file.mimeType.startsWith('image/'));
    if (allImages) return message.attachments.length === 1 ? '[图片]' : `[${message.attachments.length} 张图片]`;
    const names = message.attachments.map(file => file?.name).filter(Boolean).join('、');
    return truncateCodePoints(names ? `[附件] ${names}` : '[附件]', 240);
  }

  if (Array.isArray(message?.references) && message.references.length) return '[共享了引用]';
  return '';
}

function buildApnsPayload({ title, subtitle = '', body, threadId, extra }) {
  let bodyText = String(body || '');
  const make = currentBody => JSON.stringify({
    aps: {
      alert: { title, ...(subtitle ? { subtitle } : {}), body: currentBody },
      sound: 'default',
      'thread-id': threadId,
    },
    ...extra,
  });
  let payload = make(bodyText);
  let limit = Array.from(bodyText).length;
  while (Buffer.byteLength(payload, 'utf8') > maxApnsPayloadBytes && limit > 16) {
    limit = Math.max(16, Math.floor(limit * 0.75));
    bodyText = truncateCodePoints(bodyText, limit);
    payload = make(bodyText);
  }
  return payload;
}

/** One owner's workspace, matching the gateway's existing controller authorization.
 * Device tokens stay in its private database, never in snapshots or events.
 * Persisted queue + message cursor survives gateway and capability restarts.
 */
export class PushService {
  constructor({ openStore, messages, dataRoot, historyEpoch, redact, onNotify }) {
    Object.assign(this, { openStore, messages, dataRoot, historyEpoch, redact, onNotify });
    this.closed = false;
    this.inflight = null;
    this.dirty = false;
    this.config = null;
    this.configurationStatus = 'unconfigured';
    this.connections = new Set();
  }
  async initialize() {
    try {
      const config = JSON.parse(await readFile(join(this.dataRoot, 'config', 'apns.json'), 'utf8'));
      if (config.teamId !== '6Y29E7PSVF' || !/^[A-Z0-9]{10}$/.test(config.keyId) || config.bundleId !== topic) {
        throw new Error('Invalid APNs team, key ID, or Bundle ID');
      }
      const key = createPrivateKey(await readFile(join(this.dataRoot, 'config', 'apns.p8')));
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('APNs requires a P-256 private key');
      }
      this.config = { ...config, key };
      this.configurationStatus = 'ready';
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.configurationStatus = 'invalid_config';
        console.error('APNs is disabled because its private configuration could not be loaded');
      }
    }
    try {
      const store = this.openStore();
      store.transaction(() => {
        const cursor = store.get('push-state', 'cursor');
        if (!cursor || cursor.historyEpoch !== this.historyEpoch) {
          for (const job of store.list('push-queue')) store.remove('push-queue', job.id);
          const row = this.messages.db.prepare("SELECT COALESCE(MAX(rowid),0) AS seq FROM records WHERE kind='messages'").get();
          store.save('push-state', { id: 'cursor', seq: row.seq, historyEpoch: this.historyEpoch });
        }
      });
      this.store = store;
    } catch {
      this.configurationStatus = 'storage_unavailable';
      console.error('APNs is disabled because its local queue could not be opened');
      return this;
    }
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref();
    return this;
  }
  status() { return { configured: this.configurationStatus === 'ready', status: this.configurationStatus }; }
  register(input) {
    if (!uuid.test(input.deviceId || '') || !/^[a-f0-9]{64,200}$/i.test(input.token || '')) fail('Invalid push registration');
    if (input.bundleId !== topic || input.environment !== 'production') fail('Unsupported push app or environment');
    if (!this.store) reject('push_unavailable', 'Push registration storage is unavailable', 503);
    // A rotated installation identifier must not leave two registrations for the same token.
    for (const device of this.store.list('push-devices')) {
      if (device.token === input.token && device.id !== input.deviceId) this.remove({ deviceId: device.id });
    }
    this.store.save('push-devices', { id: input.deviceId, token: input.token.toLowerCase() });
    return { registered: true, ...this.status() };
  }
  remove(input) {
    if (!uuid.test(input.deviceId || '')) fail('Invalid device identifier');
    if (!this.store) reject('push_unavailable', 'Push registration storage is unavailable', 503);
    this.store.remove('push-devices', input.deviceId);
    for (const job of this.store.list('push-queue')) if (job.deviceId === input.deviceId) this.store.remove('push-queue', job.id);
    return { removed: true };
  }
  jwt() {
    const now = Math.floor(Date.now() / 1000);
    if (this.authorization && now - this.authorization.at < 3000) return this.authorization.value;
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${encode({ alg: 'ES256', kid: this.config.keyId })}.${encode({ iss: this.config.teamId, iat: now })}`;
    const signature = sign('sha256', Buffer.from(data), { key: this.config.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.authorization = { at: now, value: `${data}.${signature}` };
    return this.authorization.value;
  }
  send(device, job) {
    return new Promise(resolve => {
      const session = connect('https://api.push.apple.com');
      this.connections.add(session);
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer); session.destroy(); this.connections.delete(session); resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 0 }), 15000);
      session.on('error', () => finish({ status: 0 }));
      const request = session.request({ ':method': 'POST', ':path': `/3/device/${device.token}`,
        authorization: `bearer ${this.jwt()}`, 'apns-topic': topic, 'apns-push-type': 'alert', 'apns-priority': '10',
        'apns-expiration': String(Math.floor((Date.parse(job.createdAt) + ttl) / 1000)),
        'apns-collapse-id': job.notificationId, 'content-type': 'application/json' });
      let status = 0, body = '';
      request.on('response', headers => { status = Number(headers[':status']); });
      request.on('data', chunk => { if (body.length < 4096) body += chunk; });
      request.on('error', () => finish({ status: 0 }));
      request.on('end', () => {
        let reason; try { reason = JSON.parse(body).reason; } catch {}
        finish({ status, reason });
      });
      const roomName = truncateCodePoints(String(job.roomName || '').trim(), 60);
      const senderName = truncateCodePoints(String(job.senderName || '').trim(), 48);
      const preview = truncateCodePoints(String(job.preview || '').trim(), 240);
      const title = roomName || senderName || 'Summon Bot';
      let alertBody;
      if (preview) {
        alertBody = job.roomMode !== 'direct' && senderName && senderName !== title
          ? `${senderName}：${preview}`
          : preview;
      } else {
        alertBody = senderName ? `${senderName} 发来一条新消息` : 'Bot 发来一条新消息';
      }
      request.end(buildApnsPayload({
        title,
        body: alertBody,
        threadId: job.roomId,
        extra: { roomId: job.roomId, messageId: job.messageId, deviceId: device.id },
      }));
    });
  }
  tick() {
    if (this.closed || !this.store) return this.inflight;
    if (this.inflight) {
      this.dirty = true;
      return this.inflight;
    }
    this.dirty = false;
    this.inflight = this.drain().catch(() => {
      // No token, key, message text, or response body is emitted to logs.
      console.error('APNs queue operation failed; pending notifications will retry');
    }).finally(() => {
      this.inflight = null;
      if (this.dirty && !this.closed) {
        this.dirty = false;
        void this.tick();
      }
    });
    return this.inflight;
  }
  async drain() {
    const cursor = this.store.get('push-state', 'cursor');
    const rows = this.messages.db.prepare("SELECT rowid AS seq,data FROM records WHERE kind='messages' AND rowid>? ORDER BY rowid LIMIT 100").all(cursor.seq);
    const notified = [];
    this.store.transaction(() => {
      const devices = this.store.list('push-devices');
      for (const row of rows) {
        const message = JSON.parse(row.data), room = this.messages.get('rooms', message.roomId);
        if (message.senderId && !['user', 'system'].includes(message.senderId) && room?.members?.includes('user')
            && Date.now() - Date.parse(message.createdAt) < ttl) {
          const notificationId = randomUUID();
          const roomName = truncateCodePoints(String(room?.name || '').trim(), 60);
          const roomMode = room?.mode === 'direct' ? 'direct' : 'group';
          const senderBot = this.messages.get('platform-bots', message.senderId) || this.messages.get('deleted-bots', message.senderId);
          const senderName = truncateCodePoints(String(message.senderName || senderBot?.name || '').trim(), 48);
          const preview = formatMessagePreview(message, this.redact);
          notified.push({ roomId: message.roomId, roomName, roomMode, senderId: message.senderId, senderName,
            messageId: message.id, preview, notificationId, createdAt: message.createdAt });
          for (const device of devices) {
            if (Date.parse(device.createdAt) > Date.parse(message.createdAt)) continue;
            this.store.save('push-queue', { id: `${message.id}:${device.id}`, messageId: message.id,
              roomId: message.roomId, roomName, roomMode, senderId: message.senderId, senderName, preview,
              deviceId: device.id, notificationId, createdAt: message.createdAt, attempts: 0, nextAt: 0 });
          }
        }
      }
      if (rows.length) this.store.save('push-state', { id: 'cursor', seq: rows.at(-1).seq, historyEpoch: this.historyEpoch });
    });
    for (const item of notified) {
      try { this.onNotify?.(item); } catch {}
    }
    for (const job of this.store.list('push-queue')) {
      if (this.closed) return;
      const device = this.store.get('push-devices', job.deviceId);
      if (!device || Date.now() - Date.parse(job.createdAt) > ttl) { this.store.remove('push-queue', job.id); continue; }
      if (!this.config || job.nextAt > Date.now()) continue;
      const result = await this.send(device, job);
      if (this.closed) return;
      if (result.status === 200) { this.store.remove('push-queue', job.id); continue; }
      if (result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason)) {
        // Do not remove a token refreshed while this request was in flight.
        if (this.store.get('push-devices', device.id)?.token === device.token) this.remove({ deviceId: device.id });
        continue;
      }
      this.store.save('push-queue', { ...job, attempts: job.attempts + 1,
        nextAt: Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(job.attempts, 7)) });
      console.error(`APNs delivery deferred (HTTP ${result.status}); inspect server push configuration if persistent`);
      if (result.status === 403 || result.status === 429 || result.status >= 500 || result.status === 0) break;
    }
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    // Each active request has a bounded timeout and is awaited before SQLite closes.
    await this.inflight;
    for (const session of this.connections) session.destroy();
  }
}
