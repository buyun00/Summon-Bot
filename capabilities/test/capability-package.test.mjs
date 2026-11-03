import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageCapabilityPackage,verifyCapabilityPackage } from '../services/publish.mjs';

test('capability package preserves imported files and rejects mutation under a published version',async t=>{
  const root=await mkdtemp(join(tmpdir(),'summon-cap-package-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),dataRoot=join(root,'data');await mkdir(source);
  await writeFile(join(source,'capability.json'),JSON.stringify({id:'sample',version:'v1',entry:'index.mjs',stateVersion:'1'}));
  await writeFile(join(source,'index.mjs'),"export { createCapability } from './implementation.mjs';\n");
  await writeFile(join(source,'implementation.mjs'),'export function createCapability(){return {tools:[]};}\n');
  const staged=await stageCapabilityPackage({packageRoot:source,dataRoot,id:'sample',version:'v1'});
  assert.equal((await verifyCapabilityPackage(staged.root)).contentHash,staged.contentHash);
  assert.equal((await stageCapabilityPackage({packageRoot:source,dataRoot,id:'sample',version:'v1'})).root,staged.root);
  await writeFile(join(source,'implementation.mjs'),'export function createCapability(){return {tools:[],changed:true};}\n');
  await assert.rejects(stageCapabilityPackage({packageRoot:source,dataRoot,id:'sample',version:'v1'}),/immutable/);
  assert.doesNotMatch(await readFile(join(staged.root,'implementation.mjs'),'utf8'),/changed/);
  await writeFile(join(staged.root,'implementation.mjs'),'tampered');
  await assert.rejects(verifyCapabilityPackage(staged.root),/changed/);
});

test('capability package rejects runtime credentials, traversal and identity mismatch',async t=>{
  const root=await mkdtemp(join(tmpdir(),'summon-cap-package-invalid-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source'),dataRoot=join(root,'data');await mkdir(source);
  const spec={id:'sample',version:'v1',entry:'../outside.mjs'};await writeFile(join(source,'capability.json'),JSON.stringify(spec));
  await assert.rejects(stageCapabilityPackage({packageRoot:source,dataRoot,id:'sample',version:'v1'}),/contained/);
  await writeFile(join(source,'capability.json'),JSON.stringify({...spec,entry:'index.mjs'}));await writeFile(join(source,'index.mjs'),'export const createCapability=()=>({tools:[]});');
  await writeFile(join(source,'.env'),'PRIVATE=fixture');
  await assert.rejects(stageCapabilityPackage({packageRoot:source,dataRoot,id:'sample',version:'v1'}),/credential/);
  await assert.rejects(stageCapabilityPackage({packageRoot:source,dataRoot,id:'sample',version:'v2'}),/identity/);
});
