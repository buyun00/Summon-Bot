import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { inputRecords, observeExitedCodexLaunch, operationRecords, settled } from '../../capabilities/services/session-processes.mjs';
import { inspectService, stopService } from './system.mjs';
import { inspectServiceLock } from './service-lock.mjs';
import { advanceInstallation, writeInstallationState } from './installation-state.mjs';

const failure = (message, code = 'INSTALLATION_DRAIN_UNAVAILABLE') => Object.assign(new Error(message), { code });
const codexLaunchIsUnknown = item => item.kind === 'codex_turn' && item.status === 'unknown';
const hasWriterBoundary = operation => operation.runtime_ended === true && settled(operation.status) &&
  [operation.finished_at, operation.runtime_exit_observed_at, operation.recovered_at]
    .some(value => Number.isFinite(Date.parse(value)) && Date.parse(value) >= Date.parse(operation.submitted_at)) &&
  (operation.status !== 'unknown' || operation.protocol !== 'codex' || !operation.thread_active && !operation.turn_attempted);
const sameWriter = (left, right) => left.call_id === right.call_id && left.instance_id === right.instance_id &&
  left.runner_pid === right.runner_pid && left.bridge_pid === right.bridge_pid && left.submitted_at === right.submitted_at;
const stoppedDrain = (state, exited) => ({
  started_calls: state.drain?.started_calls || [], active: [], ready: true, intake_closed: true,
  ...(exited.length ? { exited_writers: exited } : {}),
});

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
    const exited = await owner.assertStopped();
    return advanceInstallation(dataRoot, state, 'draining', { cutoff: state.cutoff || new Date().toISOString(),
      intake_closed: true, drain: stoppedDrain(state, exited) });
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
      if (state.intake_closed && state.drain?.ready && state.drain.intake_closed) await owner.stop();
      const exited = await owner.assertStopped({ drain: state.drain });
      if (exited) {
        return writeInstallationState(dataRoot, { ...state, intake_closed: true, drain: stoppedDrain(state, exited) });
      }
      return state;
    }
    if (gateway.state === 'stopping' && state.intake_closed && state.drain?.ready && state.drain.intake_closed) {
      await owner.stop();
      await owner.assertStopped({ drain: state.drain });
      return state;
    }
    if (gateway.state !== 'ready') throw failure(`The gateway owner is ${gateway.state}; drain status remains unknown`);
    const facts = await installationRequest(previous, gateway, 'POST');
    if (facts.migration_id !== state.migration_id || !Array.isArray(facts.active) || typeof facts.ready !== 'boolean') {
      throw failure('The gateway has not confirmed the current installation window');
    }
    const active = facts.active.map(call => ({ kind: String(call.kind), id: String(call.id), status: String(call.status) }));
    const started = (facts.started_calls || active).map(call => ({ kind: String(call.kind), id: String(call.id) }));
    // A disappeared report can also be a real receipt or a lost observation.
    // Keep the last proof until the closed-window pass can check the store.
    const witnesses = new Map((state.drain?.exited_writers || []).map(writer => [writer.call_id, writer]));
    const observed = active.filter(codexLaunchIsUnknown).map(item => item.id);
    const exited = (await observeExitedWriters(dataRoot, [...witnesses.keys(), ...observed]))
      .filter(writer => !witnesses.has(writer.call_id) || sameWriter(writer, witnesses.get(writer.call_id)));
    for (const writer of exited) witnesses.set(writer.call_id, writer);
    const confirmed = new Set(exited.map(writer => writer.call_id));
    const actionable = active.filter(item => !codexLaunchIsUnknown(item) || !confirmed.has(item.id));
    const unconfirmed = [...witnesses.keys()].filter(id => !confirmed.has(id) && !actionable.some(item => item.id === id));
    for (const id of unconfirmed) actionable.push({ kind: 'codex_turn', id, status: 'writer_unconfirmed' });
    const drain = { started_calls: state.drain?.started_calls ?? started, active: actionable,
      ...(witnesses.size ? { exited_writers: [...witnesses.values()] } : {}),
      ready: actionable.length === 0 && (facts.ready || observed.some(id => confirmed.has(id))),
      intake_closed: state.intake_closed === true && facts.intake_closed === true };
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
    if (!await confirmWriterBoundary(dataRoot, state.drain)) { await pause(2500); continue; }
    await owner.stop();
    await owner.assertStopped({ drain: state.drain });
    return state;
  }
}

async function observeStoppedNativeWriters(dataRoot) {
  const path = join(dataRoot, 'capabilities', 'chatroom', 'state.sqlite');
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  let uncertain, pending;
  try {
    const records = db.prepare('SELECT data FROM records WHERE kind=?');
    const operations = records.all(operationRecords).map(row => JSON.parse(row.data));
    const inputs = records.all(inputRecords).map(row => JSON.parse(row.data));
    uncertain = operations.filter(item => item.submitted_at && !hasWriterBoundary(item));
    pending = inputs.find(item => !item.receipt && ['writing', 'submitted'].includes(item.status));
  } finally { db.close(); }
  const exited = await observeExitedWriters(dataRoot, uncertain.map(item => item.id));
  const confirmed = new Set(exited.map(item => item.call_id));
  const unsettled = pending || uncertain.find(item => !confirmed.has(item.id));
  if (unsettled) {
    throw failure(`The stopped gateway left execution ${unsettled.id} without a confirmed writer boundary`, 'INSTALLATION_ACTIVE_WRITER');
  }
  return exited;
}

async function observeExitedWriters(dataRoot, callIds) {
  if (!callIds.length) return [];
  const db = new DatabaseSync(join(dataRoot, 'capabilities', 'chatroom', 'state.sqlite'), { readOnly: true });
  try {
    const getOperation = db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
    const pendingInput = db.prepare(`
      SELECT 1 FROM records WHERE kind=? AND json_extract(data,'$.operation_id')=?
        AND json_extract(data,'$.status') IN ('writing','submitted') AND json_extract(data,'$.receipt') IS NULL
      LIMIT 1`);
    const read = id => !pendingInput.get(inputRecords, id) && getOperation.get(operationRecords, id)?.data;
    const exited = [];
    for (const id of new Set(callIds)) {
      const record = read(id);
      if (!record) continue;
      const operation = JSON.parse(record);
      if (operation.protocol !== 'codex' || !operation.instance_id) continue;
      const boundary = hasWriterBoundary(operation) ||
        operation.status === 'unknown' && await observeExitedCodexLaunch(dataRoot, operation);
      if (boundary && read(id) === record) {
        exited.push({ call_id: id, instance_id: operation.instance_id, runner_pid: operation.runner_pid ?? null,
          bridge_pid: operation.child_pid ?? null, submitted_at: operation.submitted_at });
      }
    }
    return exited;
  } finally { db.close(); }
}

async function confirmWriterBoundary(dataRoot, drain) {
  const previous = drain?.exited_writers || [];
  const current = await observeExitedWriters(dataRoot, previous.map(item => item.call_id));
  return current.length === previous.length && current.every((item, index) => sameWriter(item, previous[index]));
}

export function currentWriters(config) {
  const types = ['web', 'gateway', 'cloudflared', 'remote-bridge'];
  return {
    gateway: () => inspectService(config, 'gateway'),
    async stop() {
      for (const type of types) await stopService(config, type, { waitForExit: true });
      while (await inspectServiceLock(config.dataRoot, 'watchdog')) await pause(150);
    },
    async assertStopped({ drain } = {}) {
      for (const type of types) {
        if ((await inspectService(config, type)).state !== 'stopped') {
          throw failure(`The selected deployment still has a ${type} writer`, 'INSTALLATION_ACTIVE_WRITER');
        }
      }
      if (await inspectServiceLock(config.dataRoot, 'remote-access-operation')) {
        throw failure('A remote access configuration writer is still active', 'INSTALLATION_ACTIVE_WRITER');
      }
      if (!drain?.ready || !drain.intake_closed) return observeStoppedNativeWriters(config.dataRoot);
      if (!await confirmWriterBoundary(config.dataRoot, drain)) {
        throw failure('The disconnected Codex launch no longer has a confirmed writer boundary', 'INSTALLATION_ACTIVE_WRITER');
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
