import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { inspectService, stopService } from './system.mjs';
import { inspectServiceLock } from './service-lock.mjs';
import { advanceInstallation, writeInstallationState } from './installation-state.mjs';

const failure = (message, code = 'INSTALLATION_DRAIN_UNAVAILABLE') => Object.assign(new Error(message), { code });
const stoppedDrain = state => ({
  started_calls: state.drain?.started_calls || [],
  active: [],
  ready: true,
  intake_closed: true,
});

export async function installationRequest(config, service, method = 'GET', signal) {
  if (!service?.controlUrl || !['127.0.0.1', '[::1]'].includes(new URL(service.controlUrl).hostname)) {
    throw failure(`Gateway PID ${service?.pid ?? 'unknown'} has no reachable local installation control endpoint (${service?.state ?? 'unknown'})`);
  }
  if (!service.releaseRoot || resolve(service.releaseRoot) !== resolve(config.releaseRoot)) {
    throw failure(`Gateway PID ${service.pid} belongs to release ${service.releaseRoot || 'unknown'}; expected ${config.releaseRoot}`);
  }
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(new URL('/installation', service.controlUrl), {
    method,
    redirect: 'error',
    headers: { Authorization: `Bearer ${config.controlToken}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw failure(`Gateway installation control returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.bootId !== service.bootId || result.pid !== service.pid) throw failure('Gateway identity changed during installation control');
  return result;
}

export function enterDrain({ dataRoot, state }) {
  return advanceInstallation(dataRoot, state, 'draining', { cutoff: state.cutoff || new Date().toISOString() });
}

export async function finishDrain({ dataRoot, state, previous, owner, onProgress, timeoutMs = 180000, signal }) {
  if (!previous) return state;
  const deadline = Date.now() + (Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 180000);
  const sameReport = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const stopOptions = { deadline, signal, onProgress };
  let waiting;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const gateway = await owner.gateway();
    if (gateway.state === 'stopped') {
      await owner.stop(stopOptions);
      await owner.assertStopped();
      return writeInstallationState(dataRoot, { ...state, intake_closed: true, drain: stoppedDrain(state) });
    }
    if (gateway.state !== 'ready') {
      const observed = `gateway PID ${gateway.pid} (${gateway.state})`;
      if (waiting !== observed) onProgress?.({ phase: state.phase, writer: observed });
      waiting = observed;
      await pause(Math.max(0, Math.min(1500, deadline - Date.now())), undefined, { signal });
      continue;
    }
    waiting = undefined;
    const facts = await installationRequest(previous, gateway, 'POST', signal);
    if (facts.migration_id !== state.migration_id || !Array.isArray(facts.active) || typeof facts.ready !== 'boolean') {
      throw failure('The gateway has not confirmed the current installation window');
    }
    const active = facts.active.map(call => ({ kind: String(call.kind), id: String(call.id), status: String(call.status) }));
    const started = (facts.started_calls || active).map(call => ({ kind: String(call.kind), id: String(call.id) }));
    const drain = {
      started_calls: state.drain?.started_calls ?? started,
      active,
      ready: active.length === 0 && facts.ready,
      intake_closed: state.intake_closed === true && facts.intake_closed === true,
    };
    if (!sameReport(drain, state.drain)) {
      state = await writeInstallationState(dataRoot, { ...state, drain });
      onProgress?.({ phase: state.phase, drain });
    }
    if (!drain.ready) {
      await pause(Math.max(0, Math.min(2000, deadline - Date.now())), undefined, { signal });
      continue;
    }
    if (!state.intake_closed) {
      state = await writeInstallationState(dataRoot, { ...state, intake_closed: true });
      continue;
    }
    if (facts.intake_closed !== true) throw failure('The gateway did not close intake for the final stop');
    await owner.stop(stopOptions);
    await owner.assertStopped();
    return state;
  }
  const active = state.drain?.active?.map(item => `${item.kind} ${item.id} (${item.status})`).join(', ');
  throw failure(`Installation drain paused for build ${state.target_build}: ${waiting || active || 'active tasks remaining'}.`, 'INSTALLATION_DRAIN_TIMEOUT');
}

export function currentWriters(config) {
  const types = ['web', 'gateway', 'cloudflared', 'remote-bridge'];
  const passive = ['watchdog', 'remote-access-operation'];
  return {
    gateway: () => inspectService(config, 'gateway'),
    async stop({ deadline, signal, onProgress }) {
      for (const type of types) {
        signal?.throwIfAborted();
        onProgress?.({ phase: 'draining', service: type });
        await stopService(config, type, { timeoutMs: Math.max(1, deadline - Date.now()), signal });
      }
      for (const type of passive) {
        let lastOwner;
        for (;;) {
          signal?.throwIfAborted();
          const owner = await inspectServiceLock(config.dataRoot, type);
          if (!owner) break;
          if (Date.now() >= deadline) throw failure(`${type} PID ${owner.pid} is still active (${owner.state})`, 'INSTALLATION_ACTIVE_WRITER');
          if (lastOwner !== owner.pid) onProgress?.({ phase: 'draining', service: type, pid: owner.pid, state: owner.state });
          lastOwner = owner.pid;
          await pause(Math.max(0, Math.min(250, deadline - Date.now())), undefined, { signal });
        }
      }
    },
    async assertStopped() {
      for (const type of [...types, ...passive]) {
        const owner = await inspectServiceLock(config.dataRoot, type);
        if (owner) throw failure(`${type} PID ${owner.pid} still owns the service (${owner.state})`, 'INSTALLATION_ACTIVE_WRITER');
      }
    },
  };
}

export async function installationStatus(app, state, record, method) {
  const support = typeof app?.installationDrain === 'function';
  const identity = { pid: record.pid, bootId: record.bootId, supportsDrain: support };
  if (method === 'GET') return identity;
  if (!support || state?.phase !== 'draining' || resolve(state.previous_release) !== resolve(record.releaseRoot)) {
    throw failure('This gateway is not the owner of an active drain window');
  }
  const facts = await app.installationDrain(state);
  return { migration_id: state.migration_id, intake_closed: state.intake_closed === true, ...facts, ...identity };
}
