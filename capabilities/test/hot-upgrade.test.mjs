import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startGateway } from '../gateway/index.mjs';

async function until(check,timeout=30000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=await check();if(result)return result;await new Promise(done=>setTimeout(done,50));}throw new Error('Hot upgrade verification timed out');}

test('independent service deployment pins an active Pi task, switches at readiness, binds new Bots to v2 and drains unload', {timeout:120000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'relay-hot-upgrade-')),dataRoot=join(root,'data');await mkdir(dataRoot);
  let gateway,releaseOld,oldEntered=false;
  const held=new Promise(done=>{releaseOld=done;});
  const provider=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
    const lastTool=body.messages.findLast(message=>message.role==='tool');
    if(!lastTool&&JSON.stringify(body.messages).includes('hold-old')){oldEntered=true;await held;}
    const tool=body.tools?.find(item=>item.function.name==='version_probe');
    const field=tool?.function.parameters?.properties?.v2?'v2':'v1';
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'EXPLICIT_PROTOCOL_FIXTURE',choices:[{finish_reason:lastTool?'stop':'tool_calls',message:lastTool?{role:'assistant',content:typeof lastTool.content==='string'?lastTool.content:JSON.stringify(lastTool.content)}:{role:'assistant',content:null,tool_calls:[{id:'probe-call',type:'function',function:{name:'version_probe',arguments:JSON.stringify({[field]:'observed'})}}]}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
  });
  await new Promise(done=>provider.listen(0,'127.0.0.1',done));
  t.after(async()=>{releaseOld();if(gateway){await fetch(gateway.url+'/internal/bots/stop-all',{method:'POST',headers:{Authorization:`Bearer ${gateway.token}`,'Content-Type':'application/json'},body:'{}'});await gateway.close();}provider.closeAllConnections();await new Promise(done=>provider.close(done));await rm(root,{recursive:true,force:true});});
  gateway=await startGateway({dataRoot,releaseRoot:resolve(import.meta.dirname,'../..'),defaultCwd:root,seed:false,restore:false,model:{provider:'openai-compatible',model:'fixture',apiKey:'fixture-credential',baseUrl:`http://127.0.0.1:${provider.address().port}/v1`}});
  const api=async(operation,input)=>{const response=await fetch(`${gateway.url}/api/capabilities/${operation}`,{method:'POST',headers:{Authorization:`Bearer ${gateway.token}`,'Content-Type':'application/json'},body:JSON.stringify(input)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
  const pack=async version=>{
    const packageRoot=join(root,version);await mkdir(packageRoot);await writeFile(join(packageRoot,'capability.json'),JSON.stringify({id:'version-probe',version,stateVersion:'1',entry:'index.mjs'}));
    await writeFile(join(packageRoot,'index.mjs'),`export function createCapability(){return {tools:[{name:'version_probe',description:'Read the service version',effect:'read',inputSchema:{type:'object',properties:{${version}:{type:'string'}},required:['${version}'],additionalProperties:false}}],callTool(name,args){if(!args.${version})throw new Error('Wrong version schema');return {version:'${version}',pid:process.pid};}};}\n`);
    return packageRoot;
  };
  const v1=await api('deploy',{id:'version-probe',version:'v1',packageRoot:await pack('v1')});assert.notEqual(v1.pid,process.pid);
  const makeBot=async id=>{await gateway.manager.create({id,roleId:'engineer'});await api('grant',{botId:id,tools:['version_probe']});await until(()=>gateway.registry.bindingsFor(id)['version-probe']&&gateway.control.inventory().switches.find(item=>item.id===id)?.phase==='complete');return id;};
  const old=await makeBot('bot-old');
  const accepted=await gateway.manager.send(old,{id:'old-task',sessionId:'old-task',kind:'request',content:{text:'hold-old'}});await until(()=>oldEntered);
  const oldPid=(await gateway.manager.identity(old)).pid;
  const v2=await api('deploy',{id:'version-probe',version:'v2',packageRoot:await pack('v2')});assert.notEqual(v2.pid,v1.pid);
  await until(()=>gateway.control.inventory().switches.find(item=>item.id===old)?.phase==='preparing');
  assert.equal(gateway.registry.bindingsFor(old)['version-probe'],'v1');
  const young=await makeBot('bot-new');assert.equal(gateway.registry.bindingsFor(young)['version-probe'],'v2');
  const newer=await gateway.manager.send(young,{id:'new-task',sessionId:'new-task',kind:'request',content:{text:'probe new service'}});
  const newResult=await until(async()=>{const task=await gateway.manager.request(young,`/tasks/${newer.taskId}`);return task.status==='completed'&&task;});assert.match(newResult.result.content,/v2/);
  const blocked=await fetch(gateway.url+'/api/capabilities/retire',{method:'POST',headers:{Authorization:`Bearer ${gateway.token}`,'Content-Type':'application/json'},body:JSON.stringify({id:'version-probe',version:'v1'})});assert.equal(blocked.status,409);
  releaseOld();
  const oldResult=await until(async()=>{const task=await gateway.manager.request(old,`/tasks/${accepted.taskId}`);return task.status==='completed'&&task;});assert.match(oldResult.result.content,/v1/);
  await until(()=>gateway.registry.bindingsFor(old)['version-probe']==='v2'&&gateway.control.inventory().switches.find(item=>item.id===old)?.phase==='complete');
  assert.equal((await gateway.manager.identity(old)).pid,oldPid,'Bot process must survive capability upgrade');
  const follow=await gateway.manager.send(old,{id:'after-task',sessionId:'after-task',kind:'request',content:{text:'probe after switch'}});
  const after=await until(async()=>{const task=await gateway.manager.request(old,`/tasks/${follow.taskId}`);return task.status==='completed'&&task;});assert.match(after.result.content,/v2/);
  assert.equal((await api('retire',{id:'version-probe',version:'v1'})).state,'stopped');
  await api('unload',{id:'version-probe'});
  await until(()=>[old,young].every(id=>!gateway.registry.bindingsFor(id)['version-probe']&&gateway.control.inventory().switches.find(item=>item.id===id)?.phase==='complete'));
  assert.ok(!(await gateway.manager.request(old,'/health')).engine.tools.includes('version_probe'));
  assert.equal((await api('retire',{id:'version-probe',version:'v2'})).state,'stopped');
});
