import { AssistantMessageEventStream, clampThinkingLevel, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { modelConnection, connectionModel, connectionRuntime, modelError, officialDeepSeekCompletions } from './connections.mjs';
import { reportedUsage, referenceCost } from './usage.mjs';

const connectionWaitMs = 180000;
const authorizationOutput = { off: 2048, thinking: 16384 };
const timeoutError = phase => Object.assign(new Error(`Model request timed out during ${phase}`), { code: 'MODEL_DEADLINE' });

const rawUsage = usage => ({ prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite,
  completion_tokens: usage.output, total_tokens: usage.totalTokens,
  prompt_cache_hit_tokens: usage.cacheRead, completion_tokens_details: { reasoning_tokens: usage.reasoning } });
function providerUsage(usage, api) {
  if (!usage) return null;
  if (api === 'anthropic-messages') return {
    prompt_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : undefined,
    completion_tokens: usage.output_tokens, prompt_cache_hit_tokens: usage.cache_read_input_tokens,
  };
  return { ...usage, prompt_tokens: usage.prompt_tokens ?? usage.input_tokens, completion_tokens: usage.completion_tokens ?? usage.output_tokens,
    prompt_tokens_details: usage.prompt_tokens_details ?? usage.input_tokens_details,
    completion_tokens_details: usage.completion_tokens_details ?? usage.output_tokens_details };
}

/** Pi owns serialization, streaming and the tool loop for every configured source. */
export class ModelProvider {
  constructor(config) {
    this.config = config;
    this.config.redact ||= value => value;
    this.status = { model: config.model, configured: Boolean(config.apiKey || config.connectionStore), credentialSource: config.credentialSource,
      connected: false, calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, lastError: null, lastSuccessAt: null };
    this.controllers = new Set();
  }
  stream(model, context, options = {}) {
    const output = new AssistantMessageEventStream(), controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const deadline = new AbortController(), requestSignal = AbortSignal.any([signal, deadline.signal]);
    const { timeoutMs: totalWaitMs, onPayload, ...streamOptions } = options;
    this.controllers.add(controller);
    const started = Date.now(), secrets = new Set();
    const tracksConnection = options.usageContext?.purpose !== 'activity';
    let record, selectedModel = model, received, ended = false, wireUsage, stageTimer, totalTimer;
    const waitFor = (phase, ms) => {
      clearTimeout(stageTimer);
      stageTimer = setTimeout(() => {
        if (record) record.timeoutPhase = phase;
        deadline.abort(timeoutError(phase));
      }, ms);
    };
    const cleanError = error => {
      let message = String(error?.message || error);
      for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
      return this.config.redact({ message: modelError(message) }).message;
    };
    void (async () => {
      try {
        const connection = modelConnection(this.config, this.config.connectionStore ? model.provider : undefined);
        // A dialogue keeps its captured connection when the global default changes.
        const runtime = connectionRuntime(connection, undefined, model);
        const authorization = options.usageContext?.requestKind === 'production-authorization';
        const deepseek = officialDeepSeekCompletions({ ...connection, model: model.id }, model.api, model.baseUrl);
        // For official DeepSeek, a short structured check uses the native off path.
        const requestedReasoning = authorization && deepseek ? 'off' : options.reasoning || 'off';
        const fastest = model.thinkingLevelMap?.off === null ? ['low', 'medium', 'high'].find(level => model.thinkingLevelMap[level] != null) : null;
        const reasoning = clampThinkingLevel(model, requestedReasoning === 'off' && fastest ? fastest : requestedReasoning);
        const thinking = reasoning !== 'off', idleWaitMs = thinking ? 300000 : 180000;
        const maxTokens = authorization ? Math.min(model.outputTokenLimit ?? model.maxTokens, authorizationOutput[thinking ? 'thinking' : 'off']) :
          Math.min(options.maxTokens ?? model.maxTokens, model.outputTokenLimit ?? model.maxTokens);
        record = { id: randomUUID(), botId: this.config.botId, ...options.usageContext,
          purpose: options.usageContext?.purpose || 'other', provider: connection.kind === 'api' ? connection.provider : connection.kind,
          connectionId: connection.id, billingMode: connection.kind === 'api' ? 'api' : 'subscription',
          model: model.id, requestedModel: model.id, startedAt: new Date(started).toISOString(), status: 'pending', ...reportedUsage(null),
          thinking, thinkingLevel: reasoning, api: model.api, contextWindow: model.contextWindow, requestedOutputTokens: maxTokens,
          messageCount: context.messages?.length || 0, toolCount: getCurrentTools(normalizeContext(context).messages).length, maxOutputTokens: null };
        const persist = () => this.config.recordUsage?.(record); persist();
        waitFor('connection', connectionWaitMs);
        if (totalWaitMs) totalTimer = setTimeout(() => {
          record.timeoutPhase = 'total-budget'; deadline.abort(timeoutError('total-budget'));
        }, totalWaitMs);
        const stream = runtime.models.streamSimple(selectedModel, context, { ...streamOptions, reasoning, maxTokens, signal: requestSignal,
          // The SDK uses this for its HTTP header wait. Stream lifetime is
          // governed separately by meaningful deltas and the caller's stop.
          timeoutMs: connectionWaitMs + 1000,
          sessionId: options.usageContext?.sessionId || options.sessionId, maxRetries: 0,
          ...(connection.kind === 'codex' ? { transport: 'sse' } : {}),
          onPayload: async (payload, model) => {
            const replacement = await onPayload?.(payload, model);
            const sent = replacement ?? payload;
            const limit = sent?.max_tokens ?? sent?.max_completion_tokens ?? sent?.max_output_tokens;
            record.maxOutputTokens = Number.isSafeInteger(limit) ? limit : null;
            persist();
            return replacement;
          },
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            const bearer = headers.get('authorization'); if (bearer) secrets.add(bearer.replace(/^Bearer\s+/i, ''));
            if (headers.get('x-api-key')) secrets.add(headers.get('x-api-key'));
            const response = await fetch(input, { ...init, redirect: 'error' });
            record.httpStatus = response.status;
            waitFor('first-progress', idleWaitMs);
            if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
            let tail = ''; const decoder = new TextDecoder();
            // Observe billing fields while forwarding bytes; missing usage stays unknown.
            const body = response.body.pipeThrough(new TransformStream({ transform(chunk, destination) {
              destination.enqueue(chunk); tail += decoder.decode(chunk, { stream: true });
              let split;
              while ((split = tail.indexOf('\n')) >= 0) {
                const line = tail.slice(0, split).trim(); tail = tail.slice(split + 1);
                if (!line.startsWith('data:')) continue;
                try { const event = JSON.parse(line.slice(5)); const usage = event.usage || event.response?.usage || event.message?.usage;
                  if (usage) wireUsage = { ...wireUsage, ...usage };
                } catch {}
              }
              if (tail.length > 2 * 1024 * 1024) tail = '';
            } }));
            return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
          } });
        for await (const event of stream) {
          if (deadline.signal.aborted) throw deadline.signal.reason;
          if (signal.aborted && event.type !== 'error') signal.throwIfAborted();
          if (event.type.endsWith('_delta') && event.delta?.length) {
            record.firstProgressAt ||= new Date().toISOString();
            waitFor('stream-idle', idleWaitMs);
          }
          if (event.type === 'done' || event.type === 'error') {
            received = event.type === 'done' ? event.message : event.error;
            if (wireUsage) {
              Object.assign(record, reportedUsage(providerUsage(wireUsage, selectedModel.api)));
              record.cost = connection.kind === 'api' ? referenceCost(record, model.id,
                connection.provider === 'deepseek' && new URL(selectedModel.baseUrl).hostname === 'api.deepseek.com') : null;
              if (!record.cost && connection.kind === 'api' && received.usage.cost?.total > 0) record.cost = {
                min: received.usage.cost.total, max: received.usage.cost.total, currency: 'USD', pricingSource: 'Pi model catalog' };
            }
            received.generationBudget = { requested: maxTokens, sent: record.maxOutputTokens, contextWindow: model.contextWindow,
              input: record.inputTokens, output: record.outputTokens, reasoning: record.reasoningTokens };
            Object.assign(record, { finishReason: received.stopReason, responseId: received.responseId || null,
              status: event.type === 'done' ? 'succeeded' : signal.aborted ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(), latencyMs: Date.now() - started });
            if (event.type === 'error') {
              received.errorMessage = cleanError(received.errorMessage || '模型调用失败'); record.error = received.errorMessage;
              if (tracksConnection) { this.status.failures += 1; Object.assign(this.status, { connected: false, lastError: received.errorMessage }); }
            } else if (tracksConnection) {
              this.status.calls += 1;
              this.status.promptTokens += record.inputTokens || 0; this.status.completionTokens += record.outputTokens || 0;
              this.status.cacheHitTokens += record.cacheHitTokens || 0; this.status.cacheMissTokens += record.cacheMissTokens || 0;
              Object.assign(this.status, { model: model.id, connectionId: connection.id, configured: true, connected: true,
                lastError: null, lastSuccessAt: record.finishedAt, lastLatencyMs: record.latencyMs, actualModel: received.model || model.id });
            }
            persist(); ended = true;
          }
          output.push(event);
        }
        if (!ended) throw deadline.signal.reason || new Error('模型连接在完整响应前结束');
      } catch (error) {
        if (!ended) {
          const message = cleanError(error), cancelled = signal.aborted;
          if (tracksConnection) { this.status.failures += 1; Object.assign(this.status, { connected: false, lastError: message }); }
          if (record) {
            if (wireUsage) Object.assign(record, reportedUsage(providerUsage(wireUsage, selectedModel.api)));
            Object.assign(record, { status: cancelled ? 'cancelled' : 'failed', finishReason: cancelled ? 'aborted' : 'error',
              error: message, finishedAt: new Date().toISOString(), latencyMs: Date.now() - started });
            this.config.recordUsage?.(record);
          }
          const failure = received || { role: 'assistant', content: [], api: selectedModel.api, provider: selectedModel.provider, model: selectedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
          failure.stopReason = cancelled ? 'aborted' : 'error'; failure.errorMessage = message;
          output.push({ type: 'error', reason: failure.stopReason, error: failure });
        }
      } finally { clearTimeout(stageTimer); clearTimeout(totalTimer); this.controllers.delete(controller); output.end(); }
    })();
    return output;
  }
  async complete({ messages, deep = false, json = false, maxTokens, signal, usageContext } = {}) {
    const connection = modelConnection(this.config), reasoning = deep ? 'high' : 'off';
    const model = connectionModel({ ...connection, thinkingLevel: reasoning }), started = Date.now();
    const context = { messages: messages.map(message => ({ ...message,
      content: typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content, timestamp: Date.now() })) };
    if (json) context.messages.unshift({ role: 'system', content: [{ type: 'text', text: 'Return valid JSON.' }] });
    const result = await this.stream(model, context, { reasoning, maxTokens, signal, usageContext }).result();
    if (['error', 'aborted', 'length'].includes(result.stopReason)) throw new Error(result.errorMessage || '模型未完整结束');
    const content = result.content.filter(block => block.type === 'text').map(block => block.text).join('');
    if (!content.trim()) throw new Error('模型没有返回正文');
    return { content, usage: rawUsage(result.usage), model: result.model, latencyMs: Date.now() - started };
  }
  stop() { for (const controller of this.controllers) controller.abort(); }
}
