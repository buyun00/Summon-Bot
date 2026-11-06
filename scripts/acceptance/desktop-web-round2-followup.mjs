import { createServer, request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32' || !process.env.SUMMON_INSTALL_ROOT) throw new Error('Installed candidate on disposable Windows runner required');
const root = process.env.ACCEPTANCE_ROOT, install = process.env.SUMMON_INSTALL_ROOT;
const runtime = join(install, 'resources/summon-runtime'), node = join(runtime, 'runtime/node.exe');
const data = join(root, 'followup-data'), profile = join(root, 'followup-profile');
const report = { candidate: { commit: '056992bec5322cd6cf65f659582da80707e0be2e', version: '0.3.23', build: 27, sourceRun: 42196380346 }, run: process.env.GITHUB_RUN_ID, cases: [] };
let token, child, echo;
function assert(value, message) { if (!value) throw new Error(message); }
const json = async path => JSON.parse(await readFile(path, 'utf8'));
async function cli(command) {
  return new Promise(resolve => execFile(node, [join(runtime, 'scripts/installation/cli.mjs'), command, '--data-root', data, '--release-root', runtime], { windowsHide: true, timeout: 25000 }, (error, stdout, stderr) => {
    let result; try { result = JSON.parse(stdout); } catch {}
    resolve({ code: error?.code ?? 0, killed: Boolean(error?.killed), signal: error?.signal, result, error: stderr });
  }));
}
function raw(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, response => {
      let text = ''; response.on('data', part => text += part); response.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: response.statusCode, json, sentHost: req.getHeader('host') });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Raw HTTP timeout'))); req.once('error', reject); req.end();
  });
}
try {
  const manifest = await json(join(runtime, 'release-manifest.json'));
  assert(manifest.sourceCommit === report.candidate.commit && manifest.version === report.candidate.version, 'Wrong candidate');
  const began = Date.now();
  const timing = report.cliTiming = { wrapper: 'cmd.exe /d /s /c installed/summon.cmd local', firstOutputMs: null, stateOutputMs: null, processExitMs: null, stdioCloseMs: null };
  let output = '', stderr = '';
  const command = `""${join(install, 'summon.cmd')}" local --profile-root "${profile}" --data-root "${data}""`;
  child = spawn(process.env.ComSpec, ['/d', '/s', '/c', command], { windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', part => {
    timing.firstOutputMs ??= Date.now() - began; output += part;
    try { const state = JSON.parse(output); if (state.mode === 'local') { timing.stateOutputMs ??= Date.now() - began; timing.state = { mode: state.mode, local: state.local?.state, version: state.version }; } } catch {}
  });
  child.stderr.on('data', part => stderr += part);
  child.once('error', error => { timing.spawnError = error.message; });
  child.once('exit', (code, signal) => { timing.processExitMs = Date.now() - began; timing.exitCode = code; timing.signal = signal; });
  child.once('close', () => { timing.stdioCloseMs = Date.now() - began; });
  while (Date.now() - began < 90000 && !timing.stateOutputMs && !timing.processExitMs && !timing.spawnError) await pause(100);
  assert(timing.stateOutputMs, 'Installed CLI did not return a local state: ' + stderr.slice(0, 800));
  const config = await json(join(data, 'config/deployment.json')); token = config.web.accessToken;
  await pause(2000);
  const health = await raw('http://127.0.0.1:8787/api/state', { Authorization: 'Bearer ' + token });
  assert(health.status === 200, 'Installed backend not reachable');
  report.cases.push({ id: 'CLI', status: 'PASS', backendStatus: health.status, snapshotAtMs: Date.now() - began, timingAtReady: { ...timing } });
  echo = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ receivedHost: req.headers.host })); });
  await new Promise(resolve => echo.listen(18997, '127.0.0.1', resolve));
  const attemptedFetch = await fetch('http://127.0.0.1:18997/', { headers: { Host: 'unregistered.invalid' } }).then(r => r.json());
  const attemptedRaw = await raw('http://127.0.0.1:18997/', { Host: 'unregistered.invalid' });
  report.transport = { requestedHost: 'unregistered.invalid', fetchEcho: attemptedFetch, rawEcho: attemptedRaw.json, rawSentHost: attemptedRaw.sentHost };
  assert(attemptedRaw.json.receivedHost === 'unregistered.invalid', 'Raw transport did not send intended Host');
  const results = [];
  for (const [name, headers] of [
    ['unknown-host', { Host: 'unregistered.invalid' }],
    ['loopback-control', { Host: '127.0.0.1:8787' }],
    ['unrelated-origin', { Host: '127.0.0.1:8787', Origin: 'https://unrelated.invalid' }],
  ]) {
    const result = await raw('http://127.0.0.1:8787/api/state', { Authorization: 'Bearer ' + token, ...headers });
    results.push({ name, status: result.status, sentHost: result.sentHost, error: result.json?.error });
  }
  report.cases.push({ id: 'W14-RAW', status: results[0].status === 403 && results[1].status === 200 && results[2].status === 403 ? 'PASS' : 'FAIL', results });
} catch (error) { report.cases.push({ id: 'FOLLOWUP', status: 'FAIL', error: error.message }); }
finally {
  const stopped = await cli('stop');
  report.cleanup = { code: stopped.code, killed: stopped.killed, state: stopped.result?.state, error: stopped.code !== 0 ? stopped.error : undefined };
  await pause(1000);
  if (child && report.cliTiming?.processExitMs === null) {
    report.cliTiming.stillRunningAfterBackendStop = true;
    child.kill();
  }
  child?.stdout?.destroy(); child?.stderr?.destroy();
  echo?.closeAllConnections(); echo?.close();
  let text = JSON.stringify(report, null, 2); if (token) text = text.split(token).join('[REDACTED]');
  await writeFile(join(root, 'evidence/followup.json'), text);
  console.log(text);
  process.exitCode = report.cases.some(c => c.status === 'FAIL') || report.cleanup.code !== 0 ? 1 : 0;
}
