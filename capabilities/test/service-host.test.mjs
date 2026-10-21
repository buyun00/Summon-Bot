import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCapabilityService } from '../services/host.mjs';
import { CapabilityServiceSupervisor } from '../services/supervisor.mjs';

const token = 'private-explicit-service-fixture-token';
const tool = { name: 'echo', description: 'Protocol fixture', inputSchema: { type: 'object' }, effect: 'read' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async check => { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(20); } throw new Error('Service fixture condition timed out'); };
async function http(service, path, body, bearer = token) {
  const response = await fetch(`${service.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
}

test('independent service API and real MCP client authenticate and share the same tool implementation', async t => {
  const service = await startCapabilityService({ id: 'fixture', version: 'v1', token, tools: [tool], callTool: (_name, args, context) => ({ ...args, actor: context.actor }),
    operations: { echo: value => ({ value }) } });
  t.after(() => service.close());
  assert.equal((await http(service, '/manifest', undefined, 'incorrect')).status, 401);
  assert.equal((await http(service, '/manifest')).value.version, 'v1');
  assert.deepEqual((await http(service, '/tools/echo', { arguments: { text: 'HTTP' }, context: { actor: 'bot-one' } })).value, { text: 'HTTP', actor: 'bot-one' });
  assert.deepEqual((await http(service, '/rpc/echo', { arguments: ['RPC'] })).value, { value: 'RPC' });
  assert.equal((await http(service, '/rpc/toString', {})).status, 404);
  const client = new Client({ name: 'service-fixture-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${service.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  assert.equal((await client.listTools()).tools[0].name, 'echo');
  assert.deepEqual(JSON.parse((await client.callTool({ name: 'echo', arguments: { text: 'MCP' } })).content[0].text), { text: 'MCP' });
});

test('drain refuses new work and shutdown preserves in-flight requests and background jobs', async t => {
  let finish, pending = 1;
  const held = new Promise(resolve => { finish = resolve; });
  const service = await startCapabilityService({ id: 'fixture', version: 'v1', token, tools: [tool], callTool: () => held, pendingWork: () => pending });
  t.after(async () => { pending = 0; finish({ done: true }); await service.close(); });
  const call = http(service, '/tools/echo', { arguments: {} });
  await until(async () => (await service.health()).activeRequests === 1);
  const refused = await http(service, '/internal/shutdown', {});
  assert.equal(refused.status, 409); assert.equal(refused.value.code, 'CAPABILITY_BUSY');
  assert.equal((await service.health()).state, 'ready');
  await http(service, '/internal/drain', {});
  assert.equal((await http(service, '/tools/echo', { arguments: {} })).status, 409);
  let closed = false;
  const closing = service.close().then(() => { closed = true; });
  finish({ done: true });
  assert.deepEqual((await call).value, { done: true });
  await delay(40); assert.equal(closed, false);
  pending = 0; await closing; assert.equal(closed, true);
});

test('caller disconnect aborts its request and oversize bodies never reach the handler', async t => {
  let aborted = false, entered = false;
  const service = await startCapabilityService({ id: 'fixture', version: 'v1', token, tools: [tool], maxRequestBytes: 256,
    callTool: (_name, _args, _context, signal) => { entered = true; return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(null); }, { once: true })); } });
  t.after(() => service.close());
  assert.equal((await http(service, '/tools/echo', { arguments: { text: 'x'.repeat(512) } })).status, 413);
  assert.equal(entered, false);
  const controller = new AbortController();
  const request = fetch(`${service.url}/tools/echo`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}', signal: controller.signal }).catch(error => error);
  await until(() => entered); controller.abort(); await request;
  await until(() => aborted); assert.equal((await service.health()).activeRequests, 0);
});

test('supervisor owns real independent versions and reuses their process after gateway replacement', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'relay-service-host-'));
  const releaseRoot = resolve(import.meta.dirname, '../..');
  const first = new CapabilityServiceSupervisor({ dataRoot, releaseRoot });
  const second = new CapabilityServiceSupervisor({ dataRoot, releaseRoot });
  const module = join(dataRoot, 'fixture.mjs');
  await writeFile(module, await readFile(join(releaseRoot, 'capabilities/test/fixtures/service-fixture.mjs')));
  const input = { id: 'fixture', version: 'v1', module };
  t.after(async () => {
    const failures = [];
    for (const version of ['v1', 'v2']) {
      try { await until(async () => !(await first.status('fixture', version)).pendingWork); await first.stop('fixture', version); }
      catch (error) { failures.push(error); }
    }
    if (!failures.length) await rm(dataRoot, { recursive: true, force: true });
    else throw new AggregateError(failures, `Service fixture retained because shutdown failed: ${dataRoot}`);
  });
  const [a, same] = await Promise.all([first.start(input), second.start(input)]);
  assert.equal(a.pid, same.pid); assert.notEqual(a.pid, process.pid);
  assert.equal([a.reused, same.reused].filter(Boolean).length, 1);
  const b = await second.start({ ...input, version: 'v2' });
  assert.notEqual(a.pid, b.pid);
  const response = await second.request('fixture', 'v2', '/tools/echo', { body: { arguments: { text: 'new version' }, context: { actor: 'bot-two' } } });
  assert.equal(response.version, 'v2'); assert.equal(response.actor, 'bot-two');
  await assert.rejects(second.request('fixture', 'v2', 'https://example.invalid/', { body: {} }), { code: 'INVALID_SERVICE_PATH' });
  await assert.rejects(second.start({ ...input, stateVersion: '2' }), { code: 'SERVICE_VERSION_IMMUTABLE' });
  await appendFile(module, '\n// Another entry revision requires a new version.\n');
  await assert.rejects(second.start(input), { code: 'SERVICE_VERSION_IMMUTABLE' });
  const duplicate = spawn(process.execPath, [join(releaseRoot, 'capabilities/services/cli.mjs'), '--config', first.paths('fixture', 'v1').config], { windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise((done, reject) => { duplicate.once('error', reject); duplicate.once('exit', done); }), 1);
  assert.equal((await first.status('fixture', 'v1')).bootId, a.bootId);
  assert.equal(JSON.parse(await readFile(first.paths('fixture', 'v1').current, 'utf8')).bootId, a.bootId);
  await second.request('fixture', 'v1', '/tools/background', { body: { arguments: { ms: 300 } } });
  await assert.rejects(first.stop('fixture', 'v1'), { code: 'CAPABILITY_BUSY' });
  assert.equal((await first.status('fixture', 'v1')).state, 'ready');
  await until(async () => (await first.status('fixture', 'v1')).pendingWork === 0);
  await first.stop('fixture', 'v1');
  assert.equal((await first.status('fixture', 'v1')).state, 'stopped');
  const record = JSON.parse(await readFile(join(dataRoot, 'capabilities/service-runtime/fixture/v1/run/current.json'), 'utf8'));
  assert.equal(record.state, 'stopped'); assert.equal(record.token, undefined);
});
