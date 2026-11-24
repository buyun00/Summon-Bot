#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayStore } from './store.mjs';
import { startRelayServer } from './server.mjs';

const args = process.argv.slice(2);
const command = args[0] || 'start';

function flag(name, fallback = '') {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) return args[i + 1];
    if (args[i].startsWith(prefix)) return args[i].slice(prefix.length);
  }
  return fallback;
}

const dataDir = resolve(flag('data-dir', process.env.SUMMON_RELAY_DATA_DIR || '/data'));
const dbPath = join(dataDir, 'relay.sqlite');

if (command === 'start') {
  const host = flag('host', process.env.SUMMON_RELAY_HOST || '0.0.0.0');
  const port = Number(flag('port', process.env.SUMMON_RELAY_PORT || '8790'));
  const frontendRoot = resolve(flag('frontend', process.env.SUMMON_RELAY_FRONTEND || fileURLToPath(new URL('../../web/frontend', import.meta.url))));
  const maxUploadMb = Math.max(1, Number(flag('max-upload-mb', process.env.SUMMON_RELAY_MAX_UPLOAD_MB || '20')) || 20);
  const maxConcurrentLarge = Math.max(1, Number(flag('max-concurrent-large', process.env.SUMMON_RELAY_MAX_CONCURRENT_LARGE || '2')) || 2);
  const trustProxy = String(process.env.SUMMON_RELAY_TRUST_PROXY ?? 'true').toLowerCase() !== 'false';
  const bootstrapInvite = process.env.SUMMON_RELAY_BOOTSTRAP_INVITE || '';

  const app = await startRelayServer({
    host, port, dataDir, frontendRoot, maxUploadMb, maxConcurrentLarge, trustProxy, bootstrapInvite,
  });
  console.log(JSON.stringify({
    event: 'relay.ready',
    url: app.url,
    dataDir,
    frontendRoot,
    maxUploadMb,
    maxConcurrentLarge,
  }));
  if (app.bootstrapInvite) {
    console.log(`\n========================================`);
    console.log(`Initial Admin Invite Code: ${app.bootstrapInvite}`);
    console.log(`========================================\n`);
  }
  const shutdown = () => {
    void app.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} else if (command === 'invite') {
  const sub = args[1] || 'list';
  const store = new RelayStore(dbPath);
  try {
    if (sub === 'create') {
      const role = flag('role', 'user');
      const maxUses = Number(flag('uses', '1')) || 1;
      const days = Number(flag('days', '0')) || 0;
      const note = flag('note', '');
      const code = flag('code', '') || undefined;
      const expiresAt = days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null;
      const invite = store.createInvite({ code, role, note, maxUses, expiresAt, createdBy: 'cli' });
      console.log(JSON.stringify(invite, null, 2));
    } else if (sub === 'revoke') {
      const code = args[2] || flag('code');
      console.log(JSON.stringify({ code, revoked: store.revokeInvite(code) }));
    } else {
      console.log(JSON.stringify(store.listInvites(), null, 2));
    }
  } finally {
    store.close();
  }
} else if (command === 'users') {
  const sub = args[1] || 'list';
  const store = new RelayStore(dbPath);
  try {
    if (sub === 'disable' || sub === 'enable') {
      const id = args[2];
      console.log(JSON.stringify({ id, updated: store.setUserDisabled(id, sub === 'disable') }));
    } else if (sub === 'reset-password') {
      const id = args[2];
      const password = args[3];
      if (!id || !password) throw new Error('Usage: summon-relay users reset-password <userId> <newPassword>');
      store.updatePassword(id, password);
      console.log(JSON.stringify({ id, reset: true }));
    } else {
      console.log(JSON.stringify(store.listUsers(), null, 2));
    }
  } finally {
    store.close();
  }
} else {
  console.log('Usage: summon-relay start | invite [create|list|revoke] | users [list|disable|enable|reset-password]');
  process.exitCode = 1;
}
