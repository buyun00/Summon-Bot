import { createServer } from 'node:http';
import { randomBytes,timingSafeEqual,randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { RecordStore } from '../shared/store.mjs';
import { IncrementalSync } from '../shared/sync.mjs';
import { WorkspaceExecutionLock } from '../shared/workspace-lock.mjs';
import { RunArtifactDownloads,projectRunArtifacts } from '../shared/run-artifacts.mjs';
import { BotManager } from '../bot-management/service.mjs';
import { cleanTemporaryData } from '../bot-management/maintenance.mjs';
import { ChatroomService } from '../chatroom/service.mjs';
import { AttachmentStore,MAX_ATTACHMENT_REQUEST_BYTES } from '../chatroom/attachments.mjs';
import { KnowledgeService } from '../knowledge/service.mjs';
import { MemoryManagement } from '../memory-management/service.mjs';
import { CodexExecutor } from '../codex/executor.mjs';
import { createFileTools } from '../filesystem/tools.mjs';
import { fail,required,now,pick } from '../shared/validation.mjs';
import { toolDefinitions,FILE_TOOLS } from './tools.mjs';

const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const normalizeList=(value,key)=>Array.isArray(value)?value:value?.[key]||[];
export async function startGateway(options={}) {
  const dataRoot=resolve(required(options.dataRoot,'dataRoot')),releaseRoot=resolve(required(options.releaseRoot,'releaseRoot')),defaultCwd=resolve(options.defaultCwd||releaseRoot),token=options.token||randomBytes(32).toString('hex');
  if(!['127.0.0.1','::1'].includes(options.host||'127.0.0.1'))throw new Error('Capability gateway must use loopback');
  const clients=new Set(),stores=new Map(),pending=new Set();let url,closing=false,quiescing=false,ticking=false,monitoring=false,stopBotsPromise;
  const store=name=>{if(!stores.has(name))stores.set(name,new RecordStore(join(dataRoot,'capabilities',name,'state.sqlite')));return stores.get(name);};
  const emit=(type,payload={})=>{const line=`data: ${JSON.stringify({type,...payload})}\n\n`;for(const client of clients)client.write(line);};
  const manager=new BotManager({store:store('bot-management'),dataRoot,releaseRoot,defaultCwd,model:options.model,emit,botApi:options.botApi,gatewayUrl:()=>url,getTools:bot=>toolDefinitions.filter(tool=>(bot.allowedTools||[]).includes(tool.name)).map(tool=>({...tool,type:'http',url:`${url}/tools/${tool.name}`,method:'POST',timeoutMs:tool.name==='run_command'?130000:60000}))});
  const attachments=new AttachmentStore(join(dataRoot,'capabilities','chatroom'));
  const chatroom=new ChatroomService({store:store('chatroom'),manager,attachments,emit});
  const knowledge=new KnowledgeService({store:store('knowledge'),emit}),memories=new MemoryManagement({store:store('memory-management'),manager,dataRoot,emit});
  const locks=new Map(),lockFor=cwd=>{const key=resolve(cwd);if(!locks.has(key))locks.set(key,new WorkspaceExecutionLock(key));return locks.get(key);};
  let codex;
  const consult=async(work,question,targetId)=>{
    const botId=targetId||work.botId;if(!botId)fail('No consultation target');
    // Codex holds the workspace mutation lock. Requests explicitly require a read-only answer.
    const receipt=await manager.send(botId,{id:`consult:${work.id}:${work.question?.requestId||randomUUID()}`,kind:'request',sessionId:`consult:${work.id}`,metadata:{toolPolicy:{allowedEffects:['read']}},content:{text:`只读项目事实咨询，不得调用写入、命令或创建新 Codex 工作，避免与等待你的执行器争用工作区。\n${question}`,work:pick(work,['id','goal','cwd','constraints']),metadata:{readOnlyConsult:true}}});
    for(;;){if(closing)throw new Error('Gateway stopping');const current=codex.require(work.id);if(current.status!=='waiting')throw new Error('Consultation no longer pending');const task=await manager.request(botId,`/tasks/${receipt.taskId}`);if(task.status==='completed')return task.result?.content||'';if(['failed','cancelled','interrupted'].includes(task.status))throw new Error('Consultation failed');await new Promise(done=>setTimeout(done,400));}
  };
  codex=new CodexExecutor({store:store('codex'),emit,defaultCwd,codexPath:options.codexPath,executionLock:{acquire:(owner,signal)=>lockFor(codex.require(codex.active.id).cwd).acquire(owner,signal)},consult,onResult:work=>{
    if(work.roomId&&chatroom.store.get('rooms',work.roomId))chatroom.append(work.roomId,{id:`work-result:${work.id}:${work.status}:${work.finishedAt||''}`,content:`工作「${work.goal}」：${work.status}\n${String(work.result?.content||work.summary||work.error||'').slice(0,15000)}`,kind:'work',workId:work.id,hop:4},work.botId||'system');
  }});
  const sync=new IncrementalSync(store('gateway'));
  async function ownRun(id) {
    for(const bot of manager.list()){
      let tasks;try{tasks=await manager.tasks(bot.id);}catch{continue;}
      const task=tasks.find(task=>task.id===id||task.taskId===id);if(task){let full=task;try{full=await manager.request(bot.id,`/tasks/${encodeURIComponent(id)}`);}catch{}return {id,...full,botId:bot.id,tools:full.tools||await manager.readState(bot.id,db=>db?.listTools(id)||[]),summary:full.result?.content||full.summary||'',sessionId:full.sessionId,roomId:full.sessionId?.replace(/^room:/,'')};}
      const historical=await manager.readState(bot.id,db=>db?.getRecord?.('agentRuns',id));if(historical)return {...historical,botId:bot.id,tools:await manager.readState(bot.id,db=>db?.listRecords?.('toolRuns').filter(tool=>tool.runId===id)||[])};
    }return null;
  }
  const downloads=new RunArtifactDownloads({getRun:ownRun,resolveRoot:run=>({dataRoot,artifactRoot:join(manager.directory(run.botId),'artifacts')}),tempRoot:join(dataRoot,'capabilities','gateway','tmp','downloads')});
  async function state() {
    const agentRuns=[],providers=[];for(const bot of manager.list()){
      try{for(const task of await manager.tasks(bot.id)){const tools=await manager.readState(bot.id,db=>db?.listTools(task.id||task.taskId)||[]);agentRuns.push({id:task.id||task.taskId,...task,botId:bot.id,summary:task.result?.content||task.summary||'',toolCount:task.result?.toolsCalled??tools.length,roomId:task.sessionId?.replace(/^room:/,'')});}const health=await manager.request(bot.id,'/health');if(health.engine?.provider)providers.push(health.engine.provider);}catch{}
      for(const record of await manager.readState(bot.id,db=>db?.listRecords?.('agentRuns')||[]))if(!agentRuns.some(run=>run.id===record.id))agentRuns.push({...record,botId:bot.id});
    }
    const messages=chatroom.store.list('messages'),jobs=chatroom.jobs(),runtime={started:true,fast:{running:jobs.filter(job=>['running','accepted'].includes(job.status)).length,queued:jobs.filter(job=>job.status==='queued').length},deep:{running:0,queued:0},jobs:jobs.slice(-80)};
    const latestProvider=providers.slice().sort((a,b)=>String(b.lastSuccessAt||'').localeCompare(String(a.lastSuccessAt||'')))[0]||{};
    return {bots:manager.list(),rooms:chatroom.rooms(),routines:manager.store.list('routines'),knowledge:knowledge.graph(),runtime,activity:messages.filter(message=>message.returnTo||message.peerReplyId||['event','work'].includes(message.kind)).slice(-100),works:codex.list(),agentRuns:agentRuns.slice(-100),provider:{configured:Boolean(options.model?.apiKey||process.env[options.model?.apiKeyEnv||'DEEPSEEK_API_KEY']),model:options.model?.model||'deepseek-flash',...latestProvider},defaultCwd};
  }
  const assertOwner=(actor,botId)=>{if(actor!=='controller'&&actor!==botId&&!['manager','memory'].includes(manager.get(actor).roleId))fail('This Bot cannot access another Bot private data',403);};
  async function callTool(name,args={},actor='controller',signal) {
    if(quiescing&&toolDefinitions.find(tool=>tool.name===name)?.effect!=='read')fail('Gateway is stopping; new work is unavailable',503);
    if(actor!=='controller'&&!(manager.store.get('bots',actor)?.allowedTools||[]).includes(name))fail('Tool not authorized for this Bot',403);
    const activeConsultation=actor!=='controller'&&codex.list().find(work=>work.status==='waiting'&&(work.question?.targetBotId||work.botId)===actor);
    if(activeConsultation&&!['list_files','read_file','search_files','chatroom_list','chatroom_read','knowledge_search','bots_list','bot_memory_read','codex_status'].includes(name))fail('Only read-only capabilities are available while answering an executor consultation',409);
    if(FILE_TOOLS.has(name)){
      if(actor==='controller')fail('Filesystem tools require an explicit Bot identity');
      // Consultations may read facts, but never wait for a lock held by their caller.
      const waiting=codex.list().find(work=>work.status==='waiting'&&(work.question?.targetBotId||work.botId)===actor);
      if(waiting&&!['read_file','list_files','search_files'].includes(name))fail('Only read-only tools are available while answering an executor consultation',409);
      const config=await manager.config(actor),artifacts=[],tools=createFileTools({workspace:config.workspace,projectRoot:defaultCwd,protectedRoot:dataRoot,tempRoot:join(manager.directory(actor),'tmp','gateway-tools'),onArtifacts:items=>artifacts.push(...items),withExecution:(fn,toolSignal)=>lockFor(defaultCwd).withLock(`bot:${actor}`,fn,toolSignal),saveArtifact:async input=>{
        const api=await manager.botApi();return api.saveArtifact(join(manager.directory(actor),'artifacts'),input);
      }});const tool=tools.find(tool=>tool.name===name),result=await tool.execute(randomUUID(),args,signal);return {...result,artifacts,isError:Boolean(result.details?.timedOut||result.details?.aborted||(result.details?.exitCode!==undefined&&result.details.exitCode!==0))};
    }
    switch(name){
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
      case 'bots_cleanup':return cleanTemporaryData(manager,args.botId,{externalTasks:()=>codex.list()});
      case 'bot_memory_read':{const id=args.botId||actor;assertOwner(actor,id);return memories.list(id);}
      case 'memory_propose':return memories.propose(args.deliveryId);
      case 'memory_merge':return memories.merge(args.deliveryId,args);
      case 'routines_create':return manager.saveRoutine({...args,botId:args.botId||actor});
      case 'codex_submit':return codex.create({...args,botId:actor,sourceActionId:args.requestId||null});
      case 'codex_status':{const work=codex.require(args.workId);assertOwner(actor,work.botId);return codex.get(args.workId);}
      case 'codex_cancel':case 'codex_resume':{const work=codex.require(args.workId);assertOwner(actor,work.botId);return codex[name==='codex_cancel'?'cancel':'resume'](args.workId,args);}
      default:fail('Unknown capability tool',404);
    }
  }
  async function handleApi(method,path,body={},params=new URLSearchParams()) {
    if(quiescing&&!['GET','HEAD'].includes(method))fail('Gateway is stopping; new work is unavailable',503);
    let match;
    if(method==='GET'&&path==='/api/health')return {ok:true,service:'relay-capabilities'};
    if(method==='GET'&&path==='/api/state'){const value=await state();return params.get('sync')==='1'?sync.respond('workspace',value,params.get('since')):value;}
    if(method==='GET'&&path==='/api/bots')return {bots:manager.list()};
    if(method==='POST'&&path==='/api/bots')return manager.create(body);
    if((match=path.match(/^\/api\/bots\/([^/]+)$/))&&method==='PATCH')return manager.update(decodeURIComponent(match[1]),body);
    if((match=path.match(/^\/api\/bots\/([^/]+)\/memories$/))){const id=decodeURIComponent(match[1]);if(method==='GET')return {memories:(await memories.list(id)).map(memory=>({...memory,content:memory.text}))};if(method==='POST')return memories.write(id,body);}
    if((match=path.match(/^\/api\/memories\/([^/]+)$/))&&method==='PATCH'){for(const bot of manager.list()){const found=(await memories.list(bot.id)).find(memory=>memory.id===decodeURIComponent(match[1]));if(found)return memories.write(bot.id,{...body,id:found.id,expectedRevision:body.expectedRevision??found.revision});}fail('Memory not found',404);}
    if(method==='GET'&&path==='/api/rooms')return {rooms:chatroom.rooms()};
    if(method==='POST'&&path==='/api/rooms')return chatroom.createRoom(body);
    if((match=path.match(/^\/api\/rooms\/([^/]+)$/))&&method==='PATCH')return chatroom.updateRoom(decodeURIComponent(match[1]),body);
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/messages$/))){const id=decodeURIComponent(match[1]);if(method==='GET'){const value={room:chatroom.need('rooms',id),messages:chatroom.messages(id),jobs:chatroom.jobs(id)};return params.get('sync')==='1'?sync.respond(`room:${id}`,value,params.get('since')):value;}if(method==='POST')return chatroom.post(id,body);}
    if((match=path.match(/^\/api\/rooms\/([^/]+)\/conclude$/))&&method==='POST')return chatroom.conclude(decodeURIComponent(match[1]));
    if(method==='GET'&&path==='/api/knowledge/search'){const result=knowledge.search(params.get('q')||'');return {...result,memories:params.get('botId')?(await memories.list(params.get('botId'))).map(memory=>({...memory,content:memory.text})):[]};}
    if(method==='GET'&&path==='/api/knowledge/graph')return knowledge.graph(params.get('id'),params.get('depth'));
    if(method==='POST'&&path==='/api/knowledge/nodes')return knowledge.saveNode(body);
    if((match=path.match(/^\/api\/knowledge\/nodes\/([^/]+)$/))&&method==='PATCH')return knowledge.saveNode({...body,id:decodeURIComponent(match[1])});
    if(method==='POST'&&path==='/api/knowledge/edges')return knowledge.saveEdge(body);
    if(method==='POST'&&path==='/api/routines')return manager.saveRoutine(body);
    if((match=path.match(/^\/api\/routines\/([^/]+)$/))&&method==='PATCH')return manager.saveRoutine({...body,id:decodeURIComponent(match[1])});
    if(method==='POST'&&path==='/api/events'){const event=chatroom.post(body.roomId||'room-lobby',{...body,toBotId:body.botId,kind:'event',notify:true},'system');return {event,jobs:chatroom.jobs().filter(job=>job.messageId===event.id)};}
    if(method==='GET'&&path==='/api/jobs')return {jobs:chatroom.jobs()};
    if((match=path.match(/^\/api\/jobs\/([^/]+)\/retry$/))&&method==='POST')return chatroom.retry(decodeURIComponent(match[1]));
    if(method==='POST'&&path==='/api/works'){manager.get(body.botId);chatroom.need('rooms',body.roomId);return codex.create(body);}
    if((match=path.match(/^\/api\/works\/([^/]+)(?:\/(cancel|resume|answer))?$/))){if(method==='GET'&&!match[2])return codex.get(decodeURIComponent(match[1]));if(method==='POST'&&match[2])return codex[match[2]](decodeURIComponent(match[1]),body);}
    if((match=path.match(/^\/api\/agent-runs\/([^/]+)(?:\/(cancel))?$/))){const run=await ownRun(decodeURIComponent(match[1]));if(!run)fail('Run not found',404);if(method==='GET')return projectRunArtifacts(run);if(method==='POST'&&match[2])return manager.request(run.botId,`/tasks/${encodeURIComponent(run.id)}/cancel`,{method:'POST',body:'{}'});}
    if(method==='POST'&&path==='/api/attachments')return attachments.upload(body);
    return undefined;
  }
  const authenticate=req=>{const supplied=req.headers.authorization?.replace(/^Bearer /,'');if(same(supplied,token))return 'controller';for(const bot of manager.store.list('bots'))if(same(supplied,bot.capabilityToken))return bot.id;fail('Unauthorized',401);};
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const server=createServer((req,res)=>{const work=(async()=>{
    try{const actor=authenticate(req),requestUrl=new URL(req.url,'http://localhost'),path=requestUrl.pathname;
      if(actor!=='controller'&&(path.startsWith('/api/')||path.startsWith('/internal/')))fail('User API requires controller authentication',403);
      if(req.method==='GET'&&path==='/api/stream'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store',Connection:'keep-alive'});res.write('data: {"type":"connected"}\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
      let body={};if(['POST','PATCH','PUT'].includes(req.method)){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>(path==='/api/attachments'?MAX_ATTACHMENT_REQUEST_BYTES:2*1024*1024))fail('Request too large',413);chunks.push(chunk);}body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
      if(req.method==='POST'&&path==='/internal/bots/stop-all')return json(res,200,await stopBots(body));
      if(req.method==='GET'&&path==='/tools')return json(res,200,{tools:toolDefinitions.filter(tool=>actor==='controller'||manager.store.get('bots',actor).allowedTools.includes(tool.name))});
      if(req.method==='POST'&&path.startsWith('/tools/')){const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});return json(res,200,await callTool(decodeURIComponent(path.slice(7)),body.arguments||body,actor,abort.signal));}
      if(req.method==='POST'&&path==='/mcp'){
        if(body.jsonrpc!=='2.0'||typeof body.method!=='string')return json(res,400,{jsonrpc:'2.0',id:body.id??null,error:{code:-32600,message:'Invalid JSON-RPC request'}});
        if(body.id===undefined){res.writeHead(202);res.end();return;}
        try{let result;if(body.method==='initialize')result={protocolVersion:['2025-03-26','2024-11-05','2025-06-18'].includes(body.params?.protocolVersion)?body.params.protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'relay-capabilities',version:'0.2.0'}};
          else if(body.method==='ping')result={};else if(body.method==='tools/list')result={tools:toolDefinitions.filter(tool=>actor==='controller'||manager.store.get('bots',actor).allowedTools.includes(tool.name)).map(({name,description,inputSchema})=>({name,description,inputSchema}))};
          else if(body.method==='tools/call'){try{const value=await callTool(body.params?.name,body.params?.arguments||{},actor);result={content:[{type:'text',text:JSON.stringify(value)}],isError:false};}catch(error){result={content:[{type:'text',text:error.message}],isError:true};}}
          else return json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:'Method not found'}});return json(res,200,{jsonrpc:'2.0',id:body.id,result});
        }catch(error){return json(res,200,{jsonrpc:'2.0',id:body.id,error:{code:-32603,message:error.message}});}
      }
      const attachment=path.match(/^\/api\/attachments\/([^/]+)(\/preview)?$/);if(attachment&&['GET','HEAD'].includes(req.method)){const file=await attachments.read(attachment[1],Boolean(attachment[2]));res.writeHead(200,file.headers);res.end(req.method==='HEAD'?undefined:file.bytes);return;}
      const artifact=path.match(/^\/api\/agent-runs\/([^/]+)\/tools\/([^/]+)\/artifacts\/([^/]+)$/);if(artifact&&['GET','HEAD'].includes(req.method)){if(requestUrl.search)fail('Artifact IDs only',404);const file=await downloads.read(...artifact.slice(1).map(decodeURIComponent));try{res.writeHead(200,file.headers);if(req.method==='HEAD'||file.size===0)res.end();else await pipeline(file.handle.createReadStream({autoClose:false,start:0,end:file.size-1}),res);}finally{await file.close();}return;}
      const result=await handleApi(req.method,path,body,requestUrl.searchParams);if(result===undefined)fail('Not found',404);json(res,200,result);
    }catch(error){if(!res.headersSent)json(res,error.status||400,{error:String(error.message).replace(/\bsk-[a-zA-Z0-9_-]+/g,'[redacted]')});else res.end();}
  })();pending.add(work);work.finally(()=>pending.delete(work));});
  try {
    await new Promise((done,reject)=>{server.once('error',reject);server.listen(options.port||0,options.host||'127.0.0.1',done);});url=`http://${options.host==='::1'?'[::1]':'127.0.0.1'}:${server.address().port}`;
    await mkdir(join(dataRoot,'capabilities','gateway'),{recursive:true});await writeFile(join(dataRoot,'capabilities','gateway','run.json'),JSON.stringify({pid:process.pid,url,startedAt:now()}));
    if(options.seed!==false){await manager.seed();chatroom.seed();}await codex.start();chatroom.start();
    if(options.restore!==false)await manager.restore();
  } catch(error) {
    closing=true;await Promise.allSettled([chatroom.close(),codex.stop()]);for(const client of clients)client.end();server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));await Promise.allSettled([...pending]);for(const value of stores.values())value.close();throw error;
  }
  const monitor=setInterval(async()=>{if(monitoring||closing||quiescing)return;monitoring=true;try{await manager.monitor();}finally{monitoring=false;}},5000);monitor.unref();
  let polling=false;const eventPoll=setInterval(async()=>{if(polling||closing)return;polling=true;try{for(const bot of manager.list()){const cursor=manager.store.get('event-cursors',bot.id)?.after||0;const events=await manager.readState(bot.id,db=>db?.listEvents({after:cursor,limit:1000})||[]);if(events.length){manager.store.save('event-cursors',{id:bot.id,after:events.at(-1).seq});emit('bot-event',{botId:bot.id,eventType:events.at(-1).type});}}}catch(error){emit('gateway-error',{error:error.message});}finally{polling=false;}},750);eventPoll.unref();
  const scheduler=setInterval(async()=>{if(ticking||closing||quiescing)return;ticking=true;try{for(const routine of manager.store.list('routines'))if(routine.enabled&&new Date(routine.nextRunAt)<=new Date()){const due=routine.nextRunAt;try{chatroom.post(routine.roomId||'room-lobby',{content:`定时职责「${routine.name}」：${routine.instruction}`,toBotId:routine.botId,clientId:`routine:${routine.id}:${due}`,kind:'event',notify:true},'system');manager.store.save('routines',{...routine,lastRunAt:now(),lastStatus:'queued',nextRunAt:new Date(Date.now()+routine.intervalSeconds*1000).toISOString()});}catch(error){manager.store.save('routines',{...routine,lastStatus:'failed',error:error.message,nextRunAt:new Date(Date.now()+routine.intervalSeconds*1000).toISOString()});}}}finally{ticking=false;}},1000);scheduler.unref();
  const heartbeat=setInterval(()=>{for(const client of clients)client.write(': keepalive\n\n');},20000);heartbeat.unref();
  function stopBots(options={}) {return stopBotsPromise||=(async()=>{quiescing=true;await Promise.all([manager.quiesce(),chatroom.close()]);while(ticking||monitoring)await new Promise(done=>setTimeout(done,10));return manager.shutdownAll(options);})().catch(error=>{stopBotsPromise=null;throw error;});}
  let closePromise;const close=()=>closePromise||=(async()=>{closing=true;clearInterval(scheduler);clearInterval(heartbeat);clearInterval(monitor);clearInterval(eventPoll);await chatroom.close();await codex.stop();for(const client of clients)client.end();server.closeAllConnections();await new Promise(done=>server.close(done));await Promise.allSettled([...pending]);while(ticking||monitoring||polling)await new Promise(done=>setTimeout(done,10));for(const value of stores.values())value.close();})();
  return {url,token,server,manager,chatroom,knowledge,codex,memories,attachments,state,handleApi,callTool,close};
}
