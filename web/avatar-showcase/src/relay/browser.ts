import { paperShapes, paperTemplates, normalizePaperAvatar, defaultPaperAvatar } from '../../../../capabilities/shared/avatar-style.mjs'
import { PaperRig, motions } from './rig'
import type { BotFrame } from '../bot/engine'

type Appearance=ReturnType<typeof normalizePaperAvatar>
const ns='http://www.w3.org/2000/svg'
let serial=0
const node=(name:string,attrs:Record<string,unknown>={})=>{const element=document.createElementNS(ns,name);for(const [key,value]of Object.entries(attrs))element.setAttribute(key,String(value));return element}
function eyesColor(color:string,paper:string){const channels=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);return channels[0]!*0.2126+channels[1]!*0.7152+channels[2]!*0.0722>.69?'#485346':paper}
class PaperAvatar {
  svg:SVGElement;rig:PaperRig;appearance:Appearance;time=0;seen=0;requested='idle';completedUntil=0
  private body:SVGElement;private backing:SVGElement;private edge:SVGElement;private maskBody:SVGElement;private eyes:SVGElement[]
  private backArcs:SVGElement;private frontArcs:SVGElement
  constructor(appearance:Appearance,size:number,motion:string){
    this.appearance=appearance;this.rig=new PaperRig(appearance.shape,motion);this.requested=motion
    const id=`paper-avatar-${++serial}`
    this.svg=node('svg',{xmlns:ns,viewBox:'-158 -158 316 316',width:size,height:size,'aria-hidden':'true',class:'relay-bot-face',style:'display:block;flex:none;overflow:visible'})
    const defs=node('defs'),mask=node('mask',{id:`${id}-mask`,maskUnits:'userSpaceOnUse',x:-158,y:-158,width:316,height:316})
    this.maskBody=node('path',{fill:'#fff'});mask.append(this.maskBody)
    this.eyes=[node('path',{fill:'#000'}),node('path',{fill:'#000'})];mask.append(...this.eyes);defs.append(mask)
    const filter=node('filter',{id:`${id}-grain`,x:'0%',y:'0%',width:'100%',height:'100%','color-interpolation-filters':'sRGB'})
    filter.append(node('feTurbulence',{type:'fractalNoise',baseFrequency:'0.76 0.59',numOctaves:3,seed:12,stitchTiles:'stitch'}),node('feColorMatrix',{type:'saturate',values:0}));defs.append(filter)
    this.backArcs=node('g');this.frontArcs=node('g')
    this.backing=node('path',{transform:'translate(4.5 5.5) rotate(-3)',stroke:'#CFC4AB','stroke-width':.65})
    this.body=node('path');this.edge=node('path',{fill:'none','stroke-opacity':.16,'stroke-width':.75})
    const ink=node('g',{mask:`url(#${id}-mask)`}),paint=node('rect',{x:-158,y:-158,width:316,height:316,'data-paper-fill':''})
    ink.append(paint,node('rect',{x:-158,y:-158,width:316,height:316,filter:`url(#${id}-grain)`,opacity:.15,style:'mix-blend-mode:soft-light'}))
    this.svg.append(defs,this.backArcs,this.backing,this.body,ink,this.edge,this.frontArcs)
    this.setAppearance(appearance);this.draw(this.rig.sample(0))
  }
  setAppearance(value:Appearance){
    if(value.shape!==this.appearance.shape)this.rig.setShape(value.shape,this.time)
    this.appearance=value;this.backing.setAttribute('fill',value.secondary);this.body.setAttribute('fill',eyesColor(value.color,value.paper));this.edge.setAttribute('stroke',value.ink)
    this.svg.querySelector('[data-paper-fill]')!.setAttribute('fill',value.color)
  }
  private arcs(host:SVGElement,arcs:BotFrame['arcs'],half:'back'|'front'){
    while(host.children.length>arcs.length)host.lastElementChild!.remove()
    arcs.forEach((arc,index)=>{let path=host.children[index];if(!path){path=node('path',{fill:'none','stroke-linecap':'round'});host.append(path)}path.setAttribute('d',arc[half]);path.setAttribute('stroke',this.appearance.color);path.setAttribute('stroke-width',String(arc.width));path.setAttribute('opacity',String(arc.opacity*.8))})
  }
  draw(frame:BotFrame){
    for(const part of [this.body,this.backing,this.edge,this.maskBody])part.setAttribute('d',frame.bodyPath)
    frame.eyes.forEach((eye,index)=>{const path=this.eyes[index]!;path.setAttribute('d',eye.d);path.setAttribute('transform',eye.matrix);path.setAttribute('opacity',String(eye.alpha))})
    this.arcs(this.backArcs,frame.arcs,'back');this.arcs(this.frontArcs,frame.arcs,'front')
  }
  setMotion(next:string){if(next===this.requested)return;const celebrate=next==='idle'&&['work','think'].includes(this.requested);this.requested=next;this.completedUntil=celebrate?this.time+2.8:0;this.rig.setMotion(celebrate?'done':next,this.time)}
  tick(delta:number){this.time+=delta;if(this.completedUntil&&this.time>=this.completedUntil){this.completedUntil=0;this.rig.setMotion('idle',this.time)}this.draw(this.rig.sample(this.time))}
}
const instances=new Map<string,PaperAvatar>()
const reduced=matchMedia('(prefers-reduced-motion: reduce)')
let raf=0,last=0,drawn=0
function render(value={},size=40,options:{key?:string;state?:string;static?:boolean}={}){
  const appearance=normalizePaperAvatar(value),dimension=Math.max(8,Math.min(512,Number(size)||40))
  if(appearance.image)return `<img class="relay-bot-face" src="${appearance.image}" width="${dimension}" height="${dimension}" alt="" style="object-fit:cover;border-radius:22%;flex:none">`
  const item=new PaperAvatar(appearance,dimension,options.state||'idle')
  item.svg.dataset.paperAvatar=JSON.stringify(appearance);item.svg.dataset.avatarKey=options.key||'';item.svg.dataset.paperState=options.state||'idle';item.svg.dataset.paperStatic=String(Boolean(options.static||!options.key))
  return item.svg.outerHTML
}
function hydrate(root:ParentNode&{matches?:(selector:string)=>boolean}=document){
  const nodes=[...(root.matches?.('[data-paper-avatar]')?[root as unknown as SVGElement]:[]),...root.querySelectorAll<SVGElement>('[data-paper-avatar]')]
  for(const target of nodes){
    if(target.dataset.paperStatic==='true'||target.closest('[data-motion-ghost]'))continue
    const key=target.dataset.avatarKey;if(!key)continue
    let appearance:Appearance;try{appearance=normalizePaperAvatar(JSON.parse(target.dataset.paperAvatar!))}catch{continue}
    let item=instances.get(key)
    if(!item){item=new PaperAvatar(appearance,Number(target.getAttribute('width')),target.dataset.paperState||'idle');instances.set(key,item)}
    item.setAppearance(appearance);item.setMotion(target.dataset.paperState||'idle')
    if(target!==item.svg){item.svg.dataset.paperAvatar=JSON.stringify(appearance);item.svg.dataset.avatarKey=key;item.svg.dataset.paperState=target.dataset.paperState||'idle';item.svg.dataset.paperStatic='false';item.svg.setAttribute('width',target.getAttribute('width')||'40');item.svg.setAttribute('height',target.getAttribute('height')||'40');target.replaceWith(item.svg)}
    item.seen=performance.now();if(reduced.matches)item.draw(item.rig.sample(item.time))
  }
  wake()
}
function tick(now:number){
  raf=0;if(document.hidden||reduced.matches)return
  const delta=last?Math.min((now-last)/1000,.064):0;last=now
  if(now-drawn<1000/30){raf=requestAnimationFrame(tick);return}const elapsed=drawn?Math.min((now-drawn)/1000,.064):delta;drawn=now
  let visible=false
  for(const [key,item]of instances){if(!item.svg.isConnected){if(now-item.seen>60000)instances.delete(key);continue}const r=item.svg.getBoundingClientRect();if(r.bottom<0||r.top>innerHeight||r.right<0||r.left>innerWidth)continue;visible=true;item.seen=now;item.tick(elapsed)}
  if(visible)raf=requestAnimationFrame(tick)
}
function wake(){if(!raf&&!document.hidden&&!reduced.matches){last=0;drawn=0;raf=requestAnimationFrame(tick)}}
document.addEventListener('visibilitychange',wake);document.addEventListener('scroll',wake,true);reduced.addEventListener('change',()=>{if(reduced.matches&&raf){cancelAnimationFrame(raf);raf=0}else wake()})
Object.assign(window,{RelayAvatars:Object.freeze({shapes:paperShapes,colors:paperTemplates.map(item=>item.color),templates:paperTemplates,normalize:normalizePaperAvatar,defaults:defaultPaperAvatar,render,hydrate,capture(){},states:Object.keys(motions)})})
