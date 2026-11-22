import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appServerArgs } from '../connectors/codex.mjs';
import { nativeCommand, nativeSpawnFailureCode } from '../services/native-host.mjs';
import { guardStillMatches } from '../services/session-processes.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';

const [executable, action, ...launchArgs] = process.argv.slice(2);
const mode = action === 'history' ? action : undefined;
const [originalThread, originalTurn, originalCall, historyStdio, ...historyArgs] = mode ? launchArgs : [];
const command = nativeCommand(executable, [...appServerArgs(mode ? historyStdio : action), ...(mode ? historyArgs : launchArgs)]);
const server = spawn(command.file, command.args, { ...command.options, cwd: process.cwd(),
  windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
server.stderr.pipe(process.stderr, { end: false });
const input = createInterface({ input: process.stdin });
const output = createInterface({ input: server.stdout });
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...fields } }) + '\n');
const textInput = text => [{ type: 'text', text }];
const requests = new Map(), prompts = new Map(), asyncItems = new Set();
let nextId = 0, threadId, turnId, finalText, lastMessage, terminal, modelRerouted, ending = false;
let threadSubmitted = false, turnSubmitted = false;
let asyncCalls = 0;
let serverClosed = false, shutdownTimer;
const filesByItem = new Map();
let starting = true, stopping = false, requireReadOnly = false, guardDb;

function allowed(guard) {
  try { return guardStillMatches(guardDb, guard); } catch { return false; }
}

function send(message) {
  if (!server.stdin.writable) throw new Error('Codex app-server stdin is closed');
  server.stdin.write(JSON.stringify(message) + '\n');
}

function rpc(method, params, timeoutMs = 20_000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(Object.assign(new Error(method + ' response timed out'), { unconfirmed: true }));
    }, timeoutMs);
    requests.set(id, { resolve, reject, timer });
    try { send({ id, method, params }); }
    catch (error) { clearTimeout(timer); requests.delete(id); reject(error); }
  });
}

function finish(status, error, code) {
  if (ending) return;
  ending = true;
  if (asyncCalls > asyncItems.size)
    emit('progress', { turnId, text: 'Codex 记录了异步提问调用，本轮未收到对应的可定位题文。可在原会话续投，要求 Codex 使用同步提问。' });
  for (const [id, prompt] of prompts) {
    if (prompt.asyncItem) {
      emit('withdrawn', { id });
      if (!prompt.inputId) emit('progress', { turnId, text: '该异步问题的 Codex 回合已结束。可将尚未提交的答复作为该会话的下一条输入。' });
    } else if (prompt.inputId) emit('input-result', { inputId: prompt.inputId, status: 'unknown', turnId,
      error: 'Codex ended without acknowledging this response' });
  }
  prompts.clear();
  guardDb?.close();
  if (!mode) emit('outcome', { status, error, code });
  process.exitCode = status === 'completed' || status === 'stopped' ? 0 : 1;
  input.close();
  process.stdin.destroy();
  if (serverClosed) return;
  server.stdin.end();
  // Allow outstanding RPC replies to drain, then terminate the entire app-server
  // process tree (e.g. cmd.exe -> node codex.js -> codex.exe on Windows) so no
  // descendant survives after the bridge exits.
  shutdownTimer = setTimeout(() => {
    const cleanup = !serverClosed ? terminateTree(server).catch(() => {}) : Promise.resolve();
    void cleanup.finally(() => {
      output.close();
      server.stdin.destroy();
      server.stdout.destroy();
      server.stderr.destroy();
      disconnected('Codex app-server transport closed before acknowledging the request');
    });
  }, 1_000);
}

function bindTurn(turn) {
  if (!turn?.id || turnId && turnId !== turn.id) return;
  if (!turnId) {
    turnId = turn.id;
    starting = false;
    emit('turn', { sessionId: threadId, turnId, startedAt: turn.startedAt && new Date(turn.startedAt * 1_000).toISOString() });
  }
}

const choice = (id, label) => ({ id, label });
const accept = choice('accept', '仅本次允许');
const deny = choice('decline', '拒绝');
const cancel = choice('cancel', '取消操作');

function nativePrompt(message) {
  const { method, params: p, id } = message;
  if (p?.threadId !== threadId || !turnId || p?.turnId && p.turnId !== turnId)
    return send({ id, error: { code: -32602, message: 'Request is outside this Codex turn' } });
  if (method === 'item/permissions/requestApproval') {
    const permissions = p.permissions || {};
    const text = ['Codex 请求本轮权限', JSON.stringify(permissions), p.cwd, p.reason].filter(Boolean).join('\n');
    const choices = !requireReadOnly && Object.keys(permissions).length && text.length <= 4_000 ? [accept, deny, cancel] : [deny, cancel];
    return { kind: 'approval', choices, text, answer: decision => ({ permissions: decision === 'accept' ? permissions : {}, scope: 'turn' }) };
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const command = method === 'item/commandExecution/requestApproval';
    const network = p.networkApprovalContext;
    const text = [network ? 'Codex 请求访问网络' : command ? 'Codex 请求执行以下命令' : 'Codex 请求批准这项文件修改',
      network ? [network.protocol, network.host].filter(Boolean).join(' ') : p.command,
      ...(!command ? filesByItem.get(p.itemId) || [] : []), p.cwd, p.grantRoot,
      p.additionalPermissions && JSON.stringify(p.additionalPermissions), p.reason].filter(Boolean).join('\n');
    const choices = (!requireReadOnly && text.length <= 4_000 ? [accept, deny, cancel] : [deny, cancel])
      .filter(value => !command || p.availableDecisions == null ||
        Array.isArray(p.availableDecisions) && p.availableDecisions.includes(value.id));
    if (!choices.length) return send({ id, error: { code: -32602, message: 'No native approval decision is available in this session' } });
    return { kind: 'approval', choices, text, answer: decision => ({ decision }) };
  }
  if (method === 'item/tool/requestUserInput') {
    const supplied = Array.isArray(p.questions) ? p.questions : [];
    const questions = supplied.filter(question => question?.isSecret !== true);
    const secretInputUnavailable = questions.length !== supplied.length;
    if (!questions.length) {
      const reason = secretInputUnavailable ? '当前会话没有接收保密回答的通道。' : 'Codex 未提供可回答的问题。';
      emit('progress', { turnId, text: reason });
      return send({ id, error: { code: -32602, message: reason } });
    }
    if (questions.some(question => typeof question?.id !== 'string' || !question.id ||
        typeof question.question !== 'string' || !question.question ||
        question.options != null && (!Array.isArray(question.options) ||
          question.options.some(option => typeof option?.label !== 'string' || !option.label))) ||
        new Set(questions.map(question => question.id)).size !== questions.length) {
      return send({ id, error: { code: -32602, message: 'Codex returned an invalid question or option' } });
    }
    const simple = questions.length === 1;
    const choices = simple && !questions[0].isOther
      ? (questions[0].options || []).map(option => choice(option.label, option.label)) : [];
    const text = questions.map((question, index) => (simple ? '' : (index + 1) + '. ') + question.question +
      (question.options?.length && !choices.length ? '\n' + question.options.map(option => option.label).join(' / ') : '')).join('\n');
    return { kind: 'question', choices, answer_format: simple ? (choices.length ? 'choice_id' : 'text') : 'one_answer_per_line',
      plain_text: simple && !secretInputUnavailable && (!questions[0].options?.length || questions[0].isOther === true),
      text: [text, !simple && '请按题目顺序每行回复一项。', secretInputUnavailable && '保密问题需要使用支持保密输入的通道。']
        .filter(Boolean).join('\n'),
      answer: answer => {
        const values = simple ? [answer] : answer.split(/\r?\n/);
        if (values.length !== questions.length || questions.some((question, index) => !values[index]?.trim() ||
            !question.isOther && question.options?.length && !question.options.some(option => option.label === values[index]))) {
          throw new Error('请为每个显示的问题提供一个有效回答，并使用原选项文字。');
        }
        return { answers: Object.fromEntries(questions.map((question, index) => [question.id, { answers: [values[index]] }])) };
      } };
  }
  if (method === 'mcpServer/elicitation/request') {
    const form = p.mode !== 'url';
    return { kind: 'question', choices: form ? [] : [choice('accept', '已完成'), deny, cancel], answer_format: form ? 'json_text' : 'choice_id',
      text: [p.message, p.url, form ? '请回复所要求的 JSON 表单，或输入「拒绝」。' : '请处理链接中的请求，再回复结果。'].filter(Boolean).join('\n'),
      answer: text => {
        if (!form) return { action: text, content: null };
        if (text === '拒绝') return { action: 'decline', content: null };
        const invalid = '请提供有效的 JSON 对象，或输入「拒绝」。';
        let content;
        try { content = JSON.parse(text); } catch { throw new Error(invalid); }
        if (!content || typeof content !== 'object' || Array.isArray(content)) throw new Error(invalid);
        return { action: 'accept', content };
      } };
  }
  send({ id, error: { code: -32601, message: 'This Codex app-server request is unsupported' } });
}

function observe(method, p) {
  if (p?.threadId !== threadId) return;
  if (method === 'turn/started' && turnSubmitted) bindTurn(p.turn);
  if (method === 'model/rerouted' && p.turnId === turnId && p.fromModel !== p.toModel) {
    modelRerouted = { from: p.fromModel, to: p.toModel, reason: p.reason };
    emit('model-rerouted', { turnId, ...modelRerouted });
    stopping = true;
    void interrupt();
  }
  if (method === 'serverRequest/resolved') {
    const key = String(p.requestId), prompt = prompts.get(key);
    if (prompt) {
      emit(prompt.inputId ? 'resolved' : 'withdrawn', { id: key });
      if (prompt.inputId) emit('input-result', { inputId: prompt.inputId, status: 'accepted', turnId });
      prompts.delete(key);
    }
  }
  if (method === 'item/started' || method === 'item/completed') {
    if (!turnId || p.turnId !== turnId) return;
    const { item } = p, completed = method === 'item/completed';
    if (completed && item.type === 'functionCallOutput' && item.name === 'request_user_input_async') {
      asyncCalls++;
      if (asyncCalls > asyncItems.size)
        emit('progress', { turnId, text: '目前仅收到 Codex 的异步提问调用，仍在等待可答的原题。需要立即答复时，可请原执行者改用带真实备选、允许自填的同步表单。' });
    }
    if (item.type === 'agentMessage' && item.delivery === 'async' && item.questions?.length) {
      // An async question is a ThreadItem, not a server JSON-RPC request.
      // Its reply is a normal steer to the same live turn.
      const id = 'async/' + item.id;
      if (asyncItems.has(id)) return;
      const questions = item.questions;
      if (typeof item.id !== 'string' || !item.id || !questions.every(q => typeof q?.title === 'string' && q.title.trim() &&
          (q.options == null || Array.isArray(q.options) && q.options.every(s => typeof s === 'string')))) {
        emit('progress', { turnId, text: 'Codex 异步问题没有可用的原题标识或题文。请在原会话使用同步提问。' });
        return;
      }
      const simple = questions.length === 1;
      asyncItems.add(id);
      const text = questions.map((q, i) => (simple ? '' : (i + 1) + '. ') + q.title +
        (q.options?.length ? '\n' + q.options.join(' / ') + '（也可自填）' : '')).join('\n');
      prompts.set(id, { asyncItem: item.id, questions });
      emit('request', { id, turnId, kind: 'question', text: text + (simple ? '' : '\n请按题目顺序每行回复一项。'),
        choices: [], plain_text: simple, answer_format: simple ? 'text' : 'one_answer_per_line' });
      return;
    }
    const evidence = { itemId: item.id, turnId, itemType: item.type, tool: item.tool, status: item.status, exitCode: item.exitCode,
      command: item.command, files: item.changes?.map(change => change.path), output: item.aggregatedOutput?.slice(-5_000) };
    if (item.type === 'fileChange') filesByItem.set(item.id, evidence.files || []);
    if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(item.type))
      emit('item', { ...evidence, phase: completed ? 'completed' : 'started' });
    if (completed && item.type === 'agentMessage' && item.text) {
      lastMessage = { itemId: item.id, text: item.text };
      if (item.phase === 'final_answer') finalText = lastMessage;
      else if (item.phase === 'commentary' || item.phase === 'partial_answer')
        emit('progress', { ...lastMessage, turnId, phase: item.phase });
    }
  }
  if (method === 'turn/completed' && turnId && p.turn?.id === turnId) {
    terminal = p.turn;
    const final = finalText || lastMessage;
    if (final?.text) emit('result', { ...final, turnId, confirmed: terminal.status === 'completed' && !modelRerouted });
    finish(modelRerouted ? 'failed' : { completed: 'completed', interrupted: 'stopped', failed: 'failed' }[terminal.status] || 'unknown',
      modelRerouted ? `Codex reported a model change from ${modelRerouted.from} to ${modelRerouted.to}` : terminal.error?.message);
  }
}

output.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.stderr.write(line + '\n'); return; }
  if (ending && message.method) return;
  if (message.method && message.id !== undefined) {
    try {
      const prompt = nativePrompt(message);
      if (prompt) {
        const id = String(message.id);
        prompts.set(id, { ...prompt, id: message.id });
        emit('request', { id, turnId, kind: prompt.kind, text: prompt.text, choices: prompt.choices,
          plain_text: prompt.plain_text === true, answer_format: prompt.answer_format || 'choice_id' });
      }
    } catch (error) { send({ id: message.id, error: { code: -32602, message: error.message } }); }
  } else if (message.method) observe(message.method, message.params);
  else {
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || 'Codex app-server refused the request'));
    else request.resolve(message.result);
  }
});

function disconnected(error, code) {
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(Object.assign(new Error(error), { unconfirmed: true }));
  }
  requests.clear();
  if (!ending) finish(threadSubmitted || turnSubmitted ? 'unknown' : 'failed', error, code);
}

server.on('error', error => disconnected(error.message, !server.pid && !stopping ? nativeSpawnFailureCode(error) : undefined));
server.stdin.on('error', error => disconnected(error.message));
server.once('close', () => {
  serverClosed = true;
  clearTimeout(shutdownTimer);
  disconnected('Codex app-server closed before confirming the outcome');
});

async function interrupt() {
  if (turnId && !ending) await rpc('turn/interrupt', { threadId, turnId }).catch(error => process.stderr.write(error.message + '\n'));
}

async function processInput({ type, id, requestId, expectedTurnId, guard, text }) {
  if (type === 'stop') { stopping = true; await interrupt(); return; }
  if (!allowed(guard))
    return emit('input-result', { inputId: id, status: 'not_submitted', turnId, error: 'Session control or connection access changed before input submission' });
  if (!turnId || expectedTurnId !== turnId || terminal || stopping || ending || starting)
    return emit('input-result', { inputId: id, status: 'rejected', turnId, error: 'The requested Codex turn is no longer accepting input' });
  if (type === 'answer') {
    const prompt = prompts.get(requestId);
    if (!prompt || prompt.inputId) return emit('input-result', { inputId: id, status: 'rejected', turnId, error: 'The Codex request has already been answered or ended' });
    if (prompt.asyncItem) {
      const values = prompt.questions.length === 1 ? [text] : text.split(/\r?\n/);
      if (values.length !== prompt.questions.length || values.some(value => !value.trim()))
        return emit('input-result', { inputId: id, status: 'rejected', turnId, error: '请按原问题顺序填写每项回答。' });
      prompt.inputId = id;
      try {
        const answer = prompt.questions.map((q, i) => q.title + '\n' + values[i]).join('\n\n');
        const receipt = await rpc('turn/steer', { threadId, expectedTurnId, input: textInput(answer), clientUserMessageId: id });
        if (receipt?.turnId !== expectedTurnId) throw Object.assign(new Error('Codex did not confirm the question’s turn'), { unconfirmed: true });
        prompts.delete(requestId);
        emit('resolved', { id: requestId });
        emit('input-result', { inputId: id, status: 'accepted', turnId });
      } catch (error) {
        if (!error.unconfirmed) delete prompt.inputId;
        emit('input-result', { inputId: id, status: error.unconfirmed ? 'unknown' : 'rejected', turnId, error: error.message });
      }
      return;
    }
    try {
      const result = prompt.answer(text);
      prompt.inputId = id;
      send({ id: prompt.id, result });
    } catch (error) { emit('input-result', { inputId: id, status: prompt.inputId ? 'unknown' : 'rejected', turnId, error: error.message }); }
    return;
  }
  try {
    const receipt = await rpc('turn/steer', { threadId, expectedTurnId: turnId, input: textInput(text), clientUserMessageId: id });
    if (receipt?.turnId !== turnId) throw Object.assign(new Error('Unexpected Codex steer receipt'), { unconfirmed: true });
    emit('input-result', { inputId: id, status: 'accepted', turnId });
  } catch (error) { emit('input-result', { inputId: id, status: error.unconfirmed ? 'unknown' : 'rejected', turnId, error: error.message }); }
}

let commandQueue = Promise.resolve();
let opened;
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.summonStart && !opened && !mode) {
    opened = start(message.summonStart).catch(error => {
      finish((threadSubmitted || turnSubmitted) && error.unconfirmed ? 'unknown' : 'failed', error.message);
    });
    return;
  }
  if (message.summonInput) commandQueue = commandQueue.then(() => processInput(message.summonInput))
    .catch(error => process.stderr.write(error.message + '\n'));
});
input.on('close', () => {
  if (mode || ending) return;
  if (!opened) finish('not_submitted', 'Codex did not receive an initial input');
  else finish(threadSubmitted || turnSubmitted ? 'unknown' : 'stopped', 'Codex supervisor input closed unexpectedly');
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    if (!ending) finish('stopped', `Codex bridge received ${sig}`);
  });
}

async function initialize() {
  await rpc('initialize', { clientInfo: { name: 'summon-bot', title: 'Summon Bot', version: '1' },
    capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
}

async function start({ text, sessionId, readOnly = false, callId, model, effort, guard, storePath }) {
  requireReadOnly = readOnly;
  guardDb = new DatabaseSync(storePath, { readOnly: true, timeout: 3000 });
  await initialize();
  if (stopping) return finish('stopped');
  if (!allowed(guard)) return finish('not_submitted', 'Session control or connection access changed before creating the thread');
  const cwd = process.cwd();
  const binding = { ...(model ? { model } : {}), ...(effort ? { config: { model_reasoning_effort: effort } } : {}) };
  const workspacePolicy = readOnly ? { sandbox: 'read-only', approvalPolicy: 'never' } : {};
  const method = sessionId ? 'thread/resume' : 'thread/start';
  threadSubmitted = true;
  emit('thread-submitting', { method, ...workspacePolicy });
  const response = await rpc(method, { cwd, ...binding, ...workspacePolicy,
    ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false, threadSource: 'automation', allowProviderModelFallback: false }) });
  if (!response.thread?.id || sessionId && response.thread.id !== sessionId)
    throw new Error('Codex did not confirm the intended thread');
  threadId = response.thread.id;
  const cwdMatched = typeof response.cwd === 'string' && isAbsolute(response.cwd) && relative(cwd, response.cwd) === '';
  const readOnlyMatched = !readOnly || response.sandbox?.type === 'readOnly' &&
    (response.approvalPolicy === 'never' || response.approvalsReviewer === 'user');
  const matched = (!model || response.model === model) && (!effort || response.reasoningEffort === effort);
  emit('session', { sessionId: threadId, model: response.model, effort: response.reasoningEffort,
    ...(readOnly && { sandbox: response.sandbox?.type, approvalPolicy: response.approvalPolicy }),
    bindingRejected: !cwdMatched || !matched || !readOnlyMatched });
  if (sessionId && response.thread.status?.type === 'active') {
    emit('thread-active', { sessionId: threadId });
    return finish('unknown', 'The original Codex thread is still active');
  }
  if (!cwdMatched) throw new Error('Codex did not confirm the selected working directory');
  if (!matched)
    throw new Error(`Codex applied ${response.model || '(unknown model)'} / ${response.reasoningEffort || '(unknown effort)'} instead of the requested binding`);
  if (!readOnlyMatched)
    return finish('unsupported', 'Codex did not confirm a read-only sandbox without automatic approval for this workspace');
  if (stopping) return finish('stopped');
  if (!allowed(guard)) return finish('not_submitted', 'Session control or connection access changed before starting the turn');
  turnSubmitted = true;
  emit('turn-submitting', { sessionId: threadId });
  const receipt = await rpc('turn/start', { threadId, input: textInput(text), clientUserMessageId: callId,
    ...(response.model ? { model: response.model } : {}), ...(response.reasoningEffort ? { effort: response.reasoningEffort } : {}) });
  bindTurn(receipt.turn);
  if (!turnId) return finish('unknown', 'Codex did not confirm the turn identity');
  if (stopping) await interrupt();
}

if (mode === 'history') {
  initialize().then(async () => {
    const { thread } = await rpc('thread/read', { threadId: originalThread, includeTurns: true });
    if (thread?.id !== originalThread) throw new Error('Codex did not return the original thread');
    const turn = thread.turns?.find(item => originalTurn ? item.id === originalTurn :
      item.items?.some(message => message.type === 'userMessage' && originalCall && message.clientId === originalCall));
    const messages = turn?.items?.filter(item => item.type === 'agentMessage' && item.text) || [];
    const final = messages.findLast(item => item.phase === 'final_answer') || messages.at(-1);
    process.stdout.write(JSON.stringify({ threadId: thread.id, threadStatus: thread.status?.type, model: thread.model,
      effort: thread.reasoningEffort, ...(turn ? { turnId: turn.id, turnStatus: turn.status,
        error: turn.error?.message, text: final?.text?.slice(0, 16000) } : {}) }) + '\n');
    finish('completed');
  }).catch(error => { process.stderr.write(error.message + '\n'); finish('failed'); });
}
