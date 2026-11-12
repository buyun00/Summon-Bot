const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const runtime = join(process.resourcesPath, 'summon-runtime');
const node = join(runtime, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const desktopScript = join(runtime, 'scripts/installation/desktop.mjs');
const desktopSettings = () => import(pathToFileURL(desktopScript).href);
const setupUrl = 'summon-setup://workspace/index.html';

function localAccess(profile, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [desktopScript, 'access', '--profile-root', profile, '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new Error('本机远程访问配置无法启动。')));
    child.once('close', code => {
      try {
        const result = JSON.parse(code === 0 || code === 2 ? output : error);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch { reject(new Error('本机远程访问配置未完成。')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function sessionCookie(origin) {
  const secure = new URL(origin).protocol === 'https:';
  return { secure, name: secure ? '__Host-summon_session' : 'summon_local_session' };
}

async function login(session, origin, token, local) {
  const { bearerHeader, workspaceRequest } = await desktopSettings();
  const response = await workspaceRequest(origin, '/auth/session', { method: 'POST', headers: bearerHeader(token) });
  if (response.status === 429) throw new Error('认证尝试过于频繁，请稍后重试。');
  if (response.status === 401) throw new Error(local
    ? '本机正式实例拒绝了部署配置中的访问令牌。' : '工作区访问令牌无效。');
  const { name, secure } = sessionCookie(origin);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] || '';
  const value = cookie.startsWith(name + '=') ? cookie.slice(name.length + 1) : '';
  if (!response.ok || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new Error('该地址没有返回有效的 Summon Bot 登录会话。');
  try {
    await session.cookies.set({ url: origin + '/', name, value, path: '/', secure, httpOnly: true,
      sameSite: 'strict', expirationDate: Date.now() / 1000 + 30 * 86400 });
  } catch { throw new Error('无法保存工作区登录会话。'); }
}

async function workspaceProfiles(session, origin, createId) {
  const { loginRequired, requestWorkspaceProfiles } = await desktopSettings();
  const { name, secure } = sessionCookie(origin);
  const cookies = await session.cookies.get({ url: origin + '/', name });
  const cookie = cookies.find(item => item.httpOnly && item.secure === secure && item.hostOnly && item.path === '/'
    && /^[A-Za-z0-9._-]{1,160}$/.test(item.value));
  if (!cookie) throw loginRequired();
  return requestWorkspaceProfiles(origin, { Cookie: name + '=' + cookie.value }, createId);
}

async function prepareWorkspace(session, selection, token) {
  const local = selection.mode === 'local';
  if (!local && token) await login(session, selection.origin, token, false);
  try { return await workspaceProfiles(session, selection.origin); }
  catch (error) {
    if (!local || error.code !== 'WORKSPACE_LOGIN_REQUIRED') throw error;
    const { formalWorkspaceToken } = await desktopSettings();
    await login(session, selection.origin, await formalWorkspaceToken(), true);
    return workspaceProfiles(session, selection.origin);
  }
}

async function authorizationUrl(provider) {
  if (provider !== 'tailscale') return null;
  const { formalDeployment } = await desktopSettings();
  const config = await formalDeployment();
  const file = join(config.dataRoot, 'config', 'remote-tailscale-plan.json');
  try {
    const plan = JSON.parse(await readFile(file, 'utf8'));
    const url = new URL(plan.authorization);
    if (plan.expires > Date.now() && url.protocol === 'https:' && !url.username && !url.password
      && ['login.tailscale.com', 'controlplane.tailscale.com'].includes(url.hostname)) return url.href;
  } catch {}
  return null;
}

module.exports = { runtime, setupUrl, desktopSettings, localAccess, prepareWorkspace, workspaceProfiles, authorizationUrl };
