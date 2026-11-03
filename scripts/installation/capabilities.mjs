import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson,parseArgs } from '../build/files.mjs';

export async function capabilityCommand({dataRoot,operation='list',input={}}) {
  const config=await readJson(join(resolve(dataRoot),'config','deployment.json'));
  const running=await readJson(join(resolve(dataRoot),'capabilities','gateway','run','current.json'));
  const path=operation==='list'?'/api/capabilities':`/api/capabilities/${encodeURIComponent(operation)}`;
  const response=await fetch(running.url+path,{method:operation==='list'?'GET':'POST',headers:{Authorization:`Bearer ${config.gatewayToken}`,'Content-Type':'application/json'},...(operation==='list'?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(180000)});
  const result=await response.json();if(!response.ok)throw new Error(result.error?.message||result.error||`Capability operation failed (${response.status})`);return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const {options,positional}=parseArgs(process.argv.slice(2));
  const operation=positional[0]||'list';
  const input=options.file?await readJson(resolve(options.file)):{id:options.id,version:options.version,botId:options.bot,'releaseRoot':options['release-root'],packageRoot:options['package-root']};
  capabilityCommand({dataRoot:options['data-root']||process.env.SUMMON_DATA_ROOT||'D:/Relay-Bot-data',operation,input}).then(value=>console.log(JSON.stringify(value,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
