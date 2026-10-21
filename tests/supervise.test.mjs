import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { superviseServices } from '../scripts/installation/supervise.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
const deferred = () => { let resolve; const promise = new Promise(done => resolve = done); return { promise, resolve }; };
function unknown() { return Object.assign(new Error('Service identity could not be verified; stopped state is unknown', { cause: Object.assign(new Error('Identity timeout'), { code: 'SERVICE_HANDSHAKE_TIMEOUT' }) }), { code: 'SERVICE_IDENTITY_UNAVAILABLE' }); }

test('uncertain identity recovers in the same supervisor without shutting down or overlapping rounds', async () => {
  const signals = new EventEmitter(), events = [], recovered = deferred(); let probes = 0, active = 0, maximum = 0, stopped = 0;
  const monitoring = superviseServices({ signals, intervalMs: 5, shutdown: async () => { stopped++; }, report: event => { events.push(event); if (event.type === 'service.monitor.recovered') recovered.resolve(); }, inspect: async type => {
    if (type === 'web') return { state: 'ready' };
    maximum = Math.max(maximum, ++active); await pause(15); active--;
    if (++probes <= 3) throw unknown(); return { state: 'ready' };
  } });
  await recovered.promise; assert.equal(stopped, 0); assert.equal(maximum, 1);
  assert.deepEqual(events.map(event => event.type), ['service.monitor.warning', 'service.monitor.recovered']);
  assert.equal(events[0].error.cause.code, 'SERVICE_HANDSHAKE_TIMEOUT');
  signals.emit('SIGTERM'); await monitoring; assert.equal(stopped, 1);
  const after = probes; await pause(25); assert.equal(probes, after); assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('unreachable and repeated unknown states are retained and only state changes are reported', async () => {
  const signals = new EventEmitter(), events = [], observed = deferred(); let rounds = 0, stops = 0;
  const monitoring = superviseServices({ signals, intervalMs: 5, shutdown: async () => { stops++; }, report: event => events.push(event), inspect: async type => {
    if (type === 'web') return { state: 'ready' };
    rounds++; if (rounds >= 5) observed.resolve();
    if (rounds <= 2) return { state: 'unreachable' }; throw unknown();
  } });
  await observed.promise; await pause(0); assert.equal(stops, 0);
  assert.deepEqual(events.map(event => event.state), ['unreachable', 'unknown']);
  assert.ok(events.every(event => event.action === 'retain-and-recheck'));
  signals.emit('SIGINT'); await monitoring; assert.equal(stops, 1);
});

test('confirmed stopped rejects for the existing Hub recovery path and clears observation', async () => {
  const signals = new EventEmitter(), events = []; let calls = 0, stops = 0;
  const monitoring = superviseServices({ signals, intervalMs: 5, report: event => events.push(event), shutdown: async () => { stops++; }, inspect: async type => { calls++; return { state: type === 'web' ? 'stopped' : 'ready' }; } });
  await assert.rejects(monitoring, error => error.code === 'SERVICE_STOPPED' && error.service === 'web');
  assert.equal(stops, 0); assert.deepEqual(events.map(event => event.type), ['service.monitor.stopped']);
  const after = calls; await pause(20); assert.equal(calls, after); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('repeated stop signals wait for an active check and call original shutdown exactly once', async () => {
  const signals = new EventEmitter(), entered = deferred(), check = deferred(), closing = deferred(), events = []; let probes = 0, stops = 0;
  const monitoring = superviseServices({ signals, intervalMs: 5, report: event => events.push(event), inspect: async () => { probes++; entered.resolve(); await check.promise; throw unknown(); }, shutdown: async () => { stops++; await closing.promise; } });
  await entered.promise; signals.emit('SIGTERM'); signals.emit('SIGINT'); await pause(15); assert.equal(stops, 0);
  check.resolve(); await pause(0); assert.equal(stops, 1); assert.deepEqual(events, []);
  signals.emit('SIGTERM'); closing.resolve(); await monitoring; assert.equal(stops, 1);
  const after = probes; await pause(20); assert.equal(probes, after); assert.equal(signals.eventNames().length, 0);
});

test('shutdown errors retain their cause and remove signal handlers', async () => {
  const signals = new EventEmitter(), failure = new Error('Actual shutdown failed');
  const monitoring = superviseServices({ signals, intervalMs: 1000, inspect: async () => ({ state: 'ready' }), shutdown: async () => { throw failure; } });
  const rejected = assert.rejects(monitoring, error => error === failure); signals.emit('SIGTERM'); await rejected;
  assert.equal(signals.eventNames().length, 0);
});

test('recoverable diagnostics use stdout, redact credentials, and let the process exit normally after stop', async () => {
  const source = `import {EventEmitter} from 'node:events';import {superviseServices} from ${JSON.stringify(new URL('../scripts/installation/supervise.mjs', import.meta.url).href)};
    const signals=new EventEmitter();let count=0;
    await superviseServices({signals,intervalMs:5,shutdown:async()=>{},inspect:async type=>{
      if(type==='web')return {state:'ready'};
      if(++count===1)throw Object.assign(new Error('apiKey=sample-private-value Bearer example-token https://name:password@example.test/'),{code:'UNAVAILABLE',cause:Object.assign(new Error('socket timeout'),{code:'ETIMEDOUT'})});
      setImmediate(()=>signals.emit('SIGTERM'));return {state:'ready'};
    }});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr); assert.equal(stderr, '');
  const events = stdout.trim().split('\n').map(line => JSON.parse(line)); assert.deepEqual(events.map(event => event.type), ['service.monitor.warning', 'service.monitor.recovered']);
  assert.equal(events[0].error.cause.code, 'ETIMEDOUT'); assert.ok(!/sample-private-value|example-token|name:password/.test(stdout));
});

const windowsPowerShell = process.platform === 'win32' && join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
test('Windows PowerShell 5.1 Stop preference and merged native output survive unknown-to-ready recovery', { skip: !windowsPowerShell || !existsSync(windowsPowerShell), timeout: 15000 }, async () => {
  const source = `import {EventEmitter} from 'node:events';import {superviseServices} from ${JSON.stringify(new URL('../scripts/installation/supervise.mjs', import.meta.url).href)};
    const signals=new EventEmitter();let count=0;
    const deadline=setTimeout(()=>{process.exitCode=3;signals.emit('SIGTERM');},5000);deadline.unref();
    await superviseServices({signals,intervalMs:10,shutdown:async()=>{},inspect:async type=>{
      if(type==='web')return {state:'ready'};
      if(++count===1)throw Object.assign(new Error('Service identity could not be verified; stopped state is unknown'),{code:'SERVICE_IDENTITY_UNAVAILABLE',cause:Object.assign(new Error('Fixture handshake timeout'),{code:'SERVICE_HANDSHAKE_TIMEOUT'})});
      setImmediate(()=>signals.emit('SIGTERM'));return {state:'ready'};
    }});clearTimeout(deadline);`;
  const encodedSource = Buffer.from(source).toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $nodeSource = "await import('data:text/javascript;base64,${encodedSource}')"
    $captured = & '${process.execPath.replaceAll("'", "''")}' --input-type=module -e $nodeSource *>&1
    if ($LASTEXITCODE -ne 0) { throw "Monitor exited with $LASTEXITCODE" }
    foreach ($line in $captured) { Write-Output $line }
    Write-Output ('{"powershellVersion":"' + $PSVersionTable.PSVersion.ToString() + '","hostSurvived":true}')`;
  const child = spawn(windowsPowerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr); assert.equal(stderr, '');
  const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(events.slice(0, 2).map(event => event.type), ['service.monitor.warning', 'service.monitor.recovered']);
  assert.equal(events[0].error.cause.code, 'SERVICE_HANDSHAKE_TIMEOUT');
  assert.match(events[2].powershellVersion, /^5\.1\./); assert.equal(events[2].hostSurvived, true);
});
