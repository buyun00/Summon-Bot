import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { isAbsolute, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeCommand } from '../services/native-host.mjs';
import { guardStillMatches } from '../services/session-processes.mjs';

const [executable, mode, originalThread, originalTurn, originalCall] = process.argv.slice(2);
const windows = process.platform === 'win32';
const mxcUnavailable = 'codex_mxc_unavailable';
// Legacy Windows sandboxing rejects a root-deny profile. Select MXC for this
// adapter process so it can keep the same restricted-read policy.
const sandboxArgs = windows && !mode ? ['-c', 'windows.sandbox=mxc'] : [];
const command = nativeCommand(executable, ['app-server', '--stdio', ...sandboxArgs]);
const server = spawn(command.file, command.args, { ...command.options, cwd: process.cwd(),
  windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
const input = createInterface({ input: process.stdin });
const output = createInterface({ input: server.stdout });
const emit = (type, fields = {}) => process.stdout.write(JSON.stringify({ summonEvent: { type, ...fields } }) + '\n');
const textInput = text => [{ type: 'text', text }];
const requests = new Map(), prompts = new Map();
let nextId = 0, threadId, turnId, finalText, lastMessage, terminal, modelRerouted, ending = false;
let threadSubmitted = false, turnSubmitted = false;
const filesByItem = new Map();
let starting = true, stopping = false, guardDb;

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
  for (const prompt of prompts.values()) {
    if (prompt.inputId) emit('input-result', { inputId: prompt.inputId, status: 'unknown', turnId,
      error: 'Codex ended without acknowledging this response' });
  }
  prompts.clear();
  guardDb?.close();
  if (!mode) emit('outcome', { status, error, code });
  process.exitCode = status === 'completed' || status === 'stopped' ? 0 : 1;
  input.close();
  process.stdin.pause();
  server.stdin.end();
  const timer = setTimeout(() => { if (server.exitCode === null) server.kill(); }, 1_000);
  timer.unref();
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
const deny = choice('decline', '拒绝');
const cancel = choice('cancel', '取消操作');

function nativePrompt(message) {
  const { method, params: p, id } = message;
  if (p?.threadId !== threadId || !turnId || p?.turnId && p.turnId !== turnId)
    return send({ id, error: { code: -32602, message: 'Request is outside this Codex turn' } });
  if (method === 'item/permissions/requestApproval') {
    const permissions = p.permissions || {}, files = permissions.fileSystem;
    const requested = [...(files?.read || []), ...(files?.write || []),
      ...(files?.entries || []).map(entry => entry.path?.path || entry.path?.pattern)].filter(Boolean);
    return { kind: 'approval', choices: [deny, cancel], text: ['Codex 请求扩大当前会话的权限。',
      ...requested, permissions.network?.enabled && '网络访问', p.reason,
      '该请求超出当前会话的执行权限。'].filter(Boolean).join('\n'),
      answer: () => ({ permissions: {}, scope: 'turn' }) };
  }
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    const command = method === 'item/commandExecution/requestApproval';
    const cwd = command && p.cwd ? relative(process.cwd(), p.cwd) : '';
    const scopeChange = p.additionalPermissions || p.networkApprovalContext || p.grantRoot ||
      cwd === '..' || cwd.startsWith('../') || cwd.startsWith('..\\') || isAbsolute(cwd);
    const choices = [!scopeChange && choice('accept', '仅本次允许'), deny, cancel]
      .filter(value => value && (!command || !p.availableDecisions?.length || p.availableDecisions.includes(value.id)));
    if (!choices.length) return send({ id, result: { decision: 'decline' } });
    return { kind: 'approval', choices, text: [command ? 'Codex 请求执行以下命令' : 'Codex 请求批准这项文件修改',
      p.command, ...(!command ? filesByItem.get(p.itemId) || [] : []), p.cwd, p.grantRoot, p.reason].filter(Boolean).join('\n'),
      answer: decision => ({ decision }) };
  }
  if (method === 'item/tool/requestUserInput') {
    const questions = p.questions || [];
    if (!questions.length || questions.some(question => question.isSecret)) return send({ id, result: { answers: {} } });
    const simple = questions.length === 1;
    const choices = simple && !questions[0].isOther ? (questions[0].options || []).map(option => choice(option.label, option.label)) : [];
    const text = questions.map((question, index) => (simple ? '' : (index + 1) + '. ') + question.question +
      (question.options?.length && !choices.length ? '\n' + question.options.map(option => option.label).join(' / ') : '')).join('\n');
    return { kind: 'question', choices, text: text + (simple ? '' : '\n请按题目顺序每行回复一项。'),
      answer: answer => ({ answers: Object.fromEntries(questions.map((question, index) =>
        [question.id, { answers: [simple ? answer : answer.split(/\r?\n/)[index]?.trim() || ''] }])) }) };
  }
  if (method === 'mcpServer/elicitation/request') {
    const form = p.mode !== 'url';
    return { kind: 'question', choices: form ? [] : [choice('accept', '已完成'), deny, cancel],
      text: [p.message, p.url, form ? '请回复所要求的 JSON 表单，或输入「拒绝」。' : '请处理链接中的请求，再回复结果。'].filter(Boolean).join('\n'),
      answer: text => form ? text === '拒绝' ? { action: 'decline', content: null } : { action: 'accept', content: JSON.parse(text) } :
        { action: text, content: null } };
  }
  send({ id, error: { code: -32601, message: 'This Codex app-server request is unsupported' } });
}

function observe(method, p) {
  if (p?.threadId !== threadId) return;
  if (method === 'turn/started') bindTurn(p.turn);
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
    const evidence = { itemId: item.id, turnId, itemType: item.type, status: item.status, exitCode: item.exitCode,
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
  if (method === 'turn/completed' && p.turn?.id === turnId) {
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
  if (message.method && message.id !== undefined) {
    try {
      const prompt = nativePrompt(message);
      if (prompt) {
        const id = String(message.id);
        prompts.set(id, { ...prompt, id: message.id });
        emit('request', { id, turnId, kind: prompt.kind, text: prompt.text, choices: prompt.choices });
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

function disconnected(error) {
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(Object.assign(new Error(error), { unconfirmed: true }));
  }
  requests.clear();
  if (!ending) finish(threadSubmitted || turnSubmitted ? 'unknown' : 'failed', error);
}

server.on('error', error => disconnected(error.message));
server.stdin.on('error', error => disconnected(error.message));
server.on('close', () => disconnected('Codex app-server closed before confirming the outcome'));

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
  if (!opened && !mode && !ending) finish('not_submitted', 'Codex did not receive an initial input');
});

async function initialize() {
  await rpc('initialize', { clientInfo: { name: 'summon-bot', title: 'Summon Bot', version: '1' },
    capabilities: { experimentalApi: true } });
  send({ method: 'initialized' });
  return rpc('account/read', { refreshToken: false });
}

async function checkModel(model, effort) {
  if (!model) return;
  let cursor;
  const cursors = new Set();
  do {
    const page = await rpc('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    const match = page.data.find(item => item.model === model);
    if (match) {
      if (effort && !match.supportedReasoningEfforts?.some(value => value.reasoningEffort === effort))
        throw new Error(`Codex model ${model} does not support reasoning effort ${effort}`);
      return;
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex model list repeated a cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  throw new Error(`Codex did not advertise model ${model}`);
}

async function start({ text, sessionId, scope, callId, model, effort, guard, storePath }) {
  guardDb = new DatabaseSync(storePath, { readOnly: true, timeout: 3000 });
  const { account, requiresOpenaiAuth } = await initialize();
  if (!account && requiresOpenaiAuth)
    return finish('failed', 'Codex CLI 需要登录。请先在部署机运行 codex login。');
  if (windows) {
    // Readiness describes setup. The thread request must still prepare the scoped sandbox.
    const [readiness, effective] = await Promise.all([
      rpc('windowsSandbox/readiness', {}),
      rpc('config/read', { includeLayers: false, cwd: process.cwd() }),
    ]);
    if (readiness.status !== 'ready' || effective.config?.windows?.sandbox !== 'mxc')
      return finish('not_submitted', 'Codex requires Windows MXC for this restricted workspace', mxcUnavailable);
  }
  await checkModel(model, effort);
  if (stopping) return finish('stopped');
  if (!allowed(guard)) return finish('not_submitted', 'Session control or connection access changed before creating the thread');
  const profile = 'summon-session';
  const policy = { permissions: profile, runtimeWorkspaceRoots: [process.cwd()], cwd: process.cwd(), multiAgentMode: 'explicitRequestOnly',
    approvalPolicy: { granular: { sandbox_approval: false, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } },
    approvalsReviewer: 'user' };
  const config = { ...(effort ? { model_reasoning_effort: effort } : {}), web_search: 'disabled',
    default_permissions: profile, permissions: { [profile]: { extends: ':workspace',
    filesystem: { ':minimal': 'read', ':root': 'deny', ':workspace_roots': { '.': scope.workspaceMode, '.git': 'read', '.codex': 'read',
      '.agents': 'read', '.aws': 'deny', '.env': 'deny', '.ssh': 'deny' },
      ...scope.filesystem },
    network: { enabled: false } } } };
  if (!sessionId) {
    threadSubmitted = true;
    emit('thread-submitting');
  }
  let response;
  try {
    response = await rpc(sessionId ? 'thread/resume' : 'thread/start', { ...policy, config, ...(model ? { model } : {}),
      ...(sessionId ? { threadId: sessionId, excludeTurns: true } : { ephemeral: false, threadSource: 'automation', allowProviderModelFallback: false }) });
  } catch (error) {
    if (windows && !error.unconfirmed && (error.message.includes('native MXC is unavailable on this executor') ||
        error.message.includes('this Windows build cannot enforce native MXC deny paths')))
      return finish('failed', error.message, mxcUnavailable);
    throw error;
  }
  if (!response.thread?.id || sessionId && response.thread.id !== sessionId)
    throw new Error('Codex did not confirm the intended thread');
  threadId = response.thread.id;
  const scoped = response.activePermissionProfile?.id === profile && response.cwd && relative(process.cwd(), response.cwd) === '';
  const matched = (!model || response.model === model) && (!effort || response.reasoningEffort === effort);
  emit('session', { sessionId: threadId, model: response.model, effort: response.reasoningEffort, bindingRejected: !scoped || !matched });
  if (!scoped)
    throw new Error('Codex did not apply the scoped permissions profile and working directory');
  if (!matched)
    throw new Error(`Codex applied ${response.model || '(unknown model)'} / ${response.reasoningEffort || '(unknown effort)'} instead of the requested binding`);
  if (sessionId && response.thread.status?.type === 'active') {
    emit('thread-active', { sessionId: threadId });
    return finish('unknown', 'The original Codex thread is still active');
  }
  if (stopping) return finish('stopped');
  if (!allowed(guard)) return finish('not_submitted', 'Session control or connection access changed before starting the turn');
  turnSubmitted = true;
  emit('turn-submitting', { sessionId: threadId });
  const receipt = await rpc('turn/start', { ...policy, threadId, input: textInput(text), clientUserMessageId: callId,
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
