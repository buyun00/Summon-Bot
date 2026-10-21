import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { RecordStore } from '../shared/store.mjs';
import { WorkspaceExecutionLock } from '../shared/workspace-lock.mjs';
import { CapabilityRegistry } from '../services/registry.mjs';
import { CapabilityControl, controlTools } from '../services/control.mjs';
import { BotManager } from '../bot-management/service.mjs';
import * as botApi from '../../bot/src/index.mjs';

const directories = [];
after(async () => { for (const dir of directories) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } });
const tool = version => ({ name: 'example_read', description: `Version ${version}`, effect: 'read', inputSchema: { type: 'object' } });
const missing = () => Object.assign(new Error('Not found'), { status: 404 });
const transient = () => Object.assign(new Error('Connection interrupted'), { status: 503, code: 'CONNECTION_RESET' });
const custom = name => ({ type: 'http', name, description: name, effect: 'read', inputSchema: { type: 'object' }, url: `http://127.0.0.1:1/${name}`, headers: { Authorization: 'private-custom-secret' } });
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-capability-control-')); directories.push(dir);
  const directory = join(dir, 'bots', 'bot-one'); await mkdir(directory, { recursive: true });
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({ botId: 'bot-one', dataDir: directory, prompt: 'original', tools: [custom('custom_read')], bundledToolNames: [] }));
  const store = new RecordStore(':memory:'), bots = new RecordStore(':memory:');
  const registry = new CapabilityRegistry({ store, reservedTools: controlTools.map(value => value.name), fetch: async url => {
    const version = new URL(url).pathname.split('/')[1];
    return new Response(JSON.stringify({ id: 'example', version, stateVersion: '1', tools: [tool(version)] }), { headers: { 'content-type': 'application/json' } });
  } });
  for (const version of ['1', '2', '3']) await registry.register({ id: 'example', version, endpoint: `http://127.0.0.1/${version}` });
  registry.activate('example', '1');
  bots.save('bots', { id: 'bot-one', allowedTools: ['example_read'], capabilityToken: 'private-capability-token' });
  registry.registerActor('bot-one', ['example_read']);
  let clock = 10000;
  const manager = { dataRoot: dir, store: bots, online: true, states: new Map(), requests: [], prepareReady: false,
    list: () => bots.list('bots'), get: id => bots.get('bots', id), directory: () => directory,
    config: async () => JSON.parse(await readFile(configPath, 'utf8')), botApi: async () => botApi,
    async identity() { return this.online ? { state: 'ready' } : null; },
    async request(id, path, options = {}) {
      this.requests.push({ path, body: options.body });
      if (this.unavailable) throw transient();
      const parts = path.split('/').filter(Boolean), key = decodeURIComponent(parts[1]);
      if (key === 'prepare') {
        const body = JSON.parse(options.body), prior = this.states.get(body.id);
        if (prior) { assert.deepEqual(prior.body, body, 'Idempotent prepare must use the original immutable payload'); return prior; }
        const state = { id: body.id, status: this.rejectPrepare ? 'failed' : this.prepareReady ? 'ready' : 'preparing', body,
          ...(this.rejectPrepare ? { error: { code: 'INVALID_CANDIDATE', message: 'Invalid staged client' } } : {}) };
        this.states.set(body.id, state); return state;
      }
      const state = this.states.get(key); if (!state) throw missing();
      if (parts[2] === 'commit') {
        if (this.dropCommit) { this.dropCommit = false; throw transient(); }
        assert.equal(state.status, 'ready'); state.status = 'committed';
        await writeFile(configPath, JSON.stringify({ ...await this.config(id), tools: state.body.tools, bundledToolNames: state.body.bundledToolNames, capabilityBindingRevision: state.body.bindingRevision, capabilityUpdateId: key }));
      }
      if (parts[2] === 'abort') { state.status = 'failed'; state.error = { code: 'CAPABILITY_UPDATE_ABORTED' }; }
      return state;
    },
  };
  const stopped = [], supervisor = {
    async descriptor(id, version) { return { id, version, state: stopped.some(value => value.id === id && value.version === version) ? 'stopped' : 'ready' }; },
    async status(id, version) { return { ...await this.descriptor(id, version), pendingWork: 0, activeRequests: 0 }; },
    async stop(id, version) { stopped.push({ id, version }); return { stopped: true }; },
  };
  const control = new CapabilityControl({ registry, supervisor, manager, store, gatewayUrl: () => 'http://127.0.0.1:8788', retryBaseMs: 100, maxRetries: 3, clock: () => clock, ...options });
  t.after(async () => { await control.close(); bots.close(); store.close(); });
  return { dir, directory, configPath, registry, manager, store, control, stopped, supervisor, advanceClock: (ms = 1000) => clock += ms,
    transition: () => store.get('switches', 'bot-one'), ready: () => { manager.states.get(store.get('switches', 'bot-one').updateId).status = 'ready'; } };
}

test('coordinator freezes the tool payload and keeps every tool URL pinned until Bot acknowledgement', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); await f.control.tick();
  const update = f.transition(), payload = f.manager.states.get(update.updateId).body;
  assert.match(payload.tools.find(value => value.name === 'example_read').url, /\/capabilities\/example\/versions\/2\/tools\/example_read$/);
  const config = await f.manager.config(); await writeFile(f.configPath, JSON.stringify({ ...config, tools: [custom('later_custom')] }));
  await f.control.tick(); assert.equal(f.transition().updateId, update.updateId);
  f.ready(); await f.control.tick();
  assert.equal(f.transition().phase, 'complete');
  assert.deepEqual((await f.manager.config()).tools.map(value => value.name), ['example_read', 'custom_read']);
  assert.doesNotMatch(JSON.stringify(f.control.inventory()), /private-(?:capability-token|custom-secret)/);
});

test('registry commit before a lost Bot commit acknowledgement retains v1 and recovers a restarted Bot', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); await f.control.tick(); f.ready();
  f.manager.dropCommit = true; await f.control.tick();
  const interrupted = f.transition();
  assert.equal(interrupted.phase, 'committing'); assert.equal(interrupted.registryCommitted, true);
  assert.equal(f.registry.bindingsFor('bot-one').example, '2');
  assert.equal(f.control.permittedVersion('bot-one', 'example', '1'), true);
  await assert.rejects(f.control.retire('example', '1'), /acknowledgement/);
  const state = f.manager.states.get(interrupted.updateId); state.status = 'failed'; state.error = { code: 'CAPABILITY_UPDATE_INTERRUPTED' };
  f.advanceClock(); await f.control.tick(); const retry = f.transition();
  assert.notEqual(retry.updateId, interrupted.updateId); assert.equal(retry.registryCommitted, true);
  assert.deepEqual(retry.previousBindings, { example: '1' });
  f.manager.prepareReady = true; f.advanceClock(); await f.control.tick();
  assert.equal(f.transition().phase, 'complete');
  assert.equal(f.control.permittedVersion('bot-one', 'example', '1'), false);
  assert.deepEqual(await f.control.retire('example', '1'), { stopped: true });
});

test('permanent preparation failure stops retries until an explicit retry or a different proposal', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); f.manager.rejectPrepare = true;
  await f.control.tick(); const failed = f.transition(), count = f.manager.requests.length;
  assert.equal(failed.phase, 'failed');
  for (let i = 0; i < 12; i++) { f.advanceClock(); await f.control.tick(); }
  assert.equal(f.manager.requests.length, count); assert.equal(f.transition().updateId, failed.updateId);
  f.manager.rejectPrepare = false; f.manager.prepareReady = true;
  await f.control.call('capabilities_retry', { botId: 'bot-one' }); await f.control.tick();
  assert.equal(f.transition().phase, 'complete'); assert.notEqual(f.transition().updateId, failed.updateId);
});

test('recovery recognizes a registry commit that preceded its durable coordinator phase update', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); await f.control.tick(); f.ready();
  const transition = f.transition(); f.registry.commit('bot-one', transition.proposalId);
  assert.equal(f.transition().registryCommitted, false); assert.equal(f.registry.propose('bot-one'), null);
  await f.control.tick();
  assert.equal(f.transition().phase, 'complete');
  assert.equal(f.manager.requests.some(request => request.path.endsWith('/abort')), false);
});

test('transport failures back off and become explicitly blocked without repeated requests', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); f.manager.unavailable = true;
  await f.control.tick(); const count = f.manager.requests.length;
  await f.control.tick(); assert.equal(f.manager.requests.length, count);
  f.advanceClock(); await f.control.tick(); f.advanceClock(); await f.control.tick();
  assert.equal(f.transition().phase, 'blocked'); const blockedCount = f.manager.requests.length, id = f.transition().updateId;
  for (let i = 0; i < 5; i++) { f.advanceClock(); await f.control.tick(); }
  assert.equal(f.manager.requests.length, blockedCount);
  f.manager.unavailable = false; f.manager.prepareReady = true;
  await f.control.retry('bot-one'); await f.control.tick();
  assert.equal(f.transition().phase, 'complete'); assert.equal(f.transition().updateId, id);
});

test('a changed admin grant supersedes the prepared catalog and replaces its update ID', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); await f.control.tick();
  const old = f.transition(); assert.equal(f.manager.states.get(old.updateId).body.tools.some(value => value.name === 'capabilities_retry'), false);
  await f.control.grant('bot-one', ['example_read', 'capabilities_retry']); await f.control.tick();
  const current = f.transition(); assert.notEqual(current.updateId, old.updateId);
  assert.equal(f.manager.states.get(old.updateId).status, 'failed');
  assert.equal(f.manager.states.get(current.updateId).body.tools.some(value => value.name === 'capabilities_retry'), true);
  assert.equal(f.control.tools(f.manager.get('bot-one')).some(value => value.name === 'capabilities_retry'), false);
  f.ready(); await f.control.tick();
  assert.equal(f.control.tools(f.manager.get('bot-one')).some(value => value.name === 'capabilities_retry'), true);
});

test('rollback aborts a stale ready update and does not keep an unnecessary switch pending', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); await f.control.tick(); f.ready();
  const id = f.transition().updateId; f.registry.activate('example', '1'); await f.control.tick();
  assert.equal(f.manager.states.get(id).status, 'failed'); assert.equal(f.transition().phase, 'complete');
  assert.equal(f.registry.bindingsFor('bot-one').example, '1');
});

test('offline switching serializes with the management worker and rechecks a concurrent Bot start', async t => {
  const f = await fixture(t); f.manager.online = false; f.registry.activate('example', '2');
  const root = join(f.dir, 'capabilities', 'bot-management'); await mkdir(root, { recursive: true });
  const worker = new WorkspaceExecutionLock(root), release = await worker.acquire('worker-start');
  const switched = f.control.tick();
  await new Promise(resolve => setTimeout(resolve, 50));
  f.manager.online = true; await writeFile(f.configPath, JSON.stringify({ ...await f.manager.config(), prompt: 'worker startup completed' }));
  release(); await switched;
  assert.equal(f.registry.bindingsFor('bot-one').example, '1');
  assert.equal((await f.manager.config()).prompt, 'worker startup completed');
  assert.equal(f.manager.requests.length, 0);
  await f.control.tick(); f.ready(); await f.control.tick(); assert.equal(f.transition().phase, 'complete');
});

test('a stopped Bot receives a durable version-pinned config under its data lease', async t => {
  const f = await fixture(t); f.manager.online = false; f.registry.activate('example', '2'); await f.control.tick();
  assert.equal(f.transition().phase, 'complete');
  const saved = await f.manager.config();
  assert.equal(saved.capabilityUpdateId, f.transition().updateId); assert.equal(saved.capabilityBindingRevision, '1');
  assert.match(saved.tools[0].url, /\/versions\/2\//); assert.equal(saved.tools[1].name, 'custom_read');
  assert.equal(await botApi.inspectBotIdentity(f.directory), null);
});

test('an offline custom-tool collision fails preparation without committing bindings or replacing config', async t => {
  const f = await fixture(t); f.manager.online = false;
  f.registry.fetch = async () => new Response(JSON.stringify({ id: 'custom-capability', version: '1', stateVersion: '1', tools: [{ ...tool('1'), name: 'custom_read' }] }));
  await f.registry.register({ id: 'custom-capability', version: '1', endpoint: 'http://127.0.0.1/new' });
  f.registry.activate('custom-capability', '1');
  f.manager.store.save('bots', { id: 'bot-one', allowedTools: ['example_read', 'custom_read'] });
  const before = await readFile(f.configPath, 'utf8'); await f.control.tick();
  assert.equal(f.transition().phase, 'failed'); assert.match(f.transition().error.message, /collision/);
  assert.equal(await readFile(f.configPath, 'utf8'), before);
  assert.deepEqual(f.registry.bindingsFor('bot-one'), { example: '1' });
  assert.equal(await botApi.inspectBotIdentity(f.directory), null);
});

test('deployment control delegates the concrete package request to the configured publisher', async t => {
  const deployed = [], f = await fixture(t, { deploy: async args => { deployed.push(args); return { published: args.version }; } });
  const request = { id: 'example', version: '4', packageRoot: 'C:/trusted/example' };
  assert.deepEqual(await f.control.call('capabilities_deploy', request), { published: '4' }); assert.deepEqual(deployed, [request]);
  assert.ok(controlTools.find(value => value.name === 'capabilities_retry').inputSchema.required.includes('botId'));
});

test('unknown request reconciliation requires evidence and records the authenticated actor atomically', async t => {
  const f = await fixture(t);
  f.store.save('capability-requests', { id: 'unknown-effect', capabilityId: 'example', version: '1', status: 'unknown', actor: 'bot-one', tool: 'example_read' });
  await assert.rejects(f.control.call('capabilities_reconcile', { requestId: 'unknown-effect', outcome: 'completed', evidence: '   ' }), /evidence/);
  assert.equal(f.store.get('capability-requests', 'unknown-effect').status, 'unknown');
  const args = { requestId: 'unknown-effect', outcome: 'failed', evidence: 'Service receipt 45 confirms the request was rejected before execution.' };
  const result = await f.control.call('capabilities_reconcile', args, { actor: 'bot-manager' });
  assert.equal(result.actor, 'bot-manager'); assert.equal(result.outcome, 'failed');
  assert.equal(f.store.get('capability-requests', 'unknown-effect').status, 'failed');
  assert.deepEqual(await f.control.call('capabilities_reconcile', args, { actor: 'controller' }), result);
  await assert.rejects(f.control.call('capabilities_reconcile', { ...args, outcome: 'completed' }), { status: 409 });
});

test('activation waits for retirement and cannot publish a managed version that just stopped', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); f.manager.prepareReady = true; await f.control.tick();
  let entered, release;
  const observed = new Promise(resolve => entered = resolve), held = new Promise(resolve => release = resolve);
  const original = f.supervisor.status.bind(f.supervisor);
  f.supervisor.status = async (id, version) => { if (version === '1' && !f.stopped.length) { entered(); await held; } return original(id, version); };
  const retiring = f.control.retire('example', '1'); await observed;
  const activation = f.control.activate('example', '1');
  const rejected = assert.rejects(activation, /not running/);
  release(); await retiring; await rejected;
  assert.equal(f.registry.active('example').version, '2'); assert.equal((await f.supervisor.status('example', '1')).state, 'stopped');
});

test('unmanaged retirement reports only routing retirement and never claims a remote service stopped', async t => {
  const f = await fixture(t); f.registry.activate('example', '2'); f.manager.prepareReady = true; await f.control.tick();
  f.supervisor.descriptor = async () => null;
  assert.deepEqual(await f.control.retire('example', '1'), { id: 'example', version: '1', externallyManaged: true, routingRetired: true, serviceStopped: false });
  assert.equal(f.stopped.length, 0);
  await f.control.activate('example', '1'); await f.control.tick();
  assert.equal(f.registry.active('example').version, '1');
});

test('real Bot HTTP config writes preserve both concurrent manager prompts and capability commits', async t => {
  const f = await fixture(t);
  const manager = new BotManager({ dataRoot: f.dir, releaseRoot: resolve(import.meta.dirname, '../..'), store: f.manager.store, defaultCwd: f.dir });
  const input = { ...await f.manager.config(), token: 'actual-concurrent-config-management-token',
    model: { provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-key' } };
  const bot = await botApi.startBot(input); t.after(() => bot.close());
  const contact = { botId: bot.config.botId, url: bot.url, token: bot.config.token };
  const request = (path, body, method = 'POST') => botApi.requestBot(contact, path, { method, body });
  for (let index = 1; index <= 6; index++) {
    const id = `concurrent-${index}`, tools = [custom('custom_read'), custom(`new_tool_${index}`)];
    await request('/capability-updates/prepare', { id, bindingRevision: String(index), tools, bundledToolNames: [`new_tool_${index}`] });
    for (;;) { if ((await request(`/capability-updates/${id}`, undefined, 'GET')).status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    const prompt = `Concurrent prompt ${index}`;
    const update = manager.update('bot-one', { prompt });
    manager.store.save('bots', { id: 'bot-one', allowedTools: [`retained-grant-${index}`] });
    await Promise.all([update, request(`/capability-updates/${id}/commit`)]);
    const current = await manager.config('bot-one');
    assert.equal(current.prompt, prompt); assert.equal(current.capabilityBindingRevision, String(index));
    assert.equal(current.capabilityUpdateId, id); assert.deepEqual(current.tools, tools);
    assert.deepEqual(manager.get('bot-one').allowedTools, [`retained-grant-${index}`]);
  }
  await bot.close(); await manager.update('bot-one', { prompt: 'Offline prompt retained' });
  assert.equal((await manager.config('bot-one')).capabilityBindingRevision, '6');
  assert.equal((await manager.config('bot-one')).prompt, 'Offline prompt retained');
});
