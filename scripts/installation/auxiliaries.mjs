import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { workspaceOrigin } from '../../web/backend/origins.mjs';
import { readJson } from '../build/files.mjs';
import { bundledNode, launchService, serviceRoot } from './system.mjs';
import { readRemoteAccess, registerCustomRemote, remoteCandidate, usableRemoteAccess } from './remote-config.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';

export const tunnelTokenPath = dataRoot => join(serviceRoot(dataRoot, 'cloudflared'), 'tunnel-token');
export const cloudflareInstall = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
export const tailscaleInstall = 'https://tailscale.com/download';
const windows = process.platform === 'win32';
const connectorTimeout = (value, fallback) => Number.isSafeInteger(value) && value > 0 && value <= 300000 ? value : fallback;

export function installedBinary(name) {
  const override = process.env['SUMMON_' + name.toUpperCase() + '_BIN'];
  const executable = name + (windows ? '.exe' : '');
  const common = windows ? [join(process.env.ProgramFiles || 'C:/Program Files', name === 'tailscale' ? 'Tailscale' : 'cloudflared')]
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  const candidates = [override, ...common.map(dir => join(dir, executable))];
  if (name === 'tailscale' && process.platform === 'darwin') candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  for (const dir of (process.env.PATH || '').split(windows ? ';' : ':')) if (isAbsolute(dir)) candidates.push(join(dir, executable));
  return candidates.find(path => path && isAbsolute(path) && existsSync(path));
}

export function safeEnvironment(extra = []) {
  const names = /^(?:path|pathext|systemroot|windir|systemdrive|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|programfiles|programdata|codex_home|https?_proxy|no_proxy|all_proxy|ssl_cert_(?:file|dir)|node_extra_ca_certs)$/i;
  const selected = new Set(Array.isArray(extra) ? extra.filter(key => typeof key === 'string') : []);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.test(key) || selected.has(key)));
}

async function loopbackPort() {
  const server = createServer();
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  await new Promise(ready => server.close(ready));
  return port;
}

async function spawnAuxiliary(file, args, { env, cwd, ipc, url, discoverOrigin, startupTimeoutMs = 45000 }, onExit) {
  const child = spawn(file, args, { env, cwd, windowsHide: true, detached: discoverOrigin && !windows, stdio: ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
  let exited;
  const completion = new Promise(ready => {
    child.once('exit', () => { exited = true; ready(); });
    child.once('error', () => { exited = true; ready(); });
  });
  let originTimer;
  const originReady = discoverOrigin && new Promise((ready, reject) => {
    originTimer = setTimeout(() => reject(new Error('远程桥接脚本尚未返回可用地址。')), startupTimeoutMs);
    child.on('message', message => {
      if (message?.type === 'remote-ready') {
        try { ready(workspaceOrigin(message.origin, { httpsOnly: true })); } catch (error) { reject(error); }
      }
      if (message?.type === 'remote-error') reject(new Error(String(message.message || '远程桥接启动失败。').slice(0, 300)));
    });
    child.once('exit', () => reject(new Error('远程桥接脚本启动后退出。')));
    child.once('error', reject);
  });
  if (originReady) void originReady.catch(() => {});
  try {
    await new Promise((ready, reject) => { child.once('spawn', ready); child.once('error', reject); });
    if (discoverOrigin) url = await originReady;
  } catch (error) { if (discoverOrigin) await terminateTree(child); throw error; }
  finally { clearTimeout(originTimer); }
  if (exited) throw new Error('本机连接器启动后退出。');
  void completion.then(onExit);
  return {
    url,
    async close() {
      if (exited) return;
      if (discoverOrigin) { await terminateTree(child); await completion; return; }
      if (ipc && child.connected) child.send({ type: 'shutdown' }, () => {});
      else child.kill();
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000);
      try { await completion; } finally { clearTimeout(timer); }
    },
  };
}

export async function startAuxiliary(config, type, onExit) {
  const env = safeEnvironment(), cwd = serviceRoot(config.dataRoot, type);
  if (type === 'remote-bridge') {
    const bridge = await readJson(join(cwd, 'config.json'));
    const bridgePath = bridge.builtin === 'quick-tunnel' ? join(config.releaseRoot, 'scripts', 'installation', 'quick-tunnel.mjs') : bridge.bridgePath;
    const service = await spawnAuxiliary(bundledNode(config.releaseRoot), [bridgePath, ...(bridge.arguments || [])], {
      env: { ...safeEnvironment(bridge.environment), SUMMON_WEB_URL: 'http://127.0.0.1:' + config.web.port },
      cwd, ipc: true, discoverOrigin: true, startupTimeoutMs: connectorTimeout(bridge.startupTimeoutMs, 45000),
    }, onExit);
    try {
      const result = await registerCustomRemote(config, { ...bridge, bridgePath, origin: service.url });
      if (!result.registered) throw new Error(result.error?.message || '远程桥接未能连接当前工作区。');
      return service;
    } catch (error) { await service.close(); throw error; }
  }
  const entries = await readRemoteAccess(config.dataRoot);
  const pending = remoteCandidate(entries);
  if (entries.cloudflare?.owner !== 'summon' && !(pending?.provider === 'cloudflare' && pending.owner === 'summon')) {
    throw new Error('此 Cloudflare 隧道由外部管理。');
  }
  const file = installedBinary('cloudflared');
  if (!file) throw new Error('请在部署机安装 cloudflared。');
  const metrics = '127.0.0.1:' + await loopbackPort();
  return spawnAuxiliary(file, ['tunnel', '--no-autoupdate', '--metrics', metrics, 'run', '--token-file', tunnelTokenPath(config.dataRoot)],
    { env, cwd, url: 'http://' + metrics }, onExit);
}

export async function restoreAuxiliaries(config, report, { isClosing } = {}) {
  const entries = await usableRemoteAccess(config.dataRoot, message => report('configuration', { state: 'unavailable', message }));
  const restore = async (type, timeoutMs) => {
    if (isClosing?.()) return;
    report(type, { state: 'starting' });
    try {
      const service = await launchService(config, type, { timeoutMs, onExit: () => report(type, { state: 'stopped' }) });
      report(type, { state: service.state, pid: service.pid });
    } catch (error) {
      report(type, { state: 'unavailable', code: error.code || error.name });
    }
  };
  const restoreBridge = async () => {
    try {
      const bridge = await readJson(join(serviceRoot(config.dataRoot, 'remote-bridge'), 'config.json'));
      await restore('remote-bridge', connectorTimeout(bridge.startupTimeoutMs, 45000) + 105000);
    } catch (error) {
      report('remote-bridge', { state: 'unavailable', code: error.code || error.name });
    }
  };
  await Promise.all([
    entries.cloudflare?.owner === 'summon' && !entries.cloudflare.pending
      && restore('cloudflared', connectorTimeout(config.remoteAccess?.cloudflare?.startupTimeoutMs, 10000)),
    entries.custom?.owner === 'summon' && entries.custom.bridgePath && !entries.custom.pending && restoreBridge(),
  ]);
}
