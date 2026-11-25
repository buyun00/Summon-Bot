import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const windows = process.platform === 'win32';
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...fields } }) + '\n');

let activeChild = null;
let stopping = false;

async function run(payload) {
  const exe = payload.executable || 'claude';
  const args = [
    '--print',
    '--output-format', payload.outputFormat || 'stream-json',
    '--verbose',
    ...(payload.sessionId ? ['--resume', String(payload.sessionId)] : []),
    ...(Array.isArray(payload.extraArgs) ? payload.extraArgs.map(String) : []),
  ];

  const child = spawn(exe, args, {
    cwd: process.cwd(),
    env: process.env,
    shell: windows && !/\.exe$/i.test(exe),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeChild = child;
  child.stdin.on('error', () => {});
  child.stdin.end(String(payload.text || ''));

  let stderrTail = '', finalText = '', error = null;
  const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
  errRl.on('line', line => {
    if (line.trim()) {
      stderrTail = (stderrTail ? `${stderrTail}\n${line}` : line).slice(-4000);
      emit('progress', { text: line.slice(0, 4000), phase: 'stderr' });
    }
  });

  const exitPromise = new Promise(resolve => {
    child.once('error', err => resolve({ error: `无法启动 claude：${err.message}` }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of outRl) {
    if (!line.trimStart().startsWith('{')) { finalText = (finalText + line + '\n').slice(-16000); continue; }
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }
    if (frame.session_id) emit('session', { sessionId: String(frame.session_id) });
    if (frame.type === 'assistant' && !frame.parent_tool_use_id) {
      const parts = Array.isArray(frame.message?.content) ? frame.message.content : [];
      const text = parts.filter(p => p.type === 'text' && p.text).map(p => p.text).join('\n');
      const tools = parts.filter(p => p.type === 'tool_use');
      if (text || tools[0]?.name) emit('progress', { text: (text || tools[0].name).slice(0, 400) });
      for (const t of tools) emit('tool', { itemId: t.id, tool: t.name, phase: 'call', status: 'running', command: t.input?.command });
    }
    if (frame.type === 'result') {
      if (typeof frame.result === 'string') finalText = frame.result.slice(-16000);
      if (frame.is_error || (frame.subtype && frame.subtype !== 'success')) {
        error ||= frame.errors?.join?.('\n') || frame.result || frame.subtype;
      }
    }
  }

  const outcome = await exitPromise;
  activeChild = null;
  error ||= outcome.error;
  if (!error && !stopping && outcome.code !== 0) {
    error = stderrTail.trim() || `claude exited with ${outcome.signal || `code ${outcome.code}`}`;
  }
  const result = finalText.trim();
  if (result) emit('result', { text: result, confirmed: !error });
  emit('outcome', stopping ? { status: 'stopped' } : error ? { status: 'failed', error: error.slice(0, 4000) } : { status: 'completed' });
  if (error && !stopping) process.exitCode = 1;
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
