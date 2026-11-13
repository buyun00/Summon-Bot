import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, now } from '../shared/validation.mjs';
import { redactNative } from './native-host.mjs';

const collection = 'native-executions';
const inputs = 'native-execution-inputs';
const worker = fileURLToPath(new URL('./native-process.mjs', import.meta.url));
const terminal = new Set(['completed', 'failed', 'stopped', 'unknown', 'superseded']);
export const liveNative = status => !terminal.has(status);
const optional = async path => {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};
async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

async function page(path, offset, limit, lines) {
  const file = await open(path, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return { text: '', nextOffset: offset, more: false };
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(limit, Math.max(size - offset, 0)));
    if (!buffer.length) return { text: '', nextOffset: offset, more: false };
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let end = bytesRead;
    if (lines && bytesRead) end = buffer.lastIndexOf(10, bytesRead - 1) + 1;
    else if (offset + bytesRead < size && bytesRead) {
      let start = bytesRead - 1;
      while (start > 0 && (buffer[start] & 192) === 128) start--;
      const leading = buffer[start], expected = leading >= 240 ? 4 : leading >= 224 ? 3 : leading >= 192 ? 2 : 1;
      if (bytesRead - start < expected) end = start;
    }
    return { text: buffer.toString('utf8', 0, end), nextOffset: offset + end, more: offset + end < size };
  } finally { await file.close(); }
}

export class NativeExecutions {
  constructor({ store, dataRoot, emit, clean }) {
    Object.assign(this, { store, emit, clean });
    this.root = join(dataRoot, 'capabilities', 'native-executions');
  }

  list() { return this.store.list(collection); }
  forResource(id) { return this.list().filter(item => item.resourceId === id); }
  forWork(actor, workId) { return this.list().filter(item => item.actor === actor && item.workId === workId); }
  get(actor, workId, operationId) {
    return this.store.get(collection, JSON.stringify([actor, workId, operationId]));
  }
  directory(item) { return join(this.root, item.nonce); }
  save(item, patch = {}) {
    const base = this.store.get(collection, item.id) ? { id: item.id } : item;
    return this.store.save(collection, { ...base, ...patch });
  }
  public(item) {
    const { id, nonce, sequence, launch, intent, source, eventOffset, projected, stopRequestedAt, ...result } = item;
    return this.clean({ ...result, outputRef: { type: 'native-execution', operationId: item.operationId, workId: item.workId, botId: item.actor } });
  }

  create(input, launch, status) {
    const id = JSON.stringify([input.actor, input.workId, input.operationId]);
    const previous = this.store.get(collection, id);
    if (previous) return previous;
    return this.store.transaction(() => {
      const record = this.store.get('native-execution-sequence', 'host');
      const sequence = (record?.sequence || 0) + 1;
      this.store.save('native-execution-sequence', { id: 'host', sequence });
      return this.save({ id, nonce: randomUUID(), sequence, ...input, launch, status, observedAt: now() });
    });
  }

  async launch(item, launch) {
    if (item.status !== 'queued') return item;
    const directory = this.directory(item);
    await mkdir(join(directory, 'inputs'), { recursive: true, mode: 0o700 });
    await atomic(join(directory, 'launch.json'), { ...launch, nonce: item.nonce });
    // Persist intent before creating the OS process. Once starting, recovery
    // inspects the original receipt and heartbeat. It never repeats a launch.
    const starting = this.save(item, { launch, status: 'starting', launchedAt: now() });
    try {
      const child = spawn(process.execPath, [worker, directory], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
      });
      const pid = await new Promise((accept, reject) => {
        child.once('spawn', () => accept(child.pid));
        child.once('error', reject);
      });
      child.unref();
      return this.save(starting, { runnerPid: pid });
    } catch (error) {
      return this.save(starting, { status: 'failed', finishedAt: now(), error: this.clean(error.message) });
    }
  }

  async refresh(item) {
    if (['completed', 'failed', 'stopped', 'superseded', 'queued'].includes(item.status)) return item;
    const state = await optional(join(this.directory(item), 'state.json'));
    const latest = this.store.get(collection, item.id);
    if (latest?.finishedAt && latest.status !== 'unknown') return latest;
    item = latest || item;
    if (state?.nonce === item.nonce && (!item.runnerPid || state.runnerPid === item.runnerPid)) {
      const stale = liveNative(state.status) && Date.now() - Date.parse(state.observedAt) > 15_000;
      if (state.observedAt === item.observedAt && item.status === (stale ? 'unknown' : state.status) && item.pid === state.pid) return item;
      return this.save(item, { status: stale ? 'unknown' : state.status, runnerPid: state.runnerPid, pid: state.pid,
        observedAt: state.observedAt, startedAt: state.startedAt, finishedAt: state.finishedAt,
        error: stale ? 'Execution heartbeat unavailable; the original outcome is unknown' : state.error,
        pending: stale ? [] : state.pending, nativeSessionId: state.nativeSessionId, exitCode: state.exitCode, exitSignal: state.exitSignal });
    }
    return Date.now() - Date.parse(item.launchedAt) > 15_000
      ? this.save(item, { status: 'unknown', error: 'Execution launch receipt unavailable; inspect the original effect before another write' })
      : item;
  }

  async output(item, { stream = 'stdout', offset = 0, limit = 16_384 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1024 || limit > 65_536 ||
        !['stdout', 'stderr', 'events'].includes(stream)) fail('Invalid native output page');
    return page(join(this.directory(item), stream === 'events' ? 'events.jsonl' : stream + '.log'), offset, limit, stream === 'events');
  }

  async events(item) {
    const read = await this.output(item, { stream: 'events', offset: item.eventOffset || 0, limit: 65_536 });
    const events = read.text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { events, offset: read.nextOffset };
  }

  async command(item, { id, type, text, requestId, source }) {
    const key = JSON.stringify([item.id, id]);
    const previous = this.store.get(inputs, key);
    if (previous) {
      if (previous.type !== type || previous.text !== text || previous.requestId !== (requestId || null)) fail('This input identity already belongs to a different command', 409);
      return this.inputReceipt(item, previous);
    }
    if (type === 'stop' && item.status === 'queued') return this.public(this.save(item, { status: 'stopped', finishedAt: now(), observedAt: now() }));
    if (!['starting', 'running', 'awaiting-input', 'stopping'].includes(item.status)) fail('The original process is not available for input', 409);
    if (type === 'input') {
      if (!item.launch.keepInput) fail('The selected method closes stdin after launch', 409);
      if (typeof text !== 'string' || !text.length || text.length > 32_768 || text !== redactNative(text) || JSON.stringify(text) !== JSON.stringify(this.clean(text))) fail('Pass native credentials by a configured reference');
      const request = requestId && item.pending?.find(request => request.id === requestId);
      if (requestId && !request || request?.choices.length && !request.choices.some(choice => choice.id === text)) fail('The request is no longer pending or the choice is invalid', 409);
      if (requestId && this.store.list(inputs).some(input => input.operation === item.id && input.type === 'input' && input.requestId === requestId)) fail('An answer is already associated with this native request; inspect its receipt', 409);
    }
    const record = this.store.save(inputs, { id: key, operation: item.id, inputId: id, type, text, requestId: requestId || null,
      file: String(Date.now()).padStart(15, '0') + '-' + randomUUID() + '.json', source, status: 'recorded' });
    return this.inputReceipt(item, record);
  }

  async inputReceipt(item, record) {
    const path = join(this.directory(item), 'inputs', record.file);
    if (record.status === 'recorded') {
      await atomic(path, { id: record.inputId, nonce: item.nonce, type: record.type, text: record.text, requestId: record.requestId });
      record = this.store.save(inputs, { id: record.id, status: 'queued' });
    }
    const receipt = await optional(path + '.receipt');
    if (!receipt && !liveNative(item.status)) return { id: record.inputId, requestId: record.requestId, status: 'unknown', observedAt: item.observedAt };
    return receipt || { id: record.inputId, requestId: record.requestId, status: record.status };
  }

  async inputReceipts(item) {
    return Promise.all(this.store.list(inputs).filter(input => input.operation === item.id).map(input => this.inputReceipt(item, input)));
  }
}
