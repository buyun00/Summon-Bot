#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceOrigin } from '../../web/backend/origins.mjs';
import { workspaceProof } from '../../web/backend/workspace-probe.mjs';
import { parseArgs, readJson, writeJson } from '../build/files.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profilePath = root => join(root, 'desktop-workspace.json');
const schemaVersion = 1;
const formalDataRoot = 'D:/Relay-Bot-data';
export const formalOrigin = 'http://127.0.0.1:8787';
const defaultProfile = () => join(process.platform === 'win32' ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  : join(homedir(), 'Library', 'Application Support'), 'Relay');
const workspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isWorkspaceId = id => typeof id === 'string' && workspaceIdPattern.test(id);

export function remoteWorkspaceOrigin(address) {
  try { return workspaceOrigin(address, { httpsOnly: true }); }
  catch { throw new Error('请填写已有实例的 HTTPS 地址。'); }
}

function savedOrigin(mode, origin) {
  if (mode === 'local') return process.platform === 'win32' && origin === formalOrigin ? origin : null;
  if (mode !== 'remote') return null;
  try { return remoteWorkspaceOrigin(origin); } catch { return null; }
}

async function readProfile(root) {
  let previous;
  try { previous = await readJson(profilePath(root)); }
  catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { schemaVersion, selection: null, pendingCreate: null };
    throw new Error('无法读取本机工作区选择。');
  }
  if (previous?.schemaVersion === schemaVersion) {
    const { selection, pendingCreate } = previous;
    const origin = savedOrigin(selection?.mode, selection?.origin);
    const pendingOrigin = savedOrigin(pendingCreate?.mode, pendingCreate?.origin);
    return {
      schemaVersion,
      selection: origin && (selection.workspaceId === null || isWorkspaceId(selection.workspaceId))
        ? { mode: selection.mode, origin, workspaceId: selection.workspaceId } : null,
      pendingCreate: pendingOrigin && isWorkspaceId(pendingCreate.id)
        ? { mode: pendingCreate.mode, origin: pendingOrigin, id: pendingCreate.id } : null,
    };
  }
  // A previously connected HTTPS instance can keep using its browser session.
  const origin = savedOrigin(previous?.mode === 'remote' ? 'remote' : null, previous?.origin);
  const migrated = { schemaVersion, selection: origin ? { mode: 'remote', origin, workspaceId: null } : null, pendingCreate: null };
  await writeProfile(root, migrated);
  return migrated;
}

async function writeProfile(root, value) {
  try { await writeJson(profilePath(root), value); }
  catch { throw new Error('无法保存本机工作区选择。请检查应用配置目录是否可写。'); }
}

export async function readWorkspaceSelection(root) {
  return (await readProfile(root)).selection;
}

export async function saveWorkspaceSelection(root, selection) {
  const profile = await readProfile(root);
  const pendingCreate = profile.pendingCreate?.origin === selection.origin ? null : profile.pendingCreate;
  await writeProfile(root, { schemaVersion, selection, pendingCreate });
}

export async function reserveWorkspaceCreation(root, { mode, origin }) {
  const profile = await readProfile(root);
  if (profile.pendingCreate?.origin === origin) return profile.pendingCreate.id;
  const id = randomUUID();
  await writeProfile(root, { ...profile, pendingCreate: { mode, origin, id } });
  return id;
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

export async function formalWorkspaceToken(requested) {
  const { web: { accessToken } } = await formalDeployment(requested);
  const challenge = randomBytes(32).toString('base64url');
  const response = await workspaceRequest(formalOrigin, '/auth/instance?challenge=' + challenge);
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.proof !== workspaceProof(accessToken, challenge)) {
    throw new Error('本机入口未连接到部署配置对应的正式实例。请确认正式服务状态后重试。');
  }
  return accessToken;
}

export function bearerHeader(token) {
  if (typeof token !== 'string' || !token || token.length > 512 || /[^\x21-\x7e]/.test(token)) {
    throw new Error('请输入有效的工作区访问令牌。');
  }
  return { Authorization: 'Bearer ' + token };
}

export async function workspaceRequest(origin, path, options = {}, timeout = 10000) {
  try {
    return await fetch(new URL(path, origin), {
      ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error(origin === formalOrigin
      ? '无法连接本机正式实例。请确认正式服务已启动后重试。'
      : '无法连接该实例。请检查 HTTPS 地址和网络后重试。');
  }
}

export function loginRequired() {
  return Object.assign(new Error('工作区登录已失效，请重新连接该实例。'), { code: 'WORKSPACE_LOGIN_REQUIRED' });
}

function workspaceSummary(item) {
  if (!isWorkspaceId(item?.id)) throw new Error('实例返回的工作区标识无效。');
  return { id: item.id, name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : '工作区' };
}

export async function requestWorkspaceProfiles(origin, headers, createId) {
  const creating = Boolean(createId);
  const response = await workspaceRequest(origin, '/api/workspace-profiles', creating
    ? { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: createId }) }
    : { headers }, creating ? 60000 : 10000);
  if (response.status === 401) throw loginRequired();
  if (response.status === 403) throw new Error('该地址拒绝了工作区请求，请检查实例的访问配置。');
  if (response.status === 429) throw new Error('认证尝试过于频繁，请稍后重试。');
  if (response.status === 404) throw new Error('该实例尚未提供工作区选择功能。请检查正式实例版本。');
  if (!response.ok) throw new Error(creating ? '工作区未能准备完成，请重试。' : '暂时无法读取工作区列表，请重试。');
  const result = await response.json().catch(() => null);
  if (creating) {
    if (result?.id !== createId) throw new Error('未收到本次创建的工作区，请重试。');
    return workspaceSummary(result);
  }
  if (!Array.isArray(result?.workspaces)) throw new Error('实例返回的工作区列表无法读取。');
  return result.workspaces.map(workspaceSummary);
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
  if (command !== 'status') {
    if (!['local', 'remote'].includes(command)) throw new Error('未知的桌面命令。');
    const local = command === 'local';
    const origin = local ? formalOrigin : remoteWorkspaceOrigin(input.address);
    try { await requestWorkspaceProfiles(origin, bearerHeader(local ? await formalWorkspaceToken(input.dataRoot) : input.token)); }
    catch (error) {
      if (error.code === 'WORKSPACE_LOGIN_REQUIRED') throw new Error('工作区访问令牌无效。');
      throw error;
    }
    await saveWorkspaceSelection(root, { mode: command, origin, workspaceId: null });
  }
  const selection = await readWorkspaceSelection(root);
  const manifest = await readJson(join(releaseRoot, 'release-manifest.json'));
  return { ...(selection || { mode: 'unselected', origin: null, workspaceId: null }),
    version: manifest.version, buildId: manifest.buildId, sourceCommit: manifest.sourceCommit, runtime: manifest.runtime };
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
