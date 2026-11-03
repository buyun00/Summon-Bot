import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RecordStore } from '../shared/store.mjs';
import { CapabilityRegistry } from '../services/registry.mjs';

const tool = (name = 'example_read', description = 'Read example', effect = 'read') => ({ name, description, inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, effect });
async function service(t, { id = 'example', version = '1', tools = [tool()], stateVersion = '1', handler } = {}) {
  const token = `secret-${id}-${version}`, calls = [];
  const manifest = { id, version, tools, stateVersion };
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' })); return; }
    if (request.url === '/manifest') { response.end(JSON.stringify(manifest)); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url, ...body });
    try {
      const result = handler ? await handler(body, response) : { version, arguments: body.arguments, context: body.context };
      if (!response.writableEnded) response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { id, version, endpoint: `http://127.0.0.1:${server.address().port}`, token, calls, manifest, server };
}
function fixture(t, options = {}) {
  const store = new RecordStore(':memory:');
  t.after(() => store.close());
  return { store, registry: new CapabilityRegistry({ store, ...options }) };
}
const register = (registry, service) => registry.register({ id: service.id, version: service.version, endpoint: service.endpoint, token: service.token });

test('real service versions keep old Bots pinned and route new Bots/controller to the published version', async t => {
  const v1 = await service(t), v2 = await service(t, { version: '2', tools: [tool('example_read', 'New schema'), tool('example_extra')] });
  const { registry } = fixture(t);
  await register(registry, v1); registry.activate('example', '1');
  registry.registerActor('old-bot', ['example_read', 'example_extra']);
  await register(registry, v2); registry.activate('example', '2');
  assert.equal((await registry.call('old-bot', 'example_read', { value: 'old' })).version, '1');
  assert.equal((await registry.call('new-bot', 'example_read', {})).version, '2');
  assert.equal((await registry.call('controller', 'example_read', {})).version, '2');
  assert.deepEqual(registry.toolsFor('old-bot').map(item => item.name), ['example_read']);
  const proposal = registry.propose('old-bot');
  assert.equal(registry.propose('old-bot').id, proposal.id);
  assert.deepEqual(proposal.tools.map(item => item.name), ['example_read', 'example_extra']);
  const committed = registry.commit('old-bot', proposal.id);
  assert.equal(committed.revision, 1);
  assert.deepEqual(registry.commit('old-bot', proposal.id), committed);
  assert.equal((await registry.call('old-bot', 'example_read', {}, { context: { actor: 'forged', workspace: 'workspace' } })).version, '2');
  assert.equal(v2.calls.at(-1).context.actor, 'old-bot');
  assert.equal(v2.calls.at(-1).context.workspace, 'workspace');
  assert.ok(v2.calls.at(-1).context.requestId);
  assert.equal(registry.inventory().versions.find(item => item.version === '1').retirementReady, true);
});

test('unload removes new routes but retains old bindings and an in-flight request until both drain', async t => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; }), continuation = new Promise(resolve => { finish = resolve; });
  const v1 = await service(t, { handler: async () => { entered(); await continuation; return { completed: true }; } });
  const { registry } = fixture(t);
  await register(registry, v1); registry.activate('example', '1'); registry.registerActor('old-bot', ['example_read']);
  const request = registry.call('old-bot', 'example_read', {});
  await started;
  registry.unload('example');
  await assert.rejects(registry.call('new-bot', 'example_read', {}), { code: 'CAPABILITY_TOOL_NOT_BOUND' });
  await assert.rejects(registry.call('controller', 'example_read', {}), { code: 'CAPABILITY_TOOL_NOT_BOUND' });
  const pending = registry.propose('old-bot');
  assert.deepEqual(pending.bindings, {}); registry.commit('old-bot', pending.id);
  let version = registry.inventory().versions[0];
  assert.equal(version.bindingCount, 0); assert.equal(version.inFlight, 1); assert.equal(version.retirementReady, false);
  finish(); assert.deepEqual(await request, { completed: true });
  version = registry.inventory().versions[0];
  assert.equal(version.inFlight, 0); assert.equal(version.retirementReady, true);
  assert.deepEqual(registry.toolsFor('old-bot'), []);
});

test('registration validates manifest, immutable versions, collisions, state compatibility and hides credentials', async t => {
  const events = [], { registry } = fixture(t, { reservedTools: ['messages_send'], emit: (...args) => events.push(args) });
  const v1 = await service(t); await register(registry, v1);
  await register(registry, v1); registry.activate(v1.id, v1.version);
  const replacement = await service(t); await assert.rejects(register(registry, replacement), { code: 'CAPABILITY_VERSION_IMMUTABLE' });
  const collision = await service(t, { id: 'another' }); await assert.rejects(register(registry, collision), { code: 'CAPABILITY_TOOL_COLLISION' });
  const reserved = await service(t, { id: 'reserved', tools: [tool('messages_send')] }); await assert.rejects(register(registry, reserved), { code: 'CAPABILITY_TOOL_COLLISION' });
  const wrongIdentity = await service(t, { version: '2' });
  await assert.rejects(registry.register({ ...wrongIdentity, version: '3' }), { code: 'CAPABILITY_MANIFEST_MISMATCH' });
  await assert.rejects(registry.register({ ...v1, tools: [tool('wrong_name')] }), { code: 'CAPABILITY_MANIFEST_MISMATCH' });
  const incompatible = await service(t, { version: '3', stateVersion: '2' }); await register(registry, incompatible);
  assert.throws(() => registry.activate('example', '3'), { code: 'CAPABILITY_STATE_MIGRATION_REQUIRED' });
  for (const endpoint of ['http://example.com', 'http://user:pass@localhost', 'http://localhost/?secret=x', 'http://localhost/#fragment', 'file:///tmp/service']) await assert.rejects(registry.register({ id: 'bad', version: '1', endpoint }), { code: 'CAPABILITY_INVALID' });
  const publicData = JSON.stringify({ inventory: registry.inventory(), active: registry.active('example'), version: registry.getVersion('example', '1'), events });
  assert.ok(!publicData.includes(v1.token)); assert.ok(!publicData.includes('"token"'));
  assert.equal(registry.getVersion('example', '1', { private: true }).token, v1.token);
});

test('stale proposals cannot commit after newer activation or authorization changes', async t => {
  const { registry } = fixture(t), v1 = await service(t), v2 = await service(t, { version: '2' }), v3 = await service(t, { version: '3' });
  for (const version of [v1, v2, v3]) await register(registry, version);
  registry.activate('example', '1'); registry.registerActor('bot', ['example_read']); registry.activate('example', '2');
  const older = registry.propose('bot'); registry.activate('example', '3');
  assert.throws(() => registry.commit('bot', older.id), { code: 'CAPABILITY_PROPOSAL_STALE' });
  const latest = registry.propose('bot'); registry.toolsFor('bot', []);
  assert.throws(() => registry.commit('bot', latest.id), { code: 'CAPABILITY_PROPOSAL_STALE' });
  await assert.rejects(registry.call('bot', 'example_read', {}), { code: 'CAPABILITY_FORBIDDEN' });
  const removal = registry.propose('bot'); assert.deepEqual(removal.tools, []); registry.commit('bot', removal.id);
  assert.deepEqual(registry.bindingsFor('bot'), {});
  assert.throws(() => registry.commit('different-bot', removal.id), { code: 'CAPABILITY_PROPOSAL_NOT_FOUND' });
});

test('SQLite restart retains versions, bindings and pending proposals', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'summon-capability-registry-'));
  const path = join(directory, 'state.sqlite'), v1 = await service(t), v2 = await service(t, { version: '2' });
  let store = new RecordStore(path), registry = new CapabilityRegistry({ store });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  await register(registry, v1); registry.activate('example', '1'); registry.registerActor('old', ['example_read']);
  await register(registry, v2); registry.activate('example', '2'); const proposal = registry.propose('old');
  store.close(); store = new RecordStore(path); registry = new CapabilityRegistry({ store });
  assert.equal(registry.active('example').version, '2'); assert.equal(registry.propose('old').id, proposal.id);
  assert.equal((await registry.call('old', 'example_read', {})).version, '1'); registry.commit('old', proposal.id);
  assert.equal((await registry.call('old', 'example_read', {})).version, '2');
});

test('transport failure is never retried and blocks retirement until explicitly reconciled, including after restart', async t => {
  const { store } = fixture(t), v1 = await service(t, { handler: async (_body, response) => { response.destroy(); } });
  let registry = new CapabilityRegistry({ store });
  await register(registry, v1); registry.activate('example', '1');
  let unknown;
  await assert.rejects(registry.call('controller', 'example_read', {}), error => { unknown = error; return error.code === 'CAPABILITY_OUTCOME_UNKNOWN'; });
  assert.equal(v1.calls.length, 1); registry.unload('example');
  assert.equal(registry.inventory().versions[0].retirementReady, false);
  registry = new CapabilityRegistry({ store });
  assert.equal(registry.inventory().versions[0].unknownRequests[0].id, unknown.requestId);
  registry.resolveRequest(unknown.requestId, { outcome: 'failed' });
  assert.equal(registry.inventory().versions[0].retirementReady, true);
  assert.throws(() => registry.resolveRequest(unknown.requestId, { outcome: 'failed' }), { code: 'CAPABILITY_REQUEST_NOT_UNKNOWN' });
});

test('retained version routing supports long-job control after an actor switches and normal failures drain safely', async t => {
  const { registry } = fixture(t), v1 = await service(t, { handler: async () => { throw new Error('secret-example-1 detail'); } }), v2 = await service(t, { version: '2' });
  await register(registry, v1); registry.activate('example', '1'); registry.registerActor('bot');
  await register(registry, v2); registry.activate('example', '2'); registry.commit('bot', registry.propose('bot').id);
  await assert.rejects(registry.callVersion('example', '1', 'example_read', {}, { context: { actor: 'bot' } }), error => error.status === 500 && error.outcome === 'failed' && error.message.includes('[redacted]') && !error.message.includes(v1.token));
  assert.equal(v1.calls.length, 1); assert.equal(registry.inventory().versions.find(item => item.version === '1').retirementReady, true);
  await assert.rejects(registry.callVersion('example', '1', 'missing', {}), { code: 'CAPABILITY_TOOL_NOT_FOUND' });
});

test('a supervised restart relocates a version only when its entire manifest is unchanged', async t => {
  const { registry } = fixture(t), original = await service(t), restarted = await service(t);
  await register(registry, original); registry.activate('example', '1'); registry.registerActor('bot', ['example_read']);
  await registry.relocate('example', '1', { endpoint: restarted.endpoint, token: restarted.token });
  assert.equal(registry.active('example').endpoint, restarted.endpoint);
  await registry.call('bot', 'example_read', {}); assert.equal(original.calls.length, 0); assert.equal(restarted.calls.length, 1);
  const changed = await service(t, { tools: [tool('example_read', 'Different description')] });
  await assert.rejects(registry.relocate('example', '1', { endpoint: changed.endpoint, token: changed.token }), { code: 'CAPABILITY_MANIFEST_MISMATCH' });
  assert.equal(registry.active('example').endpoint, restarted.endpoint);
});

test('grant changes prepare a new catalog even on the same version and revoked grants stop calls immediately', async t => {
  const { registry } = fixture(t), v1 = await service(t, { tools: [tool(), tool('example_extra')] });
  await register(registry, v1); registry.activate('example', '1'); registry.registerActor('bot', ['example_read']);
  assert.deepEqual(registry.toolsFor('bot', ['example_read', 'example_extra']).map(item => item.name), ['example_read']);
  const addition = registry.propose('bot'); assert.deepEqual(addition.bindings, { example: '1' });
  assert.deepEqual(addition.tools.map(item => item.name), ['example_read', 'example_extra']); registry.commit('bot', addition.id);
  assert.deepEqual(registry.toolsFor('bot', ['example_read']).map(item => item.name), ['example_read', 'example_extra']);
  await assert.rejects(registry.call('bot', 'example_extra', {}), { code: 'CAPABILITY_FORBIDDEN' });
  const removal = registry.propose('bot'); registry.commit('bot', removal.id);
  assert.deepEqual(registry.toolsFor('bot').map(item => item.name), ['example_read']);
});

test('internal API requests participate in the same drain and unknown-outcome ledger', async t => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; }), continuation = new Promise(resolve => { finish = resolve; });
  const v1 = await service(t, { handler: async () => { entered(); await continuation; return ['ok']; } });
  const { registry } = fixture(t); await register(registry, v1); registry.activate('example', '1');
  const request = registry.invokeVersion('example', '1', 'list', ['argument'], { context: { actor: 'controller' } }); await started;
  registry.unload('example'); assert.equal(registry.inventory().versions[0].retirementReady, false);
  assert.equal(v1.calls[0].path, '/rpc/list'); assert.deepEqual(v1.calls[0].arguments, ['argument']);
  finish(); assert.deepEqual(await request, ['ok']); assert.equal(registry.inventory().versions[0].retirementReady, true);
});

test('a real gateway process death preserves unresolved requests instead of declaring a version drained', async t => {
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; }), continuation = new Promise(resolve => { finish = resolve; });
  const v1 = await service(t, { handler: async () => { entered(); await continuation; return { done: true }; } });
  const directory = await mkdtemp(join(tmpdir(), 'summon-capability-crash-')), path = join(directory, 'state.sqlite');
  let store = new RecordStore(path), registry = new CapabilityRegistry({ store });
  await register(registry, v1); registry.activate('example', '1'); store.close(); store = null;
  const code = `import { RecordStore } from ${JSON.stringify(new URL('../shared/store.mjs', import.meta.url).href)}; import { CapabilityRegistry } from ${JSON.stringify(new URL('../services/registry.mjs', import.meta.url).href)}; const store = new RecordStore(process.argv[1]); await new CapabilityRegistry({store}).call('controller','example_read',{});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, path], { stdio: 'ignore', windowsHide: true });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } finish(); store?.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.race([started, once(child, 'exit').then(() => { throw new Error('Gateway child exited before its request reached the service'); })]);
  const exited = once(child, 'exit'); child.kill(); await exited;
  store = new RecordStore(path); registry = new CapabilityRegistry({ store }); registry.unload('example');
  const version = registry.inventory().versions[0];
  assert.equal(version.retirementReady, false); assert.equal(version.unknownRequests.length, 1);
  assert.equal(version.unknownRequests[0].reason, 'gateway-restarted'); assert.equal(v1.calls.length, 1);
  finish();
});

test('terminal request history is bounded while unresolved outcomes are retained', async t => {
  const { store, registry } = fixture(t, { requestHistoryLimit: 2 }), v1 = await service(t);
  await register(registry, v1); registry.activate('example', '1');
  for (let index = 0; index < 5; index++) await registry.call('controller', 'example_read', {});
  assert.equal(store.list('capability-requests').length, 2);
  registry.unload('example'); assert.equal(registry.inventory().versions[0].retirementReady, true);
});
