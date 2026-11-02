import { realpath,lstat,readdir,rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { within,fail } from '../shared/validation.mjs';

/** Only stopped, fully known work may lose its disposable files. */
export async function cleanTemporaryData(manager,botId,{externalTasks=[]}={}) {
  const bot=manager.get(botId),dir=manager.directory(bot.id);
  if(await manager.identity(botId))return {botId,cleaned:false,reason:'running'};
  const api=await manager.botApi();
  try{return await api.withBotDataLease(dir,async()=>{
  const facts=await manager.readState(botId,db=>({tasks:db?.listUnfinishedTasks()||[],tools:db?.listTools()||[],works:db?.listRecords('works')||[]}));
  if(facts.tasks.length||facts.tools.some(tool=>['unknown','running','queued'].includes(tool.status))||facts.works.some(work=>!['completed','cancelled'].includes(work.status)))return {botId,cleaned:false,reason:'unfinished-or-unknown-work'};
  const currentExternal=typeof externalTasks==='function'?externalTasks():externalTasks;
  if(currentExternal.some(task=>task.botId===botId&&!['completed','failed','cancelled'].includes(task.status)))return {botId,cleaned:false,reason:'external-work'};
  const root=join(dir,'tmp');if(!existsSync(root))return {botId,cleaned:true,removed:[]};
  const managed=await realpath(dir),physical=await realpath(root);if(!within(managed,physical)||(await lstat(root)).isSymbolicLink())fail('Temporary directory escaped its managed Bot root');
  async function validate(path){if((await lstat(path)).isSymbolicLink()||!within(physical,await realpath(path)))fail('Temporary directory contains an external link');for(const entry of await readdir(path,{withFileTypes:true}))if(entry.isDirectory())await validate(join(path,entry.name));else if(entry.isSymbolicLink())fail('Temporary file is an external link');}
  await validate(root);const removed=await readdir(root);for(const name of removed){const target=join(root,name);if(!within(physical,await realpath(target)))fail('Cleanup boundary changed');await rm(target,{recursive:true,force:false});}return {botId,cleaned:true,removed};
  },{botId,purpose:'clean-disposable-data'});}catch(error){if(error.code==='INSTANCE_ALREADY_RUNNING')return {botId,cleaned:false,reason:'running'};throw error;}
}
