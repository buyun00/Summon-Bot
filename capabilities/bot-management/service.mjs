import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, cp, realpath, lstat, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join,resolve,relative } from 'node:path';
import { spawn } from 'node:child_process';
import { safeId,required,fail,avatarOf,pick,within,now } from '../shared/validation.mjs';

const core = () => import('@relay/bot');
const sleep = ms => new Promise(done=>setTimeout(done,ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class BotManager {
  constructor({store,dataRoot,releaseRoot,model={},defaultCwd,emit=()=>{},getTools=()=>[],gatewayUrl=()=>'',botApi=core,cacheReadStores=false}) {
    Object.assign(this,{store,dataRoot:resolve(dataRoot),releaseRoot:resolve(releaseRoot),model,defaultCwd,emit,getTools,gatewayUrl,botApi,cacheReadStores}); this.launching=new Map();this.creating=new Map();this.cloning=new Map();this.readStores=new Map();
  }
  directory(id) { return join(this.dataRoot,'bots',safeId(id)); }
  public(record) { if (!record) return record; const {capabilityToken,token,...rest}=record; return rest; }
  list() { return this.store.list('bots').map(value=>this.public(value)); }
  get(id) { const bot=this.store.get('bots',id); if(!bot) fail('Bot not found',404); return this.public(bot); }
  async config(id) { this.get(id); return JSON.parse(await readFile(join(this.directory(id),'config.json'),'utf8')); }
  async create(input={}) {
    this.assertAccepting();
    const id=safeId(input.id||`bot-${randomUUID()}`);if(this.creating.has(id))return this.creating.get(id);
    const pending=this.createNow({...input,id}).finally(()=>this.creating.delete(id));this.creating.set(id,pending);return pending;
  }
  async createNow(input={}) {
    const id=safeId(input.id||`bot-${randomUUID()}`);
    if(this.store.get('bots',id)) return this.get(id);
    const roleId=safeId(input.roleId || 'default'), profile=JSON.parse(await readFile(join(this.releaseRoot,'roles',roleId,'role.json'),'utf8'));
    const dir=this.directory(id), token=randomBytes(32).toString('hex'), capabilityToken=randomBytes(32).toString('hex');
    await mkdir(dir,{recursive:true}); await mkdir(join(dir,'workspace'),{recursive:true});
    const config={schemaVersion:1,botId:id,dataDir:dir,workspace:input.cwd?resolve(input.cwd):join(dir,'workspace'),model:{...this.model,...input.modelConfig},prompt:input.prompt||await readFile(join(this.releaseRoot,'roles',roleId,'prompt.md'),'utf8'),skills:(profile.skills||[]).map(skill=>join(this.releaseRoot,'skills',skill)),bundleRoot:this.releaseRoot,bundledSkills:profile.skills||[],token,listen:{host:'127.0.0.1',port:0},concurrency:1,tools:[],limits:input.limits};
    const bot=this.store.save('bots',{id,name:required(input.name||profile.name,'name',100),role:input.role||profile.role,roleId,creationSource:'custom',expertise:input.expertise||profile.role,prompt:input.prompt||'',status:input.status==='paused'?'paused':'active',skills:profile.skills,model:config.model.model||'deepseek-flash',executor:'codex',capabilityToken,allowedTools:profile.tools,runIntent:'stopped',...(input.avatar?{avatar:avatarOf(input.avatar)}:{})});
    config.tools=(await this.getTools(bot)).map(tool=>({...tool,headers:{Authorization:`Bearer ${capabilityToken}`}}));
    config.bundledToolNames=config.tools.map(tool=>tool.name);
    await writeFile(join(dir,'config.json'),JSON.stringify(config,null,2),{mode:0o600});
    this.emit('bot',this.public(bot)); return this.public(bot);
  }
  async seed() {
    for(const roleId of ['engineer','components','qa','entry','chatroom','manager','memory']) {
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
    if(input.status!==undefined&&!['active','paused'].includes(input.status)) fail('Invalid Bot status');
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
    const record=this.store.save('bots',{id,...pick(input,['name','role','expertise','prompt','status','skills']),...(input.avatar?{avatar:avatarOf(input.avatar,previous.avatar)}:{})});
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
    this.get(id);const present=await this.identity(id);if(present?.state==='ready') return present;
    if(present) { for(let i=0;i<600;i++){await sleep(100);const state=await this.identity(id);if(state?.state==='ready')return state;}fail('Bot startup timed out',504); }
    const dir=this.directory(id), config=await this.config(id), record=this.store.get('bots',id);this.assertAccepting();
    const profile=JSON.parse(await readFile(join(this.releaseRoot,'roles',record.roleId||'default','role.json'),'utf8'));
    const priorRoot=config.bundleRoot||this.releaseRoot,oldSkills=new Set((config.bundledSkills||profile.skills||[]).map(skill=>resolve(priorRoot,'skills',skill)));
    config.skills=[...(config.skills||[]).filter(path=>!oldSkills.has(resolve(path))),...(profile.skills||[]).map(skill=>join(this.releaseRoot,'skills',skill))];
    const previousTools=new Set(config.bundledToolNames||(record.allowedTools||[]));
    const customTools=(config.tools||[]).filter(tool=>!previousTools.has(tool.name)).map(tool=>tool.type==='module'&&within(priorRoot,tool.module)?{...tool,module:join(this.releaseRoot,relative(priorRoot,tool.module))}:tool);
    const bundledTools=await this.getTools(record);
    config.tools=[...bundledTools.map(tool=>({...tool,headers:{Authorization:`Bearer ${record.capabilityToken}`}})),...customTools];
    config.bundleRoot=this.releaseRoot;config.bundledSkills=profile.skills||[];config.bundledToolNames=bundledTools.map(tool=>tool.name);
    config.accepting=record.status==='active';
    await writeFile(join(dir,'config.json'),JSON.stringify(config,null,2),{mode:0o600});await mkdir(join(dir,'logs'),{recursive:true});
    this.assertAccepting();let failure;
    const child=spawn(process.execPath,[join(this.releaseRoot,'bot','bin','relay-bot.mjs'),'--config',join(dir,'config.json')],{cwd:this.releaseRoot,detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});
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
  assertAccepting() { if(this.quiescing)fail('Bot management is stopping; new work is unavailable',503); }
  async quiesce() { this.quiescing=true;await Promise.allSettled([...this.creating.values(),...this.cloning.values(),...this.launching.values()]); }
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
  async clone(input) {
    this.assertAccepting();
    const id=required(input.requestId,'requestId',200);if(this.cloning.has(id))return this.cloning.get(id);const pending=this.cloneNow(input).finally(()=>this.cloning.delete(id));this.cloning.set(id,pending);return pending;
  }
  async cloneNow(input) {
    const requestId=required(input.requestId,'requestId',200),existing=this.store.get('derivations',requestId);if(existing&&existing.parentId!==input.parentId)fail('Creation request belongs to another parent',409);if(existing&&existing.status!=='initializing')return existing;
    const parent=this.get(input.parentId),parentConfig=await this.config(parent.id);
    // SQLite is the sole authority. A read transaction gives one consistent logical view,
    // without adding a fork/export protocol to Bot or copying live database files.
    const snapshot=existing?.initialization||await this.readState(parent.id,db=>({sessions:input.inheritContext===false?[]:db?.listSessions()||[],memories:input.inheritMemory===false?[]:db?.listMemories()||[]}));
    const childId=existing?.childId||input.childId||`bot-${randomUUID()}`;
    this.store.save('derivations',{id:requestId,parentId:parent.id,childId,status:'initializing',initialization:snapshot});
    const {apiKey:parentSecret,...inheritedModel}=parentConfig.model;
    const child=await this.create({id:childId,name:input.name||`${parent.name} · 分身`,roleId:input.roleId||parent.roleId,prompt:parentConfig.prompt,modelConfig:inheritedModel,cwd:input.cwd});
    const parentTools=new Set(parent.allowedTools||[]),requestedTools=new Set(input.allowedTools||parent.allowedTools||[]);
    this.store.save('bots',{id:child.id,allowedTools:child.allowedTools.filter(name=>parentTools.has(name)&&requestedTools.has(name))});
    const api=await this.botApi(), target=new api.BotStore(join(this.directory(child.id),'state.sqlite'));
    try{for(const session of snapshot.sessions)target.saveSession({...session,botId:child.id});for(const memory of snapshot.memories)target.putMemory({...memory,id:memory.id,botId:child.id,expectedRevision:undefined});}finally{target.close();}
    // Only declared per-Bot resources are copied; runtime, tasks/outbox and credentials are not.
    const resources=join(this.directory(parent.id),'resources');if(existsSync(resources))await this.copyOwned(resources,join(this.directory(child.id),'resources'));
    const childConfig=await this.config(child.id);childConfig.skills=[...new Set([...childConfig.skills,...(parentConfig.skills||[]).filter(path=>within(resources,path)).map(path=>join(this.directory(child.id),'resources',relative(resources,path)))])];
    await writeFile(join(this.directory(child.id),'config.json'),JSON.stringify(childConfig,null,2),{mode:0o600});
    const record=this.store.save('derivations',{id:requestId,parentId:parent.id,childId:child.id,baseline:snapshot.memories.map(memory=>({id:memory.id,revision:memory.revision,hash:hash(memory.text??memory.content)})),initialization:null,status:'created',task:input.task||'',createdAt:now()});
    if(input.start!==false){await this.start(child.id);if(input.task)await this.send(child.id,{id:`derivation:${requestId}`,kind:'request',content:{text:input.task},sessionId:`assignment:${requestId}`});}
    return record;
  }
  async copyOwned(source,target) { const root=await realpath(source); for(const entry of await readdir(source,{withFileTypes:true})){const path=join(source,entry.name);if((await lstat(path)).isSymbolicLink()||!within(root,await realpath(path)))fail('Managed data contains an external link');if(entry.isDirectory())await this.copyOwned(path,join(target,entry.name));else{await mkdir(target,{recursive:true});const destination=join(target,entry.name);if(existsSync(destination)){if((await lstat(destination)).isSymbolicLink()||hash(await readFile(destination))!==hash(await readFile(path)))fail('A retained delivery file conflicts with its source',409);}else await cp(path,destination,{errorOnExist:true,force:false});}} }
  async archive(childId) {
    const relation=this.store.list('derivations').find(item=>item.childId===childId);if(!relation)fail('Only managed temporary Bots can be archived');
    const delivery=this.store.list('deliveries').find(item=>item.childId===childId&&item.status==='delivered');if(!delivery)fail('Deliver results durably before recycling',409);
    if((await this.tasks(childId)).some(task=>['accepted','queued','running','waiting'].includes(task.status)))fail('Bot still has unfinished work',409);
    await this.stop(childId);this.store.save('bots',{id:childId,status:'paused',runIntent:'stopped',archivedAt:now()});
    // Preserve the directory while archives/results or other tasks may reference artifacts.
    const record=this.store.save('derivations',{...relation,status:'archived',archivedAt:now()});const archiveDir=join(this.dataRoot,'archives',safeId(childId));await mkdir(archiveDir,{recursive:true});await writeFile(join(archiveDir,'record.json'),JSON.stringify({...record,dataDirectory:this.directory(childId),deliveryId:delivery.id,retention:'Data retained in place to preserve artifact references'},null,2));return record;
  }
  async saveRoutine(input) { const previous=input.id&&this.store.get('routines',input.id),botId=input.botId||previous?.botId;this.get(botId);const intervalSeconds=Number(input.intervalSeconds??previous?.intervalSeconds??3600);if(!Number.isFinite(intervalSeconds)||intervalSeconds<60)fail('Routine interval must be >= 60 seconds');return this.store.save('routines',{...previous,...input,botId,name:required(input.name??previous?.name),instruction:required(input.instruction??previous?.instruction),intervalSeconds,enabled:input.enabled??previous?.enabled??true,nextRunAt:input.nextRunAt||previous?.nextRunAt||now()}); }
}
