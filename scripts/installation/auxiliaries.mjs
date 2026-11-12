import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { workspaceOrigin } from '../../web/backend/origins.mjs';
import { readJson, writeJson } from '../build/files.mjs';
import { bundledNode, inspectService, launchService, serviceRoot, stopService } from './system.mjs';
import { readRemoteAccess, registerCustomRemote, removeCustomRemote } from './remote-config.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';

export const tunnelTokenPath = dataRoot => join(serviceRoot(dataRoot, 'cloudflared'), 'tunnel-token');
export const cloudflareInstall = 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/';
export const tailscaleInstall = 'https://tailscale.com/download';
const windows = process.platform === 'win32';

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

export function safeEnvironment() {
  const names = /^(?:path|pathext|systemroot|windir|systemdrive|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|programfiles|programdata|code[x]_home)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => names.test(key)));
}

async function loopbackPort() {
  const server = createServer();
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  await new Promise(ready => server.close(ready));
  return port;
}

async function spawnAuxiliary(file, args, { env, cwd, ipc, url, discoverOrigin }, onExit) {
  const child = spawn(file, args, { env, cwd, windowsHide: true, detached: discoverOrigin && !windows, stdio: ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
  let exited;
  const completion = new Promise(ready => {
    child.once('exit', () => { exited = true; ready(); });
    child.once('error', () => { exited = true; ready(); });
  });
  let originTimer;
  const originReady = discoverOrigin && new Promise((ready, reject) => {
    originTimer = setTimeout(() => reject(new Error('远程桥接脚本尚未返回可用地址。')), 45000);
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
    const service = await spawnAuxiliary(bundledNode(config.releaseRoot), [bridgePath, ...bridge.arguments], {
      env: { ...env, SUMMON_WEB_URL: 'http://127.0.0.1:' + config.web.port }, cwd, ipc: true, discoverOrigin: true,
    }, onExit);
    try {
      await registerCustomRemote(config, { ...bridge, bridgePath, origin: service.url });
      return service;
    } catch (error) { await service.close(); throw error; }
  }
  const entry = (await readRemoteAccess(config.dataRoot)).cloudflare;
  if (entry?.owner !== 'summon') throw new Error('此 Cloudflare 隧道由外部管理。');
  const file = installedBinary('cloudflared');
  if (!file) throw new Error('请在部署机安装 cloudflared。');
  const metrics = '127.0.0.1:' + await loopbackPort();
  return spawnAuxiliary(file, ['tunnel', '--no-autoupdate', '--metrics', metrics, 'run', '--token-file', tunnelTokenPath(config.dataRoot)],
    { env, cwd, url: 'http://' + metrics }, onExit);
}

export async function restoreAuxiliaries(config) {
  const result = {};
  const entry = (await readRemoteAccess(config.dataRoot)).cloudflare;
  if (entry?.owner === 'summon' && !entry.pending) {
    result.cloudflare = await launchService(config, 'cloudflared', { timeoutMs: 10000 }).then(() => 'running', () => 'unavailable');
  }
  const custom = (await readRemoteAccess(config.dataRoot)).custom;
  if (custom?.owner === 'summon' && custom.bridgePath) {
    result.custom = await launchService(config, 'remote-bridge', { timeoutMs: 150000 }).then(() => 'running', () => 'unavailable');
  }
  return result;
}

export async function startRemoteBridge(config, input, { signal } = {}) {
  const args = input.arguments || [];
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new Error('桥接参数必须为字符串数组。');
  await stopService(config, 'remote-bridge');
  await writeJson(join(serviceRoot(config.dataRoot, 'remote-bridge'), 'config.json'), {
    ...(input.bridgePath ? { bridgePath: input.bridgePath } : { builtin: 'quick-tunnel' }),
    arguments: args, label: input.label || '临时远程入口', temporary: input.temporary !== false, workId: input.workId,
  });
  let run;
  try {
    run = await launchService(config, 'remote-bridge', { timeoutMs: 150000, signal });
  } catch (error) {
    if (signal?.aborted) await removeCustomRemote(config, input.workId);
    throw error;
  }
  const registered = (await readRemoteAccess(config.dataRoot)).custom;
  if (registered?.origin === run.url && registered.workId === input.workId) {
    return { provider: 'custom', state: 'reachable', reachable: true, ...registered };
  }
  return { provider: 'custom', state: 'waiting', reachable: false, origin: run.url,
    instruction: '桥接进程已保留，公网入口尚未验证成功。继续调用 check-remote 检查同一地址，DNS 暂未就绪时不要重启桥接或更换域名。' };
}

export async function checkRemoteBridge(config, workId, { signal } = {}) {
  let bridge;
  try { bridge = await readJson(join(serviceRoot(config.dataRoot, 'remote-bridge'), 'config.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (bridge.workId !== workId) return null;
  const run = await inspectService(config, 'remote-bridge');
  if (run.state !== 'ready') return { provider: 'custom', state: run.state, reachable: false };
  const bridgePath = bridge.builtin === 'quick-tunnel' ? join(config.releaseRoot, 'scripts', 'installation', 'quick-tunnel.mjs') : bridge.bridgePath;
  return registerCustomRemote(config, { ...bridge, bridgePath, origin: run.url }, { signal });
}

export async function stopRemoteBridge(config, workId) {
  let bridge;
  try { bridge = await readJson(join(serviceRoot(config.dataRoot, 'remote-bridge'), 'config.json')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (bridge.workId !== workId) return;
  await stopService(config, 'remote-bridge');
  await removeCustomRemote(config, workId);
}
