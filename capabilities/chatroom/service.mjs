import { randomUUID } from 'node:crypto';
import { required,fail,pick,now } from '../shared/validation.mjs';
const TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
export class ChatroomService {
  constructor({store,manager,attachments,emit=()=>{}}) { Object.assign(this,{store,manager,attachments,emit});this.busy=false;this.closed=false; }
  seed() { if(!this.store.get('rooms','room-lobby'))this.createRoom({id:'room-lobby',name:'项目大群',kind:'group',members:['user','bot-engineer','bot-components','bot-qa']}); }
  need(kind,id) { const value=this.store.get(kind,id);if(!value)fail(`${kind} not found`,404);return value; }
  rooms() { return this.store.list('rooms').map(room=>({...room,lastMessage:this.messages(room.id).at(-1)||null})); }
  messages(id) { return this.store.list('messages').filter(message=>message.roomId===id); }
  jobs(id) { return this.store.list('deliveries').filter(item=>!id||item.roomId===id); }
  createRoom(input) {
    const members=[...new Set(input.members||[])],kind=input.kind||'group';if(!['group','dm','deep'].includes(kind)||!members.length)fail('Invalid room');
    if(kind==='deep'&&this.manager.store.get('bots','bot-chatroom')?.status==='active'&&!members.includes('bot-chatroom'))members.push('bot-chatroom');
    for(const id of members)if(id!=='user'&&!id.startsWith('executor:'))this.manager.get(id);
    if(kind==='dm'){if(members.length!==2)fail('DM requires two participants');const existing=this.store.list('rooms').find(room=>room.kind==='dm'&&room.members.length===2&&members.every(id=>room.members.includes(id)));if(existing)return existing;}
    const room=this.store.save('rooms',{...pick(input,['id','originRoomId','originMessageId']),name:input.name||members.join(' ↔ '),kind,members,status:'active',goal:input.goal||'',rounds:Math.max(1,Math.min(5,Number(input.rounds)||2)),summary:''});this.emit('room',room);
    if(kind==='deep'&&room.goal)this.post(room.id,{content:room.goal,toBotId:members.includes('bot-chatroom')?'bot-chatroom':members.find(id=>id!=='user'),kind:'event'},'system');return room;
  }
  updateRoom(id,input) { const room=this.need('rooms',id);if(input.members&&room.kind==='dm')fail('DM participants are fixed');if(room.kind==='deep'&&(input.members||input.goal!==undefined)&&(room.status==='concluded'||this.jobs(id).some(job=>!TERMINAL.has(job.status))))fail('Active or concluded discussion evidence cannot be rewritten',409);if(input.members)for(const member of input.members)if(member!=='user')this.manager.get(member);const updated=this.store.save('rooms',{...room,...pick(input,['name','goal','members','rounds'])});this.emit('room',updated);return updated; }
  mentions(content,members) {if(/(?:^|\s)@(?:all|everyone|所有人)(?=\s|$|[，。！？:：])/i.test(content))return members;return members.filter(id=>{const bot=this.manager.get(id);return [id,bot.name].some(name=>new RegExp(`(?:^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|[\\s，。！？:：,!?])`,'i').test(content));});}
  append(roomId,input,senderId) {
    const room=this.need('rooms',roomId);if(!room.members.includes(senderId)&&!['system'].includes(senderId))fail('Sender is not a room member',403);
    if(input.id&&this.store.get('messages',input.id))return this.store.get('messages',input.id);
    if(input.clientId){const existing=this.messages(roomId).find(item=>item.clientId===input.clientId&&item.senderId===senderId);if(existing)return existing;}
    const attachments=this.attachments.resolve(input.attachments),content=String(input.content||'').trim();if(!content&&!attachments.length)fail('Message cannot be empty');if(content.length>16000)fail('Message is too long');
    const id=input.id||randomUUID(),message=this.store.save('messages',{...pick(input,['replyTo','clientId','toBotId','eventType','routineId','workId','jobId','usage','model','returnTo','peerReplyId','discussionBatch']),id,roomId,senderId,content,attachments,kind:input.kind||'message',rootId:input.rootId||id,hop:Math.max(0,Number(input.hop)||0)});this.emit('message',message);return message;
  }
  post(roomId,input,senderId='user') {
    const room=this.need('rooms',roomId);if(room.status==='concluded')fail('Discussion has concluded',409);
    if(!['user','system'].includes(senderId)){
      const active=this.jobs(roomId).filter(job=>job.botId===senderId&&!TERMINAL.has(job.status)).at(-1);
      const origin=active&&this.store.get('messages',active.messageId);
      if(origin)input={...input,rootId:origin.rootId,hop:Math.max(Number(input.hop)||0,origin.hop+1),discussionBatch:senderId==='bot-chatroom'?active.id:origin.discussionBatch};
      if(room.kind==='deep'&&senderId==='bot-chatroom'&&(room.completedRounds||0)>=room.rounds)fail('Discussion round limit reached; save an evidence-based conclusion with chatroom_conclude',409);
    }
    if(input.toBotId&&!room.members.includes(input.toBotId))fail('Target is not a member');
    const message=this.append(roomId,input,senderId);if(message.hop>=4)return message;
    const active=room.members.filter(id=>id!==senderId&&this.manager.store.get('bots',id)?.status==='active');
    const mentions=this.mentions(message.content,active),selected=input.toBotId?active.filter(id=>id===input.toBotId):mentions.length?mentions:senderId==='user'||room.kind==='dm'||input.notify?active:[];
    for(const botId of selected)this.enqueue(message,botId);void this.tick();return message;
  }
  enqueue(message,botId,extra={}) {const id=extra.id||`delivery:${message.id}:${botId}`;if(this.store.get('deliveries',id))return this.store.get('deliveries',id);const item=this.store.save('deliveries',{id,botId,roomId:message.roomId,messageId:message.id,status:'queued',rootId:message.rootId,hop:message.hop,routineId:message.routineId,discussionBatch:message.discussionBatch,...extra});this.emit('job',item);return item;}
  async tick() {
    if(this.busy||this.closed)return;this.busy=true;
    try{await Promise.allSettled(this.jobs().filter(item=>!TERMINAL.has(item.status)).map(item=>this.deliver(item)));}finally{this.busy=false;}
  }
  async deliver(item) {
    try {
      if(item.status==='queued'){
        const room=this.need('rooms',item.roomId),trigger=this.need('messages',item.messageId),config=await this.manager.config(item.botId);
        const context=await this.attachments.stageContext({messages:this.messages(room.id).slice(-30),trigger},config.workspace);
        const receipt=await this.manager.send(item.botId,{id:item.id,kind:'request',sessionId:`room:${room.id}`,correlationId:trigger.rootId,replyTo:trigger.id,content:{text:item.instruction||'回应触发消息；以实际工具和证据为依据，无新增贡献时仅回复 PASS。',room:pick(room,['id','name','kind','goal','members']),...context,...(item.peerAnswer?{peerAnswer:item.peerAnswer}:{}),metadata:{actor:trigger.senderId,roomId:room.id,deliveryId:item.id}}});
        item=this.store.save('deliveries',{...item,status:'accepted',taskId:receipt.taskId,startedAt:now()});this.emit('job',item);
      }
      if(!item.taskId)return;
      const task=await this.manager.request(item.botId,`/tasks/${encodeURIComponent(item.taskId)}`);
      const status=task.status;if(!TERMINAL.has(status)){if(item.status!==status){this.store.save('deliveries',{...item,status});this.emit('job',{...item,status});}return;}
      if(status==='completed') {
        let text=String(task.result?.content||''),passed=/^PASS\s*$/i.test(text);try{const parsed=JSON.parse(text);if(typeof parsed.reply==='string'){text=parsed.reply;passed=parsed.pass||!text;}}catch{}
        if(text&&!passed){const reply=this.append(item.roomId,{id:`reply:${item.id}`,content:text.slice(0,16000),replyTo:item.messageId,rootId:item.rootId,hop:item.hop+1,jobId:item.id,usage:task.result?.usage,model:task.result?.model},item.botId);this.returnReply(reply);}
      } else this.append(item.roomId,{id:`error:${item.id}`,content:`任务${status}：${task.error?.message||task.error||'执行未完成'}`,kind:'error',jobId:item.id,hop:4},'system');
      const result=this.store.save('deliveries',{...item,status,finishedAt:now(),agentRunId:item.taskId,error:task.error||null});this.emit('job',result);
      if(item.routineId)this.manager.store.save('routines',{id:item.routineId,lastStatus:status});
      const room=this.need('rooms',item.roomId);
      if(room.kind==='deep'&&room.status!=='concluded'&&room.members.includes('bot-chatroom'))this.settleDiscussion(room);
    }catch(error){const attempts=(item.attempts||0)+1;const result=this.store.save('deliveries',{...item,attempts,error:error.message,...(attempts>=3?{status:'interrupted',finishedAt:now()}:{})});this.emit('job',result);}
  }
  settleDiscussion(room) {
    const jobs=this.jobs(room.id),batches=[...new Set(jobs.filter(job=>job.botId!=='bot-chatroom').map(job=>job.discussionBatch||job.messageId))];
    for(const batch of batches){
      if(this.store.get('messages',`discussion-results:${batch}`))continue;
      const host=jobs.find(job=>job.id===batch),participants=jobs.filter(job=>job.botId!=='bot-chatroom'&&(job.discussionBatch||job.messageId)===batch);
      if(host&&!TERMINAL.has(host.status)||!participants.length||participants.some(job=>!TERMINAL.has(job.status)))continue;
      room=this.store.save('rooms',{...room,completedRounds:(room.completedRounds||0)+1});
      const last=room.completedRounds>=room.rounds;
      const message=this.append(room.id,{id:`discussion-results:${batch}`,content:`第 ${room.completedRounds}/${room.rounds} 轮参与者任务已结束。请查看实际发言和失败项，${last?'已达到轮数上限，调用 chatroom_conclude 保存有依据的结论。':'决定继续提问或调用 chatroom_conclude 保存有依据的结论。'}`,kind:'event',rootId:room.id,hop:0},'system');
      this.enqueue(message,'bot-chatroom');
    }
  }
  returnReply(reply) {
    const request=this.store.get('messages',reply.replyTo),route=request?.returnTo;if(!route||request.toBotId!==reply.senderId||reply.hop>=4)return;
    const origin=this.store.get('messages',route.messageId),room=this.store.get('rooms',route.roomId);if(!origin||!room||room.status==='concluded'||!room.members.includes(route.botId))return;
    this.enqueue(origin,route.botId,{id:`dm-return:${reply.id}`,peerAnswer:{request:request.content,answer:reply.content,senderId:reply.senderId},instruction:'同伴已回复。根据 peerAnswer 向原请求方转达实际答案，不再次询问或只道谢。',hop:reply.hop});
  }
  dm(actor,input) {
    if(actor===input.targetBotId)fail('Cannot DM self');
    const origin=input.originMessageId&&this.store.get('messages',input.originMessageId);
    if(input.originMessageId&&(!origin||origin.roomId!==input.originRoomId||!this.need('rooms',origin.roomId).members.includes(actor)))fail('Invalid originating conversation');
    if(origin&&origin.hop+1>=4)fail('Automatic collaboration hop limit reached',409);
    const room=this.createRoom({kind:'dm',members:[actor,input.targetBotId]});
    return this.post(room.id,{...input,content:required(input.message||input.content),toBotId:input.targetBotId,rootId:origin?.rootId,hop:origin?origin.hop+1:0,...(origin?{returnTo:{roomId:origin.roomId,messageId:origin.id,botId:actor}}:{})},actor);
  }
  conclude(roomId,actor='user') {const room=this.need('rooms',roomId);if(room.kind!=='deep')fail('Not a discussion room');if(room.status==='concluded')return room;const host=room.members.find(id=>this.manager.store.get('bots',id)?.roleId==='chatroom')||room.members.find(id=>id!=='user');const message=this.append(room.id,{content:'请根据实际讨论与证据形成结论，并调用 chatroom_conclude 保存结论。',kind:'event',toBotId:host},'system');return this.enqueue(message,host);}
  saveConclusion(roomId,input) {const room=this.need('rooms',roomId);if(room.status==='concluded')return room;const record=this.store.save('rooms',{...room,status:'concluded',summary:required(input.summary,'summary'),concludedAt:now()});this.emit('room',record);if(room.originRoomId&&this.store.get('rooms',room.originRoomId))this.append(room.originRoomId,{id:`conclusion:${room.id}`,content:`讨论「${room.name}」结论：\n${record.summary}`,kind:'event',hop:4},'system');return record;}
  retry(id) {const item=this.need('deliveries',id);if(!TERMINAL.has(item.status)||item.status==='completed')fail('Only interrupted/failed work can be explicitly retried');const room=this.need('rooms',item.roomId);if(room.status==='concluded')fail('Discussion has concluded',409);if(!item.taskId)return this.store.save('deliveries',{...item,status:'queued',attempts:0,error:null});const trigger=this.need('messages',item.messageId);return this.enqueue(trigger,item.botId,{id:`retry:${randomUUID()}`,retryOf:id});}
  start() {this.closed=false;this.timer=setInterval(()=>void this.tick(),750);this.timer.unref();void this.tick();}
  async close() {this.closed=true;clearInterval(this.timer);while(this.busy)await new Promise(done=>setTimeout(done,20));}
}
