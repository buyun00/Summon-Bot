import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { readJson, writeJson } from '../build/files.mjs';
import { bundledNode, deploymentPath, inspectService, launchService, serviceRoot, stopService } from './system.mjs';
import { readRemoteAccess } from './remote-config.mjs';
import { desktopExecutorState } from '../../bot/src/capabilities/executor-connections.mjs';

export const codexConfigPath = dataRoot => join(serviceRoot(dataRoot, 'codex-connector'), 'config.json');
export const tunnelTokenPath = dataRoot => join(serviceRoot(dataRoot, 'cloudflared'), 'tunnel-token');
const connectorEntry = releaseRoot => join(releaseRoot, 'connectors/codex-desktop-api/src/main.js');
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

export async function inspectCodex(config) {
  const path = codexConfigPath(config.dataRoot);
  const saved = existsSync(path) ? await readJson(path) : null;
  const executor = desktopExecutorState({ dataRoot: config.dataRoot });
  const status = saved?.managed ? (await inspectService(config, 'codex-connector')).state : saved ? 'external' : 'pending';
  return { status, enabled: executor.enabled, managed: saved?.managed === true, callerConfigured: Boolean(saved?.callerThreadId),
    socketsConfigured: windows || Boolean(saved?.toolsPipe && saved?.ipcPipe), platform: process.platform };
}

export async function prepareCodex(config, input = {}) {
  const path = codexConfigPath(config.dataRoot);
  const saved = existsSync(path) ? await readJson(path) : null;
  if (saved && !saved.managed) return inspectCodex(config);
  if (saved && (await inspectService(config, 'codex-connector')).state !== 'stopped') throw new Error('请先停用 Codex 执行器，再更改本机端点。');
  const values = {};
  if (input.callerThreadId) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.callerThreadId)) throw new Error('请填写 Codex 的本机会话 ID。');
    values.callerThreadId = input.callerThreadId;
  }
  for (const field of ['toolsPipe', 'ipcPipe']) if (input[field]) {
    if (!(windows ? /^\\\\\.\\pipe\\[\w.-]+$/i.test(input[field]) : isAbsolute(input[field]))) throw new Error('请填写本机 Codex 套接字路径。');
    values[field] = input[field];
  }
  await writeJson(path, { managed: true, host: '127.0.0.1', port: await loopbackPort(),
    auth: { enabled: true, localhostBypass: false, bearerToken: randomBytes(32).toString('base64url') }, ...saved, ...values });
  return inspectCodex(config);
}

export async function ensureCodexConnector(dataRoot) {
  const config = await readJson(deploymentPath(dataRoot));
  if (!existsSync(codexConfigPath(dataRoot))) await prepareCodex(config);
  const saved = await readJson(codexConfigPath(dataRoot));
  if (!saved.managed) return { managed: false };
  if (!windows && !(saved.toolsPipe && saved.ipcPipe)) throw Object.assign(
    new Error('请在部署机填写当前 Codex 的工具端点和会话 IPC 套接字，然后重试。'), { expose: true });
  if (!saved.callerThreadId) throw Object.assign(
    new Error('请打开使用默认权限的 Codex 本机会话，并在部署机填写它的会话 ID。'), { expose: true });
  await launchService(config, 'codex-connector', { timeoutMs: 10000 });
  return { managed: true };
}

export async function stopCodexConnector(dataRoot) {
  if (!existsSync(codexConfigPath(dataRoot)) || !(await readJson(codexConfigPath(dataRoot))).managed) return;
  await stopService(await readJson(deploymentPath(dataRoot)), 'codex-connector');
}

async function spawnAuxiliary(file, args, { env, cwd, ipc, url, health }, onExit) {
  const child = spawn(file, args, { env, cwd, windowsHide: true, stdio: ipc ? ['ignore', 'ignore', 'ignore', 'ipc'] : 'ignore' });
  let exited;
  const completion = new Promise(ready => {
    child.once('exit', () => { exited = true; ready(); });
    child.once('error', () => { exited = true; ready(); });
  });
  await new Promise((ready, reject) => { child.once('spawn', ready); child.once('error', reject); });
  if (health) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (exited) throw new Error('本机连接器启动后退出。请检查端口和配置。');
      const response = await fetch(new URL(health, url), { signal: AbortSignal.timeout(500), redirect: 'error' }).catch(() => null);
      if (response?.ok) break;
      if (attempt === 39) { child.kill(); throw new Error('本机连接器未能就绪。'); }
      await pause(150);
    }
  }
  if (exited) throw new Error('本机连接器启动后退出。');
  void completion.then(onExit);
  return {
    url,
    async close() {
      if (exited) return;
      if (ipc && child.connected) child.send({ type: 'shutdown' }, () => {});
      else child.kill();
      const timer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 3000);
      try { await completion; } finally { clearTimeout(timer); }
    },
  };
}

export async function startAuxiliary(config, type, onExit) {
  const env = safeEnvironment(), cwd = serviceRoot(config.dataRoot, type);
  if (type === 'codex-connector') {
    const file = codexConfigPath(config.dataRoot);
    const connector = await readJson(file);
    if (!connector.managed || connector.host !== '127.0.0.1') throw new Error('此 Codex 连接器由外部管理。');
    return spawnAuxiliary(bundledNode(config.releaseRoot), [connectorEntry(config.releaseRoot)], {
      env: { ...env, SUMMON_DATA_ROOT: config.dataRoot, CODEX_DESKTOP_API_CONFIG: file },
      cwd, ipc: true, url: 'http://127.0.0.1:' + connector.port, health: '/healthz',
    }, onExit);
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
  if (desktopExecutorState({ dataRoot: config.dataRoot }).enabled) {
    result.codex = await ensureCodexConnector(config.dataRoot).then(() => 'enabled', () => 'unavailable');
  }
  const entry = (await readRemoteAccess(config.dataRoot)).cloudflare;
  if (entry?.owner === 'summon' && !entry.pending) {
    result.cloudflare = await launchService(config, 'cloudflared', { timeoutMs: 10000 }).then(() => 'running', () => 'unavailable');
  }
  return result;
}
