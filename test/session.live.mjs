import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { startServer } from '../src/server.mjs';
import { loadConfig, safeError } from '../src/config.mjs';
import { DeepSeekProvider } from '../src/provider.mjs';

// Real, billable DeepSeek calls. Records are isolated here; the fixture project is
// outside .relay because shared access to Relay's runtime directory is protected.
const evidence = resolve('.relay', 'evidence', `session-${new Date().toISOString().replaceAll(':', '-')}`);
const project = await mkdtemp(join(tmpdir(), 'relay-session-live-'));
const dataDir = join(evidence, 'data');
await mkdir(project, { recursive: true });
await mkdir(dataDir, { recursive: true });
const config = loadConfig({ dataDir, database: join(dataDir, 'relay.sqlite'), defaultCwd: project,
  publicOrigin: '', port: 0, agentTimeoutMs: 180000 });
const secretA = randomUUID();
const secretB = randomUUID();
const source = join(project, 'sealed-input.txt');
await writeFile(source, `续聊文件验收\nsecretA=${secretA}\nsecretB=${secretB}\n`, 'utf8');
const captured = [];
const report = { startedAt: new Date().toISOString(), evidence, project,
  provider: 'real configured deepseek-flash', requests: [], rounds: [], checks: {},
  billing: 'Real provider calls may incur charges. Only returned token usage is measured; zero-valued local cost metadata is not a measured price.' };
let app;
let epoch = 0;
let expired = false;
const pause = ms => new Promise(done => setTimeout(done, ms));
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const save = async () => {
  await writeFile(join(evidence, 'requests.json'), JSON.stringify(captured, null, 2));
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
};
const deadline = setTimeout(() => { expired = true; app?.provider.stop(); void app?.close(); }, 600000);

async function boot() {
  const provider = new DeepSeekProvider(config);
  const request = provider.request.bind(provider);
  const serverEpoch = ++epoch;
  provider.request = async (body, options = {}) => {
    // Capture only the actual body/response, never transport Authorization headers or config credentials.
    const record = { index: captured.length + 1, serverEpoch, runId: [...(app?.agentRuntime.active.keys() || [])][0] || null,
      startedAt: new Date().toISOString(), body: clone({ model: 'deepseek-flash', thinking: { type: options.deep ? 'enabled' : 'disabled' }, stream: false, ...body }) };
    captured.push(record);
    try {
      const result = await request(body, options);
      Object.assign(record, { finishedAt: new Date().toISOString(), response: clone(result.result), latencyMs: result.latencyMs });
      return result;
    } catch (error) {
      Object.assign(record, { finishedAt: new Date().toISOString(), error: safeError(error, config) });
      throw error;
    } finally { await save(); }
  };
  app = await startServer({ config, provider });
  console.log(JSON.stringify({ event: 'server_started', serverEpoch, url: app.url, evidence }));
}

async function call(path, body) {
  if (expired) throw new Error('Live session verification exceeded its ten-minute deadline');
  const response = await fetch(app.url + path, { signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function round(roomId, name, prompt) {
  const startIndex = captured.length;
  const message = await call(`/api/rooms/${roomId}/messages`, { content: prompt });
  const until = Date.now() + 190000;
  let job;
  while (Date.now() < until && !expired) {
    job = app.store.list('jobs').find(item => item.messageId === message.id && item.botId === 'bot-engineer');
    if (job && !['queued', 'running'].includes(job.status)) break;
    await pause(100);
  }
  assert.equal(job?.status, 'completed', `${name}: ${JSON.stringify(job)}`);
  const run = app.agentRuntime.get(job.agentRunId);
  assert.equal(run?.status, 'completed', name);
  const requests = captured.slice(startIndex);
  assert.ok(requests.length > 0, `${name} made no actual model request`);
  assert.ok(requests.every(item => item.runId === run.id && item.response), `${name} request attribution failed`);
  const session = app.store.get('agentSessions', run.sessionId);
  assert.ok(session?.messages?.length, `${name} did not persist native messages`);
  const reply = app.store.get('messages', `reply:${job.id}`);
  assert.ok(reply, `${name} has no exact job reply`);
  assert.equal(reply.replyTo, message.id);
  const result = { name, serverEpoch: epoch, runId: run.id, sessionId: run.sessionId, roomId,
    triggerId: message.id, replyId: reply.id, reply: reply.content, toolNames: run.tools.map(item => item.name),
    requestIndices: requests.map(item => item.index), nativeMessages: session.messages.length,
    transcriptSha256: hash(session.messages), firstRequestUsage: requests[0].response.usage || {},
    allRequestUsage: requests.map(item => item.response.usage || {}), recordedRequests: run.requests };
  assert.equal(run.requests?.length, requests.length, `${name} durable per-request accounting`);
  for (const [index, item] of requests.entries()) {
    const actual = item.response.usage || {};
    const saved = run.requests[index];
    assert.equal(saved.index, index + 1);
    assert.equal(saved.firstInRun, index === 0);
    assert.equal(saved.usage.cacheRead, actual.prompt_cache_hit_tokens ?? actual.prompt_tokens_details?.cached_tokens ?? 0);
    assert.equal(saved.usage.input + saved.usage.cacheRead, actual.prompt_tokens);
  }
  report.rounds.push(result);
  await writeFile(join(evidence, `${name}-run.json`), JSON.stringify(run, null, 2));
  await writeFile(join(evidence, `${name}-session.json`), JSON.stringify(session, null, 2));
  await save();
  console.log(JSON.stringify({ event: 'round_completed', name, runId: run.id, sessionId: run.sessionId,
    tools: result.toolNames, cacheHit: result.firstRequestUsage.prompt_cache_hit_tokens ?? null }));
  return { run, session, reply, requests, result };
}

function finalAssistant(request) {
  const message = request.response.choices[0].message;
  return { role: 'assistant', content: message.content || null,
    ...(message.tool_calls?.length ? { tool_calls: message.tool_calls.map(item => ({ id: item.id, type: 'function',
      function: { name: item.function.name, arguments: JSON.stringify(JSON.parse(item.function.arguments)) } })) } : {}),
    ...(request.body.thinking.type === 'enabled' || message.reasoning_content ? { reasoning_content: message.reasoning_content || '' } : {}) };
}

function verifyPrefix(previous, current) {
  const previousRequest = previous.requests.at(-1);
  const expected = [...previousRequest.body.messages, finalAssistant(previousRequest)];
  const actual = current.requests[0].body.messages;
  assert.deepEqual(actual.slice(0, expected.length), expected, 'Next run changed an already completed HTTP message prefix');
  assert.ok(actual.length > expected.length, 'Next run did not append a new user turn');
  assert.deepEqual(current.requests[0].body.tools, previousRequest.body.tools, 'Tool definitions changed between consecutive requests');
  const result = { previousRunId: previous.run.id, currentRunId: current.run.id,
    messageCount: expected.length, byteLength: Buffer.byteLength(JSON.stringify(expected)), sha256: hash(expected),
    completeHttpTranscriptPrefix: true, unchangedTools: true };
  report.prefixChecks ||= [];
  report.prefixChecks.push(result);
}

function verifyNoAlternateMemory() {
  assert.deepEqual(app.store.list('memories'), report.initialMemories, 'Test modified long-term memory');
  assert.deepEqual(app.store.list('nodes'), report.initialNodes, 'Test modified shared knowledge');
  const chat = JSON.stringify(app.store.list('messages'));
  assert.ok(!chat.includes(secretA) && !chat.includes(secretB), 'A secret leaked into ordinary chat history');
  assert.equal(app.executor.list().length, 0, 'Session test unexpectedly delegated to Codex');
}

try {
  await boot();
  report.initialMemories = app.store.list('memories');
  report.initialNodes = app.store.list('nodes');
  const room = await call('/api/rooms', { kind: 'dm', name: '真实 Session 连续工具上下文验收', members: ['user', 'bot-engineer'] });
  const first = await round(room.id, '01-read-secrets', `这是持久 Session 验收。请仅调用一次 read_file 读取真实文件 ${source}。文件包含两个独立随机值 secretA 和 secretB，后续会使用其原始值。不要调用其他工具，不保存 memory 或 knowledge，不写文件，不委托 Codex。读取成功后，最终 JSON 的 reply 必须精确为“准备好了”，不能泄露任何随机值。后续依靠原生工具消息继续。`);
  assert.deepEqual(first.result.toolNames, ['read_file']);
  assert.equal(first.run.tools[0].status, 'completed');
  assert.equal(first.reply.content, '准备好了');
  const savedTool = JSON.stringify(first.session.messages.filter(message => message.role === 'toolResult'));
  assert.ok(savedTool.includes(secretA) && savedTool.includes(secretB), 'First native transcript did not retain both actual read results');
  verifyNoAlternateMemory();
  // Make re-reading the original file incapable of recovering either random value.
  await writeFile(source, '原随机值已由验收程序从源文件移除。请仅使用本会话先前的实际工具消息。\n', 'utf8');

  const second = await round(room.id, '02-continue', '继续刚才的同一会话。只能依据之前 read_file 的原始工具结果，把 secretA 的原始随机值写入个人工作目录 first-result.txt，内容严格为该值加一个换行。只允许一次 write_file，不允许读取或搜索任何文件、执行命令、搜索知识、保存记忆或委托。最终 JSON reply 精确为“已完成第一份文件”，不得在聊天中透露任何随机值。验收程序会独立读取实际文件。');
  assert.equal(second.run.sessionId, first.run.sessionId);
  assert.notEqual(second.run.id, first.run.id);
  assert.deepEqual(second.result.toolNames, ['write_file']);
  const firstOutput = join(second.run.workspace, 'first-result.txt');
  assert.equal(await readFile(firstOutput, 'utf8'), `${secretA}\n`);
  verifyPrefix(first, second);
  verifyNoAlternateMemory();
  const beforeRestart = clone(app.store.get('agentSessions', first.run.sessionId));
  const beforeRuns = app.agentRuntime.list().map(item => item.id);
  const beforeTools = app.store.list('toolRuns').length;
  await app.close();
  await boot();
  assert.deepEqual(app.store.get('agentSessions', first.run.sessionId), beforeRestart, 'Restart changed persisted session');
  assert.deepEqual(app.agentRuntime.list().map(item => item.id), beforeRuns, 'Restart replayed or lost a run');
  assert.equal(app.store.list('toolRuns').length, beforeTools, 'Restart replayed a tool');
  assert.equal(app.agentRuntime.active.size, 0);

  const third = await round(room.id, '03-after-restart', '服务已经重启，现在继续同一会话。仅依据本会话最初 read_file 的原始工具结果，把 secretB 的原始随机值写入个人工作目录 restart-result.txt，内容严格为该值加一个换行。只允许一次 write_file；禁止重新读取或搜索文件、命令、搜索知识、保存记忆或委托。最终 JSON reply 精确为“已完成重启恢复文件”，不得在聊天中透露任何随机值。验收程序会独立读回。');
  assert.equal(third.run.sessionId, first.run.sessionId);
  assert.equal(new Set([first.run.id, second.run.id, third.run.id]).size, 3);
  assert.deepEqual(third.result.toolNames, ['write_file']);
  const restartOutput = join(third.run.workspace, 'restart-result.txt');
  assert.equal(await readFile(restartOutput, 'utf8'), `${secretB}\n`);
  verifyPrefix(second, third);
  verifyNoAlternateMemory();

  // DM rooms are intentionally deduplicated by participant pair. A group is a
  // genuinely separate room for the same Bot, even with the same two members.
  const otherRoom = await call('/api/rooms', { kind: 'group', name: '独立房间隔离验收', members: ['user', 'bot-engineer'] });
  assert.notEqual(otherRoom.id, room.id);
  const isolated = await round(otherRoom.id, '04-other-room', '只做新房间确认，不调用任何工具。最终 JSON reply 精确为“独立房间已建立”。');
  assert.notEqual(isolated.run.sessionId, first.run.sessionId);
  assert.deepEqual(isolated.result.toolNames, []);
  const isolatedInput = JSON.stringify(isolated.requests[0].body.messages);
  assert.ok(!isolatedInput.includes(secretA) && !isolatedInput.includes(secretB), 'Other room received private tool history');
  assert.ok(!isolated.session.messages.some(message => message.role === 'toolResult'), 'Other room inherited tool results');
  verifyNoAlternateMemory();

  let latest = third;
  const continuationNames = new Set(['02-continue', '03-after-restart']);
  const hasContinuationHit = () => report.rounds.some(item => continuationNames.has(item.name) && Number(item.firstRequestUsage.prompt_cache_hit_tokens ?? item.firstRequestUsage.prompt_tokens_details?.cached_tokens) > 0);
  for (let attempt = 1; attempt <= 2 && !hasContinuationHit(); attempt++) {
    // Cache persistence is provider-managed and can be delayed. Preserve every actual attempt.
    await pause(3000);
    const name = `05-cache-followup-${attempt}`;
    const next = await round(room.id, name, `继续本会话，缓存观测追加第 ${attempt} 次。不要调用任何工具，也不要复述随机值；最终 JSON reply 只写“继续完成”。`);
    verifyPrefix(latest, next);
    continuationNames.add(name);
    latest = next;
  }
  verifyNoAlternateMemory();
  report.requests = captured.map(item => ({ index: item.index, serverEpoch: item.serverEpoch, runId: item.runId,
    usage: item.response?.usage, latencyMs: item.latencyMs, error: item.error }));
  const allUsage = captured.reduce((sum, item) => {
    const usage = item.response?.usage || {};
    sum.promptTokens += usage.prompt_tokens || 0;
    sum.cacheHitTokens += usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    sum.cacheMissTokens += usage.prompt_cache_miss_tokens ?? ((usage.prompt_tokens || 0) - (usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0));
    sum.completionTokens += usage.completion_tokens || 0;
    return sum;
  }, { promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 0 });
  report.cache = { providerReported: true, crossRunFirstRequestHitObserved: hasContinuationHit(), allRequests: allUsage,
    continuationFirstRequests: report.rounds.filter(item => continuationNames.has(item.name)).map(item => ({ runId: item.runId, name: item.name, usage: item.firstRequestUsage })) };
  report.artifacts = { source, firstOutput, restartOutput, firstExpected: secretA, restartExpected: secretB,
    firstSha256: createHash('sha256').update(await readFile(firstOutput)).digest('hex'),
    restartSha256: createHash('sha256').update(await readFile(restartOutput)).digest('hex') };
  report.checks = { realProvider: true, continuationUsesOriginalToolResult: true, secretsAbsentFromChatAndMemory: true,
    sourceRemovedBeforeContinuation: true, distinctRunsSameSession: true, exactHttpPrefixPreserved: true,
    restartRestoresExactNativeTranscript: true, restartNoReplay: true, restartedContinuationUsesOriginalToolResult: true,
    differentRoomHasIsolatedSession: true, independentFileReadback: true, durableRequestUsageMatchesProvider: true,
    cacheHitObserved: hasContinuationHit() };
  report.status = hasContinuationHit() ? 'passed' : 'functional_pass_cache_not_observed';
  report.finishedAt = new Date().toISOString();
  delete report.initialMemories;
  delete report.initialNodes;
  await save();
  console.log(JSON.stringify({ status: report.status, evidence, cache: report.cache, checks: report.checks }));
} catch (error) {
  report.status = 'failed';
  report.error = safeError(error, config);
  report.finishedAt = new Date().toISOString();
  try { report.failedRuns = app?.agentRuntime.list(); } catch { /* Service may already have closed on the deadline. */ }
  await save();
  console.error(JSON.stringify({ status: 'failed', error: report.error, evidence }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await app?.close();
}
