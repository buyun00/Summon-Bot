import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { installProcessLog } from '@relay/bot/process-log';
import { readJson, writeJson } from '../build/files.mjs';
import { acquireServiceLock } from './service-lock.mjs';
import { deploymentPath, inspectService, launchService, stopSystem } from './system.mjs';

const message = error => String(error.message || error).slice(0, 1000)
  .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  .replace(/\b(token|api[_-]?key|authorization|password|secret)(\s*[:=]\s*)(["']?)[^\s,;"']+\3/gi, '$1$2[redacted]');

// OS ownership prevents concurrent manual/StartupHub supervisors.
export async function watchSystem(config, { respectIntent = false } = {}) {
  const bootId = randomUUID();
  const ownership = await acquireServiceLock(config.dataRoot, 'watchdog', () => ({
    pid: process.pid, bootId, state: 'ready', releaseRoot: config.releaseRoot,
  }));
  let log, stopping = false, wake;
  const signal = () => { stopping = true; wake?.(); };
  const report = (type, details = {}) => console.log(JSON.stringify({ type, at: new Date().toISOString(), ...details }));
  const retries = new Map(), previous = new Map();
  const pause = () => new Promise(accept => {
    const timer = setTimeout(done, 5000);
    function done() { clearTimeout(timer); wake = undefined; accept(); }
    wake = done;
    if (stopping) done();
  });
  try {
    log = installProcessLog(join(config.dataRoot, 'web', 'watchdog'), config.logs, { tee: false });
    process.on('SIGINT', signal); process.on('SIGTERM', signal);
    config = await readJson(deploymentPath(config.dataRoot));
    if (!respectIntent && config.runIntent === 'stopped') {
      config = { ...config, runIntent: 'running' };
      await writeJson(deploymentPath(config.dataRoot), config);
    }
    const releaseRoot = config.releaseRoot;
    report('watchdog.started', { pid: process.pid, intervalMs: 5000 });
    while (!stopping) {
      try {
        config = await readJson(deploymentPath(config.dataRoot));
        if (config.runIntent === 'stopped') {
          // Let Stop.ps1 finish shutting down its children before the task host exits.
          const states = await Promise.all(['gateway', 'web'].map(type => inspectService(config, type)));
          if (states.some(state => state.state !== 'stopped')) { await pause(); continue; }
          report('watchdog.stopped', { reason: 'saved-stop-intent' });
          return;
        }
        if (resolve(config.releaseRoot) !== resolve(releaseRoot)) {
          report('watchdog.stopped', { reason: 'release-changed' });
          return;
        }
        for (const type of ['gateway', 'web']) {
          if (stopping) break;
          try {
            const state = await inspectService(config, type);
            if (previous.get(type) !== state.state) {
              report('watchdog.observed', { service: type, state: state.state, pid: state.pid });
              previous.set(type, state.state);
            }
            const retry = retries.get(type) || { failures: 0, next: 0, readySince: 0 };
            retries.set(type, retry);
            if (state.state === 'ready') {
              retry.readySince ||= Date.now();
              if (Date.now() - retry.readySince >= 60000) retry.failures = 0;
              continue;
            }
            retry.readySince = 0;
            // A timeout is not proof of death. Never kill or duplicate an uncertain owner.
            if (state.state !== 'stopped' || Date.now() < retry.next) continue;
            const latest = await readJson(deploymentPath(config.dataRoot));
            if (stopping || latest.runIntent === 'stopped' || latest.releaseRoot !== releaseRoot) break;
            const delayMs = Math.min(60000, 5000 * 2 ** Math.min(retry.failures++, 4));
            retry.next = Date.now() + delayMs;
            report('watchdog.restart', { service: type, attempt: retry.failures, retryDelayMs: delayMs });
            try {
              const started = await launchService(latest, type, { foreground: true, onExit: (code, signal) =>
                report('watchdog.child-exit', { service: type, code, signal }) });
              report('watchdog.recovered', { service: type, pid: started.pid });
              // Stop may have been requested while this child was becoming ready.
              const after = await readJson(deploymentPath(config.dataRoot));
              if (after.runIntent === 'stopped') { await stopSystem(after); return; }
            } finally { retry.next = Date.now() + delayMs; }
          } catch (error) {
            report('watchdog.error', { service: type, code: error.code || error.name, causeCode: error.cause?.code, message: message(error) });
          }
        }
      } catch (error) { report('watchdog.error', { code: error.code || error.name, message: message(error) }); }
      await pause();
    }
    await stopSystem(config);
    report('watchdog.stopped', { reason: 'signal' });
  } finally {
    process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
    try { log?.close(); } finally { await ownership.close(); }
  }
}
