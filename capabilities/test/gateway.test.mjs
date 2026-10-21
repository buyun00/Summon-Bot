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

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'relay-gateway-')),dataRoot=join(root,'data'),project=join(root,'project');await mkdir(project);
 const gateway=await startGateway({dataRoot,releaseRoot:resolve(import.meta.dirname,'../..'),defaultCwd:project,model:{provider:'openai-compatible',model:'test',baseUrl:'http://127.0.0.1:1/v1'},botApi:async()=>({BotStore,saveArtifact,inspectBotIdentity:async()=>null})});
 t.after(async()=>{await gateway.close();await rm(root,{recursive:true,force:true});});
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

test('system stop quiesces a concurrent delivery before stopping Bots and rejects restart races',async t=>{
 const {gateway,request}=await fixture(t);let entered,release;
 const staging=new Promise(done=>{entered=done;}),continueStaging=new Promise(done=>{release=done;});
 gateway.attachments.stageContext=async context=>{entered();await continueStaging;return context;};
 let stopped=0;const originalStop=gateway.manager.stop.bind(gateway.manager);
 gateway.manager.stop=async(...args)=>{assert.equal(gateway.chatroom.busy,false);stopped++;return originalStop(...args);};
 const room=gateway.chatroom.createRoom({members:['user','bot-engineer']});
 gateway.chatroom.post(room.id,{content:'A delivery concurrent with stop',toBotId:'bot-engineer'});await staging;
 const stopping=request('/internal/bots/stop-all',{});
 for(let i=0;i<100&&!gateway.manager.quiescing;i++)await new Promise(done=>setTimeout(done,10));
 assert.equal(gateway.manager.quiescing,true);assert.equal(stopped,0);
 try {
   assert.equal((await request(`/api/rooms/${room.id}/messages`,{content:'Too late'})).status,503);
   await assert.rejects(gateway.callTool('bots_start',{botId:'bot-engineer'}),/stopping/);
   await assert.rejects(gateway.manager.start('bot-engineer'),/stopping/);
   await assert.rejects(gateway.manager.send('bot-engineer',{content:'Too late'}),/stopping/);
   assert.deepEqual(await gateway.manager.monitor(),[]);
   assert.equal((await request('/api/state')).status,200);
 } finally {release();}
 assert.equal((await stopping).status,200);assert.equal(stopped,gateway.manager.list().length);
 assert.equal(gateway.chatroom.closed,true);assert.equal(gateway.chatroom.jobs(room.id)[0].taskId,undefined);
 assert.equal((await request('/internal/bots/stop-all',{})).status,200);assert.equal(stopped,gateway.manager.list().length);
});
