import { createServer } from 'node:http';
import { randomBytes,timingSafeEqual,randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RecordStore } from '../shared/store.mjs';
import { IncrementalSync } from '../shared/sync.mjs';
import { RunArtifactDownloads,projectRunArtifacts } from '../shared/run-artifacts.mjs';
import { BotManager } from '../bot-management/service.mjs';
import { tickRoutines } from '../bot-management/routines.mjs';
import { ChatroomService } from '../chatroom/service.mjs';
import { AttachmentStore,MAX_ATTACHMENT_REQUEST_BYTES } from '../chatroom/attachments.mjs';
import { KnowledgeService } from '../knowledge/service.mjs';
import { MemoryManagement } from '../memory-management/service.mjs';
import { fail,required,now } from '../shared/validation.mjs';
import { CapabilityRegistry } from '../services/registry.mjs';
import { CapabilityControl,controlTools } from '../services/control.mjs';
import { CapabilityServiceSupervisor } from '../services/supervisor.mjs';
import { BUILTIN_CAPABILITIES } from '../services/builtin.mjs';
import { deployCapability } from '../services/publish.mjs';
import { coreTools } from '../../bot/src/capabilities/core-tools.mjs';
import { assertToolPolicy, permitsTool, permitsMaintenanceTool, taskMode } from '../../bot/src/capabilities/task-policy.mjs';
import { CapabilityCatalog,catalogTools } from '../services/catalog.mjs';
import { UsageLedger,readUsage,usageRange,finishUsageTotals,emptyUsageTotals,USAGE_PRICING } from '../../bot/src/agent/usage.mjs';
import { ModelConnections } from '../models/service.mjs';

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
  const botToolNames=[...coreTools({},{}).map(tool=>tool.name),'read_resource','read_session_history','knowledge_list','knowledge_read','knowledge_write','skills_list','skill_write'];
  const registry=new CapabilityRegistry({store:store('registry'),emit,reservedTools:[...botToolNames,...controlTools.map(tool=>tool.name),...catalogTools.map(tool=>tool.name)]});
  const supervisor=new CapabilityServiceSupervisor({dataRoot,releaseRoot});
  let control;
  const manager=new BotManager({store:store('bot-management'),dataRoot,releaseRoot,defaultCwd,model:options.model,emit,botApi:options.botApi,cacheReadStores:true,gatewayUrl:()=>url,getTools:bot=>control.tools(bot)});
  const deploy=args=>deployCapability(args,{dataRoot,defaultCwd,model:options.model,codexPath:options.codexPath,gatewayUrl:url,gatewayToken:token,supervisor,registry,control});
  control=new CapabilityControl({registry,supervisor,manager,store:store('registry'),gatewayUrl:()=>url,emit,deploy});
  const rpc=(id,operation,args=[],version)=>{
    const selected=version||registry.active(id)?.version;
    if(!selected)fail(`Capability ${id} has no active service`,503);
    return registry.invokeVersion(id,selected,operation,args,{context:{actor:'controller'}});
  };
  const proxy=(target,id,names)=>{for(const name of names)target[name]=(...args)=>rpc(id,name,args);};
  proxy(manager,'bot-management',['create','update','start','stop','send','saveRoutine','seed','restore','monitor','quiesce','shutdownAll','connect','ensureCatalogMaintainer','setCatalogMaintainerState']);
  const attachments=new AttachmentStore(join(dataRoot,'capabilities','chatroom'));
  const chatroom=new ChatroomService({store:store('chatroom'),manager,attachments,emit});
  const knowledge=new KnowledgeService({store:store('knowledge'),emit}),memories=new MemoryManagement({store:store('memory-management'),manager,dataRoot,emit});
  proxy(chatroom,'chatroom',['createRoom','updateRoom','post','append','dm','conclude','saveConclusion','retry','seed','teamRead','teamRaise','teamManage']);
  const catalog=new CapabilityCatalog({store:store('registry'),registry,manager,dataRoot,workspace:defaultCwd,emit,delegate:(actor,input)=>chatroom.dm(actor,input)});
  proxy(knowledge,'knowledge',['saveNode','saveEdge']);
  proxy(memories,'memory-management',['write']);
  proxy(attachments,'chatroom',['upload']);
  const codex={store:store('codex'),list:()=>store('codex').list('works'),require:id=>{const work=store('codex').get('works',id);if(!work)fail('Work not found',404);return work;},
    get:id=>{const work=store('codex').get('works',id);return work?{...work,events:store('codex').list('workEvents').filter(event=>event.workId===id)}:null;},
    create:input=>rpc('codex','create',[input])};
  for(const operation of ['send','interrupt','read'])codex[operation]=(id,args)=>rpc('codex',operation,[id,args||{}]);
  codex.attach=input=>rpc('codex','attach',[input]);
  const publicWork=(botId,work)=>({...work,id:`${botId}~${work.id}`,workId:work.id,botId,summary:work.progress,roomId:work.sources?.find(source=>source.roomId)?.roomId});
  async function localWorks() {
    const groups=await Promise.all(manager.list().map(async bot=>manager.readState(bot.id,db=>(db?.listRecords('works')||[]).map(work=>publicWork(bot.id,work)))));
    return groups.flat();
  }
  async function localWork(id) {
    const split=id.indexOf('~');if(split<0)return null;
    const botId=id.slice(0,split),workId=id.slice(split+1);manager.get(botId);
    return manager.readState(botId,db=>{const work=db?.getRecord('works',workId);return work?{...publicWork(botId,work),events:db.listEvents({workId,limit:200})}:null;});
  }
  const sync=new IncrementalSync(store('gateway'));
  async function ownRun(id) {
    for(const bot of manager.list()){
      const full=await manager.readState(bot.id,db=>{const task=db?.getTask(id);return task?{...task,tools:db.listTools(id)}:null;});
      if(full)return {id,...full,botId:bot.id,summary:full.result?.content||full.summary||'',sessionId:full.sessionId,roomId:full.sessionId?.replace(/^room:/,'')};
    }return null;
  }
  const downloads=new RunArtifactDownloads({getRun:ownRun,resolveRoot:run=>({dataRoot,artifactRoot:join(manager.directory(run.botId),'artifacts')}),tempRoot:join(dataRoot,'capabilities','gateway','tmp','downloads')});
  async function state() {
    const agentRuns=[],providers=[];
    await Promise.all(manager.list().map(async bot=>{
      // A single durable snapshot per Bot avoids reopening its database for every
      // historical task and reading every full tool result on every UI refresh.
      const snapshot=await manager.readState(bot.id,db=>{
        if(!db)return {tasks:[],counts:{},lastTools:{}};
        return {tasks:db.listTasks().slice(-100),
          counts:Object.fromEntries(db.db.prepare('SELECT task_id,COUNT(*) AS count FROM tools GROUP BY task_id').all().map(row=>[row.task_id,row.count])),
          lastTools:Object.fromEntries(db.db.prepare(`SELECT task_id,
            COALESCE(json_extract(data,'$.name'),json_extract(data,'$.toolName')) AS name,
            json_extract(data,'$.status') AS status,
            COALESCE(json_extract(data,'$.args.path'),json_extract(data,'$.args.filePath')) AS path,
            COALESCE(json_extract(data,'$.args.to'),json_extract(data,'$.args.targetBotId'),json_extract(data,'$.args.toBotId'),json_extract(data,'$.args.botId'),json_extract(data,'$.args.childId')) AS targetBotId,
            json_extract(data,'$.startedAt') AS startedAt,json_extract(data,'$.finishedAt') AS finishedAt
            FROM tools WHERE rowid IN (SELECT MAX(rowid) FROM tools GROUP BY task_id)`)
            .all().map(row=>[row.task_id,toolActivity(row)]))};
      });
      for(const task of snapshot.tasks)agentRuns.push({id:task.id||task.taskId,...task,botId:bot.id,summary:task.result?.content||task.summary||'',toolCount:task.result?.toolsCalled??snapshot.counts[task.id||task.taskId]??0,lastTool:snapshot.lastTools[task.id||task.taskId]||null,roomId:task.sessionId?.replace(/^room:/,'')});
      try{const health=await manager.request(bot.id,'/health',{signal:AbortSignal.timeout(2000)});if(health.engine?.provider)providers.push(health.engine.provider);}catch{}
    }));
    agentRuns.sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
    const messages=chatroom.store.list('messages'),jobs=chatroom.jobs(),runtime={started:true,fast:{running:jobs.filter(job=>['running','accepted'].includes(job.status)).length,queued:jobs.filter(job=>job.status==='queued').length},deep:{running:0,queued:0},jobs:jobs.slice(-80)};
    const selection=modelConnections.runtimeModel();
    const latestProvider=providers.filter(provider=>provider.connectionId===selection.id).sort((a,b)=>String(b.lastSuccessAt||'').localeCompare(String(a.lastSuccessAt||'')))[0]||{};
    return {historyEpoch,bots:manager.list(),rooms:chatroom.rooms(),routines:manager.store.list('routines'),knowledge:knowledge.graph(),runtime,activity:messages.filter(message=>message.returnTo||message.peerReplyId||['event','work'].includes(message.kind)).slice(-100),works:[...await localWorks(),...codex.list().filter(work=>work.backend!=='desktop').map(work=>({...work,historical:true}))],agentRuns:agentRuns.slice(-100),provider:{configured:Boolean((await modelConnections.credentials.read(selection.id).catch(()=>null))||selection.allowNoKey),model:selection.model,...latestProvider},defaultCwd};
  }
  function visibleTools(actor) {
    const allowed=actor==='controller'?null:manager.get(actor).allowedTools||[];
    return [...registry.toolsFor(actor,allowed),...controlTools.filter(tool=>allowed===null||allowed.includes(tool.name)),...catalogTools.filter(tool=>allowed===null||allowed.includes(tool.name))];
  }
  async function callTool(name,args={},actor='controller',signal,pin,taskId) {
    const definition=visibleTools(actor).find(tool=>tool.name===name);
    if(quiescing&&definition?.effect!=='read')fail('Gateway is stopping; new work is unavailable',503);
    if(actor!=='controller'&&!(manager.store.get('bots',actor)?.allowedTools||[]).includes(name))fail('Tool not authorized for this Bot',403);
    const {_context,...input}=args;args=input;
    let task;
    if(actor!=='controller'){
      if(taskId){
        task=await manager.readState(actor,db=>db?.getTask(taskId));
        const notification=task?.metadata?.notificationId&&name==='chatroom_send'
          ?await manager.readState(actor,db=>db?.getRecord('work-notifications',task.metadata.notificationId)):null;
        const publishing=notification&&notification.frontendContent===args.content&&notification.id===args.clientId&&notification.roomId===args.roomId;
        if(!task||(task.status!=='running'&&!publishing))fail('An active task owned by this Bot is required',403);
        assertToolPolicy(task,definition,args);
      }else if(!permitsMaintenanceTool(name))fail('A runtime task context is required',403);
    }
    if(catalogTools.some(tool=>tool.name===name)){
      const current=task?.input?.current||task?.input,work=task?.workId&&await manager.readState(actor,db=>db?.getRecord('works',task.workId));
      const source=work?.sources?.findLast(item=>item.roomId)||{};
      const provenance=task?{workId:task.workId,conversationId:task.conversationId,originRoomId:current?.room?.id||source.roomId,
        originMessageId:current?.trigger?.id||source.replyTo,sourceRefs:[`task:${task.id}`]}:undefined;
      return catalog.call(name,{...args,...(provenance?{_context:provenance}:{})},{actor,signal,task});
    }
    if(controlTools.some(tool=>tool.name===name))return control.call(name,args,{actor});
    if(pin&&!control.permittedVersion(actor,pin.id,pin.version))fail('This capability version is not bound to the Bot',403);
    const context={actor,...(task?{taskId:task.id,workId:task.workId,mode:taskMode(task)}:{})};
    if(pin)return registry.callVersion(pin.id,pin.version,name,args,{signal,context});
    return registry.call(actor,name,args,{signal,context});
  }
  async function tokenUsage(params) {
    const range=usageRange(params.get('period')||'today'),botId=params.get('botId')||null;
    const roomId=params.has('roomId')?(params.get('roomId')||null):undefined;
    const offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||25);
    if(!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('无效的用量分页',400);
    return usageLedger.snapshot(()=>{
    const snapshot=readUsage(usageLedger.db,range,{roomId,botId,offset,limit});
    const profiles=manager.list(),botsById=new Map(profiles.map(bot=>[bot.id,bot])),roomsById=new Map(chatroom.rooms().map(room=>[room.id,room]));
    const bots=snapshot.bots.map(row=>({...row,id:row.key,name:botsById.get(row.key)?.name||row.name||row.key,kind:'bot',removed:!botsById.has(row.key)}));
    if(!botId&&roomId===undefined)for(const bot of profiles)if(!bots.some(row=>row.id===bot.id))bots.push({...finishUsageTotals(emptyUsageTotals()),id:bot.id,name:bot.name,kind:'bot'});
    const rooms=snapshot.rooms.map(row=>({...row,id:row.key,name:roomsById.get(row.key)?.name||row.name||(row.key?'已移除的会话':'未归属会话'),kind:roomsById.get(row.key)?.kind||row.kind||'unassigned'}));
    const providerReports=usageLedger.providerReports(range).map(report=>{
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
    if(method==='GET'&&path==='/api/usage')return tokenUsage(params);
    if(path==='/api/model-settings'&&method==='GET')return modelConnections.snapshot();
    if(path==='/api/model-settings/connections'&&method==='POST')return modelConnections.save(body);
    if(path==='/api/model-settings/codex/import'&&method==='POST')return modelConnections.importCodex();
    if(path==='/api/model-settings/active'&&method==='POST')return modelConnections.select(body.id);
    if(path==='/api/model-settings/usage'&&method==='POST')return modelConnections.refreshUsage(body.force===true);
    if((match=path.match(/^\/api\/model-settings\/connections\/([A-Za-z0-9_-]+)(?:\/(login|models))?$/))){
      const id=match[1],action=match[2];
      if(!action&&method==='DELETE')return modelConnections.remove(id);
      if(action==='models'&&method==='GET')return modelConnections.choices(id,params.get('discover')==='1');
      if(action==='login'){
        if(method==='GET')return modelConnections.loginStatus(id);
        if(method==='POST')return modelConnections.startLogin(id);
        if(method==='DELETE'){modelConnections.cancelLogin(id);return modelConnections.loginStatus(id);}
      }
    }
    if(path==='/api/catalog'){
      if(method==='GET')return catalog.search({query:params.get('query')||'',kind:params.get('kind')||undefined,scopeRefs:params.getAll('scopeRef'),offset:Number(params.get('offset')||0),limit:Number(params.get('limit')||40)},params.get('botId')||'controller');
      if(method==='POST')return catalog.save(body);
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
    if(method==='GET'&&path==='/api/state'){const value=await state();return params.get('sync')==='1'?{...sync.respond('workspace',value,params.get('since')),historyEpoch}:value;}
    if(method==='GET'&&path==='/api/bots')return {bots:manager.list()};
    if(method==='POST'&&path==='/api/bots')return manager.create(body);
    if((match=path.match(/^\/api\/bots\/([^/]+)\/contacts$/))){const id=decodeURIComponent(match[1]);if(method==='GET')return manager.contacts(id);if(method==='POST')return manager.connect(id,body.botId,{enabled:body.enabled??true});}
    if((match=path.match(/^\/api\/bots\/([^/]+)$/))&&method==='PATCH')return manager.update(decodeURIComponent(match[1]),body);
    if((match=path.match(/^\/api\/bots\/([^/]+)\/memories$/))){const id=decodeURIComponent(match[1]);if(method==='GET')return {memories:(await memories.list(id)).map(memory=>({...memory,content:memory.text}))};if(method==='POST')return memories.write(id,body);}
    if((match=path.match(/^\/api\/memories\/([^/]+)$/))&&method==='PATCH'){for(const bot of manager.list()){const found=(await memories.list(bot.id)).find(memory=>memory.id===decodeURIComponent(match[1]));if(found)return memories.write(bot.id,{...body,id:found.id,expectedRevision:body.expectedRevision??found.revision});}fail('Memory not found',404);}
    if(method==='GET'&&path==='/api/rooms')return {rooms:chatroom.rooms()};
    if(method==='POST'&&path==='/api/rooms')return chatroom.createRoom(body);
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/team(?:\/(raise|manage))?$/))){const input={...body,roomId:decodeURIComponent(match[1])};if(method==='GET'&&!match[2])return chatroom.teamRead(input,'controller');if(method==='POST'&&match[2])return chatroom[match[2]==='raise'?'teamRaise':'teamManage'](input,'controller');}
    if((match=path.match(/^\/api\/rooms\/([^/]+)$/))&&method==='PATCH')return chatroom.updateRoom(decodeURIComponent(match[1]),body);
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/messages$/))){const id=decodeURIComponent(match[1]);if(method==='GET'){const value={historyEpoch,room:chatroom.need('rooms',id),messages:chatroom.messages(id),jobs:chatroom.jobs(id)};return params.get('sync')==='1'?{...sync.respond(`room:${id}`,value,params.get('since')),historyEpoch}:value;}if(method==='POST')return chatroom.post(id,body);}
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/conclude$/))&&method==='POST')return chatroom.conclude(decodeURIComponent(match[1]));
    if(method==='GET'&&path==='/api/knowledge/search'){const result=knowledge.search(params.get('q')||'');return {...result,memories:params.get('botId')?(await memories.list(params.get('botId'))).map(memory=>({...memory,content:memory.text})):[]};}
    if(method==='GET'&&path==='/api/knowledge/graph')return knowledge.graph(params.get('id'),params.get('depth'));
    if(method==='POST'&&path==='/api/knowledge/nodes')return knowledge.saveNode(body);
    if((match=path.match(/^\/api\/knowledge\/nodes\/([^/]+)$/))&&method==='PATCH')return knowledge.saveNode({...body,id:decodeURIComponent(match[1])});
    if(method==='POST'&&path==='/api/knowledge/edges')return knowledge.saveEdge(body);
    if(method==='POST'&&path==='/api/routines')return manager.saveRoutine(body);
    if((match=path.match(/^\/api\/routines\/([^/]+)$/))&&method==='PATCH')return manager.saveRoutine({...body,id:decodeURIComponent(match[1])});
    if(method==='POST'&&path==='/api/events'){const event=await chatroom.post(body.roomId||'room-lobby',{...body,toBotId:body.botId,kind:'event',notify:true},'system');return {event,jobs:chatroom.jobs().filter(job=>job.messageId===event.id)};}
    if(method==='GET'&&path==='/api/jobs')return {jobs:chatroom.jobs()};
    if((match=path.match(/^\/api\/jobs\/([^/]+)\/retry$/))&&method==='POST')return chatroom.retry(decodeURIComponent(match[1]));
    if(method==='POST'&&path==='/api/works'){
      manager.get(body.botId);await manager.start(body.botId);
      const work=await manager.request(body.botId,'/works',{method:'POST',body:JSON.stringify({id:body.id||randomUUID(),goal:body.goal,requirements:[body.constraints,body.cwd?`工作目录：${body.cwd}`:'',...(body.inputRefs||[])].filter(Boolean).join('\n'),sources:[{source:'controller',roomId:body.roomId}]})});
      await manager.request(body.botId,`/works/${encodeURIComponent(work.id)}/events`,{method:'POST',body:JSON.stringify({id:'initial',kind:'request',content:{goal:work.goal,requirements:work.requirements,authority:'user',instruction:'推进此工作，按当前要求记录进度、等待和完成状态。仅在需要时使用Codex等外部能力。'},metadata:{actor:'user',priority:'foreground'}})});
      return publicWork(body.botId,work);
    }
    if((match=path.match(/^\/api\/works\/([^/]+)(?:\/(send|pause|cancel|resume))?$/))){
      const id=decodeURIComponent(match[1]),work=await localWork(id);
      if(method==='GET'&&!match[2])return work||codex.get(id);
      if(method==='POST'&&match[2]){
        if(!work)fail('Historical external work is read-only',409);await manager.start(work.botId);
        const endpoint=`/works/${encodeURIComponent(work.workId)}`;
        if(match[2]==='send')return manager.request(work.botId,`${endpoint}/events`,{method:'POST',body:JSON.stringify({id:body.id||randomUUID(),kind:'request',content:body.message,metadata:{actor:'user',priority:'foreground',correction:true}})});
        const status={pause:'paused',cancel:'cancelled',resume:'active'}[match[2]];
        const changed=await manager.request(work.botId,endpoint,{method:'PATCH',body:JSON.stringify({status})});
        if(match[2]==='cancel'){
          for(const binding of work.bindings||[])if(binding.type==='codex-desktop'&&binding.externalThreadId){
            try { const observed=await codex.read(binding.id,{}),turn=observed.observed?.currentTurn;
              if(turn?.id&&turn.status==='inProgress')await codex.interrupt(binding.id,{operationId:`cancel:${work.revision}`,expectedTurnId:turn.id});
            }catch(error){changed.lastError={message:`本地工作已取消；外部停止尚未确认：${error.message}`};await manager.request(work.botId,endpoint,{method:'PATCH',body:JSON.stringify({lastError:changed.lastError})});}
          }
        }
        if(match[2]==='resume')await manager.request(work.botId,`${endpoint}/events`,{method:'POST',body:JSON.stringify({id:body.id||randomUUID(),kind:'request',content:'用户要求继续此工作。先核对既有执行和未知结果，沿原绑定继续。',metadata:{actor:'user',priority:'foreground'}})});
        return publicWork(work.botId,changed);
      }
    }
    if((match=path.match(/^\/api\/agent-runs\/([^/]+)(?:\/(cancel))?$/))){const run=await ownRun(decodeURIComponent(match[1]));if(!run)fail('Run not found',404);if(method==='GET')return projectRunArtifacts(run);if(method==='POST'&&match[2])return manager.request(run.botId,`/tasks/${encodeURIComponent(run.id)}/cancel`,{method:'POST',body:'{}'});}
    if(method==='POST'&&path==='/api/attachments')return attachments.upload(body);
    return undefined;
  }
  const authenticate=req=>{const supplied=req.headers.authorization?.replace(/^Bearer /,'');if(same(supplied,token))return 'controller';for(const bot of manager.store.list('bots'))if(same(supplied,bot.capabilityToken))return bot.id;fail('Unauthorized',401);};
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
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
      let body={};if(['POST','PATCH','PUT','DELETE'].includes(req.method)){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(path==='/api/attachments'?MAX_ATTACHMENT_REQUEST_BYTES:2*1024*1024))fail('Request too large',413);chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
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
          else if(body.method==='tools/call'){try{const value=await callTool(body.params?.name,body.params?.arguments||{},actor,undefined,undefined,runtimeTaskId);result={content:[{type:'text',text:JSON.stringify(value)}],isError:false};}catch(error){result={content:[{type:'text',text:error.message}],isError:true};}}
          else return json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}});return json(res,200,{jsonrpc:'2.0',id:body.id,result});
        }catch(error){return json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32603,message:error.message}});}
      }
      const attachment=path.match(/^\/api\/attachments\/([^/]+)(\/preview)?$/);if(attachment&&['GET','HEAD'].includes(req.method)){const file=await attachments.read(attachment[1],Boolean(attachment[2]));res.writeHead(200,file.headers);res.end(req.method==='HEAD'?undefined:file.bytes);return;}
      const artifact=path.match(/^\/api\/agent-runs\/([^/]+)\/tools\/([^/]+)\/artifacts\/([^/]+)$/);if(artifact&&['GET','HEAD'].includes(req.method)){if(requestUrl.search)fail('Artifact IDs only',404);const file=await downloads.read(...artifact.slice(1).map(decodeURIComponent));try{res.writeHead(200,file.headers);if(req.method==='HEAD'||file.size===0)res.end();else await pipeline(file.handle.createReadStream({autoClose:false,start:0,end:file.size-1}),res);}finally{await file.close();}return;}
      const result=await handleApi(req.method,path,body,requestUrl.searchParams);if(result===undefined)fail('Not found',404);json(res,200,result);
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:catalog.clean(String(error.message)),...(error.code?{code:error.code}:{}),...(error.outcomeUnknown?{outcomeUnknown:true}:{})});else res.end();}
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
      const ownsJob=entry.capabilityId==='codex'?codex.list().some(work=>work.backend==='desktop'&&work.serviceVersion===entry.version&&!['completed','failed','cancelled','interrupted'].includes(work.status)):entry.capabilityId==='chatroom'&&chatroom.jobs().some(job=>job.serviceVersion===entry.version&&['queued','accepted','running','waiting'].includes(job.status));
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
        if(['bot-management','chatroom','codex'].includes(entry.capabilityId))await rpc(entry.capabilityId,'resumeService',[],entry.version);
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
    const workerOptions={dataRoot,releaseRoot,defaultCwd,model:options.model,codexPath:options.codexPath,gatewayUrl:url,gatewayToken:token,deferStart:true,...(build?.contentHash?{contentHash:build.contentHash}:{})};
    for(const id of BUILTIN_CAPABILITIES){
      const previouslyRegistered=registry.inventory().services.some(service=>service.id===id);
      await registerWorker({id,version,module:join(releaseRoot,'capabilities/services/builtin.mjs'),options:workerOptions});
      if(!previouslyRegistered)registry.activate(id,version);
    }
    for(const id of ['bot-management','chatroom','codex'])await invokeManagedVersions(id,'resumeService');
    if(options.seed!==false){await manager.seed();await chatroom.seed();}
    control.pinExisting();await control.tick();
    if(options.restore!==false)await manager.restore();
  } catch(error) {
    closing=true;await control.close();await catalog.close();await stopIdleWorkers().catch(()=>{});for(const client of clients)client.end();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));await Promise.allSettled([...pending]);manager.closeReadStores();for(const value of stores.values())value.close();usageLedger.close();throw error;
  }
  const monitor=setInterval(async()=>{if(monitoring||closing||quiescing)return;monitoring=true;try{await manager.monitor();}catch(error){emit('gateway-error',{error:error.message});}finally{monitoring=false;}},5000);monitor.unref();
  const serviceMonitor=setInterval(()=>{void monitorServices().catch(error=>emit('gateway-error',{error:error.message}));},2000);serviceMonitor.unref();
  let polling=false;const eventPoll=setInterval(async()=>{if(polling||closing)return;polling=true;try{for(const bot of manager.list()){const cursor=store('gateway').get('event-cursors',bot.id)?.after||0;const events=await manager.readState(bot.id,db=>db?.listEvents({after:cursor,limit:1000})||[]);if(events.length){store('gateway').save('event-cursors',{id:bot.id,after:events.at(-1).seq});emit('bot-event',{botId:bot.id,eventType:events.at(-1).type});}}if(!quiescing)await catalog.tick();}catch(error){emit('gateway-error',{error:error.message});}finally{polling=false;}},750);eventPoll.unref();
  const scheduler=setInterval(async()=>{if(ticking||closing||quiescing)return;ticking=true;try{await tickRoutines({manager,chatroom});}catch(error){emit('gateway-error',{error:error.message});}finally{ticking=false;}},1000);scheduler.unref();
  const switches=setInterval(()=>{if(!closing&&!quiescing)void control.tick().catch(error=>emit('gateway-error',{error:error.message}));},300);switches.unref();
  const heartbeat=setInterval(()=>{for(const client of clients)client.write(': keepalive\n\n');},20000);heartbeat.unref();
  function stopBots(stopOptions={}) {return stopBotsPromise||=(async()=>{
    quiescing=true;manager.quiescing=true;
    while(serviceMonitoring)await new Promise(done=>setTimeout(done,10));
    await invokeManagedVersions('chatroom','pause');chatroom.closed=true;
    await invokeManagedVersions('codex','pause');
    await invokeManagedVersions('bot-management','quiesce');
    while(ticking||monitoring)await new Promise(done=>setTimeout(done,10));
    return manager.shutdownAll(stopOptions);
  })().catch(error=>{stopBotsPromise=null;throw error;});}
  let closePromise;const close=()=>closePromise||=(async()=>{
    closing=true;clearInterval(scheduler);clearInterval(heartbeat);clearInterval(monitor);clearInterval(serviceMonitor);clearInterval(eventPoll);clearInterval(switches);
    await modelConnections.close();await control.close();await catalog.close();while(ticking||monitoring||serviceMonitoring||polling)await new Promise(done=>setTimeout(done,10));
    while(pending.size)await Promise.allSettled([...pending]);
    await stopIdleWorkers();for(const client of clients)client.end();
    await new Promise(done=>{server.close(done);server.closeIdleConnections?.();});
    await Promise.allSettled([...pending]);manager.closeReadStores();for(const value of stores.values())value.close();usageLedger.close();
  })();
  return {url,token,server,manager,chatroom,knowledge,codex,memories,attachments,registry,supervisor,control,catalog,state,handleApi,callTool,monitorServices,stopBots,close};
}

