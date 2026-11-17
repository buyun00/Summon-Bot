#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { instanceOrigin } from '../../web/backend/origins.mjs';
import { instanceProof } from '../../web/backend/instance-probe.mjs';
import { parseArgs, readJson, writeJson } from '../build/files.mjs';
import { protocolVersion } from '../../capabilities/platform/contract.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const connectionPath = root => join(root, 'desktop-connection.json');
const schemaVersion = 1;
const formalDataRoot = 'D:/Relay-Bot-data';
export const formalOrigin = 'http://127.0.0.1:8787';
const defaultProfile = () => join(process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : join(homedir(), 'Library', 'Application Support'), 'Relay');

export function remoteInstanceOrigin(address) {
  try { return instanceOrigin(address, { httpsOnly: true }); }
  catch { throw new Error('请填写已有实例的 HTTPS 地址。'); }
}

function savedOrigin(mode, origin) {
  if (mode === 'local') return process.platform === 'win32' && origin === formalOrigin ? origin : null;
  if (mode !== 'remote') return null;
  try { return remoteInstanceOrigin(origin); } catch { return null; }
}

export async function readDesktopConnection(root) {
  let saved;
  try { saved = await readJson(connectionPath(root)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取本机实例设置。', { cause: error });
    const legacyPath = join(root, 'desktop-workspace.json');
    let legacy;
    try { legacy = await readJson(legacyPath); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('无法读取本机原有连接设置。', { cause: error });
    }
    const selection = legacy?.schemaVersion === schemaVersion ? legacy.selection : legacy;
    const origin = savedOrigin(selection?.mode, selection?.origin);
    if (!origin && selection !== null) throw new Error('本机原有连接设置无法识别。');
    const value = origin ? { mode: selection.mode, origin } : null;
    await saveDesktopConnection(root, value);
    await unlink(legacyPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return value;
  }
  if (saved?.schemaVersion !== schemaVersion) throw new Error('本机实例设置格式无法识别。');
  if (saved.connection === null) return null;
  const origin = savedOrigin(saved.connection?.mode, saved.connection?.origin);
  if (!origin) throw new Error('本机实例地址无效。');
  return { mode: saved.connection.mode, origin };
}

export async function saveDesktopConnection(root, connection) {
  try { await writeJson(connectionPath(root), { schemaVersion, connection }); }
  catch { throw new Error('无法保存本机实例设置。请检查应用配置目录是否可写。'); }
}

export async function formalDeployment(requested) {
  if (process.platform !== 'win32') throw new Error('请通过 HTTPS 连接已有实例。');
  if (requested && (typeof requested !== 'string' || relative(formalDataRoot, requested))) throw new Error('请使用本机正式实例的数据目录。');
  let config;
  try { config = await readJson(join(formalDataRoot, 'config', 'deployment.json')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('这台电脑没有正式实例的部署配置。请通过 HTTPS 连接已有实例。');
    throw new Error('无法读取本机正式实例的部署配置。');
  }
  if (typeof config?.dataRoot !== 'string' || !isAbsolute(config.dataRoot) || relative(formalDataRoot, config.dataRoot)
    || config.web?.host !== '127.0.0.1' || Number(config.web.port) !== 8787 || typeof config.web.accessToken !== 'string') {
    throw new Error('本机正式实例的部署配置与回环入口不一致。');
  }
  return config;
}

export async function formalInstanceToken(requested) {
  const { web: { accessToken } } = await formalDeployment(requested);
  const challenge = randomBytes(32).toString('base64url');
  const response = await instanceRequest(formalOrigin, '/auth/instance?challenge=' + challenge);
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.proof !== instanceProof(accessToken, challenge)) {
    throw new Error('本机入口未连接到部署配置对应的正式实例。请确认正式服务状态后重试。');
  }
  return accessToken;
}

export function bearerHeader(token) {
  if (typeof token !== 'string' || !token || token.length > 512 || /[^\x21-\x7e]/.test(token)) {
    throw new Error('请输入有效的实例访问令牌。');
  }
  return { Authorization: 'Bearer ' + token };
}

export async function instanceRequest(origin, path, options = {}, timeout = 10000) {
  try {
    return await fetch(new URL(path, origin), {
      ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? '实例请求超时。'
      : origin === formalOrigin ? '无法连接本机正式实例。请确认正式服务已启动后重试。'
      : '无法连接该实例。请检查 HTTPS 地址和网络后重试。';
    throw new Error(message, { cause: error });
  }
}

export function loginRequired() {
  return Object.assign(new Error('实例登录已失效，请重新连接该实例。'), { code: 'INSTANCE_LOGIN_REQUIRED' });
}

export async function instanceBootstrap(origin, headers) {
  const response = await instanceRequest(origin, '/api/bootstrap', { headers });
  if (response.status === 401) throw loginRequired();
  if (response.status === 404 || response.status === 426) throw new Error('等待正式实例升级到兼容版本。');
  if (response.status === 503) throw new Error('正式实例正在更新，请稍后重试。');
  if (!response.ok) throw new Error(`无法读取正式实例状态（HTTP ${response.status}）。`);
  const status = await response.json().catch(() => null);
  if (status?.protocolVersion !== protocolVersion) throw new Error('等待正式实例升级到兼容版本。');
  if (status.updating) throw new Error('正式实例正在更新，请稍后重试。');
  return status;
}

export async function desktopCommand(command, input = {}, { profileRoot = defaultProfile(), releaseRoot = packageRoot } = {}) {
  const root = resolve(profileRoot);
  if (command === 'access') {
    const config = await formalDeployment(input.dataRoot);
    const { applyRemote, prepareRemote, remoteStatus, revokeRemote } = await import('./remote-access.mjs');
    if (input.action === 'status') return remoteStatus(config, input.provider);
    if (input.action === 'prepare') return prepareRemote(config, input.provider, input);
    if (input.action === 'apply') return applyRemote(config, input.provider, input);
    if (input.action === 'revoke') return revokeRemote(config, input.provider, input);
    throw new Error('未知的本机设置操作。');
  }
  let selection;
  if (command !== 'status') {
    if (!['local', 'remote'].includes(command)) throw new Error('未知的桌面命令。');
    const local = command === 'local';
    const origin = local ? formalOrigin : remoteInstanceOrigin(input.address);
    await instanceBootstrap(origin, bearerHeader(local ? await formalInstanceToken(input.dataRoot) : input.token));
    selection = { mode: command, origin };
    await saveDesktopConnection(root, selection);
  } else {
    selection = await readDesktopConnection(root);
  }
  const manifest = await readJson(join(releaseRoot, 'release-manifest.json')).catch(() => null);
  return {
    ...(selection || { mode: 'unselected', origin: null }),
    ...(manifest ? { version: manifest.version, buildId: manifest.buildId, sourceCommit: manifest.sourceCommit, runtime: manifest.runtime }
      : { manifestWarning: '无法读取桌面内嵌运行时版本。' }),
  };
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
    console.log('summon status | local [--data-root PATH] | remote --address HTTPS --token-file PATH|-\n'
      + 'summon access status|prepare|apply|revoke cloudflare|tailscale [--origin HTTPS] [--owner external|summon] [--port PORT] [--plan ID --confirm] [--token-file PATH|-]');
    return;
  }
  const file = options['token-file'];
  let token;
  if (!options.stdin && file) {
    try { token = (file === '-' ? await readStdin() : await readFile(resolve(file), 'utf8')).trim(); }
    catch { throw new Error('无法读取访问令牌输入。'); }
  }
  const input = options.stdin ? JSON.parse(await readStdin()) : {
    action, provider, dataRoot: options['data-root'], address: options.address,
    origin: options.origin, owner: options.owner, port: options.port, planId: options.plan, confirm: options.confirm === true, token,
  };
  const result = await desktopCommand(command, input, { profileRoot: options['profile-root'] });
  console.log(JSON.stringify(result));
  if (['missing', 'needs-login', 'needs-https', 'needs-authorization', 'unavailable', 'unreachable', 'conflict', 'mapping-unconfirmed',
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
