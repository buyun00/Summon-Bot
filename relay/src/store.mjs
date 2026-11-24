import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const derived = scryptSync(password, salt, 64).toString('base64url');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'base64url');
  const actual = scryptSync(password, parts[1], expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function generateInviteCode(prefix = 'SUMMON') {
  const raw = randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

export class RelayStore {
  constructor(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invites (
        code TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'user',
        created_by TEXT,
        note TEXT NOT NULL DEFAULT '',
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'web',
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'unknown',
        hostname TEXT NOT NULL DEFAULT '',
        secret_hash TEXT NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nodes_user ON nodes(user_id);

      CREATE TABLE IF NOT EXISTS push_devices (
        device_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        bundle_id TEXT NOT NULL,
        environment TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);

      CREATE TABLE IF NOT EXISTS push_queue (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        node_name TEXT NOT NULL,
        room_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  close() {
    this.db.close();
  }

  ensureBootstrapInvite(preferredCode) {
    const userCount = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const inviteCount = this.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE revoked = 0 AND used_count < max_uses').get().n;
    if (userCount > 0 || inviteCount > 0) return null;
    const code = (preferredCode || generateInviteCode('SUMMON-ADMIN')).trim().toUpperCase();
    this.createInvite({ code, role: 'admin', note: 'Initial admin bootstrap invite', maxUses: 1 });
    return code;
  }

  createInvite({ code = generateInviteCode(), role = 'user', createdBy = null, note = '', maxUses = 1, expiresAt = null } = {}) {
    const normalized = String(code).trim().toUpperCase();
    if (!/^[A-Z0-9-]{6,48}$/.test(normalized)) throw new Error('邀请码格式无效');
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO invites (code, role, created_by, note, max_uses, used_count, expires_at, revoked, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, 0, ?)
    `).run(normalized, role === 'admin' ? 'admin' : 'user', createdBy, String(note || '').slice(0, 120), Math.max(1, Number(maxUses) || 1), expiresAt || null, now);
    return this.getInvite(normalized);
  }

  getInvite(code) {
    return this.db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || '').trim().toUpperCase()) || null;
  }

  listInvites() {
    return this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT 200').all();
  }

  revokeInvite(code) {
    const res = this.db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(String(code || '').trim().toUpperCase());
    return res.changes > 0;
  }

  registerWithInvite({ inviteCode, username, password, displayName }) {
    const cleanUser = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{1,31}$/.test(cleanUser)) {
      throw Object.assign(new Error('用户名需为 2–32 位字母、数字、点、下划线或短横线'), { status: 400, code: 'invalid_username' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
      throw Object.assign(new Error('密码长度需在 8–128 位之间'), { status: 400, code: 'invalid_password' });
    }
    const cleanName = String(displayName || username || '').trim().slice(0, 48) || cleanUser;
    const cleanCode = String(inviteCode || '').trim().toUpperCase();

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const invite = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(cleanCode);
      if (!invite || invite.revoked) {
        throw Object.assign(new Error('邀请码无效或已停用'), { status: 400, code: 'invalid_invite' });
      }
      if (invite.used_count >= invite.max_uses) {
        throw Object.assign(new Error('邀请码已用完'), { status: 400, code: 'invite_exhausted' });
      }
      if (invite.expires_at && Date.parse(invite.expires_at) <= Date.now()) {
        throw Object.assign(new Error('邀请码已过期'), { status: 400, code: 'invite_expired' });
      }
      const existing = this.db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUser);
      if (existing) {
        throw Object.assign(new Error('该用户名已被注册'), { status: 409, code: 'username_taken' });
      }
      const existingUsers = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
      const role = existingUsers === 0 || invite.role === 'admin' ? 'admin' : 'user';
      const id = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO users (id, username, display_name, password_hash, role, disabled, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `).run(id, cleanUser, cleanName, hashPassword(password), role, now);
      this.db.prepare('UPDATE invites SET used_count = used_count + 1 WHERE code = ?').run(cleanCode);
      this.db.exec('COMMIT');
      return this.getUserById(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  authenticateUser(username, password) {
    const cleanUser = String(username || '').trim().toLowerCase();
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUser);
    if (!row || !verifyPassword(password, row.password_hash)) return null;
    if (row.disabled) throw Object.assign(new Error('该账号已被停用'), { status: 403, code: 'account_disabled' });
    return this.sanitizeUser(row);
  }

  sanitizeUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      disabled: Boolean(row.disabled),
      createdAt: row.created_at,
    };
  }

  getUserById(id) {
    return this.sanitizeUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY created_at DESC').all().map(row => this.sanitizeUser(row));
  }

  setUserDisabled(id, disabled) {
    const res = this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    return res.changes > 0;
  }

  updatePassword(userId, newPassword, keepSessionId = null) {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
      throw Object.assign(new Error('密码长度需在 8–128 位之间'), { status: 400, code: 'invalid_password' });
    }
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
    if (keepSessionId) {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepSessionId);
    } else {
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
  }

  createSession(userId, { kind = 'web', label = '', ttlMs = 30 * 86400000 } = {}) {
    const id = randomUUID();
    const token = randomToken(32);
    const now = Date.now();
    const iso = new Date(now).toISOString();
    const expiresAt = now + ttlMs;
    const cleanKind = ['web', 'desktop', 'ios', 'android'].includes(kind) ? kind : 'web';
    const cleanLabel = String(label || cleanKind).trim().slice(0, 80);
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, kind, label, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, sha256(token), cleanKind, cleanLabel, iso, iso, expiresAt);
    return { id, token, kind: cleanKind, label: cleanLabel, expiresAt };
  }

  verifySessionToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 256) return null;
    const row = this.db.prepare(`
      SELECT s.id AS sid, s.user_id, s.kind, s.label, s.created_at AS s_created_at, s.last_seen_at, s.expires_at,
             u.id, u.username, u.display_name, u.role, u.disabled, u.created_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `).get(sha256(token));
    if (!row) return null;
    const now = Date.now();
    if (row.disabled || row.expires_at <= now) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(row.sid);
      return null;
    }
    // Slide expiry if older than 1 day since last seen
    const lastSeenMs = Date.parse(row.last_seen_at) || 0;
    let expiresAt = row.expires_at;
    if (now - lastSeenMs > 3600000) {
      expiresAt = now + 30 * 86400000;
      this.db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
        .run(new Date(now).toISOString(), expiresAt, row.sid);
    }
    return {
      user: this.sanitizeUser(row),
      session: { id: row.sid, kind: row.kind, label: row.label, createdAt: row.s_created_at, lastSeenAt: row.last_seen_at, expiresAt },
    };
  }

  listSessions(userId) {
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?').run(userId, now);
    return this.db.prepare('SELECT id, kind, label, created_at AS createdAt, last_seen_at AS lastSeenAt, expires_at AS expiresAt FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC').all(userId);
  }

  deleteSession(userId, sessionId) {
    const res = this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id = ?').run(userId, sessionId);
    return res.changes > 0;
  }

  pairNode(userId, { name, platform = 'unknown', hostname = '' } = {}) {
    const id = randomUUID();
    const secret = randomToken(32);
    const cleanName = String(name || hostname || '我的电脑').trim().slice(0, 48) || '我的电脑';
    const cleanPlatform = ['win32', 'darwin', 'linux'].includes(platform) ? platform : 'unknown';
    const cleanHost = String(hostname || '').trim().slice(0, 80);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO nodes (id, user_id, name, platform, hostname, secret_hash, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, cleanName, cleanPlatform, cleanHost, sha256(secret), now, now);
    return { id, userId, name: cleanName, platform: cleanPlatform, hostname: cleanHost, nodeSecret: secret, createdAt: now };
  }

  authenticateNode(nodeId, nodeSecret) {
    if (typeof nodeId !== 'string' || typeof nodeSecret !== 'string') return null;
    const row = this.db.prepare(`
      SELECT n.*, u.disabled AS user_disabled
      FROM nodes n
      JOIN users u ON u.id = n.user_id
      WHERE n.id = ?
    `).get(nodeId);
    if (!row || row.user_disabled) return null;
    const expected = Buffer.from(row.secret_hash, 'hex');
    const actual = Buffer.from(sha256(nodeSecret), 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      platform: row.platform,
      hostname: row.hostname,
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
    };
  }

  touchNode(nodeId, { platform, hostname } = {}) {
    const now = new Date().toISOString();
    const cleanPlatform = ['win32', 'darwin', 'linux'].includes(platform) ? platform : null;
    const cleanHost = typeof hostname === 'string' && hostname.trim() ? hostname.trim().slice(0, 80) : null;
    this.db.prepare(`
      UPDATE nodes
      SET last_seen_at = ?,
          platform = COALESCE(?, platform),
          hostname = COALESCE(?, hostname)
      WHERE id = ?
    `).run(now, cleanPlatform, cleanHost, nodeId);
  }

  getNode(userId, nodeId) {
    const row = this.db.prepare('SELECT id, user_id AS userId, name, platform, hostname, last_seen_at AS lastSeenAt, created_at AS createdAt FROM nodes WHERE user_id = ? AND id = ?').get(userId, nodeId);
    return row || null;
  }

  listNodes(userId) {
    return this.db.prepare('SELECT id, user_id AS userId, name, platform, hostname, last_seen_at AS lastSeenAt, created_at AS createdAt FROM nodes WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  }

  renameNode(userId, nodeId, name) {
    const clean = String(name || '').trim().slice(0, 48);
    if (!clean) throw Object.assign(new Error('节点名称不能为空'), { status: 400, code: 'invalid_name' });
    const res = this.db.prepare('UPDATE nodes SET name = ? WHERE user_id = ? AND id = ?').run(clean, userId, nodeId);
    if (!res.changes) return null;
    return this.getNode(userId, nodeId);
  }

  deleteNode(userId, nodeId) {
    const res = this.db.prepare('DELETE FROM nodes WHERE user_id = ? AND id = ?').run(userId, nodeId);
    return res.changes > 0;
  }

  registerPushDevice(userId, { deviceId, token, bundleId, environment }) {
    const now = new Date().toISOString();
    const cleanToken = String(token).toLowerCase();
    // Avoid stale duplicate device entries for the same APNs token
    this.db.prepare('DELETE FROM push_devices WHERE token = ? AND device_id != ?').run(cleanToken, deviceId);
    this.db.prepare(`
      INSERT INTO push_devices (device_id, user_id, token, bundle_id, environment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        user_id = excluded.user_id,
        token = excluded.token,
        bundle_id = excluded.bundle_id,
        environment = excluded.environment,
        updated_at = excluded.updated_at
    `).run(deviceId, userId, cleanToken, bundleId, environment, now, now);
  }

  removePushDevice(deviceId, userId = null) {
    if (userId) {
      this.db.prepare('DELETE FROM push_devices WHERE device_id = ? AND user_id = ?').run(deviceId, userId);
    } else {
      this.db.prepare('DELETE FROM push_devices WHERE device_id = ?').run(deviceId);
    }
    this.db.prepare('DELETE FROM push_queue WHERE device_id = ?').run(deviceId);
  }

  listPushDevices(userId) {
    return this.db.prepare('SELECT device_id AS deviceId, user_id AS userId, token, bundle_id AS bundleId, environment, created_at AS createdAt FROM push_devices WHERE user_id = ?').all(userId);
  }

  enqueuePush({ userId, nodeId, nodeName, roomId, messageId, notificationId, createdAt }) {
    const devices = this.listPushDevices(userId);
    for (const device of devices) {
      const id = `${nodeId}:${messageId}:${device.deviceId}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO push_queue (id, user_id, node_id, node_name, room_id, message_id, device_id, notification_id, created_at, attempts, next_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
      `).run(id, userId, nodeId, nodeName || 'PC', roomId, messageId, device.deviceId, notificationId || randomUUID(), createdAt || new Date().toISOString());
    }
  }

  listDuePushJobs(now = Date.now()) {
    return this.db.prepare('SELECT * FROM push_queue WHERE next_at <= ? ORDER BY created_at ASC LIMIT 50').all(now);
  }

  getPushDevice(deviceId) {
    return this.db.prepare('SELECT device_id AS deviceId, user_id AS userId, token, bundle_id AS bundleId, environment FROM push_devices WHERE device_id = ?').get(deviceId) || null;
  }

  removePushJob(id) {
    this.db.prepare('DELETE FROM push_queue WHERE id = ?').run(id);
  }

  deferPushJob(id, attempts, nextAt) {
    this.db.prepare('UPDATE push_queue SET attempts = ?, next_at = ? WHERE id = ?').run(attempts, nextAt, id);
  }
}
