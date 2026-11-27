#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : '';
}

const stripVerbatim = value => (process.platform === 'win32' && typeof value === 'string' && value.startsWith('\\\\?\\') ? value.slice(4) : value);
const runtimeRoot = resolve(stripVerbatim(getArg('--runtime')) || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const profileRoot = getArg('--profile') ? resolve(stripVerbatim(getArg('--profile'))) : '';

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function sessionCookie(origin) {
  const url = new URL(origin);
  const secure = url.protocol === 'https:';
  const port = url.port || (secure ? '443' : '80');
  const localName = port === '8787' ? 'summon_local_session' : `summon_local_session_${port}`;
  return { secure, name: secure ? '__Host-summon_session' : localName };
}

async function ensureRuntimeDependencies() {
  const archive = join(runtimeRoot, 'node_modules.tar');
  const target = join(runtimeRoot, 'node_modules');
  if (!existsSync(archive)) return;
  emit({ event: 'progress', stage: 'extract' });
  const stageDir = join(runtimeRoot, '.node_modules_extracting');
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
  await rm(target, { recursive: true, force: true }).catch(() => {});
  await rename(join(stageDir, 'node_modules'), target);
  await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  await rm(archive, { force: true }).catch(() => {});
}

async function main() {
  const desktopScript = join(runtimeRoot, 'scripts/installation/desktop.mjs');
  const {
    ensureLocalRunning,
    stopLocalInstance,
    resolveLocalDataRoot,
    bearerHeader,
    instanceRequest,
    instanceBootstrap,
  } = await import(pathToFileURL(desktopScript).href);

  const dataRoot = resolveLocalDataRoot(undefined, profileRoot || undefined);

  if (args.includes('--stop-local')) {
    await stopLocalInstance({ dataRoot, releaseRoot: runtimeRoot }).catch(() => {});
    emit({ event: 'stopped' });
    process.stdout.write('', () => process.exit(0));
    return;
  }

  if (existsSync(join(runtimeRoot, 'node_modules.tar'))) {
    await stopLocalInstance({ dataRoot, releaseRoot: runtimeRoot }).catch(() => {});
    await ensureRuntimeDependencies();
  }

  const { config, origin } = await ensureLocalRunning({
    dataRoot,
    releaseRoot: runtimeRoot,
    onProgress: progress => {
      if (progress?.stage) emit({ event: 'progress', stage: progress.stage });
    },
  });

  emit({ event: 'progress', stage: 'connect' });

  const token = config.web.accessToken;
  const authRes = await instanceRequest(origin, '/auth/session', {
    method: 'POST',
    headers: bearerHeader(token),
  });
  if (authRes.status === 429) throw new Error('认证尝试过于频繁，请稍后重试。');
  if (authRes.status === 401) throw new Error('本机服务拒绝了部署配置中的访问令牌。');

  const { name: cookieName, secure } = sessionCookie(origin);
  const setCookie = authRes.headers.getSetCookie()
    .map(value => value.split(';', 1)[0])
    .find(value => value.startsWith(cookieName + '='));
  const cookieValue = setCookie?.slice(cookieName.length + 1) || '';
  if (!authRes.ok || !/^[A-Za-z0-9._-]{1,160}$/.test(cookieValue)) {
    throw new Error('本机服务未返回有效的登录会话。');
  }

  const bootstrap = await instanceBootstrap(origin, { Cookie: `${cookieName}=${cookieValue}` });

  let onboarding = null;
  try {
    const onboardingRes = await instanceRequest(origin, '/api/onboarding', {
      headers: {
        ...bearerHeader(token),
        'X-Summon-Protocol': String(bootstrap?.protocolVersion || 3),
        Accept: 'application/json',
      },
    }, 4000);
    if (onboardingRes.ok) onboarding = await onboardingRes.json();
  } catch {}

  const needsIntro = Boolean(onboarding && (
    onboarding.status === 'configuring_bot' ||
    onboarding.status === 'choosing_engine' ||
    (onboarding.status === 'awaiting_model' && !onboarding.hasActiveModel)
  ));
  const onboardingStage = onboarding?.status === 'configuring_bot'
    ? 'bot'
    : onboarding?.status === 'choosing_engine'
      ? 'engine'
      : (needsIntro ? 'model' : 'main');

  emit({
    event: 'ready',
    mode: 'local',
    origin,
    dataRoot: config.dataRoot,
    accessToken: token,
    cookieName,
    cookieValue,
    secure,
    needsIntro,
    onboardingStage,
  });
  process.stdout.write('', () => process.exit(0));
}

main().catch(error => {
  emit({ event: 'error', message: String(error?.message || error || '本机服务启动失败') });
  process.stdout.write('', () => process.exit(1));
});
