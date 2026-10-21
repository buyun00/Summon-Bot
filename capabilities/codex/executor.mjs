import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';

const BUSY = new Set(['running', 'waiting']);
const iso = () => new Date().toISOString();
const inputText = text => [{ type: 'text', text, text_elements: [] }];
const asText = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');

function commandFor(configured) {
  if (Array.isArray(configured)) return configured;
  if (configured) return [configured];
  const executable = process.platform === 'win32' && join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  return [executable && existsSync(executable) ? executable : 'codex'];
}

class RpcProcess extends EventEmitter {
  constructor(command, cwd) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.buffer = '';
    this.stderr = '';
    this.child = spawn(command[0], [...command.slice(1), 'app-server', '--stdio'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      this.buffer += chunk;
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); }
        catch { this.emit('protocolError', 'Codex returned invalid JSON on stdout'); continue; }
        if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
        else if (this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          message.error ? pending.reject(new Error(message.error.message || 'Codex RPC error')) : pending.resolve(message.result);
        }
      }
    });
    // Do not persist raw stderr: third-party tools can put credentials in diagnostics.
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`Codex app-server exited (${code ?? signal})`));
    });
  }

  write(message) {
    if (this.closed || this.child.stdin.destroyed) throw new Error('Codex connection is closed');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 60000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  reply(id, result) { this.write({ jsonrpc: '2.0', id, result }); }

  fail(error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    this.emit('failure', error);
  }

  close() {
    this.closePromise ||= this.closeProcess();
    return this.closePromise;
  }

  async closeProcess() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Codex connection closed'));
    const pid = this.child.pid;
    if (pid && this.child.exitCode === null) {
      if (process.platform === 'win32') {
        await new Promise(resolveClose => {
          const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', resolveClose);
          killer.once('exit', resolveClose);
        });
      } else this.child.kill('SIGTERM');
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
  }
}

const CONSULT_TOOL = {
  type: 'function', name: 'relay_consult',
  description: 'Ask the delegating Relay Bot or a named colleague for project facts or a decision while working. The reply is returned to this tool so work can continue. Do not ask the human to relay routine questions.',
  inputSchema: {
    type: 'object', properties: { question: { type: 'string' }, targetBotId: { type: 'string', description: 'Optional colleague ID; omit for the delegating Bot.' } },
    required: ['question'], additionalProperties: false,
  },
};

const EXECUTOR_INSTRUCTIONS = `You are the professional executor for a Relay Bot work order. The human is the final authority and all Relay Bots are peers. Stay within the supplied work order. Keep this execution session separate from social chat. Use relay_consult when a project fact or clarification is needed; the Relay Bot can contact a colleague. Do not commit, push, publish, or change branches unless the work order explicitly authorizes that. Preserve unrelated existing changes. Report progress concisely. Your final response must distinguish actual changes and verification from unverified limitations, and list relevant files or artifacts. Never claim a test or integration passed without observing it.`;

export class CodexExecutor {
  constructor({ store, emit = () => {}, consult, onResult = () => {}, defaultCwd = process.cwd(), codexPath, executionLock } = {}) {
    if (!store) throw new Error('CodexExecutor requires a store');
    Object.assign(this, { store, emit, consult, onResult, defaultCwd, executionLock });
    this.command = commandFor(codexPath || process.env.RELAY_CODEX_PATH);
    this.active = null;
    this.started = false;
    this.stopping = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    for (const work of this.list()) {
      if (BUSY.has(work.status)) {
        this.save({ ...work, status: 'interrupted', error: 'Relay restarted before execution completion was confirmed. Resume explicitly to continue the saved Codex thread.' });
        this.event(work.id, 'interrupted', { reason: 'service_restart' });
      }
    }
    this.pump();
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    const active = this.active;
    if (active) {
      active.stopping = true;
      active.lockController?.abort();
      const work = this.store.get('works', active.id);
      if (work && BUSY.has(work.status)) {
        this.save({ ...work, status: 'interrupted', error: 'Relay stopped. The saved Codex thread can be resumed explicitly.' });
        this.event(active.id, 'interrupted', { reason: 'service_stop' });
      }
      active.finish?.();
      active.pendingQuestion?.complete?.();
      await active.rpc?.close();
      await active.done;
    }
  }

  list() { return this.store.list('works'); }
  get(id) {
    const work = this.store.get('works', id);
    return work ? { ...work, events: this.store.list('workEvents').filter(event => event.workId === id) } : null;
  }
  save(work) { const saved = this.store.save('works', work); this.emit('work', saved); return saved; }
  event(workId, type, data = {}) {
    const event = this.store.save('workEvents', { workId, type, data });
    this.emit('workEvent', event);
    return event;
  }
  require(id) { const work = this.store.get('works', id); if (!work) throw new Error('Work not found'); return work; }

  create(input = {}) {
    if (input.sourceActionId) {
      const existing = this.list().find(work => work.sourceActionId === input.sourceActionId);
      if (existing) return existing;
    }
    const goal = String(input.goal || '').trim();
    if (!goal) throw new Error('Work goal is required');
    const requestedTimeout = input.timeoutSeconds == null ? 1800 : Number(input.timeoutSeconds);
    if (!Number.isFinite(requestedTimeout)) throw new Error('Work timeoutSeconds must be a number');
    const timeoutSeconds = Math.max(30, requestedTimeout);
    const cwd = resolve(input.cwd || this.defaultCwd);
    if (!existsSync(cwd)) throw new Error('Work directory does not exist');
    const work = this.save({ botId: input.botId || null, roomId: input.roomId || null, goal, cwd,
      constraints: input.constraints || '', inputRefs: input.inputRefs || [], status: 'queued',
      sourceActionId: input.sourceActionId || null, sourceMessageId: input.sourceMessageId || null,
      timeoutSeconds,
      threadId: null, turnId: null, summary: '', error: null, question: null,
    });
    this.event(work.id, 'queued', { goal, cwd });
    this.pump();
    return work;
  }

  async cancel(id) {
    let work = this.require(id);
    if (['completed', 'failed', 'cancelled'].includes(work.status)) return work;
    const active = this.active?.id === id ? this.active : null;
    if (active) {
      active.stopping = true;
      active.lockController?.abort();
      if (work.threadId && work.turnId) {
        try { await active.rpc.request('turn/interrupt', { threadId: work.threadId, turnId: work.turnId }, 10000); this.event(id, 'interrupt_acknowledged'); }
        catch (error) { this.event(id, 'interrupt_error', { message: error.message }); }
      }
      active.finish?.();
      active.pendingQuestion?.complete?.();
      await active.rpc?.close();
    }
    work = this.save({ ...this.require(id), status: 'cancelled', finishedAt: iso(), error: null });
    this.event(id, 'cancelled');
    if (active && this.active === active) this.active = null;
    this.pump();
    return work;
  }

  async resume(id, input = {}) {
    let work = this.require(id);
    const content = typeof input === 'string' ? input : input.content || input.goal || input.constraints || '';
    if (BUSY.has(work.status)) {
      if (!content) throw new Error('This work is already active');
      if (!this.active || this.active.id !== id || !work.turnId) throw new Error('Work is starting; try adding the update after the turn starts');
      await this.active.rpc.request('turn/steer', { threadId: work.threadId, expectedTurnId: work.turnId, input: inputText(String(content)) });
      this.event(id, 'steered', { content: String(content) });
      return this.require(id);
    }
    if (work.status === 'queued') return work;
    work = this.save({ ...work, status: 'queued', resumeInput: String(content), error: null, finishedAt: null });
    this.event(id, 'resume_queued', { content: String(content), threadId: work.threadId });
    this.pump();
    return work;
  }

  async answer(id, input = {}) {
    const text = String(input.answer || input.content || '').trim();
    if (!text) throw new Error('Answer is required');
    const work = this.require(id);
    if (!work.question) throw new Error('No pending question for this work');
    const active = this.active?.id === id ? this.active : null;
    if (active?.pendingQuestion) return this.resolveQuestion(active, text, 'user');
    const saved = this.save({ ...work, question: { ...work.question, answer: text, status: 'answered', answeredAt: iso() } });
    this.event(id, 'consult_answer', { answer: text, source: 'user', connectionActive: false });
    return saved;
  }

  pump() {
    if (!this.started || this.stopping || this.active) return;
    const next = this.list().find(work => work.status === 'queued');
    if (!next) return;
    const active = { id: next.id, stopping: false, rpc: null, finish: null, pendingQuestion: null, requestTasks: new Set(), questionChain: Promise.resolve(), lockController: new AbortController() };
    let complete;
    active.done = new Promise(resolveDone => { complete = resolveDone; });
    this.active = active;
    queueMicrotask(async () => { try { await this.run(active); } finally { complete(); } });
  }

  async run(active) {
    try {
      if (active.stopping || this.stopping) return;
      // Hold the same local mutation lock used by Bot write/edit/command tools.
      active.releaseExecution = await this.executionLock?.acquire(`codex:${active.id}`, active.lockController.signal);
      if (active.stopping || this.stopping) return;
      let work = this.save({ ...this.require(active.id), status: 'running', turnId: null, startedAt: iso(), error: null });
      const timeoutSeconds = Number(work.timeoutSeconds) > 0 ? Number(work.timeoutSeconds) : 1800;
      active.timeoutTimer = setTimeout(() => {
        const current = this.require(active.id);
        if (active.stopping || !BUSY.has(current.status)) return;
        active.stopping = true;
        const message = `Work exceeded its ${timeoutSeconds}-second time limit. Resume explicitly to continue the saved Codex thread.`;
        this.save({ ...current, status: 'interrupted', error: message, finishedAt: iso() });
        this.event(active.id, 'timeout', { timeoutSeconds, message });
        active.pendingQuestion?.complete?.();
        active.finish?.();
        void active.rpc?.close();
      }, timeoutSeconds * 1000);
      const rpc = active.rpc = new RpcProcess(this.command, work.cwd);
      let resolveDone;
      const done = new Promise(resolveDone_ => { resolveDone = resolveDone_; });
      active.finish = resolveDone;
      rpc.on('failure', error => {
        if (!active.stopping) {
          const current = this.require(active.id);
          if (BUSY.has(current.status)) {
            this.save({ ...current, status: 'interrupted', error: error.message });
            this.event(active.id, 'connection_lost', { message: error.message });
          }
        }
        resolveDone();
      });
      rpc.on('protocolError', message => this.event(active.id, 'protocol_error', { message }));
      rpc.on('notification', message => this.notification(active, message));
      rpc.on('request', message => {
        const isQuestion = message.method === 'item/tool/call' || message.method === 'item/tool/requestUserInput';
        const runRequest = () => this.serverRequest(active, message);
        const task = (isQuestion ? active.questionChain.then(runRequest) : runRequest()).catch(error => {
          if (!active.stopping) this.event(active.id, 'request_error', { message: error.message });
        });
        if (isQuestion) active.questionChain = task;
        active.requestTasks.add(task);
        task.finally(() => active.requestTasks.delete(task));
      });
      await rpc.request('initialize', { clientInfo: { name: 'relay_bot', title: 'Relay Bot', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.write({ jsonrpc: '2.0', method: 'initialized' });
      if (active.stopping) return;
      const resuming = Boolean(work.threadId);
      const params = resuming
        ? { threadId: work.threadId, cwd: work.cwd, approvalPolicy: 'never', sandbox: 'workspace-write' }
        : { cwd: work.cwd, approvalPolicy: 'never', sandbox: 'workspace-write', developerInstructions: EXECUTOR_INSTRUCTIONS, dynamicTools: [CONSULT_TOOL] };
      const response = await rpc.request(resuming ? 'thread/resume' : 'thread/start', params);
      work = this.save({ ...this.require(work.id), threadId: response.thread.id, model: response.model, reasoningEffort: response.reasoningEffort });
      this.event(work.id, resuming ? 'thread_resumed' : 'thread_started', { threadId: work.threadId, model: response.model, reasoningEffort: response.reasoningEffort });
      if (active.stopping) return;
      let prompt;
      if (resuming) {
        prompt = `Continue this saved Relay work session. The previous connection ended; inspect actual current files and recorded results before continuing. Do not blindly repeat completed operations. Original goal: ${work.goal}\n`;
        if (work.question) prompt += `Previous consultation: ${work.question.text}\nKnown answer: ${work.question.answer || 'No answer was received; consult the Relay Bot again if needed.'}\n`;
        prompt += work.resumeInput || 'Continue the remaining work and report actual results.';
      } else prompt = `Relay work order\nGoal: ${work.goal}\nWorking directory: ${work.cwd}\nDelegating Bot: ${work.botId || 'unspecified'}\nConstraints: ${asText(work.constraints)}\nInput references: ${asText(work.inputRefs)}\nUse relay_consult for missing project facts. Keep progress and the final answer grounded in actual observations.`;
      const turn = await rpc.request('turn/start', { threadId: work.threadId, input: inputText(prompt) });
      if (turn?.turn?.id) this.save({ ...this.require(work.id), turnId: turn.turn.id });
      await done;
    } catch (error) {
      if (!active.stopping) {
        const work = this.require(active.id);
        const status = work.status === 'interrupted' && work.threadId ? 'interrupted' : 'failed';
        this.save({ ...work, status, error: error.message, finishedAt: iso() });
        this.event(active.id, status, { message: error.message });
      }
    } finally {
      clearTimeout(active.timeoutTimer);
      active.stopping = true;
      active.pendingQuestion?.complete?.();
      await active.rpc?.close();
      await Promise.allSettled([...active.requestTasks]);
      active.releaseExecution?.();
      if (this.active === active) this.active = null;
      const work = this.require(active.id);
      if (['completed', 'failed'].includes(work.status)) {
        try { await this.onResult(work); }
        catch (error) { this.event(work.id, 'result_delivery_error', { message: error.message }); }
      }
      this.pump();
    }
  }

  notification(active, { method, params = {} }) {
    if (active.stopping) return;
    const work = this.require(active.id);
    if (params.threadId && work.threadId && params.threadId !== work.threadId) return;
    if (method === 'turn/started') this.save({ ...work, turnId: params.turn.id });
    else if (method === 'item/agentMessage/delta') this.event(work.id, 'message_delta', { text: params.delta, itemId: params.itemId });
    else if (method === 'item/commandExecution/outputDelta') this.event(work.id, 'command_output', { text: params.delta, itemId: params.itemId });
    else if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      this.event(work.id, method === 'item/started' ? 'item_started' : 'item_completed', { item });
      if (method === 'item/completed' && item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)) {
        this.save({ ...this.require(work.id), summary: item.text || '' });
      }
    } else if (method === 'turn/completed') {
      const turn = params.turn || {};
      const status = turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed';
      const finalItems = (turn.items || []).filter(item => item.type === 'agentMessage');
      const summary = finalItems.at(-1)?.text || this.require(work.id).summary;
      this.save({ ...this.require(work.id), status, summary, error: turn.error?.message || null, finishedAt: iso() });
      this.event(work.id, 'turn_completed', { turnId: turn.id, status: turn.status, error: turn.error });
      active.finish?.();
    } else if (method === 'turn/plan/updated' || method === 'turn/diff/updated' || method === 'error') this.event(work.id, method.replaceAll('/', '_'), params);
  }

  async serverRequest(active, message) {
    if (active.stopping) return;
    const { id, method, params = {} } = message;
    if (method === 'currentTime/read') {
      active.rpc.reply(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (method === 'item/tool/call' && params.tool !== 'relay_consult') {
      active.rpc.reply(id, { contentItems: [{ type: 'inputText', text: `Unsupported Relay tool: ${params.tool}` }], success: false });
      return;
    }
    if (method === 'item/tool/call' || method === 'item/tool/requestUserInput') {
      const questions = params.questions || [];
      const text = method === 'item/tool/call' ? asText(params.arguments?.question || params.arguments) : questions.map(question => `${question.question}${question.options?.length ? ` Options: ${question.options.map(option => option.label).join(', ')}` : ''}`).join('\n');
      const targetBotId = params.arguments?.targetBotId || null;
      const question = { requestId: id, text, targetBotId, kind: method, status: 'waiting', askedAt: iso(), questions };
      let complete;
      const answered = new Promise(resolveAnswer => { complete = resolveAnswer; });
      active.pendingQuestion = { id, method, questions, complete };
      const work = this.save({ ...this.require(active.id), status: 'waiting', question });
      this.event(work.id, 'consult_requested', { question: text, targetBotId, kind: method });
      // A request addressed to the human is never answered by another model.
      if (this.consult && method === 'item/tool/call') {
        try {
          const answer = await this.consult(work, text, targetBotId);
          if (answer && !active.stopping && active.pendingQuestion?.id === id) await this.resolveQuestion(active, asText(answer), 'bot');
        } catch (error) {
          if (!active.stopping) this.event(work.id, 'consult_failed', { message: error.message });
        }
      }
      await answered;
      return;
    }
    // The chosen never-approval policy should prevent these. Deny unexpected requests
    // instead of silently accepting external actions or constructing an approval system.
    if (method.includes('requestApproval') || method.endsWith('Approval')) {
      active.rpc.reply(id, method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
      this.event(active.id, 'unexpected_approval', { method });
      return;
    }
    active.rpc.write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Relay does not implement ${method}` } });
    this.event(active.id, 'unsupported_request', { method });
  }

  async resolveQuestion(active, answer, source) {
    const pending = active.pendingQuestion;
    if (!pending || active.stopping) return this.require(active.id);
    const result = pending.method === 'item/tool/call'
      ? { contentItems: [{ type: 'inputText', text: answer }], success: true }
      : { answers: Object.fromEntries(pending.questions.map(question => [question.id, { answers: [answer] }])) };
    active.rpc.reply(pending.id, result);
    active.pendingQuestion = null;
    pending.complete();
    const current = this.require(active.id);
    const work = this.save({ ...current, status: 'running', question: { ...current.question, status: 'answered', answer, answeredAt: iso() } });
    this.event(work.id, 'consult_answer', { answer, source, connectionActive: true });
    return work;
  }
}
