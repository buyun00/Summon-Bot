import {characters,states} from './characters.js';
import {CrewAvatar} from './animator.js';
const $=id=>document.getElementById(id),keys=Object.keys(states),palettes=new Map();
let role='dev',state='idle',paused=matchMedia('(prefers-reduced-motion: reduce)').matches,auto=false,speed=1,cycleTime=0;
let selected=[],examples=[],cards=[];
function palette(){return palettes.get(role)||{accent:characters[role].color,secondary:characters[role].secondary,ink:'#142443',paper:'#fffaf1'};}
function create(host,who,size,status=state){return new CrewAvatar(host,who,{size,state:status,palette:who===role?palette():(palettes.get(who)||{})});}
function updateStateUI(){document.querySelectorAll('[data-state]').forEach(b=>b.classList.toggle('active',b.dataset.state===state));$('motionNote').textContent=states[state].description;$('roleNote').textContent=characters[role].verbs[keys.indexOf(state)];}
function changeState(next){state=next;cycleTime=0;for(const avatar of [...selected,...cards])avatar.setState(state);updateStateUI();}
function selectRole(next){
 role=next;selected.forEach(a=>a.destroy());examples.forEach(a=>a.destroy());selected=[];examples=[];$('sizes').replaceChildren();$('motionGrid').replaceChildren();
 selected.push(create($('hero'),role,280));
 for(const size of [24,32,48,64]){const holder=document.createElement('div');$('sizes').append(holder);selected.push(create(holder,role,size));const label=document.createElement('span');label.textContent=`${size} px`;holder.append(label);}
 for(const [key,spec] of Object.entries(states)){const holder=document.createElement('div');holder.className='motion-card';$('motionGrid').append(holder);examples.push(create(holder,role,96,key));const title=document.createElement('strong');title.textContent=spec.name;const desc=document.createElement('span');desc.textContent=`${spec.duration.toFixed(1)} 秒 · ${characters[role].verbs[keys.indexOf(key)]}`;holder.append(title,desc);}
 const colors=palette();for(const key of ['accent','secondary','ink','paper'])$(key).value=colors[key];$('roleTitle').textContent=characters[role].name;document.querySelectorAll('[data-role]').forEach(b=>b.classList.toggle('active',b.dataset.role===role));cycleTime=0;updateStateUI();
}
for(const [key,spec] of Object.entries(states)){const button=document.createElement('button');button.dataset.state=key;button.innerHTML=`${spec.name}<small>${spec.duration.toFixed(1)} s${spec.once?' · 单次':''}</small>`;button.onclick=()=>changeState(key);$('states').append(button);}
for(const [key,model] of Object.entries(characters)){const button=document.createElement('button');button.dataset.role=key;button.setAttribute('aria-label',`选择${model.name}`);$('catalog').append(button);cards.push(create(button,key,62));const label=document.createElement('span');label.textContent=model.name;button.append(label);button.onclick=()=>selectRole(key);}
selectRole(role);
function recolor(){const colors={};for(const key of ['accent','secondary','ink','paper'])colors[key]=$(key).value;palettes.set(role,colors);for(const a of [...selected,...examples,...cards.filter(a=>a.role===role)])a.setPalette(colors);}
for(const key of ['accent','secondary','ink','paper'])$(key).oninput=recolor;
$('reset').onclick=()=>{const m=characters[role];$('accent').value=m.color;$('secondary').value=m.secondary;$('ink').value='#142443';$('paper').value='#fffaf1';recolor();};
$('dark').onclick=()=>{const enabled=$('stage').classList.toggle('dark');$('dark').textContent=enabled?'浅色底':'深色底';};
function pauseLabel(){$('pause').textContent=paused?'播放':'暂停';}$('pause').onclick=()=>{paused=!paused;pauseLabel();};pauseLabel();
$('auto').onclick=()=>{auto=!auto;cycleTime=0;$('auto').textContent=`连续演示：${auto?'开':'关'}`;};
$('speed').oninput=()=>{speed=Number($('speed').value);$('rate').textContent=`${speed.toFixed(1)}×`;};
function download(content,type,name){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('svg').onclick=()=>download(selected[0].snapshot(),'image/svg+xml',`relay-${role}-${state}.svg`);
$('config').onclick=()=>download(JSON.stringify({format:'relay-little-crew-v1',role,palette:palette(),state,speed,states,transition:'critically-damped-spring',animationModule:'animator.js'},null,2),'application/json',`relay-${role}.json`);
let last=performance.now();
function frame(now){requestAnimationFrame(frame);const dt=Math.min((now-last)/1000,.04)*speed;last=now;if(paused||document.hidden)return;
 cycleTime+=dt;
 if(auto&&cycleTime>states[state].duration+1.2)changeState(keys[(keys.indexOf(state)+1)%keys.length]);
 for(const avatar of [...selected,...examples,...cards])avatar.tick(dt);
 for(const avatar of examples)if(avatar.state==='done'&&avatar.time>4.5)avatar.setState('done');
 const elapsed=selected[0].time,spec=states[state],progress=spec.once?Math.min(elapsed/spec.duration,1):(elapsed%spec.duration)/spec.duration;$('progress').style.transform=`scaleX(${progress})`;
 $('status').textContent=state==='done'&&elapsed>spec.duration?'完成 · 保持笑眼':`${spec.name} · ${spec.duration.toFixed(1)} 秒${spec.once?'单次':'循环'} · 柔和衔接`;
}requestAnimationFrame(frame);
