import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { inputRecords, operationRecords, settled } from '../../capabilities/services/session-processes.mjs';
import { isProcessAlive } from '../../bot/src/runtime/process-tools.mjs';
import { bundledNode, inspectService, stopService } from './system.mjs';
import { inspectServiceLock } from './service-lock.mjs';
import { advanceInstallation, writeInstallationState } from './installation-state.mjs';

const failure = (message, code = 'INSTALLATION_DRAIN_UNAVAILABLE') => Object.assign(new Error(message), { code });
const codexLaunchIsUnknown = item => item.kind === 'codex_turn' && item.status === 'unknown';
const detachedSafe = operation => Boolean(
  operation.detached_at ||
  (operation.protocol !== 'service' && operation.runner_pid && ['running', 'awaiting-input', 'stopping'].includes(operation.status))
);
const hasWriterBoundary = operation => detachedSafe(operation) || (operation.runtime_ended === true && settled(operation.status)) ||
  (operation.protocol !== 'service' && settled(operation.status) && !isProcessAlive(operation.runner_pid) && !isProcessAlive(operation.child_pid));
const sameWriter = (left, right) => left.call_id === right.call_id && left.instance_id === right.instance_id &&
  left.runner_pid === right.runner_pid && left.bridge_pid === right.bridge_pid && left.submitted_at === right.submitted_at;
const stoppedDrain = (state, exited) => ({
  started_calls: state.drain?.started_calls || [], active: [], ready: true, intake_closed: true,
  ...(exited.length ? { exited_writers: exited } : {}),
});
const nativeOwner = config => ({
  runtimePath: bundledNode(config.releaseRoot),
  bridgePath: join(config.releaseRoot, 'capabilities', 'codex', 'app-server.mjs'),
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
    method, redirect: 'error', headers: { Authorization: `Bearer ${config.controlToken}` },
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
      const exited = await owner.assertStopped({ drain: state.drain }) ?? state.drain?.exited_writers ?? [];
      return writeInstallationState(dataRoot, { ...state, intake_closed: true, drain: stoppedDrain(state, exited) });
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
    const active = facts.active.map(call => ({ kind: String(call.kind), id: String(call.id), status: String(call.status),
      ...(call.instance_id || call.native?.instance_id ? { instance_id: String(call.instance_id || call.native.instance_id) } : {}),
      ...(call.pid ? { pid: call.pid } : {}) }));
    const started = (facts.started_calls || active).map(call => ({ kind: String(call.kind), id: String(call.id) }));
    // A disappeared report can also be a real receipt or a lost observation.
    // Keep the last proof until the closed-window pass can check the store.
    const witnesses = new Map((state.drain?.exited_writers || []).map(writer => [writer.call_id, writer]));
    const observed = active.filter(codexLaunchIsUnknown).map(item => item.id);
    const exited = (await observeExitedWriters(dataRoot, [...witnesses.keys(), ...observed], nativeOwner(previous)))
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
    if (!drain.ready) { await pause(Math.max(0, Math.min(2500, deadline - Date.now())), undefined, { signal }); continue; }
    if (!state.intake_closed) {
      state = await writeInstallationState(dataRoot, { ...state, intake_closed: true });
      continue;
    }
    if (facts.intake_closed !== true) throw failure('The gateway did not close intake for the final stop');
    if (!await confirmWriterBoundary(dataRoot, state.drain, nativeOwner(previous))) {
      await pause(Math.max(0, Math.min(2500, deadline - Date.now())), undefined, { signal });
      continue;
    }
    await owner.stop(stopOptions);
    await owner.assertStopped({ drain: state.drain });
    return state;
  }
  const active = state.drain?.active?.map(item => `${item.kind} ${item.id} (${item.status})`).join(', ');
  throw failure(`Installation drain paused for build ${state.target_build}: ${waiting || active || 'writer exit not confirmed'}. Run the same release command to resume.`,
    'INSTALLATION_DRAIN_TIMEOUT');
}

export async function observeStoppedNativeWriters(config) {
  const { dataRoot } = config;
  const path = join(dataRoot, 'capabilities', 'chatroom', 'state.sqlite');
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  let uncertain, pending;
  try {
    const records = db.prepare('SELECT data FROM records WHERE kind=?');
    const operations = records.all(operationRecords).map(row => JSON.parse(row.data));
    const inputs = records.all(inputRecords).map(row => JSON.parse(row.data));
    uncertain = operations.filter(item => item.submitted_at && !hasWriterBoundary(item));
    pending = inputs.find(item => !item.migrated && !item.receipt && ['writing', 'submitted'].includes(item.status));
  } finally { db.close(); }
  const exited = await observeExitedWriters(dataRoot, uncertain.map(item => item.id), nativeOwner(config));
  const confirmed = new Set(exited.map(item => item.call_id));
  const unsettled = pending || uncertain.find(item => !confirmed.has(item.id));
  if (unsettled) {
    throw failure(`The stopped gateway left ${pending ? 'input' : 'execution'} ${unsettled.id} (${unsettled.status}) without a confirmed writer boundary`,
      'INSTALLATION_ACTIVE_WRITER');
  }
  return exited;
}

async function observeExitedWriters(dataRoot, callIds, owner) {
  if (!callIds.length) return [];
  const db = new DatabaseSync(join(dataRoot, 'capabilities', 'chatroom', 'state.sqlite'), { readOnly: true });
  try {
    const getOperation = db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
    const pendingInput = db.prepare(`
      SELECT 1 FROM records WHERE kind=? AND json_extract(data,'$.operation_id')=?
        AND json_extract(data,'$.status') IN ('writing','submitted') AND json_extract(data,'$.receipt') IS NULL
        AND COALESCE(json_extract(data,'$.migrated'), 0) = 0
      LIMIT 1`);
    const read = id => !pendingInput.get(inputRecords, id) && getOperation.get(operationRecords, id)?.data;
    const exited = [];
    for (const id of new Set(callIds)) {
      const record = read(id);
      if (!record) continue;
      const operation = JSON.parse(record);
      if (operation.protocol === 'service' || !operation.instance_id) continue;
      const boundary = hasWriterBoundary(operation) ||
        (!isProcessAlive(operation.runner_pid) && !isProcessAlive(operation.child_pid));
      if (boundary && read(id) === record) {
        exited.push({ call_id: id, instance_id: operation.instance_id, runner_pid: operation.runner_pid ?? null,
          bridge_pid: operation.child_pid ?? null, submitted_at: operation.submitted_at });
      }
    }
    return exited;
  } finally { db.close(); }
}

async function confirmWriterBoundary(dataRoot, drain, owner) {
  const previous = drain?.exited_writers || [];
  const current = await observeExitedWriters(dataRoot, previous.map(item => item.call_id), owner);
  return current.length === previous.length && current.every((item, index) => sameWriter(item, previous[index]));
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
          if (Date.now() >= deadline) throw failure(`${type} PID ${owner.pid} is still active (${owner.state}); resume after it exits`, 'INSTALLATION_ACTIVE_WRITER');
          if (lastOwner !== owner.pid) onProgress?.({ phase: 'draining', service: type, pid: owner.pid, state: owner.state });
          lastOwner = owner.pid;
          await pause(Math.max(0, Math.min(250, deadline - Date.now())), undefined, { signal });
        }
      }
    },
    async assertStopped({ drain } = {}) {
      for (const type of [...types, ...passive]) {
        const owner = await inspectServiceLock(config.dataRoot, type);
        if (owner) throw failure(`${type} PID ${owner.pid} still owns the service (${owner.state})`, 'INSTALLATION_ACTIVE_WRITER');
      }
      if (!drain?.ready || !drain.intake_closed) return observeStoppedNativeWriters(config);
      if (!await confirmWriterBoundary(config.dataRoot, drain, nativeOwner(config))) {
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
