// Build real Bloub avatars and native vector clips. No tests or integrity scans.
import { writeFile,mkdir,readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=new URL('../../',import.meta.url),showcase=new URL('web/avatar-showcase/',root);
const built=spawnSync(process.execPath,[fileURLToPath(new URL('build-avatars.mjs',showcase))],{cwd:fileURLToPath(showcase),stdio:'inherit',windowsHide:true});
if(built.status!==0)throw new Error('Paper avatar build failed');
const {default:svgpath}=await import(new URL('node_modules/svgpath/index.js',showcase));
const {PaperRig,motions,paperShapes,paperTemplates,paperLegacyShapes,paperLegacyColors,defaultPaperAvatar}=await import(new URL('generated/engine.mjs',showcase));
const round=value=>Math.round(value*10000)/10000;
const ops=value=>svgpath(value).abs().unarc().unshort().segments.map(a=>a.map(n=>typeof n==='number'?round(n):n));
function bounds(path){const values=path.flatMap(segment=>segment.slice(1));const x=values.filter((_,i)=>i%2===0),y=values.filter((_,i)=>i%2===1);return [Math.min(...x),Math.min(...y),Math.max(...x),Math.max(...y)];}
const fps=20,characters={},sharedClips={};
function clipFor(shape,motion,spec,base){
  const rig=new PaperRig(shape,motion);
  return {duration:spec.duration,once:motion==='done'||!!spec.once,pingpong:spec.pose==='idle'&&motion!=='work',rows:Array.from({length:Math.round(spec.duration*fps)+1},(_,i)=>{
    const frame=rig.sample(i/fps),body=ops(frame.bodyPath),box=bounds(body);
    const sx=(box[2]-box[0])/(base[2]-base[0]),sy=(box[3]-box[1])/(base[3]-base[1]);
    const eyes=frame.eyes.map(eye=>{const b=bounds(ops(eye.d));const matrix=eye.matrix.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi).map(Number);return [b[0],b[1],b[2]-b[0],b[3]-b[1],...matrix,eye.alpha].map(round);});
    return {body:spec.fullBody?[1,0,0,1,0,0]:[sx,0,0,sy,box[0]-base[0]*sx,box[1]-base[1]*sy].map(round),eyes,alpha:round(frame.bodyAlpha),
      ...(spec.fullBody?{outline:body.flatMap(segment=>segment.slice(1))}:{}),
      ...(frame.dots.length?{dots:frame.dots.map(dot=>({x:round(dot.x),y:round(dot.y),r:round(dot.r),alpha:round(dot.opacity),...(dot.d?{path:ops(dot.d),rotation:dot.rot||0}:{})})),dotsBehind:frame.dotsBehind}:{}),
      ...(motion!=='work'&&frame.arcs.length?{arcs:frame.arcs.map(arc=>({back:ops(arc.back),front:ops(arc.front),width:round(arc.width),opacity:round(arc.opacity*.8)}))}:{}),
      ...(frame.notif?{notification:[frame.notif.x,frame.notif.y,frame.notif.r].map(round)}:{}),
      ...(frame.notch?{notch:[frame.notch.x,frame.notch.y,frame.notch.r].map(round)}:{})};
  })};
}
for(const shape of paperShapes){
  const body=ops(new PaperRig(shape.id).sample(0).bodyPath),base=bounds(body),frames={};
  for(const [motion,spec]of Object.entries(motions)){
    if(spec.fullBody){if(!sharedClips[motion])sharedClips[motion]=clipFor('cercle',motion,spec,bounds(ops(new PaperRig('cercle').sample(0).bodyPath)));}
    else frames[motion]=clipFor(shape.id,motion,spec,base);
  }
  characters[shape.id]={name:shape.label,body,frames};
}
const orbit=new PaperRig('cercle','work');
const rings={duration:4.3,rows:Array.from({length:Math.round(4.3*fps)+1},(_,i)=>orbit.sample(i/fps).arcs.map(arc=>({back:ops(arc.back),front:ops(arc.front),width:arc.width,opacity:arc.opacity*.8})))};
const fibers=Array.from({length:115},(_,i)=>[round(((i*73)%199)-99),round(((i*127)%193)-96),round(0.7+(i%5)*0.45),round(0.1+(i%3)*0.2)]);
const native={version:3,fps,shapes:paperShapes,templates:paperTemplates,legacyRoles:paperLegacyShapes,legacyColors:paperLegacyColors,characters,sharedClips,rings,fibers,defaults:Object.fromEntries(['bot-engineer','bot-components','bot-qa','bot-lumi','lumi','bot-entry','bot-chatroom','bot-manager','bot-memory'].map(id=>[id,defaultPaperAvatar(id)]))};
async function save(name,text){const url=new URL(name,root);await mkdir(new URL('.',url),{recursive:true});await writeFile(url,text);}
const json=JSON.stringify(native);
await save('ios/Summon/Resources/paper-avatars.json',json);
await save('android/app/src/main/assets/paper-avatars.json',json);
const license=await readFile(new URL('LICENSE',showcase),'utf8');
await save('ios/Summon/Resources/Bloub-LICENSE.txt',license);
await save('android/app/src/main/assets/Bloub-LICENSE.txt',license);
console.log(`Exported paper avatars: ${paperShapes.length} shapes, ${Object.keys(motions).length} Bloub vector motions, ${json.length} bytes per native catalog.`);
