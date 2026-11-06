import { readFile, writeFile, mkdir, readdir, copyFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { setTimeout as pause } from 'node:timers/promises';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ACCEPTANCE_ROOT?.includes('summon-acceptance')) {
  throw new Error('This harness may run only in its disposable GitHub runner.');
}
const root = process.env.ACCEPTANCE_ROOT, install = process.env.SUMMON_INSTALL_ROOT;
const windows = process.platform === 'win32';
if (!windows || !install) throw new Error('Round 2 requires the actual installed Windows candidate package.');
const release = install ? join(install, 'resources/summon-runtime') : join(root, 'release'), data = join(root, 'data');
const node = join(release, 'runtime', windows ? 'node.exe' : 'node'), cliFile = join(release, 'scripts/installation/cli.mjs');
const desktopCLI = join(release, 'scripts/installation/desktop.mjs');
const evidence = join(root, 'evidence'), fixtures = join(root, 'fixtures');
const base = 'http://127.0.0.1:8787', cf = 'https://acceptance-cloud.test:9443', ts = 'https://acceptance-node.acceptance.ts.net:9444';
const report = { candidate: { version: '0.3.23', build: 27, commit: '056992bec5322cd6cf65f659582da80707e0be2e', sourceRun: 42196380346 },
  scope: 'Install exact PC EXE to provide bundled backend; test Web behavior. No Electron interaction, other clients, or mobile testing.',
  environment: { platform: process.platform, arch: process.arch, node: process.version, run: process.env.GITHUB_RUN_ID },
  started: new Date().toISOString(), cases: [], modelRequests: [], operations: [] };
const secrets = new Set(), observed = [], servers = [];
let token, modelKey, config, initialRoom, initialJob, modelMode = 'reject', sequence = 0;
const readJSON = async file => JSON.parse(await readFile(file, 'utf8'));
const saveJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
function safe(value) {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) if (secret) s = s.split(secret).join('[REDACTED]');
  return s;
}
async function flush() { await writeFile(join(evidence, 'results.json'), safe(report)); }
async function checkCase(id, description, operation, level = 'actual backend / HTTP') {
  const start = Date.now();
  try {
    const detail = await operation();
    const status = detail?.status || 'PASS';
    report.cases.push({ id, description, level, status, milliseconds: Date.now() - start, detail });
    console.log(`${status} ${id}: ${description}`);
  } catch (error) {
    report.cases.push({ id, description, level, status: 'FAIL', milliseconds: Date.now() - start, error: safe(error.message) });
    console.log(`FAIL ${id}: ${safe(error.message)}`);
  }
  await flush();
}
function assert(condition, message) { if (!condition) throw new Error(message); }
function run(file, args, extra = {}) {
  return new Promise(resolve => {
    const child = execFile(file, args, { timeout: 210000, maxBuffer: 6 * 1024 * 1024, env: process.env, ...extra }, (error, stdout, stderr) => {
      let result; try { result = JSON.parse(stdout); } catch { try { result = JSON.parse(stderr); } catch {} }
      resolve({ code: error ? typeof error.code === 'number' && error.code !== 0 ? error.code : 1 : 0,
        killed: Boolean(error?.killed), signal: error?.signal, result, stdout, stderr });
    });
    child.stdin.end(extra.input || '');
  });
}
const cli = (command, args = []) => run(node, [cliFile, command, '--data-root', data, '--release-root', release, ...args]);
const control = (args, input) => run(node, [desktopCLI, ...args, '--data-root', data, '--profile-root', join(root, 'control-profile')], input ? { input } : {});
async function installedLocal() {
  const command = `""${join(install, 'summon.cmd')}" local --profile-root "${join(root, 'installed-profile')}" --data-root "${data}""`;
  return run(process.env.ComSpec, ['/d', '/s', '/c', command], { windowsVerbatimArguments: true, windowsHide: true });
}
async function serviceDiagnostics() {
  try {
    const current = await readJSON(join(data, 'config/deployment.json'));
    const { CapabilityServiceSupervisor } = await import(pathToFileURL(join(current.releaseRoot, 'capabilities/services/supervisor.mjs')));
    const supervisor = new CapabilityServiceSupervisor({ dataRoot: data, releaseRoot: current.releaseRoot });
    const services = await supervisor.list();
    return Promise.all(services.map(async service => ({ id: service.id, version: service.version, state: service.state,
      health: await supervisor.request(service.id, service.version, '/health').then(value => ({ state: value.state, activeRequests: value.activeRequests, pendingWork: value.pendingWork, draining: value.draining }), error => ({ error: error.message })) })));
  } catch (error) { return [{ error: error.message }]; }
}
async function restart(label) {
  const stop = await cli('stop');
  if (stop.code !== 0) {
    report.operations.push({ label, action: 'stop', code: stop.code, error: safe(stop.stderr), services: await serviceDiagnostics() });
  }
  const start = await cli('start'); okCLI(start);
  return { stoppedCleanly: stop.code === 0, restarted: true };
}
function okCLI(result) { assert(result.code === 0, `CLI exit ${result.code}: ${safe(result.stderr || result.stdout)}`); return result.result; }
async function api(path, body, opts = {}) {
  const headers = { ...(token && opts.auth !== false ? { Authorization: 'Bearer ' + token } : {}), ...opts.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch((opts.origin || base) + path, { method: opts.method || (body === undefined ? 'GET' : 'POST'), headers,
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(opts.timeout || 40000) });
  const text = await response.text();
  observed.push(text);
  let json; try { json = JSON.parse(text); } catch {}
  return { status: response.status, headers: response.headers, text, json };
}
function okHTTP(response) { assert(response.status >= 200 && response.status < 300, `HTTP ${response.status}: ${response.text.slice(0, 1000)}`); return response.json; }
function rawHostStatus(host) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + '/api/state', { headers: { Host: host, Authorization: 'Bearer ' + token } }, response => {
      let text = ''; response.on('data', chunk => text += chunk);
      response.on('end', () => { observed.push(text); resolve({ status: response.statusCode, sentHost: request.getHeader('host') }); });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Raw Host request timed out')));
    request.once('error', reject); request.end();
  });
}
const onboarding = () => api('/api/model-settings/onboarding').then(okHTTP);
const reply = (action, value = '') => api('/api/model-settings/onboarding/reply', { action, value }).then(okHTTP);
const advance = (step, action) => api('/api/model-settings/onboarding/advance', { step, action }).then(okHTTP);
const room = () => api('/api/rooms/room-onboarding/messages').then(okHTTP);
async function until(fn, predicate, timeout = 100000) {
  const end = Date.now() + timeout; let value;
  while (Date.now() < end) { value = await fn(); if (predicate(value)) return value; await pause(800); }
  throw new Error('Timed out waiting for expected state; last=' + safe(value && { status: value.status, step: value.step, error: value.error }));
}
async function listen(server, port) { servers.push(server); await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); }); }
const pathState = name => join(fixtures, name + '.json');
const fixture = (name, value) => saveJSON(pathState(name), value);
function summary(s) { return { status: s.status, required: s.required, step: s.step, roomId: s.roomId, error: s.error, actions: s.guide?.options?.map(o => o.action), localControl: s.guide?.localControl }; }

await mkdir(evidence, { recursive: true }); await mkdir(fixtures, { recursive: true });
await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'fake-network.mjs'), join(fixtures, 'fake-network.mjs'));
for (const provider of ['tailscale', 'cloudflared']) {
  if (windows) {
    const compiler = join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const result = await run(compiler, ['/nologo', '/target:exe', '/reference:System.Web.Extensions.dll', '/out:' + join(fixtures, provider + '.exe'), join(dirname(fileURLToPath(import.meta.url)), 'FakeNetwork.cs')]);
    assert(result.code === 0, 'Network fixture compilation failed: ' + result.stdout + result.stderr);
  } else await writeFile(join(fixtures, provider), `#!/bin/sh\nexec '${node}' '${join(fixtures, 'fake-network.mjs')}' '${provider}' "$@"\n`, { mode: 0o700 });
}
const running = { BackendState: 'Running', Self: { ID: 'fixture-node-1', DNSName: 'acceptance-node.acceptance.ts.net.' } };
const unrelated = { TCP: { '9555': { HTTPS: true } }, Web: { 'unrelated.acceptance.ts.net:9555': { Handlers: { '/other': { Proxy: 'http://127.0.0.1:9999' } } } } };
const mapping = { TCP: { ...unrelated.TCP, '9444': { HTTPS: true } }, Web: { ...unrelated.Web, 'acceptance-node.acceptance.ts.net:9444': { Handlers: { '/': { Proxy: base } } } } };
await fixture('ts-status', running); await fixture('ts-serve', unrelated); await fixture('ts-unrelated', unrelated); await fixture('ts-after', mapping); await fixture('ts-mode', { mode: 'authorize' }); await fixture('cf-mode', { mode: 'waiting' });

try {
  await checkCase('W01', 'Installed PC package metadata and summon.cmd local start', async () => {
    const manifest = await readJSON(join(release, 'release-manifest.json'));
    assert(manifest.sourceCommit === report.candidate.commit && manifest.version === report.candidate.version, 'Unexpected candidate metadata');
    const releaseVersion = await readJSON(join(release, 'release.json'));
    assert(releaseVersion.buildNumber === report.candidate.build, 'Unexpected candidate build number');
    const dependencyPaths = ['node_modules/@earendil-works/pi-agent-core/package.json', 'node_modules/@earendil-works/pi-ai/package.json', 'node_modules/@summon/bot/package.json'];
    const dependencies = dependencyPaths.map(path => ({ path, present: existsSync(join(release, path)) }));
    assert(dependencies.every(item => item.present), 'F01 persists: installed backend dependency missing');
    const installedResult = install ? okCLI(await installedLocal()) : null;
    if (!install) okCLI(await cli('init'));
    config = await readJSON(join(data, 'config/deployment.json'));
    token = config.web.accessToken; for (const v of [token, config.controlToken, config.gatewayToken]) secrets.add(v);
    modelKey = 'sk-acceptance-' + randomBytes(24).toString('hex'); secrets.add(modelKey);
    const result = okCLI(await cli('status'));
    assert(result.web?.state === 'ready' && result.gateway?.state === 'ready', 'Installed backend services not ready');
    return { command: 'installed/summon.cmd local --profile-root <temporary> --data-root <temporary>', installedMode: installedResult?.mode,
      sourceCommit: manifest.sourceCommit, buildNumber: releaseVersion.buildNumber, dependencies, buildProfile: manifest.profile, web: result.web?.state, gateway: result.gateway?.state, bundledNode: process.execPath === node };
  });
  await checkCase('W02', 'Anonymous login shell, token login, cookie authentication and assets', async () => {
    const shell = await api('/', undefined, { auth: false }), denied = await api('/api/state', undefined, { auth: false });
    assert(shell.status === 401 && shell.text.includes('type="password"'), 'Unauthenticated login shell missing: ' + shell.status);
    assert(denied.status === 401, 'Anonymous state not rejected: ' + denied.status);
    const login = await api('/auth/session', {}), cookie = login.headers.get('set-cookie');
    assert(login.status === 200 && cookie?.startsWith('summon_local_session='), 'Local login failed');
    secrets.add(cookie.split(';')[0].split('=').slice(1).join('='));
    const state = await api('/api/state', undefined, { auth: false, headers: { Cookie: cookie.split(';')[0] } });
    assert(state.status === 200, 'Session cookie does not authenticate');
    const app = await api('/'); assert(app.status === 200 && app.text.includes('app.js'), 'App HTML unavailable');
    const assets = {};
    for (const path of ['/app.js', '/onboarding.js', '/onboarding.css', '/models.js', '/style.css']) {
      const r = await api(path); assets[path] = r.status; assert(r.status === 200 && r.text.length > 100, path + ' unavailable');
    }
    return { shell: shell.status, anonymousState: denied.status, cookieState: state.status, cookieFlags: cookie.split(';').slice(1), assets,
      initial: summary(state.json.onboarding) };
  });
  await checkCase('W03', 'Fresh workspace has pending welcome and Codex disabled', async () => {
    const s = await onboarding(), codex = okCLI(await control(['codex', 'status']));
    assert(s.status === 'pending' && s.required === true && !s.configured, 'Fresh onboarding not pending/unconfigured');
    assert(codex.enabled === false && codex.status === 'pending', 'Codex unexpectedly connected');
    const premature = await api('/api/model-settings/onboarding/start', {});
    assert(premature.status === 409, 'Starting without a model should fail 409');
    return { onboarding: summary(s), codex, noModelStart: premature.status };
  });

  const model = httpServer(async (req, res) => {
    try {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const body = JSON.parse(bytes || '{}');
      const seq = ++sequence;
      report.modelRequests.push({ sequence: seq, path: req.url, model: body.model, stream: body.stream, mode: modelMode,
        messages: body.messages?.length, tools: body.tools?.length, authenticated: req.headers.authorization === 'Bearer ' + modelKey });
      if (modelMode === 'reject' || modelMode === 'quota') {
        res.writeHead(modelMode === 'reject' ? 401 : 429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: modelMode === 'reject' ? 'Acceptance fixture authorization rejected' : 'Acceptance fixture quota exhausted', type: modelMode === 'reject' ? 'authentication_error' : 'insufficient_quota', code: modelMode === 'reject' ? 'invalid_api_key' : 'insufficient_quota' } }));
      }
      const content = modelMode === 'empty' ? '' : 'ROUND2_PI_REPLY：你好，欢迎使用 Summon Bot。你最想先用它做什么？';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const common = { id: 'acceptance-' + seq, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
        res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } }) + '\n\n');
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'acceptance-' + seq, object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 } }));
    } catch { res.writeHead(500); res.end('fixture failed'); }
  });
  await listen(model, 18999);
  await checkCase('W04', 'Script API provider/endpoint/protocol/model and secret-safe hidden key step', async () => {
    const phases = [];
    for (const [a, v] of [['hello',''], ['api',''], ['provider','openai-compatible'], ['endpoint','http://127.0.0.1:18999/v1'], ['protocol','openai-completions'], ['model','acceptance-model']]) {
      const result = await reply(a, v); phases.push({ action: a, phase: result.phase });
      if (a === 'model') assert(result.input === 'password' && result.phase === 'key', 'Key step not password');
    }
    const before = await api('/api/rooms'); assert(!before.json.rooms.some(r => r.id === 'room-onboarding'), 'Script stage created real room prematurely');
    const restartResult = await restart('key-step');
    const restored = await reply('hello'); assert(restored.phase === 'key' && restored.draft.model === 'acceptance-model', 'Script/key step not restored after restart');
    const result = await reply('key', modelKey); assert(result.phase === 'ready', 'Key save did not produce ready step');
    assert(!JSON.stringify(result).includes(modelKey), 'Key leaked into script reply');
    const state = await onboarding(); assert(state.configured === true, 'Saved model not configured');
    return { phases, resumedPhase: restored.phase, savedPhase: result.phase, configured: state.configured, scriptRoomAbsent: true, restartResult };
  });
  await checkCase('W05', 'Real Pi authorization rejection is recoverable and duplicate handoff is deduplicated', async () => {
    const starts = await Promise.all([reply('handoff'), reply('handoff'), reply('handoff')]);
    const s = await until(onboarding, value => value.status === 'failed');
    const r = await room(), user = r.messages.filter(m => m.clientId === 'summon-onboarding-start');
    assert(user.length === 1 && r.jobs.length === 1, 'Duplicate initial handoff created duplicate triggers/jobs');
    assert(report.modelRequests.some(r => r.mode === 'reject'), 'No actual model HTTP request occurred');
    initialRoom = s.roomId; initialJob = r.jobs[0].id;
    const progress = await reply('progress');
    assert(progress.options?.some(o => o.action === 'handoff') && progress.options?.some(o => o.action === 'choose'), 'Failure does not offer retry/change model');
    return { starts: starts.map(r => r.phase), state: summary(s), roomId: initialRoom, triggerCount: user.length,
      jobs: r.jobs.map(j => ({ id: j.id, status: j.status, agentRunId: j.agentRunId })), failureActions: progress.options.map(o => o.action) };
  });
  await checkCase('W06', 'Failure survives restart and retry yields an actual Pi response in the same trigger/room', async () => {
    await restart('failed-first-reply');
    const failed = await onboarding(); assert(failed.status === 'failed' && failed.roomId === initialRoom, 'Failure state/room lost on restart');
    modelMode = 'ok';
    await Promise.all([reply('handoff'), reply('handoff')]);
    const s = await until(onboarding, value => value.status === 'guiding');
    const r = await room(), response = r.messages.find(m => m.content?.includes('ROUND2_PI_REPLY') && m.kind !== 'error');
    assert(response?.senderId === s.bot.id && response.jobId, 'No actual Bot reply with associated job');
    assert(r.jobs.some(j => j.id === response.jobId && j.status === 'completed'), 'Bot reply job not completed');
    assert(s.roomId === initialRoom && r.jobs.length === 2 && r.jobs.some(j => j.retryOf === initialJob && j.messageId === r.jobs.find(x => x.id === initialJob).messageId), 'Retry does not preserve original trigger/job relationship');
    return { state: summary(s), reply: { sender: response.senderId, jobId: response.jobId, content: response.content },
      jobs: r.jobs.map(j => ({ id: j.id, status: j.status, agentRunId: j.agentRunId, retryOf: j.retryOf, messageId: j.messageId })), actualModelRequests: report.modelRequests.length };
  });
  await checkCase('W07', 'Refresh/cross-client start/restart reuse completed first conversation', async () => {
    const before = await room(); await Promise.all([reply('hello'), reply('progress'), api('/api/model-settings/onboarding/start', {}).then(okHTTP)]);
    await restart('completed-first-reply');
    const after = await room(), s = await onboarding(), rooms = okHTTP(await api('/api/rooms'));
    assert(s.status === 'guiding' && s.roomId === initialRoom, 'Guidance state not resumed');
    assert(before.messages.length === after.messages.length && before.jobs.length === after.jobs.length, 'Reopen duplicated messages/jobs');
    assert(rooms.rooms.filter(r => r.id === 'room-onboarding').length === 1, 'Duplicate onboarding room');
    return { state: summary(s), messagesBefore: before.messages.length, messagesAfter: after.messages.length, jobs: after.jobs.length };
  });
  await checkCase('W08', 'Structured ordinary-chat step advances only after a real user message', async () => {
    let s = await advance('intent', 'chat'); assert(s.step === 'chat' && !s.guide.options.some(o => o.action === 'next'), 'Chat step advances before user message');
    const payload = { clientId: 'acceptance-user-chat-1', toBotId: s.bot.id, content: '这是网页端验收的第一条普通消息。' };
    await Promise.all([api('/api/rooms/room-onboarding/messages', payload).then(okHTTP), api('/api/rooms/room-onboarding/messages', payload).then(okHTTP)]);
    await until(room, r => r.messages.some(m => m.content?.includes('ROUND2_PI_REPLY') && m.replyTo === r.messages.find(x => x.clientId === payload.clientId)?.id));
    const r = await room(); assert(r.messages.filter(m => m.clientId === payload.clientId).length === 1, 'Double post duplicated message');
    s = await onboarding(); assert(s.guide.options.some(o => o.action === 'next'), 'Chat completion does not unlock next');
    s = await advance('chat', 'next'); assert(s.step === 'work', 'Missing work instruction step');
    s = await advance('work', 'next'); assert(s.step === 'codex', 'Missing Codex explanation step');
    return { state: summary(s), normalMessageCount: 1 };
  });
  await checkCase('W09', 'Codex remains disabled until consent; unavailable desktop stays recoverable', async () => {
    let s = await onboarding();
    if (s.step !== 'codex') { await api('/api/model-settings/onboarding/start', {}); s = await onboarding(); if (s.step === 'intent') s = await advance('intent', 'codex'); }
    const before = okCLI(await control(['codex', 'status'])); assert(!before.enabled, 'Codex enabled before consent');
    const status = await api('/api/model-settings'); assert(!status.json.executors.find(x => x.id === 'codex-desktop').enabled, 'Model state says enabled before consent');
    s = await advance('codex', 'connect-codex');
    const after = okCLI(await control(['codex', 'status']));
    assert(!after.enabled && s.step === 'codex' && s.error, 'Unavailable Codex did not remain unconnected/recoverable');
    assert(s.guide.options.some(o => o.action === 'skip'), 'No Codex skip path');
    const prepared = okCLI(await control(['codex', 'prepare', '--caller-thread-id', 'acceptance-caller', '--tools-pipe', windows ? '\\\\.\\pipe\\acceptance-missing-tools' : join(root, 'missing-tools.sock'), '--ipc-pipe', windows ? '\\\\.\\pipe\\acceptance-missing-ipc' : join(root, 'missing-ipc.sock')]));
    s = await advance('codex', 'connect-codex');
    const final = okCLI(await control(['codex', 'status'])); assert(!final.enabled, 'Missing actual sockets enabled executor');
    s = await advance('codex', 'skip'); assert(s.step === 'remote', 'Skip Codex did not lead to remote options');
    return { before, firstConsentError: after.enabled === false, prepared, afterMissingSockets: final, state: summary(s),
      realDesktop: 'MISSING: no logged-in Codex desktop/default-permission caller session in disposable runner; no actual desktop work claimed' };
  });

  await checkCase('W10', 'Remote setup is not exposed as a Web mutation and missing components are reported', async () => {
    const missing = {};
    for (const provider of ['cloudflare', 'tailscale']) {
      const r = await control(['access', 'status', provider]); missing[provider] = { code: r.code, state: r.result?.state };
    }
    const unknown = await api('/api/remote-access', { provider: 'tailscale', action: 'apply', confirm: true });
    assert(unknown.status === 404, 'Web exposes unexpected privileged remote mutation');
    let s = await advance('remote', 'cloudflare');
    assert(s.step === 'cloudflare' && s.guide.localControl.status === 'needs-local-setup' && s.guide.options.some(o => o.action === 'skip'), 'Missing local remote setup/skip state');
    s = await advance('cloudflare', 'pause'); assert(s.status === 'paused', 'Pause not persisted');
    await until(room, r => r.jobs.every(j => ['completed', 'failed', 'interrupted', 'cancelled'].includes(j.status)));
    const restartResult = await restart('remote-pause'); await api('/api/model-settings/onboarding/start', {}).then(okHTTP);
    s = await onboarding(); assert(s.step === 'cloudflare' && s.status === 'guiding', 'Remote setup pause did not resume same step');
    return { components: missing, webMutationStatus: unknown.status, state: summary(s), restartResult };
  });

  const tls = { key: await readFile(join(root, 'tls.key')), cert: await readFile(join(root, 'tls.crt')) };
  for (const port of [9443, 9444]) {
    const proxy = httpsServer(tls, (req, res) => {
      const upstream = httpRequest(base + req.url, { method: req.method, headers: { ...req.headers, 'x-forwarded-proto': 'https' } }, incoming => {
        res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.once('close', () => upstream.destroy()); req.pipe(upstream);
    });
    await listen(proxy, port);
  }
  process.env.SUMMON_TAILSCALE_BIN = join(fixtures, windows ? 'tailscale.exe' : 'tailscale');
  process.env.SUMMON_CLOUDFLARED_BIN = join(fixtures, windows ? 'cloudflared.exe' : 'cloudflared');
  await checkCase('W11', 'Cloudflare plan requires confirmation and external reuse becomes visible to Web', async () => {
    const plan = okCLI(await control(['access', 'prepare', 'cloudflare', '--origin', cf, '--owner', 'external']));
    const denied = await control(['access', 'apply', 'cloudflare', '--plan', plan.planId]);
    assert(denied.code === 1, 'Cloudflare applied without confirmation');
    const applied = okCLI(await control(['access', 'apply', 'cloudflare', '--plan', plan.planId, '--confirm']));
    assert(applied.state === 'reachable' && applied.owner === 'external', 'Controlled external HTTPS route not reachable');
    const s = await advance('cloudflare', 'check');
    assert(s.guide?.localControl?.status === 'registered' && s.guide.localControl.origin === cf, 'Web does not show registered Cloudflare state');
    return { deniedCode: denied.code, applied, web: summary(s) };
  }, 'controlled HTTPS proxy + actual local CLI and Web');
  await checkCase('W12', 'Tailscale needs-login/HTTPS authorization state, confirmation and reuse preserve unrelated mappings', async () => {
    await fixture('ts-status', { BackendState: 'NeedsLogin', AuthURL: 'https://login.tailscale.com/a/fixture' });
    const login = await control(['access', 'prepare', 'tailscale', '--port', '9444']);
    assert(login.code === 2 && login.result?.state === 'needs-login' && login.result.authorizationAvailable, 'Missing Tailscale login state not returned');
    await fixture('ts-status', { BackendState: 'Running', Self: { ID: 'fixture-node-1' } });
    const https = await control(['access', 'prepare', 'tailscale', '--port', '9444']);
    assert(https.code === 2 && https.result?.state === 'needs-https', 'Missing private HTTPS state not returned');
    await fixture('ts-status', running);
    const plan = okCLI(await control(['access', 'prepare', 'tailscale', '--port', '9444']));
    const denied = await control(['access', 'apply', 'tailscale', '--plan', plan.planId]); assert(denied.code === 1, 'Tailscale applied without confirmation');
    const auth = await control(['access', 'apply', 'tailscale', '--plan', plan.planId, '--confirm']);
    assert(auth.code === 2 && auth.result?.state === 'needs-authorization', 'HTTPS authorization wait state not returned');
    const privatePlan = await readJSON(join(data, 'config/remote-tailscale-plan.json'));
    assert(privatePlan.authorization?.startsWith('https://login.tailscale.com/'), 'No private authorization link saved');
    await fixture('ts-mode', { mode: 'ok' });
    const applied = okCLI(await control(['access', 'apply', 'tailscale', '--plan', plan.planId, '--confirm']));
    assert(applied.state === 'registered' && applied.reachable === true, 'Tailscale route not registered/reachable');
    const served = await readJSON(pathState('ts-serve')); assert(served.Web['unrelated.acceptance.ts.net:9555'], 'Unrelated Serve mapping removed');
    const reusePlan = okCLI(await control(['access', 'prepare', 'tailscale', '--port', '9444'])); assert(reusePlan.reuse === true, 'Existing mapping not reused');
    okCLI(await control(['access', 'apply', 'tailscale', '--plan', reusePlan.planId, '--confirm']));
    return { needsLogin: login.result, needsHttps: https.result, waitingAuthorization: auth.result, applied, reuse: reusePlan.reuse, unrelatedPreserved: true };
  }, 'official CLI substitute + controlled HTTPS proxy + actual local CLI');
  await checkCase('W13', 'Both registered HTTPS hosts support secure login, state and realtime SSE', async () => {
    const records = [];
    for (const origin of [cf, ts]) {
      const login = await api('/auth/session', {}, { origin, headers: { Origin: origin } });
      const cookie = login.headers.get('set-cookie');
      assert(login.status === 200 && cookie?.startsWith('__Host-summon_session=') && cookie.includes('; Secure'), 'HTTPS host login/cookie failed: ' + origin);
      secrets.add(cookie.split(';')[0].split('=').slice(1).join('='));
      const state = await api('/api/state', undefined, { origin, auth: false, headers: { Cookie: cookie.split(';')[0], Origin: origin } });
      assert(state.status === 200 && state.json.onboarding.roomId === initialRoom, 'HTTPS cookie state failed');
      const controller = new AbortController();
      const stream = await fetch(origin + '/api/stream', { headers: { Cookie: cookie.split(';')[0], Origin: origin }, signal: controller.signal });
      assert(stream.status === 200 && stream.headers.get('content-type')?.includes('text/event-stream'), 'HTTPS SSE unavailable');
      let buffer = '', observedEvent = false;
      const read = (async () => { try { for await (const part of stream.body) { buffer += Buffer.from(part).toString(); if (buffer.includes('onboarding.changed')) { observedEvent = true; break; } } } catch {} })();
      // Creating a new guide progress event exercises real upstream streaming.
      await api('/api/model-settings/onboarding/advance', { step: 'cloudflare', action: 'pause' });
      await api('/api/model-settings/onboarding/start', {});
      await Promise.race([read, pause(7000)]); controller.abort(); await read;
      assert(observedEvent, 'SSE did not forward a live onboarding.changed event');
      records.push({ origin, login: login.status, state: state.status, secureCookie: true, sse: stream.status, liveEvent: true, roomId: state.json.onboarding.roomId });
    }
    return { hosts: records, tlsValidation: 'test certificate explicitly trusted; Host preserved; no TLS verification bypass', realProviderTunnel: false };
  }, 'actual TLS HTTP/SSE over controlled local reverse proxies');
  await checkCase('W14', 'Unregistered Host, unrelated/cross-host Origin and Funnel requests are rejected', async () => {
    const results = [];
    for (const [name, opts] of [
      ['unknown-host', { rawHost: 'unregistered.invalid' }],
      ['unrelated-origin', { origin: cf, headers: { Origin: 'https://unrelated.invalid' } }],
      ['other-registered-origin', { origin: cf, headers: { Origin: ts } }],
      ['scheme-mismatch', { origin: cf, headers: { Origin: 'http://acceptance-cloud.test:9443' } }],
      ['funnel', { origin: ts, headers: { 'tailscale-funnel-request': '?1' } }],
    ]) { try { const r = opts.rawHost ? await rawHostStatus(opts.rawHost) : await api('/api/state', undefined, opts); results.push({ name, status: r.status, sentHost: r.sentHost }); } catch (error) { results.push({ name, error: error.message }); } }
    const normalized = await api('/api/state', undefined, { origin: cf, headers: { Origin: 'https://ACCEPTANCE-CLOUD.TEST:9443' } });
    assert(results.every(r => r.status === 403), 'Origin/Host rejection results: ' + JSON.stringify(results));
    assert(normalized.status === 200, 'Normalized equivalent origin rejected');
    return { results, normalizedOrigin: normalized.status };
  });
  await checkCase('W15', 'Remote waiting and registered states can be skipped/reopened in Web', async () => {
    let s = await onboarding(); if (s.step === 'cloudflare') s = await advance('cloudflare', 'next');
    assert(s.status === 'complete', 'Completed remote setup does not complete guide');
    await api('/api/model-settings/onboarding/start', {}).then(okHTTP);
    s = await advance('intent', 'remote'); s = await advance('remote', 'tailscale');
    assert(s.guide?.localControl?.origin === ts && s.guide.localControl.status === 'registered', 'Web does not show Tailscale registration');
    s = await advance('tailscale', 'pause'); assert(s.status === 'paused', 'Tailscale guidance cannot pause');
    await api('/api/model-settings/onboarding/start', {}).then(okHTTP);
    s = await advance('tailscale', 'next'); assert(s.status === 'complete', 'Tailscale guide cannot finish');
    await api('/api/model-settings/onboarding/start', {}).then(okHTTP);
    s = await advance('intent', 'skip'); assert(s.status === 'complete', 'Optional setup cannot be skipped');
    return { final: summary(s), sameRoom: s.roomId === initialRoom };
  });
  await checkCase('W16', 'Revoking owned/external remote entries preserves unrelated forwarding', async () => {
    okCLI(await control(['access', 'revoke', 'tailscale', '--confirm']));
    const served = await readJSON(pathState('ts-serve')); assert(JSON.stringify(served) === JSON.stringify(unrelated), 'Revoke altered unrelated mappings');
    const before = (await readFile(join(fixtures, 'commands.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    okCLI(await control(['access', 'revoke', 'cloudflare', '--confirm']));
    const after = (await readFile(join(fixtures, 'commands.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    assert(after.filter(x => x.provider === 'cloudflared').length === before.filter(x => x.provider === 'cloudflared').length, 'External tunnel was controlled on revoke');
    const denied = await api('/api/state', undefined, { origin: cf }); assert(denied.status === 403, 'Revoked Host still authorized');
    await fixture('ts-serve', mapping);
    const plan = okCLI(await control(['access', 'prepare', 'tailscale', '--port', '9444']));
    assert(plan.reuse && plan.owner === 'external', 'Preexisting mapping not recognized as external');
    okCLI(await control(['access', 'apply', 'tailscale', '--plan', plan.planId, '--confirm']));
    okCLI(await control(['access', 'revoke', 'tailscale', '--confirm']));
    assert(JSON.stringify(await readJSON(pathState('ts-serve'))) === JSON.stringify(mapping), 'External Serve mapping removed by revoke');
    return { ownedMappingOnlyRemoved: true, unrelatedPreserved: true, externalMappingPreserved: true, revokedHost: denied.status };
  }, 'CLI substitutes / actual ownership and Web host checks');
  await checkCase('W17', 'Managed Cloudflare connector waits and recovers without exposing token', async () => {
    const tunnelToken = randomBytes(48).toString('base64url'); secrets.add(tunnelToken);
    const tokenFile = join(root, 'private-tunnel-token'); await writeFile(tokenFile, tunnelToken, { mode: 0o600 });
    const plan = okCLI(await control(['access', 'prepare', 'cloudflare', '--origin', cf, '--owner', 'summon']));
    const wait = await control(['access', 'apply', 'cloudflare', '--plan', plan.planId, '--confirm', '--token-file', tokenFile]);
    assert(wait.code === 2 && wait.result?.state === 'waiting-connector', 'Cloudflare waiting state missing: ' + safe(wait.result));
    const pending = await readJSON(join(data, 'config/remote-access.json')); assert(pending.cloudflare.pending === true, 'Pending connector prematurely registered');
    const blocked = await api('/api/state', undefined, { origin: cf }); assert(blocked.status === 403, 'Pending host accepted');
    await fixture('cf-mode', { mode: 'ready' });
    const applied = okCLI(await control(['access', 'apply', 'cloudflare', '--plan', plan.planId, '--confirm']));
    assert(applied.state === 'reachable' && applied.owner === 'summon', 'Managed connector failed after readiness');
    okCLI(await control(['access', 'revoke', 'cloudflare', '--confirm']));
    return { waiting: wait.result, pendingHost: blocked.status, applied, tokenViaFile: true, tokenNotInCLIArguments: true };
  }, 'cloudflared process substitute / actual service ownership and HTTPS route');
  await checkCase('W18', 'Public responses and real chat history exclude submitted secrets', async () => {
    const s = await onboarding(), messages = await room(); observed.push(JSON.stringify(s), JSON.stringify(messages));
    const leaked = [];
    for (const secret of secrets) if (observed.some(text => text.includes(secret))) leaked.push('submitted credential appeared in response');
    assert(!leaked.length, leaked.join('; '));
    const scriptSecret = await api('/api/model-settings/onboarding/reply', { action: 'endpoint', value: modelKey });
    assert(scriptSecret.status >= 400 && !scriptSecret.text.includes(modelKey), 'Secret accepted or echoed in ordinary script input');
    return { inspectedResponses: observed.length, chatMessages: messages.messages.length, credentialLeakCount: 0, wrongFieldStatus: scriptSecret.status };
  });
  await checkCase('W19', 'Old unreachable address does not block a fresh authenticated Web connection', async () => {
    let oldUnreachable = false;
    try { await fetch('http://127.0.0.1:19998/api/health', { signal: AbortSignal.timeout(2000) }); } catch { oldUnreachable = true; }
    const login = await api('/auth/session', {}), state = await api('/api/state');
    assert(oldUnreachable && login.status === 200 && state.status === 200, 'New Web connection failed after old endpoint unavailable');
    return { oldUnreachable, newLogin: login.status, newState: state.status, scope: 'HTTP protocol only; mobile clients explicitly out of scope' };
  });
  await checkCase('W20', 'Explicit external-resource boundaries', async () => ({ status: 'EXTERNAL_MISSING',
    realCodex: 'Disposable runner lacks a logged-in Codex desktop, live sockets, default-permission caller and authorized actual work context.',
    realCloudflare: 'No disposable authorized published hostname/tunnel credentials supplied; existing production resources deliberately untouched.',
    realTailscale: 'No disposable authorized tailnet device, login/HTTPS authorization or second tailnet peer supplied.',
    clients: 'PC package installed to supply the backend. Electron interaction, macOS and mobile client testing excluded.',
    browser: 'No computer-use, GUI, screenshot, click or key-driving; protocol and returned frontend assets only.' }), 'coverage boundary');
} catch (error) {
  report.cases.push({ id: 'HARNESS', status: 'FAIL', error: safe(error.stack) });
} finally {
  await checkCase('W21', 'Stop all owned candidate services on disposable runner', async () => {
    let attempt = await cli('stop');
    if (attempt.code !== 0) {
      report.operations.push({ label: 'final-cleanup', action: 'stop', code: attempt.code, error: safe(attempt.stderr), services: await serviceDiagnostics() });
      await pause(3000); attempt = await cli('stop');
    }
    const stopped = okCLI(attempt), status = okCLI(await cli('status'));
    assert(status.web.state === 'stopped' && status.gateway.state === 'stopped', 'Candidate services remain running');
    return { state: stopped.state, web: status.web.state, gateway: status.gateway.state };
  });
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
  report.finished = new Date().toISOString();
  report.summary = report.cases.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {});
  await flush();
  console.log('RESULT ' + JSON.stringify(report.summary));
  // Candidate failures are evidence, not a reason to skip other cases or artifact upload.
  process.exitCode = report.cases.some(item => item.status === 'FAIL') ? 1 : 0;
}

