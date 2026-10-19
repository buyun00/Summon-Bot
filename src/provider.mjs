import { AssistantMessageEventStream, calculateCost, collapseSystemMessages, getCurrentTools, getSystemMessageText, normalizeContext } from '@earendil-works/pi-ai';
import { safeError } from './config.mjs';

const tokenCount = value => Number.isFinite(value) && value > 0 ? value : 0;

function usageFor(result, model) {
  const source = result.usage || {};
  const prompt = tokenCount(source.prompt_tokens);
  const cacheRead = Math.min(prompt, tokenCount(source.prompt_cache_hit_tokens ?? source.prompt_tokens_details?.cached_tokens));
  const output = tokenCount(source.completion_tokens);
  const usage = { input: prompt - cacheRead, output, cacheRead, cacheWrite: 0,
    totalTokens: tokenCount(source.total_tokens) || prompt + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  if (Number.isFinite(source.completion_tokens_details?.reasoning_tokens)) usage.reasoning = tokenCount(source.completion_tokens_details.reasoning_tokens);
  if (model.cost) calculateCost(model, usage);
  return usage;
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new Error('模型上下文正文格式不正确');
  if (content.some(block => block.type !== 'text')) throw new Error('当前 DeepSeek 文件操作会话只支持文本内容');
  return content.map(block => block.text).join('\n');
}

function deepSeekContext(context, deep) {
  // pi 1.3 carries prompt/tool changes in system messages. Replay those changes
  // with pi's own helpers, including section replacements and tool removals.
  const transcript = collapseSystemMessages(normalizeContext(context));
  const tools = getCurrentTools(transcript.messages).map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description, parameters: tool.parameters,
  } }));
  const messages = transcript.messages.flatMap(message => {
    if (message.role === 'system') {
      const content = getSystemMessageText(message);
      return content ? [{ role: 'system', content }] : [];
    }
    if (message.role === 'user') return [{ role: 'user', content: textContent(message.content) }];
    if (message.role === 'toolResult') return [{ role: 'tool', tool_call_id: message.toolCallId, content: textContent(message.content) }];
    if (message.role !== 'assistant') throw new Error(`不支持的模型上下文角色: ${message.role}`);
    const content = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const reasoning = message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('\n');
    const calls = message.content.filter(block => block.type === 'toolCall').map(block => ({
      id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.arguments) },
    }));
    return [{ role: 'assistant', content: content || null,
      ...(calls.length ? { tool_calls: calls } : {}),
      ...(deep || reasoning ? { reasoning_content: reasoning } : {}),
    }];
  });
  return { messages, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) };
}

function responseChoice(result) {
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('DeepSeek 输出被长度上限截断，请缩小请求后重试');
  if (!choice?.message) throw new Error('DeepSeek 没有返回消息');
  if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error(`DeepSeek 未正常结束 (${choice.finish_reason || 'unknown'})`);
  return choice;
}

function assistantContent(choice) {
  const source = choice.message;
  const content = [];
  if (typeof source.reasoning_content === 'string' && source.reasoning_content) content.push({ type: 'thinking', thinking: source.reasoning_content, thinkingSignature: 'reasoning_content' });
  if (typeof source.content === 'string' && source.content.trim()) content.push({ type: 'text', text: source.content });
  const ids = new Set();
  if (source.tool_calls != null && !Array.isArray(source.tool_calls)) throw new Error('DeepSeek 工具调用格式不正确');
  for (const call of source.tool_calls || []) {
    if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || ids.has(call.id) || typeof call.function?.name !== 'string' || !call.function.name) throw new Error('DeepSeek 工具调用缺少有效名称或唯一编号');
    ids.add(call.id);
    let args;
    try { args = JSON.parse(call.function.arguments); } catch { throw new Error('DeepSeek 工具参数不是有效 JSON'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('DeepSeek 工具参数必须是 JSON 对象');
    content.push({ type: 'toolCall', id: call.id, name: call.function.name, arguments: args });
  }
  if (choice.finish_reason === 'tool_calls' && !ids.size) throw new Error('DeepSeek 工具调用响应为空');
  if (!ids.size && !content.some(block => block.type === 'text')) throw new Error(`DeepSeek 没有返回正文 (${choice.finish_reason})`);
  return content;
}

export class DeepSeekProvider {
  constructor(config) {
    this.config = config;
    this.status = { model: 'deepseek-flash', configured: Boolean(config.apiKey), credentialSource: config.credentialSource,
      connected: false, calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, lastError: null, lastSuccessAt: null };
    this.controllers = new Set();
  }

  async request(body, { deep = false, signal, timeoutMs, validate = result => result } = {}) {
    if (!this.config.apiKey) throw new Error('未找到 DeepSeek 密钥，请在本项目 .env 配置 DEEPSEEK_API_KEY');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    const timer = setTimeout(abort, timeoutMs || (deep ? 180000 : 60000));
    const started = Date.now();
    try {
      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: deep ? 'enabled' : 'disabled' }, stream: false, ...body }),
      });
      const raw = await response.text();
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error(`DeepSeek 返回非 JSON (${response.status})`); }
      if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}: ${result?.error?.message || '调用失败'}`);
      if (!result || typeof result !== 'object') throw new Error('DeepSeek 返回无效响应');
      const usage = result.usage || {};
      // A rejected/truncated answer can still be billed; retain its reported usage.
      this.status.promptTokens += tokenCount(usage.prompt_tokens);
      this.status.completionTokens += tokenCount(usage.completion_tokens);
      const value = validate(result);
      this.status.calls += 1;
      Object.assign(this.status, { connected: true, lastError: null, lastSuccessAt: new Date().toISOString(), lastLatencyMs: Date.now() - started, actualModel: result.model });
      return { result, value, latencyMs: Date.now() - started };
    } catch (error) {
      this.status.failures += 1;
      const aborted = controller.signal.aborted;
      this.status.lastError = aborted ? '模型调用已取消、超时或服务正在停止' : safeError(error, this.config);
      this.status.connected = false;
      const failure = new Error(this.status.lastError);
      if (aborted) failure.name = 'AbortError';
      throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
  }

  async complete({ messages, deep = false, json = false, maxTokens, signal } = {}) {
    const requestMessages = [...messages];
    if (json && !requestMessages.some(message => /json/i.test(message.content || ''))) requestMessages.unshift({ role: 'system', content: 'Return valid JSON.' });
    const { result, value: content, latencyMs } = await this.request({ messages: requestMessages,
      max_tokens: maxTokens || (deep ? 6000 : 2200), ...(json ? { response_format: { type: 'json_object' } } : {}),
    }, { deep, signal, validate: result => {
      const choice = responseChoice(result);
      if (typeof choice.message.content !== 'string' || !choice.message.content.trim()) throw new Error(`DeepSeek 没有返回正文 (${choice.finish_reason})`);
      return choice.message.content;
    } });
    return { content, usage: result.usage || {}, model: result.model, latencyMs };
  }

  // StreamFn for pi-agent-core. The HTTP transport deliberately remains non-streaming;
  // pi owns the tool loop, while this adapter emits one complete assistant response.
  stream(model, context, options = {}) {
    const stream = new AssistantMessageEventStream();
    const deep = Boolean(options.reasoning && options.reasoning !== 'off');
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: usageFor({}, model), stopReason: 'pending', timestamp: Date.now() };
    void (async () => {
      try {
        const body = deepSeekContext(context, deep);
        if (options.toolChoice) body.tool_choice = options.toolChoice;
        stream.push({ type: 'start', partial: message });
        await this.request({ ...body, max_tokens: options.maxTokens || model.maxTokens || 6000 }, {
          deep, signal: options.signal, timeoutMs: options.timeoutMs,
          validate: result => {
            message.usage = usageFor(result, model);
            const choice = responseChoice(result);
            message.content = assistantContent(choice);
            message.stopReason = message.content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop';
            message.rawStopReason = choice.finish_reason;
            if (result.model) message.responseModel = result.model;
            if (result.id) message.responseId = result.id;
          },
        });
        stream.push({ type: 'done', reason: message.stopReason, message });
      } catch (error) {
        message.stopReason = error.name === 'AbortError' || options.signal?.aborted ? 'aborted' : 'error';
        message.errorMessage = safeError(error, this.config);
        stream.push({ type: 'error', reason: message.stopReason, error: message });
      } finally {
        stream.end();
      }
    })();
    return stream;
  }

  stop() { for (const controller of this.controllers) controller.abort(); }
}
