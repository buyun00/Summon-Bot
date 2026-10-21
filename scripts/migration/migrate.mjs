import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile, readFile, open, unlink } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readJson, writeJson, digest, walk, within, parseArgs } from '../build/files.mjs';
import { inspectServiceLock } from '../installation/service-lock.mjs';

const executionKinds = new Set(['agentSessions','agentRuns','toolRuns','jobs']);
const terminal = new Set(['completed','failed','cancelled','interrupted','passed','done']);
const canonical = value => JSON.stringify(value);
const keyOf = row => `${row.kind}:${row.id}`;
const sqlRows = path => {
  const db = new DatabaseSync(path,{readOnly:true});
  try { if (Object.values(db.prepare('PRAGMA integrity_check').get())[0] !== 'ok') throw new Error(`Invalid SQLite database: ${path}`);
    return db.prepare('SELECT kind,id,created_at,updated_at,data FROM records ORDER BY rowid').all().map(row=>({...row,value:JSON.parse(row.data)}));
  } finally { db.close(); }
};

/** Inspect source records without starting an Agent or changing any source database. */
export async function inspectMigration({sourceRoot, dataRoot}) {
  sourceRoot=resolve(sourceRoot); dataRoot=resolve(dataRoot);
  const sources=[], instances=[];
  for(const root of [join(sourceRoot,'.relay'),join(dataRoot,'legacy')]) if(existsSync(join(root,'relay.sqlite'))) sources.push({root,path:join(root,'relay.sqlite'),authority:'public',rows:sqlRows(join(root,'relay.sqlite'))});
  if(existsSync(join(dataRoot,'instances'))) for(const entry of await readdir(join(dataRoot,'instances'),{withFileTypes:true})) {
    if(!entry.isDirectory())continue;const root=join(dataRoot,'instances',entry.name), configPath=join(root,'instance.json');if(!existsSync(configPath))continue;
    const config=await readJson(configPath);instances.push({root,botId:config.botId,instanceId:config.instanceId,app:config.app});
    if(existsSync(join(root,'legacy','relay.sqlite')))sources.push({root:join(root,'legacy'),path:join(root,'legacy','relay.sqlite'),authority:'execution',botId:config.botId,rows:sqlRows(join(root,'legacy','relay.sqlite'))});
  }
  const selected=new Map(), decisions=[];
  for(const source of sources)for(const row of source.rows){
    if(source.authority==='execution'&&!executionKinds.has(row.kind))continue;
    const key=keyOf(row),before=selected.get(key);
    if(!before || source.authority==='execution' || new Date(row.updated_at)>=new Date(before.row.updated_at)) {
      if(before&&before.row.data!==row.data)decisions.push({key,source:source.path,replaces:before.source.path,rule:source.authority==='execution'?'worker-execution-authority':'latest-public-revision'});
      selected.set(key,{row,source});
    }
  }
  const counts={};for(const {row}of selected.values())counts[row.kind]=(counts[row.kind]||0)+1;
  const inputHash=digest(canonical([...selected].map(([key,{row,source}])=>[key,source.path,row.data])));
  return {sourceRoot,dataRoot,sources,instances,selected,counts,decisions,inputHash};
}

async function copyChecked(source,target,files,filter) {
  if(!existsSync(source))return;
  for(const file of await walk(source,filter)){
    const destination=resolve(target,file.name);if(!within(target,destination))throw new Error('Migration path escapes target');
    const sha256=digest(await readFile(file.path));
    if(existsSync(destination)){if(digest(await readFile(destination))!==sha256)throw new Error(`Migration file conflict: ${destination}`);}
    else {await mkdir(dirname(destination),{recursive:true});await copyFile(file.path,destination);}
    if(digest(await readFile(destination))!==sha256)throw new Error(`Migration copy changed: ${file.name}`);
    files.push({source:file.path,target:destination,size:file.size,sha256});
  }
}

export async function verifyMigration(report) {
  const databases=new Map();
  try {
    for(const check of report.checks||[]){
      if(!within(report.dataRoot,check.database)||!existsSync(check.database))throw new Error('Migration target database missing or outside data root');
      if(!databases.has(check.database))databases.set(check.database,new DatabaseSync(check.database,{readOnly:true}));
      if(!['records','sessions','memories'].includes(check.table))throw new Error('Unsupported migration verification table');
      const db=databases.get(check.database),row=check.table==='records'?db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(check.kind,check.id):db.prepare(`SELECT data FROM ${check.table} WHERE id=?`).get(check.id);
      if(!row||digest(row.data)!==check.sha256)throw new Error(`Migrated record verification failed: ${check.kind||check.table}:${check.id}`);
    }
    for(const file of report.files){if(!within(report.dataRoot,file.target)||digest(await readFile(file.target))!==file.sha256)throw new Error(`Migrated file verification failed: ${file.target}`);}
    return {verified:true,records:report.checks.length,files:report.files.length};
  }finally{for(const db of databases.values())db.close();}
}

export async function migrate({sourceRoot,dataRoot,releaseRoot,execute=false,model={provider:'deepseek',model:'deepseek-flash',baseUrl:'https://api.deepseek.com/v1',apiKeyEnv:'DEEPSEEK_API_KEY'},defaultCwd}={}) {
  const plan=await inspectMigration({sourceRoot,dataRoot});releaseRoot=resolve(releaseRoot||sourceRoot);
  const report={schemaVersion:2,inputHash:plan.inputHash,sourceRoot:plan.sourceRoot,dataRoot:plan.dataRoot,counts:plan.counts,decisions:plan.decisions,sources:plan.sources.map(s=>({path:s.path,authority:s.authority,count:s.rows.length})),files:[],records:[],checks:[],mode:execute?'imported':'preview'};
  if(!execute)return report;
  const reportPath=join(plan.dataRoot,'migration','layout-v2.json');
  if(existsSync(reportPath)){const previous=await readJson(reportPath);if(previous.inputHash===plan.inputHash&&previous.completedAt){await verifyMigration(previous);return {...previous,mode:'unchanged'};}throw new Error('Migration input changed after import; resolve differences before another import');}
  const {BotStore,inspectBotIdentity}=await import(pathToFileURL(join(releaseRoot,'bot/src/index.mjs'))),{RecordStore}=await import(pathToFileURL(join(releaseRoot,'capabilities/shared/store.mjs'))),{BotManager}=await import(pathToFileURL(join(releaseRoot,'capabilities/bot-management/service.mjs')));
  for(const instance of plan.instances)if(await inspectBotIdentity(instance.root))throw new Error(`Source instance still owns its data: ${instance.instanceId}`);
  for(const {row}of plan.selected.values())if(row.kind==='bots'&&await inspectBotIdentity(join(plan.dataRoot,'bots',row.id)))throw new Error(`Target Bot is running: ${row.id}`);
  if(await inspectServiceLock(plan.dataRoot,'gateway'))throw new Error('Target capability gateway is running');
  // Check source writers before opening any target database. No PID-based termination.
  for(const instance of plan.instances){const runPath=join(instance.root,'run.json');if(!existsSync(runPath))continue;const run=await readJson(runPath);if(!Number.isInteger(run.pid))continue;let alive=true;try{process.kill(run.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}if(alive&&run.state!=='stopped')throw new Error(`Source instance may still be running: ${instance.instanceId}; stop it before migration`);}
  await mkdir(dirname(reportPath),{recursive:true});const lockPath=join(dirname(reportPath),'layout-v2.lock'),lock=await open(lockPath,'wx');
  await lock.writeFile(canonical({pid:process.pid,inputHash:plan.inputHash}));
  const stores=new Map(),botStores=new Map();
  const store=name=>{if(!stores.has(name))stores.set(name,new RecordStore(join(plan.dataRoot,'capabilities',name,'state.sqlite')));return stores.get(name);};
  const bots=id=>{if(!botStores.has(id))botStores.set(id,new BotStore(join(plan.dataRoot,'bots',id,'state.sqlite')));return botStores.get(id);};
  const put=(destination,kind,value)=>{const prior=destination.get(kind,value.id);if(prior&&canonical(prior)!==canonical(value))throw new Error(`Target record conflict: ${kind}:${value.id}`);if(!prior)destination.import(kind,value);};
  try {
    const manager=new BotManager({store:store('bot-management'),dataRoot:plan.dataRoot,releaseRoot,model,defaultCwd,getTools:()=>[]});
    const botRows=[...plan.selected.values()].filter(item=>item.row.kind==='bots');
    for(const {row}of botRows){const value=row.value;const roleId=['bot-engineer','bot-components','bot-qa'].includes(value.id)?value.id.slice(4):'default';
      await manager.create({...value,roleId});const generated=manager.store.get('bots',value.id);
      manager.store.import('bots',{...generated,...value,roleId,capabilityToken:generated.capabilityToken,allowedTools:generated.allowedTools,runIntent:'stopped'});
    }
    const getBotId=row=>row.value.botId || (row.kind==='toolRuns'?plan.selected.get(`agentRuns:${row.value.runId}`)?.row.value.botId:null);
    // Every original artifact/resource/workspace gets its final owner before references change.
    const mappings=[];
    for(const {row}of botRows){const id=row.id,short=createHash('sha256').update(id).digest('hex').slice(0,24),target=join(plan.dataRoot,'bots',id);
      for(const source of plan.sources.filter(s=>s.authority==='public'))for(const child of ['workspace','resources','artifacts','memory']){const origin=join(source.root,'bots',short,child),dest=join(target,child);await copyChecked(origin,dest,report.files);mappings.push([origin,dest]);}
      for(const instance of plan.instances.filter(item=>item.botId===id))for(const child of ['artifacts','resources','workspace']){for(const origin of [join(instance.root,child),join(instance.root,'legacy',child)]){const dest=join(target,child);await copyChecked(origin,dest,report.files);mappings.push([origin,dest]);}}
    }
    const evidenceFile=(name,entry)=>!name.split('/').some(part=>['node_modules','.git','snapshot','snapshots','backup','backups'].includes(part)) && (entry.isDirectory() || /\.(?:json|jsonl|png|jpe?g|webp|txt|md|log|csv|html)$/i.test(name));
    for(const source of plan.sources.filter(s=>s.authority==='public')){await copyChecked(join(source.root,'attachments'),join(plan.dataRoot,'capabilities/chatroom/attachments'),report.files);await copyChecked(join(source.root,'evidence'),join(plan.dataRoot,'verification/history'),report.files,evidenceFile);}
    mappings.sort((a,b)=>b[0].length-a[0].length);
    const remap=value=>{if(Array.isArray(value))return value.map(remap);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,['path','cwd','workspace','projectRoot','artifactRoot','filePath','absolutePath'].includes(key)&&typeof item==='string'?mapPath(item):remap(item)]));return value;};
    const mapPath=value=>{for(const [from,to]of mappings)if(within(from,resolve(value)))return join(to,relative(from,resolve(value)));return value;};
    for(const [key,{row,source}]of plan.selected){let value=remap(row.value),destination;
      if(row.kind==='bots')destination='bot-management/bots';
      else if(executionKinds.has(row.kind)||row.kind==='memories'){
        const botId=getBotId(row);if(!botId||!manager.store.get('bots',botId))throw new Error(`Execution owner missing: ${key}`);const db=bots(botId);
        db.putRecord(row.kind,value);
        if(row.kind==='agentSessions')db.saveSession({...value,id:value.id,contextKey:value.roomId?`room:${value.roomId}`:value.contextKey});
        if(row.kind==='memories')db.putMemory({...value,text:value.text??value.content??'',expectedRevision:undefined});
        if(row.kind==='jobs')put(store('chatroom'),'deliveries',{...value,status:terminal.has(value.status)?value.status:'interrupted',...(terminal.has(value.status)?{}:{error:'Migration stopped unconfirmed work; explicit retry required'})});
        destination=`bots/${botId}/${row.kind}`;
      }else{
        const owner={rooms:'chatroom',messages:'chatroom',nodes:'knowledge',edges:'knowledge',works:'codex',workEvents:'codex',routines:'bot-management'}[row.kind];if(!owner)throw new Error(`Unknown source collection: ${row.kind}`);
        if(row.kind==='works'&&!terminal.has(value.status)){value={...value,status:'interrupted',error:'Migration requires explicit resume'};}
        put(store(owner),row.kind,value);destination=`${owner}/${row.kind}`;
      }
      report.records.push({key,source:source.path,destination,sourceHash:digest(row.data),targetHash:digest(canonical(value))});
    }
    // Preserve old request receipts/events as historical facts, never as runnable work.
    for(const instance of plan.instances){const path=join(instance.root,'state.sqlite');if(!existsSync(path))continue;const db=new DatabaseSync(path,{readOnly:true});
      try{for(const name of ['requests','events','tool_runs','kv_state','sessions']){if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name))continue;let index=0;for(const row of db.prepare(`SELECT * FROM ${name}`).all()){
        const value={id:`${instance.instanceId}:${name}:${++index}`,instanceId:instance.instanceId,botId:instance.botId,sourceSchema:1,row};
        if(instance.app==='ui'||instance.botId==='ui-entry')put(store('gateway'),`imported-${name}`,value);else bots(instance.botId).putRecord(`imported-${name}`,value);
      }}}finally{db.close();}
    }
    for(const db of [...stores.values(),...botStores.values()]){
      for(const row of db.db.prepare('SELECT kind,id,data FROM records').all())report.checks.push({database:db.path,table:'records',kind:row.kind,id:row.id,sha256:digest(row.data)});
      if(botStores.has([...botStores].find(([,value])=>value===db)?.[0]))for(const table of ['sessions','memories'])for(const row of db.db.prepare(`SELECT id,data FROM ${table}`).all())report.checks.push({database:db.path,table,id:row.id,sha256:digest(row.data)});
    }
    report.verification=await verifyMigration(report);
    report.completedAt=new Date().toISOString();report.copiedFilesVerified=true;report.automaticReplay=false;report.backupCreated=false;
    await writeJson(reportPath,report);return report;
  }finally{for(const db of botStores.values())db.close();for(const db of stores.values())db.close();await lock.close();await unlink(lockPath);}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {options}=parseArgs(process.argv.slice(2));migrate({sourceRoot:options['source-root']||resolve('.'),dataRoot:options['data-root'],releaseRoot:options['release-root'],execute:Boolean(options.execute)})
    .then(result=>console.log(JSON.stringify({mode:result.mode,counts:result.counts,records:result.records.length,files:result.files.length,inputHash:result.inputHash},null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
