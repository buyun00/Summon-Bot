const shapes=Object.entries(characters).map(([id,m])=>({id,label:m.name})),colors=templates.map(p=>p.color);
const safeImage=value=>typeof value==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)?value:null;
function normalize(value={}){const role=characters[value.shape]?value.shape:legacyRoles[value.shape]||'dev',m=characters[role];return {shape:role,color:hex(value.color,m.color),secondary:hex(value.secondary,m.secondary),ink:hex(value.ink,'#142443'),paper:hex(value.paper,'#FFFAF1'),image:safeImage(value.image)};}
function defaults(botId,index=0){const seeded={'bot-engineer':'dev','bot-components':'plan','bot-qa':'qa'};let value=5381;for(const c of String(botId||`bot-${index}`))value=(Math.imul(value,33)^c.codePointAt(0))>>>0;return normalize({shape:seeded[botId]||shapes[value%shapes.length].id});}
function paletteOf(a){return {accent:a.color,secondary:a.secondary,ink:a.ink,paper:a.paper};}
const mountedAvatars=new Map();let raf=0,last=0;
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
function render(appearance={},size=40,options={}){
 const a=normalize(appearance),dimension=Math.max(8,Math.min(512,Number(size)||40));
 if(a.image)return `<img class="relay-bot-face" src="${a.image}" alt="" width="${dimension}" height="${dimension}" style="object-fit:cover;border-radius:22%;flex:none">`;
 const holder=document.createElement('span'),avatar=new CrewAvatar(holder,a.shape,{size:dimension,palette:paletteOf(a)}),svg=avatar.svg;
 svg.classList.add('relay-bot-face');svg.dataset.crew=JSON.stringify(a);svg.dataset.avatarKey=options.key||'';svg.dataset.crewState=states[options.state]?options.state:'idle';svg.dataset.crewStatic=String(!!options.static||!options.key);svg.setAttribute('aria-hidden','true');svg.style.cssText+=';display:block;flex:none;overflow:visible';
 return svg.outerHTML;
}
function hydrate(root=document){
 const nodes=[...(root.matches?.('[data-crew]')?[root]:[]),...root.querySelectorAll('[data-crew]')];
 for(const node of nodes){if(node.dataset.crewStatic==='true')continue;const key=node.dataset.avatarKey;if(!key)continue;
  let a;try{a=normalize(JSON.parse(node.dataset.crew));}catch{continue;}
  let entry=mountedAvatars.get(key);const desired=node.dataset.crewState||'idle';
  if(!entry||entry.avatar.role!==a.shape){entry?.avatar.destroy();const holder=document.createElement('span');entry={avatar:new CrewAvatar(holder,a.shape,{size:Number(node.getAttribute('width')),palette:paletteOf(a)}),seen:performance.now()};mountedAvatars.set(key,entry);}
  entry.avatar.setPalette(paletteOf(a));if(entry.avatar.state!==desired)entry.avatar.setState(desired);
  if(node!==entry.avatar.svg){for(const attribute of [...node.attributes])if(attribute.name!=='style')entry.avatar.svg.setAttribute(attribute.name,attribute.value);entry.avatar.svg.classList.add('relay-bot-face');node.replaceWith(entry.avatar.svg);}
  entry.seen=performance.now();
 }
 wake();
}
function wake(){if(!raf&&!document.hidden&&!reduce.matches){last=performance.now();raf=requestAnimationFrame(tick);}}
function tick(now){raf=0;const dt=Math.min((now-last)/1000,.04);last=now;let visible=false;
 for(const [key,entry] of mountedAvatars){const node=entry.avatar.svg;if(!node.isConnected){if(now-entry.seen>60000){entry.avatar.destroy();mountedAvatars.delete(key);}continue;}entry.seen=now;const rect=node.getBoundingClientRect();if(rect.bottom<0||rect.top>innerHeight||rect.right<0||rect.left>innerWidth)continue;visible=true;entry.avatar.tick(dt);}
 if(visible&&!document.hidden&&!reduce.matches)raf=requestAnimationFrame(tick);
}
document.addEventListener('visibilitychange',wake);document.addEventListener('scroll',wake,true);reduce.addEventListener('change',wake);
window.RelayAvatars=Object.freeze({shapes,colors,templates,render,defaults,normalize,capture(){},hydrate});
