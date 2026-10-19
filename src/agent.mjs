import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createFileTools } from './agent-tools.mjs';
import { ExecutionLock } from './execution-lock.mjs';
import { AgentSessions, sessionIdFor } from './agent-session.mjs';

const now = () => new Date().toISOString();
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
const actionSchema = schema({
  type: { type: 'string', enum: ['dm', 'deep', 'work', 'memory', 'knowledge', 'relation', 'routine'] },
  targetBotId: str, message: str, name: str, goal: str, members: { type: 'array', items: str }, rounds: { type: 'integer' },
  cwd: str, constraints: str, inputRefs: { type: 'array', items: str }, content: str, category: str, id: str,
  status: str, source: str, version: str, title: str, knowledgeType: str, from: str, to: str, relation: str,
  instruction: str, intervalSeconds: { type: 'number' },
}, ['type']);
const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Separate request slots from long-running tools: a waiting command cannot consume all chat slots.
class RequestPool {
  constructor(size) { this.locks = Array.from({ length: size }, () => new ExecutionLock()); }
  acquire(owner, signal) {
    const lock = this.locks.reduce((best, next) => (Number(next.owner !== null) + next.pending < Number(best.owner !== null) + best.pending) ? next : best);
    return lock.acquire(owner, signal);
  }
}

export class BotAgentRuntime {
  constructor({ store, provider, config, emit = () => {}, executionLock = new ExecutionLock() }) {
    Object.assign(this, { store, provider, config, emit, executionLock });
    this.active = new Map();
    this.sessions = new AgentSessions(store, value => this.clean(value));
    this.sessionsBusy = new Set();
    this.pendingStarts = new Set();
    this.pools = { fast: new RequestPool(3), deep: new RequestPool(1) };
    this.stopping = false;
  }

  redact(value) {
    let result = String(value);
    if (this.config.apiKey) result = result.split(this.config.apiKey).join('[redacted]');
    return result.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]');
  }
  clean(value) { return JSON.parse(this.redact(JSON.stringify(value))); }
  save(run) { const value = this.store.save('agentRuns', this.clean(run)); this.emit('agentRun', { id: value.id }); return value; }
  list() { return this.store.list('agentRuns').slice(-50).map(({ messages, ...run }) => run); }
  get(id) {
    const run = this.store.get('agentRuns', id);
    if (!run) return null;
    const { messages, ...summary } = run;
    return { ...summary, tools: this.store.list('toolRuns').filter(tool => tool.runId === id) };
  }
  start() {
    this.stopping = false;
    for (const run of this.store.list('agentRuns')) if (run.status === 'running') this.save({ ...run, status: 'interrupted', finishedAt: now(), error: '服务重启；请先核对已执行操作，再显式重试' });
    for (const tool of this.store.list('toolRuns')) if (tool.status === 'running') this.store.save('toolRuns', { ...tool, status: 'interrupted', finishedAt: now(), error: '操作结果未确认；不能自动重放' });
    for (const session of this.store.list('agentSessions')) this.sessions.repair(session);
  }
  async cancel(id, reason = '用户取消') {
    const active = this.active.get(id);
    if (!this.store.get('agentRuns', id)) throw new Error('找不到执行记录');
    if (active) { active.cancelReason = reason; active.agent.abort(); await active.done; }
    return this.get(id);
  }
  async stop() {
    this.stopping = true;
    await Promise.allSettled([...this.active.keys()].map(id => this.cancel(id, '服务停止')));
    await Promise.allSettled([...this.pendingStarts]);
  }

  async run(input) {
    if (this.stopping) throw new Error('Bot 执行器正在停止');
    const sessionId = sessionIdFor(input.job.botId, input.job.roomId);
    if (this.sessionsBusy.has(sessionId)) throw new Error('同一 Bot 的房间会话正在响应，请等待当前响应完成');
    this.sessionsBusy.add(sessionId);
    const runId = randomUUID();
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    this.pendingStarts.add(pending);
    try { return await this.runSession(input, sessionId, runId); }
    catch (error) {
      // Setup can fail before an Agent is active (including malformed persisted
      // state). Close its audit record just as an execution failure would.
      const run = this.store.get('agentRuns', runId);
      if (run?.status === 'running' && !this.active.has(runId)) {
        this.save({ ...run, status: 'failed', error: this.redact(error.message), finishedAt: now() });
      }
      throw error;
    }
    finally { this.sessionsBusy.delete(sessionId); this.pendingStarts.delete(pending); settle(); }
  }

  async runSession({ job, systemPrompt, context, action, search, onPhase = () => {} }, sessionId, id) {
    const workspace = join(this.config.dataDir, 'bots', createHash('sha256').update(job.botId).digest('hex').slice(0, 24), 'workspace');
    await mkdir(workspace, { recursive: true });
    if (this.stopping) throw new Error('Bot 执行器正在停止');
    const previous = this.store.list('agentRuns').filter(run => run.jobId === job.id);
    const previousIds = new Set(previous.map(run => run.id));
    const priorTools = this.store.list('toolRuns').filter(tool => previousIds.has(tool.runId));
    // Keep every attempted mutation's identity/path even when verbose results are omitted.
    const recovery = priorTools.map(({ id, name, args, status, error }) => {
      const raw = JSON.stringify(args || {});
      return { id, name, status, error, path: args?.path, cwd: args?.cwd, actionType: args?.action?.type,
        argumentsPreview: raw.slice(0, 1200), argumentsTruncated: raw.length > 1200 };
    });
    let run = this.save({ id, sessionId, botId: job.botId, roomId: job.roomId, jobId: job.id, status: 'running', workspace,
      projectRoot: this.config.defaultCwd, startedAt: now(), toolCount: 0, turns: 0, messages: [], requests: [], summary: '', error: null });
    this.store.save('jobs', { ...this.store.get('jobs', job.id), agentRunId: id });
    let finish;
    const active = { agent: null, done: new Promise(resolve => { finish = resolve; }), cancelReason: null };
    const maxTurns = this.config.agentMaxTurns || 16;
    const maxTools = this.config.agentMaxTools || 32;
    let releaseRequest;
    let exhausted = false;
    let toolCount = 0;
    let turns = 0;
    let formatRepairs = 0;
    let currentRequest = null;
    let initialUserSaved = false;
    const usage = emptyUsage();
    const tools = createFileTools({ workspace, projectRoot: this.config.defaultCwd, protectedRoot: this.config.dataDir, redact: value => this.redact(value),
      withExecution: (fn, signal) => this.executionLock.withLock(`agent:${id}`, fn, signal) });
    tools.push({ name: 'relay_action', label: '协作与记忆', description: '执行 Relay 内部协作动作：dm/deep/memory/knowledge/relation/routine/work。work 仅用于复杂专业委托，普通文件操作自己用文件工具完成。',
      parameters: schema({ action: actionSchema }, ['action']), execute: async (callId, args, signal) => {
        signal?.throwIfAborted();
        return toolResult(await action(args.action, `pi:${id}:${turns}:${callId}`));
      } }, { name: 'search_knowledge', label: '检索知识与记忆', description: '查询当前 Bot 记忆和项目共享知识。',
      parameters: schema({ query: str }, ['query']), execute: async (_callId, args, signal) => { signal?.throwIfAborted(); return toolResult(search(args.query)); } });
    const model = { id: 'deepseek-flash', name: 'DeepSeek Flash', api: 'openai-completions', provider: 'deepseek', baseUrl: this.config.baseUrl,
      reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 6000 };
    const prompt = `${systemPrompt}\n你具备真实文件和命令工具。个人工作目录=${workspace}；共享项目根目录=${this.config.defaultCwd}。相对路径属于个人目录；操作共享项目须传完整路径。先读真实内容再编辑，完成后读回核对。命令在 ${process.platform === 'win32' ? 'PowerShell（不要使用 bash 语法）' : 'sh'} 中执行，cwd 不是操作系统沙箱。遵守用户目标和既有授权，不触碰密钥/凭据、其他 Bot 私有目录或 Relay 数据库。不要自行提交/推送/发布。\n你正在延续同一房间的持久会话。relay_turn 只追加新房间消息；contextUpdate 是当时的记忆、知识及工作状态，后出现的快照取代旧状态。保留此前原生工具观察，但文件可能被外部修改，编辑前仍要核对。需要协作动作时调用 relay_action，收到真实结果后继续；最终回复仍为 JSON {"reply":"给用户的答复","pass":false,"actions":[]}，actions 必须为空以免重复执行。不要在工具执行前声称完成。没有新增贡献可 pass:true。失败工具不等于完成，报告剩余问题。每次响应工具预算 ${maxTools} 次，最多 ${maxTurns} 轮。`;
    let session = this.sessions.load({ botId: job.botId, roomId: job.roomId, prompt, tools });
    const prepared = this.sessions.prepare(session, context, { job, workspace, projectRoot: this.config.defaultCwd, recovery });
    const failureStream = (error, signal) => {
      const stream = new AssistantMessageEventStream();
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], usage: emptyUsage(),
        stopReason: signal?.aborted ? 'aborted' : 'error', errorMessage: this.redact(error.message), timestamp: Date.now() };
      stream.push({ type: 'error', reason: message.stopReason, error: message }); stream.end(message); return stream;
    };
    const agent = active.agent = new Agent({
      initialState: { model, thinkingLevel: job.lane === 'deep' ? 'medium' : 'off', tools, systemPrompt: prompt, messages: session.messages },
      sessionId,
      toolExecution: 'sequential',
      streamFn: async (selectedModel, transcript, options) => {
        try {
          const contextBytes = Buffer.byteLength(JSON.stringify(transcript));
          const maxBytes = this.config.agentSessionMaxBytes || 384000;
          if (contextBytes > maxBytes) throw new Error(`会话上下文达到容量上限 (${contextBytes}/${maxBytes} 字节)。完整历史已保留；请新建房间继续，本次没有静默截断或自动压缩。`);
          onPhase('waiting');
          releaseRequest = await this.pools[job.lane === 'deep' ? 'deep' : 'fast'].acquire(id, options?.signal);
          onPhase('model');
          const requests = this.store.get('agentRuns', id).requests;
          currentRequest = requests.length + 1;
          run = this.save({ ...this.store.get('agentRuns', id), requests: [...requests,
            { index: currentRequest, firstInRun: currentRequest === 1, startedAt: now(), status: 'running', contextBytes }] });
          return this.provider.stream(selectedModel, transcript, options);
        } catch (error) { return failureStream(error, options?.signal); }
      },
      beforeToolCall: async () => toolCount > maxTools ? { block: true, reason: '已达到工具次数上限', terminate: true } : undefined,
      afterToolCall: async ({ toolCall, result }) => {
        if (toolCall.name === 'run_command' && (result.details?.exitCode !== 0 || result.details?.timedOut || result.details?.aborted)) return { isError: true };
      },
      finishTurn: ({ message }) => {
        if (turns >= maxTurns && message.content?.some(part => part.type === 'toolCall')) { exhausted = true; return { action: 'end' }; }
        if (toolCount > maxTools) { exhausted = true; return { action: 'end' }; }
        if (message.stopReason === 'stop' && turns < maxTurns && formatRepairs < 1) {
          let final;
          try { final = JSON.parse(message.content.filter(part => part.type === 'text').map(part => part.text).join('\n').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { /* One bounded formatting correction, with existing tool observations intact. */ }
          if (!final || typeof final !== 'object' || Array.isArray(final) || (final.actions !== undefined && (!Array.isArray(final.actions) || final.actions.length)) ||
            (final.reply !== undefined && typeof final.reply !== 'string') || (final.pass !== undefined && typeof final.pass !== 'boolean')) {
            formatRepairs++;
            agent.followUp({ role: 'user', timestamp: Date.now(), content: '运行器格式校正：刚才的正文不是有效最终回复，其中的 actions 没有执行。若原用户请求确需尚未执行的协作动作，请实际调用 relay_action 工具；不要重复工具日志中已经执行的动作。然后输出单行 JSON {"reply":"真实结果","pass":false,"actions":[]}。reply必须是字符串，pass为布尔值，actions为空数组。JSON字符串内不能出现未经转义的换行或双引号；本次请用简短的单行reply，使用中文引号，确保JSON.parse可以解析。不要代码围栏或额外正文。此校正不扩大原任务授权。' });
          }
        }
      },
    });
    agent.subscribe(event => {
      if (event.type === 'turn_start') turns++;
      if (event.type === 'message_end') {
        if (event.message.role === 'assistant') {
          releaseRequest?.(); releaseRequest = null;
          for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) usage[key] += event.message.usage?.[key] || 0;
          if (currentRequest !== null) {
            const current = this.store.get('agentRuns', id);
            run = this.save({ ...current, requests: current.requests.map(request => request.index !== currentRequest ? request : {
              ...request, status: ['error', 'aborted'].includes(event.message.stopReason) ? event.message.stopReason : 'completed',
              finishedAt: now(), usage: event.message.usage || emptyUsage(), responseId: event.message.responseId,
              ...(event.message.errorMessage ? { error: event.message.errorMessage } : {}) }) });
            currentRequest = null;
          }
        }
        this.store.transaction(() => {
          run = this.save({ ...this.store.get('agentRuns', id), messages: [...this.store.get('agentRuns', id).messages, this.clean(event.message)], turns });
          const isInitialUser = !initialUserSaved && event.message.role === 'user';
          session = this.sessions.append(sessionId, event.message, { runId: id,
            ...(isInitialUser ? { consumedRoomMessageIds: prepared.roomMessageIds, dynamicContextHash: prepared.dynamicContextHash } : {}) });
          if (isInitialUser) initialUserSaved = true;
        });
      }
      if (event.type === 'tool_execution_start') {
        onPhase('tool'); toolCount++;
        this.store.save('toolRuns', this.clean({ id: `${id}:${turns}:${event.toolCallId}`, runId: id, turn: turns, toolCallId: event.toolCallId, name: event.toolName,
          args: event.args, status: 'running', startedAt: now() }));
        run = this.save({ ...this.store.get('agentRuns', id), toolCount });
      }
      if (event.type === 'tool_execution_end') {
        this.store.save('toolRuns', this.clean({ id: `${id}:${turns}:${event.toolCallId}`, status: event.isError ? 'failed' : 'completed',
          result: event.result, error: event.isError ? event.result?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') : null, finishedAt: now() }));
        this.emit('agentTool', { runId: id });
      }
    });
    this.active.set(id, active);
    const timer = setTimeout(() => { active.cancelReason = '执行超时'; agent.abort(); }, this.config.agentTimeoutMs || 600000);
    try {
      await agent.prompt(prepared.message);
      if (active.cancelReason) throw new Error(active.cancelReason);
      const last = agent.state.messages.findLast(message => message.role === 'assistant');
      if (!last || ['error', 'aborted'].includes(last.stopReason)) throw new Error(last?.errorMessage || 'Bot 未完成响应');
      if (exhausted) throw new Error('达到执行预算；已执行记录保留，请缩小任务或显式重试');
      const content = last.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      let final;
      try { final = JSON.parse(content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { throw new Error('工具操作已记录，但模型最终回复不是有效 JSON'); }
      if (!final || typeof final !== 'object' || Array.isArray(final) || (final.reply !== undefined && typeof final.reply !== 'string') ||
        (final.pass !== undefined && typeof final.pass !== 'boolean') || (final.actions !== undefined && (!Array.isArray(final.actions) || final.actions.length))) {
        throw new Error('最终回复包含未执行动作或格式错误，请查看实际工具记录');
      }
      this.store.transaction(() => {
        this.save({ ...this.store.get('agentRuns', id), status: 'completed', summary: String(final.reply || ''), usage, finishedAt: now() });
        this.sessions.complete(sessionId, job.id, final.reply);
      });
      return { content, usage: { prompt_tokens: usage.input + usage.cacheRead, completion_tokens: usage.output, total_tokens: usage.totalTokens }, model: model.id };
    } catch (error) {
      const status = active.cancelReason === '用户取消' ? 'cancelled' : active.cancelReason ? 'interrupted' : 'failed';
      this.save({ ...this.store.get('agentRuns', id), status, error: this.redact(error.message), usage, finishedAt: now() });
      for (const tool of this.store.list('toolRuns')) if (tool.runId === id && tool.status === 'running') this.store.save('toolRuns', { ...tool, status: 'interrupted', error: '结果未确认', finishedAt: now() });
      this.sessions.repair(this.store.get('agentSessions', sessionId));
      throw new Error(this.redact(error.message));
    } finally {
      clearTimeout(timer); releaseRequest?.(); this.active.delete(id); finish(); onPhase('done');
    }
  }
}
