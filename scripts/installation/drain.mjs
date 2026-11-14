import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { inputRecords, operationRecords } from '../../capabilities/services/session-processes.mjs';
import { inspectService, stopService } from './system.mjs';
import { inspectServiceLock } from './service-lock.mjs';
import { advanceInstallation, writeInstallationState } from './installation-state.mjs';

const failure = (message, code = 'INSTALLATION_DRAIN_UNAVAILABLE') => Object.assign(new Error(message), { code });

export async function installationRequest(config, service, method = 'GET') {
  if (!service?.controlUrl || !['127.0.0.1', '[::1]'].includes(new URL(service.controlUrl).hostname)) {
    throw failure('The current gateway has no local installation control endpoint');
  }
  const response = await fetch(new URL('/installation', service.controlUrl), {
    method, headers: { Authorization: `Bearer ${config.controlToken}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw failure(`Gateway installation control returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.bootId !== service.bootId || result.pid !== service.pid) throw failure('Gateway identity changed during installation control');
  return result;
}

export async function enterDrain({ dataRoot, state, previous, owner }) {
  if (!previous) return advanceInstallation(dataRoot, state, 'draining', { cutoff: new Date().toISOString(), drain: { started_calls: [], active: [], ready: true } });
  const gateway = await owner.gateway();
  if (gateway.state === 'stopped') {
    if (owner.legacy) throw failure('The previous protocol stopped without leaving a drain boundary for this installation');
    await owner.assertStopped();
  } else {
    const support = await installationRequest(previous, gateway);
    if (support.supportsDrain !== true) throw failure('The running gateway cannot drain installations using its current protocol');
  }
  return advanceInstallation(dataRoot, state, 'draining', { cutoff: state.cutoff || new Date().toISOString() });
}

export async function finishDrain({ dataRoot, state, previous, owner, onProgress }) {
  if (!previous) return state;
  const sameReport = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  for (;;) {
    const gateway = await owner.gateway();
    if (gateway.state === 'stopped') {
      if (owner.legacy && !(state.intake_closed && state.drain?.ready && state.drain?.intake_closed)) {
        throw failure('The old gateway stopped before confirming that calls and receipt writers reached the cutover boundary');
      }
      if (state.intake_closed && state.drain?.ready) await owner.stop();
      await owner.assertStopped({ drained: state.drain?.intake_closed === true && state.drain.ready === true });
      return state;
    }
    if (gateway.state === 'stopping' && state.intake_closed && state.drain?.ready && state.drain.intake_closed) {
      await owner.stop();
      await owner.assertStopped({ drained: true });
      return state;
    }
    if (gateway.state !== 'ready') throw failure(`The gateway owner is ${gateway.state}; drain status remains unknown`);
    const facts = await installationRequest(previous, gateway, 'POST');
    if (facts.migration_id !== state.migration_id || !Array.isArray(facts.active) || typeof facts.ready !== 'boolean') {
      throw failure('The gateway has not confirmed the current installation window');
    }
    const active = facts.active.map(call => ({ kind: String(call.kind), id: String(call.id), status: String(call.status) }));
    const started = (facts.started_calls || active).map(call => ({ kind: String(call.kind), id: String(call.id) }));
    const drain = { started_calls: state.drain?.started_calls ?? started, active,
      ready: facts.ready && active.length === 0, intake_closed: state.intake_closed === true && facts.intake_closed === true };
    if (!sameReport(drain, state.drain)) {
      state = await writeInstallationState(dataRoot, { ...state, drain });
      onProgress?.({ phase: state.phase, drain });
    }
    if (!drain.ready) { await pause(2500); continue; }
    if (!state.intake_closed) {
      state = await writeInstallationState(dataRoot, { ...state, intake_closed: true });
      continue;
    }
    if (facts.intake_closed !== true) throw failure('The gateway did not close intake for the final stop');
    await owner.stop();
    await owner.assertStopped({ drained: true });
    return state;
  }
}

function assertNoUneventfulShutdown(dataRoot) {
  const path = join(dataRoot, 'capabilities', 'chatroom', 'state.sqlite');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const records = db.prepare('SELECT data FROM records WHERE kind=?');
    const operations = records.all(operationRecords).map(row => JSON.parse(row.data));
    const inputs = records.all(inputRecords).map(row => JSON.parse(row.data));
    const uncertain = operations.find(item => item.submitted_at && !(item.runtime_ended && item.finished_at &&
      (item.protocol !== 'codex' || item.status !== 'unknown' || !item.thread_active && !item.turn_attempted)));
    const pending = inputs.find(item => !item.migrated && !item.receipt && ['writing', 'submitted'].includes(item.status));
    if (uncertain || pending) {
      throw failure(`The stopped gateway left execution ${(uncertain || pending).id} without a final boundary. Resume the selected runtime to finish draining.`,
        'INSTALLATION_ACTIVE_WRITER');
    }
  } finally { db.close(); }
}

export function currentWriters(config) {
  const types = ['web', 'gateway', 'cloudflared', 'remote-bridge'];
  return {
    legacy: false,
    gateway: () => inspectService(config, 'gateway'),
    async stop() {
      for (const type of types) await stopService(config, type, { waitForExit: true });
      while (await inspectServiceLock(config.dataRoot, 'watchdog')) await pause(150);
    },
    async assertStopped({ drained = false } = {}) {
      for (const type of types) {
        if ((await inspectService(config, type)).state !== 'stopped') {
          throw failure(`The selected deployment still has a ${type} writer`, 'INSTALLATION_ACTIVE_WRITER');
        }
      }
      if (await inspectServiceLock(config.dataRoot, 'remote-access-operation')) {
        throw failure('A remote access configuration writer is still active', 'INSTALLATION_ACTIVE_WRITER');
      }
      if (!drained) assertNoUneventfulShutdown(config.dataRoot);
    },
  };
}

// Shared by the managed control listener and the same-protocol upgrade support.
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
