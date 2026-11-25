import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson, writeJson } from './files.mjs';
import { instanceOrigin } from '../../web/backend/origins.mjs';
import { cloudflareInstall, installedBinary, safeEnvironment, tailscaleInstall, tunnelTokenPath } from './auxiliaries.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { inspectService, launchService, stopService } from './system.mjs';
import { inspectRemoteOrigin, readRemoteAccess, usableRemoteAccess, verifyRemoteCandidate, writeRemoteAccess } from './remote-config.mjs';
import { assertInstallationWritable, dataFormat } from './installation-state.mjs';

const providers = new Set(['cloudflare', 'tailscale']);
const targetUrl = config => 'http://127.0.0.1:' + config.web.port;
const planPath = (config, provider) => join(config.dataRoot, 'config', 'remote-' + provider + '-plan.json');
const docs = { cloudflare: cloudflareInstall, tailscale: tailscaleInstall };
const budget = (config, provider, name, fallback) => {
  const value = config.remoteAccess?.[provider]?.[name];
  return Number.isSafeInteger(value) && value > 0 && value <= 300000 ? value : fallback;
};

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
  const timeout = budget(config, 'tailscale', 'commandTimeoutMs', 10000);
  const response = await command(file, ['status', '--json', '--peers=false'], timeout);
  let status;
  try { status = JSON.parse(response.stdout); } catch { return { state: 'unavailable' }; }
  if (status.BackendState !== 'Running') return { state: 'needs-login', authorization: officialAuthorization(status.AuthURL) };
  const dns = String(status.Self?.DNSName || '').replace(/\.$/, '').toLowerCase();
  if (!dns.endsWith('.ts.net') || !status.Self?.ID) return { state: 'needs-https' };
  const served = await command(file, ['serve', 'status', '--json'], timeout);
  if (!served.ok) return { state: 'unavailable' };
  let configJSON;
  try { configJSON = JSON.parse(served.stdout) || {}; } catch { return { state: 'unavailable' }; }
  const hostPort = dns + ':' + port;
  const origin = instanceOrigin('https://' + hostPort, { httpsOnly: true });
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

const probeRoute = (config, provider, origin) => inspectRemoteOrigin(config, origin, {
  timeoutMs: budget(config, provider, 'probeTimeoutMs', 4500),
});

async function cloudflareConnection(config) {
  const run = await inspectService(config, 'cloudflared');
  if (run.state !== 'ready') return run.state;
  const ready = await fetch(new URL('/ready', run.url), { redirect: 'error', signal: AbortSignal.timeout(1000) }).catch(() => null);
  return ready?.ok ? 'connected' : 'waiting-connector';
}

export async function remoteStatus(config, provider) {
  providerName(provider);
  const entry = (await usableRemoteAccess(config.dataRoot))[provider];
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
  const reachable = !entry.pending && (await probeRoute(config, provider, entry.origin)).reachable;
  const connector = entry.owner === 'summon' ? await cloudflareConnection(config) : 'external';
  return view(provider, reachable ? 'reachable' : entry.pending ? connector : 'registered', {
    origin: entry.origin, owner: entry.owner, registered: !entry.pending, connector, reachable,
  });
}

async function serialized(config, operation) {
  if (config.dataFormat !== dataFormat) throw new Error('正式实例需先完成版本更新。');
  await assertInstallationWritable(config.dataRoot, config.releaseRoot);
  const lock = await acquireServiceLock(config.dataRoot, 'remote-access-operation',
    () => ({ pid: process.pid, bootId: 'remote-access', state: 'working' }));
  try { await assertInstallationWritable(config.dataRoot, config.releaseRoot); return await operation(); }
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
      const plan = await savePlan(config, provider, { port, origin: mapping.origin, nodeId: mapping.nodeId, target,
        reuse: mapping.state === 'configured' });
      return view(provider, 'prepared', { planId: plan.id, origin: plan.origin, target, reuse: plan.reuse,
        owner: (existing?.origin === plan.origin && existing?.owner) || (plan.reuse ? 'external' : 'summon') });
    }
    const origin = instanceOrigin(input.origin || existing?.origin, { httpsOnly: true });
    const owner = input.owner || existing?.owner || 'external';
    if (!['external', 'summon'].includes(owner)) throw new Error('请选择由外部或 Summon 管理。');
    if (owner === 'summon' && !installedBinary('cloudflared')) return view(provider, 'missing');
    const plan = await savePlan(config, provider, { origin, owner, target });
    return view(provider, 'prepared', { planId: plan.id, origin, owner, target,
      needsToken: owner === 'summon' && existing?.owner !== 'summon' });
  });
}

async function removeTailscaleMapping(config, entry) {
  const mapping = await tailscaleMapping(config, entry.port);
  if (mapping.nodeId !== entry.nodeId || mapping.origin !== entry.origin || mapping.target !== entry.target
    || !['available', 'configured'].includes(mapping.state)) throw new Error('原 Serve 映射的归属无法确认。请检查部署机上的配置。');
  if (mapping.state === 'configured' && mapping.background) {
    const result = await command(mapping.file, ['serve', '--bg', '--yes', '--https=' + entry.port, '--set-path=/', 'off'],
      budget(config, 'tailscale', 'serveTimeoutMs', 15000));
    if (!result.ok) throw new Error('Tailscale 没有撤销这条 Serve 映射。');
  }
}

async function applyTailscale(config, plan, entries) {
  const mapping = await tailscaleMapping(config, plan.port);
  if (mapping.nodeId !== plan.nodeId || mapping.origin !== plan.origin) throw new Error('Tailscale 登录或地址已变化，请重新准备。');
  if (!['available', 'configured'].includes(mapping.state)) return view('tailscale', mapping.state);
  const previous = entries.tailscale;
  const sameMapping = previous?.origin === plan.origin && previous.nodeId === plan.nodeId;
  const result = await verifyRemoteCandidate(config.dataRoot, entries, plan, async () => {
    let owner = (sameMapping && previous.owner) || 'external', created = false;
    if (mapping.state === 'available') {
      const response = await command(mapping.file, ['serve', '--bg', '--yes', '--https=' + plan.port, '--set-path=/', plan.target],
        budget(config, 'tailscale', 'serveTimeoutMs', 15000));
      if (!response.ok) {
        const authorization = officialAuthorization(response.stdout + '\n' + response.stderr);
        if (authorization) await writeJson(planPath(config, 'tailscale'), { ...plan, authorization });
        return view('tailscale', authorization ? 'needs-authorization' : 'unavailable', { authorizationAvailable: Boolean(authorization) });
      }
      const installed = await tailscaleMapping(config, plan.port);
      if (installed.state !== 'configured' || installed.nodeId !== plan.nodeId || !installed.background) return view('tailscale', 'mapping-unconfirmed');
      owner = 'summon';
      created = true;
    }
    const entry = { origin: plan.origin, owner, port: plan.port, nodeId: plan.nodeId, target: plan.target };
    const probe = await probeRoute(config, 'tailscale', plan.origin);
    if (!probe.reachable) {
      if (created && !sameMapping) await removeTailscaleMapping(config, entry);
      return view('tailscale', 'unreachable', { origin: plan.origin, registered: false, error: probe });
    }
    entries.tailscale = entry;
    return view('tailscale', 'registered', { origin: plan.origin, owner, reachable: true });
  });
  if (result.state === 'registered' && !sameMapping && previous?.owner === 'summon') {
    try { await removeTailscaleMapping(config, previous); }
    catch (error) { result.cleanupPending = error.message; }
  }
  return result;
}

async function writeTunnelToken(path, token) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, token, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function applyCloudflare(config, plan, entries, token) {
  if (token != null && token !== '' && (typeof token !== 'string' || !token.trim() || Buffer.byteLength(token) > 8192 || /[\x00-\x1f\x7f]/.test(token))) {
    throw new Error('请通过隐藏输入提交有效的隧道令牌。');
  }
  const path = tunnelTokenPath(config.dataRoot), previous = entries.cloudflare;
  const wasManaged = previous?.owner === 'summon';
  const managed = plan.owner === 'summon';
  const launch = () => launchService(config, 'cloudflared', { timeoutMs: budget(config, 'cloudflare', 'startupTimeoutMs', 10000) });
  const oldToken = managed ? await readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; }) : null;
  if (managed && !token && (!wasManaged || !oldToken)) throw new Error('请通过私有文件或隐藏输入提供隧道令牌。');
  let rotated = false, started = false, stopped = false, committed = false;
  try {
    const result = await verifyRemoteCandidate(config.dataRoot, entries, plan, async () => {
      if (managed) {
        if (token) {
          await stopService(config, 'cloudflared');
          stopped = wasManaged;
          await writeTunnelToken(path, token + '\n');
          rotated = true;
        }
        try { await launch(); started = true; }
        catch { return view('cloudflare', 'connector-unavailable', { owner: plan.owner, origin: plan.origin }); }
      }
      const deadline = Date.now() + budget(config, 'cloudflare', 'routeTimeoutMs', 10000);
      let probe;
      do {
        probe = await probeRoute(config, 'cloudflare', plan.origin);
        if (probe.reachable || !managed) break;
        await pause(750);
      } while (Date.now() < deadline);
      if (probe.reachable && wasManaged && !managed) {
        await stopService(config, 'cloudflared');
        stopped = true;
        probe = await probeRoute(config, 'cloudflare', plan.origin);
      }
      if (!probe.reachable) return view('cloudflare', managed ? 'waiting-connector' : 'unreachable',
        { owner: plan.owner, origin: plan.origin, registered: false, error: probe });
      entries.cloudflare = { origin: plan.origin, owner: plan.owner, target: plan.target };
      return view('cloudflare', 'reachable', { origin: plan.origin, owner: plan.owner, registered: true, reachable: true });
    });
    committed = result.state === 'reachable';
    if (committed && wasManaged && !managed) {
      await rm(path, { force: true }).catch(error => { result.cleanupPending = error.message; });
    }
    return result;
  } finally {
    if (!committed) {
      if (rotated || started && !wasManaged) await stopService(config, 'cloudflared');
      if (rotated && oldToken) await writeTunnelToken(path, oldToken);
      else if (rotated) await rm(path, { force: true });
      if (stopped && wasManaged) await launch();
    }
  }
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
      } else await removeTailscaleMapping(config, entry);
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
