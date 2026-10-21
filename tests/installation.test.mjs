import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { initializeDeployment,startSystem,stopSystem,stopService,launchService,inspectService,deploymentPath } from '../scripts/installation/system.mjs';
import { acquireServiceLock,inspectServiceLock } from '../scripts/installation/service-lock.mjs';
import { readJson } from '../scripts/build/files.mjs';

// A real child owns the same OS identity protocol as a service. Its identity
// listener can become temporarily busy without fabricating a stopped result.
async function startupFixture(t, mode) {
  const root = await mkdtemp(join(tmpdir(), 'relay-startup-handshake-'));
  const dataRoot = join(root, 'data'), releaseRoot = join(root, 'release');
  await mkdir(join(releaseRoot, 'scripts', 'installation'), { recursive: true });
  const { config } = await initializeDeployment({ dataRoot, releaseRoot, port: 0 });
  await writeFile(join(releaseRoot, 'scripts', 'installation', 'service.mjs'), `
    import net from 'node:net';
    import http from 'node:http';
    import { createHash, randomUUID } from 'node:crypto';
    import { readFile, realpath, writeFile } from 'node:fs/promises';
    import { appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--config') + 1], 'utf8'));
    const mode = ${JSON.stringify(mode)}, sockets = new Set(); let requests = 0;
    appendFileSync(join(config.dataRoot, 'spawn-count.txt'), process.pid + '\\n');
    const root = await realpath(config.dataRoot), key = createHash('sha256').update((process.platform === 'win32' ? root.toLowerCase() : root) + ':gateway').digest('hex').slice(0, 40);
    const endpoint = process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\relay-service-' + key : process.platform === 'linux' ? '\\0relay-service-' + key : {host:'127.0.0.1',port:30000+parseInt(key.slice(0,8),16)%25000};
    const record = {protocol:'relay-service-v1',type:'gateway',pid:process.pid,bootId:randomUUID(),state:'ready',releaseRoot:config.releaseRoot};
    const control = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/shutdown') {
        response.end('{}');
        setImmediate(() => { identity.close(); for (const socket of sockets) socket.destroy(); control.close(); control.closeAllConnections(); });
      } else response.end(JSON.stringify({...record, ...(mode === 'mismatch' ? {bootId:'another-boot'} : {})}));
    });
    await new Promise(done => control.listen(0, '127.0.0.1', done));
    record.controlUrl = record.url = 'http://127.0.0.1:' + control.address().port;
    await writeFile(join(config.dataRoot, 'fixture-control.json'), JSON.stringify(record));
    const identity = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      appendFileSync(join(config.dataRoot, 'requests.txt'), ++requests + '\\n');
      if (mode === 'silent') return;
      if (mode === 'exit') return setTimeout(() => process.exit(7), 25);
      if (mode === 'invalid') return socket.end(JSON.stringify({...record,protocol:'invalid'}) + '\\n');
      if (mode === 'partial' && requests <= 3) return socket.end();
      if (mode === 'busy' && requests === 1) { const until=Date.now()+2600; while(Date.now()<until) {} }
      socket.end(JSON.stringify(record) + '\\n');
    });
    await new Promise(done => identity.listen(endpoint, done));
    process.send?.({type:'ready'});
  `);
  t.after(async () => {
    try {
      const owner = await readJson(join(dataRoot, 'fixture-control.json'));
      await fetch(owner.controlUrl + '/shutdown', {method:'POST',signal:AbortSignal.timeout(5000)}).catch(error => { if (mode !== 'exit') throw error; });
      const deadline = Date.now() + 5000;
      while (await inspectServiceLock(dataRoot, 'gateway')) {
        assert.ok(Date.now() < deadline, 'fixture must release its real identity');
        await new Promise(done => setTimeout(done, 20));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(root, {recursive:true,force:true,maxRetries:5,retryDelay:50});
  });
  return { config, count: async file => (await readFile(join(dataRoot, file), 'utf8')).trim().split('\n').length };
}

test('service OS lock excludes a second owner and vanishes on close',async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-service-lock-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const lock=await acquireServiceLock(root,'gateway',()=>({pid:process.pid,bootId:'test',state:'starting'}));
  try{assert.equal((await inspectServiceLock(root,'gateway')).bootId,'test');await assert.rejects(acquireServiceLock(root,'gateway',()=>({})));}finally{await lock.close();}
  assert.equal(await inspectServiceLock(root,'gateway'),null);
});
test('installed service chain runs in other cwd, persists gateway address, and Web stop leaves gateway alive', {timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-service-chain-'));let config;
  t.after(async()=>{if(config)await stopSystem(config);await rm(root,{recursive:true,force:true});});
  ({config}=await initializeDeployment({dataRoot:root,releaseRoot:resolve('.'),port:0}));
  const foregroundConfig = config;
  const first=await startSystem(config);assert.equal(first.state,'ready');assert.notEqual(first.gateway.pid,first.web.pid);
  const state=await (await fetch(first.web.url+'/api/state')).json();assert.ok(state.bots.some(bot=>bot.roleId==='entry'));assert.ok(state.bots.some(bot=>bot.roleId==='chatroom'));
  config=await readJson(deploymentPath(root));assert.ok(config.gateway.port>0);
  await stopService(config,'web');assert.equal((await inspectService(config,'gateway')).state,'ready');
  await launchService(config,'web');await stopSystem(foregroundConfig);assert.equal((await inspectService(config,'gateway')).state,'stopped');
  config=await readJson(deploymentPath(root));assert.equal((await startSystem(config,{respectIntent:true})).state,'stopped');
  assert.ok(config.gateway.port>0,'foreground stop preserves the allocated gateway port');
  const second=await startSystem(config);assert.equal(second.gateway.url,first.gateway.url);assert.notEqual(second.gateway.bootId,first.gateway.bootId);
});

test('an already spawned service survives temporary handshake timeout or exhausted EOF retries without a duplicate', {timeout:20000}, async t => {
  for (const mode of ['busy', 'partial']) {
    const fixture = await startupFixture(t, mode);
    const ready = await launchService(fixture.config, 'gateway', {timeoutMs:10000});
    assert.equal(ready.state, 'ready'); assert.equal(await fixture.count('spawn-count.txt'), 1);
    assert.ok(await fixture.count('requests.txt') >= (mode === 'busy' ? 2 : 4), 'startup must re-observe the same real owner after the single-probe limit');
  }
});

test('startup never retries malformed identities, mismatched health, or child exit as temporary handshake failures', {timeout:15000}, async t => {
  for (const mode of ['invalid', 'mismatch', 'exit']) {
    const fixture = await startupFixture(t, mode);
    await assert.rejects(launchService(fixture.config, 'gateway', {timeoutMs:5000}), error => mode === 'invalid'
      ? error.code === 'SERVICE_IDENTITY_UNAVAILABLE' && error.cause?.code === 'SERVICE_IDENTITY_INVALID'
      : mode === 'mismatch' ? error.code === 'SERVICE_IDENTITY_MISMATCH' : /exited before readiness \(7\)/.test(error.message));
    assert.equal(await fixture.count('spawn-count.txt'), 1);
    if (mode !== 'exit') assert.equal(await fixture.count('requests.txt'), 1);
  }
});

test('persistent startup uncertainty reaches the existing deadline without claiming stopped, ready, or spawning again', {timeout:10000}, async t => {
  const fixture = await startupFixture(t, 'silent');
  await assert.rejects(launchService(fixture.config, 'gateway', {timeoutMs:2300}), error => error.code === 'SERVICE_STARTUP_TIMEOUT' && error.cause?.cause?.code === 'SERVICE_HANDSHAKE_TIMEOUT');
  assert.equal(await fixture.count('spawn-count.txt'), 1);
  assert.ok(await fixture.count('requests.txt') >= 1);
});
