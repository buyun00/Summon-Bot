import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startGateway } from '../gateway/index.mjs';
import { BotStore } from '../../bot/src/storage/store.mjs';
import { saveArtifact } from '../../bot/src/storage/artifacts.mjs';
import { inspectBotIdentity } from '../../bot/src/index.mjs';
import { startCapabilityService } from '../services/host.mjs';

async function fixture(t,options={}) {
 const root=await mkdtemp(join(tmpdir(),'relay-gateway-')),dataRoot=join(root,'data'),project=join(root,'project');await mkdir(project);
 if(options.historyEpoch){await mkdir(dataRoot);await writeFile(join(dataRoot,'history.json'),JSON.stringify({historyEpoch:options.historyEpoch}));}
 const gateway=await startGateway({dataRoot,releaseRoot:resolve(import.meta.dirname,'../..'),defaultCwd:project,model:{provider:'openai-compatible',model:'test',baseUrl:'http://127.0.0.1:1/v1'},botApi:async()=>({BotStore,saveArtifact,inspectBotIdentity:async()=>null}),...options});
 t.after(async()=>{await gateway.stopBots();await gateway.close();await rm(root,{recursive:true,force:true});});
 const request=async(path,body,method=body===undefined?'GET':'POST',token=gateway.token)=>fetch(gateway.url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 return {root,dataRoot,project,gateway,request};
}
test('gateway preserves public history, attachment references, sync and private capability authentication',async t=>{
 const {gateway,request}=await fixture(t);
 assert.equal((await fetch(gateway.url+'/api/state')).status,401);
 const room=await (await request('/api/rooms',{name:'History',members:['user']})).json();
 const bytes=Buffer.from('original attachment'),attachment=await(await request('/api/attachments',{name:'proof.txt',data:bytes.toString('base64')})).json();
 const sent=await(await request(`/api/rooms/${room.id}/messages`,{content:'Evidence',attachments:[{id:attachment.id}],clientId:'one'})).json();
 const repeated=await(await request(`/api/rooms/${room.id}/messages`,{content:'Evidence',clientId:'one'})).json();assert.equal(sent.id,repeated.id);
 assert.deepEqual(Buffer.from(await(await request(`/api/attachments/${attachment.id}`)).arrayBuffer()),bytes);
 const first=await(await request('/api/state?sync=1')).json();assert.equal(first.sync.reset,true);
 const second=await(await request(`/api/state?sync=1&since=${first.sync.cursor}`)).json();assert.equal(second.sync.reset,false);assert.deepEqual(second.patch,{values:{},collections:{}});
 const botToken=gateway.manager.store.get('bots','bot-engineer').capabilityToken;
 assert.equal((await request('/api/state',undefined,'GET',botToken)).status,403);
 assert.equal((await request('/tools/bots_stop',{arguments:{botId:'bot-qa'}},'POST',botToken)).status,403);
 const config=await gateway.manager.config('bot-engineer');assert.ok(config.tools.every(tool=>tool.type==='http'));assert.ok(config.skills.length);
});

test('workspace and room snapshots expose one persisted history epoch on full, reset and delta responses',async t=>{
 const {request}=await fixture(t,{historyEpoch:'explicit-cleared-history-fixture'});
 const room=await(await request('/api/rooms',{name:'Empty after reset',members:['user']})).json();
 for(const path of ['/api/state',`/api/rooms/${room.id}/messages`]){
  const full=await(await request(path)).json();assert.equal(full.historyEpoch,'explicit-cleared-history-fixture');
  const first=await(await request(path+'?sync=1')).json();assert.equal(first.historyEpoch,full.historyEpoch);assert.equal(first.snapshot.historyEpoch,full.historyEpoch);assert.equal(first.sync.reset,true);
  const next=await(await request(path+`?sync=1&since=${first.sync.cursor}`)).json();assert.equal(next.historyEpoch,full.historyEpoch);assert.equal(next.sync.reset,false);
 }
});

test('an incomplete history clear blocks gateway startup before any worker is started',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'relay-gateway-incomplete-history-'));
 t.after(()=>rm(dataRoot,{recursive:true,force:true}));
 for(const status of ['clearing','failed']){
  await writeFile(join(dataRoot,'history.json'),JSON.stringify({historyEpoch:'incomplete-fixture',status}));
  await assert.rejects(startGateway({dataRoot,releaseRoot:resolve(import.meta.dirname,'../..')}),/History maintenance has not completed/);
 }
});
test('a real MCP SDK client initializes, discovers and calls the capability gateway',async t=>{
 const {gateway}=await fixture(t),token=gateway.manager.store.get('bots','bot-components').capabilityToken;
 const client=new Client({name:'relay-gateway-test',version:'1.0.0'});
 await client.connect(new StreamableHTTPClientTransport(new URL(gateway.url+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
 t.after(()=>client.close());
 const listed=await client.listTools();assert.ok(listed.tools.some(tool=>tool.name==='knowledge_search'));assert.ok(!listed.tools.some(tool=>tool.name==='bots_stop'));
 const result=await client.callTool({name:'knowledge_search',arguments:{query:'absent'}});assert.equal(result.isError,false);assert.deepEqual(JSON.parse(result.content[0].text),{nodes:[],edges:[]});
});
test('filesystem capability preserves complete command artifacts and authenticated three-ID download after Bot stop',async t=>{
 const {gateway,request}=await fixture(t),actor='bot-engineer';
 const result=await gateway.callTool('run_command',{command:process.platform==='win32'?"[Console]::Out.Write(('x' * 90000))":"printf '%090000d' 0"},actor);
 assert.equal(result.details.exitCode,0);assert.equal(result.artifacts[0].size,90000);
 const db=new BotStore(join(gateway.manager.directory(actor),'state.sqlite')),accepted=db.acceptMessage({id:'artifact-test',content:'test'},'controller','test');
 db.saveTool({id:'tool-artifact',taskId:accepted.task.id,runId:accepted.task.id,status:'completed',name:'run_command',artifacts:result.artifacts});db.updateTask(accepted.task.id,{status:'completed',result:{content:'done'}});db.close();
 const path=`/api/agent-runs/${accepted.task.id}/tools/tool-artifact/artifacts/${result.artifacts[0].id}`;
 const response=await request(path);assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,90000);
 assert.equal((await request(path+'?path=outside')).status,404);
 await writeFile(result.artifacts[0].path,'changed');assert.notEqual((await request(path)).status,200);
});
test('Codex consultation blocks every mutating capability, including new work and clone',async t=>{
 const {gateway}=await fixture(t);gateway.codex.store.save('works',{id:'waiting-test',botId:'bot-engineer',status:'waiting',question:{targetBotId:'bot-engineer'}});
 await assert.rejects(gateway.callTool('codex_submit',{goal:'nested'},'bot-engineer'),/read-only/);
 await assert.rejects(gateway.callTool('bots_clone',{parentId:'bot-engineer',requestId:'nested'},'bot-engineer'),/read-only/);
 await assert.rejects(gateway.callTool('knowledge_save_node',{title:'new',content:'new'},'bot-engineer'),/read-only/);
 assert.ok(Array.isArray(await gateway.callTool('bots_list',{},'bot-engineer')));
});

test('system stop quiesces real service deliveries before stopping Bots and rejects restart races',async t=>{
 const {gateway,request}=await fixture(t);
 const identity=await gateway.manager.start('bot-engineer');assert.notEqual(identity.pid,process.pid);
 const room=await gateway.chatroom.createRoom({members:['user','bot-engineer']});
 await gateway.chatroom.post(room.id,{content:'A real service delivery concurrent with stop',toBotId:'bot-engineer'});
 const stopping=request('/internal/bots/stop-all',{});
 for(let i=0;i<100&&!gateway.manager.quiescing;i++)await new Promise(done=>setTimeout(done,10));
 assert.equal(gateway.manager.quiescing,true);
 assert.equal((await request(`/api/rooms/${room.id}/messages`,{content:'Too late'})).status,503);
 await assert.rejects(gateway.callTool('bots_start',{botId:'bot-engineer'}),/stopping/);
 const stopped=await stopping;assert.equal(stopped.status,200);assert.equal((await stopped.json()).length,gateway.manager.list().length);
 await assert.rejects(gateway.manager.start('bot-engineer'),/stopping/);
 await assert.rejects(gateway.manager.send('bot-engineer',{content:'Too late'}),/stopping/);
 assert.deepEqual(await gateway.manager.monitor(),[]);
 assert.equal(await inspectBotIdentity(gateway.manager.directory('bot-engineer')),null);
 assert.equal((await request('/api/state')).status,200);
 assert.equal(gateway.chatroom.closed,true);
 assert.ok(gateway.chatroom.jobs(room.id).every(job=>['completed','failed','cancelled','interrupted'].includes(job.status)));
 assert.equal((await request('/internal/bots/stop-all',{})).status,200);
});

test('unloaded builtin stays unloaded across a gateway restart with stable endpoint and credential',async t=>{
 const dataRoot=await mkdtemp(join(tmpdir(),'relay-gateway-unload-')),releaseRoot=resolve(import.meta.dirname,'../..');
 let gateway;
 t.after(async()=>{if(gateway){await gateway.stopBots();await gateway.close();}await rm(dataRoot,{recursive:true,force:true});});
 gateway=await startGateway({dataRoot,releaseRoot,defaultCwd:dataRoot,model:{provider:'openai-compatible',model:'test',baseUrl:'http://127.0.0.1:1/v1'}});
 const token=gateway.token,port=Number(new URL(gateway.url).port);
 await gateway.control.unload('knowledge');
 for(let i=0;i<100&&gateway.registry.inventory().bindings.some(actor=>actor.bindings.knowledge);i++){await gateway.control.tick();await new Promise(done=>setTimeout(done,20));}
 assert.ok(gateway.registry.inventory().bindings.every(actor=>!actor.bindings.knowledge));
 await gateway.close();gateway=null;
 gateway=await startGateway({dataRoot,releaseRoot,defaultCwd:dataRoot,token,port,model:{provider:'openai-compatible',model:'test',baseUrl:'http://127.0.0.1:1/v1'}});
 assert.equal(gateway.registry.active('knowledge'),undefined);
 assert.equal(gateway.registry.inventory().services.find(service=>service.id==='knowledge').status,'draining');
 assert.ok(gateway.registry.inventory().bindings.every(actor=>!actor.bindings.knowledge));
 assert.ok(!gateway.control.tools(gateway.manager.get('bot-engineer')).some(tool=>tool.name==='knowledge_search'));
 await assert.rejects(gateway.callTool('knowledge_search',{query:'still unloaded'},'bot-engineer'),{code:'CAPABILITY_TOOL_NOT_BOUND'});
});

test('gateway reserves Bot core and resource tools before external capability registration',async t=>{
 const {gateway}=await fixture(t);
 for(const name of ['memory_write','messages_send','read_resource','read_session_history']){
  const service=await startCapabilityService({id:'reserved-probe',version:name,token:'explicit-reserved-tool-fixture-token',tools:[{name,description:'Collision fixture',effect:'read',inputSchema:{type:'object'}}],callTool:()=>({})});
  try{await assert.rejects(gateway.registry.register({id:'reserved-probe',version:name,endpoint:service.url,token:'explicit-reserved-tool-fixture-token'}),{code:'CAPABILITY_TOOL_COLLISION'});}
  finally{await service.close();}
 }
 assert.ok(!gateway.registry.inventory().services.some(service=>service.id==='reserved-probe'));
});

test('Codex status and cancellation remain routed to an existing job after capability unload',async t=>{
 const {gateway}=await fixture(t,{codexPath:[process.execPath,resolve(import.meta.dirname,'helpers/fake-codex.mjs')]});
 const work=await gateway.callTool('codex_submit',{goal:'HOLD explicit protocol fixture'},'bot-engineer');
 for(let i=0;i<150&&!gateway.codex.get(work.id).turnId;i++)await new Promise(done=>setTimeout(done,20));
 assert.ok(gateway.codex.get(work.id).turnId);
 await gateway.control.unload('codex');
 assert.equal(gateway.registry.active('codex'),undefined);
 const result=await gateway.callTool('codex_status',{workId:work.id});
 assert.equal(result.serviceVersion,work.serviceVersion);assert.equal(result.status,'running');
 const cancelled=await gateway.callTool('codex_cancel',{workId:work.id});assert.equal(cancelled.status,'cancelled');
});

test('gateway supervisor restarts a crashed required worker and relocates its existing version',async t=>{
 let listening;
 const {gateway}=await fixture(t,{onListening:value=>{listening=value;}});
 assert.equal(listening.url,gateway.url);assert.equal(listening.port,Number(new URL(gateway.url).port));
 const version=gateway.registry.active('knowledge').version,previous=await gateway.supervisor.status('knowledge',version);
 assert.equal(previous.state,'ready');assert.notEqual(previous.pid,process.pid);
 process.kill(previous.pid,'SIGKILL');
 for(let i=0;i<150;i++){await gateway.monitorServices();const status=await gateway.supervisor.status('knowledge',version);if(status.state==='ready'&&status.pid!==previous.pid)break;await new Promise(done=>setTimeout(done,30));}
 const restored=await gateway.supervisor.status('knowledge',version);
 assert.equal(restored.state,'ready');assert.notEqual(restored.pid,previous.pid);assert.notEqual(restored.bootId,previous.bootId);
 assert.equal(gateway.registry.getVersion('knowledge',version).endpoint,restored.url);
 assert.deepEqual(await gateway.callTool('knowledge_search',{query:'after restart'},'bot-engineer'),{nodes:[],edges:[]});
});
