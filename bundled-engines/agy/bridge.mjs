import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const windows = process.platform === 'win32';
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...fields } }) + '\n');

const EFFORT_SUFFIX_RE = /-(low|medium|high|xhigh|max)$/i;
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function resolveModelArgs(payload) {
  const rawModel = typeof payload.model === 'string' ? payload.model.trim() : '';
  const rawEffort = typeof payload.effort === 'string' ? payload.effort.trim().toLowerCase() : '';
  const model = rawModel || process.env.SUMMON_AGY_DEFAULT_MODEL || 'gemini-4-hydrogen-high';
  const args = ['--model', model];
  if (rawEffort && VALID_EFFORTS.has(rawEffort)) {
    const suffixMatch = model.match(EFFORT_SUFFIX_RE);
    if (!suffixMatch || suffixMatch[1].toLowerCase() !== rawEffort) {
      args.push('--effort', rawEffort);
    }
  }
  return args;
}

function summarizeToolCommand(toolName, params = {}) {
  const raw = params.CommandLine ?? params.command ?? params.Path ?? params.path ?? params.TargetFile ?? params.SearchPath ?? params.Query ?? params.query ?? params.Url ?? params.url ?? '';
  if (typeof raw === 'string' && raw.trim()) return raw.trim().slice(0, 400);
  return toolName || '';
}

let activeChild = null;
let stopping = false;
let ending = false;
let turnInFlight = false;
const queuedMessages = [];

function writeUserTurn(child, text) {
  if (!child?.stdin?.writable) return false;
  const content = String(text || '').trim();
  if (!content) return false;
  turnInFlight = true;
  child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
  return true;
}

async function run(payload) {
  const exe = payload.executable || (windows ? 'agy.exe' : 'agy');
  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    ...resolveModelArgs(payload),
    ...(payload.sessionId ? ['--conversation', String(payload.sessionId)] : []),
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

  let stderrTail = '';
  let turnDeltas = '';
  let finalText = '';
  let error = null;
  let lastProgressAt = 0;
  let lastSessionId = null;

  const errRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
  errRl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (/^warning:\s+--mode auto is not available/i.test(trimmed)) return;
    stderrTail = (stderrTail ? `${stderrTail}\n${trimmed}` : trimmed).slice(-4000);
    emit('progress', { text: trimmed.slice(0, 400), phase: 'stderr' });
  });

  const exitPromise = new Promise(resolve => {
    child.once('error', err => resolve({ error: `无法启动 agy：${err.message}` }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  // Send the initial prompt over NDJSON stdin (keeps stdin open for queued steer turns).
  if (!writeUserTurn(child, payload.text)) {
    try { child.stdin.end(); } catch {}
  }

  const outRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of outRl) {
    if (!line.trimStart().startsWith('{')) {
      turnDeltas = (turnDeltas + line + '\n').slice(-24_000);
      continue;
    }
    let frame;
    try { frame = JSON.parse(line); } catch { continue; }

    const convId = frame.conversation_id || frame.step_update?.conversation_id || frame.result?.conversation_id;
    if (typeof convId === 'string' && convId && convId !== lastSessionId) {
      lastSessionId = convId;
      emit('session', { sessionId: convId });
    }

    if (frame.event === 'step_update' && frame.step_update) {
      const u = frame.step_update;
      if (u.step_type === 'tool') {
        const toolName = u.tool_name || u.tool_info?.name || 'tool';
        const done = u.state === 'DONE';
        const toolErr = u.tool_info?.error;
        const failed = Boolean(toolErr);
        const command = summarizeToolCommand(toolName, u.tool_info?.parameters || {});
        const outputText = failed
          ? (typeof toolErr === 'string' ? toolErr : (toolErr?.message || JSON.stringify(toolErr)))
          : (typeof u.tool_info?.output === 'string' ? u.tool_info.output : '');
        emit('tool', {
          itemId: String(u.step_index ?? ''),
          tool: toolName,
          phase: done ? 'completed' : 'started',
          status: failed ? 'failed' : (done ? 'completed' : 'running'),
          command,
          text: String(outputText || '').slice(-2000),
        });
      } else if (u.step_type === 'agent_response' && typeof u.text_delta === 'string' && u.text_delta) {
        turnDeltas = (turnDeltas + u.text_delta).slice(-24_000);
        const nowMs = Date.now();
        if (u.state === 'DONE' || nowMs - lastProgressAt >= 1200) {
          lastProgressAt = nowMs;
          const preview = turnDeltas.replace(/\s+/g, ' ').trim();
          if (preview) emit('progress', { itemId: String(u.step_index ?? ''), text: preview.slice(0, 400) });
        }
      }
      continue;
    }

    if (frame.event === 'result' && frame.result) {
      const r = frame.result;
      turnInFlight = false;
      const status = String(r.status || '').toUpperCase();
      if (typeof r.response === 'string' && r.response.trim()) {
        finalText = r.response.trim().slice(-32_000);
      } else if (turnDeltas.trim()) {
        finalText = turnDeltas.trim().slice(-32_000);
      }
      turnDeltas = '';

      if (status !== 'SUCCESS') {
        error = r.error || (status === 'CANCELED' || status === 'INTERRUPTED' ? null : `agy returned status ${status}`);
        if (status === 'CANCELED' || status === 'INTERRUPTED') stopping = true;
        try { child.stdin.end(); } catch {}
        continue;
      }

      if (!stopping && queuedMessages.length > 0) {
        const nextText = queuedMessages.shift();
        emit('progress', { text: '收到追加纠偏，继续执行…' });
        if (!writeUserTurn(child, nextText)) {
          try { child.stdin.end(); } catch {}
        }
      } else {
        try { child.stdin.end(); } catch {}
      }
    }
  }

  const outcome = await exitPromise;
  activeChild = null;
  ending = true;
  error ||= outcome.error;
  if (!error && !stopping && outcome.code !== 0) {
    error = stderrTail.trim() || `agy exited with ${outcome.signal || `code ${outcome.code}`}`;
  }
  const result = (finalText || turnDeltas).trim();
  if (result) emit('result', { text: result, confirmed: !error && !stopping });
  emit('outcome', stopping ? { status: 'stopped' } : error ? { status: 'failed', error: String(error).slice(0, 4000) } : { status: 'completed' });
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
  } else if (msg.summonInput) {
    if (msg.summonInput.type === 'stop') {
      stopping = true;
      queuedMessages.length = 0;
      try { activeChild?.stdin?.end(); } catch {}
      try { activeChild?.kill(); } catch {}
    } else if (!stopping && !ending && typeof msg.summonInput.text === 'string' && msg.summonInput.text.trim()) {
      if (!turnInFlight && activeChild?.stdin?.writable) {
        writeUserTurn(activeChild, msg.summonInput.text);
      } else {
        queuedMessages.push(msg.summonInput.text.trim());
      }
    }
  }
});
