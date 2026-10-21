import { mkdir, readFile, writeFile, rename, copyFile, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { verifyRelease } from '../../scripts/build/verify.mjs';
import { walk, within } from '../../scripts/build/files.mjs';
import { validateServiceIdentity } from './host.mjs';
import { BUILTIN_CAPABILITIES } from './builtin.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const error = message => Object.assign(new Error(message),{status:409});
const entryPath = (root,entry) => {
  if(typeof entry!=='string'||isAbsolute(entry)||entry.includes('\\')||entry.split('/').some(part=>['..','.',''].includes(part))||!entry.endsWith('.mjs'))throw error('Package entry must be a contained relative .mjs path');
  const path=resolve(root,entry);if(!within(root,path))throw error('Package entry leaves its root');return path;
};

/** Snapshot an explicit service package once; no active version is edited in place. */
export async function stageCapabilityPackage({packageRoot,dataRoot,id,version}) {
  validateServiceIdentity(id,version);packageRoot=resolve(packageRoot);
  if((await lstat(packageRoot)).isSymbolicLink())throw error('Capability package root must not be a link');
  const specification=JSON.parse(await readFile(join(packageRoot,'capability.json'),'utf8'));
  if(specification.id!==id||specification.version!==version)throw error('Package identity does not match deployment');
  entryPath(packageRoot,specification.entry);
  const stateVersion=specification.stateVersion||'1';validateServiceIdentity(id,stateVersion);
  const files=await walk(packageRoot,name=>name!=='package-integrity.json'&&!name.split('/').some(part=>['.git','test','tests','coverage'].includes(part)));
  if(files.some(file=>/(^|\/)\.env(?:\.|$)|\.(sqlite(?:-wal|-shm)?|log|key|pem)$/i.test(file.name)))throw error('A capability package cannot contain runtime data or credential files');
  const hashes={};for(const file of files)hashes[file.name]=sha(await readFile(file.path));
  if(!hashes[specification.entry])throw error('Capability entry is missing');
  const contentHash=sha(JSON.stringify(hashes)),destination=join(resolve(dataRoot),'capabilities','packages',id,version);
  if(within(packageRoot,destination)||within(destination,packageRoot))throw error('Package source and installed snapshot must be disjoint');
  if(existsSync(destination)) {
    const previous=JSON.parse(await readFile(join(destination,'package-integrity.json'),'utf8'));
    if(previous.contentHash!==contentHash)throw error('Capability package version is immutable; use a new version');
    await verifyCapabilityPackage(destination);return {root:destination,module:entryPath(destination,specification.entry),stateVersion,contentHash};
  }
  const staging=`${destination}.staging-${randomUUID()}`;await mkdir(staging,{recursive:true});
  for(const file of files){const target=join(staging,file.name);await mkdir(dirname(target),{recursive:true});await copyFile(file.path,target);}
  await writeFile(join(staging,'package-integrity.json'),JSON.stringify({id,version,entry:specification.entry,stateVersion,contentHash,files:hashes},null,2));
  await verifyCapabilityPackage(staging);await rename(staging,destination);
  return {root:destination,module:entryPath(destination,specification.entry),stateVersion,contentHash};
}

export async function verifyCapabilityPackage(root) {
  const manifest=JSON.parse(await readFile(join(root,'package-integrity.json'),'utf8'));
  const files=await walk(root),actual=files.filter(file=>file.name!=='package-integrity.json');
  if(actual.length!==Object.keys(manifest.files).length)throw error('Capability package file count changed');
  for(const file of actual)if(sha(await readFile(file.path))!==manifest.files[file.name])throw error(`Capability package file changed: ${file.name}`);
  if(sha(JSON.stringify(manifest.files))!==manifest.contentHash)throw error('Capability package integrity record changed');
  return manifest;
}

/** Deploy only a capability from a verified full release, or a standalone package.
 * The running gateway, Web and Bot processes are not replaced by this operation. */
export async function deployCapability(input,{dataRoot,defaultCwd,model,codexPath,gatewayUrl,gatewayToken,supervisor,registry,control}) {
  const {id,version}=input;validateServiceIdentity(id,version);
  if(Boolean(input.packageRoot)===Boolean(input.releaseRoot))throw error('Specify exactly one packageRoot or releaseRoot');
  let module,stateVersion,sourceRoot,integrity;
  if(input.releaseRoot) {
    if(!BUILTIN_CAPABILITIES.includes(id))throw error('Full releases contain only declared builtin capabilities');
    sourceRoot=resolve(input.releaseRoot);const checked=await verifyRelease(sourceRoot);
    module=join(sourceRoot,'capabilities','services','builtin.mjs');if(!existsSync(module))throw error('Release does not support independent capability services');
    stateVersion='1';integrity={releaseRoot:sourceRoot,contentHash:checked.contentHash};
  } else {
    const staged=await stageCapabilityPackage({packageRoot:input.packageRoot,dataRoot,id,version});
    module=staged.module;stateVersion=staged.stateVersion;sourceRoot=staged.root;integrity={packageRoot:sourceRoot,contentHash:staged.contentHash};
  }
  const instance=await supervisor.start({id,version,stateVersion,module,options:{...(input.options||{}),id,version,dataRoot,releaseRoot:sourceRoot,defaultCwd,model,codexPath,gatewayUrl,gatewayToken,...integrity}});
  const current=registry.getVersion(id,version);
  if(current)await registry.relocate(id,version,{endpoint:instance.url,token:instance.token});
  else await registry.register({id,version,endpoint:instance.url,token:instance.token,stateVersion});
  if(input.activate!==false)await control.activate(id,version);
  return {id,version,stateVersion,endpoint:instance.url,pid:instance.pid,activated:input.activate!==false,...integrity};
}
