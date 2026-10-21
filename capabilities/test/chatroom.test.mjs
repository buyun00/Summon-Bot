import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordStore } from '../shared/store.mjs';
import { ChatroomService } from '../chatroom/service.mjs';

function fixture(t){const store=new RecordStore(':memory:'),bots=new RecordStore(':memory:'),sent=[];for(const id of ['a','b','c'])bots.save('bots',{id,name:id,status:'active'});const manager={store:bots,get:id=>{const bot=bots.get('bots',id);if(!bot)throw new Error('Missing Bot');return bot;},config:async()=>({workspace:'unused'}),send:async(id,message)=>{sent.push({id,message});return {taskId:`task-${message.id}`};},request:async(id,path)=>({id:path.split('/').at(-1),status:'completed',result:{content:`Answer from ${id}`,model:'EXPLICIT_FIXTURE'}})};
 const service=new ChatroomService({store,manager,attachments:{resolve:()=>[],stageContext:async context=>context}});service.closed=true;
 t.after(async()=>{await service.close();store.close();bots.close();});return {service,store,bots,sent};}
test('public message dedup is independent of Bot execution and multiple DMs return to their original room',async t=>{
 const {service,sent}=fixture(t);const one=service.createRoom({members:['user','a'],name:'One'}),two=service.createRoom({members:['user','a'],name:'Two'});
 const trigger1=service.post(one.id,{content:'question one',toBotId:'a',clientId:'first'}),trigger2=service.post(two.id,{content:'question two',toBotId:'a'});
 assert.equal(service.post(one.id,{content:'question one',toBotId:'a',clientId:'first'}).id,trigger1.id);
 const dm1=service.dm('a',{targetBotId:'b',message:'first fact?',originRoomId:one.id,originMessageId:trigger1.id}),dm2=service.dm('a',{targetBotId:'b',message:'second fact?',originRoomId:two.id,originMessageId:trigger2.id});assert.equal(dm1.roomId,dm2.roomId);
 await service.deliver(service.jobs().find(job=>job.messageId===dm1.id));await service.deliver(service.jobs().find(job=>job.messageId===dm2.id));
 const returns=service.jobs().filter(job=>job.id.startsWith('dm-return:'));assert.equal(returns.length,2);assert.equal(returns[0].roomId,one.id);assert.equal(returns[1].roomId,two.id);
 await service.deliver(returns[0]);assert.ok(service.messages(one.id).some(message=>message.senderId==='a'));assert.ok(!service.jobs().some(job=>job.roomId===dm1.roomId&&job.botId==='a'));
 assert.equal(sent.length,3);
});
test('nested requests retain the collaboration root/hop and reject unlimited automatic handoff',t=>{const {service}=fixture(t);const room=service.createRoom({members:['user','a']});const trigger=service.post(room.id,{content:'start',toBotId:'a'});const first=service.dm('a',{targetBotId:'b',message:'first',originRoomId:room.id,originMessageId:trigger.id});const second=service.dm('b',{targetBotId:'c',message:'second',originRoomId:first.roomId,originMessageId:first.id});assert.equal(second.rootId,trigger.id);assert.equal(second.hop,2);const third=service.dm('c',{targetBotId:'a',message:'third',originRoomId:second.roomId,originMessageId:second.id});assert.equal(third.hop,3);assert.throws(()=>service.dm('a',{targetBotId:'b',message:'fourth',originRoomId:third.roomId,originMessageId:third.id}),/hop limit/);});
test('uncertain receipt retry reuses the delivery identifier instead of creating another task',t=>{const {service,store}=fixture(t);const room=service.createRoom({members:['user','a']});const message=service.post(room.id,{content:'side effect',toBotId:'a'}),job=service.jobs().find(job=>job.messageId===message.id);store.save('deliveries',{...job,status:'interrupted',error:'Receipt not observed'});assert.equal(service.retry(job.id).id,job.id);assert.equal(service.jobs().length,1);});

test('repeated retries share one attempt and a successful replacement prevents replay',async t=>{
 const {service,store,sent}=fixture(t),room=service.createRoom({members:['user','a']});
 const message=service.post(room.id,{content:'perform once',toBotId:'a'}),original=service.jobs(room.id)[0];
 store.save('deliveries',{id:original.id,status:'failed',taskId:'old-task',error:'failed before a reply'});
 const first=service.retry(original.id),second=service.retry(original.id);
 assert.equal(first.id,second.id);assert.equal(service.jobs(room.id).length,2);
 await service.deliver(first);
 const completed=service.retry(original.id);assert.equal(completed.id,first.id);assert.equal(completed.status,'completed');
 assert.equal(service.retry(first.id).id,first.id);assert.equal(sent.length,1);
 assert.equal(service.messages(room.id).filter(item=>item.replyTo===message.id).length,1);
 assert.equal(store.get('deliveries',original.id).status,'failed','preserve the original attempt as historical evidence');
});

test('retrying a failed replacement advances the chain and preserves its instruction',t=>{
 const {service,store}=fixture(t),room=service.createRoom({members:['user','a']});
 service.post(room.id,{content:'original question',toBotId:'a'});const original=service.jobs(room.id)[0];
 store.save('deliveries',{id:original.id,status:'interrupted',taskId:'old-task',instruction:'Return the recorded peer answer',peerAnswer:{answer:'fact'},routineId:'routine'});
 const first=service.retry(original.id);store.save('deliveries',{id:first.id,status:'failed',taskId:'second-task'});
 const second=service.retry(original.id);assert.equal(second.retryOf,first.id);
 assert.equal(service.retry(first.id).id,second.id);assert.equal(service.jobs(room.id).length,3);
 assert.equal(second.instruction,'Return the recorded peer answer');assert.deepEqual(second.peerAnswer,{answer:'fact'});assert.equal(second.routineId,'routine');
});

test('a recorded reply blocks replay of a stale migrated failure, but unrelated replies do not',t=>{
 const {service,store}=fixture(t),room=service.createRoom({members:['user','a']});
 const message=service.post(room.id,{content:'old request',toBotId:'a'}),job=service.jobs(room.id)[0];
 store.save('deliveries',{id:job.id,status:'interrupted',error:'Migration stopped unconfirmed work; explicit retry required'});
 service.append(room.id,{content:'old final answer',jobId:job.id,replyTo:message.id},'a');
 assert.throws(()=>service.retry(job.id),error=>error.status===409&&/recorded reply/.test(error.message));
 assert.equal(store.get('deliveries',job.id).status,'interrupted');assert.equal(service.jobs(room.id).length,1);
 const other=service.post(room.id,{content:'unrelated request',toBotId:'a'}),unanswered=service.jobs(room.id).find(item=>item.messageId===other.id);
 store.save('deliveries',{id:unanswered.id,status:'interrupted'});
 assert.equal(service.retry(unanswered.id).id,unanswered.id);
});

test('a retry owned by another service version is reused and uncertain receipts emit a queue event',t=>{
 const {service,store}=fixture(t),room=service.createRoom({members:['user','a']});
 service.post(room.id,{content:'request',toBotId:'a'});const original=service.jobs(room.id)[0];
 store.save('deliveries',{id:original.id,status:'failed',taskId:'prior-task'});service.version='old';
 const first=service.retry(original.id);service.version='new';
 assert.equal(service.retry(original.id).id,first.id);assert.equal(service.retry(original.id).serviceVersion,'old');
 const events=[];service.emit=(type,value)=>events.push({type,value});
 store.save('deliveries',{id:first.id,status:'interrupted',taskId:null,finishedAt:'old-time'});
 const resumed=service.retry(original.id);assert.equal(resumed.id,first.id);assert.equal(resumed.serviceVersion,'new');
 assert.equal(resumed.finishedAt,null);assert.equal(events.at(-1).type,'job');assert.equal(events.at(-1).value.status,'queued');
});

test('deep discussion groups a host turn, waits for every participant, and obeys its round limit',async t=>{
 const {service,store,bots}=fixture(t);bots.save('bots',{id:'bot-chatroom',roleId:'chatroom',name:'Host',status:'active'});
 const origin=service.createRoom({members:['user','a']}),room=service.createRoom({kind:'deep',members:['user','a','b'],goal:'Compare actual evidence',rounds:2,originRoomId:origin.id});
 const kickoff=service.jobs(room.id).find(job=>job.botId==='bot-chatroom');
 const first=service.post(room.id,{content:'@a @b provide evidence',notify:true},'bot-chatroom');
 const participants=service.jobs(room.id).filter(job=>job.messageId===first.id);assert.equal(participants.length,2);
 await service.deliver(participants[0]);assert.equal(service.jobs(room.id).filter(job=>job.botId==='bot-chatroom').length,1);
 await service.deliver(participants[1]);assert.equal(service.jobs(room.id).filter(job=>job.botId==='bot-chatroom').length,1);
 await service.deliver(kickoff);assert.equal(service.need('rooms',room.id).completedRounds,1);
 const nextHost=service.jobs(room.id).filter(job=>job.botId==='bot-chatroom').at(-1);
 const second=service.post(room.id,{content:'@a verify remaining uncertainty',toBotId:'a'},'bot-chatroom');
 assert.equal(second.hop,1);await service.deliver(service.jobs(room.id).find(job=>job.messageId===second.id));await service.deliver(nextHost);
 assert.equal(service.need('rooms',room.id).completedRounds,2);assert.throws(()=>service.post(room.id,{content:'@a another round',toBotId:'a'},'bot-chatroom'),/round limit/);
 const count=service.jobs(room.id).length;service.settleDiscussion(service.need('rooms',room.id));assert.equal(service.jobs(room.id).length,count);
 service.saveConclusion(room.id,{summary:'Only conclusions supported by the recorded replies'});
 assert.equal(service.messages(origin.id).filter(message=>message.id===`conclusion:${room.id}`).length,1);
 assert.equal(store.get('rooms',room.id).status,'concluded');
});
