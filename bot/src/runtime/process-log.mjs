import { mkdirSync, lstatSync, openSync, closeSync, fstatSync, readSync, writeSync, ftruncateSync, futimesSync, fsyncSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_LOG_CONFIG = Object.freeze({ maxFileBytes: 10 * 1024 * 1024, maxFiles: 5, retentionDays: 7, sweepIntervalMs: 60000 });
export function normalizeLogConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('logs must be an object');
  const config = { ...DEFAULT_LOG_CONFIG, ...input };
  if (!Number.isSafeInteger(config.maxFileBytes) || config.maxFileBytes < 4) throw new Error('logs.maxFileBytes must be an integer >= 4');
  if (!Number.isSafeInteger(config.maxFiles) || config.maxFiles < 1 || config.maxFiles > 100) throw new Error('logs.maxFiles must be 1..100 (including the active file)');
  if (!Number.isFinite(config.retentionDays) || config.retentionDays <= 0 || config.retentionDays > 3650) throw new Error('logs.retentionDays must be > 0 and <= 3650');
  if (!Number.isSafeInteger(config.sweepIntervalMs) || config.sweepIntervalMs < 10 || config.sweepIntervalMs > 3600000) throw new Error('logs.sweepIntervalMs must be 10..3600000');
  return config;
}

const archivePattern = /^process\.(\d{13})\.(\d+)\.[a-f0-9-]{36}\.log$/;
const continuation = byte => (byte & 0xc0) === 0x80;
const statIfPresent = path => { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };

/** The caller must already own its Bot/service OS identity. No parent pipe is used. */
export function createProcessLog(directory, input = {}) {
  const config = normalizeLogConfig(input), root = resolve(directory), path = join(root, 'process.log');
  mkdirSync(root, { recursive: true });
  if (lstatSync(root).isSymbolicLink()) throw new Error('Process log directory must not be a link');
  const retentionMs = config.retentionDays * 86400000, rotationMs = Math.min(retentionMs, 86400000);
  let fd, size = 0, openedAt = Date.now(), lastWriteAt = openedAt, closed = false, sequence = 0, nextSweep = 0;
  const decoders = new Map();
  function open() {
    const previous = statIfPresent(path);
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw new Error('process.log must be a regular file');
    fd = openSync(path, previous ? 'r+' : 'wx+', 0o600);
    // Files inherited across releases/restarts may be years old but contain
    // fresh diagnostics. Their latest write, not creation time, starts this
    // ownership period. While running we keep our own rotation start time.
    const stat = fstatSync(fd); size = stat.size; lastWriteAt = stat.mtimeMs; openedAt = size ? lastWriteAt : Date.now();
    // Importing an old unbounded log must not carry an oversized file forward.
    // Retain only its newest complete UTF-8 bytes; this is operational log data.
    if (size > config.maxFileBytes) {
      const tail = Buffer.alloc(config.maxFileBytes); readSync(fd, tail, 0, tail.length, size - tail.length);
      let start = 0; while (start < tail.length && continuation(tail[start])) start++;
      const text = Buffer.from(tail.subarray(start).toString('utf8'));
      ftruncateSync(fd, 0); size = 0;
      start = Math.max(0, text.length - config.maxFileBytes); while (start < text.length && continuation(text[start])) start++;
      append(text.subarray(start));
      // Capacity maintenance is not new log output and cannot renew retention.
      futimesSync(fd, stat.atime, stat.mtime); lastWriteAt = stat.mtimeMs;
    }
  }
  function append(buffer) { let offset = 0; while (offset < buffer.length) { const bytes = writeSync(fd, buffer, offset, buffer.length - offset, size); if (!bytes) throw new Error('Process log write made no progress'); offset += bytes; size += bytes; lastWriteAt = Date.now(); } }
  function prune(now) {
    const files = readdirSync(root).flatMap(name => {
      const match = archivePattern.exec(name); if (!match) return [];
      const file = join(root, name), stat = lstatSync(file);
      return stat.isFile() && !stat.isSymbolicLink() ? [{ file, lastWriteAt: Number(match[1]), sequence: Number(match[2]), size: stat.size }] : [];
    }).sort((a, b) => b.lastWriteAt - a.lastWriteAt || b.sequence - a.sequence);
    let kept = 0;
    for (const file of files) {
      if (file.lastWriteAt <= now - retentionMs || file.size > config.maxFileBytes || kept >= config.maxFiles - 1) unlinkSync(file.file);
      else kept++;
    }
  }
  function rotate(now) {
    fsyncSync(fd); closeSync(fd); fd = undefined;
    // Rotation age and retention age are different: recently written tail data
    // survives an old active window reaching its rotation deadline.
    renameSync(path, join(root, `process.${Math.floor(lastWriteAt)}.${sequence++}.${randomUUID()}.log`));
    open(); openedAt = now; prune(now);
  }
  function maintain(now = Date.now()) {
    if (closed) return;
    if (size && now - openedAt >= rotationMs) rotate(now);
    else if (now >= nextSweep) { prune(now); nextSweep = now + config.sweepIntervalMs; }
  }
  function writeText(text) {
    const buffer = Buffer.from(text, 'utf8'); let cursor = 0;
    while (cursor < buffer.length) {
      if (size >= config.maxFileBytes) rotate(Date.now());
      let end = Math.min(buffer.length, cursor + config.maxFileBytes - size);
      while (end < buffer.length && end > cursor && continuation(buffer[end])) end--;
      if (end === cursor) { rotate(Date.now()); continue; }
      append(buffer.subarray(cursor, end)); cursor = end;
    }
  }
  try { open(); maintain(); } catch (error) { if (fd !== undefined) closeSync(fd); throw error; }
  return {
    config, path, maintain,
    write(chunk, encoding = 'utf8', channel = 'stdout') {
      if (closed) throw new Error('Process log is closed');
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw new TypeError('Log write requires a string or Uint8Array');
      let decoder = decoders.get(channel); if (!decoder) decoders.set(channel, decoder = new StringDecoder('utf8'));
      maintain(); writeText(decoder.write(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk));
    },
    close() {
      if (closed) return;
      try { for (const decoder of decoders.values()) writeText(decoder.end()); fsyncSync(fd); }
      finally { closed = true; if (fd !== undefined) { closeSync(fd); fd = undefined; } }
    },
  };
}

const captureKey = Symbol.for('summon.process-log.capture');
/** Explicit process-wide output capture for CLI/service hosts, not embedded Bots. */
export function installProcessLog(directory, config, { tee = true } = {}) {
  if (process[captureKey]) throw new Error('Process output already has a log owner');
  const log = createProcessLog(directory, config), originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  let closed = false, timer;
  const restore = () => {
    clearInterval(timer); process.removeListener('exit', onExit);
    process.stdout.write = originals.stdout; process.stderr.write = originals.stderr;
    delete process[captureKey];
  };
  const fatal = error => {
    restore(); closed = true; try { log.close(); } catch {}
    const failure = Object.assign(new Error(`Process logging failed: ${error.message}`, { cause: error }), { code: 'PROCESS_LOG_FAILED' });
    originals.stderr.call(process.stderr, `${failure.stack}\n`);
    // A caught console/write error must not leave an apparently healthy process
    // silently running without its configured log. OS ownership dies with it.
    process.nextTick(() => { throw failure; }); return failure;
  };
  const onExit = () => { try { handle.close(); } catch (error) { originals.stderr.call(process.stderr, `Process log flush failed: ${error.message}\n`); process.exitCode = 1; } };
  const handle = {
    ...log,
    close() { if (closed) return; closed = true; restore(); log.close(); },
  };
  process[captureKey] = handle;
  for (const channel of ['stdout', 'stderr']) process[channel].write = function (chunk, encoding, callback) {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    try { log.write(chunk, encoding || 'utf8', channel); } catch (error) { throw fatal(error); }
    if (tee) return originals[channel].call(this, chunk, encoding, callback);
    if (callback) process.nextTick(callback); return true;
  };
  timer = setInterval(() => { try { log.maintain(); } catch (error) { fatal(error); } }, log.config.sweepIntervalMs); timer.unref();
  process.once('exit', onExit);
  return handle;
}
