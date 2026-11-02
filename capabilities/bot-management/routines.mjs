import { now, pick } from '../shared/validation.mjs';
const terminal=new Set(['completed','failed','cancelled','interrupted']);
const passiveWork=new Set(['paused','cancelled','completed','archived']);

/** Existing gateway timer calls this; observations and in-flight ownership stay in its current databases. */
export async function tickRoutines({manager,chatroom}) {
  const due=manager.store.list('routines').filter(item=>item.enabled&&Date.parse(item.nextRunAt)<=Date.now());
  for(const snapshot of due){
    const routine=manager.store.get('routines',snapshot.id);
    if(!routine?.enabled)continue;
    const nextRunAt=new Date(Date.now()+routine.intervalSeconds*1000).toISOString();
    try{
      const owner=manager.get(routine.botId);
      if(owner.status!=='active'||owner.runIntent==='stopped'){await manager.saveRoutine({id:routine.id,nextRunAt,lastStatus:'paused'});continue;}
      const deliveries=chatroom.jobs().filter(job=>job.routineId===routine.id),inflight=deliveries.find(job=>!terminal.has(job.status));
      if(inflight){await manager.saveRoutine({id:routine.id,nextRunAt,pendingAt:routine.pendingAt||routine.nextRunAt,pendingCount:(routine.pendingCount||0)+1,lastStatus:'coalesced',lastDeliveryId:inflight.id});continue;}
      // Foreground work is dispatched first; don't occupy execution slots just to check a routine.
      if(chatroom.jobs().some(job=>job.botId===routine.botId&&job.priority!=='background'&&!terminal.has(job.status))){await manager.saveRoutine({id:routine.id,nextRunAt,pendingAt:routine.pendingAt||routine.nextRunAt,lastStatus:'deferred'});continue;}
      let work=routine.workId?await manager.readState(routine.botId,db=>db?.getRecord('works',routine.workId)):null;
      if(work&&(passiveWork.has(work.status)||work.status==='waiting'&&!routine.watch)){await manager.saveRoutine({id:routine.id,nextRunAt,lastStatus:work.status});continue;}
      let observation;
      if(routine.watch){
        const watch=routine.watch;
        if(watch.kind==='work'){
          const value=await manager.readState(routine.botId,db=>db?.getRecord('works',watch.workId));
          observation=value?pick(value,['id','goal','requirements','status','progress','waiting','bindings','result']):{id:watch.workId,status:'unknown'};
        }else if(watch.kind==='task'){
          const value=await manager.readState(routine.botId,db=>db?.getTask(watch.taskId));
          observation=value?pick(value,['id','status','result','error']):{id:watch.taskId,status:'unknown'};
        }else{
          const room=chatroom.need('rooms',watch.roomId);
          if(!room.members.includes(routine.botId))throw new Error('Routine cannot observe a room its owner has not joined');
          const ownJobs=new Set(deliveries.map(job=>job.id));
          const latest=chatroom.messages(watch.roomId).filter(message=>!message.routineId&&message.senderId!==routine.botId&&!ownJobs.has(message.jobId)).at(-1);
          observation={roomId:watch.roomId,messageId:latest?.id||null};
        }
        if(JSON.stringify(observation)===JSON.stringify(routine.lastObservation)){
          await manager.saveRoutine({id:routine.id,nextRunAt,lastObservedAt:now(),lastStatus:'unchanged',pendingAt:null,pendingCount:0});continue;
        }
      }
      const eventId=`routine:${routine.id}:${routine.pendingAt||routine.nextRunAt}`;
      // The room receives a pointer, not a private task result or another work's requirements.
      const observationText=observation?`\n真实来源已有变化：${JSON.stringify(pick(observation,['id','status','roomId','messageId']))}；用该来源 ID 按需读取实际内容。`:'';
      const message=await chatroom.post(routine.roomId||'room-lobby',{
        content:`定时职责「${routine.name}」：${routine.instruction}${observationText}\n沿原 work 继续；无实质变化时保持安静。不重新提交结果未知的操作。`,
        toBotId:routine.botId,clientId:eventId,kind:'event',routineId:routine.id,workId:routine.workId,priority:'background',purpose:'request',
        sourceRefs:[{type:'routine',id:routine.id,eventId,watch:routine.watch||null}],
      },'system');
      await manager.saveRoutine({id:routine.id,lastRunAt:now(),lastStatus:'queued',lastEventId:eventId,lastDeliveryId:`delivery:${message.id}:${routine.botId}`,nextRunAt,lastObservation:observation,lastObservedAt:observation?now():routine.lastObservedAt,pendingAt:null,pendingCount:0,error:null});
    }catch(error){
      await manager.saveRoutine({id:routine.id,lastStatus:'failed',error:error.message,nextRunAt});
      if(routine.lastErrorNotified!==error.message){
        await chatroom.append(routine.roomId||'room-lobby',{id:`routine-error:${routine.id}:${routine.nextRunAt}`,content:`职责「${routine.name}」暂未投递：${error.message}`,kind:'error',routineId:routine.id},'system');
        await manager.saveRoutine({id:routine.id,lastErrorNotified:error.message});
      }
    }
  }
}
