import { resolve,join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { mkdir,copyFile,readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { copyTree,readJson,writeJson,within,parseArgs } from '../build/files.mjs';
import { verifyRelease } from '../build/verify.mjs';
import { initializeDeployment,inspectService,deploymentPath } from './system.mjs';
import { selectCurrentVersion } from './current-version.mjs';

/** Install a selected build; development packages use manifest metadata only. */
export async function installRelease({releaseRoot,appRoot,dataRoot,sourceRoot,defaultCwd,publicOrigin='',port=8787}={}) {
  releaseRoot=resolve(releaseRoot);appRoot=resolve(appRoot);dataRoot=resolve(dataRoot);
  if(within(appRoot,dataRoot)||within(dataRoot,appRoot))throw new Error('Application and data roots must be disjoint');
  const verified=await verifyRelease(releaseRoot),destination=join(appRoot,'releases',verified.buildId);
  if(!within(join(appRoot,'releases'),destination))throw new Error('Invalid release build ID');
  if(existsSync(deploymentPath(dataRoot))){
    const current=await readJson(deploymentPath(dataRoot));for(const type of ['gateway','web'])if((await inspectService(current,type)).state!=='stopped')throw new Error('Stop managed services before installing a different release');
    const module=join(releaseRoot,'capabilities/services/supervisor.mjs');
    if(existsSync(module)){
      const {CapabilityServiceSupervisor}=await import(pathToFileURL(module));
      const services=await new CapabilityServiceSupervisor({dataRoot,releaseRoot}).list();
      if(services.some(service=>service.state!=='stopped'))throw new Error('Stop managed capability services before replacing the full runtime; use capability deploy for a hot upgrade');
    }
  }
  const {inspectBotIdentity}=await import(pathToFileURL(join(releaseRoot,'bot/src/index.mjs')));
  if(existsSync(join(dataRoot,'bots')))for(const entry of await readdir(join(dataRoot,'bots'),{withFileTypes:true})) {
    if(entry.isDirectory()&&await inspectBotIdentity(join(dataRoot,'bots',entry.name)))throw new Error(`Stop independent Bot ${entry.name} before installing a release`);
  }
  if(existsSync(destination)){
    const installed=await readJson(join(destination,'release-manifest.json'));
    const sameBuild=(installed.profile||'release')===verified.profile&&installed.buildId===verified.buildId&&installed.sourceCommit===verified.sourceCommit;
    if(!sameBuild)throw new Error('Release ID collision');await verifyRelease(destination);
  }
  else {await copyTree(releaseRoot,destination);await verifyRelease(destination);}
  const initialized=await initializeDeployment({dataRoot,releaseRoot:destination,defaultCwd,publicOrigin,port});
  sourceRoot=sourceRoot||initialized.config.sourceRoot;
  await writeJson(deploymentPath(dataRoot),{...initialized.config,releaseRoot:destination,...(sourceRoot?{sourceRoot:resolve(sourceRoot)}:{})});
  await mkdir(appRoot,{recursive:true});
  for(const name of ['Start.ps1','Start-Hidden.vbs','Stop.ps1','Run.cmd'])await copyFile(join(destination,name),join(appRoot,name));
  const selection={schemaVersion:1,releaseRoot:destination,buildId:verified.buildId,dataRoot,selectedAt:new Date().toISOString()};
  await writeJson(join(appRoot,'current.json'),selection);
  const cleanup=await selectCurrentVersion({appRoot,dataRoot,sourceRoot,releaseRoot:destination,buildId:verified.buildId});
  return {...selection,cleanup};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {options}=parseArgs(process.argv.slice(2));installRelease({releaseRoot:options['release-root'],appRoot:options['app-root'],dataRoot:options['data-root'],sourceRoot:options['source-root'],defaultCwd:options.cwd,publicOrigin:options['public-origin'],port:options.port})
    .then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
