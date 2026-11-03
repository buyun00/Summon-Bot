import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { RecordStore } from '../shared/store.mjs';
import { BotManager } from '../bot-management/service.mjs';
import { MemoryManagement } from '../memory-management/service.mjs';
import { BotStore } from '../../bot/src/storage/store.mjs';

async function fixture(t) {
 const dataRoot=await mkdtemp(join(tmpdir(),'summon-capability-management-'));
 const store=new RecordStore(join(dataRoot,'management.sqlite')), mergeStore=new RecordStore(join(dataRoot,'merge.sqlite'));
 const manager=new BotManager({dataRoot,releaseRoot:resolve(import.meta.dirname,'../..'),store,defaultCwd:dataRoot,model:{provider:'openai-compatible',model:'test',baseUrl:'http://127.0.0.1:1/v1'},botApi:async()=>({BotStore,inspectBotIdentity:async()=>null})});
 const memory=new MemoryManagement({store:mergeStore,manager,dataRoot});
 t.after(async()=>{store.close();mergeStore.close();await rm(dataRoot,{recursive:true,force:true});});
 return {dataRoot,store,manager,memory};
}
test('external clone inherits context/memory with new identity, excludes pending actions, and is idempotent',async t=>{
 const {manager}=await fixture(t);await manager.create({id:'parent',roleId:'engineer'});
 const db=new BotStore(join(manager.directory('parent'),'state.sqlite'));
 db.putMemory({id:'fact',text:'Original fact',source:'observed'});db.saveSession({id:'room:one',messages:[{role:'user',content:'Context'}]});
 db.acceptMessage({id:'in-flight',content:'Do not replay'},'controller','boot');db.saveOutbox?.({id:'outbound',status:'unknown'});db.close();
 const result=await manager.clone({parentId:'parent',requestId:'clone-1',start:false});
 assert.notEqual(result.childId,'parent');assert.equal((await manager.clone({parentId:'parent',requestId:'clone-1',start:false})).childId,result.childId);
 const child=new BotStore(join(manager.directory(result.childId),'state.sqlite'));
 assert.equal(child.listTasks().length,0);assert.equal(child.listMessages().length,0);assert.equal(child.listSessions()[0].messages[0].content,'Context');assert.equal(child.getMemory('fact').text,'Original fact');child.close();
 assert.notEqual((await manager.config('parent')).token,(await manager.config(result.childId)).token);
 assert.notEqual((await manager.config('parent')).workspace,(await manager.config(result.childId)).workspace);
});
test('offline delivery, parent conflict, explicit merge and recycling retain artifacts',async t=>{
 const {manager,memory,dataRoot}=await fixture(t);await manager.create({id:'parent',roleId:'engineer'});
 await memory.write('parent',{id:'fact',text:'Base'});
 const fork=await manager.clone({parentId:'parent',requestId:'clone-2',start:false}),child=fork.childId;
 await memory.write(child,{id:'fact',text:'Child conclusion',expectedRevision:1});await memory.write(child,{id:'new',text:'New evidence'});
 await memory.write('parent',{id:'fact',text:'Concurrent parent conclusion',expectedRevision:1});
 await mkdir(join(manager.directory(child),'artifacts'),{recursive:true});await writeFile(join(manager.directory(child),'artifacts','proof.txt'),'evidence');
 const delivery=await memory.deliver({childId:child,requestId:'delivery-1',result:'Finished isolated work'});
 assert.equal((await memory.deliver({childId:child,requestId:'delivery-1'})).id,delivery.id);
 const first=await memory.merge(delivery.id);assert.equal(first.status,'conflict');assert.equal((await memory.list('parent')).find(item=>item.id==='fact').text,'Concurrent parent conclusion');assert.equal((await memory.list('parent')).find(item=>item.id==='new').text,'New evidence');
 const resolved=await memory.merge(delivery.id,{resolutions:{fact:{text:'Both observations with conditions'}}});assert.equal(resolved.status,'merged');
 const revision=(await memory.list('parent')).find(item=>item.id==='fact').revision;await memory.merge(delivery.id);assert.equal((await memory.list('parent')).find(item=>item.id==='fact').revision,revision);
 await manager.archive(child);assert.equal(await readFile(join(delivery.artifactDirectory,'proof.txt'),'utf8'),'evidence');assert.equal(await readFile(join(manager.directory(child),'artifacts','proof.txt'),'utf8'),'evidence');
 assert.ok(JSON.parse(await readFile(join(dataRoot,'archives',child,'record.json'),'utf8')).deliveryId);
});
test('recycling without durable delivery is rejected',async t=>{const {manager}=await fixture(t);await manager.create({id:'parent'});const fork=await manager.clone({parentId:'parent',requestId:'missing-delivery',start:false});await assert.rejects(manager.archive(fork.childId),/Deliver results/);});

test('only seeding marks presets; custom Bots and clones cannot inherit preset identity',async t=>{
 const {manager,store}=await fixture(t);
 await manager.create({id:'bot-engineer',roleId:'engineer',presetId:'engineer',creationSource:'preset'});
 await manager.create({id:'named-like-preset',roleId:'chatroom',name:'聊天室伙伴',presetId:'chatroom'});
 await manager.seed();
 assert.equal(manager.get('bot-engineer').presetId,undefined,'a custom instance occupying a fixed ID is still custom');
 assert.equal(manager.get('named-like-preset').presetId,undefined);
 const seeded=manager.get('bot-chatroom');assert.equal(seeded.presetId,'chatroom');assert.equal(seeded.creationSource,'preset');
 const child=await manager.clone({parentId:'bot-chatroom',requestId:'clone-preset',start:false});
 assert.equal(manager.get(child.childId).presetId,undefined);assert.equal(manager.get(child.childId).creationSource,'custom');
 const prior=store.get('bots','bot-entry');delete prior.creationSource;delete prior.presetId;store.import('bots',prior);
 await manager.seed();assert.equal(manager.get('bot-entry').presetId,'entry','exact legacy fixed ID/role is backfilled by seed');
 const modified=store.get('bots','bot-memory');delete modified.creationSource;delete modified.presetId;modified.roleId='engineer';store.import('bots',modified);
 await manager.seed();assert.equal(manager.get('bot-memory').presetId,undefined,'fixed ID with a different role is not classified as preset');
 const before=store.get('bots','bot-chatroom');await manager.seed();assert.deepEqual(store.get('bots','bot-chatroom'),before,'repeated seed does not rewrite existing provenance');
});
