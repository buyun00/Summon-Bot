import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson, writeJson } from '../build/files.mjs';
import { workspaceOrigin } from '../../web/backend/origins.mjs';
import { workspaceProof } from '../../web/backend/workspace-probe.mjs';
import { cloudflareInstall, installedBinary, safeEnvironment, tailscaleInstall, tunnelTokenPath } from './auxiliaries.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { inspectService, launchService, stopService } from './system.mjs';
import { readRemoteAccess, writeRemoteAccess } from './remote-config.mjs';

const providers = new Set(['cloudflare', 'tailscale']);
const targetUrl = config => 'http://127.0.0.1:' + config.web.port;
const planPath = (config, provider) => join(config.dataRoot, 'config', 'remote-' + provider + '-plan.json');
const docs = { cloudflare: cloudflareInstall, tailscale: tailscaleInstall };

const view = (provider, state, extra) => ({ provider, state, docsUrl: docs[provider], ...extra });
function providerName(provider) {
  if (!providers.has(provider)) throw new Error('请选择 cloudflare 或 tailscale。');
  return provider;
}

function command(file, args, timeout = 10000) {
  return new Promise(ready => {
    execFile(file, args, { timeout, windowsHide: true, env: safeEnvironment(), maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => ready({ ok: !error, stdout, stderr, timedOut: error?.killed === true }));
  });
}

function officialAuthorization(text) {
  for (const candidate of String(text || '').match(/https:\/\/[^\s"'<>]+/g) || []) {
    try {
      const url = new URL(candidate);
      if (['login.tailscale.com', 'controlplane.tailscale.com'].includes(url.hostname) && !url.username && !url.password) return url.href;
    } catch {}
  }
  return null;
}

async function tailscaleMapping(config, port) {
  const file = installedBinary('tailscale');
  if (!file) return { state: 'missing' };
  const response = await command(file, ['status', '--json', '--peers=false']);
  let status;
  try { status = JSON.parse(response.stdout); } catch { return { state: 'unavailable' }; }
  if (status.BackendState !== 'Running') return { state: 'needs-login', authorization: officialAuthorization(status.AuthURL) };
  const dns = String(status.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  if (!dns.endsWith('.ts.net') || !status.Self?.ID) return { state: 'needs-https' };
  const served = await command(file, ['serve', 'status', '--json']);
  if (!served.ok) return { state: 'unavailable' };
  let configJSON;
  try { configJSON = JSON.parse(served.stdout) || {}; } catch { return { state: 'unavailable' }; }
  const hostPort = dns + ':' + port;
  const origin = workspaceOrigin('https://' + hostPort, { httpsOnly: true });
  const settings = [configJSON, ...Object.values(configJSON.Foreground || {})];
  if (settings.some(item => item.AllowFunnel?.[hostPort] || item.TCP?.[port] && !item.TCP[port].HTTPS)) {
    return { state: 'conflict', origin };
  }
  const roots = settings.map(item => item.Web?.[hostPort]?.Handlers?.['/']).filter(Boolean);
  const target = targetUrl(config);
  const same = roots.length && roots.every(item => item.Proxy?.replace(/\/$/, '') === target);
  return { state: roots.length ? same ? 'configured' : 'conflict' : 'available', origin, target,
    nodeId: status.Self.ID, file, background: Boolean(configJSON.Web?.[hostPort]?.Handlers?.['/']) };
}

async function probeRoute(config, origin) {
  const challenge = randomBytes(32).toString('base64url');
  const url = new URL('/auth/instance', origin);
  url.searchParams.set('challenge', challenge);
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4500) });
    return response.ok && (await response.json()).proof === workspaceProof(config.web.accessToken, challenge);
  } catch { return false; }
}

async function cloudflareConnection(config) {
  const run = await inspectService(config, 'cloudflared');
  if (run.state !== 'ready') return run.state;
  const ready = await fetch(new URL('/ready', run.url), { redirect: 'error', signal: AbortSignal.timeout(1000) }).catch(() => null);
  return ready?.ok ? 'connected' : 'waiting-connector';
}

export async function remoteStatus(config, provider) {
  providerName(provider);
  const entry = (await readRemoteAccess(config.dataRoot))[provider];
  if (provider === 'tailscale') {
    const mapping = await tailscaleMapping(config, entry?.port || 443);
    const registered = mapping.state === 'configured' && mapping.origin === entry?.origin;
    return view(provider, registered ? 'registered' : mapping.state, {
      origin: registered || mapping.state === 'configured' ? mapping.origin : null,
      owner: entry?.owner || (mapping.state === 'configured' ? 'external' : null),
      registered, authorizationAvailable: Boolean(mapping.authorization),
    });
  }
  if (!entry) return view(provider, installedBinary('cloudflared') ? 'available' : 'missing');
  const reachable = !entry.pending && await probeRoute(config, entry.origin);
  const connector = entry.owner === 'summon' ? await cloudflareConnection(config) : 'external';
  return view(provider, reachable ? 'reachable' : entry.pending ? connector : 'registered', {
    origin: entry.origin, owner: entry.owner, registered: !entry.pending, connector, reachable,
  });
}

async function serialized(config, operation) {
  const lock = await acquireServiceLock(config.dataRoot, 'remote-access-operation',
    () => ({ pid: process.pid, bootId: 'remote-access', state: 'working' }));
  try { return await operation(); }
  finally { await lock.close(); }
}

async function savePlan(config, provider, fields) {
  const plan = { id: randomUUID(), provider, expires: Date.now() + 30 * 60 * 1000, ...fields };
  await writeJson(planPath(config, provider), plan);
  return plan;
}

export function prepareRemote(config, provider, input = {}) {
  providerName(provider);
  return serialized(config, async () => {
    const entries = await readRemoteAccess(config.dataRoot), existing = entries[provider];
    const target = targetUrl(config);
    if (provider === 'tailscale') {
      const port = Number(input.port || existing?.port || 443);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请填写有效的 Serve HTTPS 端口。');
      const mapping = await tailscaleMapping(config, port);
      if (!['available', 'configured'].includes(mapping.state)) {
        if (mapping.authorization) await savePlan(config, provider, { authorization: mapping.authorization });
        return view(provider, mapping.state, { authorizationAvailable: Boolean(mapping.authorization) });
      }
      if (existing && existing.origin !== mapping.origin) throw new Error('请先在原入口撤销登记，再选择另一个 Serve 端口。');
      const plan = await savePlan(config, provider, { port, origin: mapping.origin, nodeId: mapping.nodeId, target,
        reuse: mapping.state === 'configured' });
      return view(provider, 'prepared', { planId: plan.id, origin: plan.origin, target, reuse: plan.reuse, owner: existing?.owner || (plan.reuse ? 'external' : 'summon') });
    }
    const origin = workspaceOrigin(input.origin || existing?.origin, { httpsOnly: true });
    const owner = input.owner || existing?.owner || 'external';
    if (!['external', 'summon'].includes(owner)) throw new Error('请选择由外部或 Summon 管理。');
    if (existing && (existing.owner !== owner || existing.origin !== origin)) throw new Error('请先撤销原登记。外部隧道可继续通过其原有入口管理。');
    if (owner === 'summon' && !installedBinary('cloudflared')) return view(provider, 'missing');
    const plan = await savePlan(config, provider, { origin, owner, target });
    return view(provider, 'prepared', { planId: plan.id, origin, owner, target,
      needsToken: owner === 'summon' && !existing });
  });
}

async function applyTailscale(config, plan, entries) {
  const mapping = await tailscaleMapping(config, plan.port);
  if (mapping.nodeId !== plan.nodeId || mapping.origin !== plan.origin) throw new Error('Tailscale 登录或地址已变化，请重新准备。');
  if (!['available', 'configured'].includes(mapping.state)) return view('tailscale', mapping.state);
  let owner = entries.tailscale?.owner || 'external';
  if (mapping.state === 'available') {
    const response = await command(mapping.file, ['serve', '--bg', '--yes', '--https=' + plan.port, '--set-path=/', plan.target], 15000);
    if (!response.ok) {
      const authorization = officialAuthorization(response.stdout + '\n' + response.stderr);
      if (authorization) await writeJson(planPath(config, 'tailscale'), { ...plan, authorization });
      return view('tailscale', authorization ? 'needs-authorization' : 'unavailable', { authorizationAvailable: Boolean(authorization) });
    }
    const installed = await tailscaleMapping(config, plan.port);
    if (installed.state !== 'configured' || installed.nodeId !== plan.nodeId || !installed.background) return view('tailscale', 'mapping-unconfirmed');
    owner = 'summon';
  }
  entries.tailscale = { origin: plan.origin, owner, port: plan.port, nodeId: plan.nodeId, target: plan.target };
  await writeRemoteAccess(config.dataRoot, entries);
  return view('tailscale', 'registered', { origin: plan.origin, owner, reachable: await probeRoute(config, plan.origin) });
}

async function applyCloudflare(config, plan, entries, token) {
  if (plan.owner === 'summon') {
    const path = tunnelTokenPath(config.dataRoot);
    if (token) {
      if (!/^[A-Za-z0-9_+=/-]{40,8192}$/.test(token)) throw new Error('请通过隐藏输入提交有效的隧道令牌。');
      await stopService(config, 'cloudflared');
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, token + '\n', { mode: 0o600 });
    } else if (!entries.cloudflare) throw new Error('请通过私有文件或隐藏输入提供隧道令牌。');
    entries.cloudflare = { origin: plan.origin, owner: plan.owner, target: plan.target, pending: true };
    await writeRemoteAccess(config.dataRoot, entries);
    try { await launchService(config, 'cloudflared', { timeoutMs: 10000 }); }
    catch { return view('cloudflare', 'connector-unavailable', { owner: plan.owner, origin: plan.origin }); }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await cloudflareConnection(config) === 'connected') break;
      if (attempt === 9) return view('cloudflare', 'waiting-connector', { owner: plan.owner, origin: plan.origin });
      await pause(750);
    }
  }
  entries.cloudflare = { origin: plan.origin, owner: plan.owner, target: plan.target };
  await writeRemoteAccess(config.dataRoot, entries);
  return remoteStatus(config, 'cloudflare');
}

export function applyRemote(config, provider, { planId, confirm, token } = {}) {
  providerName(provider);
  if (confirm !== true) throw new Error('应用前请明确确认当前计划。');
  return serialized(config, async () => {
    const plan = await readJson(planPath(config, provider));
    if (!planId || plan.id !== planId || plan.expires <= Date.now() || plan.target !== targetUrl(config)) {
      throw new Error('接入计划已失效，请重新准备。');
    }
    const entries = await readRemoteAccess(config.dataRoot);
    const result = provider === 'tailscale' ? await applyTailscale(config, plan, entries) : await applyCloudflare(config, plan, entries, token);
    if (['reachable', 'registered'].includes(result.state)) await rm(planPath(config, provider), { force: true });
    return result;
  });
}

export function revokeRemote(config, provider, { confirm } = {}) {
  providerName(provider);
  if (confirm !== true) throw new Error('撤销前请明确确认当前入口。');
  return serialized(config, async () => {
    const entries = await readRemoteAccess(config.dataRoot), entry = entries[provider];
    if (entry?.owner === 'summon') {
      if (provider === 'cloudflare') {
        await stopService(config, 'cloudflared');
        await rm(tunnelTokenPath(config.dataRoot), { force: true });
      } else {
        const mapping = await tailscaleMapping(config, entry.port);
        if (mapping.nodeId !== entry.nodeId || mapping.origin !== entry.origin || mapping.target !== entry.target
          || !['available', 'configured'].includes(mapping.state)) throw new Error('原 Serve 映射的归属无法确认。请先检查部署机上的配置。');
        if (mapping.state === 'configured' && mapping.background) {
          const result = await command(mapping.file, ['serve', '--bg', '--yes', '--https=' + entry.port, '--set-path=/', 'off']);
          if (!result.ok) throw new Error('Tailscale 没有撤销这条 Serve 映射。');
        }
      }
    }
    delete entries[provider];
    await writeRemoteAccess(config.dataRoot, entries);
    await rm(planPath(config, provider), { force: true });
    return view(provider, 'revoked');
  });
}

export async function readRemoteAuthorization(config, provider) {
  providerName(provider);
  try {
    const plan = await readJson(planPath(config, provider));
    return plan.expires > Date.now() ? officialAuthorization(plan.authorization) : null;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
