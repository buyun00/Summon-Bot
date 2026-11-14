import { AssistantMessageEventStream, clampThinkingLevel, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { modelConnection, connectionRuntime, modelError, officialDeepSeekCompletions, supportsOpenAIRoomCache } from './connections.mjs';
import { reportedUsage, referenceCost } from './usage.mjs';

const connectionWaitMs = 180000;
const wireReasoningEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const codexTerminalEvents = new Set(['response.done', 'response.completed', 'response.incomplete', 'response.failed']);
const timeoutError = phase => Object.assign(new Error(`Model request timed out during ${phase}`), { code: 'MODEL_DEADLINE' });

function serializedReasoning(payload, model, deepseek) {
  const responses = model.api === 'openai-responses' || model.api === 'openai-codex-responses';
  const topLevel = responses ? payload?.reasoning?.effort : payload?.reasoning_effort;
  // The Responses adapter can carry the active effort in a final configuration update.
  // Earlier updates preserve past turns, and the top-level effort can remain fixed for caching.
  const update = model.api === 'openai-responses' && model.compat?.supportsMidConvoEffort && Array.isArray(payload?.input)
    ? payload.input.findLast(item => item?.type === 'configuration_update' && item.reasoning?.effort !== undefined)
    : undefined;
  if (update) return { effort: update.reasoning.effort, topLevel, source: 'configuration_update' };
  if (deepseek && payload?.thinking?.type === 'disabled') return { effort: 'disabled', topLevel, source: 'thinking.type' };
  return { effort: topLevel, topLevel, source: responses ? 'reasoning.effort' : 'reasoning_effort' };
}

function readWirePayload(body, headers) {
  const compressed = headers.get('content-encoding')?.trim().toLowerCase() === 'zstd';
  if (compressed && !(body instanceof Uint8Array)) throw new Error('Expected bytes for the zstd model request');
  if (!compressed && typeof body !== 'string') return undefined;
  try {
    return JSON.parse(compressed ? zstdDecompressSync(body).toString('utf8') : body);
  } catch {
    if (compressed) throw new Error('Could not decode the zstd model request as JSON');
    return undefined;
  }
}

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

function codexFinalUsage(message) {
  const usage = message?.usage;
  if (typeof message?.responseId !== 'string' || !message.responseId || !usage ||
      !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens <= 0) return null;
  const inputs = [usage.input, usage.cacheRead, usage.cacheWrite];
  if (![...inputs, usage.output].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  const input = inputs.reduce((total, value) => total + value, 0);
  if (input + usage.output !== usage.totalTokens) return null;
  return {
    input_tokens: input, output_tokens: usage.output, total_tokens: usage.totalTokens,
    ...(usage.cacheRead > 0 ? { input_tokens_details: { cached_tokens: usage.cacheRead } } : {}),
    ...(Number.isSafeInteger(usage.reasoning) && usage.reasoning > 0 && usage.reasoning <= usage.output
      ? { output_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
  };
}

function mergeCodexFinalUsage(wireUsage, finalUsage) {
  if (!finalUsage) return null;
  const wire = providerUsage(wireUsage, 'openai-codex-responses');
  const sdk = providerUsage(finalUsage, 'openai-codex-responses');
  const existing = reportedUsage(wire);
  const fallback = reportedUsage(sdk);
  // A partial raw receipt can identify the same result. A conflicting count cannot.
  if (['inputTokens', 'outputTokens', 'totalTokens'].some(key => existing[key] !== null && existing[key] !== fallback[key])) return null;
  return {
    ...sdk, ...wire,
    prompt_tokens: wire?.prompt_tokens ?? sdk.prompt_tokens,
    completion_tokens: wire?.completion_tokens ?? sdk.completion_tokens,
    total_tokens: wire?.total_tokens ?? sdk.total_tokens,
    prompt_tokens_details: { ...sdk.prompt_tokens_details, ...wire?.prompt_tokens_details },
    completion_tokens_details: { ...sdk.completion_tokens_details, ...wire?.completion_tokens_details },
  };
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
    const { timeoutMs: totalWaitMs, onPayload, onProviderStreamEvent, roomCache, requireEffort, usageContext, beforeFetch, ...streamOptions } = options;
    this.controllers.add(controller);
    const started = Date.now(), secrets = new Set();
    let record, received, ended = false, wireUsage, usageSource, stageTimer, totalTimer;
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
        const deepseek = officialDeepSeekCompletions({ ...connection, model: model.id }, model.api, model.baseUrl);
        const responses = model.api === 'openai-responses';
        const codex = model.api === 'openai-codex-responses';
        const responsesProtocol = responses || codex;
        // A fixed effort belongs in the request-level Responses field for every turn of this binding.
        const wireModel = requireEffort && responses && model.compat?.supportsMidConvoEffort
          ? { ...model, compat: { ...model.compat, supportsMidConvoEffort: false } } : model;
        const runtime = connectionRuntime(connection, undefined, wireModel);
        const cacheRoomHistory = roomCache?.current && streamOptions.cacheRetention !== 'none' && supportsOpenAIRoomCache(connection, model);
        let roomCacheThroughMessageId;
        const requestedReasoning = options.reasoning || 'off';
        const fastest = model.thinkingLevelMap?.off === null ? ['low', 'medium', 'high'].find(level => model.thinkingLevelMap[level] != null) : null;
        const reasoning = clampThinkingLevel(model, requestedReasoning === 'off' && fastest ? fastest : requestedReasoning);
        const thinking = reasoning !== 'off', idleWaitMs = thinking ? 300000 : 180000;
        const expectedEffort = requireEffort && (responsesProtocol || deepseek) && thinking
          ? model.thinkingLevelMap?.[requireEffort] ?? requireEffort : null;
        const validateReasoning = payload => {
          const result = serializedReasoning(payload, model, deepseek);
          if (expectedEffort !== null && result.effort !== expectedEffort)
            throw new Error(`Model ${model.id} did not serialize the configured reasoning effort ${requireEffort}`);
          return result;
        };
        const observeUsage = (event, source) => {
          const usage = codex ? (codexTerminalEvents.has(event.type) ? event.response?.usage : null) :
            event?.usage || event?.response?.usage || event?.message?.usage;
          if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
            wireUsage = { ...wireUsage, ...usage };
            usageSource = source;
          }
          const responseModel = responsesProtocol ? event?.response?.model : event?.model;
          if (typeof responseModel === 'string' && responseModel !== record.responseModel && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(responseModel) &&
              !model.baseUrl?.includes(responseModel) && ![...secrets].some(secret => secret && responseModel.includes(secret)) &&
              modelError(responseModel) === responseModel && this.config.redact(responseModel) === responseModel) record.responseModel = responseModel;
        };
        const maxTokens = Math.min(options.maxTokens ?? model.maxTokens, model.outputTokenLimit ?? model.maxTokens);
        record = { id: randomUUID(), botId: this.config.botId, ...usageContext,
          purpose: usageContext?.purpose || 'other', provider: connection.kind === 'api' ? connection.provider : connection.kind,
          connectionId: connection.id, billingMode: connection.kind === 'api' ? 'api' : 'subscription',
          model: model.id, requestedModel: model.id, sentModel: null, responseModel: null, startedAt: new Date(started).toISOString(), status: 'pending', ...reportedUsage(null),
          thinking, thinkingLevel: reasoning, sentReasoningEffort: null, sentReasoningEffortSource: null, sentTopLevelReasoningEffort: null,
          api: model.api, contextWindow: model.contextWindow, requestedOutputTokens: maxTokens,
          messageCount: context.messages?.length || 0, toolCount: getCurrentTools(normalizeContext(context).messages).length, maxOutputTokens: null };
        const persist = () => this.config.recordUsage?.(record); persist();
        waitFor('connection', connectionWaitMs);
        if (totalWaitMs) totalTimer = setTimeout(() => {
          record.timeoutPhase = 'total-budget'; deadline.abort(timeoutError('total-budget'));
        }, totalWaitMs);
        const stream = runtime.models.streamSimple(wireModel, context, { ...streamOptions, reasoning, maxTokens, signal: requestSignal,
          // The SDK uses this for its HTTP header wait. Stream lifetime is
          // governed separately by meaningful deltas and the caller's stop.
          timeoutMs: connectionWaitMs + 1000,
          sessionId: usageContext?.sessionId || options.sessionId, maxRetries: 0,
          ...(connection.kind === 'codex' ? { transport: 'sse' } : {}),
          onProviderStreamEvent: async (event, model) => {
            if (codex && event?.response && (event.type === 'response.created' || codexTerminalEvents.has(event.type))) {
              try { observeUsage(event, 'sdk_provider_event'); } catch {}
            }
            await onProviderStreamEvent?.(event, model);
          },
          onPayload: async (payload, model) => {
            const replacement = await onPayload?.(payload, model);
            const original = replacement ?? payload;
            const cached = cacheRoomHistory ? roomCacheRequest(original, roomCache) : null;
            const sent = cached?.payload ?? original;
            roomCacheThroughMessageId = cached?.throughMessageId;
            record.toolNames = Array.isArray(sent?.tools) ? sent.tools.map(tool => tool.name ?? tool.function?.name).filter(Boolean) : [];
            record.toolCount = record.toolNames.length;
            const limit = sent?.max_tokens ?? sent?.max_completion_tokens ?? sent?.max_output_tokens;
            record.maxOutputTokens = Number.isSafeInteger(limit) ? limit : null;
            validateReasoning(sent);
            return sent !== original ? sent : replacement;
          },
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            const bearer = headers.get('authorization'); if (bearer) secrets.add(bearer.replace(/^Bearer\s+/i, ''));
            if (headers.get('x-api-key')) secrets.add(headers.get('x-api-key'));
            const wire = readWirePayload(init?.body, headers);
            if (typeof wire?.model === 'string' && wire.model !== model.id)
              throw new Error(`The provider serialized a different model for ${model.id}`);
            const efforts = validateReasoning(wire);
            await beforeFetch?.();
            if (typeof wire?.model === 'string') record.sentModel = wire.model;
            if (Array.isArray(wire?.tools)) {
              record.toolNames = wire.tools.map(tool => tool.name ?? tool.function?.name).filter(Boolean);
              record.toolCount = record.toolNames.length;
            }
            record.sentReasoningEffort = wireReasoningEfforts.has(efforts.effort) || efforts.effort === 'disabled' ? efforts.effort : null;
            record.sentReasoningEffortSource = record.sentReasoningEffort === null ? null : efforts.source;
            record.sentTopLevelReasoningEffort = wireReasoningEfforts.has(efforts.topLevel) ? efforts.topLevel : null;
            persist();
            const response = await fetch(input, { ...init, redirect: 'error' });
            record.httpStatus = response.status;
            waitFor('first-progress', idleWaitMs);
            if (codex || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
            let tail = ''; const decoder = new TextDecoder();
            // Observe billing fields while forwarding bytes; missing usage stays unknown.
            const body = response.body.pipeThrough(new TransformStream({ transform(chunk, destination) {
              destination.enqueue(chunk); tail += decoder.decode(chunk, { stream: true });
              let split;
              while ((split = tail.indexOf('\n')) >= 0) {
                const line = tail.slice(0, split).trim(); tail = tail.slice(split + 1);
                if (!line.startsWith('data:')) continue;
                try { observeUsage(JSON.parse(line.slice(5)), 'sse'); } catch {}
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
            let usage = providerUsage(wireUsage, model.api);
            if (codex && !reportedUsage(usage).usageReported) {
              const fallback = mergeCodexFinalUsage(wireUsage, codexFinalUsage(received));
              if (fallback) {
                usage = fallback;
                usageSource = wireUsage ? 'sdk_provider_event_and_final_usage' : 'sdk_final_usage';
              }
            }
            if (usage) {
              Object.assign(record, reportedUsage(usage), { usageSource });
              record.cost = connection.kind === 'api' ? referenceCost(record, model.id,
                connection.provider === 'deepseek' && new URL(model.baseUrl).hostname === 'api.deepseek.com') : null;
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
            if (wireUsage) Object.assign(record, reportedUsage(providerUsage(wireUsage, model.api)), { usageSource });
            Object.assign(record, { status: cancelled ? 'cancelled' : 'failed', finishReason: cancelled ? 'aborted' : 'error',
              error: message, finishedAt: new Date().toISOString(), latencyMs: Date.now() - started });
            try { this.config.recordUsage?.(record); } catch {}
          }
          const failure = received || { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
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
