import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { initializeDeployment,startSystem,stopSystem,stopService,launchService,inspectService,deploymentPath } from '../scripts/installation/system.mjs';
import { acquireServiceLock,inspectServiceLock } from '../scripts/installation/service-lock.mjs';
import { readJson } from '../scripts/build/files.mjs';

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
