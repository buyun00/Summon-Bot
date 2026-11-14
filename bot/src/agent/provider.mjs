import { AssistantMessageEventStream, clampThinkingLevel, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { modelConnection, connectionRuntime, modelError, officialDeepSeekCompletions, supportsOpenAIRoomCache } from './connections.mjs';
import { reportedUsage, referenceCost } from './usage.mjs';

const connectionWaitMs = 180000;
const wireReasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const timeoutError = phase => Object.assign(new Error(`Model request timed out during ${phase}`), { code: 'MODEL_DEADLINE' });

function roomCacheRequest(payload, roomCache) {
  if (!Array.isArray(payload?.input) || payload.prompt_cache_options?.mode === 'explicit') return null;
  const remaining = new Set([roomCache.current, roomCache.previous].filter(Boolean));
  let changed = false;
  const input = payload.input.map(message => {
    if (message?.role !== 'user' || !Array.isArray(message.content)) return message;
    const last = message.content.at(-1);
    if (last?.type !== 'input_text' || !remaining.has(last.text)) return message;
    remaining.delete(last.text);
    if (last.prompt_cache_breakpoint) return message;
    changed = true;
    return { ...message, content: [...message.content.slice(0, -1), { ...last, prompt_cache_breakpoint: { mode: 'explicit', ttl: '30m' } }] };
  });
  return {
    payload: changed ? { ...payload, input } : payload,
    throughMessageId: remaining.has(roomCache.current) ? undefined : roomCache.throughMessageId,
  };
}

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
    this.config = { redact: value => value, ...config };
    this.controllers = new Set();
  }
  stream(model, context, options = {}) {
    const output = new AssistantMessageEventStream(), controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const deadline = new AbortController(), requestSignal = AbortSignal.any([signal, deadline.signal]);
    const { timeoutMs: totalWaitMs, onPayload, roomCache, requireEffort, usageContext, beforeFetch, ...streamOptions } = options;
    this.controllers.add(controller);
    const started = Date.now(), secrets = new Set();
    let record, selectedModel = model, received, ended = false, wireUsage, sentReasoningEffort, stageTimer, totalTimer;
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
        const deepseek = officialDeepSeekCompletions({ ...connection, model: model.id }, model.api, model.baseUrl);
        const responses = model.api === 'openai-responses';
        const responsesProtocol = responses || model.api === 'openai-codex-responses';
        const cacheRoomHistory = roomCache?.current && streamOptions.cacheRetention !== 'none' && supportsOpenAIRoomCache(connection, model);
        let roomCacheThroughMessageId;
        const requestedReasoning = options.reasoning || 'off';
        const fastest = model.thinkingLevelMap?.off === null ? ['low', 'medium', 'high'].find(level => model.thinkingLevelMap[level] != null) : null;
        const reasoning = clampThinkingLevel(model, requestedReasoning === 'off' && fastest ? fastest : requestedReasoning);
        const thinking = reasoning !== 'off', idleWaitMs = thinking ? 300000 : 180000;
        const maxTokens = Math.min(options.maxTokens ?? model.maxTokens, model.outputTokenLimit ?? model.maxTokens);
        record = { id: randomUUID(), botId: this.config.botId, ...usageContext,
          purpose: usageContext?.purpose || 'other', provider: connection.kind === 'api' ? connection.provider : connection.kind,
          connectionId: connection.id, billingMode: connection.kind === 'api' ? 'api' : 'subscription',
          model: model.id, requestedModel: model.id, responseModel: null, startedAt: new Date(started).toISOString(), status: 'pending', ...reportedUsage(null),
          thinking, thinkingLevel: reasoning, sentReasoningEffort: null, api: model.api, contextWindow: model.contextWindow, requestedOutputTokens: maxTokens,
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
          sessionId: usageContext?.sessionId || options.sessionId, maxRetries: 0,
          ...(connection.kind === 'codex' ? { transport: 'sse' } : {}),
          onPayload: async (payload, model) => {
            const replacement = await onPayload?.(payload, model);
            const original = replacement ?? payload;
            const cached = cacheRoomHistory ? roomCacheRequest(original, roomCache) : null;
            const sent = cached?.payload ?? original;
            roomCacheThroughMessageId = cached?.throughMessageId;
            record.sentModel = typeof sent?.model === 'string' ? sent.model : null;
            record.toolNames = Array.isArray(sent?.tools) ? sent.tools.map(tool => tool.name ?? tool.function?.name).filter(Boolean) : [];
            record.toolCount = record.toolNames.length;
            const limit = sent?.max_tokens ?? sent?.max_completion_tokens ?? sent?.max_output_tokens;
            record.maxOutputTokens = Number.isSafeInteger(limit) ? limit : null;
            const effort = responsesProtocol ? sent?.reasoning?.effort : sent?.reasoning_effort;
            sentReasoningEffort = deepseek && sent?.thinking?.type === 'disabled' ? 'disabled' : wireReasoningEfforts.has(effort) ? effort : null;
            if (requireEffort && (responsesProtocol || deepseek) && thinking &&
                effort !== (model.thinkingLevelMap?.[requireEffort] ?? requireEffort)) {
              throw new Error(`Model ${model.id} did not serialize the configured reasoning effort ${requireEffort}`);
            }
            return sent !== original ? sent : replacement;
          },
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            const bearer = headers.get('authorization'); if (bearer) secrets.add(bearer.replace(/^Bearer\s+/i, ''));
            if (headers.get('x-api-key')) secrets.add(headers.get('x-api-key'));
            if (typeof init?.body === 'string') {
              let wire;
              try { wire = JSON.parse(init.body); } catch {}
              if (wire && typeof wire.model === 'string') {
                record.sentModel = wire.model;
                if (wire.model !== model.id) throw new Error(`The provider serialized a different model for ${model.id}`);
                const effort = responsesProtocol ? wire.reasoning?.effort : wire.reasoning_effort;
                if (wireReasoningEfforts.has(effort)) sentReasoningEffort = effort;
                if (requireEffort && (responsesProtocol || deepseek) && thinking &&
                    effort !== (model.thinkingLevelMap?.[requireEffort] ?? requireEffort)) {
                  throw new Error(`Model ${model.id} did not serialize the configured reasoning effort ${requireEffort}`);
                }
              }
              if (Array.isArray(wire?.tools)) {
                record.toolNames = wire.tools.map(tool => tool.name ?? tool.function?.name).filter(Boolean);
                record.toolCount = record.toolNames.length;
              }
            }
            record.sentReasoningEffort = sentReasoningEffort ?? null;
            persist();
            await beforeFetch?.();
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
                  const responseModel = responsesProtocol ? event.response?.model : event.model;
                  if (typeof responseModel === 'string' && responseModel !== record.responseModel && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(responseModel) &&
                    !model.baseUrl?.includes(responseModel) && ![...secrets].some(secret => secret && responseModel.includes(secret)) &&
                    modelError(responseModel) === responseModel && this.config.redact(responseModel) === responseModel) record.responseModel = responseModel;
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
            record.lastProgressAt = new Date().toISOString();
            record.firstProgressAt ||= record.lastProgressAt;
            waitFor('stream-idle', idleWaitMs);
          }
          if (event.type === 'done' || event.type === 'error') {
            received = event.type === 'done' ? event.message : event.error;
            if (event.type === 'done' && roomCacheThroughMessageId) received.roomCacheThroughMessageId = roomCacheThroughMessageId;
            if (wireUsage) {
              Object.assign(record, reportedUsage(providerUsage(wireUsage, selectedModel.api)));
              record.cost = connection.kind === 'api' ? referenceCost(record, model.id,
                connection.provider === 'deepseek' && new URL(selectedModel.baseUrl).hostname === 'api.deepseek.com') : null;
              if (!record.cost && connection.kind === 'api' && received.usage.cost?.total > 0) record.cost = {
                min: received.usage.cost.total, max: received.usage.cost.total, currency: 'USD', pricingSource: 'Pi model catalog' };
            }
            received.generationBudget = { requested: maxTokens, sent: record.maxOutputTokens, contextWindow: model.contextWindow,
              input: record.inputTokens, output: record.outputTokens, reasoning: record.reasoningTokens, httpStatus: record.httpStatus || null };
            Object.assign(record, { finishReason: received.stopReason, responseId: received.responseId || null,
              status: event.type === 'done' ? 'succeeded' : signal.aborted ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(), latencyMs: Date.now() - started });
            if (event.type === 'error') {
              received.errorMessage = cleanError(received.errorMessage || '模型调用失败'); record.error = received.errorMessage;
            }
            persist(); ended = true;
          }
          output.push(event);
        }
        if (!ended) throw deadline.signal.reason || new Error('模型连接在完整响应前结束');
      } catch (error) {
        if (!ended) {
          const message = cleanError(error), cancelled = signal.aborted;
          if (record) {
            if (wireUsage) Object.assign(record, reportedUsage(providerUsage(wireUsage, selectedModel.api)));
            Object.assign(record, { status: cancelled ? 'cancelled' : 'failed', finishReason: cancelled ? 'aborted' : 'error',
              error: message, finishedAt: new Date().toISOString(), latencyMs: Date.now() - started });
            try { this.config.recordUsage?.(record); } catch {}
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
  stop() { for (const controller of this.controllers) controller.abort(); }
}
