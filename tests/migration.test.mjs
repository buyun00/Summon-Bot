import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { migrate } from '../scripts/migration/migrate.mjs';
import { BotStore } from '@summon/bot';
import { RecordStore } from '../capabilities/shared/store.mjs';

async function database(path,rows){await mkdir(resolve(path,'..'),{recursive:true});const db=new DatabaseSync(path);db.exec('CREATE TABLE records(kind TEXT,id TEXT,created_at TEXT,updated_at TEXT,data TEXT,PRIMARY KEY(kind,id))');for(const [kind,value]of rows)db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(kind,value.id,'2026-01-01','2026-01-02',JSON.stringify(value));db.close();}
test('source-only history migrates into a new data root while preview remains read-only',async t=>{
  const root=await mkdtemp(join(tmpdir(),'summon-new-root-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sourceRoot=join(root,'source'),dataRoot=join(root,'new-data');
  const room={id:'source-only-room',name:'retained',kind:'group',members:['user'],createdAt:'2026-01-01',updatedAt:'2026-01-02'};
  const message={id:'source-only-message',roomId:room.id,senderId:'user',content:'original history',createdAt:'2026-01-01',updatedAt:'2026-01-02'};
  await database(join(sourceRoot,'.relay','summon.sqlite'),[['rooms',room],['messages',message]]);
  const options={sourceRoot,dataRoot,releaseRoot:resolve('.')};
  assert.equal((await migrate(options)).mode,'preview');assert.equal(existsSync(dataRoot),false);
  const result=await migrate({...options,execute:true});assert.equal(result.mode,'imported');assert.equal(result.backupCreated,false);assert.equal(result.automaticReplay,false);
  const chat=new RecordStore(join(dataRoot,'capabilities','chatroom','state.sqlite'));
  try{assert.deepEqual(chat.get('rooms',room.id),room);assert.deepEqual(chat.get('messages',message.id),message);}finally{chat.close();}
  assert.equal((await migrate({...options,execute:true})).mode,'unchanged');
});
test('migration prefers worker transcript, retains IDs and attachments, and never queues uncertain work',async t=>{
  const root=await mkdtemp(join(tmpdir(),'summon-layout-migration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const sourceRoot=join(root,'source'),dataRoot=join(root,'data'),instance=join(dataRoot,'instances','worker-a');await mkdir(instance,{recursive:true});
  await writeFile(join(instance,'instance.json'),JSON.stringify({botId:'bot-engineer',instanceId:'worker-a',app:'agent'}));
  const bot={id:'bot-engineer',name:'工程伙伴',role:'工程',status:'active',createdAt:'2026-01-01',updatedAt:'2026-01-02'};
  const run={id:'run-a',botId:bot.id,roomId:'room-a',status:'running',messages:[{role:'user',content:'retained'}]};
  const session={id:'original-session-id',botId:bot.id,roomId:'room-a',messages:run.messages};
  const room={id:'room-a',name:'room',kind:'group',members:['user',bot.id]};
  const job={id:'job-a',botId:bot.id,roomId:room.id,messageId:'message-a',status:'running'};
  await database(join(sourceRoot,'.relay','summon.sqlite'),[['bots',bot],['rooms',room],['agentRuns',{...run,messages:[]}],['jobs',job],['messages',{id:'message-a',roomId:room.id,senderId:'user',content:'unchanged'}]]);
  await database(join(instance,'legacy','summon.sqlite'),[['agentRuns',run],['agentSessions',session],['jobs',job]]);
  const original=join(sourceRoot,'.relay','attachments','attachment-a');await mkdir(original,{recursive:true});await writeFile(join(original,'data'),'fixture bytes');
  const options={sourceRoot,dataRoot,releaseRoot:resolve('.')};const preview=await migrate(options);assert.equal(preview.mode,'preview');
  const result=await migrate({...options,execute:true});assert.equal(result.backupCreated,false);assert.equal(result.automaticReplay,false);assert.equal(result.decisions[0].rule,'worker-execution-authority');
  const store=new BotStore(join(dataRoot,'bots',bot.id,'state.sqlite'),{readOnly:true});try{assert.deepEqual(store.getRecord('agentRuns',run.id).messages,run.messages);assert.equal(store.getSession(session.id).contextKey,'room:room-a');assert.equal(store.listTasks().length,0);}finally{store.close();}
  const chat=new RecordStore(join(dataRoot,'capabilities','chatroom','state.sqlite'));try{assert.equal(chat.get('deliveries','job-a').status,'interrupted');assert.equal(chat.get('messages','message-a').content,'unchanged');}finally{chat.close();}
  assert.equal(await readFile(join(dataRoot,'capabilities','chatroom','attachments','attachment-a','data'),'utf8'),'fixture bytes');
  assert.equal((await migrate({...options,execute:true})).mode,'unchanged');
  await writeFile(join(dataRoot,'capabilities','chatroom','attachments','attachment-a','data'),'tampered');
  await assert.rejects(migrate({...options,execute:true}),/verification failed/);
});
