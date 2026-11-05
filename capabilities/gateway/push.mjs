import { connect } from 'node:http2';
import { createPrivateKey, sign, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from '../shared/validation.mjs';

const uuid = /^[a-f0-9-]{36}$/i;
const topic = 'org.lin0.summon';
const ttl = 24 * 60 * 60 * 1000;

/** One owner's workspace, matching the gateway's existing controller authorization.
 * Device tokens stay in its private database, never in snapshots or events.
 * Persisted queue + message cursor survives gateway and capability restarts.
 */
export class PushService {
  constructor({ store, messages, dataRoot, historyEpoch }) {
    Object.assign(this, { store, messages, dataRoot, historyEpoch });
    this.closed = false;
    this.inflight = null;
    this.config = null;
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
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Invalid APNs configuration; check private config files');
    }
    const cursor = this.store.get('push-state', 'cursor');
    if (!cursor || cursor.historyEpoch !== this.historyEpoch) {
      for (const job of this.store.list('push-queue')) this.store.remove('push-queue', job.id);
      const row = this.messages.db.prepare("SELECT COALESCE(MAX(rowid),0) AS seq FROM records WHERE kind='messages'").get();
      this.store.save('push-state', { id: 'cursor', seq: row.seq, historyEpoch: this.historyEpoch });
    }
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref();
    return this;
  }
  status() { return { configured: Boolean(this.config) }; }
  register(input) {
    if (!uuid.test(input.deviceId || '') || !/^[a-f0-9]{64,200}$/i.test(input.token || '')) fail('Invalid push registration');
    if (input.bundleId !== topic || input.environment !== 'production') fail('Unsupported push app or environment');
    // A rotated installation identifier must not leave two registrations for the same token.
    for (const device of this.store.list('push-devices')) {
      if (device.token === input.token && device.id !== input.deviceId) this.remove({ deviceId: device.id });
    }
    this.store.save('push-devices', { id: input.deviceId, token: input.token.toLowerCase() });
    return { registered: true, ...this.status() };
  }
  remove(input) {
    if (!uuid.test(input.deviceId || '')) fail('Invalid device identifier');
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
      request.end(JSON.stringify({ aps: { alert: { title: 'Summon Bot', body: 'Bot 发来一条新消息' }, sound: 'default',
        'thread-id': job.roomId }, roomId: job.roomId, messageId: job.messageId, deviceId: device.id }));
    });
  }
  tick() {
    if (this.closed || this.inflight) return this.inflight;
    this.inflight = this.drain().catch(() => {
      // No token, key, message text, or response body is emitted to logs.
      console.error('APNs queue operation failed; pending notifications will retry');
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async drain() {
    const cursor = this.store.get('push-state', 'cursor');
    const rows = this.messages.db.prepare("SELECT rowid AS seq,data FROM records WHERE kind='messages' AND rowid>? ORDER BY rowid LIMIT 100").all(cursor.seq);
    this.store.transaction(() => {
      const devices = this.store.list('push-devices');
      for (const row of rows) {
        const message = JSON.parse(row.data), room = this.messages.get('rooms', message.roomId);
        if (message.senderId && !['user', 'system'].includes(message.senderId) && room?.members?.includes('user')
            && Date.now() - Date.parse(message.createdAt) < ttl) {
          for (const device of devices) {
            if (Date.parse(device.createdAt) > Date.parse(message.createdAt)) continue;
            this.store.save('push-queue', { id: `${message.id}:${device.id}`, messageId: message.id,
              roomId: message.roomId, deviceId: device.id, notificationId: randomUUID(), createdAt: message.createdAt, attempts: 0, nextAt: 0 });
          }
        }
      }
      if (rows.length) this.store.save('push-state', { id: 'cursor', seq: rows.at(-1).seq, historyEpoch: this.historyEpoch });
    });
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
