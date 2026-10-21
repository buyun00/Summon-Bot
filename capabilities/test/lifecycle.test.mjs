import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { startGateway } from '../gateway/index.mjs';

async function until(check,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){const result=await check();if(result)return result;await new Promise(done=>setTimeout(done,80));}throw new Error('Lifecycle verification timed out');}

test('real independent Pi processes consume deterministic group deliveries and external clones; model is explicitly a fixture',async t=>{
 const calls=[];
 const provider=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));calls.push(body);const hasTool=body.messages.some(message=>message.role==='tool');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'EXPLICIT_PROTOCOL_FIXTURE',choices:[{finish_reason:hasTool?'stop':'tool_calls',message:hasTool?{role:'assistant',content:'Protocol fixture observed the actual tool result.'}:{role:'assistant',content:null,tool_calls:[{id:'knowledge-call',type:'function',function:{name:'knowledge_search',arguments:'{"query":"fixture"}'}}]}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}));});
 await new Promise(done=>provider.listen(0,'127.0.0.1',done));
 const dataRoot=await mkdtemp(join(tmpdir(),'relay-real-process-'));
 const gateway=await startGateway({dataRoot,releaseRoot:resolve(import.meta.dirname,'../..'),defaultCwd:dataRoot,model:{provider:'openai-compatible',model:'fixture',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`,apiKey:'fixture-credential'}});
 t.after(async()=>{
  const failures=[];
  const cleanup=async(name,operation)=>{try{await operation();return true;}catch(error){failures.push(new Error(`Lifecycle fixture cleanup failed: ${name}`,{cause:error}));return false;}};
  const stopped=await cleanup('stop independent Bots',()=>gateway.manager.shutdownAll());
  await cleanup('close capability gateway',()=>gateway.close());
  await cleanup('close fixture provider',async()=>{provider.closeAllConnections();await new Promise((done,reject)=>provider.close(error=>error?reject(error):done()));});
  if(stopped)await cleanup('remove stopped fixture data',()=>rm(dataRoot,{recursive:true,force:true}));
  else t.diagnostic(`Fixture data retained because Bot shutdown could not be confirmed: ${dataRoot}`);
  if(failures.length)throw new AggregateError(failures,'Lifecycle fixture cleanup did not complete');
 });
 const room=gateway.chatroom.createRoom({name:'Actual process discussion',members:['user','bot-chatroom']});
 const message=gateway.chatroom.post(room.id,{content:'Use shared knowledge then reply',clientId:'unique'});
 const repeated=gateway.chatroom.post(room.id,{content:'Use shared knowledge then reply',clientId:'unique'});assert.equal(message.id,repeated.id);
 await until(()=>gateway.chatroom.messages(room.id).find(item=>item.senderId==='bot-chatroom'));
 const identity=await gateway.manager.identity('bot-chatroom');assert.notEqual(identity.pid,process.pid);
 const health=await gateway.manager.request('bot-chatroom','/health');assert.ok(health.engine);
 const task=gateway.chatroom.jobs(room.id)[0];await until(()=>gateway.chatroom.jobs(room.id)[0].status==='completed');
 const run=await gateway.manager.request('bot-chatroom',`/tasks/${task.taskId}`);assert.equal(run.tools.filter(tool=>tool.name==='knowledge_search').length,1);assert.ok(calls.length>=2);
 await gateway.memories.write('bot-chatroom',{id:'baseline',text:'Observed fact'});
 const fork=await gateway.manager.clone({parentId:'bot-chatroom',requestId:'actual-clone',task:'Report the inherited observation'});
 const child=await gateway.manager.identity(fork.childId);assert.notEqual(child.pid,identity.pid);
 await until(async()=>{const tasks=await gateway.manager.tasks(fork.childId);return tasks.find(task=>task.status==='completed');});
 await gateway.memories.write(fork.childId,{id:'extra',text:'Child observation'});
 await gateway.manager.stop('bot-chatroom');
 const delivery=await gateway.memories.deliver({requestId:'actual-delivery',childId:fork.childId,result:'Actual independent process completed against the fixture model'});
 await gateway.manager.stop(fork.childId);assert.equal((await gateway.memories.merge(delivery.id)).status,'merged');
 assert.ok((await gateway.memories.list('bot-chatroom')).some(memory=>memory.text==='Child observation'));
 await gateway.manager.archive(fork.childId);
});
