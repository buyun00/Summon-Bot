export const legacyRoles={circle:'dev',cloud:'qa',square:'dev',star4:'plan',clover:'art',heart:'lead',flower:'music',drop:'research',pill:'translate',triangle:'write',pentagon:'knowledge',star6:'data',hexagon:'ops'};
export const templates=[
 ['apricot','杏桃手记','#FFC18E','#FFE1BA'],['rose','珊瑚花笺','#FF9C9C','#FFD4B6'],
 ['lavender','薰衣草','#C5AFF1','#E7D6FF'],['sun','奶油阳光','#FFE39A','#FFF0BD'],
 ['mint','薄荷花园','#AFDCB7','#D4F0D0'],['sky','晴空蓝','#B6C9FF','#DCE4FF'],
 ['slate','雾蓝石','#A6B9D6','#D5E1EF'],['aqua','海盐青','#81D4CF','#B9EEEA'],
 ['peach','蜜桃汽水','#FFC395','#FFE1B8'],['pink','莓果奶昔','#FFAAAA','#FFD1D0'],
 ['iris','鸢尾双色','#B9BCFF','#FFE39B'],['sage','鼠尾草','#BFDCA9','#E1EFCF'],
 ['sunset','落日双色','#F7AE87','#CEB8EE'],['ocean','海岸双色','#8BCAD7','#F5D49C'],
 ['ink','水墨纸笺','#B8C4C5','#E1E6DE'],['berry','莓紫夜话','#D7A3CC','#C4C0EC'],
].map(([id,name,color,secondary])=>({id,name,color,secondary,ink:'#142443',paper:'#FFFAF1'}));
export const hex=(value,fallback)=>/^#[\da-f]{6}$/i.test(value||'')?value.toUpperCase():fallback;
