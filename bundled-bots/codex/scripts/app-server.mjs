import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const windows = process.platform === 'win32';
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...fields } }) + '\n');
const textInput = text => [{ type: 'text', text }];

async function runBridge(startPayload) {
  const exe = startPayload.executable || 'codex';
  const extraArgs = Array.isArray(startPayload.extraArgs) ? startPayload.extraArgs.map(String) : [];
  const server = spawn(exe, ['app-server', ...extraArgs], {
    cwd: process.cwd(),
    shell: windows && !/\.exe$/i.test(exe),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  server.stderr.pipe(process.stderr, { end: false });

  const output = createInterface({ input: server.stdout });
  const requests = new Map();
  const prompts = new Map();
  const filesByItem = new Map();
  let nextId = 0, threadId = null, turnId = null, finalText = null, lastMessage = null;
  let ending = false, stopping = false;

  const send = msg => {
    if (!server.stdin.writable) throw new Error('Codex app-server stdin is closed');
    server.stdin.write(JSON.stringify(msg) + '\n');
  };

  const rpc = (method, params, timeoutMs = 20_000) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      requests.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); } catch (err) { clearTimeout(timer); requests.delete(id); reject(err); }
    });
  };

  const finish = (status, error) => {
    if (ending) return;
    ending = true;
    for (const req of requests.values()) { clearTimeout(req.timer); req.reject(new Error(error || status)); }
    requests.clear();
    for (const id of prompts.keys()) emit('withdrawn', { id });
    prompts.clear();
    emit('outcome', { status, ...(error ? { error } : {}) });
    process.exitCode = status === 'completed' || status === 'stopped' ? 0 : 1;
    try { server.stdin.end(); } catch {}
    setTimeout(() => { try { server.kill(); } catch {} output.close(); }, 800).unref();
  };

  const interrupt = async () => {
    if (turnId && !ending) await rpc('turn/interrupt', { threadId, turnId }).catch(() => {});
  };

  function handleServerRequest({ method, params: p, id }) {
    if (p?.threadId !== threadId || !turnId) return send({ id, error: { code: -32602, message: 'Outside active turn' } });
    const key = String(id);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const isCmd = method === 'item/commandExecution/requestApproval';
      const text = [isCmd ? 'Codex 请求执行命令' : 'Codex 请求修改文件', isCmd ? p.command : (filesByItem.get(p.itemId) || []).join('\n'), p.cwd, p.reason].filter(Boolean).join('\n');
      const choices = [{ id: 'accept', label: '允许' }, { id: 'decline', label: '拒绝' }, { id: 'cancel', label: '取消' }];
      prompts.set(key, { id, answer: decision => ({ decision }) });
      emit('request', { id: key, kind: 'approval', text, choices, plain_text: false });
      return;
    }
    if (method === 'item/tool/requestUserInput') {
      const qs = (Array.isArray(p.questions) ? p.questions : []).filter(q => q?.isSecret !== true);
      if (!qs.length) return send({ id, error: { code: -32602, message: 'No answerable questions' } });
      const simple = qs.length === 1;
      const choices = simple && !qs[0].isOther ? (qs[0].options || []).map(o => ({ id: o.label, label: o.label })) : [];
      const text = qs.map((q, i) => `${simple ? '' : `${i + 1}. `}${q.question}`).join('\n');
      prompts.set(key, {
        id,
        answer: ans => {
          const vals = simple ? [ans] : String(ans).split(/\r?\n/);
          return { answers: Object.fromEntries(qs.map((q, i) => [q.id, { answers: [vals[i] || ''] }])) };
        },
      });
      emit('request', { id: key, kind: 'question', text, choices, plain_text: !choices.length });
      return;
    }
    send({ id, error: { code: -32601, message: 'Unsupported request' } });
  }

  output.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { process.stderr.write(line + '\n'); return; }
    if (msg.method && msg.id !== undefined) {
      try { handleServerRequest(msg); } catch (err) { send({ id: msg.id, error: { code: -32602, message: err.message } }); }
      return;
    }
    if (msg.method) {
      const p = msg.params;
      if (p?.threadId !== threadId) return;
      if (msg.method === 'turn/started' && p.turn?.id && !turnId) {
        turnId = p.turn.id;
        emit('turn', { sessionId: threadId, turnId });
      }
      if (msg.method === 'serverRequest/resolved') {
        const key = String(p.requestId);
        if (prompts.delete(key)) emit('resolved', { id: key });
      }
      if (msg.method === 'item/started' || msg.method === 'item/completed') {
        const item = p.item;
        const done = msg.method === 'item/completed';
        if (item?.type === 'fileChange') filesByItem.set(item.id, item.changes?.map(c => c.path) || []);
        if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item?.type)) {
          emit('tool', {
            itemId: item.id,
            tool: item.tool || item.type,
            phase: done ? 'completed' : 'started',
            status: item.status || (done ? 'completed' : 'running'),
            command: item.command || (item.changes?.map(c => c.path).join(', ') || ''),
            text: (item.aggregatedOutput || '').slice(-2000),
          });
        }
        if (done && item?.type === 'agentMessage' && item.text) {
          lastMessage = item.text;
          if (item.phase === 'final_answer') finalText = item.text;
          else emit('progress', { itemId: item.id, text: item.text.slice(0, 4000) });
        }
      }
      if (msg.method === 'turn/completed' && turnId && p.turn?.id === turnId) {
        const final = finalText || lastMessage;
        if (final) emit('result', { text: final, confirmed: p.turn.status === 'completed' });
        const map = { completed: 'completed', interrupted: 'stopped', failed: 'failed' };
        finish(map[p.turn.status] || 'failed', p.turn.error?.message);
      }
      return;
    }
    const req = requests.get(msg.id);
    if (!req) return;
    requests.delete(msg.id);
    clearTimeout(req.timer);
    if (msg.error) req.reject(new Error(msg.error.message || 'Codex app-server error'));
    else req.resolve(msg.result);
  });

  server.on('error', err => finish('failed', `无法启动 codex：${err.message}`));
  server.once('close', () => finish(turnId ? 'unknown' : 'failed', 'Codex app-server closed unexpectedly'));

  globalThis.__handleInput = async msg => {
    if (msg.type === 'stop') { stopping = true; await interrupt(); return; }
    if (!turnId || stopping || ending) return;
    if (msg.type === 'answer') {
      const pr = prompts.get(msg.requestId);
      if (pr) {
        prompts.delete(msg.requestId);
        send({ id: pr.id, result: pr.answer(msg.text) });
        emit('resolved', { id: msg.requestId });
      }
      return;
    }
    await rpc('turn/steer', { threadId, expectedTurnId: turnId, input: textInput(msg.text), clientUserMessageId: msg.id }).catch(() => {});
  };

  try {
    await rpc('initialize', { clientInfo: { name: 'summon-bot', title: 'Summon Bot', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    if (stopping) return finish('stopped');

    const { text, sessionId, model, effort, sandbox = 'danger-full-access', approvalPolicy = 'never', callId } = startPayload;
    const response = await rpc(sessionId ? 'thread/resume' : 'thread/start', {
      cwd: process.cwd(),
      ...(model ? { model } : {}),
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
      ...(sandbox && sandbox !== 'inherit' ? { sandbox } : {}),
      ...(approvalPolicy && approvalPolicy !== 'inherit' ? { approvalPolicy } : {}),
      ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false, threadSource: 'automation', allowProviderModelFallback: false }),
    });
    threadId = response.thread?.id;
    if (!threadId) throw new Error('Codex did not return a thread ID');
    emit('session', { sessionId: threadId });
    if (stopping) return finish('stopped');

    const receipt = await rpc('turn/start', {
      threadId,
      input: textInput(text),
      ...(callId ? { clientUserMessageId: callId } : {}),
      ...(response.model ? { model: response.model } : {}),
      ...(response.reasoningEffort ? { effort: response.reasoningEffort } : {}),
    });
    if (receipt?.turn?.id && !turnId) {
      turnId = receipt.turn.id;
      emit('turn', { sessionId: threadId, turnId });
    }
    if (stopping) await interrupt();
  } catch (err) {
    finish('failed', err.message);
  }
}

const stdinRl = createInterface({ input: process.stdin });
let started = false;
let queue = Promise.resolve();
stdinRl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.summonStart && !started) {
    started = true;
    void runBridge(msg.summonStart);
  } else if (msg.summonInput && globalThis.__handleInput) {
    queue = queue.then(() => globalThis.__handleInput(msg.summonInput)).catch(() => {});
  }
});
