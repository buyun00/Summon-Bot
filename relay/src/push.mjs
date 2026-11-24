import { connect } from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const uuidRe = /^[a-f0-9-]{36}$/i;
const defaultBundleId = 'org.lin0.summon';
const ttlMs = 24 * 60 * 60 * 1000;

export class HubPushService {
  constructor({ store, configDir }) {
    this.store = store;
    this.configDir = configDir;
    this.config = null;
    this.configurationStatus = 'unconfigured';
    this.closed = false;
    this.inflight = null;
    this.connections = new Set();
    this.authorization = null;
  }

  async initialize() {
    try {
      const config = JSON.parse(await readFile(join(this.configDir, 'apns.json'), 'utf8'));
      const bundleId = config.bundleId || defaultBundleId;
      if (!/^[A-Z0-9]{10}$/.test(config.teamId || '') || !/^[A-Z0-9]{10}$/.test(config.keyId || '')) {
        throw new Error('Invalid APNs teamId or keyId');
      }
      const key = createPrivateKey(await readFile(join(this.configDir, 'apns.p8')));
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
        throw new Error('APNs requires a P-256 private key');
      }
      this.config = { ...config, bundleId, key };
      this.configurationStatus = 'ready';
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.configurationStatus = 'invalid_config';
        console.error('Hub APNs disabled: invalid configuration');
      }
    }
    this.timer = setInterval(() => { void this.tick(); }, 3000);
    this.timer.unref();
    return this;
  }

  status() {
    return { configured: this.configurationStatus === 'ready', status: this.configurationStatus };
  }

  register(userId, input) {
    if (!uuidRe.test(input?.deviceId || '') || !/^[a-f0-9]{64,200}$/i.test(input?.token || '')) {
      throw Object.assign(new Error('无效的推送设备注册参数'), { status: 400, code: 'invalid_push_registration' });
    }
    const expectedBundle = this.config?.bundleId || defaultBundleId;
    if (input.bundleId !== expectedBundle || input.environment !== 'production') {
      throw Object.assign(new Error('不支持的应用标识或推送环境'), { status: 400, code: 'unsupported_push_app' });
    }
    this.store.registerPushDevice(userId, {
      deviceId: input.deviceId,
      token: input.token,
      bundleId: input.bundleId,
      environment: input.environment,
    });
    return { registered: true, ...this.status() };
  }

  remove(userId, deviceId) {
    if (!uuidRe.test(deviceId || '')) {
      throw Object.assign(new Error('无效的设备标识'), { status: 400, code: 'invalid_device_id' });
    }
    this.store.removePushDevice(deviceId, userId);
    return { removed: true };
  }

  notify({ userId, nodeId, nodeName, roomId, messageId, notificationId, createdAt }) {
    if (!userId || !nodeId || !roomId || !messageId) return;
    if (createdAt && Date.now() - Date.parse(createdAt) > ttlMs) return;
    this.store.enqueuePush({ userId, nodeId, nodeName, roomId, messageId, notificationId, createdAt });
    void this.tick();
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
        settled = true;
        clearTimeout(timer);
        session.destroy();
        this.connections.delete(session);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ status: 0 }), 15000);
      session.on('error', () => finish({ status: 0 }));
      const request = session.request({
        ':method': 'POST',
        ':path': `/3/device/${device.token}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-topic': this.config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor((Date.parse(job.created_at) + ttlMs) / 1000)),
        'apns-collapse-id': job.notification_id,
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      request.on('response', headers => { status = Number(headers[':status']); });
      request.on('data', chunk => { if (body.length < 4096) body += chunk; });
      request.on('error', () => finish({ status: 0 }));
      request.on('end', () => {
        let reason;
        try { reason = JSON.parse(body).reason; } catch {}
        finish({ status, reason });
      });
      const bodyText = job.node_name ? `${job.node_name} 发来一条新消息` : 'Bot 发来一条新消息';
      request.end(JSON.stringify({
        aps: {
          alert: { title: 'Summon Bot', body: bodyText },
          sound: 'default',
          'thread-id': `${job.node_id}:${job.room_id}`,
        },
        nodeId: job.node_id,
        roomId: job.room_id,
        messageId: job.message_id,
        deviceId: device.deviceId,
      }));
    });
  }

  tick() {
    if (this.closed || this.inflight || !this.config) return this.inflight;
    this.inflight = this.drain().catch(() => {
      console.error('Hub APNs drain failed; pending jobs will retry');
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async drain() {
    const jobs = this.store.listDuePushJobs(Date.now());
    for (const job of jobs) {
      if (this.closed) return;
      const device = this.store.getPushDevice(job.device_id);
      if (!device || Date.now() - Date.parse(job.created_at) > ttlMs) {
        this.store.removePushJob(job.id);
        continue;
      }
      const result = await this.send(device, job);
      if (this.closed) return;
      if (result.status === 200) {
        this.store.removePushJob(job.id);
        continue;
      }
      if (result.status === 410 || ['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(result.reason)) {
        const latest = this.store.getPushDevice(device.deviceId);
        if (latest?.token === device.token) this.store.removePushDevice(device.deviceId);
        this.store.removePushJob(job.id);
        continue;
      }
      const nextAttempts = (job.attempts || 0) + 1;
      const nextAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(nextAttempts, 7));
      this.store.deferPushJob(job.id, nextAttempts, nextAt);
      if (result.status === 403 || result.status === 429 || result.status >= 500 || result.status === 0) break;
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.inflight;
    for (const session of this.connections) session.destroy();
  }
}
