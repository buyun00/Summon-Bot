const { spawn } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const runtime = join(process.resourcesPath, 'summon-runtime');
const node = join(runtime, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const setupUrl = 'summon-setup://workspace/index.html';

function workspaceCommand(profile, command, input = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(node, [join(runtime, 'scripts/installation/desktop.mjs'), command, '--profile-root', profile, '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '', error = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { error += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', () => reject(new Error('安装包中的本机运行环境无法启动。')));
    child.once('close', code => {
      try {
        const result = JSON.parse(code === 0 || code === 2 ? output : error);
        if (result.error) reject(new Error(result.error));
        else accept(result);
      } catch { reject(new Error('本机工作区操作未完成。')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function workspaceToken(state) {
  if (state.mode !== 'local' || state.local?.state !== 'ready' || state.origin !== 'http://127.0.0.1:8787') throw new Error('请先启动本机工作区。');
  const config = JSON.parse(await readFile(join(state.local.dataRoot, 'config', 'deployment.json'), 'utf8'));
  return config.web.accessToken;
}

async function login(session, origin, token) {
  const response = await fetch(new URL('/auth/session', origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const secure = origin.startsWith('https:');
  const name = secure ? '__Host-summon_session' : 'summon_local_session';
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!response.ok || !cookie?.startsWith(name + '=')) throw new Error('工作区登录未完成，请检查访问令牌。');
  await session.cookies.set({ url: origin + '/', name, value: cookie.slice(name.length + 1), path: '/', secure, httpOnly: true,
    sameSite: 'strict', expirationDate: Date.now() / 1000 + 30 * 86400 });
}

async function codexConsent(state, enabled) {
  const token = await workspaceToken(state);
  const response = await fetch(new URL('/api/model-settings/executors/codex-desktop', state.origin), {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }), redirect: 'error', signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => null);
    throw new Error(result?.error?.message || result?.error || 'Codex 执行器暂不可用。');
  }
  return { enabled };
}

async function authorizationUrl(state, provider) {
  if (state.mode !== 'local' || !state.local?.dataRoot || provider !== 'tailscale') return null;
  const file = join(state.local.dataRoot, 'config', 'remote-tailscale-plan.json');
  try {
    const plan = JSON.parse(await readFile(file, 'utf8'));
    const url = new URL(plan.authorization);
    if (plan.expires > Date.now() && url.protocol === 'https:' && !url.username && !url.password
      && ['login.tailscale.com', 'controlplane.tailscale.com'].includes(url.hostname)) return url.href;
  } catch {}
  return null;
}

module.exports = { runtime, setupUrl, workspaceCommand, workspaceToken, login, codexConsent, authorizationUrl };
