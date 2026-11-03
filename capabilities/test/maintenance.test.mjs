import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanTemporaryData } from '../bot-management/maintenance.mjs';
import { withBotDataLease,inspectBotIdentity } from '../../bot/src/index.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'summon-managed-cleanup-'));
  const dir=join(root,'bots','temporary'),workspace=join(root,'project');
  await mkdir(join(dir,'tmp','commands'),{recursive:true});
  await mkdir(join(dir,'artifacts'),{recursive:true});await mkdir(workspace,{recursive:true});
  await writeFile(join(dir,'tmp','commands','output.txt'),'disposable');
  await writeFile(join(dir,'artifacts','proof.txt'),'evidence');
  await writeFile(join(workspace,'work.txt'),'project');
  const state={identity:null,tasks:[],tools:[]};
  const manager={get:id=>({id}),directory:()=>dir,identity:async()=>state.identity,botApi:async()=>({withBotDataLease}),readState:async(id,fn)=>fn({listUnfinishedTasks:()=>state.tasks,listTools:()=>state.tools})};
  t.after(()=>rm(root,{recursive:true,force:true}));return {root,dir,workspace,state,manager};
}

test('cleanup only removes managed disposable files, retaining artifacts and external workspace',async t=>{
  const {dir,workspace,manager}=await fixture(t);const result=await cleanTemporaryData(manager,'temporary');
  assert.equal(result.cleaned,true);assert.deepEqual(result.removed,['commands']);
  assert.equal(await readFile(join(dir,'artifacts','proof.txt'),'utf8'),'evidence');
  assert.equal(await readFile(join(workspace,'work.txt'),'utf8'),'project');
});

test('cleanup holds the actual Bot ownership lease throughout inspection and deletion',async t=>{
  const {dir,manager}=await fixture(t);let entered,release;
  const inspecting=new Promise(done=>{entered=done;}),continueInspection=new Promise(done=>{release=done;});
  const original=manager.readState;manager.readState=async(...args)=>{entered();await continueInspection;return original(...args);};
  const pending=cleanTemporaryData(manager,'temporary');await inspecting;
  assert.equal((await inspectBotIdentity(dir)).state,'maintenance');
  try{await assert.rejects(withBotDataLease(dir,async()=>{}),error=>error.code==='INSTANCE_ALREADY_RUNNING');}finally{release();}
  assert.equal((await pending).cleaned,true);assert.equal(await inspectBotIdentity(dir),null);
});

test('cleanup waits for running identities, unknown actions and external executor work',async t=>{
  const {dir,state,manager}=await fixture(t);state.identity={pid:123};
  assert.equal((await cleanTemporaryData(manager,'temporary')).reason,'running');state.identity=null;
  state.tools=[{status:'unknown'}];assert.equal((await cleanTemporaryData(manager,'temporary')).reason,'unfinished-or-unknown-work');state.tools=[];
  state.tasks=[{status:'interrupted'}];assert.equal((await cleanTemporaryData(manager,'temporary')).reason,'unfinished-or-unknown-work');state.tasks=[];
  assert.equal((await cleanTemporaryData(manager,'temporary',{externalTasks:[{botId:'temporary',status:'waiting'}]})).reason,'external-work');
  assert.equal(await readFile(join(dir,'tmp','commands','output.txt'),'utf8'),'disposable');
});

test('cleanup rejects a junction to an external project before deleting anything',async t=>{
  const {dir,workspace,manager}=await fixture(t);await symlink(workspace,join(dir,'tmp','external'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(cleanTemporaryData(manager,'temporary'),/external link/);
  assert.equal(await readFile(join(workspace,'work.txt'),'utf8'),'project');
  assert.equal(await readFile(join(dir,'tmp','commands','output.txt'),'utf8'),'disposable');
});
