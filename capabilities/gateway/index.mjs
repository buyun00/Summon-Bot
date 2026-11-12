import { createServer } from 'node:http';
import { randomBytes,timingSafeEqual,randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { isAbsolute,join,resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as pause } from 'node:timers/promises';
import { PushService } from './push.mjs';
import { RecordStore } from '../shared/store.mjs';
import { IncrementalSync, syncPages } from '../shared/sync.mjs';
import { RunArtifactDownloads,projectRunArtifacts } from '../shared/run-artifacts.mjs';
import { BotManager } from '../bot-management/service.mjs';
import { effectiveBotTools } from '../bot-management/tool-access.mjs';
import { tickRoutines } from '../bot-management/routines.mjs';
import { ChatroomService } from '../chatroom/service.mjs';
import { AttachmentStore,MAX_ATTACHMENT_REQUEST_BYTES } from '../chatroom/attachments.mjs';
import { MAX_FILE_REQUEST_BYTES } from '../filesystem/tools.mjs';
import { KnowledgeService } from '../knowledge/service.mjs';
import { MemoryManagement } from '../memory-management/service.mjs';
import { fail,required,now,within } from '../shared/validation.mjs';
import { CapabilityRegistry } from '../services/registry.mjs';
import { CapabilityControl,controlTools } from '../services/control.mjs';
import { CapabilityServiceSupervisor } from '../services/supervisor.mjs';
import { BUILTIN_CAPABILITIES } from '../services/builtin.mjs';
import { deployCapability } from '../services/publish.mjs';
import { coreTools } from '../../bot/src/capabilities/core-tools.mjs';
import { assertToolPolicy, permitsTool, permitsMaintenanceTool, taskMode } from '../../bot/src/capabilities/task-policy.mjs';
import { acceptedWorkTask,taskSource,workExecution } from '../../bot/src/context/sources.mjs';
import { directoryProject } from '../../bot/src/context/project-scope.mjs';
import { createRedactor } from '../../bot/src/runtime/config.mjs';
import { workFormReceipt } from '../../bot/src/runtime/works.mjs';
import { createPathAccess,resolveFilePath } from '../../bot/src/capabilities/file-policy.mjs';
import { fileAccessAnswer,taskFileAccessPolicy,workFormFileScope,WORK_FILE_ACCESS,WORK_FILE_ANSWERS } from '../../bot/src/capabilities/file-access.mjs';
import { notificationParts,progressNotificationCurrent } from '../../bot/src/runtime/notifications.mjs';
import { waitingLabel } from '../../bot/src/context/execution-evidence.mjs';
import { CapabilityCatalog,catalogTools } from '../services/catalog.mjs';
import { UsageLedger,readUsage,usageRange,finishUsageTotals,emptyUsageTotals,USAGE_PRICING } from '../../bot/src/agent/usage.mjs';
import { ModelConnections } from '../models/service.mjs';
import { NativeToolService } from '../services/native-tools.mjs';
import { WorkspaceProfiles } from '../models/workspace-profiles.mjs';
import { OnboardingService } from '../models/onboarding.mjs';
import { environmentScopeId } from '../../bot/src/context/environment.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const activityText=(value,max=512)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max):null;
function toolActivity(row) {
  const name=activityText(row.name,128),status=activityText(row.status,32);
  // Only expose display metadata, never command text, contents, results or raw arguments.
  return {name,status,path:['read_file','write_file','edit_file'].includes(name)?activityText(row.path):null,
    targetBotId:['messages_send','tasks_get','tasks_cancel','chatroom_dm','chatroom_send'].includes(name)?activityText(row.targetBotId,128):null,
    startedAt:activityText(row.startedAt,64),finishedAt:activityText(row.finishedAt,64)};
}
export async function startGateway(options={}) {
  const dataRoot=resolve(required(options.dataRoot,'dataRoot')),releaseRoot=resolve(required(options.releaseRoot,'releaseRoot')),defaultCwd=resolve(options.defaultCwd||releaseRoot),token=options.token||randomBytes(32).toString('hex');
  // History is cleared only while every writer is stopped; one startup snapshot
  // keeps the epoch and all responses from this process in the same generation.
  let historyEpoch=null;
  try{const history=JSON.parse(await readFile(join(dataRoot,'history.json'),'utf8'));historyEpoch=history.historyEpoch;if(typeof historyEpoch!=='string'||!historyEpoch||historyEpoch.length>128)throw new Error('Invalid history epoch');if(history.status&&history.status!=='complete')throw new Error('History maintenance has not completed; finish offline cleanup before starting');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!['127.0.0.1','::1'].includes(options.host||'127.0.0.1'))throw new Error('Capability gateway must use loopback');
  const clients=new Set(),stores=new Map(),pending=new Set();let url,closing=false,quiescing=false,ticking=false,monitoring=false,serviceMonitoring=false,stopBotsPromise;
  const store=name=>{if(!stores.has(name))stores.set(name,new RecordStore(join(dataRoot,'capabilities',name,'state.sqlite')));return stores.get(name);};
  const usageLedger=new UsageLedger(join(dataRoot,'usage.sqlite'));
  const emit=(type,payload={})=>{const line=`data: ${JSON.stringify({type,...payload})}\n\n`;for(const client of clients)client.write(line);};
  const modelConnections=await new ModelConnections({dataRoot,model:options.model,emit}).initialize();
  options.model={connectionStore:modelConnections.path};
  const botToolNames=[...coreTools({},{}).map(tool=>tool.name),'read_resource','read_session_history','context_assemble','knowledge_list','knowledge_read','knowledge_remember','knowledge_write','skills_list','skill_write'];
  const registry=new CapabilityRegistry({store:store('registry'),emit,reservedTools:[...botToolNames,...controlTools.map(tool=>tool.name),...catalogTools.map(tool=>tool.name)]});
  const supervisor=new CapabilityServiceSupervisor({dataRoot,releaseRoot});
  let control;
  const manager=new BotManager({store:store('bot-management'),dataRoot,releaseRoot,defaultCwd,model:options.model,emit,botApi:options.botApi,cacheReadStores:true,gatewayUrl:()=>url,getTools:bot=>control.tools(bot)});
  const deploy=args=>deployCapability(args,{dataRoot,defaultCwd,model:options.model,gatewayUrl:url,gatewayToken:token,supervisor,registry,control});
  control=new CapabilityControl({registry,supervisor,manager,store:store('registry'),gatewayUrl:()=>url,emit,deploy});
  const rpc=(id,operation,args=[],version)=>{
    const selected=version||registry.active(id)?.version;
    if(!selected)fail(`Capability ${id} has no active service`,503);
    return registry.invokeVersion(id,selected,operation,args,{context:{actor:'controller'}});
  };
  const proxy=(target,id,names)=>{for(const name of names)target[name]=(...args)=>rpc(id,name,args);};
  proxy(manager,'bot-management',['create','update','start','stop','send','saveRoutine','claimReminder','settleReminder','seed','restore','monitor','quiesce','shutdownAll','connect','ensureCatalogMaintainer','setCatalogMaintainerState']);
  const attachments=new AttachmentStore(join(dataRoot,'capabilities','chatroom'));
  const chatroom=new ChatroomService({store:store('chatroom'),manager,attachments,emit});
  const push=await new PushService({store:store('push'),messages:store('chatroom'),dataRoot,historyEpoch}).initialize();
  const knowledge=new KnowledgeService({store:store('knowledge'),emit}),memories=new MemoryManagement({store:store('memory-management'),manager,dataRoot,emit});
  proxy(chatroom,'chatroom',['createRoom','updateRoom','post','append','messageReceipt','dm','conclude','saveConclusion','retry','seed','teamRead','teamRaise','teamManage']);
  const catalog=new CapabilityCatalog({store:store('registry'),registry,manager,dataRoot,workspace:defaultCwd,emit,delegate:(actor,input)=>chatroom.dm(actor,input)});
  const native=new NativeToolService({catalog,manager,store:store('registry'),dataRoot,workspace:defaultCwd,emit,
    readArchive:id=>store('gateway').get('execution-cutover-archives',id),
    notifyUser:async(item,event,key)=>{
      const {roomId,replyTo}=item.source||{};
      const room=roomId&&chatroom.store.get('rooms',roomId);
      if(!room||room.status==='concluded')return;
      const id='native:'+item.nonce+':'+key;
      const request=event.type==='request'&&event.request;
      const content=request ? request.text+(request.choices.length?'\n'+request.choices.map(choice=>choice.label).join(' / '):'')+'\n请回复这条消息，或在工作详情处理。' : event.text;
      if(!content)return;
      const message=await chatroom.append(roomId,{id,replyTo,content,workId:item.workId,kind:'work',
        eventType:request?'native_input_requested':'native_'+event.type,sourceRefs:[item.operationId]},room.members.includes(item.actor)?item.actor:'system');
      if(request)store('gateway').save('native-room-requests',{id:message.id,actor:item.actor,workId:item.workId,operationId:item.operationId,requestId:request.id,roomId});
    }});
  catalog.native=native;
  async function answerInRoom(request,body) {
    const operation=await native.status({workId:request.workId,operationId:request.operationId},request.actor);
    const question=operation.pending?.find(item=>item.id===request.requestId);
    const content=required(body.content,'回复',16000);
    const text=question?.choices.find(choice=>choice.id===content||choice.label===content)?.id||content;
    const inputId=body.clientId||body.id||randomUUID();
    await native.answer(request.actor,request.workId,request.operationId,request.requestId,{id:inputId,text});
    return chatroom.append(request.roomId,{...body,clientId:inputId,content},'user');
  }
  async function answerFileAccessInRoom(message,body) {
    const ref=message.sourceRefs?.find(item=>item.type==='work-file-access'&&item.workId===message.workId);
    const content=required(body.content,'文件授权答复',16000),id=body.clientId||body.id||randomUUID();
    if(!ref||!fileAccessAnswer(content)||body.attachments?.length)fail('请回复「允许」或「拒绝」来处理这项文件授权。');
    const request=await manager.readState(message.senderId,db=>db?.getRecord(WORK_FILE_ACCESS,ref.requestId));
    if(!request||request.workId!==message.workId||request.roomId!==message.roomId||request.actionId!==ref.operationId||
      message.clientId!==message.workId+':'+request.id)fail('原文件授权请求不可用。',409);
    await manager.start(message.senderId);
    await manager.request(message.senderId,'/works/'+encodeURIComponent(message.workId)+'/user-input',{method:'POST',
      body:JSON.stringify({id,content,fileAccessRequestId:request.id,roomId:message.roomId,replyTo:message.id})});
    return chatroom.append(message.roomId,{...body,clientId:id,content},'user');
  }
  const ensureSetupAccess=async bot=>{
      await control.grant(bot.id,[...new Set([...(bot.allowedTools||[]),'workspace_setup'])]);
      for(let attempt=0;attempt<100;attempt++){
        await control.tick();
        if((await manager.config(bot.id)).tools.some(tool=>tool.name==='workspace_setup'))return;
        await pause(100);
      }
      fail('Pi 正在切换配置能力，稍后可继续当前步骤。',503);
  };
  const onboarding=await new OnboardingService({store:store('gateway'),models:modelConnections,manager,chatroom,emit,ensureSetupAccess,native}).initialize();
  const profiles=new WorkspaceProfiles({store:store('gateway'),dataRoot,manager,chatroom,emit,ensureSetupAccess,native});
  async function environmentKnowledge(profileId, actor='controller') {
    const botId=profileId?store('gateway').get('workspace-profiles',profileId)?.botId:onboarding.bot()?.id;
    const environment=botId&&await memories.environment(botId);
    if (!environment) return null;
    const {resourceIds,text,...node}=environment;
    if (actor!=='controller'&&resourceIds.some(id=>{
      const entry=store('registry').get('catalog-entries',id);
      return !entry||!catalog.permitted(entry,actor);
    })) return null;
    return node;
  }
  async function workspaceKnowledgeGraph(profileId,id=null,depth=1) {
    const environment=(!id||id===environmentScopeId)&&await environmentKnowledge(profileId);
    if (id===environmentScopeId&&environment) return {nodes:[environment],edges:[]};
    const result=knowledge.graph(id,depth,profileId);
    if (environment) result.nodes.push(environment);
    return result;
  }
  async function includeEnvironment(result,query,profileId,actor='controller') {
    const environment=await environmentKnowledge(profileId,actor);
    const terms=String(query||'').toLowerCase().split(/[\s，。！？、,;:：!?]+/).filter(Boolean);
    if (environment&&(!terms.length||terms.some(term=>`${environment.title} ${environment.content}`.toLowerCase().includes(term))))
      return {...result,nodes:[...(result.nodes||[]),environment]};
    return result;
  }
  proxy(knowledge,'knowledge',['saveNode','saveEdge']);
  proxy(memories,'memory-management',['write']);
  proxy(attachments,'chatroom',['upload']);
  const historicalWork=id=>store('gateway').get('historical-executions',id)||null;
  const publicWork=(botId,work)=>({...work,id:`${botId}~${work.id}`,workId:work.id,botId,summary:work.progress,cwd:work.project?.cwd||work.executor?.target?.cwd,
    controlRevision:work.controlRevision||0,
    waitingLabel:['waiting','paused','cancelled'].includes(work.status)?waitingLabel(work):null,roomId:work.sources?.find(source=>source.roomId)?.roomId});
  async function localWorks(bots=manager.list()) {
    const groups=await Promise.all(bots.map(async bot=>manager.readState(bot.id,db=>(db?.listRecords('works')||[]).map(work=>publicWork(bot.id,work)))));
    return groups.flat();
  }
  async function localWork(id) {
    const split=id.indexOf('~');if(split<0)return null;
    const botId=id.slice(0,split),workId=id.slice(split+1);manager.get(botId);
    return manager.readState(botId,db=>{const work=db?.getRecord('works',workId);return work?{...publicWork(botId,work),events:db.listEvents({workId,limit:200}),nativeSources:native.sources.list().filter(source=>work.bindings?.some(binding=>binding.resourceId===source.resourceId))}:null;});
  }
  const sync=new IncrementalSync(store('gateway'));
  function runRoom(task, botId, guide, guideBotId) {
    if (guide?.status === 'guiding' && task.workId && task.workId === guide.setup?.workId && botId === guideBotId) return guide.roomId;
    return task.sessionId?.replace(/^room:/,'');
  }
  async function ownRun(id) {
    const guide=onboarding.record(),guideBotId=onboarding.bot()?.id;
    for(const bot of manager.list()){
      const full=await manager.readState(bot.id,db=>{const task=db?.getTask(id);return task?{...task,tools:db.listTools(id)}:null;});
      if(full)return {id,...full,botId:bot.id,summary:full.result?.content||full.summary||'',sessionId:full.sessionId,roomId:runRoom(full,bot.id,guide,guideBotId)};
    }return null;
  }
  const downloads=new RunArtifactDownloads({getRun:ownRun,resolveRoot:run=>({dataRoot,artifactRoot:join(manager.directory(run.botId),'artifacts')}),tempRoot:join(dataRoot,'capabilities','gateway','tmp','downloads')});
  async function state({ previews = false, selectedWorkspace } = {}) {
    const models=selectedWorkspace?.models||modelConnections, guideService=selectedWorkspace?.onboarding||onboarding, profileId=selectedWorkspace?.profile.id||null;
    const bots=manager.list().filter(bot=>(bot.workspaceProfileId||null)===profileId);
    const rooms=chatroom.rooms().filter(room=>(room.workspaceProfileId||null)===profileId);
    const roomIds=new Set(rooms.map(room=>room.id));
    const agentRuns=[],providers=[],botActivities=new Map();
    const guide=guideService.record(),guideBotId=guideService.bot()?.id;
    await Promise.all(bots.map(async bot=>{
      // A single durable snapshot per Bot avoids reopening its database for every
      // historical task and reading every full tool result on every UI refresh.
      const snapshot=await manager.readState(bot.id,db=>{
        if(!db)return {tasks:[],counts:{},lastTools:{}};
        return {tasks:db.listTasks(),maintenance:db.getState('runtime','maintenanceActivities')?.value||[],
          waitingWork:db.listRecords('works').findLast(work=>work.status==='waiting'),
          counts:Object.fromEntries(db.db.prepare('SELECT task_id,COUNT(*) AS count FROM tools WHERE task_id IN (SELECT id FROM tasks ORDER BY rowid DESC LIMIT 100) GROUP BY task_id').all().map(row=>[row.task_id,row.count])),
          lastTools:Object.fromEntries(db.db.prepare(`SELECT task_id,
            COALESCE(json_extract(data,'$.name'),json_extract(data,'$.toolName')) AS name,
            json_extract(data,'$.status') AS status,
            COALESCE(json_extract(data,'$.args.path'),json_extract(data,'$.args.filePath')) AS path,
            COALESCE(json_extract(data,'$.args.to'),json_extract(data,'$.args.targetBotId'),json_extract(data,'$.args.toBotId'),json_extract(data,'$.args.botId'),json_extract(data,'$.args.childId')) AS targetBotId,
            json_extract(data,'$.startedAt') AS startedAt,json_extract(data,'$.finishedAt') AS finishedAt
            FROM tools WHERE rowid IN (SELECT MAX(rowid) FROM tools WHERE task_id IN (SELECT id FROM tasks ORDER BY rowid DESC LIMIT 100) GROUP BY task_id)`)
            .all().map(row=>[row.task_id,toolActivity(row)]))};
      });
      for(const task of snapshot.tasks)agentRuns.push({id:task.id||task.taskId,taskId:task.taskId||task.id,runId:task.runId,
        status:task.status,workId:task.workId,sessionId:task.sessionId,conversationId:task.conversationId,
        createdAt:task.createdAt,startedAt:task.startedAt,updatedAt:task.updatedAt,finishedAt:task.finishedAt,
        activity:task.activity,model:task.result?.model,error:task.error&&{code:task.error.code,message:String(task.error.message||'').slice(0,2000)},
        input:{trigger:{id:task.input?.trigger?.id||task.input?.current?.trigger?.id}},
        botId:bot.id,summary:String(task.result?.content||task.summary||'').slice(0,2400),
        toolCount:task.result?.toolsCalled??snapshot.counts[task.id||task.taskId]??0,lastTool:snapshot.lastTools[task.id||task.taskId]||null,
        roomId:runRoom(task,bot.id,guide,guideBotId)});
      const active=snapshot.tasks.filter(task=>['accepted','queued','running','waiting'].includes(task.status)).sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt))).at(-1);
      const maintenance=snapshot.maintenance?.at(-1);
      const recent=snapshot.tasks.at(-1),fresh=recent&&Date.now()-Date.parse(recent.finishedAt||'')<8000;
      const terminal=fresh?{phase:recent.status,label:recent.status==='completed'?'已完成本次任务':recent.status==='failed'?'任务遇到问题':recent.status==='cancelled'?'任务已取消':'任务已中断',motion:recent.status==='completed'?'burst':recent.status==='failed'?'alert':'confused',source:'execution',updatedAt:recent.finishedAt}:null;
      const waitingActivity=snapshot.waitingWork?{phase:'waiting',label:waitingLabel(snapshot.waitingWork),roomId:snapshot.waitingWork.sources?.find(source=>source.roomId)?.roomId,motion:'notify',source:'execution'}:null;
      botActivities.set(bot.id,bot.status==='paused'?{phase:'paused',label:'已暂停',motion:'sleep',source:'execution'}:active?(active.activity||{phase:active.status,label:active.status==='running'?'正在准备任务':'等待执行',motion:'thinking',source:'execution'}):waitingActivity||maintenance||(fresh?recent.activity||terminal:null)||{phase:'idle',label:'空闲',motion:'idle',source:'execution'});
      try{const health=await manager.request(bot.id,'/health',{signal:AbortSignal.timeout(2000)});if(health.engine?.provider)providers.push(health.engine.provider);}catch{}
    }));
    agentRuns.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
    const activity=chatroom.store.db.prepare(`SELECT data FROM records WHERE kind='messages' AND
      (json_extract(data,'$.returnTo') IS NOT NULL OR json_extract(data,'$.peerReplyId') IS NOT NULL OR json_extract(data,'$.kind') IN ('event','work'))
      ORDER BY created_at DESC,rowid DESC LIMIT 100`).all().reverse().map(row=>JSON.parse(row.data));
    const jobs=chatroom.jobs().filter(job=>roomIds.has(job.roomId)),runtime={started:true,fast:{running:jobs.filter(job=>['running','accepted'].includes(job.status)).length,queued:jobs.filter(job=>job.status==='queued').length},deep:{running:0,queued:0},jobs:jobs.slice(-80).map(job=>Object.fromEntries(
      ['id','roomId','botId','messageId','taskId','agentRunId','status','lane','label','retryOf','createdAt','updatedAt','finishedAt','error'].filter(key=>job[key]!==undefined).map(key=>[key,job[key]])))};
    const selection=models.runtimeModel();
    const latestProvider=selection?providers.filter(provider=>provider.connectionId===selection.id).sort((a,b)=>String(b.lastSuccessAt||'').localeCompare(String(a.lastSuccessAt||'')))[0]||{}:{};
    const configured=Boolean(selection&&((await models.credentials.read(selection.id).catch(()=>null))||selection.allowNoKey));
    const modelSettings={...models.summary(),sources:native.sources.list()};
    modelSettings.chat.configured=configured;
    const works=[...await localWorks(bots),...(profileId?[]:store('gateway').list('historical-executions'))];
    const rows=previews?works.map(({id,workId,botId,roomId,goal,status,waitingLabel,createdAt,updatedAt,historical,revision,controlRevision,externalStop})=>
      ({id,workId,botId,roomId,goal,status,waitingLabel,createdAt,updatedAt,historical,revision,controlRevision,
        ...(externalStop?{externalStop:{status:externalStop.status}}:{})})):works;
    return {historyEpoch,workspaceProfileId:profileId,onboarding:await guideService.publicState(),modelSettings,bots:bots.map(bot=>({...bot,activity:botActivities.get(bot.id)})),rooms,routines:manager.store.list('routines').filter(item=>bots.some(bot=>bot.id===item.botId)),knowledge:await workspaceKnowledgeGraph(profileId),runtime,activity:activity.filter(message=>roomIds.has(message.roomId)),works:rows,agentRuns:agentRuns.slice(-100),provider:{configured,model:selection?.model||null,...latestProvider},defaultCwd};
  }
  function visibleTools(actor) {
    const allowed=actor==='controller'?null:manager.get(actor).allowedTools||[];
    return [...registry.toolsFor(actor,allowed),...controlTools,...catalogTools].filter(tool=>allowed===null||allowed.includes(tool.name));
  }
  async function callTool(name,args={},actor='controller',signal,pin,taskId) {
    const definition=visibleTools(actor).find(tool=>tool.name===name);
    if(quiescing&&definition?.effect!=='read')fail('Gateway is stopping; new work is unavailable',503);
    if(actor!=='controller'&&!(effectiveBotTools(manager.store.get('bots',actor))||[]).includes(name))fail('Tool not authorized for this Bot',403);
    const {_context,...input}=args;args=input;
    let task,source,runtimeOperation,workPublication,dutyContributionOperation;
    if(actor!=='controller'){
      if(taskId){
        task=await manager.readState(actor,db=>db?.getTask(taskId));
        const saved=await manager.readState(actor,db=>{
          const notification=name==='chatroom_send'&&_context?.notificationId?db?.getRecord('work-notifications',_context.notificationId):null;
          return {source:task&&(task.workId?workExecution(task,db).authorization?.source:taskSource(task,db)),notification,
            progressCurrent:!notification?.progressScope||progressNotificationCurrent(notification,db.getRecord('works',notification.workId)),
            operation:_context?.operationId?db?.getRecord('work-events',_context.operationId):null};
        });
        source=saved.source;
        const publishing=saved.notification&&saved.notification.status!=='delivered'&&saved.notification.taskId===taskId&&
          notificationParts(saved.notification).some(part=>Object.entries(part).every(([key,value])=>JSON.stringify(args[key])===JSON.stringify(value)));
        if(publishing)workPublication=true;
        if(publishing&&!saved.progressCurrent)fail('The recorded progress observation is no longer current',409);
        runtimeOperation=saved.operation?.sourceTaskId===taskId&&saved.operation.transport?.name===name&&
          JSON.stringify(saved.operation.transport.args)===JSON.stringify(args)?saved.operation:null;
        const contribution=args.dutyContribution,operation=saved.operation;
        if(name==='chatroom_read'&&operation?.contributionPlanId&&operation.status==='pending'&&operation.requestTaskId===taskId&&
          source?.actor==='user'&&args.roomId===source.roomId&&contribution?.planId===operation.contributionPlanId&&
          contribution.operationId===operation.id&&contribution.workId===operation.workId){
          dutyContributionOperation=operation.id;
          runtimeOperation=operation;
        }
        if(runtimeOperation?.requestTaskId&&['chatroom_read','chatroom_list'].includes(name)) source=await manager.readState(actor,db=>{
          const origin=db?.getTask(runtimeOperation.requestTaskId);return origin?taskSource(origin,db):null;
        });
        if(runtimeOperation&&['chatroom_read','chatroom_list'].includes(name)&&!source)fail('Original evidence authorization is unavailable',403);
        if(!task||(task.status!=='running'&&!publishing&&!runtimeOperation))fail('An active task or saved delivery owned by this Bot is required',403);
        if(!publishing&&!runtimeOperation)assertToolPolicy(task,definition,args);
      }else if(!permitsMaintenanceTool(name))fail('A runtime task context is required',403);
    }
    if(catalogTools.some(tool=>tool.name===name)){
      const current=task?.input?.current||task?.input,work=task?.workId&&await manager.readState(actor,db=>db?.getRecord('works',task.workId));
      const source=work?await manager.readState(actor,db=>workExecution(task,db).authorization?.source||{}):{};
      const provenance=task?{workId:task.workId,conversationId:task.conversationId,originRoomId:current?.room?.id||source.roomId,
        originMessageId:current?.trigger?.id||source.replyTo,sourceRefs:[`task:${task.id}`]}:undefined;
      return catalog.call(name,{...args,...(provenance?{_context:provenance}:{})},{actor,signal,task});
    }
    if(name==='workspace_setup'){
      const context=task?.workId&&await manager.readState(actor,db=>({work:db?.getRecord('works',task.workId),source:workExecution(task,db).authorization?.source}));
      const guide=task?.workId&&await profiles.forWork(task.workId);return (guide?.onboarding||onboarding).setupAction(args,{actor,task,...context});
    }
    if(controlTools.some(tool=>tool.name===name))return control.call(name,args,{actor});
    if(pin&&!control.permittedVersion(actor,pin.id,pin.version))fail('This capability version is not bound to the Bot',403);
    const context={actor,...(task?{taskId:task.id,workId:runtimeOperation?.workId||task.workId,mode:runtimeOperation?'work':taskMode(task),source}:{}),
      ...(workPublication?{workPublication:true}:{}),...(dutyContributionOperation?{dutyContributionOperation}:{})};
    if(task&&['list_files','read_file','search_files','write_file','edit_file','run_command','publish_file'].includes(name)){
      const config=await manager.config(actor);
      const fileScope=await manager.readState(actor,db=>{
        if(name==='publish_file'&&!task.workId){
          const route=db.getRecord('request-routing',task.id),event=args.operationId&&db.getRecord('work-events',args.operationId);
          const origin=event&&acceptedWorkTask(event,db),work=origin&&db.getRecord('works',origin.workId);
          if(!work||work.id!==args.workId||!source?.roomId||!['deliver','produce','revise'].includes(route?.intent)||
            route.messageId!==source.replyTo||route.roomId!==source.roomId||event.authorization?.source?.roomId!==source.roomId)
            fail('Select existing delivery and its exact same-room work and operation from work_outputs',403);
          const project=work.project?.cwd,base=project||config.workspace;
          const policy=taskFileAccessPolicy(origin,db,base);
          policy.deniedPaths.push(...taskFileAccessPolicy(task,db,base).deniedPaths);
          return {project,policy};
        }
        const project=db?.getRecord('works',task.workId)?.project?.cwd;
        return {project,policy:taskFileAccessPolicy(task,db,project||config.workspace)};
      });
      if(fileScope.project)context.projectRoot=fileScope.project;
      context.fileAccessPolicy=fileScope.policy;
    }
    const result=pin?registry.callVersion(pin.id,pin.version,name,args,{signal,context}):registry.call(actor,name,args,{signal,context});
    if(name==='knowledge_search')return includeEnvironment(await result,args.query,actor==='controller'?null:manager.get(actor).workspaceProfileId||null,actor);
    return result;
  }
  async function tokenUsage(params, profileId) {
    const range=usageRange(params.get('period')||'today'),botId=params.get('botId')||null;
    const roomId=params.has('roomId')?(params.get('roomId')||null):undefined;
    const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||25);
    if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('无效的用量分页',400);
    return usageLedger.snapshot(()=>{
    const all=manager.list(),profiles=all.filter(bot=>(bot.workspaceProfileId||null)===profileId);
    const scope=profileId?{botIds:profiles.map(bot=>bot.id)}:{excludeBotIds:all.filter(bot=>bot.workspaceProfileId).map(bot=>bot.id)};
    const snapshot=readUsage(usageLedger.db,range,{roomId,botId,...scope,offset,limit});
    const botsById=new Map(profiles.map(bot=>[bot.id,bot])),roomsById=new Map(chatroom.rooms().map(room=>[room.id,room]));
    const bots=snapshot.bots.map(row=>({...row,id:row.key,name:botsById.get(row.key)?.name||row.name||row.key,kind:'bot',removed:!botsById.has(row.key)}));
    if(!botId&&roomId===undefined)for(const bot of profiles)if(!bots.some(row=>row.id===bot.id))bots.push({...finishUsageTotals(emptyUsageTotals()),id:bot.id,name:bot.name,kind:'bot'});
    const rooms=snapshot.rooms.map(row=>({...row,id:row.key,name:roomsById.get(row.key)?.name||row.name||(row.key?'已移除的会话':'未归属会话'),kind:roomsById.get(row.key)?.kind||row.kind||'unassigned'}));
    const providerReports=(profileId?[]:usageLedger.providerReports(range)).map(report=>{
      const from=new Date(`${report.day}T00:00:00+08:00`).toISOString(),to=new Date(Date.parse(from)+86400000).toISOString();
      const local=readUsage(usageLedger.db,{from,to},{detail:false}).totals;
      return {...report,localCalls:local.calls,localTokens:local.totalTokens,localCostMin:local.costMin,localCostMax:local.costMax,localPricedCalls:local.pricedCalls,
        differenceCalls:report.calls-local.calls,differenceTokens:report.totalTokens-local.totalTokens,tokenCoverage:report.totalTokens?local.totalTokens/report.totalTokens:null};
    });
    return {...snapshot,range,botId,roomId,pricing:USAGE_PRICING,bots,rooms,providerReports,coverage:usageLedger.coverage(range),
      requests:snapshot.requests.map(request=>({...request,botName:botsById.get(request.botId)?.name||request.botName||request.botId}))};
    });
  }
  async function handleApi(method,path,body={},params=new URLSearchParams()) {
    if(quiescing&&!['GET','HEAD'].includes(method))fail('Gateway is stopping; new work is unavailable',503);
    let match;
    if(method==='GET'&&path==='/api/health')return {ok:true,service:'summon-capabilities'};
    if(path==='/api/workspace-profiles'&&method==='POST')return profiles.create(body);
    if(path==='/api/workspace-profiles'&&method==='GET')return {workspaces:profiles.list()};
    const profileId=params.get('workspace');
    const selectedWorkspace=profileId?await profiles.get(profileId):null;
    const models=selectedWorkspace?.models||modelConnections,guide=selectedWorkspace?.onboarding||onboarding;
    if(method==='GET'&&path==='/api/usage')return tokenUsage(params,profileId);
    if(path==='/api/model-settings'&&method==='GET')return {...await models.snapshot(),sources:native.sources.list()};
    if(path==='/api/model-settings/local'&&method==='GET')return models.localLogins();
    if(path==='/api/model-settings/local/import'&&method==='POST')return models.importLocal(body.kind);
    if(path==='/api/model-settings/onboarding'&&method==='GET')return guide.snapshot();
    if(path==='/api/model-settings/onboarding/reply'&&method==='POST')return guide.reply(body);
    if(path==='/api/model-settings/onboarding/start'&&method==='POST')return guide.start(body);
    if(path==='/api/model-settings/onboarding/advance'&&method==='POST')return guide.advance(body);
    if(path==='/api/model-settings/connections'&&method==='POST')return models.save(body);
    if(path==='/api/model-settings/active'&&method==='POST')return models.select(body.id);
    if(path==='/api/model-settings/usage'&&method==='POST'){
      const [summary,sources]=await Promise.all([models.refreshUsage(body.force===true),body.force===true?native.sources.refreshAll():native.sources.list()]);
      return {...summary,sources};
    }
    if(path==='/api/model-settings/usage'&&method==='GET')return {...models.summary(),sources:native.sources.list()};
    if(method==='POST'&&(match=path.match(/^\/api\/model-settings\/usage\/([^/]+)\/([^/]+)\/actions$/)))
      return native.sources.refresh(decodeURIComponent(match[1]),decodeURIComponent(match[2]),body.id);
    if((match=path.match(/^\/api\/model-settings\/connections\/([A-Za-z0-9_-]+)(?:\/(login|models))?$/))){
      const id=match[1],action=match[2];
      if(!action&&method==='DELETE')return models.remove(id);
      if(action==='models'&&method==='GET')return models.choices(id,params.get('discover')==='1');
      if(action==='login'){
        if(method==='GET')return models.loginStatus(id);
        if(method==='POST')return models.startLogin(id);
        if(method==='DELETE'){models.cancelLogin(id);return models.loginStatus(id);}
      }
    }
    if(path==='/api/catalog'){
      if(method==='GET')return catalog.search({query:params.get('query')||'',kind:params.get('kind')||undefined,scopeRefs:params.getAll('scopeRef'),offset:Number(params.get('offset')||0),limit:Number(params.get('limit')||40)},params.get('botId')||'controller');
      if(method==='POST')return ['mcp','http'].includes(body.kind)?native.registerNetwork(body,'controller'):catalog.save(body);
    }
    if((match=path.match(/^\/api\/catalog\/([^/]+)(?:\/(probe|call|delegate|proposals|resource|requests))?$/))){
      const id=decodeURIComponent(match[1]),action=match[2];
      if(!action){if(method==='GET')return catalog.get(id);if(method==='PATCH')return catalog.save({...body,id});if(method==='DELETE')return catalog.remove(id,'controller',body.expectedRevision);}
      if(method==='GET'&&action==='resource')return catalog.get(id,'controller',params.get('path')||'SKILL.md');
      if(method==='GET'&&action==='requests')return {requests:catalog.requests(id)};
      if(method==='GET'&&action==='proposals')return {proposals:store('registry').list('catalog-skill-proposals').filter(proposal=>proposal.entryId===id)};
      if(method==='POST'&&action==='probe')return catalog.probe(id);
      if(method==='POST'&&action==='call')return catalog.execute(id,body);
      if(method==='POST'&&action==='delegate')return catalog.handoff(id,body);
      if(method==='POST'&&action==='proposals')return catalog.propose({...body,id});
    }
    if(method==='POST'&&(match=path.match(/^\/api\/catalog\/([^/]+)\/requests\/([^/]+)\/reconcile$/)))return catalog.reconcile(decodeURIComponent(match[1]),decodeURIComponent(match[2]),body);
    if(method==='GET'&&path==='/api/capabilities')return control.inventory();
    if(method==='POST'&&(match=path.match(/^\/api\/capabilities\/(register|deploy|activate|unload|grant|retire|retry|reconcile)$/)))return control.call(`capabilities_${match[1]}`,body);
    if(method==='GET'&&path==='/api/state'){const value=await state({previews:params.get('sync')==='1',selectedWorkspace});return params.get('sync')==='1'?{...sync.respond(profileId?'workspace:'+profileId:'workspace',value,params.get('since')),historyEpoch}:value;}
    if(method==='GET'&&path==='/api/bots')return {bots:manager.list().filter(bot=>(bot.workspaceProfileId||null)===profileId)};
    if(method==='POST'&&path==='/api/bots')return manager.create({...body,workspaceProfileId:profileId,...(selectedWorkspace?{modelConfig:{connectionStore:models.path}}:{})});
    if((match=path.match(/^\/api\/bots\/([^/]+)\/contacts$/))){const id=decodeURIComponent(match[1]);if(method==='GET')return manager.contacts(id);if(method==='POST')return manager.connect(id,body.botId,{enabled:body.enabled??true});}
    if((match=path.match(/^\/api\/bots\/([^/]+)$/))&&method==='PATCH')return manager.update(decodeURIComponent(match[1]),body);
    if((match=path.match(/^\/api\/bots\/([^/]+)\/memories$/))){const id=decodeURIComponent(match[1]);if(method==='GET')return {memories:(await memories.list(id)).map(memory=>({...memory,content:memory.text}))};if(method==='POST')return memories.write(id,body);}
    if((match=path.match(/^\/api\/memories\/([^/]+)$/))&&method==='PATCH'){for(const bot of manager.list()){const found=(await memories.list(bot.id)).find(memory=>memory.id===decodeURIComponent(match[1]));if(found)return memories.write(bot.id,{...body,id:found.id,expectedRevision:body.expectedRevision??found.revision});}fail('Memory not found',404);}
    if(method==='GET'&&path==='/api/push/status')return push.status();
    if(method==='POST'&&path==='/api/push/devices')return push.register(body);
    if(method==='DELETE'&&path==='/api/push/devices')return push.remove(body);
    if(method==='GET'&&path==='/api/rooms')return {rooms:chatroom.rooms().filter(room=>(room.workspaceProfileId||null)===profileId)};
    if(method==='POST'&&path==='/api/rooms')return chatroom.createRoom({...body,workspaceProfileId:profileId});
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/team(?:\/(raise|manage))?$/))){const input={...body,roomId:decodeURIComponent(match[1])};if(method==='GET'&&!match[2])return chatroom.teamRead(input,'controller');if(method==='POST'&&match[2])return chatroom[match[2]==='raise'?'teamRaise':'teamManage'](input,'controller');}
    if((match=path.match(/^\/api\/rooms\/([^/]+)$/))&&method==='PATCH')return chatroom.updateRoom(decodeURIComponent(match[1]),body);
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/messages$/))){const id=decodeURIComponent(match[1]);if(method==='GET'){const value={historyEpoch,room:chatroom.need('rooms',id),messages:chatroom.messages(id),jobs:chatroom.jobs(id)};return params.get('sync')==='1'?{...sync.respond(`room:${id}`,value,params.get('since')),historyEpoch}:value;}if(method==='POST'){
      const request=body.replyTo&&store('gateway').get('native-room-requests',body.replyTo);
      if(request?.roomId===id)return answerInRoom(request,body);
      const replied=body.replyTo&&chatroom.store.get('messages',body.replyTo);
      if(replied?.roomId===id&&replied.eventType==='work_file_access_requested')return answerFileAccessInRoom(replied,body);
      return guide.postMessage(id,body);
    }}
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/conclude$/))&&method==='POST')return chatroom.conclude(decodeURIComponent(match[1]));
    if(method==='GET'&&path==='/api/knowledge/search'){const query=params.get('q')||'',result=await includeEnvironment(knowledge.search(query,profileId),query,profileId);return {...result,memories:params.get('botId')?(await memories.list(params.get('botId'))).map(memory=>({...memory,content:memory.text})):[]};}
    if(method==='GET'&&path==='/api/knowledge/graph')return workspaceKnowledgeGraph(profileId,params.get('id'),params.get('depth'));
    if(method==='POST'&&path==='/api/knowledge/nodes')return knowledge.saveNode({...body,workspaceProfileId:profileId});
    if((match=path.match(/^\/api\/knowledge\/nodes\/([^/]+)$/))&&method==='PATCH')return knowledge.saveNode({...body,id:decodeURIComponent(match[1]),workspaceProfileId:profileId});
    if(method==='POST'&&path==='/api/knowledge/edges')return knowledge.saveEdge({...body,workspaceProfileId:profileId});
    if(method==='POST'&&path==='/api/routines')return manager.saveRoutine(body);
    if((match=path.match(/^\/api\/routines\/([^/]+)$/))&&method==='PATCH')return manager.saveRoutine({...body,id:decodeURIComponent(match[1])});
    if(method==='POST'&&path==='/api/events'){const event=await chatroom.post(body.roomId||'room-lobby',{...body,toBotId:body.botId,kind:'event',notify:true},'system');return {event,jobs:chatroom.jobs().filter(job=>job.messageId===event.id)};}
    if(method==='GET'&&path==='/api/jobs')return {jobs:chatroom.jobs()};
    if((match=path.match(/^\/api\/jobs\/([^/]+)\/retry$/))&&method==='POST')return chatroom.retry(decodeURIComponent(match[1]));
    if(method==='POST'&&path==='/api/works'){
      const bot=manager.get(body.botId),id=body.id??randomUUID();
      if(typeof id!=='string'||!(/^[\w.-]{1,160}$/).test(id)||['.','..'].includes(id)||typeof body.goal!=='string'||
        [body.cwd,body.constraints,body.roomId].some(value=>value!=null&&typeof value!=='string')||
        body.inputRefs!=null&&(!Array.isArray(body.inputRefs)||body.inputRefs.some(value=>typeof value!=='string')))
        fail('工作表单的标识、目标或输入资料无效。');
      const fileScope=workFormFileScope(body.fileScope);
      const request={goal:required(body.goal,'工作目标'),constraints:body.constraints||'',cwd:body.cwd?.trim()||'',
        roomId:body.roomId||null,inputRefs:body.inputRefs||[],...(Object.keys(fileScope).length?{fileScope}:{})};
      if(body.projectId||body.target)fail('请使用登记项目的实际目录指定工作目标。');
      const intake=store('gateway');
      const assertFormOwner=()=>{
        const owner=intake.get('work-form-owners',id);
        if(owner&&owner.botId!==bot.id)fail('本次表单标识已绑定原委托成员，请保留原成员重试或查看原工作。',409);
        return owner;
      };
      assertFormOwner();
      const prior=await manager.readState(bot.id,db=>db?.getRecord('work-form-submissions',id));
      if(prior){
        const original=createRedactor(await manager.config(bot.id))(request);
        const saved=await manager.readState(bot.id,db=>workFormReceipt(db,id,original));
        if(saved)return {...publicWork(bot.id,saved.work),dispatch:saved.dispatch};
      }
      if(bot.status!=='active')fail('当前成员不可用，工作未受理。',409);
      if(request.roomId){
        const room=chatroom.need('rooms',request.roomId);
        if(room.status==='concluded'||!room.members.includes('user')||!room.members.includes(bot.id))
          fail('请选择用户和委托成员均可进入的有效会话。',403);
      }
      await manager.start(bot.id);
      const executor={kind:'pi'};
      let project;
      if(request.cwd){
        if(!isAbsolute(request.cwd)||!(/^(?:[A-Za-z]:[\\/]|\/|\\\\)/).test(request.cwd)||request.cwd.includes('\0'))
          fail('请填写服务器上明确的绝对工作目录。');
        const config=await manager.config(bot.id),cwd=resolveFilePath(config.workspace,request.cwd);
        const checkedPath=createPathAccess({workspace:config.workspace,project:cwd,protectedDirectories:[dataRoot]});
        project=directoryProject(await checkedPath(cwd,{directory:true}));
      }
      intake.transaction(()=>{if(!assertFormOwner())intake.save('work-form-owners',{id,botId:bot.id});});
      const {work,dispatch}=await manager.request(bot.id,'/works/form',{method:'POST',body:JSON.stringify({id,request,executor,project})});
      return {...publicWork(bot.id,work),dispatch};
    }
    if((match=path.match(/^\/api\/works\/([^/]+)\/native(?:\/([^/]+)(?:\/(answer|stop))?)?$/))){
      const work=await localWork(decodeURIComponent(match[1]));
      if(!work)fail('Original work not found',404);
      const operationId=match[2]&&decodeURIComponent(match[2]);
      if(method==='GET')return native.status({workId:work.workId,operationId,stream:params.get('stream')||undefined,
        offset:Number(params.get('offset')||0),limit:Number(params.get('limit')||16384)},work.botId);
      if(method==='POST'&&match[3]==='answer')return native.answer(work.botId,work.workId,operationId,body.requestId,body);
      if(method==='POST'&&match[3]==='stop')return native.stopByWork(work.botId,work.workId,operationId);
    }
    if((match=path.match(/^\/api\/works\/([^/]+)(?:\/(send|pause|cancel|resume))?$/))){
      const id=decodeURIComponent(match[1]),work=await localWork(id);
      if(method==='GET'&&!match[2])return work||historicalWork(id);
      if(method==='POST'&&match[2]){
        if(!work)fail('Historical external work is read-only',409);await manager.start(work.botId);
        const endpoint=`/works/${encodeURIComponent(work.workId)}`;
        if(match[2]==='send'){
          const id=body.id||randomUUID(),text=required(body.message,'补充要求',16000);
          const prior=fileAccessAnswer(text)&&await manager.readState(work.botId,db=>db?.getRecord(WORK_FILE_ANSWERS,work.workId+':'+id));
          const fileAccessRequestId=prior?.requestId||work.waiting?.fileAccess?.requestId;
          if(fileAccessRequestId)return manager.request(work.botId,endpoint+'/user-input',{method:'POST',
            body:JSON.stringify({id,content:text,fileAccessRequestId})});
          const delivered=await native.steer(work.botId,work.workId,id,text);
          return manager.request(work.botId,endpoint+'/user-input',{method:'POST',body:JSON.stringify({id,content:text,delivered})});
        }
        if(!Number.isSafeInteger(body.controlRevision)||body.controlRevision<0)fail('请刷新工作详情后重新操作。',409);
        const status={pause:'paused',cancel:'cancelled',resume:'active'}[match[2]];
        const changed=await manager.request(work.botId,endpoint,{method:'PATCH',body:JSON.stringify({status,controlRevision:body.controlRevision})});
        emit('work.updated',{work:{id:work.id,workId:work.workId,botId:work.botId,status:changed.status}});
        return publicWork(work.botId,changed);
      }
    }
    if((match=path.match(/^\/api\/agent-runs\/([^/]+)(?:\/(cancel))?$/))){const run=await ownRun(decodeURIComponent(match[1]));if(!run)fail('Run not found',404);if(method==='GET')return projectRunArtifacts(run);if(method==='POST'&&match[2])return manager.request(run.botId,`/tasks/${encodeURIComponent(run.id)}/cancel`,{method:'POST',body:'{}'});}
    if(method==='POST'&&path==='/api/attachments')return attachments.upload(body);
    return undefined;
  }
  const authenticate=req=>{const supplied=req.headers.authorization?.replace(/^Bearer /,'');if(same(supplied,token))return 'controller';for(const bot of manager.store.list('bots'))if(same(supplied,bot.capabilityToken))return bot.id;fail('Unauthorized',401);};
  const json=(res,status,value)=>{const body=Buffer.from(JSON.stringify(value));res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':body.length,'Cache-Control':'private, no-store, no-transform'});res.end(body);};
  const server=createServer((req,res)=>{
    // A disconnected streaming client must not terminate the shared gateway.
    res.on('error',()=>{clients.delete(res);res.destroy();});
    res.once('close',()=>clients.delete(res));
    const work=(async()=>{
    try{const actor=authenticate(req),requestUrl=new URL(req.url,'http://localhost'),path=requestUrl.pathname;
      const runtimeTaskId=req.headers['x-summon-task-id'];
      if(actor!=='controller'&&path!=='/tools'&&!path.startsWith('/tools/')&&!/^\/capabilities\/[^/]+\/versions\/[^/]+\/tools\/[^/]+$/.test(path)&&path!=='/mcp')fail('Bot credentials only access authorized capability tools',403);
      if(actor!=='controller'&&(path.startsWith('/api/')||path.startsWith('/internal/')))fail('User API requires controller authentication',403);
      if(closing&&!path.startsWith('/internal/service/'))fail('Gateway is stopping; new requests are unavailable',503);
      if(req.method==='GET'&&path==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'});res.write('data: {"type":"connected"}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
      let body={};if(['POST','PATCH','PUT','DELETE'].includes(req.method)){
        const limit=['/api/attachments','/internal/service/invoke'].includes(path)?MAX_ATTACHMENT_REQUEST_BYTES:
          /^(?:\/capabilities\/[^/]+\/versions\/[^/]+)?\/tools\/(?:write_file|edit_file)$/.test(path)?MAX_FILE_REQUEST_BYTES:2*1024*1024;
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>limit)fail('Request too large',413);chunks.push(chunk);}
        body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      }
      if(req.method==='POST'&&path==='/internal/bots/stop-all')return json(res,200,await stopBots(body));
      if(req.method==='POST'&&path==='/internal/service/tools')return json(res,200,control.tools(manager.get(body.botId)));
      if(req.method==='POST'&&path==='/internal/service/invoke')return json(res,200,await rpc(body.capability,body.operation,body.args||[]));
      if(req.method==='POST'&&path==='/internal/service/event'){emit(required(body.type,'type',128),body.payload||{});return json(res,200,{accepted:true});}
      if(req.method==='GET'&&path==='/tools'){
        const current=actor!=='controller'&&runtimeTaskId?await manager.readState(actor,db=>db?.getTask(runtimeTaskId)):{};
        return json(res,200,{tools:visibleTools(actor).filter(tool=>actor==='controller'||permitsTool(current||{},tool))});
      }
      const pinnedTool=path.match(/^\/capabilities\/([^/]+)\/versions\/([^/]+)\/tools\/([^/]+)$/);
      if(req.method==='POST'&&pinnedTool){const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});return json(res,200,await callTool(decodeURIComponent(pinnedTool[3]),body.arguments||body,actor,abort.signal,{id:decodeURIComponent(pinnedTool[1]),version:decodeURIComponent(pinnedTool[2])},runtimeTaskId));}
      if(req.method==='POST'&&path.startsWith('/tools/')){const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});return json(res,200,await callTool(decodeURIComponent(path.slice(7)),body.arguments||body,actor,abort.signal,undefined,runtimeTaskId));}
      if(req.method==='POST'&&path==='/mcp'){
        if(body.jsonrpc!=='2.0'||typeof body.method!=='string')return json(res,400,{jsonrpc:'2.0',id:body.id??null,error:{code:-32600,message:'Invalid JSON-RPC request'}});
        if(body.id===undefined){res.writeHead(202);res.end();return;}
        try{let result;if(body.method==='initialize')result={protocolVersion:['2025-03-26','2024-11-05','2025-06-18'].includes(body.params?.protocolVersion)?body.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'summon-capabilities',version:'0.2.0'}};
          else if(body.method==='ping')result={};else if(body.method==='tools/list')result={tools:visibleTools(actor).map(({name,description,inputSchema})=>({name,description,inputSchema}))};
          else if(body.method==='tools/call'){try{const value=await callTool(body.params?.name,body.params?.arguments||{},actor,undefined,undefined,runtimeTaskId);result={content:[{type:'text',text:JSON.stringify(value)}],isError:false};}catch(error){const details={error:error.message,code:error.code,...(error.accessDenial?{accessDenial:error.accessDenial}:{})};result={content:[{type:'text',text:JSON.stringify(details)}],structuredContent:details,isError:true};}}
          else return json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}});return json(res,200,{jsonrpc:'2.0',id:body.id,result});
        }catch(error){return json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32603,message:error.message}});}
      }
      const attachment=path.match(/^\/api\/attachments\/([^/]+)(\/(?:preview|view))?$/);if(attachment&&['GET','HEAD'].includes(req.method)){const file=await attachments.read(attachment[1],attachment[2]==='/view'?'view':Boolean(attachment[2]));res.writeHead(200,file.headers);res.end(req.method==='HEAD'?undefined:file.bytes);return;}
      const artifact=path.match(/^\/api\/agent-runs\/([^/]+)\/tools\/([^/]+)\/artifacts\/([^/]+)$/);if(artifact&&['GET','HEAD'].includes(req.method)){if(requestUrl.search)fail('Artifact IDs only',404);const file=await downloads.read(...artifact.slice(1).map(decodeURIComponent));try{res.writeHead(200,file.headers);if(req.method==='HEAD'||file.size===0)res.end();else await pipeline(file.handle.createReadStream({autoClose:false,start:0,end:file.size-1}),res);}finally{await file.close();}return;}
      const result=await handleApi(req.method,path,body,requestUrl.searchParams);if(result===undefined)fail('Not found',404);
      if(req.method==='GET'&&result.sync&&requestUrl.searchParams.get('pages')==='1'){
        res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'private, no-store, no-transform'});
        await pipeline(Readable.from(syncPages(result)),res);
      }else json(res,req.method==='POST'&&path==='/api/works'&&!result.dispatch?.duplicate?202:200,result);
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:catalog.clean(String(error.message)),...(error.code?{code:error.code}:{}),...(error.outcomeUnknown?{outcomeUnknown:true}:{}),...(error.accessDenial?{accessDenial:JSON.parse(catalog.clean(JSON.stringify(error.accessDenial)))}:{})});else res.end();}
  })();pending.add(work);void work.catch(error=>console.error('Gateway request failed:',error.stack||error.message)).finally(()=>pending.delete(work));});
  async function stopIdleWorkers() {
    for(const service of await supervisor.list())if(service.state!=='stopped'&&!service.pendingWork&&!service.activeRequests){
      try{await supervisor.stop(service.id,service.version);}catch(error){if(error.code!=='CAPABILITY_BUSY')throw error;}
    }
  }
  async function registerWorker(input) {
    const instance=await supervisor.start(input);
    if(registry.getVersion(input.id,input.version))await registry.relocate(input.id,input.version,{endpoint:instance.url,token:instance.token});
    else await registry.register({id:input.id,version:input.version,endpoint:instance.url,token:instance.token,stateVersion:input.stateVersion||'1'});
    return instance;
  }
  async function invokeManagedVersions(id,operation,args=[]) {
    const results=[];
    for(const version of registry.inventory().versions.filter(item=>item.capabilityId===id)){
      if(!await managedConfig(id,version.version))continue;
      const status=await supervisor.status(id,version.version);
      if(status.state!=='stopped')results.push(await rpc(id,operation,args,version.version));
    }
    return results;
  }
  function requiredManagedVersions() {
    const transitions=control.inventory().switches.filter(item=>item.phase!=='complete');
    return registry.inventory().versions.filter(entry=>{
      const ownsJob=entry.capabilityId==='chatroom'&&chatroom.jobs().some(job=>job.serviceVersion===entry.version&&['queued','accepted','running','waiting'].includes(job.status));
      const switching=transitions.some(item=>item.bindings?.[entry.capabilityId]===entry.version||item.previousBindings?.[entry.capabilityId]===entry.version);
      return entry.accepting||entry.bindingCount||entry.unknownRequests.length||ownsJob||switching;
    });
  }
  async function managedConfig(id,version) {
    try{return JSON.parse(await readFile(supervisor.paths(id,version).config,'utf8'));}catch(error){if(error.code==='ENOENT'||error.code==='INVALID_REQUEST')return null;throw error;}
  }
  async function monitorServices() {
    if(serviceMonitoring||closing||quiescing)return;serviceMonitoring=true;
    try{for(const entry of requiredManagedVersions()){
      if(closing||quiescing)break;
      const key=`${entry.capabilityId}@${entry.version}`,prior=store('registry').get('service-restarts',key);
      if(prior?.nextAttemptAt&&Date.parse(prior.nextAttemptAt)>Date.now())continue;
      const attempts=(prior?.attempts||0)+1;
      try{
        const config=await managedConfig(entry.capabilityId,entry.version);if(!config)continue;
        const identity=await supervisor.descriptor(entry.capabilityId,entry.version);
        if(identity&&identity.state!=='stopped')continue;
        store('registry').save('service-restarts',{id:key,attempts,lastAttemptAt:now(),nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**Math.min(attempts,6))).toISOString()});
        const instance=await registerWorker({id:entry.capabilityId,version:entry.version,stateVersion:config.stateVersion,module:config.module,options:{...config.options,gatewayUrl:url,gatewayToken:token,deferStart:true}});
        if(['bot-management','chatroom'].includes(entry.capabilityId))await rpc(entry.capabilityId,'resumeService',[],entry.version);
        store('registry').save('service-restarts',{id:key,attempts:0,nextAttemptAt:null,error:null,restartedAt:now()});
        emit('capability-restarted',{id:entry.capabilityId,version:entry.version,pid:instance.pid});
      }catch(error){
        store('registry').save('service-restarts',{id:key,attempts,error:error.message,nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**Math.min(attempts,6))).toISOString()});
        emit('capability-service-error',{id:entry.capabilityId,version:entry.version,error:error.message});
      }
    }}finally{serviceMonitoring=false;}
  }
  try {
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(options.port||0,options.host||'127.0.0.1',done);});url=`http://${options.host==='::1'?'[::1]':'127.0.0.1'}:${server.address().port}`;
    await options.onListening?.({url,port:server.address().port});
    await mkdir(join(dataRoot,'capabilities','gateway'),{recursive:true});await writeFile(join(dataRoot,'capabilities','gateway','run.json'),JSON.stringify({pid:process.pid,url,startedAt:now()}));
    let build;
    try{build=JSON.parse(await readFile(join(releaseRoot,'release-manifest.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    const version=options.capabilityVersion||build?.buildId||'1.0.0';
    const workerOptions={dataRoot,releaseRoot,defaultCwd,model:options.model,gatewayUrl:url,gatewayToken:token,deferStart:true,...(build?.contentHash?{contentHash:build.contentHash}:{})};
    for(const id of BUILTIN_CAPABILITIES){
      const previouslyRegistered=registry.inventory().services.some(service=>service.id===id);
      await registerWorker({id,version,module:join(releaseRoot,'capabilities/services/builtin.mjs'),options:workerOptions});
      if(!previouslyRegistered)registry.activate(id,version);
    }
    for(const id of ['bot-management','chatroom'])await invokeManagedVersions(id,'resumeService');
    if(options.seed!==false){await manager.seed();await chatroom.seed();}
    control.pinExisting();await control.tick();
    if(options.restore!==false){await manager.restore();await profiles.restore();}
  } catch(error) {
    closing=true;await push.close();await profiles.close();await native.close();await control.close();await catalog.close();await stopIdleWorkers().catch(()=>{});for(const client of clients)client.end();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));await Promise.allSettled([...pending]);manager.closeReadStores();for(const value of stores.values())value.close();usageLedger.close();throw error;
  }
  const monitor=setInterval(async()=>{if(monitoring||closing||quiescing)return;monitoring=true;try{await manager.monitor();}catch(error){emit('gateway-error',{error:error.message});}finally{monitoring=false;}},5000);monitor.unref();
  const serviceMonitor=setInterval(()=>{void monitorServices().catch(error=>emit('gateway-error',{error:error.message}));},2000);serviceMonitor.unref();
  let polling=false;const eventPoll=setInterval(async()=>{if(polling||closing)return;polling=true;try{for(const bot of manager.list()){const cursor=store('gateway').get('event-cursors',bot.id)?.after||0;const events=await manager.readState(bot.id,db=>db?.listEvents({after:cursor,limit:1000})||[]);if(events.length){store('gateway').save('event-cursors',{id:bot.id,after:events.at(-1).seq});emit('bot-event',{botId:bot.id,eventType:events.at(-1).type});}}if(!quiescing){await catalog.tick();await onboarding.tick();await profiles.tick();}}catch(error){emit('gateway-error',{error:error.message});}finally{polling=false;}},750);eventPoll.unref();
  const scheduler=setInterval(async()=>{if(ticking||closing||quiescing)return;ticking=true;try{await tickRoutines({manager,chatroom});await native.tick();}catch(error){emit('gateway-error',{error:error.message});}finally{ticking=false;}},1000);scheduler.unref();
  const switches=setInterval(()=>{if(!closing&&!quiescing)void control.tick().catch(error=>emit('gateway-error',{error:error.message}));},300);switches.unref();
  const heartbeat=setInterval(()=>{for(const client of clients)client.write(': keepalive\n\n');},20000);heartbeat.unref();
  function stopBots(stopOptions={}) {return stopBotsPromise||=(async()=>{
    quiescing=true;manager.quiescing=true;
    while(serviceMonitoring)await new Promise(done=>setTimeout(done,10));
    await invokeManagedVersions('chatroom','pause');chatroom.closed=true;
    await invokeManagedVersions('bot-management','quiesce');
    while(ticking||monitoring)await new Promise(done=>setTimeout(done,10));
    return manager.shutdownAll(stopOptions);
  })().catch(error=>{stopBotsPromise=null;throw error;});}
  let closePromise;const close=()=>closePromise||=(async()=>{
    closing=true;await push.close();clearInterval(scheduler);clearInterval(heartbeat);clearInterval(monitor);clearInterval(serviceMonitor);clearInterval(eventPoll);clearInterval(switches);
    await modelConnections.close();await profiles.close();await native.close();await control.close();await catalog.close();while(ticking||monitoring||serviceMonitoring||polling)await new Promise(done=>setTimeout(done,10));
    while(pending.size)await Promise.allSettled([...pending]);
    await stopIdleWorkers();for(const client of clients)client.end();
    await new Promise(done=>{server.close(done);server.closeIdleConnections?.();});
    await Promise.allSettled([...pending]);manager.closeReadStores();for(const value of stores.values())value.close();usageLedger.close();
  })();
  return {url,token,server,manager,chatroom,knowledge,memories,attachments,registry,supervisor,control,catalog,state,handleApi,callTool,monitorServices,stopBots,close};
}
