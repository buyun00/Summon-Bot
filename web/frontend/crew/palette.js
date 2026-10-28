export const legacyRoles={circle:'dev',cloud:'qa',square:'dev',star4:'plan',clover:'art',heart:'lead',flower:'music',drop:'research',pill:'translate',triangle:'write',pentagon:'knowledge',star6:'data',hexagon:'ops'};
export const templates=[
 ['apricot','开发橙','#FF6A0B','#FFAD59'],['rose','设计红','#FF5B59','#FF9C91'],
 ['lavender','质量紫','#6A48D8','#AA8AF4'],['sun','策划金','#E7A728','#FFD676'],
 ['mint','活力绿','#31A86C','#8DD0A9'],['sky','研究蓝','#1478FA','#69B5FF'],
 ['slate','运维灰蓝','#547697','#92B4D1'],['aqua','协调青绿','#009C9C','#4AD0C9'],
 ['peach','数据橙','#EC9B29','#FFC879'],['pink','创作粉','#E95883','#FFA2BB'],
 ['iris','翻译紫','#8058DD','#C29BFF'],['sage','知识绿','#479C76','#8DD0A9'],
 ['sunset','落日双色','#F47B3D','#A475D9'],['ocean','海岸双色','#1795AE','#F4C563'],
 ['ink','水墨纸笺','#5B7377','#AFBFBC'],['berry','音乐莓紫','#BB52C9','#DF96E3'],
].map(([id,name,color,secondary])=>({id,name,color,secondary,ink:'#142443',paper:'#FFFFFF'}));
export const hex=(value,fallback)=>/^#[\da-f]{6}$/i.test(value||'')?value.toUpperCase():fallback;
