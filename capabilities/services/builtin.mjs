import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RecordStore } from '../shared/store.mjs';
import { WorkspaceExecutionLock } from '../shared/workspace-lock.mjs';
import { BotManager } from '../bot-management/service.mjs';
import { cleanTemporaryData } from '../bot-management/maintenance.mjs';
import { ChatroomService } from '../chatroom/service.mjs';
import { AttachmentStore,MAX_ATTACHMENT_REQUEST_BYTES } from '../chatroom/attachments.mjs';
import { KnowledgeService } from '../knowledge/service.mjs';
import { MemoryManagement } from '../memory-management/service.mjs';
import { CodexExecutor } from '../codex/executor.mjs';
import { createFileTools } from '../filesystem/tools.mjs';
import { toolDefinitions, FILE_TOOLS } from '../gateway/tools.mjs';
import { fail, pick } from '../shared/validation.mjs';

export const BUILTIN_CAPABILITIES = ['bot-management', 'chatroom', 'knowledge', 'memory-management', 'codex', 'filesystem'];
export function capabilityForTool(name) {
  if (FILE_TOOLS.has(name)) return 'filesystem';
  if (name.startsWith('chatroom_')) return 'chatroom';
  if (name.startsWith('knowledge_')) return 'knowledge';
  if (name.startsWith('codex_')) return 'codex';
  if (['bots_deliver','bot_memory_read','memory_propose','memory_merge'].includes(name)) return 'memory-management';
  if (name.startsWith('bots_') || name === 'routines_create') return 'bot-management';
}
const unfinished = item => ['queued','accepted','running','waiting'].includes(item.status);

/** One domain in one independently supervised process. No gateway or model is started here. */
export async function createCapability(options) {
  const { id, version, dataRoot, releaseRoot, defaultCwd = releaseRoot } = options;
  if (!BUILTIN_CAPABILITIES.includes(id)) fail('Unknown builtin capability');
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new RecordStore(join(dataRoot,'capabilities',name,'state.sqlite'))); return stores.get(name); };
  const bridge = async (path, body, signal) => {
    const response = await fetch(`${options.gatewayUrl}/internal/service/${path}`, { method:'POST', headers:{'Content-Type':'application/json',Authorization:`Bearer ${options.gatewayToken}`}, body:JSON.stringify(body), signal:signal || AbortSignal.timeout(150000) });
    const result = await response.json(); if (!response.ok) fail(result.error?.message || result.error || 'Control plane unavailable', response.status); return result;
  };
  const emit = (type,payload) => { void bridge('event',{type,payload}).catch(()=>{}); };
  const manager = new BotManager({store:store('bot-management'),dataRoot,releaseRoot,defaultCwd,model:options.model,emit,
    gatewayUrl:()=>options.gatewayUrl,getTools:bot=>bridge('tools',{botId:bot.id})});
  const remote = (capability,operation,args) => bridge('invoke',{capability,operation,args});
  if (id !== 'bot-management') for (const method of ['create','update','start','stop','send','clone','archive','saveRoutine','restore','monitor','quiesce','shutdownAll']) manager[method] = (...args) => remote('bot-management',method,args);
  const ownRoot = join(dataRoot,'capabilities',id); await mkdir(ownRoot,{recursive:true});
  const mutations = new WorkspaceExecutionLock(ownRoot);
  const locked = operation => mutations.withLock(`${id}@${version}`,operation);
  const attachments = id === 'chatroom' ? new AttachmentStore(ownRoot) : null;
  const chatroom = id === 'chatroom' ? new ChatroomService({store:store(id),manager,attachments,emit,version}) : null;
  const knowledge = id === 'knowledge' ? new KnowledgeService({store:store(id),emit}) : null;
  const memories = id === 'memory-management' ? new MemoryManagement({store:store(id),manager,dataRoot,emit}) : null;
  const workspaceLocks = new Map();
  const lockFor = cwd => { const key=resolve(cwd);if(!workspaceLocks.has(key))workspaceLocks.set(key,new WorkspaceExecutionLock(key));return workspaceLocks.get(key); };
  let codex;
  if (id === 'codex') {
    codex = new CodexExecutor({store:store(id),emit,defaultCwd,codexPath:options.codexPath,version,
      executionLock:{acquire:(owner,signal)=>lockFor(codex.require(codex.active.id).cwd).acquire(owner,signal)},
      consult:async(work,question,targetId)=>{
        const botId=targetId||work.botId; if(!botId)fail('No consultation target');
        const receipt=await manager.send(botId,{id:`consult:${work.id}:${work.question?.requestId||randomUUID()}`,kind:'request',sessionId:`consult:${work.id}`,metadata:{toolPolicy:{allowedEffects:['read']}},content:{text:`只读项目事实咨询，不得调用写入、命令或创建新 Codex 工作。\n${question}`,work:pick(work,['id','goal','cwd','constraints']),metadata:{readOnlyConsult:true}}});
        for (;;) { if(codex.require(work.id).status!=='waiting')throw new Error('Consultation no longer pending');const task=await manager.request(botId,`/tasks/${receipt.taskId}`);if(task.status==='completed')return task.result?.content||'';if(['failed','cancelled','interrupted'].includes(task.status))throw new Error('Consultation failed');await new Promise(done=>setTimeout(done,400)); }
      },
      onResult:async work=>{if(work.roomId)await remote('chatroom','append',[work.roomId,{id:`work-result:${work.id}:${work.status}:${work.finishedAt||''}`,content:`工作「${work.goal}」：${work.status}\n${String(work.result?.content||work.summary||work.error||'').slice(0,15000)}`,kind:'work',workId:work.id,hop:4},work.botId||'system']);}
    });
    // Only the first service bootstrap adopts records from the pre-service layout.
    store(id).transaction(()=>{for(const work of codex.list())if(!work.serviceVersion)store(id).save('works',{id:work.id,serviceVersion:version});});
    if(!options.deferStart)await codex.start();
  }
  if (chatroom) {
    store(id).transaction(()=>{for(const job of chatroom.jobs())if(!job.serviceVersion)store(id).save('deliveries',{id:job.id,serviceVersion:version});});
    const tick=chatroom.tick.bind(chatroom);chatroom.tick=()=>locked(tick);
    if(options.deferStart)chatroom.closed=true;else chatroom.start();
  }
  const assertOwner=(actor,botId)=>{if(actor!=='controller'&&actor!==botId&&!['manager','memory'].includes(manager.get(actor).roleId))fail('This Bot cannot access another Bot private data',403);};
  const tools=toolDefinitions.filter(tool=>capabilityForTool(tool.name)===id);
  async function invoke(name,args={},context={},signal) {
    const actor=context.actor;
    if(!actor)fail('Authenticated actor context is required',403);
    if(actor!=='controller'&&!(manager.store.get('bots',actor)?.allowedTools||[]).includes(name))fail('Tool not authorized for this Bot',403);
    if(FILE_TOOLS.has(name)) {
      if(actor==='controller')fail('Filesystem tools require an explicit Bot identity');
      const config=await manager.config(actor),artifacts=[];
      const definitions=createFileTools({workspace:config.workspace,projectRoot:defaultCwd,protectedRoot:dataRoot,tempRoot:join(manager.directory(actor),'tmp','capability-tools'),onArtifacts:items=>artifacts.push(...items),withExecution:(fn,toolSignal)=>lockFor(defaultCwd).withLock(`bot:${actor}`,fn,toolSignal),saveArtifact:async input=>(await manager.botApi()).saveArtifact(join(manager.directory(actor),'artifacts'),input)});
      const result=await definitions.find(tool=>tool.name===name).execute(randomUUID(),args,signal);
      return {...result,artifacts,isError:Boolean(result.details?.timedOut||result.details?.aborted||(result.details?.exitCode!==undefined&&result.details.exitCode!==0))};
    }
    switch(name) {
      case 'chatroom_list':return chatroom.rooms().filter(room=>actor==='controller'||room.members.includes(actor));
      case 'chatroom_read':{const room=chatroom.need('rooms',args.roomId);if(actor!=='controller'&&!room.members.includes(actor))fail('Not a room member',403);return {room,messages:chatroom.messages(room.id),jobs:chatroom.jobs(room.id)};}
      case 'chatroom_create':return chatroom.createRoom({...args,members:[...new Set([...(args.members||[]),...(actor==='controller'?[]:[actor])])]});
      case 'chatroom_send':return chatroom.post(args.roomId,args,actor==='controller'?'user':actor);
      case 'chatroom_dm':return chatroom.dm(actor,args);
      case 'chatroom_conclude':{const room=chatroom.need('rooms',args.roomId);if(actor!=='controller'&&!room.members.includes(actor))fail('Not a room member',403);return chatroom.saveConclusion(args.roomId,args);}
      case 'knowledge_search':return knowledge.search(args.query);
      case 'knowledge_save_node':return knowledge.saveNode(args);
      case 'knowledge_save_edge':return knowledge.saveEdge(args);
      case 'bots_list':return manager.list();
      case 'bots_create':return manager.create(args);
      case 'bots_start':return manager.start(args.botId);
      case 'bots_stop':return manager.stop(args.botId);
      case 'bots_clone':{const parentId=args.parentId||actor;assertOwner(actor,parentId);return manager.clone({...args,parentId});}
      case 'bots_deliver':{assertOwner(actor,args.childId||actor);return memories.deliver({...args,childId:args.childId||actor});}
      case 'bots_recycle':return manager.archive(args.botId);
      case 'bots_cleanup':return cleanTemporaryData(manager,args.botId,{externalTasks:()=>store('codex').list('works')});
      case 'bot_memory_read':{const botId=args.botId||actor;assertOwner(actor,botId);return memories.list(botId);}
      case 'memory_propose':return memories.propose(args.deliveryId);
      case 'memory_merge':return memories.merge(args.deliveryId,args);
      case 'routines_create':{const previous=args.id&&manager.store.get('routines',args.id);if(previous)assertOwner(actor,previous.botId);const botId=args.botId||previous?.botId||actor;assertOwner(actor,botId);return manager.saveRoutine({...args,botId});}
      case 'codex_submit':return codex.create({...args,botId:actor,sourceActionId:args.requestId||null});
      case 'codex_status':{const work=codex.require(args.workId);assertOwner(actor,work.botId);return codex.get(args.workId);}
      case 'codex_cancel':case 'codex_resume':{const work=codex.require(args.workId);assertOwner(actor,work.botId);return codex[name==='codex_cancel'?'cancel':'resume'](args.workId,args);}
      default:fail('Unknown capability tool',404);
    }
  }
  const operations={};
  const expose=(target,names)=>{for(const name of names)operations[name]=(...args)=>locked(()=>target[name](...args));};
  if(id==='bot-management')expose(manager,['create','update','start','stop','send','clone','archive','saveRoutine','seed','restore','monitor','quiesce','shutdownAll','connect']);
  if(chatroom){
    expose(chatroom,['createRoom','updateRoom','post','append','dm','conclude','saveConclusion','retry','seed']);operations.upload=(...args)=>locked(()=>attachments.upload(...args));
    operations.pause=async()=>{await chatroom.close();for(const job of chatroom.jobs())if(job.serviceVersion===version&&unfinished(job))store(id).save('deliveries',{id:job.id,status:'interrupted',error:'Platform stopped before delivery completion was confirmed',finishedAt:new Date().toISOString()});return {paused:true};};
    operations.resumeService=()=>{if(chatroom.closed)chatroom.start();return {ready:true};};
  }
  if(knowledge)expose(knowledge,['saveNode','saveEdge']);
  if(memories)expose(memories,['write','deliver','propose','merge']);
  if(codex){
    expose(codex,['create','cancel','resume','answer']);
    operations.pause=async()=>{await codex.stop();for(const work of codex.list())if(work.serviceVersion===version&&unfinished(work))codex.save({...work,status:'interrupted',error:'Platform stopped before execution completion was confirmed'});return {paused:true};};
    operations.resumeService=async()=>{await codex.start();return {ready:true};};
  }
  if(id==='bot-management')operations.resumeService=()=>{manager.quiescing=false;return {ready:true};};
  return {tools,stateVersion:'1',operations,...(chatroom?{maxRequestBytes:MAX_ATTACHMENT_REQUEST_BYTES}:{}),
    callTool:(name,args,context,signal)=>id==='filesystem'?invoke(name,args,context,signal):locked(()=>invoke(name,args,context,signal)),
    pendingWork:()=>chatroom?Math.max(Number(chatroom.busy),chatroom.jobs().filter(job=>job.serviceVersion===version&&unfinished(job)).length):codex?Math.max(Number(Boolean(codex.active)),codex.list().filter(work=>work.serviceVersion===version&&unfinished(work)).length):0,
    close:async()=>{await chatroom?.close();await codex?.stop();for(const db of stores.values())db.close();}
  };
}
