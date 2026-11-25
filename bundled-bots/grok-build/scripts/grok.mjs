import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const windows = process.platform === 'win32';
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...fields } }) + '\n');

let activeChild = null;
let stopping = false;

async function run(payload) {
  const exe = payload.executable || 'grok';
  const promptFile = join(tmpdir(), `summon-grok-${randomUUID()}.txt`);
  await writeFile(promptFile, String(payload.text || ''), { mode: 0o600 });

  const args = [
    '--prompt-file', promptFile,
    '--output-format', payload.outputFormat || 'streaming-json',
    '--no-auto-update',
    ...(payload.sessionId ? ['--resume', String(payload.sessionId)] : []),
    ...(Array.isArray(payload.extraArgs) ? payload.extraArgs.map(String) : []),
  ];

  try {
    const child = spawn(exe, args, {
      cwd: process.cwd(),
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
      shell: windows && !/\.exe$/i.test(exe),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;

    let stderrTail = '', finalText = '', deltas = '', error = null;
    const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
    errRl.on('line', line => {
      if (line.trim()) {
        stderrTail = (stderrTail ? `${stderrTail}\n${line}` : line).slice(-4000);
        emit('progress', { text: line.slice(0, 4000), phase: 'stderr' });
      }
    });

    const exitPromise = new Promise(resolve => {
      child.once('error', err => resolve({ error: `无法启动 grok：${err.message}` }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of outRl) {
      if (!line.trimStart().startsWith('{')) { finalText = (finalText + line + '\n').slice(-16000); continue; }
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      const sid = frame.sessionId || frame.session_id;
      if (typeof sid === 'string' && sid) emit('session', { sessionId: sid });
      if (frame.type === 'text' && typeof frame.data === 'string') deltas = (deltas + frame.data).slice(-16000);
      if (frame.type === 'final_assistant_message') finalText = String(frame.text ?? frame.data ?? '').slice(-16000);
      if (frame.type === 'tool_call') {
        deltas = '';
        emit('progress', { text: String(frame.title || frame.toolName || 'tool').slice(0, 400) });
        emit('tool', { itemId: frame.toolCallId, tool: frame.toolName, phase: 'call', status: frame.status || 'running', command: frame.command ?? frame.input?.command, text: frame.title });
      }
      if (frame.type === 'result') {
        if (typeof frame.result === 'string') finalText = frame.result.slice(-16000);
        if (frame.is_error) error ||= frame.errors?.join?.('\n') || frame.result || 'Grok returned an error';
      }
      if (frame.type === 'error' && frame.message) error ||= String(frame.message);
    }

    const outcome = await exitPromise;
    error ||= outcome.error;
    if (!error && !stopping && outcome.code !== 0) {
      error = stderrTail.trim() || `grok exited with ${outcome.signal || `code ${outcome.code}`}`;
    }
    const result = (finalText || deltas).trim();
    if (result) emit('result', { text: result, confirmed: !error });
    emit('outcome', stopping ? { status: 'stopped' } : error ? { status: 'failed', error: error.slice(0, 4000) } : { status: 'completed' });
    if (error && !stopping) process.exitCode = 1;
  } finally {
    activeChild = null;
    await unlink(promptFile).catch(() => {});
  }
}

const stdinRl = createInterface({ input: process.stdin });
let started = false;
stdinRl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.summonStart && !started) {
    started = true;
    void run(msg.summonStart).finally(() => stdinRl.close());
  } else if (msg.summonInput?.type === 'stop') {
    stopping = true;
    try { activeChild?.kill(); } catch {}
  }
});
