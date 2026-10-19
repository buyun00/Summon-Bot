import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Agent } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { DeepSeekProvider } from '../src/provider.mjs';

// These tests exercise the real HTTP adapter and pi loop with an explicit fake
// model endpoint. They do not claim live DeepSeek or real file-operation evidence.
const model = { id: 'deepseek-flash', name: 'DeepSeek Flash', api: 'openai-completions', provider: 'deepseek',
  baseUrl: 'http://unused', reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 6000,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
const user = { role: 'user', content: '执行工具后报告真实结果', timestamp: 1 };
const ok = (message, finish_reason = 'stop') => ({ id: 'fake-response', model: 'fake-deepseek',
  choices: [{ message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 6 } });
const toolCall = (argumentsText = '{"path":"report.md"}') => ({ id: 'call-test-1', type: 'function', function: { name: 'read_file', arguments: argumentsText } });

async function fixture(t, responder) {
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const reply = await responder(body, requests.length, response);
      if (reply !== undefined && !response.destroyed) {
        response.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(reply.body || reply));
      }
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const provider = new DeepSeekProvider({ apiKey: 'test-api-key', credentialSource: 'test', baseUrl: `http://127.0.0.1:${server.address().port}` });
  t.after(async () => {
    provider.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { provider, requests };
}

test('pi executes a tool-only response and returns its exact call ID and reasoning to DeepSeek', async t => {
  const { provider, requests } = await fixture(t, (_body, round) => round === 1
    ? ok({ content: null, reasoning_content: 'inspect the requested report', tool_calls: [toolCall()] }, 'tool_calls')
    : ok({ content: '已读到报告中的 CHECKED 内容。' }));
  const executions = [];
  const agent = new Agent({ streamFn: provider.stream.bind(provider), toolExecution: 'sequential', initialState: {
    model, systemPrompt: 'Use tools and verify.', thinkingLevel: 'high', tools: [{
      name: 'read_file', label: 'Read file', description: 'Read a report', parameters: Type.Object({ path: Type.String() }),
      execute: async (id, args) => {
        executions.push({ id, args });
        return { content: [{ type: 'text', text: 'CHECKED' }], details: {} };
      },
    }],
  } });
  await agent.prompt(user);
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(executions, [{ id: 'call-test-1', args: { path: 'report.md' } }]);
  assert.equal(requests[0].messages[0].content, 'Use tools and verify.');
  assert.equal(requests[0].tools[0].function.parameters.properties.path.type, 'string');
  assert.equal(requests[0].thinking.type, 'enabled');
  assert.equal(requests[0].stream, false);
  const replay = requests[1].messages.find(message => message.role === 'assistant');
  assert.equal(replay.content, null);
  assert.equal(replay.reasoning_content, 'inspect the requested report');
  assert.equal(replay.tool_calls[0].id, 'call-test-1');
  assert.deepEqual(requests[1].messages.at(-1), { role: 'tool', tool_call_id: 'call-test-1', content: 'CHECKED' });
  const final = agent.state.messages.at(-1);
  assert.equal(final.content[0].text, '已读到报告中的 CHECKED 内容。');
  assert.equal(final.usage.input, 4);
  assert.equal(final.usage.cacheRead, 6);
  assert.equal(final.usage.output, 4);
  assert.equal(final.usage.totalTokens, 14);
  assert.ok(Math.abs(final.usage.cost.total - 0.0000126) < 1e-12);
  assert.equal(provider.status.calls, 2);
  assert.equal(provider.status.promptTokens, 20);
  assert.equal(provider.status.completionTokens, 8);
  assert.equal(provider.status.cacheHitTokens, 12);
  assert.equal(provider.status.cacheMissTokens, 8);
  assert.equal(provider.controllers.size, 0);
});

test('system deltas replace named sections and remove tools in the outgoing request', async t => {
  const { provider, requests } = await fixture(t, () => ok({ content: 'done' }));
  const tool = name => ({ name, description: name, parameters: Type.Object({}) });
  const stream = provider.stream(model, { messages: [
    { role: 'system', content: 'base', sections: { current: 'old instruction' }, toolsAdded: [tool('old_tool')], timestamp: 0 },
    user,
    { role: 'system', content: 'new instruction', sections: { current: 'replacement' }, toolsRemoved: [{ name: 'old_tool' }], toolsAdded: [tool('new_tool')], timestamp: 2 },
  ] });
  const events = [];
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(events, ['start', 'done']);
  assert.equal((await stream.result()).stopReason, 'stop');
  assert.equal(requests[0].thinking.type, 'disabled');
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['new_tool']);
  assert.ok(requests[0].messages[0].content.includes('replacement'));
  assert.ok(!requests[0].messages[0].content.includes('old instruction'));
});

test('a recreated Agent preserves the exact wire prefix including assistant tool calls and results', async t => {
  const { provider, requests } = await fixture(t, (_body, round) => round === 1
    ? ok({ content: null, tool_calls: [toolCall()] }, 'tool_calls')
    : ok({ content: round === 2 ? 'ready without quoting the tool secret' : 'continued' }));
  let executions = 0;
  const tools = [{ name: 'read_file', label: 'Read', description: 'Read a report', parameters: Type.Object({ path: Type.String() }),
    execute: async () => { executions++; return { content: [{ type: 'text', text: 'TOOL_ONLY_SECRET' }] }; } }];
  const initialState = { model, systemPrompt: 'Keep the conversation.', thinkingLevel: 'off', tools };
  const first = new Agent({ initialState, streamFn: provider.stream.bind(provider) });
  await first.prompt(user);
  const persisted = JSON.parse(JSON.stringify(first.state.messages));
  const second = new Agent({ initialState: { ...initialState, messages: persisted }, streamFn: provider.stream.bind(provider) });
  await second.prompt('Continue using the tool observation.');
  assert.equal(executions, 1, 'restoring tool history must not execute its calls again');
  assert.deepEqual(requests[2].messages.slice(0, requests[1].messages.length), requests[1].messages);
  assert.deepEqual(requests[2].tools, requests[0].tools);
  assert.equal(requests[2].messages.at(-2).content, 'ready without quoting the tool secret');
  assert.equal(requests[2].messages.at(-1).content, 'Continue using the tool observation.');
  assert.equal(requests[2].messages.filter(message => message.role === 'tool')[0].content, 'TOOL_ONLY_SECRET');
  assert.equal(provider.status.cacheHitTokens, 18);
  assert.equal(provider.status.cacheMissTokens, 12);
});

test('empty, truncated, malformed and HTTP failure responses terminate with errors and are never retried', async t => {
  const cases = [
    [ok({ content: null }), /没有返回正文/],
    [ok({ content: '', reasoning_content: 'thinking only' }), /没有返回正文/],
    [ok({ content: 'partial', tool_calls: [toolCall()] }, 'length'), /截断/],
    [ok({ content: null, tool_calls: [toolCall('not json')] }, 'tool_calls'), /有效 JSON/],
    [ok({ content: null, tool_calls: [toolCall('[]')] }, 'tool_calls'), /JSON 对象/],
    [ok({ content: null, tool_calls: [] }, 'tool_calls'), /工具调用响应为空/],
    [{ status: 401, body: { error: { message: 'invalid test-api-key' } } }, /HTTP 401: invalid \[redacted\]/],
  ];
  for (const [reply, expected] of cases) {
    await t.test(String(expected), async t => {
      const { provider, requests } = await fixture(t, () => reply);
      const result = await provider.stream(model, { messages: [user] }).result();
      assert.equal(result.stopReason, 'error');
      assert.match(result.errorMessage, expected);
      assert.deepEqual(result.content, []);
      assert.equal(requests.length, 1);
      assert.equal(provider.status.calls, 0);
      assert.equal(provider.status.failures, 1);
      assert.ok(!JSON.stringify(provider.status).includes('test-api-key'));
      assert.equal(provider.controllers.size, 0);
    });
  }
});

test('caller cancellation and provider stop abort in-flight HTTP requests', async t => {
  for (const mode of ['caller', 'stop']) {
    await t.test(mode, async t => {
      let started;
      const pending = new Promise(resolve => { started = resolve; });
      const { provider, requests } = await fixture(t, () => { started(); });
      const controller = new AbortController();
      const stream = provider.stream(model, { messages: [user] }, { signal: controller.signal });
      await pending;
      if (mode === 'caller') controller.abort();
      else provider.stop();
      const result = await stream.result();
      assert.equal(result.stopReason, 'aborted');
      assert.match(result.errorMessage, /取消/);
      assert.equal(requests.length, 1);
      assert.equal(provider.status.failures, 1);
      assert.equal(provider.controllers.size, 0);
    });
  }
});

test('legacy complete preserves summary JSON mode and rejects empty or truncated responses', async t => {
  const replies = [ok({ content: '{"summary":"done"}' }), ok({ content: '' }), ok({ content: 'partial' }, 'length')];
  const { provider, requests } = await fixture(t, () => replies.shift());
  const result = await provider.complete({ messages: [{ role: 'user', content: 'Summarize' }], json: true });
  assert.equal(result.content, '{"summary":"done"}');
  assert.equal(result.model, 'fake-deepseek');
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.match(requests[0].messages[0].content, /JSON/);
  await assert.rejects(provider.complete({ messages: [] }), /没有返回正文/);
  await assert.rejects(provider.complete({ messages: [] }), /截断/);
  assert.equal(provider.status.calls, 1);
  assert.equal(provider.status.failures, 2);
  assert.equal(provider.status.promptTokens, 30);
});
