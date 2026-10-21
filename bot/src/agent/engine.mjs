import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream, toToolDeclaration, getCurrentTools, getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { modelFor } from './model.mjs';
import { ModelProvider } from './provider.mjs';
import { SessionContext } from '../context/context.mjs';
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
    this.agent = new Agent({ initialState: { model: this.model }, toolExecution: 'sequential', streamFn: this.provider.stream.bind(this.provider) });
    this.context = new SessionContext({ sessions: store, clean, config: {
      agentSessionMaxBytes: config.limits.maxContextBytes,
      agentCompaction: config.limits.compaction !== false,
      agentReserveTokens: config.limits.reserveTokens,
      agentKeepRecentTokens: config.limits.keepRecentTokens,
    }, onCheckpoint: (sessionId, checkpoint) => emit('engine.compaction', { checkpoint }, { sessionId, taskId: checkpoint.runId }) });
    this.queue = Promise.resolve(); this.closed = false; this.active = null;
    this.taskGate = null; this.idleWaiters = new Set();
  }
  async initialize() {
    this.prompt = [
      `You are Bot ${this.config.botId}. Use only your configured capabilities. Tool receipts and final task results are distinct from delivery acknowledgments. Do not replay uncertain side effects.`,
      this.config.prompt || '', this.config.promptFile ? await readFile(this.config.promptFile, 'utf8') : '',
    ].filter(Boolean).join('\n\n');
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
    const repaired = repairTranscript(session.messages || [], (call, assistant) => {
      const candidates = this.store.listTools().filter(tool => tool.sessionId === session.id && tool.toolCallId === call.id &&
        tool.assistantDigest === digest(assistant) && ['completed', 'failed'].includes(tool.status));
      if (candidates.length !== 1) return null;
      const tool = candidates[0];
      return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
        content: tool.output?.content || [{ type: 'text', text: JSON.stringify(tool.output) }], isError: tool.status !== 'completed', timestamp: Date.now(), recovery: true };
    });
    if (JSON.stringify(repaired.messages) !== JSON.stringify(session.messages)) return this.store.saveSession({ ...session,
      messages: repaired.messages, checkpoints: (session.checkpoints || []).map(value => ({ ...value, invalidated: 'transcript_repaired' })),
      recoveryRecords: [...(session.recoveryRecords || []), ...repaired.recoveryRecords] });
    return session;
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
    const timer = setTimeout(() => controller.abort(new Error('Bot execution timed out')), this.config.limits.timeoutMs);
    const refs = { taskId: task.id, sessionId: task.sessionId };
    let turns = 0, toolsCalled = 0, exhausted = false;
    const usage = emptyUsage();
    const addUsage = message => { for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) usage[key] += message.usage?.[key] || 0; };
    const clean = this.clean;
    let unsubscribe;
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
      const systemPrompt = [this.prompt, this.resources.prompt, capabilityNotice].filter(Boolean).join('\n\n');
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
      this.agent.state.messages = session.messages;
      this.agent.state.tools = tools;
      this.agent.sessionId = task.sessionId;
      this.agent.streamFunction = async (model, transcript, options) => {
        try {
          combined.throwIfAborted();
          this.active.waitingFor = { kind: 'model', model: model.id };
          const view = await this.context.prepare(task.sessionId, { model, signal: combined, runId: task.id,
            streamFn: async (...args) => { const stream = await this.provider.stream(...args); addUsage(await stream.result()); return stream; } });
          this.emit('engine.request', { model: model.id, contextBytes: view.bytes, contextTokens: view.tokens }, refs);
          // Historical prompts stay in the original transcript for audit, but
          // only this Bot's current configured prompt/tools govern a new turn.
          const messages = [{ role: 'system', content: '', sections: { bot: systemPrompt }, toolsAdded: declarations, timestamp: Date.now() },
            ...view.messages.filter(message => message.role !== 'system')];
          return this.provider.stream(model, { ...transcript, messages }, { ...options, signal: combined });
        } catch (error) {
          const stream = new AssistantMessageEventStream();
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], usage: emptyUsage(),
            stopReason: combined.aborted ? 'aborted' : 'error', errorMessage: clean({ message: error.message }).message, timestamp: Date.now() };
          stream.push({ type: 'error', reason: message.stopReason, error: message }); stream.end(message); return stream;
        }
      };
      this.agent.beforeToolCall = () => {
        if (++toolsCalled > this.config.limits.maxTools) { exhausted = true; return { block: true, reason: 'Tool budget exceeded', terminate: true }; }
      };
      this.agent.finishTurn = ({ message }) => {
        if (turns >= this.config.limits.maxTurns && message.content?.some(value => value.type === 'toolCall')) { exhausted = true; return { action: 'end' }; }
      };
      unsubscribe = this.agent.subscribe(event => {
        if (event.type === 'turn_start') turns++;
        if (event.type === 'message_end') {
          if (event.message.role === 'assistant' && this.active) this.active.waitingFor = null;
          if (event.message.role === 'assistant') addUsage(event.message);
          const current = this.store.getSession(task.sessionId);
          this.store.saveSession(clean({ ...current, messages: [...current.messages, event.message], lastTaskId: task.id }));
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
        await this.agent.prompt(invocation ? `${input}\n\n${JSON.stringify(invocation)}` : input);
        combined.throwIfAborted();
      } finally { combined.removeEventListener('abort', abort); }
      const last = this.agent.state.messages.findLast(message => message.role === 'assistant');
      if (exhausted) throw new Error('Execution budget exceeded; inspect existing tool receipts before retrying');
      if (!last || ['error', 'aborted'].includes(last.stopReason)) throw new Error(last?.errorMessage || 'Agent ended without a result');
      return clean({ content: last.content.filter(value => value.type === 'text').map(value => value.text).join('\n'), model: this.model.id,
        usage: { prompt_tokens: usage.input + usage.cacheRead, completion_tokens: usage.output, total_tokens: usage.totalTokens }, turns, toolsCalled });
    } catch (error) {
      const session = this.store.getSession(task.sessionId);
      if (session && !this.store.closed) this.repairSession(session);
      throw error;
    } finally { clearTimeout(timer); unsubscribe?.(); this.active = null; for (const resolve of this.idleWaiters) resolve(); this.idleWaiters.clear(); }
  }
  health() { return { engine: 'pi-agent-core', version: '1.3.0', initialized: Boolean(this.agent), activity: this.active ? (this.active.waitingFor ? 'waiting' : 'running') : 'idle', waitingFor: this.active?.waitingFor || null, configured: this.provider.status?.configured !== false,
    activeTaskId: this.active?.taskId || null, capabilitySwitchPending: Boolean(this.taskGate), capabilityBindingRevision: this.config.capabilityBindingRevision || null,
    model: this.model.id, provider: this.clean(this.provider.status || {}), tools: this.toolNames || [], skills: this.resources?.manifest || null }; }
  async close() {
    this.closed = true; this.active?.controller.abort(new Error('Bot is closing')); this.agent.abort();
    await this.queue.catch(() => {}); await this.configured?.close(); this.provider.stop?.();
  }
}
