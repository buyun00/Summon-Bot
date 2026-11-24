const { existsSync, readFileSync } = require('node:fs');
const { mkdir, rename, rm } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const packagedRuntime = join(process.resourcesPath || '', 'summon-runtime');
const runtime = existsSync(join(packagedRuntime, 'scripts/installation/desktop.mjs'))
  ? packagedRuntime
  : resolve(__dirname, '..');
const desktopScript = join(runtime, 'scripts/installation/desktop.mjs');
const desktopSettings = () => import(pathToFileURL(desktopScript).href);
const setupUrl = 'summon-setup://boot/index.html';

function resolveLocalDataRootSync(profileRoot) {
  const formalDataRoot = 'D:/Relay-Bot-data';
  if (process.platform === 'win32' && existsSync(join(formalDataRoot, 'config', 'deployment.json'))) {
    return formalDataRoot;
  }
  return join(resolve(profileRoot), 'data');
}

function isFreshInstallSync(profileRoot) {
  try {
    const dataRoot = resolveLocalDataRootSync(profileRoot);
    const modelPath = join(dataRoot, 'config', 'model-connections.json');
    if (!existsSync(modelPath)) return true;
    const raw = JSON.parse(readFileSync(modelPath, 'utf8'));
    return !raw?.activeId;
  } catch {
    return true;
  }
}

function sessionCookie(origin) {
  const url = new URL(origin);
  const secure = url.protocol === 'https:';
  const port = url.port || (secure ? '443' : '80');
  const localName = port === '8787' ? 'summon_local_session' : `summon_local_session_${port}`;
  return { secure, name: secure ? '__Host-summon_session' : localName };
}

async function login(session, origin, token) {
  const { bearerHeader, instanceRequest } = await desktopSettings();
  const response = await instanceRequest(origin, '/auth/session', { method: 'POST', headers: bearerHeader(token) });
  if (response.status === 429) throw new Error('认证尝试过于频繁，请稍后重试。');
  if (response.status === 401) throw new Error('本机服务拒绝了部署配置中的访问令牌。');
  const { name, secure } = sessionCookie(origin);
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0])
    .find(value => value.startsWith(name + '='));
  const value = cookie?.slice(name.length + 1) || '';
  if (!response.ok || !/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new Error('本机服务未返回有效的登录会话。');
  try {
    await session.cookies.set({
      url: origin + '/',
      name,
      value,
      path: '/',
      secure,
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Date.now() / 1000 + 30 * 86400,
    });
  } catch {
    throw new Error('无法保存本机登录会话。');
  }
}

async function checkLogin(session, origin) {
  const { loginRequired, instanceBootstrap } = await desktopSettings();
  const { name, secure } = sessionCookie(origin);
  const cookies = await session.cookies.get({ url: origin + '/', name });
  const cookie = cookies.find(item => item.httpOnly && item.secure === secure && item.hostOnly && item.path === '/'
    && /^[A-Za-z0-9._-]{1,160}$/.test(item.value));
  if (!cookie) throw loginRequired();
  return instanceBootstrap(origin, { Cookie: name + '=' + cookie.value });
}

async function fetchOnboardingState(origin, token, protocolVersion) {
  try {
    const { bearerHeader, instanceRequest } = await desktopSettings();
    const res = await instanceRequest(origin, '/api/onboarding', {
      headers: { ...bearerHeader(token), 'X-Summon-Protocol': String(protocolVersion), Accept: 'application/json' },
    }, 4000);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureRuntimeDependencies(onProgress) {
  const archive = join(runtime, 'node_modules.tar');
  const target = join(runtime, 'node_modules');
  if (existsSync(target) || !existsSync(archive)) return;
  onProgress?.({ stage: 'extract' });
  const stageDir = join(runtime, '.node_modules_extracting');
  await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(stageDir, { recursive: true });
  await new Promise((resolveDone, rejectDone) => {
    const child = spawn('tar', ['-xf', archive, '-C', stageDir], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', err => rejectDone(new Error(`解压运行组件失败：${err.message}`)));
    child.once('close', code => {
      if (code === 0) resolveDone();
      else rejectDone(new Error(`解压运行组件失败（exit ${code}）：${stderr.trim().slice(0, 200)}`));
    });
  });
  await rename(join(stageDir, 'node_modules'), target);
  await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  await rm(archive, { force: true }).catch(() => {});
}

async function prepareLocalConnection(session, profileRoot, onProgress) {
  await ensureRuntimeDependencies(onProgress);
  const { ensureLocalRunning, resolveLocalDataRoot } = await desktopSettings();
  const dataRoot = resolveLocalDataRoot(undefined, profileRoot);
  const { config, origin } = await ensureLocalRunning({ dataRoot, releaseRoot: runtime, onProgress });
  onProgress?.({ stage: 'connect' });
  let bootstrap;
  try {
    bootstrap = await checkLogin(session, origin);
  } catch (error) {
    if (error.code !== 'INSTANCE_LOGIN_REQUIRED') throw error;
    await login(session, origin, config.web.accessToken);
    bootstrap = await checkLogin(session, origin);
  }
  const onboarding = await fetchOnboardingState(origin, config.web.accessToken, bootstrap?.protocolVersion || 3);
  const needsIntro = Boolean(onboarding && onboarding.status === 'awaiting_model' && !onboarding.hasActiveModel);
  return { mode: 'local', origin, dataRoot: config.dataRoot, onboarding, needsIntro };
}

async function resolveLogsRoot(profileRoot) {
  const { resolveLocalDataRoot } = await desktopSettings();
  return join(resolveLocalDataRoot(undefined, profileRoot), 'web', 'logs');
}

module.exports = { runtime, setupUrl, desktopSettings, isFreshInstallSync, prepareLocalConnection, resolveLogsRoot };
