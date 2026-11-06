#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceOrigin } from '../../web/backend/origins.mjs';
import { parseArgs, readJson, within, writeJson } from '../build/files.mjs';
import { installRelease } from './install.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { deploymentPath, inspectService, startSystem, stopSystem } from './system.mjs';
import { applyRemote, prepareRemote, remoteStatus, revokeRemote } from './remote-access.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceFile = root => join(root, 'desktop-workspace.json');
const appFolder = root => join(root, 'workspace-runtime');
const fresh = () => ({ mode: 'unselected', origin: null, localDataRoot: null, ownedDataRoot: null });
const defaultProfile = () => join(process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : join(homedir(), 'Library', 'Application Support'), 'Relay');

async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function owns(config, profileRoot) {
  const releases = join(appFolder(profileRoot), 'releases');
  return config && relative(releases, config.releaseRoot) && within(releases, config.releaseRoot);
}

async function inspectWorkspace(config, profileRoot) {
  if (!config) return null;
  const [web, gateway] = await Promise.all(['web', 'gateway'].map(type => inspectService(config, type)));
  return { owner: owns(config, profileRoot) ? 'summon' : 'external', dataRoot: config.dataRoot,
    state: web.state === 'ready' && gateway.state === 'ready' ? 'ready' : web.state === 'stopped' && gateway.state === 'stopped' ? 'stopped' : 'unavailable',
    web: { state: web.state, pid: web.pid, url: web.url }, gateway: { state: gateway.state, pid: gateway.pid }, runIntent: config.runIntent };
}

function localOrigin(config, web) {
  if (config?.web?.host !== '127.0.0.1' || !web?.url) return null;
  const url = new URL(web.url);
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port || 80) === Number(config.web.port)
    ? url.origin : null;
}

async function readProfile(profileRoot, releaseRoot) {
  const profile = await optionalJson(workspaceFile(profileRoot)) || fresh();
  const config = profile.localDataRoot && await optionalJson(deploymentPath(profile.localDataRoot));
  const local = await inspectWorkspace(config, profileRoot);
  const origin = profile.mode === 'local' && local?.state === 'ready' ? localOrigin(config, local.web) : profile.origin;
  const manifest = await readJson(join(releaseRoot, 'release-manifest.json'));
  const installed = await optionalJson(join(appFolder(profileRoot), 'current.json'));
  const activeRelease = installed && await optionalJson(join(installed.releaseRoot, 'release-manifest.json'));
  const defaultDataRoot = profile.ownedDataRoot || installed?.dataRoot || join(profileRoot, 'workspace-data');
  const existingDataRoot = profile.mode === 'unselected' && await optionalJson(deploymentPath(defaultDataRoot)) ? defaultDataRoot : null;
  return { mode: profile.mode, origin, local, defaultDataRoot, existingDataRoot,
    version: manifest.version, buildId: manifest.buildId, sourceCommit: manifest.sourceCommit, runtime: manifest.runtime,
    installedVersion: activeRelease?.version || null, installedBuildId: activeRelease?.buildId || null };
}

export async function verifyWorkspace(origin, token) {
  if (!token || typeof token !== 'string' || /[\r\n]/.test(token) || token.length > 512) throw new Error('请通过隐藏输入提交工作区访问令牌。');
  const response = await fetch(new URL('/api/health', origin), {
    headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(8000),
  }).catch(() => { throw new Error('无法连接该工作区，请检查地址和网络。'); });
  if ([401, 429].includes(response.status)) throw new Error(response.status === 429 ? '认证尝试过于频繁，请稍后重试。' : '工作区访问令牌无效。');
  const health = await response.json().catch(() => null);
  if (!response.ok || health?.service !== 'summon-capabilities') throw new Error('该地址的 Summon Bot 工作区暂不可用。');
}

async function startLocal(profileRoot, releaseRoot, profile, requested, onProgress) {
  const chosen = requested || profile.localDataRoot || profile.ownedDataRoot || join(profileRoot, 'workspace-data');
  if (typeof chosen !== 'string' || !isAbsolute(chosen)) throw new Error('请填写本机数据的绝对路径。');
  const appRoot = appFolder(profileRoot);
  if (within(appRoot, chosen) || within(chosen, appRoot)) throw new Error('请为工作区数据选择独立目录。');
  await mkdir(chosen, { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(chosen);
  if (within(appRoot, dataRoot) || within(dataRoot, appRoot)) throw new Error('请为工作区数据选择独立目录。');
  let config = await optionalJson(deploymentPath(dataRoot));
  let web;
  if (config && !owns(config, profileRoot)) {
    const service = await inspectWorkspace(config, profileRoot);
    if (service.state !== 'ready') throw new Error('该工作区由外部管理。请用它原有的入口启动本机 Web 服务。');
    web = service.web;
  } else {
    const ownedRoot = profile.ownedDataRoot;
    const switching = ownedRoot && relative(ownedRoot, dataRoot);
    if (switching) {
      if (!requested || !owns(config, profileRoot)) throw new Error('请使用当前数据目录，或选择一个已创建的本机工作区。');
      await stopOwned(profileRoot, profile);
    }
    if (!ownedRoot || switching) {
      profile.ownedDataRoot = dataRoot;
      await writeJson(workspaceFile(profileRoot), profile);
    }
    const embedded = await readJson(join(releaseRoot, 'release-manifest.json'));
    const installed = config && await optionalJson(join(config.releaseRoot, 'release-manifest.json'));
    if (!installed || installed.buildId !== embedded.buildId) {
      onProgress?.({ stage: 'runtime', ratio: 0 });
      if (config && (installed || config.runIntent !== 'stopped')) await stopSystem(config);
      await installRelease({ releaseRoot, appRoot, dataRoot,
        onCopyProgress: ratio => onProgress?.({ stage: 'runtime', ratio }) });
      config = await readJson(deploymentPath(dataRoot));
    }
    if (config.web.autoPort !== true) {
      config.web.autoPort = true;
      await writeJson(deploymentPath(dataRoot), config);
    }
    ({ web } = await startSystem(config, { onProgress }));
    config = await readJson(deploymentPath(dataRoot));
  }
  const origin = localOrigin(config, web);
  if (!origin) throw new Error('本机工作区未在已配置的回环地址就绪。');
  onProgress?.({ stage: 'verify' });
  await verifyWorkspace(origin, config.web.accessToken);
  await writeJson(workspaceFile(profileRoot), { ...profile, mode: 'local', origin, localDataRoot: dataRoot });
}

async function stopOwned(profileRoot, profile) {
  if (!profile.ownedDataRoot) return;
  const config = await optionalJson(deploymentPath(profile.ownedDataRoot));
  if (owns(config, profileRoot)) await stopSystem(config);
}

export async function desktopCommand(command, input = {}, { profileRoot = defaultProfile(), releaseRoot = packageRoot, onProgress } = {}) {
  profileRoot = resolve(profileRoot);
  if (command === 'status') return readProfile(profileRoot, releaseRoot);
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const ownership = await acquireServiceLock(profileRoot, 'desktop-workspace-operation',
    () => ({ pid: process.pid, bootId: randomUUID(), state: 'working' }));
  try {
    const profile = await optionalJson(workspaceFile(profileRoot)) || fresh();
    if (command === 'new') {
      const installed = await optionalJson(join(appFolder(profileRoot), 'current.json'));
      await stopOwned(profileRoot, { ownedDataRoot: profile.ownedDataRoot || installed?.dataRoot });
      const next = join(profileRoot, 'workspaces', randomUUID());
      await startLocal(profileRoot, releaseRoot, fresh(), next, onProgress);
    } else if (command === 'local' || command === 'start' || command === 'resume') {
      if (command !== 'local' && profile.mode !== 'local') throw new Error('请先选择本机工作区。');
      const local = profile.localDataRoot && await optionalJson(deploymentPath(profile.localDataRoot));
      if (command !== 'resume' || local?.runIntent !== 'stopped') {
        await startLocal(profileRoot, releaseRoot, profile, command === 'local' ? input.dataRoot : undefined, onProgress);
      }
    } else if (command === 'remote') {
      const origin = workspaceOrigin(input.address);
      await verifyWorkspace(origin, input.token);
      if (input.stopLocal === true && profile.mode === 'local' && !relative(profile.ownedDataRoot || profileRoot, profile.localDataRoot || profileRoot)) {
        await stopOwned(profileRoot, profile);
      }
      await writeJson(workspaceFile(profileRoot), { ...profile, mode: 'remote', origin });
    } else if (command === 'stop') {
      if (profile.mode !== 'local' || !profile.ownedDataRoot || relative(profile.localDataRoot, profile.ownedDataRoot)) {
        throw new Error('当前工作区由外部管理或处于远程连接模式。');
      }
      await stopOwned(profileRoot, profile);
    } else if (command === 'access' || command === 'codex') {
      const dataRoot = input.dataRoot || (profile.mode === 'local' && profile.localDataRoot);
      if (!dataRoot) throw new Error('请先选择本机工作区，或通过 --data-root 指定部署机数据目录。');
      const config = await optionalJson(deploymentPath(dataRoot));
      if (!config) throw new Error('该数据目录尚未初始化。');
      if (command === 'codex') {
        if (!['status', 'connect', 'disconnect'].includes(input.action)) throw new Error('请选择 Codex 的 status、connect 或 disconnect。');
        const change = input.action !== 'status', enabled = input.action === 'connect';
        const origin = workspaceOrigin(`http://${config.web.host}:${config.web.port}`);
        const response = await fetch(new URL(change ? '/api/model-settings/executors/codex-cli' : '/api/model-settings', origin), {
          method: change ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + config.web.accessToken, 'Content-Type': 'application/json' },
          ...(change ? { body: JSON.stringify({ enabled, select: enabled }) } : {}), redirect: 'error', signal: AbortSignal.timeout(45000),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.error?.message || result?.error || 'Codex 执行器暂不可用。');
        const executor = result?.executors?.find(item => item.id === 'codex-cli');
        if (!executor) throw new Error('工作区尚未支持一键接入 Codex，请先更新本机工作区。');
        return executor;
      } else {
        if (input.action === 'status') return await remoteStatus(config, input.provider);
        if (input.action === 'prepare') return await prepareRemote(config, input.provider, input);
        if (input.action === 'apply') return await applyRemote(config, input.provider, input);
        if (input.action === 'revoke') return await revokeRemote(config, input.provider, input);
      }
      throw new Error('未知的本机设置操作。');
    } else throw new Error('未知的桌面命令。');
    return readProfile(profileRoot, releaseRoot);
  } finally { await ownership.close(); }
}

async function readStdin() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 32768) throw new Error('私有输入过长。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function cli() {
  const { options, positional } = parseArgs(process.argv.slice(2));
  const [command = 'status', action, provider] = positional;
  if (command === 'help' || options.help) {
    console.log('summon status | local [--data-root PATH] | remote --address URL --token-file PATH|- [--stop-local] | start | stop\n'
      + 'summon access status|prepare|apply|revoke cloudflare|tailscale [--origin HTTPS] [--owner external|summon] [--port PORT] [--plan ID --confirm] [--token-file PATH|-]\n'
      + 'summon codex status|connect|disconnect');
    return;
  }
  const file = options['token-file'];
  const token = file === '-' ? (await readStdin()).trim() : file ? (await readFile(resolve(file), 'utf8')).trim() : undefined;
  const input = options.stdin ? JSON.parse(await readStdin()) : {
    action, provider, dataRoot: options['data-root'], address: options.address, stopLocal: options['stop-local'] === true,
    origin: options.origin, owner: options.owner, port: options.port, planId: options.plan, confirm: options.confirm === true, token,
  };
  const onProgress = progress => {
    if (process.connected) process.send({ type: 'workspace-progress', progress }, () => {});
  };
  const result = await desktopCommand(command, input, { profileRoot: options['profile-root'], onProgress });
  console.log(JSON.stringify(result));
  if (['missing', 'needs-login', 'needs-https', 'needs-authorization', 'unavailable', 'conflict', 'mapping-unconfirmed',
    'connector-unavailable', 'waiting-connector'].includes(result.state)) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    const message = error.code === 'EADDRINUSE' ? '另一个本机设置操作正在执行，请稍后重试。'
      : error instanceof SyntaxError ? '无法读取本机设置。' : String(error.message || error).replace(/Bearer\s+\S+/gi, '[已隐藏]').slice(0, 300);
    console.error(JSON.stringify({ error: message, state: 'failed' }));
    process.exitCode = 1;
  });
}
