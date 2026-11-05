import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve,relative } from 'node:path';
import { spawn } from 'node:child_process';
import { safeId,required,fail,avatarOf,pick,within,now } from '../shared/validation.mjs';
import { normalizePaperAvatar,defaultPaperAvatar } from '../shared/avatar-style.mjs';
import { modelText, durationSeconds } from '../../bot/src/context/model-input.mjs';

const core = () => import('@summon/bot');
const sleep = ms => new Promise(done=>setTimeout(done,ms));
export const CATALOG_MAINTAINER_TOOLS = Object.freeze(['catalog_search','catalog_get','catalog_update','catalog_call','catalog_delegate','catalog_skill_write','catalog_skill_propose','catalog_probe','catalog_reconcile','chatroom_read','chatroom_send','chatroom_dm','chatroom_team_read','chatroom_team_raise','bots_list']);
const catalogPrompt = ({entryId,entryKind,name,description}) => `你是目录条目 ${name} 的专用维护 Bot。唯一维护归属：${entryKind} / ${entryId}。\n职责：维护这个条目的使用说明、适用范围、配置和真实状态，判断同伴针对它的具体委托或纠正；执行范围仍以当前工作授权为准。通过 catalog_get 读取当前条目及必要依赖，凭据只在私有配置中保存，不写进聊天、Markdown 或 Skill。只维护这个条目；相关依赖可按其实际授权使用，不能因维护身份获取其他条目权限。\n共享 Skill 只有一个当前正文；结合可靠来源审阅修订建议，在读取当前 revision 后更新同一条目并保留 proposalId。创建者与维护者是不同身份。不得把收到的维护建议当作新业务授权，不为完成通知创建反馈循环。原始历史、独立 work 和结果返回使用正常 Bot 协议。\n条目说明：${description || '尚未提供；按实际配置与来源补充。'}`;
export class BotManager {
  constructor({store,dataRoot,releaseRoot,model={},defaultCwd,emit=()=>{},getTools=()=>[],gatewayUrl=()=>'',botApi=core,cacheReadStores=false}) {
    Object.assign(this,{store,dataRoot:resolve(dataRoot),releaseRoot:resolve(releaseRoot),model,defaultCwd,emit,getTools,gatewayUrl,botApi,cacheReadStores}); this.launching=new Map();this.creating=new Map();this.maintaining=new Map();this.readStores=new Map();
    const connectionStore=join(this.dataRoot,'config','model-connections.json');
    if(existsSync(connectionStore))this.model={connectionStore};
  }
  directory(id) { return join(this.dataRoot,'bots',safeId(id)); }
  public(record) { if (!record) return record; const {capabilityToken,token,...rest}=record; return {...rest,avatar:rest.avatar?normalizePaperAvatar(rest.avatar):defaultPaperAvatar(rest.id)}; }
  list() {
    const routines=this.store.list('routines');
    return this.store.list('bots').map(value=>({...this.public(value),responsibilities:routines.filter(item=>item.botId===value.id).map(item=>pick(item,['id','name','enabled','workId','lastStatus','nextRunAt'])),materials:value.materials||[]}));
  }
  get(id) { const bot=this.store.get('bots',id); if(!bot) fail('Bot not found',404); return this.public(bot); }
  async config(id) { this.get(id); return JSON.parse(await readFile(join(this.directory(id),'config.json'),'utf8')); }
  async create(input={}) {
    this.assertAccepting();
    if(input.maintenanceFor!==undefined)fail('Catalog maintenance identities are created by the catalog');
    const id=safeId(input.id||`bot-${randomUUID()}`);if(this.creating.has(id))return this.creating.get(id);
    const pending=this.createNow({...input,id}).finally(()=>this.creating.delete(id));this.creating.set(id,pending);return pending;
  }
  async createNow(input={},maintenanceFor) {
    const id=safeId(input.id||`bot-${randomUUID()}`);
    const previous=this.store.get('bots',id);
    if(previous&&(!maintenanceFor||existsSync(join(this.directory(id),'config.json')))) return this.get(id);
    if(previous&&JSON.stringify(previous.maintenanceFor)!==JSON.stringify(maintenanceFor))fail('Catalog maintenance identity does not match',409);
    const roleId=safeId(input.roleId || 'default'), profile=JSON.parse(await readFile(join(this.releaseRoot,'roles',roleId,'role.json'),'utf8'));
    const lifecycle=input.lifecycle||{kind:'permanent',state:'active'};
    if(!['temporary','permanent'].includes(lifecycle.kind)||!['active','dormant'].includes(lifecycle.state))fail('Invalid Bot lifecycle');
    const dir=this.directory(id), token=randomBytes(32).toString('hex'), capabilityToken=previous?.capabilityToken||randomBytes(32).toString('hex');
    await mkdir(dir,{recursive:true}); await mkdir(join(dir,'workspace'),{recursive:true});
    const skills=maintenanceFor?[]:profile.skills||[], basePrompt=await readFile(join(this.releaseRoot,'roles',roleId,'prompt.md'),'utf8');
    const config={schemaVersion:1,botId:id,dataDir:dir,workspace:input.cwd?resolve(input.cwd):join(dir,'workspace'),model:{...this.model,...input.modelConfig},prompt:[basePrompt,input.prompt?`\n用户设定的身份与职责：\n${input.prompt}`:''].filter(Boolean).join('\n'),skills:skills.map(skill=>join(this.releaseRoot,'skills',skill)),bundleRoot:this.releaseRoot,bundledSkills:skills,token,listen:{host:'127.0.0.1',port:0},concurrency:4,context:{maintenanceConcurrency:1},tools:[],limits:input.limits,...(maintenanceFor?{maintenanceFor}: {})};
    const bot=this.store.save('bots',{id,name:required(input.name||profile.name,'name',100),role:input.role||profile.role,roleId,lifecycle,creationSource:maintenanceFor?'catalog':'custom',expertise:input.expertise||profile.role,prompt:input.prompt||'',status:input.status==='paused'?'paused':'active',skills,model:config.model.model||'deepseek-flash',executor:'codex',capabilityToken,allowedTools:maintenanceFor?[...CATALOG_MAINTAINER_TOOLS]:profile.tools,runIntent:'stopped',...(maintenanceFor?{maintenanceFor,createdBy:input.createdBy||'controller'}:{}),...(input.avatar?{avatar:avatarOf(input.avatar)}:{})});
    config.usage={ledgerPath:join(this.dataRoot,'usage.sqlite'),botName:bot.name};
    config.tools=(await this.getTools(bot)).map(tool=>({...tool,headers:{Authorization:`Bearer ${capabilityToken}`}}));
    config.catalog={url:this.gatewayUrl(),token:capabilityToken};
    config.bundledToolNames=config.tools.map(tool=>tool.name);
    await writeFile(join(dir,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
    this.emit('bot',this.public(bot)); return this.public(bot);
  }
  async ensureCatalogMaintainer(input) {
    this.assertAccepting();
    const entryId=safeId(input.entryId),entryKind=input.entryKind;
    if(!['mcp','http','skill'].includes(entryKind))fail('Invalid catalog maintenance kind');
    if(this.maintaining.has(entryId))return this.maintaining.get(entryId);
    const pending=(async()=>{
      const matches=this.store.list('bots').filter(bot=>bot.maintenanceFor?.kind==='catalog'&&bot.maintenanceFor.entryId===entryId);
      if(matches.length>1)fail('Catalog entry has multiple maintenance identities',409);
      const previous=matches[0];if(previous&&previous.maintenanceFor.entryKind!==entryKind)fail('Catalog maintenance kind cannot change',409);
      const maintenanceFor={kind:'catalog',entryId,entryKind};
      const details={entryId,entryKind,name:required(input.name,'name',200),description:input.description};
      const prompt=catalogPrompt(details),expertise=`${entryKind}: ${details.name}`;
      await this.createNow({id:previous?.id||`bot-catalog-${randomUUID()}`,name:`${details.name} · 维护`.slice(0,100),role:'目录维护',expertise,prompt,status:input.enabled===false?'paused':'active',createdBy:input.createdBy},maintenanceFor);
      const bot=await this.setCatalogMaintainerState(entryId,{enabled:input.enabled!==false,archived:false});
      if(bot.prompt!==prompt||bot.expertise!==expertise){
        const base=await readFile(join(this.releaseRoot,'roles',bot.roleId||'default','prompt.md'),'utf8'),effective=`${base}\n\n${prompt}`;
        if(await this.identity(bot.id))await this.request(bot.id,'/config',{method:'PATCH',body:JSON.stringify({prompt:effective})});
        else {
          const api=await this.botApi();
          await api.withBotDataLease(this.directory(bot.id),async()=>{
            const config=await this.config(bot.id);config.prompt=effective;
            const path=join(this.directory(bot.id),'config.json'),temp=`${path}.${randomUUID()}.tmp`;
            await writeFile(temp,JSON.stringify(config,null,2),{mode:0o600});await rename(temp,path);
          },{botId:bot.id,purpose:'refresh-catalog-responsibility'});
        }
        const updated=this.store.save('bots',{id:bot.id,prompt,expertise});this.emit('bot',this.public(updated));return this.public(updated);
      }
      return bot;
    })().finally(()=>this.maintaining.delete(entryId));
    this.maintaining.set(entryId,pending);return pending;
  }
  async setCatalogMaintainerState(entryId,{enabled=true,archived=false}={}) {
    safeId(entryId);if(typeof enabled!=='boolean'||typeof archived!=='boolean')fail('Catalog maintenance state must be boolean');
    const matches=this.store.list('bots').filter(bot=>bot.maintenanceFor?.kind==='catalog'&&bot.maintenanceFor.entryId===entryId);
    if(matches.length!==1)fail('Catalog maintenance identity is missing or ambiguous',409);
    const bot=matches[0],active=enabled&&!archived;
    const updated=this.store.save('bots',{id:bot.id,status:active?'active':'paused',archivedAt:archived?(bot.archivedAt||now()):null,...(!active?{runIntent:'stopped'}:{})});
    if(!active){await this.launching.get(bot.id)?.catch(()=>{});await this.stop(bot.id);}
    this.emit('bot',this.public(updated));return this.public(updated);
  }
  async seed() {
    for(const roleId of ['entry','eggbot']) {
      const id=`bot-${roleId}`,previous=this.store.get('bots',id);
      await this.create({id,roleId});
      // Existing installations predate explicit provenance. Only this exact
      // fixed-ID/role pair is repaired; newly custom-created Bots are excluded.
      if(!previous||(!previous.presetId&&!previous.creationSource&&previous.roleId===roleId)) {
        const marked=this.store.save('bots',{id,presetId:roleId,creationSource:'preset'});
        this.emit('bot',this.public(marked));
      }
    }
  }
  async update(id,input) {
    const previous=this.get(id);
    if(input.maintenanceFor!==undefined)fail('Catalog maintenance identity cannot be reassigned');
    if(previous.maintenanceFor){
      const managed=['role','expertise','prompt','skills','status'];
      if(managed.some(key=>input[key]!==undefined&&JSON.stringify(input[key])!==JSON.stringify(previous[key])))fail('Manage this dedicated Bot through its catalog entry');
      input={...input};for(const key of managed)delete input[key];
    }
    if(input.status!==undefined&&!['active','paused'].includes(input.status)) fail('Invalid Bot status');
    if(input.status==='active'&&previous.lifecycle?.state==='dormant'&&input.lifecycle===undefined)input={...input,lifecycle:{...previous.lifecycle,state:'active',resumedAt:now()}};
    if(input.lifecycle!==undefined){
      if(!['temporary','permanent'].includes(input.lifecycle.kind)||!['active','dormant'].includes(input.lifecycle.state))fail('Invalid Bot lifecycle');
      if((previous.presetId||previous.maintenanceFor)&&input.lifecycle.kind!=='permanent')fail('System and capability-maintenance Bots are permanent');
    }
    if(input.status!==undefined) {
      const accepting=input.status==='active';
      if(await this.identity(id))await this.request(id,'/availability',{method:'PATCH',body:JSON.stringify({accepting})});
      else {const api=await this.botApi();await api.withBotDataLease(this.directory(id),async()=>{const config=await this.config(id);config.accepting=accepting;const path=join(this.directory(id),'config.json'),temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(config,null,2),{mode:0o600});await rename(temp,path);},{botId:id,purpose:'update-availability'});}
    }
    if(input.prompt!==undefined) {
      if(typeof input.prompt!=='string')fail('Bot prompt must be a string');
      const identity=await this.identity(id);
      if(identity) await this.request(id,'/config',{method:'PATCH',body:JSON.stringify({prompt:input.prompt})});
      else {
        const api=await this.botApi();
        await api.withBotDataLease(this.directory(id),async()=>{const config=await this.config(id);config.prompt=input.prompt;await writeFile(join(this.directory(id),'config.json'),JSON.stringify(config,null,2),{mode:0o600});},{botId:id,purpose:'update-prompt'});
      }
    }
    const record=this.store.save('bots',{id,...pick(input,['name','role','expertise','prompt','status','skills','lifecycle']),...(input.avatar?{avatar:avatarOf(input.avatar,previous.avatar)}:{})});
    this.emit('bot',this.public(record)); return this.public(record);
  }
  async identity(id) { return (await this.botApi()).inspectBotIdentity(this.directory(id)); }
  async contacts(id) { return {contacts:(await this.config(id)).contacts?.map(({botId,name})=>({botId,name,transport:'local-direct'}))||[]}; }
  async connect(id,peerId,{enabled=true}={}) {
    this.assertAccepting();
    const owner=this.get(id),peer=this.get(peerId);
    if(id===peerId||owner.archivedAt||peer.archivedAt)fail('Choose two retained, different Bots');
    if(typeof enabled!=='boolean')fail('enabled must be boolean');
    const ids=[id,peerId].sort(),key=ids.join(':');
    // Persist private, directional peer credentials before either side changes.
    // Repeating a partially completed pairing reconciles the same credentials.
    let link=this.store.get('peer-links',key);
    if(!link&&enabled)link=this.store.save('peer-links',{id:key,ids,tokens:[randomBytes(32).toString('hex'),randomBytes(32).toString('hex')]});
    for(const [from,to] of [[owner,peer],[peer,owner]]) {
      const index=ids.indexOf(from.id),body=enabled?{contact:{botId:to.id,name:to.name,dataDir:this.directory(to.id),token:link.tokens[index]},peer:{botId:to.id,token:link.tokens[1-index]}}:null;
      if(await this.identity(from.id))await this.request(from.id,`/contacts/${encodeURIComponent(to.id)}`,{method:enabled?'PUT':'DELETE',body:JSON.stringify(body||{})});
      else {
        const api=await this.botApi();
        await api.withBotDataLease(this.directory(from.id),async()=>{
          const config=await this.config(from.id);
          config.contacts=(config.contacts||[]).filter(value=>value.botId!==to.id);config.peers=(config.peers||[]).filter(value=>value.botId!==to.id);
          if(body){config.contacts.push(body.contact);config.peers.push(body.peer);}
          const path=join(this.directory(from.id),'config.json'),temp=`${path}.${randomUUID()}.tmp`;
          await writeFile(temp,JSON.stringify(config,null,2),{mode:0o600});await rename(temp,path);
        },{botId:from.id,purpose:'configure-peer'});
      }
    }
    this.emit('bot-contacts',{botId:id,peerId,connected:enabled});
    return {botId:id,peerId,connected:enabled};
  }
  async request(id,path,options={}) {
    const identity=await this.identity(id);if(!identity) fail('Bot is not running',503);
    const config=await this.config(id), response=await fetch(`${identity.url}${path}`,{...options,headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json',...options.headers},signal:options.signal||AbortSignal.timeout(15000)});
    const result=await response.json();if(!response.ok) fail(result.error?.message||result.error||`Bot HTTP ${response.status}`,response.status);return result;
  }
  async start(id) {
    this.assertAccepting();
    if(this.launching.has(id)) return this.launching.get(id);
    const pending=this.startNow(id).finally(()=>this.launching.delete(id));this.launching.set(id,pending);return pending;
  }
  async startNow(id) {
    const saved=this.get(id);if(saved.archivedAt||saved.maintenanceFor&&saved.status!=='active')fail('Catalog maintenance Bot is disabled or archived',409);
    const present=await this.identity(id);if(present?.state==='ready') return present;
    if(present) { for(let i=0;i<600;i++){await sleep(100);const state=await this.identity(id);if(state?.state==='ready')return state;}fail('Bot startup timed out',504); }
    const dir=this.directory(id), config=await this.config(id), record=this.store.get('bots',id);this.assertAccepting();
    if(this.model.connectionStore)config.model={connectionStore:this.model.connectionStore};
    const profile=JSON.parse(await readFile(join(this.releaseRoot,'roles',record.roleId||'default','role.json'),'utf8'));
    if(record.maintenanceFor){record.allowedTools=[...CATALOG_MAINTAINER_TOOLS];this.store.save('bots',{id,allowedTools:record.allowedTools});profile.skills=[];config.maintenanceFor=record.maintenanceFor;}
    const priorRoot=config.bundleRoot||this.releaseRoot,oldSkills=new Set((config.bundledSkills||profile.skills||[]).map(skill=>resolve(priorRoot,'skills',skill)));
    config.skills=record.maintenanceFor?[]:[...(config.skills||[]).filter(path=>!oldSkills.has(resolve(path))),...(profile.skills||[]).map(skill=>join(this.releaseRoot,'skills',skill))];
    const previousTools=new Set(config.bundledToolNames||(record.allowedTools||[]));
    const customTools=(config.tools||[]).filter(tool=>!previousTools.has(tool.name)).map(tool=>tool.type==='module'&&within(priorRoot,tool.module)?{...tool,module:join(this.releaseRoot,relative(priorRoot,tool.module))}:tool);
    const bundledTools=await this.getTools(record);
    config.tools=[...bundledTools.map(tool=>({...tool,headers:{Authorization:`Bearer ${record.capabilityToken}`}})),...(record.maintenanceFor?[]:customTools)];
    config.catalog={url:this.gatewayUrl(),token:record.capabilityToken};
    config.bundleRoot=this.releaseRoot;config.bundledSkills=profile.skills||[];config.bundledToolNames=bundledTools.map(tool=>tool.name);
    config.accepting=record.status==='active';
    await writeFile(join(dir,'config.json'),JSON.stringify(config,null,2),{mode:0o600});await mkdir(join(dir,'logs'),{recursive:true});
    this.assertAccepting();let failure;
    const child=spawn(process.execPath,[join(this.releaseRoot,'bot','bin','summon-bot.mjs'),'--config',join(dir,'config.json')],{cwd:this.releaseRoot,detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
    child.on('error',error=>{failure=error;this.emit('bot-error',{botId:id,error:error.message});});
    child.once('exit',(code,signal)=>{failure ||= new Error(`Bot exited during startup (${code??signal}); inspect ${join(dir,'logs')}`);});
    child.on('message',message=>{if(message.type==='error'){failure=Object.assign(new Error(message.message),{code:message.code});}if(['ready','error'].includes(message.type)&&child.connected)child.disconnect();});
    child.unref();
    this.store.save('bots',{id,runIntent:'running'});
    try {
      for(let i=0;i<600;i++){await sleep(100);if(failure)throw failure;const state=await this.identity(id);if(state?.state==='ready'){this.emit('bot-state',state);return state;}}
      fail('Bot startup timed out; inspect process log before retrying',504);
    } finally {if(child.connected)child.disconnect();}
  }
  async stop(id,{persistIntent=true}={}) {
    if(persistIntent)this.store.save('bots',{id,runIntent:'stopped'});
    if(!await this.identity(id))return {botId:id,stopped:true};
    try{await this.request(id,'/shutdown',{method:'POST',body:'{}'});}catch(error){if(await this.identity(id))throw error;}
    for(let i=0;i<300;i++){if(!await this.identity(id))return {botId:id,stopped:true};await sleep(100);}fail('Bot did not finish stopping',504);
  }
  async shutdownAll(options={}) { return Promise.all(this.list().map(bot=>this.stop(bot.id,options))); }
  async pauseProject(id,{roomId,workIds=[],taskIds=[],messageIds=[]}) {
    this.get(id);
    const selected=await this.readState(id,db=>{
      const works=(db?.listRecords('works')||[]).filter(work=>workIds.includes(work.id)&&work.sources?.some(source=>source.roomId===roomId));
      const ids=new Set(works.map(work=>work.id)), receipts=(db?.listMessages()||[]).filter(message=>messageIds.includes(message.sourceMessageId));
      const tasks=(db?.listTasks({limit:10000})||[]).filter(task=>(taskIds.includes(task.id)||receipts.some(message=>message.taskId===task.id))&&(ids.has(task.workId)||task.input?.room?.id===roomId));
      return {workIds:works.map(work=>work.id),taskIds:tasks.map(task=>task.id)};
    });
    if(await this.identity(id)) {
      for(const workId of selected.workIds)await this.request(id,`/works/${encodeURIComponent(workId)}`,{method:'PATCH',body:JSON.stringify({status:'paused'})});
      const tasks=[];
      for(const taskId of selected.taskIds){await this.request(id,`/tasks/${encodeURIComponent(taskId)}/cancel`,{method:'POST',body:'{}'});const task=await this.request(id,`/tasks/${encodeURIComponent(taskId)}`);tasks.push({taskId,status:task.status});}
      return {tasks,workIds:selected.workIds};
    }
    const api=await this.botApi();
    return api.withBotDataLease(this.directory(id),async()=>{
      const db=new api.BotStore(join(this.directory(id),'state.sqlite'));
      try {
        for(const workId of selected.workIds){const work=db.getRecord('works',workId);db.putRecord('works',{...work,status:'paused',revision:work.revision+1,updatedAt:now()});db.appendEvent('work.updated',{work:db.getRecord('works',workId)},{workId,conversationId:work.conversationId});}
        const tasks=[];
        for(const taskId of selected.taskIds){let task=db.getTask(taskId);if(!['completed','failed','cancelled','interrupted'].includes(task.status))task=db.updateTask(taskId,{status:task.status==='accepted'?'cancelled':'interrupted',cancelRequested:true,finishedAt:now(),error:{code:'PROJECT_HANDOFF',message:'Project paused while its Bot was confirmed stopped; external effects remain in their original receipts'}});tasks.push({taskId,status:task.status});}
        return {tasks,workIds:selected.workIds};
      }finally{db.close();}
    },{botId:id,purpose:'pause-room-project'});
  }
  assertAccepting() { if(this.quiescing)fail('Bot management is stopping; new work is unavailable',503); }
  async quiesce() { this.quiescing=true;await Promise.allSettled([...this.creating.values(),...this.maintaining.values(),...this.launching.values()]); }
  async restore() { for(const bot of this.store.list('bots')) if(bot.runIntent==='running'&&bot.status==='active') await this.start(bot.id); }
  async monitor() {
    if(this.quiescing)return [];
    return Promise.allSettled(this.store.list('bots').filter(bot=>bot.runIntent==='running'&&bot.status==='active').map(async bot=>{
      if(await this.identity(bot.id))return;
      const backoff=Math.min(60000,1000*Math.pow(2,Math.min(6,bot.restartFailures||0)));
      if(bot.lastRestartAttempt&&Date.now()-new Date(bot.lastRestartAttempt).getTime()<backoff)return;
      this.store.save('bots',{id:bot.id,lastRestartAttempt:now()});
      try{await this.start(bot.id);this.store.save('bots',{id:bot.id,restartFailures:0});}catch(error){this.store.save('bots',{id:bot.id,restartFailures:(bot.restartFailures||0)+1,lastRestartError:error.message});throw error;}
    }));
  }
  async send(id,message) { this.assertAccepting();if(this.get(id).status!=='active')fail('Bot is paused',409);await this.start(id);this.assertAccepting();return this.request(id,'/messages',{method:'POST',body:JSON.stringify({...message,to:id})}); }
  async tasks(id) { try { const result=await this.request(id,'/tasks');return Array.isArray(result)?result:result.tasks||[]; }catch(error){if(error.status!==503)throw error; const api=await this.botApi(); if(!existsSync(join(this.directory(id),'state.sqlite')))return [];const db=new api.BotStore(join(this.directory(id),'state.sqlite'),{readOnly:true});try{return db.listTasks?.()||[];}finally{db.close();}} }
  async readState(id,fn) {
    const api=await this.botApi(),path=join(this.directory(id),'state.sqlite');if(!existsSync(path))return fn(null);
    let store=this.readStores.get(id);
    if(!store){store=new api.BotStore(path,{readOnly:true});if(this.cacheReadStores)this.readStores.set(id,store);}
    try{store.db.exec('BEGIN');const result=fn(store);store.db.exec('COMMIT');return result;}
    catch(error){try{store.db.exec('ROLLBACK');}catch{}throw error;}
    finally{if(!this.cacheReadStores)store.close();}
  }
  closeReadStores(){for(const store of this.readStores.values())store.close();this.readStores.clear();}
  saveReminder(input, botId, source) {
    this.get(botId);
    if (!source?.taskId || !source.roomId || !source.replyTo) fail('A reminder requires an accepted room request');
    const relative=durationSeconds(input.delaySeconds??input.delay??input.after??input.when??source.input?.trigger?.content);
    const absolute=typeof input.dueAt==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.dueAt)?Date.parse(input.dueAt):NaN;
    const deadline=Number.isFinite(absolute)?absolute:Number.isFinite(relative)&&relative>=0?Date.parse(source.receivedAt)+relative*1000:NaN;
    if (!Number.isFinite(deadline)) fail('这条提醒还没有有效时间。请提供相对时长，或带时区的到期时间；其他已保存的动作不受影响。');
    const content=required(modelText(input.content??input.text??input.message,modelText(source.input?.trigger?.content)),'content',16000),dueAt=new Date(deadline).toISOString();
    const id=`reminder:${botId}:${input.id||source.taskId}`,prior=this.store.get('reminders',id);
    if(prior){if(prior.content!==content||prior.dueAt!==dueAt||prior.roomId!==source.roomId)fail('Reminder ID already belongs to another request',409);return prior;}
    return this.store.save('reminders',{id,botId,roomId:source.roomId,replyTo:source.replyTo,sourceTaskId:source.taskId,
      sourceMessageId:source.messageId,actor:source.actor,receivedAt:source.receivedAt,dueAt,content,status:'pending',attempts:0});
  }
  cancelReminder(id,botId,source) {
    const candidates=this.store.list('reminders').filter(item=>item.botId===botId&&item.roomId===source?.roomId&&['pending','sending'].includes(item.status));
    const reminder=this.store.get('reminders',id)||candidates.find(item=>item.id===source?.replyTo)||(candidates.length===1&&!id?candidates[0]:null);
    if(!reminder||reminder.botId!==botId||reminder.roomId!==source?.roomId)fail('Reminder is outside this source scope',403);
    if(['delivered','cancelled'].includes(reminder.status))return reminder;
    return this.store.save('reminders',{id:reminder.id,status:reminder.status==='sending'?'sending':'cancelled',cancelRequested:true,cancelRequestedAt:now()});
  }
  claimReminder(id) {
    const reminder=this.store.get('reminders',id);
    if(!reminder||!['pending','sending'].includes(reminder.status)||Date.parse(reminder.dueAt)>Date.now()||(reminder.retryAt&&Date.parse(reminder.retryAt)>Date.now()))return null;
    if(reminder.cancelRequested)return this.store.save('reminders',{id,status:'cancelled'});
    return this.store.save('reminders',{id,status:'sending',attempts:(reminder.attempts||0)+1,attemptedAt:now()});
  }
  settleReminder(id,input) {
    const prior=this.store.get('reminders',id);if(!prior||prior.status==='delivered')return prior;
    return this.store.save('reminders',{id,...pick(input,['status','receipt','deliveredAt','retryAt','error'])});
  }
  async saveRoutine(input) {
    let previous=input.id&&this.store.get('routines',input.id);
    const botId=input.botId||previous?.botId;this.get(botId);
    const name=required(input.name??previous?.name),roomId=input.roomId??previous?.roomId;
    if(!previous&&!input.id)previous=this.store.list('routines').find(item=>item.botId===botId&&(input.eventKey?item.eventKey===input.eventKey:item.name===name&&item.roomId===roomId&&item.workId===(input.workId||undefined)));
    const intervalSeconds=Number(input.intervalSeconds??previous?.intervalSeconds??3600);
    if(!Number.isFinite(intervalSeconds)||intervalSeconds<60)fail('Routine interval must be >= 60 seconds');
    const nextRunAt=input.nextRunAt||previous?.nextRunAt||now();if(!Number.isFinite(Date.parse(nextRunAt)))fail('Invalid routine nextRunAt');
    const watch=input.watch===null?null:input.watch??previous?.watch;
    if(watch){
      if(!['work','task','room'].includes(watch.kind))fail('Routine watch kind must be work, task or room');
      if(watch.kind==='work'&&!watch.workId||watch.kind==='task'&&!watch.taskId||watch.kind==='room'&&!watch.roomId)fail('Routine watch requires the actual source ID');
      if(watch.botId&&watch.botId!==botId)fail('Watch another Bot through an authorized collaboration task');
    }
    const fields=pick(input,['eventKey','workId','lastRunAt','lastStatus','lastTaskId','lastDeliveryId','lastObservation','lastObservedAt','lastEventId','lastErrorNotified','error','pendingAt','pendingCount']);
    return this.store.save('routines',{...previous,...fields,...(input.id?{id:input.id}:{}),botId,name,roomId,instruction:required(input.instruction??previous?.instruction),intervalSeconds,enabled:input.enabled??previous?.enabled??true,nextRunAt,watch});
  }
}

