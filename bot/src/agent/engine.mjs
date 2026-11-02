import { Agent } from '@earendil-works/pi-agent-core';
import { toToolDeclaration, getCurrentTools, getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { modelFor, contextSettings, DEFAULT_RETRY } from './model.mjs';
import { ModelProvider } from './provider.mjs';
import { SessionContext } from '../context/context.mjs';
import { PiCompactionLifecycle } from '../pi/core/compaction/lifecycle.mjs';
import { convertToLlm } from '../pi/core/messages.mjs';
import { repairTranscript } from '../context/recovery.mjs';
import { loadResources } from '../context/resources.mjs';
import { ToolRegistry } from '../capabilities/registry.mjs';
import { registerSdkTools } from '../capabilities/sdk.mjs';
import { loadConfiguredTools } from '../capabilities/remote-tools.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Exactly one Pi Agent per Bot; sessions are durable and execution is serial. */
export class BotEngine {
  constructor({ config, store, emit, services, clean, provider }) {
    Object.assign(this, { config, store, emit, services, clean });
    this.model = modelFor(config);
    this.provider = provider || new ModelProvider({ ...config.model, baseUrl: config.model.baseUrl.replace(/\/$/, ''),
      apiKey: config.model.apiKey || (config.model.apiKeyEnv ? process.env[config.model.apiKeyEnv] : ''), redact: clean });
    this.agent = new Agent({ initialState: { model: this.model }, convertToLlm,
      toolExecution: 'sequential', streamFn: this.provider.stream.bind(this.provider) });
    this.context = new SessionContext({ sessions: store, clean,
      onCheckpoint: (sessionId, checkpoint) => emit('engine.compaction', { checkpoint }, { sessionId, taskId: checkpoint.runId }) });
    this.queue = Promise.resolve(); this.closed = false; this.active = null;
    this.taskGate = null; this.idleWaiters = new Set();
  }
  async initialize() {
    this.promptFileContent = this.config.promptFile ? await readFile(this.config.promptFile, 'utf8') : '';
    this.resources = await loadResources({ config: this.config, workspace: this.config.workspace });
    this.configured = await loadConfiguredTools(this.config.tools, { botId: this.config.botId, dataDir: this.config.dataDir,
      workspace: this.config.workspace, redact: this.clean });
    this.toolNames = this.validateConfigured(this.configured);
    for (const session of this.store.listSessions()) this.repairSession(session);
    return this;
  }
  validateConfigured(configured) {
    // Reject collisions before accepting messages or acknowledging an update.
    const names = new Set();
    for (const tool of [...this.services.coreTools({}), ...configured.tools, this.resources.tool, this.context.historyTool('__validation__')]) {
      if (names.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      names.add(tool.name);
    }
    return [...names];
  }
  async stageConfigured(definitions, signal) {
    const configured = await loadConfiguredTools(definitions, { botId: this.config.botId, dataDir: this.config.dataDir,
      workspace: this.config.workspace, redact: this.clean, signal });
    try { this.validateConfigured(configured); return configured; }
    catch (error) { await configured.close(); throw error; }
  }
  holdTasks() {
    if (this.taskGate) throw new Error('Bot task boundary is already held');
    let release;
    const gate = { promise: new Promise(resolve => release = resolve) };
    this.taskGate = gate;
    const idle = this.active ? new Promise(resolve => this.idleWaiters.add(resolve)) : Promise.resolve();
    return { idle, release: () => { if (this.taskGate === gate) this.taskGate = null; release(); } };
  }
  replaceConfigured(configured) {
    if (this.active || !this.taskGate) throw new Error('Capabilities can only change at a held task boundary');
    const names = this.validateConfigured(configured), previous = this.configured;
    this.configured = configured; this.toolNames = names;
    return previous;
  }
  repairSession(session) {
    const resolveResult = (call, assistant) => {
      const candidates = this.store.listTools().filter(tool => tool.sessionId === session.id && tool.toolCallId === call.id &&
        tool.assistantDigest === digest(assistant) && ['completed', 'failed'].includes(tool.status));
      if (candidates.length !== 1) return null;
      const tool = candidates[0];
      return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: tool.output?.content || [{ type: 'text', text: JSON.stringify(tool.output) }], isError: tool.status !== 'completed', timestamp: Date.now(), recovery: true };
    };
    // Native recovery uses durable context edits. Never rewrite their indexed raw
    // history or resurrect attempts that Pi has intentionally omitted.
    const view = this.context.project(session.id), visible = view.projection.messages;
    const repaired = repairTranscript(visible, resolveResult);
    if (JSON.stringify(repaired.messages) === JSON.stringify(visible)) return session;
    const manager = this.context.sessionManager(session.id);
    for (const record of repaired.recoveryRecords) {
      const id = manager.idForMessage(record.message);
      if (id) manager.appendContextEdit(id, null);
    }
    const existing = new Set(visible.map(message => JSON.stringify(message)));
    for (const message of repaired.messages) if (!existing.has(JSON.stringify(message))) this.context.recordMessage(session.id, message, session.lastTaskId);
    const latest = this.store.getSession(session.id);
    return this.store.saveSession({ ...latest, recoveryRecords: [...(latest.recoveryRecords || []), ...repaired.recoveryRecords] });
  }
  run(task, { signal, onStart } = {}) {
    if (this.closed) return Promise.reject(new Error('Bot engine is closed'));
    const work = this.queue.catch(() => {}).then(async () => {
      while (this.taskGate) await this.taskGate.promise;
      signal?.throwIfAborted();
      if (this.closed) throw new Error('Bot engine is closed');
      onStart?.();
      return this.execute(task, signal);
    });
    this.queue = work; return work;
  }
  async execute(task, signal) {
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    this.active = { taskId: task.id, controller };
    const refs = { taskId: task.id, sessionId: task.sessionId };
    let turns = 0, toolsCalled = 0;
    const usage = emptyUsage();
    const addUsage = message => { for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) usage[key] += message.usage?.[key] || 0; };
    const clean = this.clean;
    let unsubscribe, lifecycle;
    try {
      let session = this.store.getSession(task.sessionId) || this.store.saveSession({ id: task.sessionId, contextKey: task.sessionId, messages: [], checkpoints: [] });
      session = this.repairSession(session);
      const registry = new ToolRegistry({
        context: ({ toolCallId }) => ({ ...this.services.toolContext(task), ...refs, botId: this.config.botId,
          instanceId: this.config.botId, runId: task.id, requestId: task.id,
          allowedEffects: task.metadata?.toolPolicy?.allowedEffects,
          recordId: `${task.id}:${turns}:${toolCallId}`, cwd: this.config.workspace }),
        record: record => {
          const assistant = this.agent.state.messages.findLast(message => message.role === 'assistant');
          return this.store.transaction(() => {
            const saved = this.store.saveTool(clean({ ...record, taskId: task.id, runId: task.id, sessionId: task.sessionId,
              assistantDigest: assistant ? digest(assistant) : null }));
            for (const artifact of record.artifacts || []) if (typeof artifact?.id === 'string') this.store.saveArtifact(clean({ ...artifact,
              botId: this.config.botId, taskId: task.id, runId: task.id, sessionId: task.sessionId, toolRunId: record.id }));
            if (this.active) this.active.waitingFor = record.status === 'running' ? { kind: 'tool', name: record.name, toolRunId: record.id } : null;
            return saved;
          });
        },
      });
      for (const tool of [...this.services.coreTools(task), ...this.configured.tools]) registry.register(tool);
      registerSdkTools(registry, [this.resources.tool, this.context.historyTool(task.sessionId)]);
      const tools = registry.toSdkTools(), declarations = tools.map(toToolDeclaration);
      const capabilityNotice = this.config.capabilityBindingRevision ? `Your external capabilities were switched at a completed task boundary. Current binding revision: ${this.config.capabilityBindingRevision}. Use the current tool declarations; earlier task receipts refer to their original capability versions.` : '';
      // Snapshot the current persisted prompt once per task, so profile edits
      // affect the next task without changing an in-flight conversation.
      const peerNotice = 'For one-to-one work with a configured Bot contact, prefer contacts_list and messages_send. Use tasks_get with botId and waitMs (up to 60000) to obtain its actual result; acceptance is not completion. These core tools connect directly to the peer and remain available without chatroom or gateway. Use chatroom tools for group conversations or when the user explicitly requests that channel. A peer should normally return its answer as the task result; do not create automatic reply loops.';
      const systemPrompt = [`You are Bot ${this.config.botId}. Use only your configured capabilities. Tool receipts and final task results are distinct from delivery acknowledgments. Do not replay uncertain side effects.`, this.config.prompt || '', this.promptFileContent, this.resources.prompt, capabilityNotice, peerNotice].filter(Boolean).join('\n\n');
      const promptHash = digest({ systemPrompt, declarations });
      if (session.promptHash !== promptHash) {
        const removed = getCurrentTools(session.messages).filter(tool => !tools.some(value => value.name === tool.name)).map(tool => ({ name: tool.name }));
        session = this.store.saveSession(clean({ ...session, promptHash, messages: [...session.messages,
          { role: 'system', content: '', sections: { ...Object.fromEntries(Object.keys(getCurrentSystemMessage(session.messages)?.sections || {}).map(name => [name, null])), bot: systemPrompt }, toolsAdded: declarations,
            ...(removed.length ? { toolsRemoved: removed } : {}), timestamp: Date.now() }] }));
      }
      const input = typeof task.input === 'string' ? task.input : JSON.stringify(task.input);
      const invocation = await this.resources.expand({ content: input }, combined);
      if (invocation) this.emit('skill.loaded', { name: invocation.name, path: invocation.path, sha256: invocation.sha256 }, refs);
      this.agent.clearAllQueues();
      this.agent.state.model = this.model;
      this.agent.state.thinkingLevel = this.config.model.thinkingLevel || 'off';
      this.agent.state.messages = this.context.project(task.sessionId).projection.messages;
      this.agent.state.tools = tools;
      this.agent.sessionId = task.sessionId;
      this.agent.streamFunction = this.provider.stream.bind(this.provider);
      lifecycle = new PiCompactionLifecycle({ agent: this.agent, model: this.model, signal: combined,
        sessionManager: this.context.sessionManager(task.sessionId, { runId: task.id, model: this.model, signal: combined }),
        settings: contextSettings({ agentCompaction: this.config.limits.compaction !== false,
          agentReserveTokens: this.config.limits.reserveTokens, agentKeepRecentTokens: this.config.limits.keepRecentTokens }, this.model),
        retry: DEFAULT_RETRY,
        summaryStream: async (...args) => { const stream = await this.provider.stream(...args); addUsage(await stream.result()); return stream; },
        instructions: 'Preserve user decisions and permissions, exact paths, IDs and critical observed values. Distinguish confirmed tool receipts from failed, interrupted or resultKnown=false operations. Never infer completion or replay operations. Keep pending work and task and sender context. read_session_history can recover the original observations.',
        emit: event => {
          if (event.type === 'compaction_start') this.active.waitingFor = { kind: 'compaction', reason: event.reason };
          if (event.type === 'auto_retry_start' || event.type === 'summarization_retry_scheduled') this.active.waitingFor = { kind: 'retry', attempt: event.attempt, delayMs: event.delayMs };
          if (event.type === 'compaction_end' || event.type === 'auto_retry_end') this.active.waitingFor = null;
          this.emit(`engine.${event.type}`, event, refs);
        } });
      this.agent.prepareRequest = request => {
        combined.throwIfAborted();
        const view = this.context.project(task.sessionId);
        this.active.waitingFor = { kind: 'model', model: request.model.id };
        this.emit('engine.request', { model: request.model.id, contextBytes: view.bytes, contextTokens: view.tokens }, refs);
        return { context: { ...request.context, messages: view.projection.messages, tools: this.agent.state.tools.slice() } };
      };
      this.agent.prepareNextTurnWithContext = turn => lifecycle.prepareNextTurn(turn.context);
      // Count work for reporting without imposing a per-task execution budget.
      this.agent.beforeToolCall = () => { toolsCalled++; };
      unsubscribe = this.agent.subscribe(event => {
        if (event.type === 'turn_start') turns++;
        if (event.type === 'message_end') {
          if (event.message.role === 'assistant' && this.active) this.active.waitingFor = null;
          if (event.message.role === 'assistant') addUsage(event.message);
          this.context.recordMessage(task.sessionId, event.message, task.id);
        }
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') this.emit('agent.text_delta', { text: event.assistantMessageEvent.delta }, refs);
        if (event.type === 'tool_execution_end') {
          const id = `${task.id}:${turns}:${event.toolCallId}`;
          if (!this.store.getTool(id)) this.store.saveTool(clean({ id, ...refs, runId: task.id, toolCallId: event.toolCallId,
            name: event.toolName, status: event.isError ? 'failed' : 'unknown', executionRejected: true, output: event.result, finishedAt: new Date().toISOString() }));
        }
      });
      const abort = () => this.agent.abort();
      combined.addEventListener('abort', abort, { once: true });
      try {
        combined.throwIfAborted();
        await lifecycle.beforePrompt();
        await this.agent.prompt(invocation ? `${input}\n\n${JSON.stringify(invocation)}` : input);
        while (await lifecycle.afterRun()) await this.agent.continue();
        combined.throwIfAborted();
      } finally { combined.removeEventListener('abort', abort); }
      const last = lifecycle.lastOutcome;
      if (!last || ['error', 'aborted', 'length'].includes(last.stopReason)) {
        const detail = lifecycle.lastCompactionFailureReason === 'overflow' ? lifecycle.lastCompactionError : undefined;
        const message = last?.errorMessage || (last?.stopReason === 'length' ? 'Model output reached its limit after recovery' : 'Agent ended without a result');
        throw Object.assign(new Error(detail ? `${message}; ${detail}` : message),
          { code: detail ? 'CONTEXT_RECOVERY_FAILED' : last?.stopReason === 'length' ? 'MODEL_OUTPUT_LIMIT' : 'MODEL_ERROR' });
      }
      return clean({ content: last.content.filter(value => value.type === 'text').map(value => value.text).join('\n'), model: this.model.id,
        usage: { prompt_tokens: usage.input + usage.cacheRead, completion_tokens: usage.output, total_tokens: usage.totalTokens }, turns, toolsCalled });
    } catch (error) {
      const session = this.store.getSession(task.sessionId);
      if (session && !this.store.closed) this.repairSession(session);
      throw error;
    } finally {
      unsubscribe?.(); lifecycle?.close(); this.agent.prepareRequest = undefined; this.agent.prepareNextTurnWithContext = undefined;
      this.active = null; for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear();
    }
  }
  health() { return { engine: 'pi-agent-core', version: '1.3.0', initialized: Boolean(this.agent), activity: this.active ? (this.active.waitingFor ? 'waiting' : 'running') : 'idle', waitingFor: this.active?.waitingFor || null, configured: this.provider.status?.configured !== false,
    activeTaskId: this.active?.taskId || null, capabilitySwitchPending: Boolean(this.taskGate), capabilityBindingRevision: this.config.capabilityBindingRevision || null,
    model: this.model.id, provider: this.clean(this.provider.status || {}), tools: this.toolNames || [], skills: this.resources?.manifest || null }; }
  async close() {
    this.closed = true; this.active?.controller.abort(new Error('Bot is closing')); this.agent.abort();
    await this.queue.catch(() => {}); await this.configured?.close(); this.provider.stop?.();
  }
}
