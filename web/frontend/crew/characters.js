// Little Crew: layered, abstract occupational symbols. Palette edits and motion stay aligned.
const part=(d,patch,pivot=[64,64],tone='accent')=>({d,patch,pivot,tone});
export const characters={
 dev:{name:'开发',color:'#FF6A0B',secondary:'#FFAD59',parts:[
  part('M43 22 Q49 16 55 22 Q61 28 55 35 L29 63 L55 91 Q61 98 55 104 Q49 110 43 104 L10 71 Q3 63 10 55 Z','M3 55 L30 30 L42 42 L22 64 L42 87 L31 99 L9 72 Z',[32,64]),
  part('M85 22 Q79 16 73 22 Q67 28 73 35 L99 63 L73 91 Q67 98 73 104 Q79 110 85 104 L118 71 Q125 63 118 55 Z','M90 26 L120 56 Q128 63 117 75 L96 96 L86 85 L106 63 L86 42 Z',[96,64])],verbs:['括号轻开合','两侧错拍推敲','括号连续敲合','张开后弹回','向前探身招呼','一侧高、一侧低']},
 art:{name:'设计',color:'#FF5B59',secondary:'#FF9C91',parts:[
  part('M26 49 L68 10 Q78 1 88 10 Q97 19 88 29 L54 66 L43 99 Q40 111 29 111 Q18 111 18 99 L18 68 Q18 57 26 49 Z','M19 55 L49 28 L61 40 L30 73 L27 110 H15 Z',[42,69]),
  part('M60 78 L92 49 Q101 41 109 49 Q118 57 110 67 L81 101 Q73 110 63 103 Q51 94 60 78 Z','M78 90 L112 51 L120 68 L86 109 L72 104 Z',[82,77]),
  part('M109 96 Q120 96 120 107 Q120 118 109 118 Q98 118 98 107 Q98 96 109 96 Z','M109 96 H122 V120 H109 Z',[109,107])],verbs:['笔头轻点','笔尖左右找灵感','斜向刷动两笔','扬笔庆祝','笔尖前倾','停笔摇头']},
 music:{name:'音乐',color:'#BB52C9',secondary:'#DF96E3',parts:[
  part('M56 35 Q56 25 65 23 L107 12 Q117 9 117 20 L117 84 Q117 106 97 111 Q78 115 72 101 Q66 86 81 77 Q92 71 101 75 L101 40 L72 48 L72 94 Q72 115 51 119 Q31 122 26 107 Q21 92 37 85 Q46 81 56 85 Z','M57 22 L118 6 V37 L57 54 Z',[68,78])],verbs:['轻轻打拍子','侧耳听节拍','左右摇摆切分','高高弹起落拍','轻摆邀你接拍','节拍迟疑']},
 plan:{name:'策划',color:'#E7A728',secondary:'#FFD676',parts:[
  part('M25 38 L44 38 Q35 17 53 11 Q74 5 78 23 Q80 30 76 38 L101 38 Q113 38 113 50 L113 62 Q130 54 130 71 Q130 88 113 82 L113 103 Q113 115 101 115 L80 115 Q88 97 71 97 Q55 97 61 115 L30 115 Q18 115 18 103 L18 82 Q37 89 37 72 Q37 55 18 62 L18 50 Q18 38 25 38 Z','M66 8 H138 V121 H88 Q93 77 65 72 Z',[67,68])],verbs:['轻晃拼块','来回试方向','左右对位拼接','旋正落位','探头等待下一块','歪着试一次']},
 qa:{name:'测试',color:'#6A48D8',secondary:'#AA8AF4',parts:[
  part('M48 14 Q61 1 74 14 L109 49 Q122 62 109 75 L74 110 Q61 123 48 110 L13 75 Q0 62 13 49 Z','M62 3 L119 60 L81 99 L62 78 L79 61 L45 28 Z',[61,62]),
  part('M108 95 Q122 95 122 109 Q122 123 108 123 Q94 123 94 109 Q94 95 108 95 Z','M108 95 H124 V125 H108 Z',[108,109])],details:'<circle class="focus-ring" cx="61" cy="62" r="20" fill="var(--paper)"/><circle class="focus-dot" cx="61" cy="62" r="8" fill="var(--accent)"/>',verbs:['镜头轻晃','镜头侧移聚焦','左右放大巡查','发现后抬镜','举镜等你','左右复查']},
 write:{name:'文案',color:'#487BE5',secondary:'#93B6FF',parts:[
  part('M56 15 Q63 4 71 15 L110 68 L86 102 L42 102 L18 68 Z','M17 65 L42 56 L63 88 L87 56 L112 67 L87 104 H42 Z',[64,65]),
  part('M40 109 Q64 114 88 109 L88 119 Q65 126 40 119 Z','M66 107 H92 V125 H66 Z',[64,116])],details:'<path d="M64 22 L64 56" fill="none" stroke="var(--paper)" stroke-width="7" stroke-linecap="round"/><circle cx="64" cy="64" r="6" fill="var(--paper)"/>',verbs:['笔尖轻呼吸','倾笔斟酌','连写三小笔','收笔扬起','笔尖悬停','划掉再想']},
 ops:{name:'运维',color:'#547697',secondary:'#92B4D1',parts:[
  part('M48 70 Q16 63 25 36 Q30 20 46 14 Q58 9 54 21 L49 38 L65 48 L80 40 L83 23 Q86 11 95 21 Q117 48 98 70 Q88 82 75 80 L49 114 Q42 124 32 116 L23 109 Q16 102 23 93 Z','M20 24 L48 8 L45 50 L61 65 L77 79 L48 120 L17 108 L46 72 Z',[65,65])],details:'<circle cx="37" cy="103" r="5" fill="var(--paper)"/>',verbs:['工具轻晃','调整角度','拧紧—松开—拧紧','旋正举起','工具朝前递出','卡住轻抖']},
 research:{name:'研究',color:'#1478FA',secondary:'#69B5FF',parts:[
  part('M43 10 Q43 5 49 5 L80 5 Q86 5 86 10 Q86 15 80 15 L78 15 L78 49 L111 101 Q122 120 99 120 L30 120 Q7 120 18 101 L51 49 L51 15 L49 15 Q43 15 43 10 Z','M14 99 Q32 81 52 94 Q71 105 87 90 L115 110 V125 H9 Z',[64,71])],details:'<path d="M59 18 L59 51 L42 78 L86 78 L69 51 L69 18 Z" fill="var(--paper)"/><circle cx="54" cy="102" r="5" fill="var(--paper)"/><circle cx="77" cy="93" r="3.5" fill="var(--paper)"/>',verbs:['液面轻摇','偏头观察反应','左右摇匀','小跳冒出灵感','瓶身向前','反应不对轻晃']},
 data:{name:'数据',color:'#EC9B29',secondary:'#FFC879',parts:[
  part('M14 107 L14 77 Q14 67 25 67 Q36 67 36 77 L36 107 Z','M14 80 H37 V109 H14 Z',[25,107]),
  part('M47 107 L47 27 Q47 16 59 16 Q71 16 71 27 L71 107 Z','M59 14 H73 V109 H59 Z',[59,107]),
  part('M82 107 L82 56 Q82 45 94 45 Q106 45 106 56 L106 107 Z','M82 72 H108 V109 H82 Z',[94,107])],details:'<path d="M13 117 L113 117" stroke="var(--accent)" stroke-width="8" stroke-linecap="round"/>',verbs:['柱形错拍呼吸','逐列比较','柱形依次升降','三列一起弹起','中柱探身','左右数据不齐']},
 lead:{name:'协调',color:'#009C9C',secondary:'#4AD0C9',parts:[
  part('M32 24 L92 9 Q104 6 108 18 L117 46 Q121 58 109 62 L56 77 L48 55 L91 44 L88 34 L37 47 Z','M32 24 L92 9 L104 17 L40 37 Z',[35,41]),
  part('M23 22 Q35 19 38 31 L56 103 Q59 115 47 118 Q35 121 32 109 L14 37 Q11 25 23 22 Z','M15 29 L27 22 L52 113 L39 119 Z',[36,104]),
  part('M100 87 Q113 87 113 100 Q113 113 100 113 Q87 113 87 100 Q87 87 100 87 Z','M100 87 H115 V115 H100 Z',[100,100])],details:'<path d="M36 67 L55 62 L60 79 L41 84 Z" fill="var(--paper)"/>',verbs:['旗面轻摆','偏旗查看队伍','有节奏地挥旗','举旗欢呼','挥一次招呼','旗面垂下又抬起']},
 translate:{name:'翻译',color:'#8058DD',secondary:'#C29BFF',parts:[
  part('M70 43 Q91 26 111 43 Q129 59 114 79 L119 99 L98 91 Q78 99 62 81 Z','M79 36 H124 V103 H77 Z',[96,63],'secondary'),
  part('M91 51 Q91 23 60 18 Q29 13 15 37 Q2 61 23 79 L17 100 L41 90 Q69 96 86 74 Z','M6 58 L88 36 L100 68 L32 101 H4 Z',[51,58])],details:'<path d="M32 47 L67 47 M49 38 L49 47 M37 48 Q43 64 64 74 M62 48 Q56 65 35 75" fill="none" stroke="var(--paper)" stroke-width="6" stroke-linecap="round"/>',verbs:['两气泡轻错位','侧向倾听','前后交替接话','同步弹起回应','向对方靠近','两边反向歪头']},
 knowledge:{name:'知识',color:'#479C76',secondary:'#8DD0A9',parts:[
  part('M64 29 Q42 13 17 19 Q9 21 9 30 L9 105 Q36 98 64 115 Z','M9 17 H27 V84 L64 101 V117 H6 Z',[64,72]),
  part('M64 29 Q88 13 111 19 Q119 21 119 30 L119 105 Q91 98 64 115 Z','M97 17 H122 V109 L64 117 V101 L99 83 Z',[64,72])],details:'<path d="M64 32 L64 107" stroke="var(--paper)" stroke-width="6" stroke-linecap="round"/>',verbs:['书页轻呼吸','缓缓翻页思索','两页交替展开','展开呈现答案','书页微微合拢','左右翻找']},
};
export const states={
 idle:{name:'待机',duration:4.8,description:'慢起伏，保留安静停顿。'},
 think:{name:'思考',duration:3.6,description:'侧转和歪斜推敲，节奏有停顿。'},
 work:{name:'工作',duration:2.4,description:'持续而清楚的职业动作，节奏较快。'},
 done:{name:'完成',duration:2.2,description:'蓄力、弹起、落地；播完停在完成姿态。',once:true},
 wait:{name:'等你',duration:4.4,description:'探身、轻招呼，再留一段等待时间。'},
 confused:{name:'困惑',duration:3.2,description:'不对称转动、两次摇摆、偏转停顿。'},
};
