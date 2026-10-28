import {characters,states} from './characters.js';
const ns='http://www.w3.org/2000/svg';
let sequence=0;
const clamp=(v,a=0,b=1)=>Math.max(a,Math.min(b,v));
const pulse=(p,center,width)=>Math.exp(-(((p-center)/width)**2));
const rest=()=>({x:0,y:0,r:0,sx:1,sy:1,gx:0,gy:0,open:1,smile:0,ask:0,a:0,b:0,c:0,spread:0,marks:0});
export function pose(role,state,t){
 const spec=states[state],p=spec.once?Math.min(t/spec.duration,1):(t%spec.duration)/spec.duration;
 const w=p*Math.PI*2,q=rest();
 if(state==='idle'){q.y=-1.5*Math.sin(w);q.r=1.4*Math.sin(w);q.open=1-.94*pulse(p,.73,.018);q.a=1.8*Math.sin(w);q.b=-q.a;q.gx=Math.sin(w)*.6;}
 if(state==='think'){q.r=7*Math.sin(w);q.gx=4*Math.tanh(Math.sin(w)*3);q.gy=-2;q.ask=.4+.3*Math.sin(w);q.a=7*Math.sin(w);q.b=-q.a;q.spread=2*Math.sin(w);q.y=-1.5*Math.sin(w*2);q.open=1-.9*pulse(p,.52,.022);}
 if(state==='work'){q.y=-3*Math.abs(Math.sin(w*2));q.r=3*Math.sin(w*2);q.a=10*Math.sin(w*2);q.b=-q.a;q.c=8*Math.sin(w*2+1.8);q.spread=2.4*Math.sin(w*2);q.sy=1+.025*Math.sin(w*4);q.sx=1-.015*Math.sin(w*4);q.gy=1;q.open=1-.9*pulse(p,.87,.022);}
 if(state==='done'){const charge=pulse(p,.12,.075),jump=pulse(p,.38,.16),land=pulse(p,.66,.08);q.y=4*charge-17*jump+2*land;q.sy=1-.13*charge+.1*jump-.07*land;q.sx=1+.1*charge-.06*jump+.06*land;q.r=7*Math.sin(w)*jump;q.smile=clamp(p*5);q.a=-10*jump;q.b=10*jump;q.c=-7*jump;q.spread=7*jump;q.marks=jump;}
 if(state==='wait'){const reach=pulse(p,.28,.18);q.y=-4*reach;q.sx=1+.065*reach;q.sy=1+.065*reach;q.r=5*reach*Math.sin(w*2);q.gx=2*reach;q.gy=-1;q.a=5*reach;q.b=-5*reach;q.spread=3*reach;q.open=1-.95*pulse(p,.7,.022);q.marks=reach*.4;}
 if(state==='confused'){const shake=Math.sin(w*3)*Math.sin(Math.PI*p)**2;q.r=8+5*shake;q.x=2*shake;q.ask=.9;q.gx=-3;q.a=-7+4*shake;q.b=7-4*shake;q.spread=-2;q.open=1-.85*pulse(p,.65,.025);}
 // Occupational motion accents share the state vocabulary but articulate
 // different silhouettes. All return numeric channels for continuous blending.
 if(role==='dev'){q.a*=.25;q.b*=.25;q.spread*=1.6;}
 if(role==='art'&&state==='work'){q.x=7*Math.sin(w*2);q.y+=4*Math.sin(w*4);q.r=-12+9*Math.sin(w*2);q.b*=.45;}
 if(role==='music'){q.r*=1.7;if(state==='work'){q.y=-9*Math.abs(Math.sin(w*2));q.sx=1+.05*Math.sin(w*2);q.sy=1-.04*Math.sin(w*2);}q.a=0;}
 if(role==='plan'){q.a=0;if(state==='work'){q.x=8*Math.sin(w);q.r=9*Math.sin(w);q.y=-3*Math.cos(w*2);}}
 if(role==='qa'){q.a*=.3;q.b*=.3;if(state==='work'){q.x=10*Math.sin(w);q.y=4*Math.sin(w*2);q.gx=4*Math.sin(w);}}
 if(role==='write'&&state==='work'){q.x=9*(p-.5);q.y=3*Math.sin(w*4);q.r=-7+4*Math.sin(w*2);q.a=0;q.b=0;}
 if(role==='ops'){q.a=0;if(state==='work'){q.r=20*Math.sin(w*2);q.y=0;}}
 if(role==='research'){q.a=0;if(state==='work'){q.r=13*Math.sin(w*2);q.y=-2*Math.abs(Math.sin(w*2));}}
 if(role==='data'){q.a*=.25;q.b*=.15;q.c*=.25;q.spread=0;}
 if(role==='lead'){q.b*=.15;q.spread=0;if(state==='work'){q.a=15*Math.sin(w*2);q.r=5*Math.sin(w*2);}}
 if(role==='translate'){q.a*=.55;q.b*=.55;if(state==='work'){q.spread=5*Math.sin(w*2);q.r=3*Math.sin(w*2);}}
 if(role==='knowledge'){q.a*=.6;q.b*=.6;q.spread=0;if(state==='work'){q.a=9*Math.sin(w);q.b=-9*Math.sin(w);}}
 return q;
}
export class CrewAvatar{
 constructor(host,role,{state='idle',size=128,palette={}}={}){
  this.role=role;this.state=state;this.time=0;this.value=rest();this.velocity=rest();Object.keys(this.velocity).forEach(k=>this.velocity[k]=0);
  this.palette={ink:'#142443',paper:'#FFFFFF',accent:characters[role].color,secondary:characters[role].secondary,...palette};
  const id=`crew-${++sequence}`,m=characters[role];this.svg=document.createElementNS(ns,'svg');this.svg.setAttribute('viewBox','-8 -8 144 144');this.svg.setAttribute('width',size);this.svg.setAttribute('height',size);this.svg.setAttribute('role','img');this.svg.setAttribute('aria-label',`${m.name} · ${states[state].name}`);this.svg.dataset.crewRole=role;
  this.svg.innerHTML=`<defs>${m.parts.map((p,i)=>`<clipPath id="${id}-${i}"><path d="${p.d}"/></clipPath>`).join('')}</defs><g class="body">${m.parts.map((p,i)=>`<g class="part"><path d="${p.d}" fill="var(--${p.tone})" stroke="var(--ink)" stroke-width="1" stroke-opacity=".08"/><path d="${p.patch}" fill="var(--${p.tone==='secondary'?'accent':'secondary'})" opacity=".32" clip-path="url(#${id}-${i})"/></g>`).join('')}<g class="symbol-details">${m.details||''}</g><g class="marks" fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round"><path d="M103 9 l3 -8 M114 16 l8 -5 M17 12 l-6 -6"/></g></g>`;
  host.append(this.svg);this.body=this.svg.querySelector('.body');this.parts=[...this.svg.querySelectorAll('.part')];this.focus=this.svg.querySelector('.focus-dot');this.marks=this.svg.querySelector('.marks');this.setPalette(this.palette);this.render();
 }
 setState(state){if(!states[state])return;this.state=state;this.time=0;this.svg.setAttribute('aria-label',`${characters[this.role].name} · ${states[state].name}`);/* Keep value AND velocity: interrupted transitions remain continuous. */}
 setPalette(palette){Object.assign(this.palette,palette);for(const [k,v] of Object.entries(this.palette))this.svg.style.setProperty(`--${k}`,v);}
 tick(dt){this.time+=dt;const target=pose(this.role,this.state,this.time);let remaining=dt;while(remaining>0){const h=Math.min(remaining,1/120);for(const k of Object.keys(target)){// Critically damped spring, ~0.35–0.5s settling without a reset frame.
   const stiffness=k==='open'?1800:260,damping=2*Math.sqrt(stiffness);this.velocity[k]+=(stiffness*(target[k]-this.value[k])-damping*this.velocity[k])*h;this.value[k]+=this.velocity[k]*h;
  }remaining-=h;}this.render();}
 render(){const q=this.value,m=characters[this.role];this.body.setAttribute('transform',`translate(${q.x} ${q.y}) translate(64 75) rotate(${q.r}) scale(${q.sx} ${q.sy}) translate(-64 -75)`);
  this.parts.forEach((g,i)=>{const [px,py]=m.parts[i].pivot,angle=[q.a,q.b,q.c][i]||0,sign=i===0?-1:1;let dy=0;if(this.role==='data')dy=angle*1.4;g.setAttribute('transform',`translate(${sign*q.spread} ${dy}) rotate(${angle} ${px} ${py})`);});
  if(this.focus)this.focus.setAttribute('transform',`translate(${q.gx*.5} ${q.gy*.5})`);this.marks.style.opacity=clamp(q.marks);
 }
 snapshot(){const clone=this.svg.cloneNode(true);clone.setAttribute('xmlns',ns);return new XMLSerializer().serializeToString(clone);}
 destroy(){this.svg.remove();}
}
