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
import { DesktopCodex } from '../codex/desktop.mjs';
import { createFileTools, MAX_FILE_REQUEST_BYTES } from '../filesystem/tools.mjs';
import { createRedactor } from '../../bot/src/runtime/config.mjs';
import { acceptedWorkTask, workExecution } from '../../bot/src/context/sources.mjs';
import { executorManifestOperation, readExecutorManifest } from '../../bot/src/runtime/executor-delivery.mjs';
import { toolDefinitions, FILE_TOOLS } from '../gateway/tools.mjs';
import { fail } from '../shared/validation.mjs';

export const BUILTIN_CAPABILITIES = ['bot-management', 'chatroom', 'knowledge', 'memory-management', 'codex', 'filesystem'];
export function capabilityForTool(name) {
  if (FILE_TOOLS.has(name)) return 'filesystem';
  if (name.startsWith('chatroom_')) return 'chatroom';
  if (name.startsWith('knowledge_')) return 'knowledge';
  if (name.startsWith('codex_')) return 'codex';
  if (name.startsWith('bots_') || name.startsWith('reminders_') || name === 'routines_create') return 'bot-management';
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
  if (id !== 'bot-management') for (const method of ['create','update','start','stop','send','saveRoutine','restore','monitor','quiesce','shutdownAll','pauseProject','ensureCatalogMaintainer','setCatalogMaintainerState']) manager[method] = (...args) => remote('bot-management',method,args);
  const ownRoot = join(dataRoot,'capabilities',id); await mkdir(ownRoot,{recursive:true});
  const mutations = new WorkspaceExecutionLock(ownRoot);
  const locked = operation => mutations.withLock(`${id}@${version}`,operation);
  const attachments = id === 'chatroom' ? new AttachmentStore(ownRoot) : null;
  const chatroom = id === 'chatroom' ? new ChatroomService({store:store(id),manager,attachments,emit,version,invoke:remote}) : null;
  const knowledge = id === 'knowledge' ? new KnowledgeService({store:store(id),emit}) : null;
  const memories = id === 'memory-management' ? new MemoryManagement({store:store(id),manager,dataRoot,emit}) : null;
  const workspaceLocks = new Map();
  const lockFor = cwd => { const key=resolve(cwd);if(!workspaceLocks.has(key))workspaceLocks.set(key,new WorkspaceExecutionLock(key));return workspaceLocks.get(key); };
  let codex;
  if (id === 'codex') {
    codex = new DesktopCodex({store:store(id),dataRoot,manager,emit,version});
    if(!options.deferStart)await codex.start();
  }
  if (chatroom) {
    store(id).transaction(()=>{for(const job of chatroom.jobs())if(!job.serviceVersion)store(id).save('deliveries',{id:job.id,serviceVersion:version});});
    const tick=chatroom.tick.bind(chatroom);chatroom.tick=()=>locked(tick);
    if(options.deferStart)chatroom.closed=true;else chatroom.start();
  }
  const assertOwner=(actor,botId)=>{if(actor!=='controller'&&actor!==botId)fail('This Bot cannot access another Bot private data',403);};
  const tools=toolDefinitions.filter(tool=>capabilityForTool(tool.name)===id);
  async function invoke(name,args={},context={},signal) {
    const actor=context.actor;
    if(!actor)fail('Authenticated actor context is required',403);
    if(actor!=='controller'&&!(manager.store.get('bots',actor)?.allowedTools||[]).includes(name))fail('Tool not authorized for this Bot',403);
    if(FILE_TOOLS.has(name)) {
      if(actor==='controller')fail('Filesystem tools require an explicit Bot identity');
      const config=await manager.config(actor),artifacts=[];
      const definitions=createFileTools({workspace:config.workspace,projectRoot:config.workspace,protectedRoot:dataRoot,accessPolicy:context.fileAccessPolicy,redact:createRedactor(config),containProcesses:context.workId?.startsWith('onboarding-')===true,tempRoot:join(manager.directory(actor),'tmp','capability-tools'),onArtifacts:items=>artifacts.push(...items),withExecution:(fn,toolSignal)=>lockFor(defaultCwd).withLock(`bot:${actor}`,fn,toolSignal),saveArtifact:async input=>(await manager.botApi()).saveArtifact(join(manager.directory(actor),'artifacts'),input),
        publishFile:(input,file)=>locked(async ()=>{
          const workId=context.workId||(context.mode==='chat'?args.workId:null);
          if(!workId||!context.taskId)fail('File publication requires an authorized work ID',403);
          const frontend=context.mode==='chat',source=context.source;
          const {work,operation,nativeResult}=await manager.readState(actor,db=>{
            const work=db?.getRecord('works',workId),task=db?.getTask(context.taskId);
            const form=context.mode==='work'&&source?.formId===workId;
            if(!work||task?.status!=='running'||task.cancelRequested||!source?.roomId||!(source.replyTo||form)||!work.sources?.some(item=>item.roomId===source.roomId))
              fail('The authorized publication source is unavailable',403);
            if(frontend){
              const route=db.getRecord('request-routing',task.id),operation=args.operationId&&db.getRecord('work-events',args.operationId);
              if(!['deliver','produce','revise'].includes(route?.intent)||route.messageId!==source.replyTo||route.roomId!==source.roomId||
                operation?.workId!==work.id||!acceptedWorkTask(operation,db)||operation.authorization?.source?.roomId!==source.roomId)
                fail('Select existing delivery and its exact same-room work and operation from work_outputs',403);
              return {work,operation};
            }
            if(['paused','cancelled'].includes(work.status))fail('The work has stopped; no new upload was submitted',409);
            const execution=workExecution(task,db);
            const binding=task.metadata?.sourceType==='external'&&work.bindings?.find(item=>item.id===task.metadata.externalBindingId);
            const manifestOperation=binding&&executorManifestOperation(db,work,binding,task.input,source);
            const operation=manifestOperation||
              (execution.executionEventId&&db.getRecord('work-events',execution.executionEventId));
            return {work,operation:operation?.workId===work.id?operation:null,nativeResult:task.input?.type==='external_status'&&Boolean(manifestOperation)};
          });
          const publications=store('filesystem');
          const sameResource=item=>item.botId===actor&&item.roomId===source.roomId&&item.file?.path===file.path;
          const records=publications.list('file-publications').filter(sameResource);
          const reconcile=async item=>{
            const receipt=await remote('chatroom','publication',[item.id]);
            const origin=receipt.attachment?.origin;
            if(receipt.status!=='published'||receipt.attachment.id!==item.id||origin?.publicationId!==item.id||
              origin.botId!==item.botId||origin.roomId!==item.roomId||origin.workId!==item.workId)
              fail(`Publication ${item.id} is still unconfirmed; do not resubmit this file with another task, name or operation`,409);
            return publications.save('file-publications',{id:item.id,status:'published',attachment:receipt.attachment,reconciledAt:new Date().toISOString()});
          };
          for(const [index,item] of records.entries())if(['publishing','unknown'].includes(item.status))records[index]=await reconcile(item);
          const sameVersion=item=>['size','mtimeMs','ctimeMs'].every(key=>item.file[key]===file[key]);
          const exact=item=>item.workId===work.id&&operation?.id&&item.operationId===operation.id;
          let publication=frontend?records.findLast(exact):nativeResult?records.findLast(item=>exact(item)&&sameVersion(item)):null;
          publication||=records.findLast(item=>item.workId===work.id&&sameVersion(item)&&
            (frontend||nativeResult?(!item.operationId||exact(item)):item.name===input.name&&item.mimeType===(input.mimeType||null)));
          if(publication)return {...(await reconcile(publication)).attachment,publication:'existing-upload'};
          if(frontend&&operation.resultFile){
            const manifest=await readExecutorManifest({workspace:config.workspace,workId:work.id,operation}).catch(error=>{
              if(error.code!=='ENOENT'||!work.bindings?.some(binding=>binding.type==='codex-desktop'&&
                [binding.operationId,binding.executionOperationId].includes(operation.id)))throw error;
              return null;
            });
            if(manifest&&(!manifest.artifacts.some(artifact=>artifact.path===file.path)||file.mtimeMs>manifest.writtenAt||file.ctimeMs>manifest.writtenAt))
              fail('This path is not the unchanged output of the selected operation. Use its confirmed attachment or report the missing original.',409);
          }
          signal?.throwIfAborted();
          publication=publications.save('file-publications',{id:randomUUID(),botId:actor,workId:work.id,roomId:source.roomId,
            sourceTaskId:context.taskId,operationId:operation?.id||null,file,name:input.name,mimeType:input.mimeType||null,status:'publishing'});
          try{
            const attachment=await remote('chatroom','publishFile',[input,{type:'work-output',publicationId:publication.id,botId:actor,workId:work.id,
              operationId:operation?.id,taskId:context.taskId,roomId:source.roomId,sourceMessageId:source.replyTo}]);
            publications.save('file-publications',{id:publication.id,status:'published',attachment});return {...attachment,publication:'uploaded'};
          }catch(error){
            publications.save('file-publications',{id:publication.id,status:'unknown',error:error.message});
            try{return {...(await reconcile(publication)).attachment,publication:'reconciled-upload'};}catch{}
            throw Object.assign(new Error(`Publication ${publication.id} outcome is unknown; query this identity before any further upload`),{code:'PUBLICATION_OUTCOME_UNKNOWN',outcomeUnknown:true});
          }
        })});
      const result=await definitions.find(tool=>tool.name===name).execute(randomUUID(),args,signal);
      return {...result,artifacts,isError:Boolean(result.details?.timedOut||result.details?.aborted||(result.details?.exitCode!==undefined&&result.details.exitCode!==0))};
    }
    switch(name) {
      case 'chatroom_list':{
        const sourceActor=context.source?.accessActor||context.source?.actor;
        const rooms=args.roomId?[chatroom.store.get('rooms',args.roomId)].filter(Boolean):chatroom.rooms();
        return rooms.filter(room=>actor==='controller'||room.members.includes(actor)&&(!sourceActor||sourceActor==='system'||room.members.includes(sourceActor)));
      }
      case 'chatroom_read':{
        const page=chatroom.read(args,actor,context.source);
        return actor==='controller'||args.outputReceipts!==undefined||context.source?.metadata?.groupObservation?page:attachments.stageContext(page,(await manager.config(actor)).workspace);
      }
      case 'chatroom_create':return chatroom.createRoom({...args,members:[...new Set([...(args.members||[]),...(actor==='controller'?[]:[actor])])]});
      case 'chatroom_team_read':return chatroom.teamRead(args,actor);
      case 'chatroom_team_raise':return chatroom.teamRaise(args,actor);
      case 'chatroom_team_manage':return chatroom.teamManage(args,actor);
      case 'chatroom_send':{
        if(actor!=='controller')for(const item of args.attachments||[]){
          const attachment=attachments.get(item.id),origin=attachment.origin;
          if(origin?.type==='work-output'){
            if(origin.botId!==actor||origin.roomId!==args.roomId||context.source?.roomId!==args.roomId)
              fail('This published file belongs to another Bot or room',403);
            const workId=context.workId||(context.mode==='chat'?args.workId:null);
            const authorized=workId===origin.workId&&await manager.readState(actor,db=>{
              const work=db?.getRecord('works',origin.workId);
              return Boolean(work?.sources?.some(source=>source.roomId===args.roomId));
            });
            if(!authorized)fail('This published file requires its authorized original work',403);
            const form=context.mode==='work'&&context.source.formId===workId;
            if(!(context.source.replyTo||form)||args.replyTo&&args.replyTo!==context.source.replyTo)
              fail('This published file must return to the current authorized source message',403);
            args={...args,replyTo:context.source.replyTo};
          }
        }
        return chatroom.post(args.roomId,args,actor==='controller'?'user':actor,{sourceMessageId:context.source?.replyTo,deliveryId:context.source?.input?.metadata?.deliveryId});
      }
      case 'chatroom_dm':return chatroom.dm(actor,args);
      case 'chatroom_conclude':{const room=chatroom.need('rooms',args.roomId);if(actor!=='controller'&&!room.members.includes(actor))fail('Not a room member',403);return chatroom.saveConclusion(args.roomId,args);}
      case 'knowledge_search':return knowledge.search(args.query);
      case 'knowledge_save_node':return knowledge.saveNode(args);
      case 'knowledge_save_edge':return knowledge.saveEdge(args);
      case 'bots_list':{
        const sharedRooms=new Set(store('chatroom').list('rooms').filter(room=>actor==='controller'||room.members.includes(actor)).map(room=>room.id));
        return Promise.all(manager.list().map(async bot=>{
          const works=await manager.readState(bot.id,db=>db?.listRecords('works')||[]);
          const responsibilities=works.filter(work=>!['completed','cancelled'].includes(work.status)).flatMap(work=>{
            const shared=actor==='controller'||actor===bot.id||work.sources?.some(source=>sharedRooms.has(source.roomId));
            if(!shared&&!work.responsibility)return [];
            return [{workId:work.id,status:work.status,responsibility:work.responsibility||null,...(shared?{goal:work.goal}:{}),sourceCount:shared?work.sources?.length||0:undefined}];
          });
          return {...bot,responsibilities:responsibilities.slice(-20),responsibilityCount:responsibilities.length,resources:{skills:bot.skills||[],knowledge:'Owned Markdown is read by the responsible Bot; ask it for relevant sourced information.'}};
        }));
      }
      case 'bots_create':return manager.create(args);
      case 'bots_start':return manager.start(args.botId);
      case 'bots_stop':return manager.stop(args.botId);
      case 'bots_cleanup':return cleanTemporaryData(manager,args.botId,{externalTasks:()=>store('codex').list('works')});
      case 'routines_create':{const previous=args.id&&manager.store.get('routines',args.id);if(previous)assertOwner(actor,previous.botId);const botId=args.botId||previous?.botId||actor;assertOwner(actor,botId);return manager.saveRoutine({...args,botId});}
      case 'reminders_create':return manager.saveReminder(args,actor,context.source);
      case 'reminders_list':return manager.store.list('reminders').filter(item=>item.botId===actor&&item.roomId===context.source?.roomId);
      case 'reminders_cancel':return manager.cancelReminder(args.id,actor,context.source);
      case 'codex_projects':return codex.projects(signal,context.codexScope,actor);
      case 'codex_threads':return codex.threads(signal,context.codexScope,actor);
      case 'codex_create':case 'codex_attach':{
        codex.assertScope(actor,args.workId||context.workId,context.codexScope);
        if(name==='codex_attach'&&actor!=='controller'&&!context.codexScope.threadGrants.includes(args.threadId))
          fail('Attaching an existing chat requires its exact ID in the authenticated user request. Global chat discovery is not authorization.',403);
        return codex[name==='codex_create'?'create':'attach']({...args,botId:actor},signal);
      }
      case 'codex_status':{codex.assertScope(actor,args.workId,context.codexScope);const id=codex.bindingId(actor,args.workId),work=codex.require(id);assertOwner(actor,work.botId);return codex.get(id);}
      case 'codex_read':case 'codex_send':case 'codex_interrupt':{
        codex.assertScope(actor,args.workId||context.workId,context.codexScope);
        if(name==='codex_interrupt'&&context.stopId&&context.workId===args.workId)
          return codex.stopWork(actor,args.workId,context.stopId);
        const id=codex.bindingId(actor,args.workId||context.workId),work=codex.require(id);assertOwner(actor,work.botId);
        return codex[{codex_read:'read',codex_send:'send',codex_interrupt:'interrupt'}[name]](id,
          {...args,verification:context.codexVerification,cardResume:context.cardResume,signal});
      }
      default:fail('Unknown capability tool',404);
    }
  }
  const operations={};
  const expose=(target,names)=>{for(const name of names)operations[name]=(...args)=>locked(()=>target[name](...args));};
  if(id==='bot-management')expose(manager,['create','update','start','stop','send','saveRoutine','claimReminder','settleReminder','seed','restore','monitor','quiesce','shutdownAll','connect','pauseProject','ensureCatalogMaintainer','setCatalogMaintainerState']);
  if(chatroom){
    expose(chatroom,['createRoom','updateRoom','post','append','messageReceipt','dm','conclude','saveConclusion','retry','seed','teamRead','teamRaise','teamManage']);operations.upload=(...args)=>locked(()=>attachments.upload(...args));
    operations.publishFile=(input,origin)=>locked(()=>attachments.upload(input,origin));
    operations.publication=id=>locked(()=>attachments.publication(id));
    operations.pause=async()=>{await chatroom.close();return {paused:true};};
    operations.resumeService=()=>{if(chatroom.closed)chatroom.start();return {ready:true};};
  }
  if(knowledge)expose(knowledge,['saveNode','saveEdge']);
  if(memories)expose(memories,['write']);
  if(codex){
    expose(codex,['create','attach','send','interrupt','read','stopWork']);
    operations.pause=async()=>{await codex.stop();return {paused:true};};
    operations.resumeService=async()=>{await codex.start();return {ready:true};};
  }
  if(id==='bot-management')operations.resumeService=()=>{manager.quiescing=false;return {ready:true};};
  return {tools,stateVersion:'1',operations,...(chatroom?{maxRequestBytes:MAX_ATTACHMENT_REQUEST_BYTES}:
    id==='filesystem'?{maxRequestBytes:MAX_FILE_REQUEST_BYTES}:{}),
    callTool:(name,args,context,signal)=>id==='filesystem'?invoke(name,args,context,signal):locked(()=>invoke(name,args,context,signal)),
    pendingWork:()=>chatroom?(chatroom.closed?0:Math.max(Number(chatroom.busy),chatroom.jobs().filter(job=>job.serviceVersion===version&&unfinished(job)).length)):codex?Number(Boolean(codex.active)):0,
    close:async()=>{await chatroom?.close();await codex?.stop();for(const db of stores.values())db.close();}
  };
}
