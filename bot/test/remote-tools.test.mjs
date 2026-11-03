import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfiguredTools } from '../src/capabilities/remote-tools.mjs';

const inputSchema = { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false };
const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM4sAAAAASUVORK5CYII=';
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'summon-remote-tools-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'cleanup remains inside the test temporary directory');
    return rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return root;
}
function setEnvironment(t, name, value) {
  const old = process.env[name]; process.env[name] = value;
  t.after(() => { if (old === undefined) delete process.env[name]; else process.env[name] = old; });
}
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeHttp(server) {
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
const context = root => ({ botId: 'fixture-bot', workspace: root, dataDir: root });
const definition = (url, name, extra = {}) => ({ type: 'http', name, url, inputSchema, description: `Fixture ${name}`, effect: 'external', ...extra });

test('configured HTTP tools send explicit credentials and body modes, preserve JSON/text/MCP content and redact real errors', async t => {
  const root = await temporary(t), received = [];
  const secret = 'fixture-header-secret-73482';
  setEnvironment(t, 'SUMMON_REMOTE_HTTP_SECRET', secret);
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ path: request.url, body, secret: request.headers['x-api-key'], contentType: request.headers['content-type'] });
    if (request.url === '/text') return response.end('plain response');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/error') { response.statusCode = 403; return response.end(JSON.stringify({ error: `denied ${secret}`, reason: 'permission' })); }
    if (request.url === '/content') return response.end(JSON.stringify({ isError: true, content: [{ type: 'text', text: 'tool failure' }, { type: 'image', data: imageData, mimeType: 'image/png' }] }));
    response.end(JSON.stringify({ received: body, echoed: request.headers['x-api-key'] || null }));
  });
  const base = await listen(server);
  const capabilities = await loadConfiguredTools([
    definition(base + '/args', 'arguments_body', { headersEnv: { 'x-api-key': 'SUMMON_REMOTE_HTTP_SECRET' } }),
    definition(base + '/raw', 'raw_body', { bodyMode: 'raw', headers: { 'Content-Type': 'application/json' } }),
    definition(base + '/text', 'plain_text'), definition(base + '/content', 'content_result'),
    definition(base + '/error', 'http_failure', { headersEnv: { 'x-api-key': 'SUMMON_REMOTE_HTTP_SECRET' } }),
  ], context(root));
  t.after(async () => { await capabilities.close(); await closeHttp(server); });
  const tools = new Map(capabilities.tools.map(tool => [tool.name, tool]));
  const first = await tools.get('arguments_body').execute({ value: '中文 arguments' }, {});
  assert.deepEqual(first.details, { received: { arguments: { value: '中文 arguments' } }, echoed: '[redacted]' });
  assert.equal(received[0].secret, secret);
  const raw = await tools.get('raw_body').execute({ value: 'raw' }, {});
  assert.deepEqual(raw.details.received, { value: 'raw' });
  assert.equal(received[1].contentType, 'application/json');
  assert.equal((await tools.get('plain_text').execute({})).content[0].text, 'plain response');
  const result = await tools.get('content_result').execute({});
  assert.equal(result.isError, true); assert.equal(result.content[1].data, imageData);
  assert.equal(tools.get('content_result').classify(result), 'failed');
  await assert.rejects(tools.get('http_failure').execute({}), error => {
    assert.equal(error.status, 403); assert.equal(error.responseBody.reason, 'permission');
    assert.match(error.message, /denied \[redacted\]/); assert.ok(!JSON.stringify(error).includes(secret)); return true;
  });
});

test('HTTP abort, timeout and close are bounded, do not retry, and do not follow credential redirects', async t => {
  const root = await temporary(t), hits = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the complete request */ }
    hits.push(request.url);
    if (request.url === '/redirect') { response.writeHead(307, { Location: '/target' }); return response.end(); }
    if (request.url === '/target') return response.end('unexpected redirect');
    // Deliberately unresponsive capability; fetch must cancel its connection.
  });
  const base = await listen(server);
  const capabilities = await loadConfiguredTools([
    definition(base + '/timeout', 'timeout_call', { timeoutMs: 150 }),
    definition(base + '/abort', 'abort_call'), definition(base + '/close', 'close_call'),
    definition(base + '/redirect', 'redirect_call', { headers: { Authorization: 'fixture-redirect-secret' } }),
  ], context(root));
  t.after(async () => { await capabilities.close(); await closeHttp(server); });
  const tools = new Map(capabilities.tools.map(tool => [tool.name, tool]));
  const began = Date.now(); await assert.rejects(tools.get('timeout_call').execute({}), error => {
    assert.equal(error.name, 'AbortError'); assert.equal(error.code, 'CAPABILITY_TIMEOUT'); return true;
  });
  assert.ok(Date.now() - began < 2000);
  const controller = new AbortController();
  const aborted = tools.get('abort_call').execute({}, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('fixture caller cancelled')), 60);
  await assert.rejects(aborted, /fixture caller cancelled/);
  await assert.rejects(tools.get('redirect_call').execute({}), /fetch failed/);
  assert.equal(hits.includes('/target'), false);
  const closing = tools.get('close_call').execute({});
  await sleep(60); await capabilities.close(); await assert.rejects(closing, /closed/);
  await assert.rejects(tools.get('abort_call').execute({}), /closed/);
  assert.equal(hits.filter(path => path === '/timeout').length, 1);
  assert.equal(hits.filter(path => path === '/abort').length, 1);
});

test('trusted module factories receive generic context and clean up on closure or validation/collision failure', async t => {
  const root = await temporary(t), modulePath = join(root, 'trusted-tools.mjs');
  await writeFile(modulePath, `import { writeFile } from 'node:fs/promises';
export function createTools(context, options) {
  return { tools: [{ name: options.name, description: 'Trusted fixture', inputSchema: {type:'object'}, effect:'read',
    execute: async (args, call) => ({ args, botId: context.botId, workspace: context.workspace, callBot: call.botId }) }],
    close: () => writeFile(options.closed, 'closed') };
}`);
  const closed = join(root, 'closed.txt');
  const config = { type: 'module', module: modulePath, options: { name: 'module_tool', closed } };
  const capabilities = await loadConfiguredTools([config], context(root));
  assert.deepEqual((await capabilities.tools[0].execute({ value: 'module' })).details,
    { args: { value: 'module' }, botId: 'fixture-bot', workspace: root, callBot: 'fixture-bot' });
  await capabilities.close(); assert.equal(await readFile(closed, 'utf8'), 'closed');
  for (const name of ['bad.tool', '', 'a'.repeat(65)]) {
    const marker = join(root, `invalid-${name.length}.txt`);
    await assert.rejects(loadConfiguredTools([{ ...config, options: { name, closed: marker } }], context(root)), /Invalid configured/);
    assert.equal(await readFile(marker, 'utf8'), 'closed');
  }
  const marker = join(root, 'collision.txt');
  await assert.rejects(loadConfiguredTools([config, { ...config, options: { name: 'module_tool', closed: marker } }], context(root)), /collision/);
  assert.equal(await readFile(marker, 'utf8'), 'closed');
  await assert.rejects(loadConfiguredTools([{ type: 'module', module: './implicit.mjs' }], context(root)), /absolute/);
});

async function mcpFixture(t) {
  const root = await temporary(t), script = join(root, 'mcp-server.mjs');
  const imports = Object.fromEntries(['server/index.js', 'server/stdio.js', 'types.js'].map(path => [path, import.meta.resolve(`@modelcontextprotocol/sdk/${path}`)]));
  await writeFile(script, `import { Server } from ${JSON.stringify(imports['server/index.js'])};
import { StdioServerTransport } from ${JSON.stringify(imports['server/stdio.js'])};
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from ${JSON.stringify(imports['types.js'])};
const server = new Server({name:'independent-mcp-fixture',version:'1.0.0'}, {capabilities:{tools:{}}});
const tool = name => ({name,description:'Standard MCP '+name,inputSchema:{type:'object',properties:{value:{type:'string'}},additionalProperties:false}});
server.setRequestHandler(ListToolsRequestSchema, async request => process.env.FIXTURE_COLLISION
  ? {tools:[tool('same.name'),tool('same_name')]}
  : request.params?.cursor === 'page-2' ? {tools:[tool('failure'),tool('protocol_error'),tool('slow')]}
    : {tools:[tool('echo.tool')],nextCursor:'page-2'});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if(request.params.name === 'failure') return {isError:true,content:[{type:'text',text:'MCP reported failure'}]};
  if(request.params.name === 'protocol_error') throw new McpError(ErrorCode.InvalidParams, 'MCP rejected '+process.env.FIXTURE_SECRET);
  if(request.params.name === 'slow') await new Promise((done,reject) => { const timer=setTimeout(done,10000); extra.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('cancelled'));},{once:true}); });
  return {content:[{type:'text',text:JSON.stringify({arguments:request.params.arguments,pid:process.pid,
    inheritedSecret:process.env.SUMMON_UNCONFIGURED_SECRET || null,explicitSecret:process.env.FIXTURE_SECRET})},
    {type:'image',mimeType:'image/png',data:${JSON.stringify(imageData)}}],structuredContent:{answer:'standard MCP'},isError:false};
});
await server.connect(new StdioServerTransport());
`);
  return { root, script };
}

test('real MCP stdio subprocess initializes, paginates, preserves image/error results and closes its own process', async t => {
  const f = await mcpFixture(t), secret = 'fixture-mcp-secret-192837';
  setEnvironment(t, 'SUMMON_MCP_KEY', secret);
  setEnvironment(t, 'SUMMON_UNCONFIGURED_SECRET', 'ambient-secret-must-not-be-inherited');
  const capabilities = await loadConfiguredTools([{ type: 'mcp', transport: 'stdio', command: process.execPath, args: [f.script],
    env: { FIXTURE_SECRET: { env: 'SUMMON_MCP_KEY' } }, namePrefix: 'mcp_', timeoutMs: 15000 }], context(f.root));
  t.after(() => capabilities.close());
  const tools = new Map(capabilities.tools.map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], ['mcp_echo_tool', 'mcp_failure', 'mcp_protocol_error', 'mcp_slow']);
  const result = await tools.get('mcp_echo_tool').execute({ value: 'MCP 中文' });
  const observed = JSON.parse(result.content[0].text);
  assert.deepEqual(observed.arguments, { value: 'MCP 中文' });
  assert.equal(observed.inheritedSecret, null); assert.equal(observed.explicitSecret, '[redacted]');
  assert.equal(result.content[1].data, imageData); assert.equal(result.structuredContent.answer, 'standard MCP');
  const failure = await tools.get('mcp_failure').execute({}); assert.equal(failure.isError, true);
  assert.equal(tools.get('mcp_failure').classify(failure), 'failed');
  await assert.rejects(tools.get('mcp_protocol_error').execute({}), error => {
    assert.equal(error.code, -32602); assert.match(error.message, /\[redacted\]/); assert.ok(!error.message.includes(secret)); return true;
  });
  const controller = new AbortController();
  const pending = tools.get('mcp_slow').execute({}, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('fixture MCP cancellation')), 50);
  await assert.rejects(pending, /fixture MCP cancellation/);
  await capabilities.close();
  let running = true;
  for (let n = 0; n < 40 && running; n++) {
    try { process.kill(observed.pid, 0); await sleep(50); } catch { running = false; }
  }
  assert.equal(running, false, 'SDK close must reap the fixture MCP server');
});

test('MCP tool aliases reject collisions instead of invoking an ambiguous remote operation', async t => {
  const f = await mcpFixture(t);
  await assert.rejects(loadConfiguredTools([{ type: 'mcp', transport: 'stdio', command: process.execPath,
    args: [f.script], env: { FIXTURE_COLLISION: '1' } }], context(f.root)), /colliding/);
});

test('MCP Streamable HTTP uses standard initialize and JSON-RPC tool requests with configured headers', async t => {
  const root = await temporary(t), methods = [], credentials = [], live = new Set();
  setEnvironment(t, 'SUMMON_MCP_HTTP_KEY', 'fixture-standard-http-secret');
  const server = createServer(async (request, response) => {
    credentials.push(request.headers.authorization);
    if (request.method !== 'POST') { response.writeHead(405); return response.end(); }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); methods.push(body.method);
    const peer = new Server({ name: 'standard-http-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    peer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'http_echo', description: 'HTTP MCP echo', inputSchema }] }));
    peer.setRequestHandler(CallToolRequestSchema, async value => ({ content: [{ type: 'text', text: JSON.stringify(value.params.arguments) }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    live.add(peer);
    response.on('close', () => { live.delete(peer); peer.close().catch(() => {}); });
    await peer.connect(transport);
    await transport.handleRequest(request, response, body);
  });
  const base = await listen(server);
  let capabilities;
  t.after(async () => { await capabilities?.close(); await Promise.allSettled([...live].map(peer => peer.close())); await closeHttp(server); });
  capabilities = await loadConfiguredTools([{ type: 'mcp', transport: 'http', url: base + '/mcp',
    headersEnv: { Authorization: 'SUMMON_MCP_HTTP_KEY' } }], context(root));
  assert.equal((await capabilities.tools[0].execute({ value: 'standard-http' })).content[0].text, '{"value":"standard-http"}');
  assert.ok(methods.includes('initialize')); assert.ok(methods.includes('notifications/initialized'));
  assert.ok(methods.includes('tools/list')); assert.ok(methods.includes('tools/call'));
  assert.ok(credentials.every(value => value === 'fixture-standard-http-secret'));
});
