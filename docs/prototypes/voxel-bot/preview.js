import * as THREE from './vendor/three.module.js';
import {models,voxelStyles,professions} from './models.js';
const $=id=>document.getElementById(id);
const stage=$('stage');
let renderer;
try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch(error){stage.innerHTML='<p class="error">无法启动 WebGL，请使用支持硬件加速的浏览器打开此页面。</p>';throw error;}
renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;stage.prepend(renderer.domElement);
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=.9;
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(32,1,.1,100);
scene.background=new THREE.Color('#a6b0c0');
// A contrasting studio backdrop gives transmitted light something to reveal.
const backdrop=new THREE.Group();scene.add(backdrop);
for(let i=0;i<9;i++){const strip=new THREE.Mesh(new THREE.PlaneGeometry(1.1,14),new THREE.MeshBasicMaterial({color:i%2?'#aab6ca':'#d9dfeb'}));strip.position.set((i-4)*1.1,0,-4);backdrop.add(strip);}
scene.add(new THREE.HemisphereLight(0xe4edff,0x807368,1.1));
// Local studio environment: broad windows and warm/cool strips give physical
// materials actual reflected shapes, without an external HDR dependency.
const studio=new THREE.Scene();studio.background=new THREE.Color('#30394b');
const room=new THREE.Mesh(new THREE.BoxGeometry(30,24,30),new THREE.MeshBasicMaterial({color:'#525968',side:THREE.BackSide}));studio.add(room);
for(const [position,size,tint,intensity] of [
 [[-7,5,6],[4,9],0xe4efff,5],[[6,3,3],[2,8],0xffe1b1,4],[[0,9,-1],[7,4],0xffffff,5],[[1,2,-8],[6,2],0x91bbff,3]
]){const panel=new THREE.Mesh(new THREE.PlaneGeometry(...size),new THREE.MeshBasicMaterial({color:new THREE.Color(tint).multiplyScalar(intensity),side:THREE.DoubleSide}));panel.position.set(...position);panel.lookAt(0,0,0);studio.add(panel);}
const pmrem=new THREE.PMREMGenerator(renderer),environment=pmrem.fromScene(studio,.04);scene.environment=environment.texture;pmrem.dispose();studio.traverse(o=>{if(o.isMesh){o.geometry.dispose();o.material.dispose();}});
const sun=new THREE.DirectionalLight(0xffffff,1.8);sun.position.set(-5,9,7);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-7,right:7,top:8,bottom:-5});sun.shadow.normalBias=.03;scene.add(sun);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.ShadowMaterial({opacity:.13}));ground.rotation.x=-Math.PI/2;ground.position.y=-2.3;ground.receiveShadow=true;scene.add(ground);
const root=new THREE.Group();scene.add(root);
const material=new THREE.MeshPhysicalMaterial();const white=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.25,emissive:0xffffff,emissiveIntensity:.25});const geometry=new THREE.BoxGeometry(1,1,1);
// Small bevels catch highlights that disappear on perfectly sharp tiny cubes.
const bevel=new THREE.BoxGeometry(1,1,1,6,6,6),positions=bevel.attributes.position;
for(let i=0;i<positions.count;i++){const v=new THREE.Vector3().fromBufferAttribute(positions,i),inner=v.clone().clampScalar(-.40,.40);v.sub(inner).normalize().multiplyScalar(.10).add(inner);positions.setXYZ(i,v.x,v.y,v.z);}bevel.computeVertexNormals();
const badgeBacking=new THREE.MeshBasicMaterial({color:'#243249'});
const badgeMaterial=new THREE.MeshStandardMaterial({color:'#f6d899',metalness:.65,roughness:.24});
const toolMaterials={D:badgeBacking,A:badgeMaterial,W:new THREE.MeshStandardMaterial({color:'#fff7e8',roughness:.3}),C:new THREE.MeshStandardMaterial({color:'#eb7950',roughness:.3}),B:new THREE.MeshStandardMaterial({color:'#51cddd',roughness:.25,metalness:.2})};
// Large voxel pictograms sit in front of the body, not on a tiny forehead badge.
const toolPatterns={
 puff:['DDDDDDDDDDD','DWDWDWDWDWD','DDDDDDDDDDD','DWDWDWDWDWD','DDWWWWWWWDD','DDDDDDDDDDD'],
 spark:['AAWWWWWWAA','AAWDDWWWAA','AAWWWDDWAA','AAWDWWDWAA','AAWWDDWWAA','AAWWWWWWAA'],
 drop:['..AAA..','...W...','...W...','..WWW..','.WBBBW.','WBBBBBW','WBBBBBW','.WWWWW.'],
 comet:['...CC..','..CCCC.','..CCCC.','..AAAA.','...AA..','...AA..','...AA..','...AA..','...AA..'],
 crown:['AA......','AACCCCC.','AACCCCC.','AACCCC..','AA......','AA......','AA......','AA......'],
 cloud:['AA...AA','AA...AA','.AAAAA.','..AAA..','..AAA..','..AAA..','..AAA..','..AAA..'],
 crescent:['..AAAA...','.AA..AA..','AA....AA.','AA....AA.','.AA..AA..','..AAAA...','......AA.','.......AA'],
 diamond:['.......B.','....C..B.','....C..B.','.A..C..B.','.A..C..B.','.A..C..B.','WWWWWWWWW'],
 sprout:['...A...','..AAA..','.AAWAA.','.AAWAA.','..AAA..','..DDD..','..DDD..','..DDD..','..DDD..'],
 bolt:['WWWWW....','WDDDW....','WWWWW....','.W.......','....BBBBB','....BDDDB','....BBBBB','.......B.'],
 music:['..AAAAAA','..AAAAAA','..AA..AA','..AA..AA','..AA..AA','AAAA..AA','AAAA.AAA','.....AAA'],
};
let professionTool;
function buildProfessionTool(){
 professionTool=new THREE.Group();root.add(professionTool);
 const rows=toolPatterns[shape],width=Math.max(...rows.map(r=>r.length)),unit=shape==='puff'?.25:.19;
 rows.forEach((row,y)=>[...row].forEach((key,x)=>{if(key==='.')return;const mesh=new THREE.Mesh(bevel,toolMaterials[key]);mesh.position.set((x-(width-1)/2)*unit,((rows.length-1)/2-y)*unit,0);mesh.scale.set(unit*.98,unit*.98,.19);mesh.castShadow=true;professionTool.add(mesh);}));
 const home=shape==='puff'?new THREE.Vector3(0,-1.48,1):new THREE.Vector3(1.45,-.73,.85);
 professionTool.position.copy(home);professionTool.userData.home=home;professionTool.rotation.z=shape==='comet'||shape==='sprout'?-.3:0;professionTool.userData.tilt=professionTool.rotation.z;
}
const finishes={
 ceramic:{name:'釉面陶瓷',roughness:.22,metalness:0,transmission:0,ior:1.46,thickness:0,clearcoat:1,clearcoatRoughness:.08,envMapIntensity:1.1},
 glass:{name:'有色玻璃',roughness:.015,metalness:0,transmission:1,ior:1.46,thickness:.18,clearcoat:1,clearcoatRoughness:.015,envMapIntensity:1.5},
 metal:{name:'抛光金属',roughness:.09,metalness:1,transmission:0,ior:1.5,thickness:0,clearcoat:1,clearcoatRoughness:.06,envMapIntensity:2.2},
 gem:{name:'折光宝石',roughness:.035,metalness:0,transmission:.65,ior:2.35,thickness:.85,clearcoat:1,clearcoatRoughness:.02,envMapIntensity:2},
 matte:{name:'哑光原色',roughness:.83,metalness:0,transmission:0,ior:1.5,thickness:0,clearcoat:0,clearcoatRoughness:0,envMapIntensity:.6},
};
const geometries={box:bevel,plate:bevel,sphere:new THREE.SphereGeometry(.5,24,16),gem:new THREE.OctahedronGeometry(.58)};
let cubes=[],eyes=[],shape='puff',voxelStyle='box',color=models.puff.color,finish='ceramic',state='idle',time=0,paused=false,cycling=false,lastCycle=0;
function applyFinish(){const {name,...properties}=finishes[finish];material.setValues(properties);material.color.set(color);if(finish==='glass')material.color.lerp(new THREE.Color('white'),.87);if(finish==='metal')material.color.lerp(new THREE.Color('#dce1ea'),.5);material.attenuationColor.set(color);material.attenuationDistance=finish==='gem'?.65:2;material.needsUpdate=true;$('finish').value=finish;$('finishNote').textContent={glass:'透光、浅染色：观察背后条纹穿过体素。',ceramic:'不透光的釉面：饱满底色和柔和白色高光。',metal:'不透光的镜面：反射冷暖灯带，转动看反光移动。',gem:'浓色、高折射：内部折光更强，推荐搭配八面晶粒。',matte:'粗糙散射：柔和底色，几乎没有锐利高光。'}[finish];document.querySelectorAll('[data-finish]').forEach(b=>b.classList.toggle('active',b.dataset.finish===finish));updateIdentity();}
function updateIdentity(){const m=models[shape];$('identity').textContent=`${m.name} · ${m.role} / ${voxelStyles[voxelStyle]} / ${finishes[finish].name}`;$('lore').textContent=m.desc;}
const states={idle:['待机','在这里，陪你。','轻轻起伏、眨眼，外围方块偶尔探头。'],think:['思考','让我拼一拼。','核心留在原地，顶部三块绕出思路。'],work:['工作','正在认真搭建。','侧边方块有节奏地推进，像一个小型工作站。'],done:['完成','拼好了！','蓄力、跃起、展开，再重新聚成一团。'],wait:['等你','轮到你啦。','轻轻侧身，伸出一块小方块打招呼。'],oops:['困惑','这里有点不对。','左右不对称地下沉，轻轻摇头。']};
function cube(parent,x,y,z,sx,sy,sz,mat=material){const m=new THREE.Mesh(geometry,mat);m.position.set(x,y,z);m.scale.set(sx,sy,sz);m.castShadow=true;parent.add(m);return m;}
function build(){
 root.clear();cubes=[];eyes=[];
 const model=models[shape],step=.43,zStep=voxelStyle==='plate'?.15:step;
 const [sx,sy]=model.scale,[faceCol,faceRow]=model.face||[4,4];
 const groups=new Map();
 // The central 3x3 face stays intact. Eight surrounding sectors articulate
 // as coherent chunks instead of dissolving into an unreadable particle cloud.
 model.rows.forEach((row,r)=>[...row].forEach((cell,c)=>{
  if(cell!=='#')return;
  const x=(c-4)*step*sx,y=(4-r)*step*sy;
  const core=Math.abs(c-faceCol)<=1&&Math.abs(r-faceRow)<=1;
  const sector=Math.round(Math.atan2(y,x)/(Math.PI/4));
  const key=core?'core':String(sector);
  if(!groups.has(key))groups.set(key,[]);
  const layers=(r===0||r===8||c===0||c===8)?1:model.depth;
  for(let d=0;d<layers;d++)groups.get(key).push([x,y,-d*zStep]);
 }));
 for(const [key,points] of groups){
  const group=new THREE.Group();root.add(group);
  const center=points.reduce((v,p)=>v.add(new THREE.Vector3(...p)),new THREE.Vector3()).divideScalar(points.length);
  group.position.copy(center);
  for(const p of points){const mesh=new THREE.Mesh(geometries[voxelStyle],material);mesh.position.set(p[0]-center.x,p[1]-center.y,p[2]-center.z);mesh.scale.set(step*.96*sx,step*.96*sy,voxelStyle==='plate'?.12:step*.96);mesh.castShadow=true;group.add(mesh);}
  if(key!=='core'){const sector=Number(key);cubes.push({mesh:group,home:center,i:cubes.length,sector,thoughtSlot:sector>=1&&sector<=3?sector-1:null});}
 }
 [-step,step].forEach(x=>{const eye=cube(root,(faceCol-4)*step*sx+x*sx,(4-faceRow)*step*sy+.03,voxelStyle==='plate'?.095:step*.5+.025,.22,.3,.07,white);eye.userData.homeY=eye.position.y;eyes.push(eye);});
 buildProfessionTool();
 updateIdentity();
 document.querySelectorAll('[data-shape]').forEach(b=>b.classList.toggle('active',b.dataset.shape===shape));
}
build();
function setState(next){state=next;time=0;lastCycle=0;$('title').textContent=states[state][1];$('note').textContent=states[state][2];document.querySelectorAll('[data-state]').forEach(b=>b.classList.toggle('active',b.dataset.state===state));}
for(const [key,[label]] of Object.entries(states)){const b=document.createElement('button');b.textContent=label;b.dataset.state=key;b.onclick=()=>setState(key);$('states').append(b);}setState('idle');
for(const hex of ['#2875ef','#8b63df','#38ba9e','#f38564','#e9b733']){const b=document.createElement('button');b.style.background=hex;b.setAttribute('aria-label',`颜色 ${hex}`);b.onclick=()=>{color=hex;applyFinish();};$('colors').append(b);}
for(const [key,model] of Object.entries(models)){
 const b=document.createElement('button');b.dataset.shape=key;b.title=model.name;b.setAttribute('aria-label',model.name);
 const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 9 9');icon.setAttribute('aria-hidden','true');
 model.rows.forEach((row,y)=>[...row].forEach((cell,x)=>{if(cell!=='#')return;const rect=document.createElementNS(icon.namespaceURI,'rect');for(const [k,v] of Object.entries({x,y,width:.94,height:.94,fill:'currentColor'}))rect.setAttribute(k,v);icon.append(rect);}));
 b.append(icon,document.createTextNode(model.name));b.onclick=()=>{shape=key;if($('palette').checked){color=model.color;finish=model.finish;applyFinish();}build();};$('shapes').append(b);
}
for(const [key,label] of Object.entries(voxelStyles)){const option=document.createElement('option');option.value=key;option.textContent=label;$('voxelStyle').append(option);}
$('voxelStyle').onchange=e=>{voxelStyle=e.target.value;build();};
for(const [key,preset] of Object.entries(finishes)){const option=document.createElement('option');option.value=key;option.textContent=preset.name;$('finish').append(option);}
for(const [key,preset] of Object.entries(finishes)){const b=document.createElement('button');b.textContent=preset.name;b.dataset.finish=key;b.onclick=()=>{finish=key;applyFinish();};$('finishButtons').append(b);}
$('generate').onclick=()=>{
 const text=$('brief').value.trim().toLowerCase();if(!text){$('match').textContent='先描述这个 Bot 的职责，例如：负责游戏测试，金属方块风格。';return;}
 const ranked=Object.entries(professions).map(([key,m])=>({key,hits:m.keywords.filter(word=>text.includes(word))})).sort((a,b)=>b.hits.length-a.hits.length);
 const winner=ranked[0];if(!winner.hits.length){$('match').textContent='未识别到职业关键词，请补充开发、美术、策划、测试、运维等职责，或手动选择。';return;}
 if(ranked[1].hits.length===winner.hits.length){$('match').textContent='涉及多个职业：'+ranked.filter(r=>r.hits.length===winner.hits.length).map(r=>models[r.key].name).join('、')+'。请突出主要职责，或手动选择。';return;}
 shape=winner.key;color=models[shape].color;finish=models[shape].finish;
 for(const [word,key] of [['玻璃','glass'],['陶瓷','ceramic'],['金属','metal'],['宝石','gem'],['哑光','matte']])if(text.includes(word))finish=key;
 for(const [word,key] of [['方块','box'],['扁片','plate'],['圆球','sphere'],['晶粒','gem']])if(text.includes(word))voxelStyle=key;
 $('voxelStyle').value=voxelStyle;applyFinish();build();$('match').textContent='匹配：'+models[shape].name+'；依据：'+winner.hits.join('、')+'。可继续调整材质和体素。';
};
$('finish').onchange=e=>{finish=e.target.value;applyFinish();};
applyFinish();
build();
for(const name of ['speed','amount'])$(name).oninput=()=>$(name+'Out').textContent=Number($(name).value).toFixed(1)+'×';
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'继续':'暂停';};$('cycle').onclick=()=>{cycling=!cycling;lastCycle=time;$('cycle').textContent='自动轮播：'+(cycling?'开':'关');};
$('save').onclick=()=>{const data={format:'relay-voxel-prototype-v4',shape,voxelStyle,finish,material:finishes[finish],color,state,speed:+$('speed').value,amplitude:+$('amount').value,model:models[shape],cellSize:.43,animation:'sector-motion-v1'};const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`relay-${shape}-${voxelStyle}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
let yaw=.38,pitch=.18,distance=12.7,drag=null;
function view(){camera.position.set(Math.sin(yaw)*Math.cos(pitch)*distance,Math.sin(pitch)*distance+.2,Math.cos(yaw)*Math.cos(pitch)*distance);camera.lookAt(0,.1,0);}
renderer.domElement.onpointerdown=e=>{drag=[e.clientX,e.clientY];renderer.domElement.setPointerCapture(e.pointerId);};renderer.domElement.onpointermove=e=>{if(!drag)return;yaw-=(e.clientX-drag[0])*.008;pitch=THREE.MathUtils.clamp(pitch+(e.clientY-drag[1])*.006,-.35,1.1);drag=[e.clientX,e.clientY];view();};renderer.domElement.onpointerup=renderer.domElement.onpointercancel=()=>drag=null;renderer.domElement.addEventListener('wheel',e=>{e.preventDefault();distance=THREE.MathUtils.clamp(distance+e.deltaY*.01,8,20);view();},{passive:false});renderer.domElement.ondblclick=()=>{yaw=.38;pitch=.18;distance=12.7;view();};view();
new ResizeObserver(()=>{const w=stage.clientWidth,h=stage.clientHeight;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();}).observe(stage);
const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;if(reduced){paused=true;$('pause').textContent='播放';}
let previous=performance.now();
function frame(now){requestAnimationFrame(frame);const delta=Math.min((now-previous)/1000,.05);previous=now;if(!paused&&!document.hidden)time+=delta*+$('speed').value;const t=time,a=+$('amount').value;
 if(cycling&&t-lastCycle>5){const keys=Object.keys(states);setState(keys[(keys.indexOf(state)+1)%keys.length]);}
 root.position.set(0,Math.sin(t*2)*.055*a,0);root.rotation.set(0,0,Math.sin(t)*.018*a);root.scale.setScalar(1);
 if(professionTool){const tool=professionTool;tool.position.copy(tool.userData.home);tool.rotation.z=tool.userData.tilt;tool.scale.setScalar(1);
  if(state==='work'){tool.position.y+=Math.sin(t*(shape==='music'?7:5))*.09*a;tool.rotation.z+=Math.sin(t*5)*.12*a;}
  if(state==='think')tool.rotation.z+=Math.sin(t*1.8)*.09*a;
  if(state==='done'){tool.position.y+=Math.max(0,Math.sin(t*3))*.3*a;tool.scale.setScalar(1+Math.max(0,Math.sin(t*3))*.1*a);}
  if(state==='wait')tool.rotation.z+=Math.sin(t*3)*.08*a;
  if(state==='oops')tool.rotation.z-=.18*a;
 }
 for(const c of cubes){const {mesh,home,i}=c;mesh.position.copy(home);mesh.rotation.set(0,0,0);
 const personality=models[shape].motion;
 if(state==='idle'){if(['spark','diamond','sprout'].includes(shape))mesh.position.addScaledVector(home,Math.sin(t*2+i*Math.PI/2)*.07*a);else mesh.position.y+=Math.sin(t*(1.5+personality*.08)+i*.8)*.055*a;}
 if(state==='think'&&c.thoughtSlot!==null){const angle=t*2+c.thoughtSlot*Math.PI*2/3;mesh.position.set(Math.cos(angle)*1.5,2.1+Math.sin(t*3+i)*.14,Math.sin(angle)*.9);mesh.position.lerp(home,1-a/1.8);mesh.rotation.y=t*.7;}
 if(state==='work'){mesh.position.addScaledVector(new THREE.Vector3(home.x,home.y,0).normalize(),Math.max(0,Math.sin(t*(5+personality*.2)+i*1.7))*.25*a);mesh.position.z+=Math.sin(t*7+i)*.12*a;}
 if(state==='done'){const p=(t%3.8)/3.8,burst=Math.pow(Math.sin(Math.PI*THREE.MathUtils.clamp((p-.18)/.65,0,1)),2);mesh.position.addScaledVector(home,burst*.48*a);mesh.rotation.z=Math.sign(home.x)*burst*.32*a;}
 if(state==='wait'&&c.sector===0){mesh.position.x+=.35*a;mesh.position.y+=.25*a+Math.sin(t*6)*.15*a;mesh.rotation.z=Math.sin(t*6)*.22*a;}
 if(state==='oops')mesh.position.y+=Math.sin(i*2)*.25*a;
 }
 if(state==='done'){const p=(t%3.8)/3.8;root.position.y+=Math.max(0,Math.sin((p-.15)/.75*Math.PI))*.9*a;if(p<.15)root.scale.y=1-Math.sin(p/.15*Math.PI)*.14*a;root.rotation.y=Math.sin(p*Math.PI*2)*.18*a;}
 if(state==='wait')root.rotation.z=-.12*a;
 if(state==='oops'){root.rotation.z=.14*a;root.rotation.y=Math.sin(t*4)*.16*a;}
 const blink=(t%4.7)>4.5?.12:1;eyes.forEach((eye,i)=>{eye.scale.y=.3*blink;eye.position.y=eye.userData.homeY+(state==='oops'?(i?-.1:.1)*a:0);});renderer.render(scene,camera);
}requestAnimationFrame(frame);
