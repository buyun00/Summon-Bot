import { resolve,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { mkdir,copyFile,readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { copyTree,readJson,writeJson,within,parseArgs } from '../build/files.mjs';
import { verifyRelease } from '../build/verify.mjs';
import { initializeDeployment,inspectService,deploymentPath } from './system.mjs';

/** Install verified immutable code. Data is never replaced or copied into the release. */
export async function installRelease({releaseRoot,appRoot,dataRoot,defaultCwd,publicOrigin='',port=8787}={}) {
  releaseRoot=resolve(releaseRoot);appRoot=resolve(appRoot);dataRoot=resolve(dataRoot);
  if(within(appRoot,dataRoot)||within(dataRoot,appRoot))throw new Error('Application and data roots must be disjoint');
  const verified=await verifyRelease(releaseRoot),destination=join(appRoot,'releases',verified.buildId);
  if(!within(join(appRoot,'releases'),destination))throw new Error('Invalid release build ID');
  if(existsSync(deploymentPath(dataRoot))){const current=await readJson(deploymentPath(dataRoot));for(const type of ['gateway','web'])if((await inspectService(current,type)).state!=='stopped')throw new Error('Stop managed services before installing a different release');}
  const {inspectBotIdentity}=await import(pathToFileURL(join(releaseRoot,'bot/src/index.mjs')));
  if(existsSync(join(dataRoot,'bots')))for(const entry of await readdir(join(dataRoot,'bots'),{withFileTypes:true})) {
    if(entry.isDirectory()&&await inspectBotIdentity(join(dataRoot,'bots',entry.name)))throw new Error(`Stop independent Bot ${entry.name} before installing a release`);
  }
  if(existsSync(destination)){if((await readJson(join(destination,'release-manifest.json'))).contentHash!==(await readJson(join(releaseRoot,'release-manifest.json'))).contentHash)throw new Error('Release ID collision');await verifyRelease(destination);}
  else {await copyTree(releaseRoot,destination);await verifyRelease(destination);}
  const initialized=await initializeDeployment({dataRoot,releaseRoot:destination,defaultCwd,publicOrigin,port});
  await writeJson(deploymentPath(dataRoot),{...initialized.config,releaseRoot:destination});
  await mkdir(appRoot,{recursive:true});
  for(const name of ['Start.ps1','Stop.ps1','Run.cmd'])await copyFile(join(destination,name),join(appRoot,name));
  const selection={schemaVersion:1,releaseRoot:destination,buildId:verified.buildId,dataRoot,selectedAt:new Date().toISOString()};
  await writeJson(join(appRoot,'current.json'),selection);return selection;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {options}=parseArgs(process.argv.slice(2));installRelease({releaseRoot:options['release-root'],appRoot:options['app-root'],dataRoot:options['data-root'],defaultCwd:options.cwd,publicOrigin:options['public-origin'],port:options.port})
    .then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
