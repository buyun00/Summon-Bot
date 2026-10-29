// Shared paper avatar identities. Animation geometry is supplied by Bloub (MIT).
export const paperShapes = [
  ['cercle','圆形'],['galet','卵石'],['squircle','圆角方形'],['capsule','胶囊'],
  ['triangle','三角形'],['hexagone','六边形'],['nuage','云朵'],['goutte','水滴'],
].map(([id,label])=>({id,label}));
export const paperTemplates = [
  ['olive','橄榄绿','#7D824B'],['sage','鼠尾草','#648468'],['clay','陶土红','#B2634F'],
  ['apricot','杏褐色','#BC8053'],['ochre','赭石黄','#A87932'],['mist','雾蓝','#597C91'],
  ['violet','灰紫','#867399'],['rose','豆沙粉','#AF7286'],['graphite','石墨蓝','#4D5C69'],
  ['kraft','牛皮棕','#927057'],['stone','暖石灰','#898B80'],['natural','原色纸','#DED1B2'],
].map(([id,name,color])=>({id,name,color,secondary:'#E6DDC8',ink:'#414A3C',paper:'#FFFBF0'}));
export const paperLegacyShapes = {
  dev:'squircle',art:'galet',music:'goutte',plan:'hexagone',qa:'nuage',write:'triangle',
  ops:'hexagone',research:'goutte',data:'capsule',lead:'cercle',translate:'capsule',knowledge:'galet',
  circle:'cercle',cloud:'nuage',square:'squircle',star4:'hexagone',clover:'galet',heart:'cercle',
  flower:'nuage',drop:'goutte',pill:'capsule',pentagon:'galet',star6:'capsule',hexagon:'hexagone',
};
export const paperLegacyColors = {
  '#FF6A0B':'#BC8053','#FF5B59':'#B2634F','#BB52C9':'#867399','#E7A728':'#A87932',
  '#6A48D8':'#867399','#487BE5':'#597C91','#547697':'#4D5C69','#1478FA':'#597C91',
  '#EC9B29':'#BC8053','#009C9C':'#648468','#8058DD':'#867399','#479C76':'#648468',
  '#31A86C':'#648468','#E95883':'#AF7286','#F47B3D':'#BC8053','#1795AE':'#597C91',
  '#5B7377':'#4D5C69','#FFC18E':'#BC8053','#FF9C9C':'#B2634F','#C5AFF1':'#867399',
  '#FFE39A':'#A87932','#AFDCB7':'#648468','#B6C9FF':'#597C91','#A6B9D6':'#4D5C69',
  '#81D4CF':'#648468','#FFC395':'#BC8053','#FFAAAA':'#B2634F','#B9BCFF':'#867399','#BFDCA9':'#7D824B',
};
const validHex=(value,fallback)=>typeof value==='string'&&/^#[\da-f]{6}$/i.test(value)?value.toUpperCase():fallback;
export function paperShape(shape){return paperShapes.some(item=>item.id===shape)?shape:paperLegacyShapes[shape]||'cercle';}
export function normalizePaperAvatar(value={}) {
  const legacy=Boolean(paperLegacyShapes[value.shape]);
  const raw=validHex(value.color,'#7D824B');
  const color=legacy?(paperLegacyColors[raw]||raw):raw;
  const oldInk=['#142443','#FFFFFF','#FFFAF1'];
  const secondary=legacy?'#E6DDC8':validHex(value.secondary,'#E6DDC8');
  const ink=validHex(value.ink,'#414A3C');
  const paper=validHex(value.paper,'#FFFBF0');
  const image=typeof value.image==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value.image)?value.image:null;
  return {shape:paperShape(value.shape),color,secondary,ink:legacy&&oldInk.includes(ink)?'#414A3C':ink,paper:legacy&&oldInk.includes(paper)?'#FFFBF0':paper,image};
}
export function defaultPaperAvatar(botId,index=0){
  const known={'bot-engineer':['squircle',5],'bot-components':['hexagone',0],'bot-qa':['nuage',6],lumi:['cercle',0],'bot-lumi':['cercle',0],'bot-entry':['cercle',0],'bot-chatroom':['capsule',1],'bot-manager':['hexagone',8],'bot-memory':['galet',1]};
  let value=5381;for(const c of String(botId||`bot-${index}`))value=(Math.imul(value,33)^c.codePointAt(0))>>>0;
  const [shape,palette]=known[botId]||[paperShapes[value%paperShapes.length].id,value%paperTemplates.length];
  return normalizePaperAvatar({shape,...paperTemplates[palette],image:null});
}
