import { AssistantMessageEventStream, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { modelConnection, connectionRuntime, modelError, officialDeepSeekCompletions, supportsOpenAIRoomCache } from './connections.mjs';
import { reportedUsage, referenceCost } from './usage.mjs';

const connectionWaitMs = 180000;
const wireReasoningEffort = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(value) ? value : null;
const budgetThinkingLevels = new Set(['minimal', 'low', 'medium', 'high']);
const codexTerminalEvents = new Set(['response.done', 'response.completed', 'response.incomplete', 'response.failed']);
const timeoutError = phase => Object.assign(new Error(`Model request timed out during ${phase}`), { code: 'MODEL_DEADLINE' });
const transientNetworkCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH',
  'EHOSTUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']);

function serializedReasoning(payload) {
  const fields = [['reasoning.effort', payload?.reasoning?.effort], ['reasoning_effort', payload?.reasoning_effort],
    ['output_config.effort', payload?.output_config?.effort], ['thinking', typeof payload?.thinking === 'string' ? payload.thinking : undefined]];
  const [source, topLevel] = fields.find(([, value]) => value !== undefined) || [];
  if (payload?.thinking?.type === 'disabled') return { effort: 'disabled', topLevel, source: 'thinking.type' };
  if (topLevel === undefined) {
    const toggles = [['enable_thinking', payload?.enable_thinking], ['reasoning.enabled', payload?.reasoning?.enabled],
      ['chat_template_kwargs.enable_thinking', payload?.chat_template_kwargs?.enable_thinking],
      ['chat_template_args.enable_thinking', payload?.chat_template_args?.enable_thinking]];
    const disabled = toggles.find(([, value]) => value === false);
    if (disabled) return { effort: 'disabled', topLevel, source: disabled[0] };
  }
  return { effort: topLevel, topLevel, source };
}

function hasReasoningDialect(payload) {
  return ['reasoning', 'reasoning_effort', 'thinking', 'enable_thinking', 'chat_template_kwargs', 'chat_template_args'].some(key => Object.hasOwn(payload, key));
}

function providerDefaults(payload) {
  const { reasoning, reasoning_effort, thinking, enable_thinking, output_config, ...body } = payload;
  if (output_config) {
    const { effort, ...config } = output_config;
    if (Object.keys(config).length) body.output_config = config;
  }
  for (const key of ['chat_template_kwargs', 'chat_template_args']) {
    if (body[key] && Object.hasOwn(body[key], 'enable_thinking')) {
      const { enable_thinking, ...settings } = body[key];
      body[key] = settings;
    }
  }
  return body;
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

function countWireImages(parts) {
  if (!Array.isArray(parts)) return 0;
  let count = 0;
  for (const part of parts) {
    if (['input_image', 'image_url', 'image'].includes(part?.type)) count++;
    else count += countWireImages(part?.content) + countWireImages(part?.output);
  }
  return count;
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
    const { timeoutMs: totalWaitMs, onPayload, onProviderStreamEvent, roomCache, cacheSessionId, reasoning: requestedReasoning = null,
      usageContext, beforeFetch, ...streamOptions } = options;
    this.controllers.add(controller);
    const started = Date.now(), secrets = new Set();
    let record, received, ended = false, wireUsage, usageSource, stageTimer, totalTimer;
    let transportFault, outputStarted = false;
    let failureTag = `${model.provider}/${model.id}${requestedReasoning !== null ? ` · effort=${requestedReasoning}` : ''}`;
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
      return (this.config.redact.error || this.config.redact)({ message: modelError(message) }).message;
    };
    const decorateError = message => !message || signal.aborted || message.includes(model.id) ? message : `${message} [${failureTag}]`;
    const recordFailure = message => {
      if (!record || signal.aborted) return;
      const http = record.httpStatus;
      const phase = record.timeoutPhase ?? transportFault ?? (http === 429 || http >= 500 ? 'provider-unavailable' : undefined);
      if (!phase) return;
      const partial = outputStarted || record.firstProgressAt || record.outputTokens > 0 ||
        message.content?.some(part => part.type === 'toolCall' || part.type === 'image' || part.text || part.thinking);
      const failure = { phase, before_output: !partial, retryable: !partial && !(http >= 400 && http < 500 && http !== 429) &&
        ['connection', 'first-progress', 'network-before-headers', 'provider-unavailable'].includes(phase) };
      record.transportFailure = message.transportFailure = failure;
    };
    const persist = () => {
      if (!record) return;
      try { this.config.recordUsage?.(record); }
      catch {
        if (record.usageWriteFailed) return;
        record.usageWriteFailed = true;
        this.config.reportUsageError?.();
      }
    };
    void (async () => {
      try {
        const connection = modelConnection(this.config, this.config.connectionStore ? model.provider : undefined);
        failureTag = `${connection.name || connection.id} · ${model.id}${requestedReasoning !== null ? ` · effort=${requestedReasoning}` : ''}`;
        const deepseek = officialDeepSeekCompletions({ ...connection, model: model.id }, model.api, model.baseUrl);
        const responses = model.api === 'openai-responses';
        const codex = model.api === 'openai-codex-responses';
        const responsesProtocol = responses || codex;
        const anthropic = model.api === 'anthropic-messages';
        const completions = model.api === 'openai-completions';
        const thinking = requestedReasoning !== null && requestedReasoning !== 'off';
        const useThinkingBudget = anthropic && !model.compat?.forceAdaptiveThinking && budgetThinkingLevels.has(requestedReasoning);
        const effort = model.thinkingLevelMap?.[requestedReasoning] ?? (requestedReasoning === 'off' ? 'none'
          : anthropic && requestedReasoning === 'minimal' ? 'low' : requestedReasoning);
        // Pass named efforts through the SDK without rounding new provider levels.
        const wireModel = { ...model, reasoning: requestedReasoning !== null || model.reasoning,
          compat: { ...model.compat, ...(responses || anthropic ? { supportsMidConvoEffort: false } : {}),
            ...(anthropic && thinking && !useThinkingBudget ? { forceAdaptiveThinking: true } : {}) },
          thinkingLevelMap: { ...model.thinkingLevelMap, low: effort, ...(requestedReasoning === 'off' ? { off: effort } : {}) } };
        const runtime = connectionRuntime(connection, undefined, wireModel);
        const cacheRoomHistory = roomCache?.current && streamOptions.cacheRetention !== 'none' && supportsOpenAIRoomCache(connection, model);
        let roomCacheThroughMessageId;
        const reasoning = thinking ? (useThinkingBudget ? requestedReasoning : 'low') : undefined;
        const idleWaitMs = requestedReasoning === 'off' ? 180000 : 300000;
        const explicitEffort = requestedReasoning !== null && !useThinkingBudget;
        const validateReasoning = payload => {
          const result = serializedReasoning(payload);
          const disabled = requestedReasoning === 'off' && result.effort === 'disabled';
          if (explicitEffort && result.effort !== effort && !disabled ||
              useThinkingBudget && (payload?.thinking?.type !== 'enabled' || !Number.isSafeInteger(payload.thinking.budget_tokens)))
            throw new Error(`Model ${model.id} did not serialize the configured reasoning effort ${requestedReasoning}`);
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
          thinking, thinkingLevel: requestedReasoning, sentReasoningEffort: null, sentReasoningEffortSource: null, sentTopLevelReasoningEffort: null,
          api: model.api, contextWindow: model.contextWindow, requestedOutputTokens: maxTokens,
          messageCount: context.messages?.length || 0, toolCount: getCurrentTools(normalizeContext(context).messages).length, maxOutputTokens: null };
        persist();
        waitFor('connection', connectionWaitMs);
        if (totalWaitMs) totalTimer = setTimeout(() => {
          record.timeoutPhase = 'total-budget'; deadline.abort(timeoutError('total-budget'));
        }, totalWaitMs);
        const stream = runtime.models.streamSimple(wireModel, context, { ...streamOptions, reasoning, maxTokens, signal: requestSignal,
          // The SDK uses this for its HTTP header wait. Stream lifetime is
          // governed separately by meaningful deltas and the caller's stop.
          timeoutMs: connectionWaitMs + 1000,
          sessionId: cacheSessionId || usageContext?.sessionId || options.sessionId, maxRetries: 0,
          ...(connection.kind === 'codex' ? { transport: 'sse' } : {}),
          onProviderStreamEvent: async (event, model) => {
            if (event?.type === 'response.output_item.added' && event.item?.type && !['message', 'reasoning'].includes(event.item.type))
              outputStarted = true;
            if (codex && event?.response && (event.type === 'response.created' || codexTerminalEvents.has(event.type))) {
              try { observeUsage(event, 'sdk_provider_event'); } catch {}
            }
            await onProviderStreamEvent?.(event, model);
          },
          onPayload: async (payload, model) => {
            const replacement = await onPayload?.(payload, model);
            const original = replacement ?? payload;
            let withReasoning = original;
            if (requestedReasoning === null) withReasoning = providerDefaults(original);
            else if (responsesProtocol) withReasoning = { ...original, reasoning: { ...original.reasoning, effort } };
            else if (deepseek) {
              const { reasoning_effort, ...body } = original;
              withReasoning = { ...body, thinking: { ...body.thinking, type: thinking ? 'enabled' : 'disabled' },
                ...(thinking ? { reasoning_effort: effort } : {}) };
            } else if (completions && !hasReasoningDialect(original)) withReasoning = { ...original, reasoning_effort: effort };
            const cached = cacheRoomHistory ? roomCacheRequest(withReasoning, roomCache) : null;
            const sent = cached?.payload ?? withReasoning;
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
            const efforts = wire ? validateReasoning(wire) : serializedReasoning();
            await beforeFetch?.();
            if (wire && context.messages?.some(msg => msg.role === 'toolResult' && msg.content?.some(part => part.type === 'image')))
              record.sentImageCount = countWireImages(wire.input ?? wire.messages);
            if (cacheSessionId && wire) {
              record.sentPromptCacheKey = wire.prompt_cache_key ?? null;
              record.sentExplicitCacheBreakpoint = Array.isArray(wire.input) && wire.input.some(item =>
                Array.isArray(item?.content) && item.content.some(part => part?.prompt_cache_breakpoint?.mode === 'explicit'));
            }
            if (typeof wire?.model === 'string') record.sentModel = wire.model;
            if (Array.isArray(wire?.tools)) {
              record.toolNames = wire.tools.map(tool => tool.name ?? tool.function?.name).filter(Boolean);
              record.toolCount = record.toolNames.length;
            }
            record.sentReasoningEffort = wireReasoningEffort(efforts.effort);
            record.sentReasoningEffortSource = record.sentReasoningEffort === null ? null : efforts.source;
            record.sentTopLevelReasoningEffort = wireReasoningEffort(efforts.topLevel);
            persist();
            let response;
            try { response = await fetch(input, { ...init, redirect: 'error' }); }
            catch (error) {
              const causes = [error, error.cause, ...(error.cause instanceof AggregateError ? error.cause.errors : [])];
              if (causes.some(cause => transientNetworkCodes.has(cause?.code))) transportFault = 'network-before-headers';
              throw error;
            }
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
          if (event.type.startsWith('toolcall_') || event.type.endsWith('_delta') && event.delta?.length) outputStarted = true;
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
              recordFailure(received);
              received.errorMessage = decorateError(cleanError(received.errorMessage || '模型调用失败')); record.error = received.errorMessage;
            }
            persist(); ended = true;
          }
          output.push(event);
        }
        if (!ended) throw deadline.signal.reason || new Error('模型连接在完整响应前结束');
      } catch (error) {
        if (!ended) {
          const message = decorateError(cleanError(error)), cancelled = signal.aborted;
          if (record) {
            if (wireUsage) Object.assign(record, reportedUsage(providerUsage(wireUsage, model.api)), { usageSource });
            Object.assign(record, { status: cancelled ? 'cancelled' : 'failed', finishReason: cancelled ? 'aborted' : 'error',
              error: message, finishedAt: new Date().toISOString(), latencyMs: Date.now() - started });
          }
          const failure = received || { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
          failure.stopReason = cancelled ? 'aborted' : 'error'; failure.errorMessage = message;
          recordFailure(failure);
          persist();
          output.push({ type: 'error', reason: failure.stopReason, error: failure });
        }
      } finally { clearTimeout(stageTimer); clearTimeout(totalTimer); this.controllers.delete(controller); output.end(); }
    })();
    return output;
  }
  stop() { for (const controller of this.controllers) controller.abort(); }
}
