(() => {

'use strict';
const Rules=JJKRules;
/** 连续速度评分：档位 + 档内百分比。 */
function speedScores(maxHp,effValue){
  const ht=hpTierIndexOf(maxHp),hb=HP_TIERS[ht][1];
  const hpPos=clamp((maxHp-hb[0])/Math.max(1,hb[1]-hb[0]),0,1);
  const et=tierIndexOf(effValue,DMG_TIERS),eb=DMG_TIERS[et];
  const effPos=clamp((effValue-eb[0])/Math.max(1,eb[1]-eb[0]),0,1);
  return {hpScore:ht+hpPos,effScore:et+effPos};
}
function baseSpeedValue(maxHp,effValue){
  const s=speedScores(maxHp,effValue);
  return Rules.baseSpeed(s.hpScore,s.effScore);
}
function campaignSpeed(P){
  const flags=[P.technique.flag,...(P.technique.flags||[]),...(P.stolenTechs||[]).flatMap(t=>[t.flag,...(t.flags||[])]),P.extraTech&&P.extraTech.flag];
  let speed=baseSpeedValue(P.maxHp,P.eff[1])*Rules.techniqueMultiplier(flags);
  if(flags.includes('projection'))speed=Math.max(speed,Rules.tuning.projectionFloor);
  return speed;
}
/* =====================================================================================
 * 咒术回战 · 轮回转盘   —— 全部逻辑单文件实现
 * 模块：I 工具/随机 | II 数值档位与全部转盘数据 | III 角色与成长 | IV 通用转盘组件
 *       V 战斗引擎(ATB轮轴) | VI 剧情引擎 | VII 主循环/界面渲染 | VIII 启动
 * ===================================================================================== */

/* ============================ I. 工具与随机 ============================ */
const G = (typeof window!=='undefined'?window:globalThis);
const $=id=>document.getElementById(id);
function hideAllScreens(){['titleScreen','createScreen','mainScreen','vsLobbyScreen','vsRoomScreen','vsCreateScreen'].forEach(id=>{const el=$(id);if(el)el.classList.add('hidden');});}
const rand=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const randF=(a,b)=>Math.random()*(b-a)+a;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const sum=a=>a.reduce((x,y)=>x+y,0);
const deepCopy=o=>JSON.parse(JSON.stringify(o));
// Remote character names/notes are rendered in templates. Treat network text as text.
function sanitizePeerMessage(value, depth=0, budget={nodes:0}) {
  if (++budget.nodes>50000 || depth>24) throw new Error('Peer message too large');
  if (typeof value==='string') {
    if(value.length>200000) throw new Error('Peer text too large');
    return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  if (value===null || typeof value==='boolean') return value;
  if (typeof value==='number') {if(!Number.isFinite(value))throw new Error('Invalid peer number');return value;}
  if (Array.isArray(value)) return value.map(item=>sanitizePeerMessage(item,depth+1,budget));
  if (typeof value!=='object') throw new Error('Invalid peer data');
  const clean={};
  for(const [key,item]of Object.entries(value)){
    if(['__proto__','constructor','prototype'].includes(key))throw new Error('Invalid peer key');
    clean[key]=sanitizePeerMessage(item,depth+1,budget);
  }
  return clean;
}


/* ============================ 音效 & 语音（Web Audio 程序化合成，零外部文件；无音频环境自动静默降级） ============================ */
const SFX={
  muted:false,voiceOn:true,ctx:null,
  _ensure(){
    try{
      if(this.muted)return null;
      const AC=G.AudioContext||G.webkitAudioContext;if(!AC)return null;
      if(!this.ctx)this.ctx=new AC();
      if(this.ctx.state==='suspended')this.ctx.resume();
      return this.ctx;
    }catch(e){return null;}
  },
  unlock(){this._ensure();try{if(G.speechSynthesis&&G.speechSynthesis.getVoices().length===0)G.speechSynthesis.getVoices();}catch(e){}},
  tone(f0,f1,dur,type='sine',vol=.18,delay=0){
    const ctx=this._ensure();if(!ctx)return;
    try{
      const t0=ctx.currentTime+delay,o=ctx.createOscillator(),g=ctx.createGain();
      o.type=type;o.frequency.setValueAtTime(f0,t0);
      if(f1&&f1!==f0)o.frequency.exponentialRampToValueAtTime(Math.max(1,f1),t0+dur);
      g.gain.setValueAtTime(.0001,t0);g.gain.exponentialRampToValueAtTime(vol,t0+.012);
      g.gain.exponentialRampToValueAtTime(.0001,t0+dur);
      o.connect(g);g.connect(ctx.destination);o.start(t0);o.stop(t0+dur+.03);
    }catch(e){}
  },
  noise(dur,vol=.12,delay=0,lp=1200){
    const ctx=this._ensure();if(!ctx)return;
    try{
      const len=Math.max(1,Math.floor(ctx.sampleRate*dur)),buf=ctx.createBuffer(1,len,ctx.sampleRate),d=buf.getChannelData(0);
      for(let i=0;i<len;i++)d[i]=(Math.random()*2-1)*(1-i/len);
      const src=ctx.createBufferSource();src.buffer=buf;const f=ctx.createBiquadFilter();f.type='lowpass';f.frequency.value=lp;
      const g=ctx.createGain();g.gain.value=vol;src.connect(f);f.connect(g);g.connect(ctx.destination);src.start(ctx.currentTime+delay);
    }catch(e){}
  },
  click(){this.tone(620,520,.06,'triangle',.07);},
  tick(){this.tone(1500,1150,.025,'square',.045);},
  spinStart(){this.tone(280,880,.45,'sawtooth',.05);},
  spinEnd(){this.tone(880,1320,.16,'triangle',.11);this.tone(1320,1760,.2,'sine',.09,.08);},
  hit(){this.noise(.12,.09,0,900);this.tone(180,90,.12,'sawtooth',.07);},
  crit(){this.noise(.28,.18,0,1800);this.tone(120,45,.4,'sawtooth',.16);this.tone(900,200,.28,'square',.09,.02);},
  heal(){this.tone(520,780,.16,'sine',.09);this.tone(780,1040,.2,'sine',.07,.09);},
  die(){this.tone(300,70,.5,'sawtooth',.11);this.noise(.3,.07,0,500);},
  domain(){this.tone(70,150,1.1,'sawtooth',.2);this.tone(140,60,1.1,'square',.09);this.noise(1,.11,0,420);this.tone(440,880,.5,'sine',.11,.12);},
  skill(){this.tone(660,990,.18,'triangle',.10);this.tone(990,1480,.22,'sine',.08,.05);this.noise(.18,.06,1200,3600);},
  ult(){this.tone(55,120,1.2,'sawtooth',.22);this.noise(1.1,.14,0,500);this.tone(300,1200,.7,'square',.12,.18);this.tone(1200,1800,.5,'sine',.10,.35);},
  speak(text){
    try{
      if(this.muted||this.voiceOn===false||!G.speechSynthesis||!G.SpeechSynthesisUtterance)return;
      const u=new SpeechSynthesisUtterance(text);u.lang='zh-CN';u.rate=1.02;u.pitch=.8;u.volume=1;
      const vs=G.speechSynthesis.getVoices();const zh=vs.find(v=>/zh|chinese/i.test(v.lang));if(zh)u.voice=zh;
      G.speechSynthesis.cancel();G.speechSynthesis.speak(u);
    }catch(e){}
  },
  setMuted(m){this.muted=m;try{localStorage.setItem('jjk_muted',m?'1':'0');}catch(e){}
    if(m&&G.speechSynthesis){try{G.speechSynthesis.cancel();}catch(e){}}},
  setVoice(v){this.voiceOn=v;try{localStorage.setItem('jjk_voice',v?'1':'0');}catch(e){}
    if(!v&&G.speechSynthesis){try{G.speechSynthesis.cancel();}catch(e){}}}
};
try{SFX.muted=localStorage.getItem('jjk_muted')==='1';}catch(e){}
 try{SFX.voiceOn=localStorage.getItem('jjk_voice')!=='0';}catch(e){}
if(typeof document!=='undefined'&&document.addEventListener)
  ['pointerdown','keydown'].forEach(ev=>document.addEventListener(ev,()=>SFX.unlock(),{passive:true}));

/** 加权随机：items=[{...weight}]，返回选中下标 */
function weightedIndex(items){
  let total=0; const ws=items.map(it=>{const w=Math.max(0,(it.weight??1));total+=w;return w;});
  let r=Math.random()*total;
  for(let i=0;i<ws.length;i++){r-=ws[i];if(r<0)return i;}
  return items.length-1;
}
function weightedPick(items){return items[weightedIndex(items)];}
/* 等级名：tier 0~15 为正式十六级；-1=准四级、-2=不入流（仅狩猎低级咒灵出现）。12~15为未来篇神级，仅NPC/剧情可达 */
const lvName=li=>li<=-2?'不入流':li===-1?'准四级':LEVELS[clamp(li,0,LEVELS.length-1)];

/* ============================ II. 数值档位 & 转盘数据 ============================ */
/** 十六级等级序列（贯穿全游戏的强度标尺；12龙级/13龙级巅峰/14准神级/15标准神级为未来篇神域） */
const LEVELS=['四级','三级','准二级','二级','准一级','一级','特别一级','准特级','弱特级','标准特级','强特级','超特级','龙级','龙级巅峰','准神级','标准神级'];

/** 咒力总量档位 [min,max] + 权重（前12级进玩家转盘，12~15神级仅NPC） */
const CP_TIERS=[
 [0,10],[11,50],[51,99],[100,500],[501,999],[1000,5000],[5001,8999],
 [9000,9999],[10000,19999],[20000,49999],[50000,99999],[100000,999999],
 [1000000,9999999],[10000000,99999999],[100000000,999999999],[1000000000,9999999999]];
const TIER_W=[5,5,10,15,20,15,10,5,5,5,4,1];
/** 咒力操控档位：每次术式攻击消耗减免 [min,max] */
const CTL_TIERS=[
 [0,2],[3,5],[6,9],[10,19],[20,50],[51,99],[100,299],
 [300,499],[500,699],[700,899],[900,999],[1000,9999],
 [10000,99999],[100000,999999],[1000000,9999999],[10000000,99999999]];
/** 伤害档位（体术 / 咒力效率通用） [min,max] */
const DMG_TIERS=[
 [0,5],[6,10],[11,30],[31,50],[51,99],[100,500],[501,899],
 [900,999],[1000,1999],[2000,4999],[5000,9999],[10000,99999],
 [100000,999999],[1000000,9999999],[10000000,99999999],[100000000,999999999]];
/** 体质（血量）档位：名称 + [min,max]，等概率（前13档进玩家转盘，13~16神域仅NPC） */
const HP_TIERS=[
 ['普通人',[10,30]],['肉身堪比四级咒灵',[31,80]],['肉身堪比三级咒灵',[81,200]],
 ['肉身堪比准二级咒灵',[201,499]],['肉身堪比二级咒灵',[500,999]],
 ['肉身堪比准一级咒灵',[1000,4999]],['肉身堪比一级咒灵',[5000,9999]],
 ['肉身堪比准级咒灵',[10000,19999]],['肉身堪比弱特级咒灵',[20000,39999]],
 ['肉身堪比标准特级咒灵',[40000,49999]],['肉身堪比强特级咒灵',[50000,59999]],
 ['肉身堪比天与暴君',[60000,99999]],['肉身堪比超地表级',[100000,999999]],
 ['肉身堪比龙级',[1000000,4999999]],['肉身堪比龙级巅峰',[5000000,19999999]],
 ['肉身堪比准神级',[20000000,99999999]],['肉身堪比标准神级',[100000000,999999999]]];
/** 低于「四级」的两档（tier -1 准四级 / -2 不入流），仅狩猎低级咒灵时使用 */
const LOW_TIERS={
 [-1]:{cp:[0,5],dmg:[0,3],ctl:[0,1],hp:[13,30]},
 [-2]:{cp:[0,2],dmg:[0,2],ctl:[0,0],hp:[6,12]}};
const tierCp =li=>li<0?LOW_TIERS[li].cp :CP_TIERS[li];
const tierDmg=li=>li<0?LOW_TIERS[li].dmg:DMG_TIERS[li];
const tierCtl=li=>li<0?LOW_TIERS[li].ctl:CTL_TIERS[li];
/** NPC 敌人生命区间：tier 越低越弱 */
function npcHpRange(li){
  if(li<=-2)return LOW_TIERS[-2].hp;
  if(li===-1)return LOW_TIERS[-1].hp;
  return HP_TIERS[clamp(li+1,0,HP_TIERS.length-1)][1];
}
/** 按当前数值反查所处档位索引（区间表 [[min,max],...]） */
function tierIndexOf(v,table){let idx=0;for(let i=0;i<table.length;i++)if(v>=table[i][0])idx=i;return idx;}
/** 按当前生命反查体质档位（HP_TIERS 元素为 [名称,[min,max]]） */
function hpTierIndexOf(v){let idx=0;for(let i=0;i<HP_TIERS.length;i++)if(v>=HP_TIERS[i][1][0])idx=i;return idx;}

const GROWTH=[
 {label:'夭折之资',mult:0.5,weight:5},
 {label:'平庸之才',mult:0.75,weight:10},
 {label:'中规中矩',mult:0.9,weight:15},
 {label:'资质良好',mult:1.0,weight:20},
 {label:'出类拔萃',mult:1.15,weight:17},
 {label:'精英之才',mult:1.3,weight:12},
 {label:'百年天才',mult:1.5,weight:11},
 {label:'旷世奇才',mult:1.75,weight:7},
 {label:'天选之人',mult:2.1,weight:3}];
 /** 固定增量基数表（资质良好 mult=1 时每次修炼/战胜奖励的固定值），索引=综合等级li+2，覆盖li -2~11。
  *  只与等级有关、与玩家已累积属性无关 → 线性可控，后期不膨胀。 */
 const GAIN_BASE={ // 第五版：固定成长值整体翻倍
  cp:  [2,2,4,8,12,50,60,440,460,180,1100,3000,5200,40000],
  hp:  [4,4,8,16,30,60,240,520,800,1400,1800,2200,3200,24000],
  dmg: [2,2,2,4,6,8,14,44,60,70,120,280,520,3600],
  ctl: [2,2,2,2,2,4,6,12,20,28,36,44,56,600]
 };
 /** 取某次成长的固定增量：type=cp/hp/dmg/ctl，li=当前综合等级，k=成长固定系数 */
 function fixedGain(type,li,k){const arr=GAIN_BASE[type];const idx=Math.max(0,Math.min(arr.length-1,li+2));return Math.max(1,Math.round(arr[idx]*k));}

/** 年龄成长系数：25岁基准+0%，16岁封顶+30%线性递增；>25岁线性递减（垂暮）。
 *  半人半受肉体永久+30%，不受年龄影响。返回成长倍率的额外乘区（0.30=+30%）。 */
function ageGrowthBonus(age,identity){
  if(identity==='半人半受肉体')return 0.30;
  if(age<=25)return Math.max(0,Math.min(0.30,(25-age)/9*0.30));
  return Math.max(-0.90,-(age-25)*0.035);
}
/** 性别带来的成长专精：男→体质/体术额外+25%；女→咒力操控/咒力效率额外+25% */
function genderGainMult(gender,type){
  if(gender==='男'&&(type==='hp'||type==='melee'))return 1.25;
  if(gender==='女'&&(type==='ctl'||type==='eff'))return 1.25;
  return 1.0;
}
/** 颜值队伍光环：E/D/C=憎恶lv3/2/1（队友-20%/-10%/-5%总属性），B中性，A/S/EX=鼓舞lv1/2/3（队友+5%/+10%/+20%） */
const FACE_AURA=[-0.20,-0.10,-0.05,0,0.05,0.10,0.20];
function faceAuraName(faceIdx){
  if(faceIdx>=4&&faceIdx<=6)return '鼓舞lv'+(faceIdx-3);
  if(faceIdx>=0&&faceIdx<=2)return '憎恶lv'+(3-faceIdx);
  return '';
}

/** 转盘1：初始身份（附带游戏化身份天赋，在面板内说明） */
const WHEEL_IDENTITY=[
 {label:'普通人类',desc:'没有家世的普通穿越者。血量+10%，百折不挠。',mod:{hp:1.10},factionChoice:true},
 {label:'咒灵',desc:'由负面情绪孕育的存在。咒力总量+30%、术式伤害+10%。',mod:{cp:1.30,eff:1.10},factionChoice:true},
 {label:'咒术师',desc:'正统咒术界出身。咒力消耗减免额外+15%，术式熟练度成长+20%。',mod:{ctl:1.15,prof:1.20},factionChoice:true},
 {label:'诅咒师',desc:'作恶的咒术师。术式伤害+20%、体术伤害+10%。',mod:{eff:1.20,melee:1.10},factionChoice:true},
 {label:'受肉体',desc:'被强大存在寄宿的容器。血量+40%、体术+20%，咒力总量-10%。',mod:{hp:1.40,melee:1.20,cp:0.90},factionChoice:true},
 {label:'半人半受肉体',desc:'半人半诅咒容器。永久成长额外+30%，不受年龄影响。血量+20%、咒力总量+10%。',mod:{hp:1.20,cp:1.10},factionChoice:true}];

/** 转盘2：穿越时间点（游戏开始天数） */
const WHEEL_ERA=[
 {label:'怀玉篇',day:0,arc:'kaigyo',weight:30,desc:'2006年，怀玉·玉折——17岁的五条悟与夏油杰。独立时间线历时30天，第30天战胜伏黑甚尔后将自动转入主线【宿傩受肉篇】第0天。'},
 {label:'未来篇',day:0,arc:'future',weight:50/9,desc:'新宿决战数十年后的未来，乙骨犹花、乙骨真剑、68岁虎杖悠仁与新世代登场。独立时间线历时60天，第30天击败地狱·真人迎来未来篇结局。'},
 {label:'宿傩受肉虎杖时期',day:0,weight:20,desc:'故事原点，一切诅咒的开端。'},
 {label:'钉崎野蔷薇登场篇',day:5,weight:50/9,desc:'钉崎野蔷薇入学，三人组集结前夜。'},
 {label:'少年院篇',day:25,weight:50/9,desc:'特级咒灵盘踞的废弃少年院。'},
 {label:'幼鱼与逆罚篇',day:34,weight:50/9,desc:'真人与漏壶的阴影逼近。'},
 {label:'京都姐妹校交流会篇',day:49,weight:50/9,desc:'两校交流会，花御来袭。'},
 {label:'八十八桥篇',day:69,weight:50/9,desc:'咒胎与九相图兄弟的战场。'},
 {label:'涩谷事变时期',day:85,weight:50/9,desc:'10月31日，涩谷，最惨烈的一夜。'},
 {label:'死灭回游时期',day:100,weight:50/9,desc:'泳者们的杀阵，天元存亡之秋。'},
 {label:'新宿决战时期',day:118,weight:50/9,desc:'最终决战前两日，几乎没有成长时间。'}];

const WHEEL_AGE=[16,17,18,19,20,21,22,23,25,27,30,35,40,50,60].map(n=>({label:n+'岁'}));
const WHEEL_GENDER=[{label:'男'},{label:'女'}];
const WHEEL_FACE=['E','D','C','B','A','S','EX'].map(n=>({label:n+' 级颜值'}));

/** 转盘6：生得术式（严格按设定录入；name=名称，desc=完整设定，flag=特殊机制标识） */
const WHEEL_TECHNIQUE=[
 {name:'无下限术式',flag:'limitless',domain:'无量空处',desc:'【被动·无穷】免疫一切非“领域”类攻击；可利用「苍」进行高速移动（速度×1.1）。但每次轮到自己行动时咒力消耗+1000（可被咒力操控减免抵消）。领域：无量空处。'},
 {name:'十种影法术',flag:'shadows',domain:'嵌合暗翳庭',desc:'每次自己行动随机召唤一个式神助战，强度继承自身总属性：玉犬5%、脱兔3%、蟾蜍7%、大蛇15%、圆鹿20%、贯牛30%、鵺25%、满象35%、虎杖40%；多个式神在场时融合为「嵌合兽」且强度叠加。领域：嵌合暗翳庭。'},
 {name:'御厨子',flag:'cleave',domain:'伏魔御厨子',desc:'掌握解/捌/开/灶四式：解=咒力效率120%、捌=130%、开=200%、灶=250%伤害，依次轮换。领域：伏魔御厨子。'},
 {name:'刍灵咒法',flag:'straw',domain:'灵魂共鸣',desc:'近战攻击附加自身咒力效率50%的额外伤害（共鸣/簪，可伤及灵魂）。领域：灵魂共鸣。'},
 {name:'十划咒法',flag:'ratio',domain:'真视斩击',desc:'近战伤害+50%；持有该术式时黑闪触发概率+20%（共30%）。领域：真视斩击。'},
 {name:'咒言',flag:'cursedSpeech',domain:'真我言灵',desc:'辅助型：行动时可强制命令一个对手，使其下回合无法行动；对手总实力越强，固定咒力消耗越高。领域：真我言灵。'},
 {name:'咒灵操术',flag:'spiritControl',domain:'万鬼来朝',desc:'击败的咒灵化为式神（数值固定不成长）；每次自己行动随机召唤已拥有的3个咒灵式神助战。领域：万鬼来朝。'},
 {name:'无为转变',flag:'idleTrans',domain:'自闭圆顿裹',desc:'近战附加咒力效率100%伤害、咒术攻击附加体术100%伤害；每次行动无消耗恢复10%总血量。领域：自闭圆顿裹。'},
 {name:'不义游戏',flag:'swap',domain:'天手力',desc:'只要自身咒力操控高于对方，就永远闪避其攻击（无法闪避领域攻击）。领域：天手力。'},
 {name:'赤血操术',flag:'blood',domain:'超红莲真新星',desc:'以血为武：攻击消耗自身10%生命值，战斗中咒力效率+100%。领域：超红莲真新星。'},
 {name:'黑鸟操术',flag:'crows',domain:'百鸟共舞',desc:'进入战斗立即召唤3只拥有自身30%总属性的乌鸦式神助战。领域：百鸟共舞。'},
 {name:'投射咒法',flag:'projection',domain:'时胞月宫殿',desc:'速度×1.45，有效速度保底20（减速前生效）；但近战伤害×0.25、咒术伤害×0.5。不再拉条。领域：时胞月宫殿。'},
 {name:'构筑术式',flag:'construct',domain:'三重疾苦',desc:'咒力效率+50%（咒力具现为物质攻击）。领域：三重疾苦。'},
 {name:'傀儡操术',flag:'puppet',domain:'超巨大机甲',desc:'进战召唤一个继承自身70%总属性的傀儡，之后每次行动再召唤一个；傀儡在场时敌人优先攻击傀儡。领域：超巨大机甲。'},
 {name:'淀月',flag:'moon',domain:'恶毒邪月',desc:'每次攻击给目标叠1层毒素；目标每次行动时，每层毒素造成其血量上限5%的伤害。领域：恶毒邪月。'},
 {name:'蚀烂腐术',flag:'rot',domain:'暗蚀',desc:'攻击造成的伤害会同步腐蚀、降低对方的血量上限。领域：暗蚀。'},
 {name:'奇迹',flag:'miracle',domain:'鸿运齐天',desc:'每次死亡时消耗自身咒力总量的30%，得以复活并恢复100%血量；咒力不足则无法复活。领域：鸿运齐天。'},
 {name:'雅各布天梯',flag:'jacob',domain:'天使之息',desc:'行动时可直接秒杀名字带有“受肉体”字样的对手。领域：天使之息。'},
 {name:'幻兽琥珀',flag:'amber',domain:'死门雷兽',desc:'常态速度×1.3；开启后速度×1.8。每次行动燃烧自身20%血量并转化为本次攻击的附加伤害。玩家开启后本场无法撤退，战斗结束（无论胜负）必定死亡。领域：死门雷兽。'},
 {name:'判决术式',flag:'judge',domain:'处刑人之剑',desc:'行动时可直接秒杀名字带有“式神”字样的敌人。领域：处刑人之剑。'},
 {name:'咒力大炮',flag:'cannon',domain:'咒力加农炮',desc:'咒力输出效率+100%（术式伤害翻倍）。领域：咒力加农炮。'},
 {name:'质量术式',flag:'mass',domain:'星之怒',desc:'近战攻击+100%；大招「星之怒」可与一个敌人同归于尽。领域：星之怒。'},
 {name:'鬼臂罗网',flag:'arms',domain:'百臂魔神',desc:'近战攻击附加自身咒力效率10%的额外伤害（百臂追踪）。领域：百臂魔神。'},
 {name:'付丧操术',flag:'tsukumo',domain:'跑得很快',desc:'速度×1.2。领域：跑得很快。'},
 {name:'降灵术',flag:'seance',domain:'秽土转生',desc:'每次行动召唤一个曾经击败过的对手作为本场临时队友。领域：秽土转生。'},
 {name:'天空术式',flag:'sky',domain:'虚化神威',desc:'敌人对自己造成的近战伤害为0。领域：虚化神威。'},
 {name:'生长术式',flag:'grow',domain:'超高速再生',desc:'每次行动恢复自身10%血量与10%咒力。领域：超高速再生。'},
 {name:'火灾操术',flag:'fire',domain:'陨石',desc:'近战攻击附加自身咒力效率80%的火焰伤害。领域：陨石。'},
 {name:'蛊毒术式',flag:'gu',domain:'巫蛊',desc:'每次攻击给目标叠1层蛊毒；目标每次行动时，每层蛊毒造成其血量上限10%的伤害。领域：巫蛊。'},
 {name:'复制术式',flag:'copy',domain:'真赝相爱',desc:'复制并肩作战队友的术式：每名存活队友使自身术式伤害提升。领域：真赝相爱。'},
 {name:'万象拒绝',flag:'negate',domain:'我拒绝',desc:'拒绝一切：直接秒杀咒力总量比自己低的对手。领域：我拒绝。'},
 {name:'黄金体验镇魂曲',flag:'requiem',domain:'万象虚无',desc:'将一切攻击无效化：免疫领域以外的所有攻击伤害。领域：万象虚无。'},
 {name:'界王拳',flag:'kaioken',domain:'十倍界王拳',desc:'进入战斗全属性临时+50%，但每次行动减少10%血量。领域：十倍界王拳。'},
 {name:'超级赛亚人变身',flag:'ssj',domain:'超级赛亚人变身第二阶段',desc:'进入战斗全属性×51，仅持续5次攻击，之后恢复常态。速度通过体质/咒效档位自然上涨，不额外乘51。领域：超赛第二阶段。'},
 {name:'仙人模式',flag:'sage',domain:'仙法之术',desc:'进入战斗后每次行动恢复30%血量。领域：仙法之术。'},
 {name:'死而替生',flag:'reviveWin',domain:'替死鬼',desc:'每次战斗被杀死后直接获得战斗胜利，并夺取敌人的术式。领域：替死鬼。'},
 {name:'元气弹',flag:'genki',domain:'吸收元气弹',desc:'主动：吸收我方全体（含自身）的咒力总量，对敌方全体造成“我方全体咒力总量之和”的伤害。领域：吸收元气弹。'},
 {name:'白金之星·世界',flag:'zaWarudo',domain:'时间暂停',desc:'主动：消耗全部咒力令时间暂停，自身连续获得5次0行动值行动，期间敌我行动值全部冻结；用后冷却3次自身行动。领域：时间暂停。'},
 {name:'天之锁',flag:'enkidu',domain:'锁神之链',desc:'主动：神之锁链无视血量与一切术式防御机制，瞬间斩杀名字或类型带“咒灵”“受肉体”的敌人（无下限、镇魂曲亦无法抵挡）；对其余目标造成普通术式伤害。领域：锁神之链。'},
 {name:'冰灵咒法',flag:'ice',domain:'冰天雪地',desc:'每次命中后寒气扩散，使敌方全体速度-20%（可叠加，层数越高敌人行动越迟缓）。领域：冰天雪地。'},
 {name:'苍月',flag:'blueMoon',domain:'天上天下唯我独尊',desc:'主动：开启后锁定自身生命与咒力10次行动（期间不掉血、不耗蓝），第11次自身行动起失效；每场战斗仅可开启一次。领域：天上天下唯我独尊。'},
 {name:'单独禁区',flag:'soloZone',domain:'全智之星',desc:'主动：耗1000咒力，使全体队友全属性+20%（可叠加重复施放）。领域·全智之星为增益型领域：耗50%咒力，令全体队友全属性+100%，不造成伤害。'},
 {name:'落星术式',flag:'meteor',domain:'天坠流星',desc:'主动：召唤陨石轰击敌方全体，造成自身咒力效率150%的范围伤害。领域：天坠流星。'},
 {name:'影缚术式',flag:'shadowBind',domain:'无限影缚',desc:'每次命中敌人后，以影子束缚目标，使其下回合无法行动（眩晕）。领域：无限影缚。'},
 {name:'钢铁之躯',flag:'ironBody',domain:'不坏金身',desc:'被动：受到的所有伤害-40%，同时近战攻击伤害+20%。领域：不坏金身。'},
 {name:'神速',flag:'godSpeed',domain:'神速领域',desc:'被动：速度×1.3（五宿级别）。若同时拥有幻兽琥珀，开启琥珀后改为×1.8。不再拉条。领域：神速领域。'},
 {name:'念写',flag:'foresight',domain:'未来视',desc:'被动：每次受到攻击有30%概率完全闪避；成功闪避后，下一次攻击必定暴击（伤害×3）。领域：未来视。'},
 {name:'黄泉比良坂',flag:'yomi',domain:'冥界之门',desc:'被动：对血量低于50%的敌人造成双倍伤害（斩杀残血）。领域：冥界之门。'},
 {name:'花田',flag:'flowerField',domain:'百花缭乱',desc:'被动：每次轮到自己行动时，恢复我方全体10%生命值与5%咒力总量。领域：百花缭乱。'},
 {name:'音波操术',flag:'sonic',domain:'寂静领域',desc:'每次攻击有25%概率使敌人眩晕（下回合无法行动）；对已处于眩晕的敌人造成的伤害+50%。领域：寂静领域。'},
 {name:'铁壁',flag:'ironWall',domain:'绝对防御',desc:'被动：血量越高减伤越强——满血时受到伤害-50%，随血量下降线性减弱（空血时无减伤）。领域：绝对防御。'},
 {name:'命之契',flag:'fate',domain:'命运之轮',desc:'每场战斗开始时随机缔结一种命运契约并持续整场：①攻击契约（全伤害+30%）②防御契约（受伤-30%）③速度契约（速度+30%）④治愈契约（每回合恢复10%生命）。领域：命运之轮。'},
 {name:'空间吞噬',flag:'spaceDevour',domain:'噬虚之渊',desc:'被动·吞噬之躯：受到的任何攻击只承受50%伤害，被吞噬的另外50%伤害转化为自身生命值恢复；每次轮到自己行动消耗1000点咒力维持吞噬（咒力不足时减伤失效）。领域：噬虚之渊。'},
 {name:'狗颚爪',flag:'jawClaw',domain:'颚牙裂魂',desc:'近战攻击附带自身咒术伤害30%的撕裂追加伤害（狗颚之爪撕咬灵魂）。领域：颚牙裂魂。'},
 {name:'母霊度暴威',flag:'motherSpirit',domain:'母灵之威',desc:'进入战斗立即召唤一个继承自身100%全属性的【母灵式神】并肩作战；式神存在期间会成为敌人的第一攻击目标（强嘲讽）。领域：母灵之威。'},
 {name:'混沌与调和',flag:'chaosHarmony',domain:'混沌调和之境',desc:'绝对的咒力差压制：只要自身咒力总量高于目标，任何攻击都将其直接抹杀（秒杀）；咒力总量不及目标时仅造成普通伤害。领域：混沌调和之境。'},
 {name:'质量的杀意与光',flag:'massKiller',domain:'杀意流光',desc:'常态速度×1.25（五宿级别）；开启亚光速形态后速度×2.5，咒力消耗×3，每次行动损失5%最大生命。不再拉条。领域：杀意流光。'}];

/** 转盘7/8/9/11：四类十二级数值转盘（统一工厂生成） */
function buildStatWheel(type){
  const nameMap={cp:'初始咒力总量',ctl:'初始咒力操控',melee:'初始体术水平',eff:'初始咒力效率'};
  return TIER_W.map((w,i)=>{
    let label='',desc='';
    if(type==='cp'){label=`${lvName(i)}（咒力 ${CP_TIERS[i][0]}~${CP_TIERS[i][1]} 点）`;desc='咒力总量，释放术式的资源。';}
    if(type==='ctl'){label=`${lvName(i)}咒力操控（消耗减免 ${CTL_TIERS[i][0]}~${CTL_TIERS[i][1]} 点）`;desc='每次咒力攻击消耗的咒力减少对应点数。';}
    if(type==='melee'){label=`${lvName(i)}体术水平（近战伤害 ${DMG_TIERS[i][0]}~${DMG_TIERS[i][1]} 点）`;desc='每次近战攻击的输出伤害区间。';}
    if(type==='eff'){label=`${lvName(i)}咒力效率（术式伤害 ${DMG_TIERS[i][0]}~${DMG_TIERS[i][1]} 点）`;desc='每次咒力攻击的输出伤害区间。';}
    return {label,desc,weight:w,tier:i};
  });
}
/** 转盘10：体质（等概率；仅前13档，龙级/神级肉身不进玩家转盘） */
const WHEEL_HP=HP_TIERS.slice(0,13).map(([label,range])=>({label:`${label}（血量 ${range[0]}~${range[1]}）`,desc:'生命值区间。'}));
/** 转盘12：成长值 */
const WHEEL_GROWTH=GROWTH.map(g=>({label:`${g.label}（固定增量×${g.mult}）`,mult:g.mult,desc:'决定每次修炼/战胜后增加的【固定数值】：按当前等级取固定基数再乘该系数，不随已有属性滚动，后期不会膨胀。',weight:g.weight}));

/** 常规行动转盘（非剧情日，等概率） */
const WHEEL_DAILY=[
 {label:'咒力总量提升修炼',act:'cp',desc:'根据天赋等级与成长值，提升咒力总量上限。'},
 {label:'体术修炼',act:'melee',desc:'根据天赋等级与成长值，提升体术伤害区间。'},
 {label:'锻炼体质',act:'hp',desc:'根据天赋等级与成长值，提升最大生命值。'},
 {label:'学习修炼咒力操控',act:'ctl',desc:'根据天赋等级与成长值，提升咒力消耗减免。'},
 {label:'钻研咒力效率',act:'eff',desc:'根据天赋等级与成长值，提升术式伤害区间与术式熟练度。'},
 {label:'狩猎咒灵',act:'hunt',desc:'进入狩猎转盘：按当前等级分配咒灵强度权重（同级咒灵必占50%），战胜获得成长。'}];

/* ============================ III. 角色：生成 / 成长 / 评估 ============================ */
const Player={
  /** draws: 12 步抽取结果对象，由创建流程收集 */
  create(draws){
    const id=draws.identity, era=draws.era, age=draws.age.label.match(/\d+/)[0]*1,
          faceToken=(draws.face.label.match(/EX|^[EDCBAS]/)||['E'])[0],
          faceIdx=['E','D','C','B','A','S','EX'].indexOf(faceToken);
    const cpT=draws.cp.tier, ctlT=draws.ctl.tier, meleeT=draws.melee.tier,
          effT=draws.eff.tier, hpT=draws.hp.tierIdx;
    const growth=draws.growth.mult*1; // 固定增量系数，不随年龄/当前属性百分比变动
    // 年龄仅影响初始属性（年长者起步更高），不再改动成长
    let ageInit=1.0,ageNote='';
    if(age<=18){ageNote='年少，成长空间充足';}
    else if(age<=25){ageNote='正值黄金年龄';}
    else if(age<=35){ageInit=1.10;ageNote='初始属性×1.10';}
    else if(age<=50){ageInit=1.20;ageNote='初始属性×1.20';}
    else{ageInit=1.30;ageNote='初始属性×1.30';}
    const m=id.mod||{};
    const r=(arr,i)=>rand(arr[i][0],arr[i][1]);
    let maxCp=Math.round(r(CP_TIERS,cpT)*ageInit*(m.cp||1));
    let ctl=Math.round(r(CTL_TIERS,ctlT)*ageInit*(m.ctl||1));
    let melee=[Math.round(DMG_TIERS[meleeT][0]*ageInit*(m.melee||1)),Math.round(DMG_TIERS[meleeT][1]*ageInit*(m.melee||1))];
    let eff=[Math.round(DMG_TIERS[effT][0]*ageInit*(m.eff||1)),Math.round(DMG_TIERS[effT][1]*ageInit*(m.eff||1))];
    let maxHp=Math.round(rand(HP_TIERS[hpT][1][0],HP_TIERS[hpT][1][1])*ageInit*(m.hp||1)); // HP_TIERS元素是[name,[min,max]]
    maxCp=Math.max(maxCp,1);maxHp=Math.max(maxHp,10);
    if(melee[1]<1)melee[1]=1;if(eff[1]<1)eff[1]=1;
    // 阵营：无视身份，所有角色都由玩家在创建时自由选择正派/反派/自由
    const defaultFac=(['咒灵','诅咒师','受肉体'].includes(id.label))?'villain':'hero';
    const fac=id.faction||defaultFac;
    const facLabel=id.factionLabel||(fac==='villain'?'诅咒阵营':fac==='free'?'中立阵营':'高专阵营');
    // 年龄成长系数（半人半受肉体永久+30%）
    const ageBonus=+ageGrowthBonus(age,id.label).toFixed(3);
    const P={
      identity:id.label, identityDesc:id.desc, eraLabel:era.label, startDay:era.day, eraDesc:era.desc,
      arc:era.arc||'main', originEraLabel:era.label, // arc=main主线 / kaigyo怀玉独立时间线（第30天后转入主线）/ future未来篇
      isVillain:fac==='villain', // 反派路线：原BOSS变队友、正派NPC翻转为敌，前中期战败可撤退
      isFree:fac==='free', // 中立阵营：孤身一人，原队友也转为敌人
      faction:fac, factionLabel:facLabel,
      age, gender:draws.gender.label, face:['E','D','C','B','A','S','EX'][faceIdx],
      faceIdx, ageNote, ageGrowthBonus:ageBonus,
      technique:draws.technique,
      extraTech:null, // 新宿决战后（熟练度300%）可额外抽取的第二生得术式
      growthLabel:draws.growth.label.match(/^[^（]+/)[0], growthMult:+growth.toFixed(3),
      cpTier:cpT,ctlTier:ctlT,meleeTier:meleeT,effTier:effT,hpTier:hpT,
      maxCp,cp:maxCp,ctl,melee,eff,maxHp,hp:maxHp,
      prof:0, // 主生得术式熟练度 %（100领悟领域，300领悟极之番）
      reverse:false, // 反转术式
      blackFlash:false, // 黑闪
      domainLearned:false, // 领域展开
      ultimateLearned:false, // 极之番（熟练度300%）
      sixEyes:false, // 六眼（怀玉篇反派战胜觉醒五条悟获得：所有咒力消耗为0）
      jinTools:null, // 伏黑甚尔四件道具（怀玉篇正派战胜甚尔获得：天逆鉾/释魂刀/游云/万里锁）
      statBoost:1.0, // 黑闪累计永久倍率
      stolen:[], // 死而替生夺取的术式名（兼容）
      stolenTechs:[], // 死而替生夺取的完整术式 {name,flag,domain,prof}，各自独立熟练度
      absorbed:[], // 咒灵操术/降灵术永久吸收的敌人快照（数值固定不成长）
      flashCount:0,battleCount:0,huntCount:0,killCount:0,
      eventsDone:[], // 已完成的剧情节点
      notes:[], // 后日谈用关键记录
      allyBoost:FACE_AURA[faceIdx] // 颜值队伍光环：鼓舞/憎恶（队友总属性±5%/10%/20%）
    };
    P.levelIndex=Player.evalLevel(P);
    Rules.init(P);
    return P;
  },
  /** 综合等级索引 0~11：五维均衡加权——咒效(输出)24%、体质(生存)22%，咒力总量/咒力操控/体术各18%；
   *  每一项都计入评级（咒操/体术等差五六档会明显拉低评级），同时以「输出与生存的较短板+2档」温和封顶，避免严重偏科虚高。 */
  evalLevel(P){
    const cp=tierIndexOf(P.maxCp,CP_TIERS);
    const ctl=tierIndexOf(P.ctl,CTL_TIERS);
    const eff=tierIndexOf(P.eff[1],DMG_TIERS);
    const me=tierIndexOf(P.melee[1],DMG_TIERS);
    const hp=hpTierIndexOf(P.maxHp);
    const base=eff*0.24+hp*0.22+cp*0.18+ctl*0.18+me*0.18;
    const hard=Math.min(eff,hp)+2; // 输出/生存为硬短板，允许比其高2档
    return clamp(Math.min(Math.round(base),hard),0,15);
  },
  /** 修炼：type=cp/melee/hp/ctl/eff，返回描述文本 */
  train(P,type){
    const ageK=(1+(P.ageGrowthBonus||0)); // 年龄/半人半受肉体成长系数
    const gK=genderGainMult(P.gender,type); // 性别专精
    const k=P.growthMult*ageK*gK,li=P.levelIndex; // 固定增量：只看成长系数与当前等级，不随已有属性滚动
    let txt='';
    const gTag=(gK>1)?`（${P.gender}性专精×${gK}）`:'';
    if(type==='cp'){
      const add=fixedGain('cp',li,k);
      P.maxCp+=add;P.cp=Math.min(P.maxCp,P.cp+add);txt=`咒力总量 +${add}（固定）（${P.maxCp-add} → ${P.maxCp}）`;
    }else if(type==='melee'){
      const hi=fixedGain('dmg',li,k),lo=Math.max(1,Math.round(hi*0.6));
      P.melee[0]+=lo;P.melee[1]+=hi;txt=`体术伤害区间提升（固定 +${lo}~${hi}）${gTag} → ${P.melee[0]}~${P.melee[1]}`;
    }else if(type==='hp'){
      const a=fixedGain('hp',li,k);
      P.maxHp+=a;P.hp=Math.min(P.maxHp,P.hp+a);txt=`最大生命 +${a}（固定）${gTag}（${P.maxHp}）`;
    }else if(type==='ctl'){
      const a=fixedGain('ctl',li,k);
      P.ctl+=a;txt=`咒力操控（消耗减免）+${a}（固定）${gTag} → ${P.ctl}`;
    }else if(type==='eff'){
      const hi=fixedGain('dmg',li,k),lo=Math.max(1,Math.round(hi*0.6));
      P.eff[0]+=lo;P.eff[1]+=hi;
      Player.gainProf(P,8);
      txt=`咒力效率区间提升（固定 +${lo}~${hi}）${gTag} → ${P.eff[0]}~${P.eff[1]}；术式熟练度 +8%`;
    }
    const old=P.levelIndex;P.levelIndex=Player.evalLevel(P);
    if(P.levelIndex>old)txt+=`；综合评级提升至【${lvName(P.levelIndex)}】`;
    return txt;
  },
  gainProf(P,n){
    const bonus=(P.identity==='咒术师'?1.20:1);
    // 主术式：100%领悟领域、300%领悟极之番，熟练度可一直累积到300封顶
    if(P.prof<300){
      P.prof=clamp(P.prof+n*bonus,0,300);
      if(!P.domainLearned&&P.prof>=100){P.domainLearned=true;P.notes.push('术式熟练度达到100%，领悟【领域展开】');}
      if(!P.ultimateLearned&&P.prof>=300){P.ultimateLearned=true;P.notes.push('术式熟练度达到300%，领悟终极奥义【极之番】！');}
    }
    // 死而替生夺取的每个术式拥有独立熟练度，同步成长
    (P.stolenTechs||[]).forEach(t=>{t.prof=clamp((t.prof||0)+n*bonus,0,300);});
  },
  /**
   * 狩猎咒灵等级权重（严格规则）：
   * ① 最高只能与自己平级，绝不出比自己强的咒灵；可狩猎的最高级封顶「强特级(10)」，不存在超特级咒灵；
   * ② 平级目标固定占 50% 权重；
   * ③ 其余 50% 全部分配比自己低级的咒灵（每低一级权重递减），最低到不入流(-2)。
   * 四级(0)玩家：四级50% + 准四级(-1) + 不入流(-2)。
   */
  huntPool(P){
    const top=clamp(P.levelIndex,-2,10); // 平级目标，封顶强特级
    const lowRel=[20,12,8,5,3,2,2,2,2,2,2,2,2]; // 每低一级的相对权重
    const pool=[{tier:top,weight:50}];
    let k=0;
    for(let t=top-1;t>=-2;t--,k++)pool.push({tier:t,weight:lowRel[Math.min(k,lowRel.length-1)]});
    const lowSum=sum(pool.slice(1).map(p=>p.weight));
    pool.forEach((p,i)=>{if(i>0)p.weight=p.weight/lowSum*50;}); // 低级合计严格=50
    return pool;
  },
  /** 战后成长奖励（按敌方最高等级） */
  reward(P,enemyLi,victory=true){
    if(!victory)return '';
    const ageK=(1+(P.ageGrowthBonus||0));
    const profGain=Math.max(1,6+enemyLi);
    const k=P.growthMult*ageK;
    const cpAdd=fixedGain('cp',enemyLi,k*0.6*genderGainMult(P.gender,'cp'));
    const hpAdd=fixedGain('hp',enemyLi,k*0.6*genderGainMult(P.gender,'hp'));
    const dHi=fixedGain('dmg',enemyLi,k*0.6*genderGainMult(P.gender,'eff')),dLo=Math.max(1,Math.round(dHi*0.6));
    const ctlAdd=fixedGain('ctl',enemyLi,k*0.5*genderGainMult(P.gender,'ctl'));
    P.maxCp+=cpAdd;P.cp=P.maxCp;
    P.maxHp+=hpAdd;P.hp=P.maxHp;
    P.eff[0]+=dLo;P.eff[1]+=dHi;
    P.melee[0]+=Math.round(dLo*0.6*genderGainMult(P.gender,'melee'));P.melee[1]+=Math.round(dHi*0.8*genderGainMult(P.gender,'melee'));
    P.ctl+=ctlAdd;
    Player.gainProf(P,profGain);
    const old=P.levelIndex;P.levelIndex=Player.evalLevel(P);
    let t=`战胜奖励（固定）：咒力+${cpAdd}、生命+${hpAdd}、术式伤害+${dLo}~${dHi}、减免+${ctlAdd}、熟练度+${profGain}%`;
    if(P.levelIndex>old)t+=`；综合评级提升至【${lvName(P.levelIndex)}】`;
    return t;
  }
};

/* ============================ IV. Canvas 转盘组件 ============================ */
const WHEEL_COLORS=['#4c1d95','#1e3a8a','#155e75','#166534','#854d0e','#9f1239','#6d28d9','#1e40af','#0e7490','#3f6212','#b45309','#9d174d','#5b21b6','#334155','#7c2d12','#581c87'];
/** 转盘图例：色块+完整名称+权重%；hitIdx 为抽中项下标（高亮） */
function wheelLegendHtml(items,hitIdx=-1){
  const tw=items.reduce((a,b)=>a+(b.weight||0),0);
  const rows=items.map((it,i)=>{
    const txt=it.label||it.name||'';
    const w=it.weight&&tw>0?`<span class="lg-w">${Math.round(it.weight/tw*100)}%</span>`:'';
    return `<div class="lg-item${i===hitIdx?' hit':''}" title="${(it.desc||txt).replace(/"/g,'&quot;')}"><span class="lg-dot" style="background:${WHEEL_COLORS[i%WHEEL_COLORS.length]}"></span><span>${txt}</span>${w}</div>`;
  }).join('');
  return `<div class="legend-cap"><b>选项总览（共 ${items.length} 项）</b><span>${tw>0?'数字为权重占比':'等概率'}</span></div>${rows}`;
}
let SPIN_SPEED=(function(){try{return +localStorage.getItem('jjk_spin_speed')||2;}catch(e){return 2;}})();
class WheelView{
  /** boxEl: 容器（内含 <canvas>）；items:[{label,weight}] */
  constructor(canvas){
    this.cv=canvas;this.ctx=canvas.getContext('2d');this.items=[];this.rotation=0;this.spinning=false;
  }
  setItems(items){
    this.items=items;this.rotation=0;this.draw();
  }
  draw(){
    const ctx=this.ctx,W=this.cv.width,H=this.cv.height,cx=W/2,cy=H/2,R=W/2-6;
    const n=this.items.length,seg=360/n;
    ctx.clearRect(0,0,W,H);ctx.save();ctx.translate(cx,cy);ctx.rotate(this.rotation*Math.PI/180);
    // 第一遍：先画完所有扇形底色，避免文字被相邻扇形填色覆盖
    for(let i=0;i<n;i++){
      const a0=(i*seg-90)*Math.PI/180,a1=((i+1)*seg-90)*Math.PI/180;
      ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,R,a0,a1);ctx.closePath();
      ctx.fillStyle=WHEEL_COLORS[i%WHEEL_COLORS.length];ctx.fill();
      ctx.strokeStyle='rgba(8,5,20,.9)';ctx.lineWidth=n>20?1:2;ctx.stroke();
    }
    // 第二遍：再统一绘制文字（中线角度与扇形一致，-90° 使 0 号扇形从正上方起）
    for(let i=0;i<n;i++){
      const mid=i*seg+seg/2-90;          // 扇形中线全局角度
      const flip=mid>90&&mid<270;        // 左半圆：文字翻转 180° 保持正立可读
      ctx.save();ctx.rotate(mid*Math.PI/180);if(flip)ctx.rotate(Math.PI);
      ctx.textAlign=flip?'left':'right';ctx.textBaseline='middle';
      const fs=n>24?11:n>14?13:n>8?15:18;
      ctx.font=`700 ${fs}px "PingFang SC","Microsoft YaHei",sans-serif`;
      ctx.lineWidth=Math.max(2,fs/6);ctx.strokeStyle='rgba(8,4,20,.85)';
      let label=this.items[i].label||'';
      const maxLen=n>24?6:n>14?9:n>8?12:13;
      if([...label].length>maxLen)label=[...label].slice(0,maxLen).join('')+'…';
      const tx=flip?-(R-14):R-14;
      ctx.shadowColor='rgba(0,0,0,.9)';ctx.shadowBlur=4;
      ctx.strokeText(label,tx,0);
      ctx.fillStyle='#ffffff';ctx.fillText(label,tx,0);
      ctx.restore();
    }
    // 外圈
    ctx.beginPath();ctx.arc(0,0,R,0,Math.PI*2);ctx.lineWidth=5;ctx.strokeStyle='#c9a6ff';ctx.stroke();
    ctx.restore();
  }
  /** 旋转抽取，cb(selectedItem,index) */
  spin(cb){
    if(this.spinning)return;
    this.spinning=true;
    const sp=SPIN_SPEED,dur=4.6/sp; // 转速倍率：1×/2×/3×
    const idx=weightedIndex(this.items);
    const n=this.items.length,seg=360/n,targetCenter=idx*seg+seg/2;
    this.cv.style.transition='none';
    this.cv.style.transform=`rotate(${this.rotation%360}deg)`;
    void this.cv.offsetWidth;
    // 再转 6 圈，使目标扇形中心停在正上方指针处
    const finalRot=this.rotation+360*6+((360-targetCenter)-(this.rotation%360));
    let settled=false,tickTimer=null;
    const finish=()=>{if(settled)return;settled=true;this.spinning=false;clearInterval(tickTimer);SFX.spinEnd();cb&&(cb(this.items[idx],idx));};
    const onEnd=()=>{finish();this.cv.removeEventListener('transitionend',onEnd);};
    this.cv.addEventListener('transitionend',onEnd);
    this.cv.style.transition=`transform ${dur}s cubic-bezier(.12,.72,.08,1)`;
    this.cv.style.transform=`rotate(${finalRot}deg)`;
    this.rotation=finalRot;
    SFX.spinStart();
    // 指针滴答声：转6圈，每越过一个扇形一声，均摊到整段动画
    const ticks=6*n,iv=Math.max(35,dur*1000/ticks);let tc=0;
    tickTimer=setInterval(()=>{SFX.tick();if(++tc>=ticks)clearInterval(tickTimer);},iv);
    // 兜底：动画事件异常时强制结算
    setTimeout(finish,dur*1000+600);
  }
}

/* ============================ V. 战斗引擎（ATB 轮轴回合制） ============================ */
/* 设计：引擎为纯逻辑，advance() 每次推进“一个动作”；UI 层按节奏调用并渲染事件。
 * 综合实力（等级 li）决定速度，ATB 条先满者行动 -> 即“综合实力越强行动越快”。 */
const TECH_MOVE={
 limitless:['苍·引力坍缩','赫·斥力爆散','茈·虚式轰击'],shadows:['玉犬撕咬','鵺雷击俯冲','满象重坠','脱兔群袭','大蛇绞噬'],
 cleave:['解·无形斩','捌·必中斩','开·火焰','灶·炎灾'],straw:['刍灵共鸣','簪·钉子贯魂'],ratio:['十划·7:3弱点必破'],
 cursedSpeech:['咒言·爆裂吧','咒言·停下','咒言·睡吧'],spiritControl:['驱使吸收咒灵群袭'],idleTrans:['无为转变·灵魂改写'],
 swap:['不义游戏·强制换位'],blood:['赤血·穿刺血弹','赤血·超新星','赤血·血刃斩'],crows:['黑鸟群·共享视野突袭'],
 projection:['投射咒法·24帧位移斩'],construct:['构筑术式·咒具具现'],puppet:['傀儡操术·人偶强袭'],
 moon:['淀月·毒触手侵蚀'],rot:['蚀烂腐术·腐血侵入'],miracle:['奇迹·伤害转化再生'],jacob:['雅各布天梯·圣光剥离'],
 amber:['幻兽琥珀·万雷齐落'],judge:['判决术式·定罪没收'],cannon:['咒力大炮·全力输出'],mass:['质量术式·重力坍缩'],
 arms:['鬼臂罗网·百手追袭'],tsukumo:['付丧操术·机械冲撞'],seance:['降灵术·亡灵强袭'],sky:['天空术式·空间扭曲'],
 grow:['生长术式·荆棘绞杀'],fire:['火灾操术·熔岩喷发'],gu:['蛊毒术式·毒侵'],copy:['复制术式·连携轰击'],
 negate:['万象拒绝·否定一切'],requiem:['黄金体验镇魂曲·行动归零'],kaioken:['界王拳·倍化猛攻'],
 ssj:['超级赛亚人·毁天灭地'],sage:['仙法·自然之力打击'],reviveWin:['死而替生·夺式一击'],
 genki:['元气弹·集气轰击'],zaWarudo:['世界·时间暂停'],enkidu:['天之锁·神罚锁链'],ice:['冰灵·寒霜侵蚀'],blueMoon:['苍月·唯我独尊'],soloZone:['单独禁区·全智加护'],
 meteor:['落星·陨石轰击'],shadowBind:['影缚·影子束缚'],ironBody:['钢铁之躯·不坏打击'],godSpeed:['神速·残影连击'],foresight:['念写·未来视预判'],yomi:['黄泉比良坂·残魂斩杀'],flowerField:['花田·百花缭乱'],sonic:['音波·寂静冲击'],ironWall:['铁壁·绝对防御'],fate:['命之契·命运一击'],
 spaceDevour:['空间吞噬·噬虚'],jawClaw:['狗颚爪·裂魂撕咬'],motherSpirit:['母霊度暴威·母灵轰击'],chaosHarmony:['混沌与调和·咒力抹杀'],massKiller:['质量的杀意与光·流光刺杀'],
 aperture:['孔径·洞穿']};
/** 每个术式对应的领域名（取自 WHEEL_TECHNIQUE.domain） */
const TECH_DOMAIN={};WHEEL_TECHNIQUE.forEach(t=>TECH_DOMAIN[t.flag]=t.domain);

class BattleEngine{
  /** cfg:{title, player(P), enemies:[{name,li,type}], allies:[{name,li,type}]} */
  constructor(cfg){
    this.cfg=cfg;this.ended=false;this.result=null;this.events=[];this.lastActor=null;this.awaitingPlayer=false;
    this.actionsTotal=0;this.units=[];this.killedPool=[];this._downNotified=false; // killedPool: 本场被击败敌人的面板快照（供咒灵操术/降灵召唤）
    this.player=this.makePlayerUnit(cfg.player);
    this.units.push(this.player);
    cfg.allies.forEach(a=>this.units.push(this.makeNpcUnit(a.name,a.li,a.type,'ally')));
    cfg.enemies.forEach(e=>this.units.push(this.makeNpcUnit(e.name,e.li,e.type||'咒灵','enemy',e.wild)));
    // 颜值光环：玩家的颜值给我方队友总属性增幅（鼓舞）或减益（憎恶）
    const aura=(cfg.player&&cfg.player.allyBoost)||0;
    if(aura){
      this.units.filter(u=>u.side==='ally'&&!u.isPlayer&&u.alive).forEach(u=>{
        const m=+(1+aura).toFixed(4);
        u.maxHp=Math.max(1,Math.round(u.maxHp*m));u.hp=u.maxHp;
        u.maxCp=Math.max(1,Math.round(u.maxCp*m));u.cp=u.maxCp;
        u.ctl=Math.max(0,Math.round((u.ctl||0)*m));
        u.melee=u.melee.map(v=>Math.max(1,Math.round(v*m)));
        u.eff=u.eff.map(v=>Math.max(1,Math.round(v*m)));
      });
    }
    this.villain=!!cfg.villain;
    this.lightSpeedAvailable=!!cfg.lightSpeedAvailable;
    // 反派路线：作为敌方登场的五条悟，血量为正常的5倍（人类最强，是反派必须跨越的高墙）
    if(this.villain)this.units.filter(u=>u.side==='enemy'&&u.name==='五条悟').forEach(u=>{u.maxHp=Math.round(u.maxHp*5);u.hp=u.maxHp;});
    // 开局 5% 领悟反转术式
    if(!cfg.player.reverse&&Math.random()<0.05){
      cfg.player.reverse=true;this.player.reverse=true;
      this.events.push({type:'learn',text:'✦ 生死之间灵光乍现——你领悟了被动技能【反转术式】！'});
      cfg.player.notes.push('在战斗中领悟了【反转术式】');
    }
    // 开局 5% 领悟黑闪（另：京都篇战胜东堂葵可100%学会）
    if(!cfg.player.blackFlash&&Math.random()<0.05){
      cfg.player.blackFlash=true;this.player.blackFlash=true;
      this.events.push({type:'learn',text:'✦ 拳与咒力在刹那同频——你在激战中触到了【黑闪】的门径！'});
      cfg.player.notes.push('在战斗中领悟了【黑闪】');
    }
    // 界王拳：开战全属性+50%
    if(this.player.hasFlag('kaioken')){
      this.player.maxHp=Math.round(this.player.maxHp*1.5);this.player.hp=this.player.maxHp;
      this.player.melee=this.player.melee.map(v=>Math.round(v*1.5));this.player.eff=this.player.eff.map(v=>Math.round(v*1.5));
      this.events.push({type:'info',text:'【界王拳】发动！本场全属性提升50%，但每次行动后损失10%生命。'});
    }
    if(this.player.hasFlag('ssj')){
      const u=this.player;
      u.ssjBase={maxHp:u.maxHp,maxCp:u.maxCp,melee:u.melee.slice(),eff:u.eff.slice(),ctl:u.ctl};
      u.maxHp=Math.round(u.maxHp*51);u.hp=u.maxHp;
      u.maxCp=Math.round(u.maxCp*51);u.cp=u.maxCp;
      u.melee=u.melee.map(v=>Math.round(v*51));u.eff=u.eff.map(v=>Math.round(v*51));u.ctl=Math.round(u.ctl*51);
      this.events.push({type:'info',text:'【超级赛亚人变身】！全属性×51，持续5次攻击。'});
    }
    // 进战召唤：黑鸟3乌鸦 / 傀儡1傀儡 / 十影宿傩召唤魔虚罗 / 母霊度暴威召唤母灵式神
    this.units.filter(u=>u.alive).forEach(u=>{
      if(u.hasFlag('crows')){for(let i=0;i<3;i++)this.addSummon(u,'乌鸦式神',0.30,'式神');}
      if(u.hasFlag('puppet'))this.addSummon(u,'傀儡',0.70,'傀儡');
      if(u.hasFlag('motherSpirit')){const m=this.addSummon(u,'母灵式神',1.0,'式神');if(m)m.taunt=true;}
      if(u.skills&&u.skills.summonMakora)this.addSummon(u,'魔虚罗·式神',1.0,'式神',{specName:'魔虚罗',specLi:10});
    });
  }
  hasFlag(u,f){return !!u&&(u.flag===f||(u.flags&&u.flags.includes(f)));}
  makePlayerUnit(P){
    const flags=P.technique.flags?P.technique.flags.slice():[];
    if(P.technique.flag)flags.unshift(P.technique.flag);
    // 死而替生夺取的术式：其 flag 一并并入，使多个术式效果在战斗中同时生效
    (P.stolenTechs||[]).forEach(t=>{if(t.flag)flags.push(t.flag);(t.flags||[]).forEach(f=>flags.push(f));});
    // 新宿后额外抽取的第二生得术式：被动 flag 并入、领域可单独展开
    if(P.extraTech&&P.extraTech.flag)flags.push(P.extraTech.flag);
    const pSpeed=baseSpeedValue(P.maxHp,P.eff[1]);
    return this.decorate({
      name:'你',isPlayer:true,side:'ally',li:P.levelIndex,
      maxHp:P.maxHp,hp:P.maxHp,maxCp:P.maxCp,cp:P.maxCp,
      melee:P.melee.slice(),eff:P.eff.slice(),ctl:P.ctl,
      atb:randF(0,6),speed:pSpeed,
      reverse:!!P.reverse,canDomain:!!(P.domainLearned||(P.extraTech&&P.extraTech.domain)),domainUsed:0,domainCd:0,
      canUlt:!!P.ultimateLearned,ultUsed:false,
      flag:P.technique.flag,flags:[...new Set(flags)],techName:P.technique.name,domainName:P.technique.domain||'领域',
      extraTech:P.extraTech||null,extraDomainUsed:false,
      alive:true,
      skills:{sixEyes:P.sixEyes?1:0,charge:0,adapt:0,regen:0,summonMakora:0,chargeSlash:null,spaceSlash:null,
              tools:P.jinTools?JSON.parse(JSON.stringify(P.jinTools)):null}});
  }
  /** 具名角色优先使用精确五维面板（NPC_CHARS）；否则按 li 推导（泛用/野生咒灵） */
  makeNpcUnit(name,li,type,side,wild){
    li=clamp(li,-2,15);
    const spec=getCharSpec(name,li);
    let maxHp,maxCp,melee,eff,ctl,flag=null,flags=[],opt={},hpIdx;
    if(spec){
      const[cp,me,hp,ct,ef,fl,o]=spec;opt=o||{};
      maxCp=tierMidCp(cp);melee=tierMidDmg(me);eff=tierMidDmg(ef);ctl=tierMidCtl(ct);
      maxHp=charHp(hp);hpIdx=hp;flag=fl;if(o.flags)flags=o.flags.slice();
      if(fl)flags.unshift(fl);flags=[...new Set(flags)];
    }else{
      const cpR=tierCp(li),dmgR=tierDmg(li),ctlR=tierCtl(li);
      let hpR=npcHpRange(li);
      if(wild)hpR=li<0?npcHpRange(li):HP_TIERS[clamp(li,0,HP_TIERS.length-1)][1];
      const vary=v=>Math.round(v*randF(0.85,1.15));
      const hpK=wild?0.60:1,dmgK=wild?0.80:1,sc=(v,k)=>Math.max(1,Math.round(v*k));
      maxHp=sc(rand(hpR[0],hpR[1]),hpK);maxCp=Math.max(1,rand(cpR[0],cpR[1]));
      melee=[Math.max(0,sc(vary(dmgR[0]),dmgK)),Math.max(1,sc(vary(dmgR[1]),dmgK))];
      eff=[Math.max(0,sc(vary(dmgR[0]),dmgK)),Math.max(1,sc(vary(dmgR[1]),dmgK))];
      ctl=Math.max(0,rand(ctlR[0],ctlR[1]));
      opt.rev=li>=8?1:0;opt.dom=side==='enemy'?li>=7:li>=11;opt.bf=0;
    }
    // 付丧操术：速度+20%
    const speed=baseSpeedValue(maxHp,eff[1]);
    // 仅五条悟、十影宿傩、羂索、九十九由基掌握极之番
    const canUlt=['五条悟','十影宿傩','羂索','九十九由基'].includes(name);
    const u=this.decorate({
      name,li,type:type||'咒灵',side,isPlayer:false,wild:!!wild,
      maxHp,hp:maxHp,maxCp,cp:maxCp,melee,eff,ctl,
      atb:randF(0,8),speed,
      reverse:!!opt.rev,
      bf:opt.bf||0, // 是否掌握黑闪（NPC_CHARS 中 bf:1 者战斗中10%触发）
      canDomain:!!opt.dom,domainUsed:0,domainCd:0,flag,flags,techName:flag?this.techLabel(flag):'咒力',
      domainName:flag?(TECH_DOMAIN[flag]||'领域'):'领域',
      canUlt,ultUsed:false,
      skills:{sixEyes:opt.sixEyes||0,charge:opt.charge||0,adapt:opt.adapt||0,adaptRate:opt.adaptRate||0,regen:opt.regen||0,regenCap:opt.regenCap||0,summonMakora:opt.summonMakora||0,
              alwaysFlash:opt.alwaysFlash||0,toolMelee:opt.toolMelee||0,
              chargeSlash:opt.chargeSlash||null,spaceSlash:opt.spaceSlash||null,
              // 伏黑甚尔特殊道具：ama天逆鉾(破术式/吞领域) soul释魂刀(近战+50%) cloud游云(近战+30%) chain万里锁(近战AOE)
              tools:opt.tools||null},
      alive:true});
    return u;
  }
  techLabel(flag){const t=WHEEL_TECHNIQUE.find(x=>x.flag===flag);return t?t.name:'咒力';}
  decorate(u){
    u.buff={defend:false,vuln:0,stun:0,seal:0,ssj:5,actCount:0,miracle:0,saved:false,
            charge:false,poison:0,gu:0,adaptM:0,adaptT:0,
            slow:0,            // 冰灵咒法：减速层数（每层速度×0.8）
            zaWorld:0,         // 白金之星·世界：剩余时停连续行动次数
            zaWorldCd:0,       // 时停冷却（按自身行动计）
            zaWorldOpened:false,// 开启时停的当次行动不消耗时停次数
            blueMoon:0,        // 苍月：剩余锁定生命/咒力的自身行动次数
            blueMoonUsed:false, // 苍月每场只能开启一次
            blueMoonOpened:false, // 苍月开启当次行动不消耗锁定次数
            foresightCrit:false, // 念写：闪避后下次攻击必暴击(×3)
            fateType:null,      // 命之契：本场随机契约 atk/def/spd/heal
            fateRolled:false,
            amberActive:false,lightSpeedActive:false,amberUsed:false,lightSpeedUsed:false};
    u.flags=u.flags||[];u.skills=u.skills||{};
    u.hasFlag=function(f){return u.flag===f||(u.flags&&u.flags.includes(f));};
    u.baseTechMult=Rules.techniqueMultiplier([u.flag,...u.flags]);
    u.speed*=u.baseTechMult;
    // 命之契：战斗开始随机缔结一种契约（spd直接提速，其余在伤害/回复中结算）
    if(u.hasFlag('fate')&&!u.buff.fateRolled){u.buff.fateRolled=true;u.buff.fateType=['atk','def','spd','heal'][rand(0,3)];if(u.buff.fateType==='spd')u.speed*=1.3;}
    u.initialStatSpeed=baseSpeedValue(u.maxHp,u.eff[1]);
    return u;
  }
  /** 有效速度：基础速度受冰灵减速层数影响（每层-20%） */
  effSpeed(u){
    const current=baseSpeedValue(u.maxHp,u.eff[1]);
    const baseMult=u.baseTechMult||1;
    const activeMult=Rules.activeTechniqueMultiplier([u.flag,...(u.flags||[])],!!u.buff.amberActive,!!u.buff.lightSpeedActive);
    let speed=u.speed*(u.initialStatSpeed?current/u.initialStatSpeed:1)*(baseMult?activeMult/baseMult:1);
    // 投射咒法：保底 20，放在减速之前。
    if(u.hasFlag&&u.hasFlag('projection'))speed=Math.max(speed,Rules.tuning.projectionFloor);
    speed*=Math.pow(0.8,u.buff.slow||0);
    return Math.max(0.05,speed);
  }
  /** NPC 在 HP<40% 自动进入琥珀/亚光速；玩家只由按钮触发。 */
  checkSpeedForms(ev){
    for(const u of this.units){
      if(!u.alive||u.isPlayer||u.hp>=u.maxHp*0.4)continue;
      if(u.hasFlag&&u.hasFlag('amber')&&!u.buff.amberActive){
        u.buff.amberActive=true;u.amberUsed=true;
        ev.push({type:'skill',text:`【幻兽琥珀】${u.name} 在濒死之际开启雷兽形态！速度×1.8。`});
      }
      if(u.hasFlag&&u.hasFlag('massKiller')&&!u.buff.lightSpeedActive){
        u.buff.lightSpeedActive=true;u.lightSpeedUsed=true;
        ev.push({type:'skill',text:`【亚光速形态】${u.name} 进入亚光速！速度×2.5，咒力消耗×3。`});
      }
    }
  }
  /** 战斗结束：NPC 的琥珀反噬也在战后结算。 */
  settleAmber(ev){
    if(this._amberSettled)return;this._amberSettled=true;
    this.units.filter(u=>u.amberUsed&&!u.isPlayer&&u.alive).forEach(u=>{
      u.alive=false;u.hp=0;
      if(this.cfg&&this.cfg.player&&Rules.persistent(u)){
        const P=this.cfg.player,key=Rules.characterKey(u.name);
        P.deadCharacters=P.deadCharacters||{};
        P.deadCharacters[key]={name:u.name,faction:Rules.campOf(u),key};
      }
      ev.push({type:'die',text:`【幻兽琥珀】${u.name} 被雷兽反噬，战斗结束后死亡。`});
    });
  }
  alive(side){return this.units.filter(u=>u.alive&&(side?u.side===side:true));}
  /** 召唤单位：继承召唤者总属性的 ratio；tag=式神/傀儡 */
  addSummon(owner,name,ratio,tag,override){
    if(this.alive().length>=14)return null; // 全场单位上限，防止召唤膨胀
    const sc=v=>Math.max(1,Math.round(v*ratio));
    let melee,eff,maxHp,maxCp,ctl,li;
    if(override&&override.specName){ // 以指定具名角色面板召唤（十影宿傩召唤魔虚罗）
      const base=this.makeNpcUnit(override.specName,override.specLi,'式神',owner.side);
      melee=base.melee;eff=base.eff;maxHp=base.maxHp;maxCp=base.maxCp;ctl=base.ctl;li=base.li;
    }else{
      melee=owner.melee.map(sc);eff=owner.eff.map(sc);maxHp=sc(owner.maxHp);maxCp=sc(owner.maxCp);ctl=sc(owner.ctl);li=owner.li;
    }
    const u=this.decorate({name,isPlayer:false,side:owner.side,li,summonTag:tag,ownerName:owner.name,
      maxHp,hp:maxHp,maxCp,cp:maxCp,melee,eff,ctl,atb:clamp(owner.atb+randF(0,10),0,99),
      speed:owner.speed*randF(0.95,1.05),reverse:false,canDomain:false,domainUsed:0,
      flag:null,flags:[],techName:tag,domainName:'',alive:true});
    this.units.push(u);return u;
  }
  /** 十种影法术式神比例表 */
  shadowSummon(owner,ev){
    const table=[['玉犬式神',.05],['脱兔式神',.03],['蟾蜍式神',.07],['大蛇式神',.15],['圆鹿式神',.20],['贯牛式神',.30],['鵺式神',.25],['满象式神',.35],['虎杖式神',.40]];
    const mine=this.alive(owner.side).filter(u=>u.summonTag==='式神'&&u.ownerName===owner.name&&u.fused!==true&&u.shadow===true);
    // 嵌合兽融合：已有≥2个十种影式神在场时，融合为嵌合兽
    if(mine.length>=2){
      const sumHp=mine.reduce((a,b)=>a+b.maxHp,0),sumCp=mine.reduce((a,b)=>a+b.maxCp,0);
      const mM=[Math.round(sum(mine.map(u=>u.melee[0]))),Math.round(sum(mine.map(u=>u.melee[1])))];
      const eE=[Math.round(sum(mine.map(u=>u.eff[0]))),Math.round(sum(mine.map(u=>u.eff[1])))];
      mine.forEach(u=>{u.alive=false;});
      const f=this.decorate({name:'嵌合兽·式神',isPlayer:false,side:owner.side,li:owner.li,summonTag:'式神',ownerName:owner.name,fused:true,shadow:true,
        maxHp:sumHp,hp:sumHp,maxCp:sumCp,cp:sumCp,melee:mM,eff:eE,ctl:0,atb:owner.atb,speed:owner.speed,
        reverse:false,canDomain:false,domainUsed:0,flag:null,flags:[],techName:'嵌合兽',domainName:'',alive:true});
      this.units.push(f);
      ev.push({type:'skill',text:`${owner.name} 的多个式神融合为【嵌合兽】，强度叠加！`});return;
    }
    const[n,r]=table[rand(0,table.length-1)];
    const u=this.addSummon(owner,n,r,'式神');if(u){u.shadow=true;ev.push({type:'skill',text:`${owner.name} 召唤了【${n}】（继承${Math.round(r*100)}%总属性）。`});}
  }
  previewOrder(count=8,firstUnit=null){
    const seq=firstUnit&&firstUnit.alive?[firstUnit]:[];
    const sim=this.alive().map(u=>({u,atb:u.atb}));
    if(!sim.length)return seq;
    while(seq.length<count){
      let ready=sim.filter(s=>s.atb>=100).sort((a,b)=>b.atb-a.atb);
      if(!ready.length){
        const dt=Math.min(...sim.map(s=>(100-s.atb)/this.effSpeed(s.u)));
        sim.forEach(s=>s.atb+=this.effSpeed(s.u)*(dt+1e-8));
        ready=sim.filter(s=>s.atb>=100).sort((a,b)=>b.atb-a.atb);
      }
      const chosen=ready[0];if(!chosen)break;chosen.atb-=100;seq.push(chosen.u);
    }return seq;
  }
  advance(){
    const ev=this.events;this.events=[];
    if(this.ended)return {events:ev,ended:true,result:this.result,needInput:false};
    if(this.actionsTotal>=300)return this.forceSettle(ev); // 硬上限：鏖战300行动仍未分胜负则强制裁决，保证绝不卡死
    const alive=this.alive();
    this.checkSpeedForms(ev);
    // 白金之星·世界：场上若有单位处于时停连续行动中，直接由其行动，其余单位行动值完全冻结
    const timeStopper=alive.find(u=>u.alive&&(u.buff.zaWorld||0)>0);
    let actor=null,guard=0;
    if(timeStopper){actor=timeStopper;}
    else{
      let ready=alive.filter(u=>u.atb>=100).sort((a,b)=>b.atb-a.atb);
      if(!ready.length&&alive.length){
        const dt=Math.min(...alive.map(u=>(100-u.atb)/this.effSpeed(u)));
        alive.forEach(u=>u.atb+=this.effSpeed(u)*(dt+1e-8));
        ready=alive.filter(u=>u.atb>=100).sort((a,b)=>b.atb-a.atb);
      }actor=ready[0];
    }
    if(!actor)return this.pack([{type:'info',text:'战局陷入凝滞。'}]);
    if(!timeStopper)actor.atb-=100; // 时停期间不消耗/推进行动值
    this.lastActor=actor;
    if(actor.buff.stun>0){actor.buff.stun--;ev.push({type:'info',text:`${actor.name} 被压制，无法行动。`});this.afterAction(actor,ev,false);return this.pack(ev);}
    // —— 回合开始钩子 ——
    this.onTurnStart(actor,ev);
    if(this.ended)return this.pack(ev);
    if(!actor.alive){this.checkEnd(ev);return this.pack(ev);} // 回合开始DOT/反噬已将其击倒，不再行动
    actor.buff.defend=false;this.actionsTotal++;actor.buff.actCount++;
    if(actor.isPlayer){this.awaitingPlayer=true;return {events:ev,ended:false,needInput:true};}
    this.npcAct(actor,ev);
    this.afterAction(actor,ev);
    return this.pack(ev);
  }
  /** 回合开始：DOT结算 / 反转 / 无下限耗蓝 / 再生回血 / 行动召唤 */
  onTurnStart(actor,ev){
    // 1. 毒素 / 蛊毒结算（每层扣当前血量上限的比例）
    if(actor.buff.poison>0){const d=Math.round(actor.maxHp*0.05*actor.buff.poison);this.loseHp(actor,d,ev,'淀月毒素');}
    if(actor.buff.gu>0){const d=Math.round(actor.maxHp*0.10*actor.buff.gu);this.loseHp(actor,d,ev,'蛊毒');}
    if(!actor.alive)return;
    // 2. 反转术式（单机主线为被动自动恢复；本地对战versus改为主动技能，不自动触发）
    const reverseCost=this.cpCost(actor,(actor.skills&&actor.skills.sixEyes)?0:Math.round(actor.maxCp*0.05));
    if(!(this.cfg&&this.cfg.versus)&&actor.reverse&&actor.hp<actor.maxHp&&actor.cp>=reverseCost){
      const hf=this.actionsTotal>120?0.25:1; // 力竭阶段回复衰减，保证僵持必分胜负
      const gojoMult=actor.name==='五条悟'?2:1; // 五条悟反转治愈2倍
      const cost=reverseCost,heal=Math.round(actor.maxHp*0.20*hf*gojoMult);
      actor.cp-=cost;actor.hp=Math.min(actor.maxHp,actor.hp+heal);
      ev.push({type:'heal',from:actor.name,text:`${actor.name} 运转【反转术式】，耗5%咒力恢复${Math.round(20*hf*gojoMult)}%生命（+${heal}）。`,heal});
    }
    // 3. 超高速再生（魔虚罗：每回合回90%；未来篇适应体：回100%并按 regenCap 提升血量上限）
    if(actor.skills.regen){
      const rf=this.actionsTotal>120?0.25:1; // 力竭阶段回复衰减，保证僵持必分胜负
      if(actor.skills.regenCap&&rf===1){const inc=Math.round(actor.maxHp*actor.skills.regenCap);actor.maxHp+=inc;actor.hp+=inc;}
      const h=Math.round(actor.maxHp*actor.skills.regen*rf);actor.hp=Math.min(actor.maxHp,actor.hp+h);
      ev.push({type:'heal',text:`${actor.name}【${actor.skills.regenCap?'适应再生':'超高速再生'}】，恢复${Math.round(actor.skills.regen*rf*100)}%生命${actor.skills.regenCap&&rf===1?'并提升血量上限':''}（+${h}）。`,heal:h});
    }
    // 4. 无下限：每次行动咒力消耗+1000（被咒力操控减免抵消；六眼为0）
    if(this.hasFlag(actor,'limitless')&&!actor.skills.sixEyes&&!(actor.buff.blueMoon>0)){
      const cost=this.cpCost(actor,Math.max(0,1000-actor.ctl));
      if(actor.cp>=cost){actor.cp-=cost;if(cost>0&&actor.isPlayer)ev.push({type:'info',text:`维持【无下限·无穷】，本回合消耗咒力 ${cost}（已被操控减免）。`});}
    }
    // 空间吞噬：每次行动耗1000咒力维持吞噬之躯（咒力耗尽则减伤失效）
    if(this.hasFlag(actor,'spaceDevour')&&!actor.skills.sixEyes&&!(actor.buff.blueMoon>0)){
      const cost=this.cpCost(actor,Math.max(0,1000-actor.ctl));
      if(actor.cp>=cost)actor.cp-=cost;
    }
    // 5. 回合回血类
    if(this.hasFlag(actor,'idleTrans')){const h=Math.round(actor.maxHp*.10);actor.hp=Math.min(actor.maxHp,actor.hp+h);if(actor.isPlayer)ev.push({type:'heal',text:`【无为转变】改写灵魂，恢复10%生命（+${h}）。`,heal:h});}
    if(this.hasFlag(actor,'grow')){const h=Math.round(actor.maxHp*.10),c=Math.round(actor.maxCp*.10);actor.hp=Math.min(actor.maxHp,actor.hp+h);actor.cp=Math.min(actor.maxCp,actor.cp+c);if(actor.isPlayer)ev.push({type:'heal',text:`【生长术式】恢复10%生命与咒力。`,heal:h});}
    if(this.hasFlag(actor,'sage')){const h=Math.round(actor.maxHp*.30);actor.hp=Math.min(actor.maxHp,actor.hp+h);if(actor.isPlayer)ev.push({type:'heal',text:`【仙人模式】恢复30%生命（+${h}）。`,heal:h});}
    // 花田：每次行动恢复我方全体10%生命与5%咒力
    if(this.hasFlag(actor,'flowerField')){const team=this.alive(actor.side);const h=team.map(u=>Math.round(u.maxHp*.10));const c=team.map(u=>Math.round(u.maxCp*.05));
      team.forEach((u,i)=>{u.hp=Math.min(u.maxHp,u.hp+h[i]);u.cp=Math.min(u.maxCp,u.cp+c[i]);});
      if(actor.isPlayer)ev.push({type:'heal',text:`【花田·百花缭乱】我方全体恢复10%生命与5%咒力。`,heal:h[0]});}
    // 命之契·治愈契约：每回合恢复10%生命
    if(actor.buff.fateType==='heal'){const h=Math.round(actor.maxHp*.10);actor.hp=Math.min(actor.maxHp,actor.hp+h);if(actor.isPlayer)ev.push({type:'heal',text:`【命之契·治愈契约】恢复10%生命（+${h}）。`,heal:h});}
    // 6. 行动时召唤
    if(this.hasFlag(actor,'shadows'))this.shadowSummon(actor,ev);
    if(this.hasFlag(actor,'spiritControl')){for(let i=0;i<3;i++)this.summonFromKilled(actor,ev,'咒灵式神');}
    if(this.hasFlag(actor,'seance'))this.summonFromKilled(actor,ev,'亡灵式神');
    if(this.hasFlag(actor,'puppet')){const n=this.alive(actor.side).filter(u=>u.summonTag==='傀儡'&&u.ownerName===actor.name).length;if(n<3)this.addSummon(actor,'傀儡',.70,'傀儡');}
    // 领域熔断恢复：轮到自身行动时，有反转术式者冷却-1（用完间隔自身一次行动即可再开）
    if((actor.domainCd||0)>0&&actor.domainCd<9000)actor.domainCd=Math.max(0,actor.domainCd-1);
  }
  summonFromKilled(owner,ev,prefix){
    const perm=(owner.isPlayer&&this.cfg.player.absorbed)?this.cfg.player.absorbed:[];
    const pool=perm.concat(this.killedPool);
    if(!pool.length)return;
    const dead=pool[rand(0,pool.length-1)];
    const u=this.addSummon(owner,prefix+'·'+dead.name,1.0,'式神');
    if(u){u.melee=dead.melee.slice();u.eff=dead.eff.slice();u.maxCp=dead.maxCp;u.cp=dead.maxCp;u.maxHp=dead.maxHp;u.hp=dead.maxHp;u.li=dead.li;
      ev.push({type:'skill',text:`${owner.name} 召唤曾击败的【${dead.name}】作为临时式神。`});}
  }
  loseHp(u,d,ev,label){
    if(!u.alive||d<=0)return;
    u.hp-=d;ev.push({type:'hit',text:`${u.name} 因【${label}】受到 ${d} 点持续伤害。`,dmg:d});
    if(u.hp<=0){
      if(u.isPlayer)this.guardPlayerDeath(ev);
      if(u.alive===false||u.hp<=0)this.kill(u,ev);
    }
  }
  pack(ev){this.checkEnd(ev);return {events:ev,ended:this.ended,result:this.result,needInput:false};}
  afterAction(actor,ev,acted){
    // acted=false 表示本回合被眩晕/压制、并未真正行动：只结算全局力竭与死亡判定，不触发“行动代价/行动收益”
    if(acted===undefined)acted=true;
    // 力竭收敛：行动超过120次后（如双方互相免疫/打不动），全体每回合受最大生命4%的力竭伤害，保证战斗必然分出胜负
    if(this.actionsTotal>120){
      const over=this.actionsTotal-120;
      const pct=Math.min(0.60,0.04+Math.floor(over/6)*0.05); // 递增侵蚀：4%起每6行动+5%，封顶60%（必压过再生/反转）
      this.alive().forEach(u=>{if(!u.alive)return;const d=Math.max(1,Math.round(u.maxHp*pct));u.hp-=d;
        if(u.isPlayer)ev.push({type:'hit',text:`战局拖入力竭（侵蚀${Math.round(pct*100)}%），你受到 ${d} 点侵蚀伤害。`,dmg:d});
        if(u.hp<=0){if(u.isPlayer)this.guardPlayerDeath(ev);if(u.hp<=0)this.kill(u,ev);}});
    }
    if(acted){
      // 界王拳反噬：每次实际行动-10%血（苍月锁定生命期间不掉血；被眩晕不行动时不扣）
      if(this.hasFlag(actor,'kaioken')&&!(actor.buff.blueMoon>0)){const d=Math.round(actor.maxHp*.10);actor.hp-=d;ev.push({type:'hit',text:`【界王拳】反噬，生命 -${d}。`,dmg:d});}
      // 亚光速形态：每次实际行动损失5%最大生命（反转术式只解除冷却，不抵消这个代价）
      if(actor.buff.lightSpeedActive&&actor.alive){
        const d=Math.max(1,Math.round(actor.maxHp*0.05));actor.hp-=d;
        ev.push({type:'hit',text:`【亚光速形态】反噬，${actor.isPlayer?'你':actor.name}损失 ${d} 点生命（5%上限）。`,dmg:d});
        if(actor.hp<=0){if(actor.isPlayer)this.guardPlayerDeath(ev);if(actor.hp<=0)this.kill(actor,ev);}
      }
      // 白金之星·世界 / 苍月：按“自身行动次数”递减（被眩晕不行动时不消耗次数）
      if((actor.buff.zaWorld||0)>0){if(actor.buff.zaWorldOpened){actor.buff.zaWorldOpened=false;}else{actor.buff.zaWorld--;if(actor.buff.zaWorld===0)ev.push({type:'skill',text:`${actor.isPlayer?'你':actor.name} 的【时间暂停】结束，所有人的行动值重新开始流动。`});}}
      if((actor.buff.blueMoon||0)>0){if(actor.buff.blueMoonOpened)actor.buff.blueMoonOpened=false;else{actor.buff.blueMoon--;if(actor.buff.blueMoon===0)ev.push({type:'info',text:`【苍月·天上天下唯我独尊】10次行动已过，生命与咒力的锁定解除。`});}}
    }
    // 时停冷却按回合流转（眩晕也计时）
    if((actor.buff.zaWorldCd||0)>0&&(actor.buff.zaWorld||0)===0)actor.buff.zaWorldCd--;
    if(actor.isPlayer&&actor.hp<=0)this.guardPlayerDeath(ev);
    this.checkSpeedForms(ev);
    this.checkEnd(ev);
  }
  playerAct(action,targetIdx,opts){
    const ev=[];const p=this.player;this.awaitingPlayer=false;
    const enemySide=p.side==='enemy'?'ally':'enemy';
    const target=()=>{let t=this.units[targetIdx];if(!t||!t.alive||t.side!==enemySide)t=this.alive(enemySide).sort((a,b)=>a.hp-b.hp)[0];return t;};
    if(action==='defend'){
      p.buff.defend=true;p.cp=Math.min(p.maxCp,p.cp+Math.round(p.maxCp*0.08));
      ev.push({type:'info',text:'你架式防御，本回合受伤减半，并恢复8%咒力。'});
    }else if(action==='domain'){
      const domOk=this.castDomain(p,ev,opts&&opts.forceExtra);
      if(!domOk){ // 领域熔断中 / 咒力不足：不消耗本次行动，继续等待玩家重新选择指令
        this.awaitingPlayer=true;
        return {events:ev,ended:false,result:null,needInput:true,retryInput:true};
      }
    }
    else if(action==='ult'){
      const ultOk=this.castUltimate(p,ev);
      if(!ultOk){ // 不满足极之番条件：不耗回合，重新等待指令
        this.awaitingPlayer=true;
        return {events:ev,ended:false,result:null,needInput:true,retryInput:true};
      }
    }
    else if(action==='melee'){
      if(p.skills&&p.skills.tools&&p.skills.tools.chain){this.alive(enemySide).forEach(t=>this.performStrike(p,t,'melee',ev));}
      else this.performStrike(p,target(),'melee',ev);
    }
    else if(action==='tech'){
      const cost=this.techCost(p);
      const chain=p.skills&&p.skills.tools&&p.skills.tools.chain;
      if(p.buff.blueMoon>0){if(chain)this.alive(enemySide).forEach(t=>this.performStrike(p,t,'tech',ev));else this.performStrike(p,target(),'tech',ev);} // 苍月锁蓝：不耗咒力
      else if(p.cp<cost){ev.push({type:'info',text:'咒力不足，无法释放术式，只能近身肉搏！'});if(chain)this.alive(enemySide).forEach(t=>this.performStrike(p,t,'melee',ev));else this.performStrike(p,target(),'melee',ev);}
      else{p.cp-=cost;if(chain)this.alive(enemySide).forEach(t=>this.performStrike(p,t,'tech',ev));else this.performStrike(p,target(),'tech',ev);}
    }
    else if(action.startsWith&&action.startsWith('sig_')){
      // 专属技能：五条悟苍/赫/茈、宿傩解/捌/开/灶、九十九星之怒/质量弹
      const skill=action.substring(4);
      const avg=(p.eff[0]+p.eff[1])/2;
      const foes=this.alive(enemySide);
      const doHit=(scope,mult,label,fixed)=>{
        ev.push({type:'skillcut',actorName:p.name,text:label});
        const list=scope==='all'?foes:[target()];
        list.forEach(t=>{if(t&&t.alive)this.dealDamage(p,t,fixed!=null?fixed:Math.round(avg*mult),1,'tech',ev,label,false,false);});
        this.afterStrike(ev);
      };
      if(skill==='aoi')doHit('all',1.5,p.name+'·苍（引力·全体）');
      else if(skill==='ka')doHit('one',2.0,p.name+'·赫（斥力·单体）');
      else if(skill==='kai')doHit('all',1.2,p.name+'·解（无形斩·全体）');
      else if(skill==='hatsu')doHit('one',1.2,p.name+'·捌（必中斩·单体）');
      else if(skill==='hiraku')doHit('all',2.0,p.name+'·开（火焰·全体）');
      else if(skill==='kamado')doHit('one',2.5,p.name+'·灶（炽焰·单体）');
      else if(skill==='shitsuryo')doHit('one',2.2,p.name+'·质量弹');
      else if(skill==='hoshi'){
        if(p.hp<p.maxHp*0.3){ev.push({type:'info',text:'血量不足30%，无法发动星之怒！'});this.awaitingPlayer=true;return {events:ev,ended:false,result:null,needInput:true,retryInput:true};}
        const cost=Math.round(p.hp*0.99);p.hp-=cost;
        ev.push({type:'hit',text:p.name+' 燃烧99%生命（-'+cost+'）凝聚【星之怒】。',dmg:cost});
        doHit('all',0,p.name+'·星之怒',1000000);
      }
      else if(skill==='murasaki'){
        if(p.buff.charge){p.buff.charge=false;const t=target();if(t){ev.push({type:'skillcut',actorName:p.name,text:p.name+' · 虚式「茈」'});const d=Math.round(avg*5.0);this.dealDamage(p,t,d,1,'tech',ev,p.name+'·虚式「茈」',false,true);this.afterStrike(ev);}}
        else{p.buff.charge=true;ev.push({type:'info',text:p.name+' 开始蓄力【虚式·茈】，下一击将造成恐怖伤害！'});}
      }
      else if(skill==='spaceSlash'){
        // 十影宿傩·空间斩：固定真伤，无法被术式豁免
        const ss=p.skills&&p.skills.spaceSlash;
        if(!ss){ev.push({type:'info',text:'无法使用空间斩'});this.awaitingPlayer=true;return {events:ev,ended:false,result:null,needInput:true,retryInput:true};}
        const t=target();if(t){ev.push({type:'skillcut',actorName:p.name,text:'十影宿傩 · 空间斩'});this.dealDamage(p,t,ss.dmg,1,'tech',ev,'十影宿傩·空间斩（无法豁免）',false,true);this.afterStrike(ev);}
      }
      else if(skill==='sCharge'){
        // 一削~五削宿傩·空间斩：蓄力一回合→固定真伤
        const cs=p.skills&&p.skills.chargeSlash;
        if(!cs){ev.push({type:'info',text:'无法使用空间斩'});this.awaitingPlayer=true;return {events:ev,ended:false,result:null,needInput:true,retryInput:true};}
        if(p.buff.charge){p.buff.charge=false;const t=target();if(t){ev.push({type:'skillcut',actorName:p.name,text:p.name+' · 空间斩'});this.dealDamage(p,t,cs.dmg,1,'tech',ev,p.name+'·空间斩（无法豁免）',false,true);this.afterStrike(ev);}}
        else{p.buff.charge=true;ev.push({type:'info',text:p.name+' 开始凝聚【空间斩】，下一回合落下无法豁免的一击！'});}
      }
      else if(skill==='reverse'){
        // 本地对战：主动反转术式——回5%最大生命、单次封顶10万，消耗本次行动
        if(!p.reverse){ev.push({type:'info',text:'未掌握反转术式'});this.awaitingPlayer=true;return {events:ev,ended:false,result:null,needInput:true,retryInput:true};}
        if(p.hp>=p.maxHp){ev.push({type:'info',text:'生命值已满，无需运转反转术式'});this.awaitingPlayer=true;return {events:ev,ended:false,result:null,needInput:true,retryInput:true};}
        const rcost=(p.skills&&p.skills.sixEyes)?0:Math.round(p.maxCp*0.05);
        p.cp=Math.max(0,p.cp-rcost);
        let rh=Math.min(Math.round(p.maxHp*0.05),100000); // 5%且封顶10万
        rh=Math.min(rh,p.maxHp-p.hp); // 不超过缺失血量
        rh=Math.max(0,rh);
        p.hp=Math.min(p.maxHp,p.hp+rh);
        ev.push({type:'skillcut',actorName:p.name,text:p.name+' · 反转术式'});
        ev.push({type:'heal',from:p.name,text:`${p.name} 主动运转【反转术式】，恢复5%生命（+${rh}，单次上限10万），消耗本次行动。`,heal:rh});
      }
    }
    this.afterAction(p,ev);
    return {events:ev,ended:this.ended,result:this.result,needInput:false};
  }
  /** 超级赛亚人结束：把×51的属性还原（界王拳等其他 buff 保留）。 */
  revertSsj(u,ev){
    if(!u.ssjBase)return;
    const b=u.ssjBase;
    u.maxHp=b.maxHp;u.hp=Math.min(u.hp,u.maxHp);
    u.maxCp=b.maxCp;u.cp=Math.min(u.cp,u.maxCp);
    u.melee=b.melee.slice();u.eff=b.eff.slice();u.ctl=b.ctl;
    u.ssjBase=null;
    ev.push({type:'info',text:'超级赛亚人变身结束，恢复常态。'});
  }
  /** 亚光速形态：该单位所有咒力消耗×3。 */
  cpCost(u,base){
    const mult=u&&u.buff&&u.buff.lightSpeedActive?3:1;
    return Math.max(0,Math.round((base||0)*mult));
  }
  techCost(u){
    if(u.skills&&u.skills.sixEyes)return 0; // 六眼：咒力消耗为0
    return this.cpCost(u,Math.max(1,Math.round(u.eff[1]*0.08)-u.ctl));
  }
  /** 统一出手（玩家/NPC 共用），kind=melee|tech */
  performStrike(att,target,kind,ev){
    if(!target||!target.alive)return;
    // 混沌与调和：自身咒力总量高于目标时，任何攻击（近战/咒术）都将其直接抹杀
    if(this.hasFlag(att,'chaosHarmony')&&att.maxCp>target.maxCp&&!(target.buff.blueMoon>0)){
      ev.push({type:'skillcut',actorName:att.name,text:'混沌与调和 · 咒力抹杀'});
      ev.push({type:'domain',text:`【混沌与调和】${att.isPlayer?'你':att.name} 的咒力总量绝对压制 ${target.name}，一击将其存在抹杀（秒杀）！`});
      this.kill(target,ev,att);this.afterStrike(ev);return;
    }
    // —— 即死类（tech）——
    if(kind==='tech'){
      // 白金之星·世界：消耗全部咒力，时停并获得5次0行动值连续行动，用后冷却3次自身行动
      if(this.hasFlag(att,'zaWarudo')&&(att.buff.zaWorld||0)<=0&&(att.buff.zaWorldCd||0)<=0&&att.cp>0){
        ev.push({type:'skillcut',actorName:att.name,text:'白金之星 · 世界'});
        if(!(att.buff.blueMoon>0))att.cp=0;
        att.buff.zaWorld=5;att.buff.zaWorldOpened=true;att.buff.zaWorldCd=3;
        ev.push({type:'domain',text:`✦ ${att.isPlayer?'你':att.name} 发动【世界·时间暂停】——接下来将连续行动5次，期间敌我行动值全部冻结！ ✦`});
        this.afterStrike(ev);return;
      }
      // 苍月：开启后锁定自身生命与咒力10次行动，每场一次
      if(this.hasFlag(att,'blueMoon')&&!att.buff.blueMoonUsed){
        att.buff.blueMoonUsed=true;att.buff.blueMoon=10;att.buff.blueMoonOpened=true;
        ev.push({type:'skillcut',actorName:att.name,text:'苍月 · 天上天下唯我独尊'});
        ev.push({type:'domain',text:`✦ ${att.isPlayer?'你':att.name} 展开【苍月】——未来10次自身行动内，生命与咒力被牢牢锁定，不掉血、不耗蓝！ ✦`});
        this.afterStrike(ev);return;
      }
      // 单独禁区（主动）：耗1000咒力，全体队友全属性+20%，可叠加
      if(this.hasFlag(att,'soloZone')){
        const cost=(att.skills&&att.skills.sixEyes||att.buff.blueMoon>0)?0:this.cpCost(att,1000);
        if(att.cp>=cost||att.buff.blueMoon>0){if(!(att.buff.blueMoon>0))att.cp-=cost;this.boostTeam(att,0.20,ev,'单独禁区');this.afterStrike(ev);return;}
      }
      // 元气弹：吸收我方全体咒力总量，对敌方全体造成等量伤害
      if(this.hasFlag(att,'genki')){
        const total=this.alive(att.side).reduce((a,u)=>a+u.maxCp,0);
        ev.push({type:'skillcut',actorName:att.name,text:'元气弹 · 集气轰击'});
        const foes=att.side==='enemy'?this.alive('ally'):this.alive('enemy');
        foes.forEach(t=>{if(t.alive)this.dealDamage(att,t,total,1,'tech',ev,'元气弹（全队咒力汇聚）',false,true);});
        this.afterStrike(ev);return;
      }
      // 落星术式：召唤陨石，对敌全体造成自身咒力效率150%伤害
      if(this.hasFlag(att,'meteor')){
        const dmg=Math.round((att.eff[0]+att.eff[1])/2*1.5);
        ev.push({type:'skillcut',actorName:att.name,text:'落星 · 天坠流星'});
        const foes=att.side==='enemy'?this.alive('ally'):this.alive('enemy');
        foes.forEach(t=>{if(t.alive)this.dealDamage(att,t,dmg,1,'tech',ev,'落星术式·陨石轰击',false,false);});
        this.afterStrike(ev);return;
      }
      if(this.hasFlag(att,'jacob')&&(target.type==='受肉体'||target.name.includes('受肉'))){ev.push({type:'domain',text:`【雅各布天梯】圣光剥离受肉灵魂，${target.name} 被瞬间抹除！`});this.kill(target,ev,att);this.afterStrike(ev);return;}
      // 天之锁：无视血量与一切术式防御，斩杀“咒灵/受肉体”（直接抹除，不经免伤判定）
      if(this.hasFlag(att,'enkidu')&&(target.type==='咒灵'||target.type==='受肉体'||target.name.includes('咒灵')||target.name.includes('受肉'))){
        ev.push({type:'skillcut',actorName:att.name,text:'天之锁 · 锁神之链'});
        ev.push({type:'domain',text:`【天之锁】神罚锁链贯穿 ${target.name}——无视其血量与一切术式防御，将其当场斩杀！`});this.kill(target,ev,att);this.afterStrike(ev);return;}
      if(this.hasFlag(att,'judge')&&(target.type==='式神'||target.summonTag==='式神'||target.name.includes('式神'))){ev.push({type:'domain',text:`【判决术式】定罪完成，式神 ${target.name} 被处刑抹除！`});this.kill(target,ev,att);this.afterStrike(ev);return;}
      if(this.hasFlag(att,'negate')&&target.maxCp<att.maxCp){ev.push({type:'domain',text:`【万象拒绝】${att.name} 否定了咒力更低的 ${target.name}，将其存在直接拒绝（秒杀）！`});this.kill(target,ev,att);this.afterStrike(ev);return;}
      // 咒言：控制目标下回合无法行动，消耗随对方实力提高（苍月锁蓝时不耗）
      if(this.hasFlag(att,'cursedSpeech')){const raw=(att.skills&&att.skills.sixEyes||att.buff.blueMoon>0)?0:Math.round(att.maxCp*0.05+target.maxCp*0.02);const cost=this.cpCost(att,raw);if(att.cp>=cost){att.cp-=cost;target.buff.stun=Math.max(target.buff.stun,1);ev.push({type:'skill',text:`【咒言】强制命令 ${target.name}，其下回合无法行动（耗咒力${cost}）。`});} }
    }
    // —— 基础伤害 ——
    let base,label,mult=1;
    if(kind==='melee'){base=rand(att.melee[0],att.melee[1]);label=`${att.name} 体术攻击`;}
    else{
      // 御厨子四式轮换：解120/捌130/开200/灶250
      if(this.hasFlag(att,'cleave')){const seq=[['解',1.2],['捌',1.3],['开',2.0],['灶',2.5]];const[nm,m]=seq[(att.buff.actCount-1+seq.length)%seq.length];base=Math.round(rand(att.eff[0],att.eff[1])*m);label=`${att.name}「${nm}」`;}
      else{base=Math.round(rand(att.eff[0],att.eff[1])*2.0);label=`${att.name}「${this.pickMove(att.flag)}」`;}
    }
    // 队友颜值协同（allyBoost）
    if(att.side==='ally'&&!att.isPlayer)mult*=(1+(this.cfg.player.allyBoost||0));
    // —— 增伤倍率 ——
    if(kind==='melee'){
      if(this.hasFlag(att,'ratio'))mult*=1.5;            // 十划 近战+50%
      if(this.hasFlag(att,'mass'))mult*=2.0;            // 质量 近战+100%
      // 伏黑甚尔特殊道具：释魂刀 体术+50%、游云 体术+30%（合计×1.8）
      if(att.skills&&att.skills.tools){const t=att.skills.tools;mult*=(1+(t.soul?.5:0)+(t.cloud?.3:0));}
      // 火之夜艺咒具：体术伤害+20%
      if(att.skills&&att.skills.toolMelee)mult*=(1+att.skills.toolMelee);
    }
    if(kind==='tech'){
      if(this.hasFlag(att,'construct'))mult*=1.5;       // 构筑 效率+50%
      if(this.hasFlag(att,'cannon'))mult*=2.0;          // 咒力大炮 +100%
      if(this.hasFlag(att,'blood'))mult*=2.0;           // 赤血 效率+100%
      if(this.hasFlag(att,'projection'))mult*=0.5;      // 投射 咒术×0.5
    }
    if(kind==='melee'&&this.hasFlag(att,'projection'))mult*=0.25; // 投射 近战×0.25
    // 超级赛亚人 ×51（前5次攻击）
    if(this.hasFlag(att,'ssj')&&att.buff.ssj>0){att.buff.ssj--;if(att.buff.ssj===0)this.revertSsj(att,ev);}
    // 复制术式：每名存活非自身队友 +8%；死而替生夺式 +20%/个
    if(this.hasFlag(att,'copy'))mult*=(1+0.08*this.alive(att.side).filter(u=>u!==att&&!u.summonTag).length);
    if(att.isPlayer)mult*=(1+0.20*(this.cfg.player.stolen?.length||0));
    // 钢铁之躯：近战+20%
    if(kind==='melee'&&this.hasFlag(att,'ironBody'))mult*=1.20;
    // 黄泉比良坂：对血量低于50%的目标伤害×2
    if(this.hasFlag(att,'yomi')&&target.hp<target.maxHp*0.5)mult*=2.0;
    // 音波操术：对已眩晕目标伤害+50%
    if(this.hasFlag(att,'sonic')&&(target.buff.stun||0)>0)mult*=1.50;
    // 念写：闪避后下次攻击必暴击(×3)
    if(att.buff.foresightCrit){mult*=3;att.buff.foresightCrit=false;ev.push({type:'skill',text:`${att.isPlayer?'你':att.name}【念写·未来视】预判成功，本次攻击暴击（×3）！`});}
    // 命之契·攻击契约：全伤害+30%
    if(att.buff.fateType==='atk')mult*=1.30;
    // —— 耗血类：赤血耗10%血；幻兽琥珀烧20%血转附加（苍月锁定生命期间不烧血）——
    let amberBonus=0;
    if(kind==='tech'&&this.hasFlag(att,'blood')&&!(att.buff.blueMoon>0)){const c=Math.round(att.maxHp*.10);att.hp-=c;ev.push({type:'hit',text:`【赤血操术】以血为武，消耗自身10%生命（-${c}）。`,dmg:c});}
    if(this.hasFlag(att,'amber')&&!(att.buff.blueMoon>0)){const c=Math.round(att.maxHp*.20);att.hp-=c;amberBonus=c;ev.push({type:'hit',text:`【幻兽琥珀】燃烧20%生命（-${c}）化作雷击附加。`,dmg:c});}
    // —— 黑闪 ——（玩家需学会；NPC 需 bf；alwaysFlash=每发必黑闪，如未来篇68岁虎杖）
    let flash=false;const flashP=(att.isPlayer&&this.cfg.player.blackFlash)?0.10:(att.bf?0.10:0)+(this.hasFlag(att,'ratio')?0.20:0);
    if((att.skills&&att.skills.alwaysFlash)||(flashP>0&&Math.random()<flashP)){mult*=10;flash=true;}
    // 天逆鉾：持有者攻击强制穿透一切术式免疫（破无下限/镇魂曲/不义游戏/天空）
    const bypassTool=(att.skills&&att.skills.tools&&att.skills.tools.ama)?true:false;
    const dmg=this.dealDamage(att,target,base,mult,kind,ev,label,flash,bypassTool);
    // —— 附加伤害（命中后追加，不再触发叠层/即死递归）——
    if(target.alive&&dmg>0){
      const bonus=(kind==='melee'?this.meleeBonus(att):0)+(kind==='tech'?this.techBonus(att):0)+amberBonus;
      if(bonus>0)this.dealDamage(att,target,Math.round(bonus),1,kind,ev,att.techName+'·附加',false,true);
      // 质量术式·星之怒：tech 时与目标同归于尽的毁灭一击（自身承受50%当前血）
      if(kind==='tech'&&this.hasFlag(att,'mass')){const sd=Math.round((att.eff[0]+att.eff[1])*3);this.dealDamage(att,target,sd,1,'tech',ev,'质量术式·星之怒',false,true);}
    }
    // —— 命中后叠层 / 蚀烂降上限 / 冰灵减速 ——
    if(target.alive&&dmg>0){
      if(this.hasFlag(att,'moon')){target.buff.poison++;ev.push({type:'skill',text:`${target.name} 中了【淀月】毒素（当前${target.buff.poison}层）。`});}
      if(this.hasFlag(att,'gu')){target.buff.gu++;ev.push({type:'skill',text:`${target.name} 中了【蛊毒】（当前${target.buff.gu}层）。`});}
      if(this.hasFlag(att,'rot')){target.maxHp=Math.max(1,target.maxHp-dmg);if(target.hp>target.maxHp)target.hp=target.maxHp;ev.push({type:'skill',text:`【蚀烂腐术】腐蚀肉体，${target.name} 血量上限被削减 ${dmg}。`});}
    }
    // 冰灵咒法：命中即对敌方全体叠减速（即便本次击杀了主目标，其余敌人仍被寒霜波及）
    if(dmg>0&&this.hasFlag(att,'ice')){const foes=att.side==='enemy'?this.alive('ally'):this.alive('enemy');foes.forEach(u=>u.buff.slow++);ev.push({type:'skill',text:`【冰灵咒法】寒霜扩散，敌方全体速度-20%（当前各${foes[0]?foes[0].buff.slow:0}层）。`});}
    // 影缚术式：命中后以影子束缚目标，使其下回合无法行动
    if(dmg>0&&this.hasFlag(att,'shadowBind')&&target.alive){target.buff.stun=Math.max(target.buff.stun,1);ev.push({type:'skill',text:`【影缚术式】${target.name} 被影子束缚，下回合无法行动！`});}
    // 音波操术：25%概率使目标眩晕
    if(dmg>0&&this.hasFlag(att,'sonic')&&target.alive&&Math.random()<0.25){target.buff.stun=Math.max(target.buff.stun,1);ev.push({type:'skill',text:`【音波操术】${target.name} 被音波震晕，下回合无法行动！`});}
    if(att.isPlayer&&att.hp<=0)this.guardPlayerDeath(ev);
    this.afterStrike(ev);
  }
  /** 单独禁区：为同阵营全体队友（不含施法者自身）全属性提升 ratio，可叠加 */
  boostTeam(att,ratio,ev,tag){
    const mates=this.alive(att.side).filter(u=>u!==att);
    mates.forEach(u=>{
      const f=1+ratio;
      u.maxHp=Math.round(u.maxHp*f);u.hp=Math.round(u.hp*f);
      u.maxCp=Math.round(u.maxCp*f);u.cp=Math.round(u.cp*f);
      u.melee=u.melee.map(v=>Math.round(v*f));u.eff=u.eff.map(v=>Math.round(v*f));
      u.ctl=Math.round((u.ctl||0)*f);
    });
    ev.push({type:'skill',text:`【${tag}】${att.isPlayer?'你':att.name} 为 ${mates.length} 名全体队友全属性 +${Math.round(ratio*100)}%（可叠加）。`});
  }
  meleeBonus(att){ // 近战附加：刍灵eff50/无为eff100/鬼臂eff10/火灾eff80/狗颚爪eff30
    let b=0,e=rand(att.eff[0],att.eff[1]);
    if(this.hasFlag(att,'straw'))b+=e*.50;
    if(this.hasFlag(att,'idleTrans'))b+=e*1.0;
    if(this.hasFlag(att,'arms'))b+=e*.10;
    if(this.hasFlag(att,'fire'))b+=e*.80;
    if(this.hasFlag(att,'jawClaw'))b+=e*.30;
    return b;
  }
  techBonus(att){ // 咒术附加：无为=体术100
    if(this.hasFlag(att,'idleTrans'))return rand(att.melee[0],att.melee[1])*1.0;
    return 0;
  }
  afterStrike(ev){this.checkEnd(ev);}
  pickMove(flag){const arr=TECH_MOVE[flag];return arr?arr[rand(0,arr.length-1)]:'咒力打击';}
  castDomain(att,ev,forceExtra){
    if(!att.canDomain)return false;
    const hasExtra=!!(att.extraTech&&att.extraTech.domain);
    const bothUsed=!!(att.domainUsed&&(!hasExtra||att.extraDomainUsed));
    // 两门领域都展开后进入熔断冷却；有反转者冷却归零时两门领域同时重铸
    if(bothUsed&&(att.domainCd||0)>0){
      if(att.isPlayer)ev.push({type:'info',text:att.reverse?'【正在修复领域熔断中】两门领域都已展开，反转术式正在重铸——再间隔一次自身行动即可再次展开。':'【正在领域熔断中】两门领域都已展开，本场已无法再次展开。'});
      return false;
    }
    if(bothUsed&&(att.domainCd||0)===0&&att.reverse){att.domainUsed=0;att.extraDomainUsed=false;}
    // 精确选择本次要展开的领域：forceExtra=true 展开第二术式领域，否则主领域
    let useExtra=false,dName=null;
    if(forceExtra){
      if(!hasExtra||att.extraDomainUsed){
        if(att.isPlayer)ev.push({type:'info',text:hasExtra?'【副领域已展开/熔断中】该领域正在冷却，暂无法再次展开。':'你没有第二门术式的领域。'});
        return false;
      }
      useExtra=true;dName=att.extraTech.domain;
    }else{
      if(att.domainUsed){
        if(att.isPlayer)ev.push({type:'info',text:hasExtra?'【主领域已展开】可点击另一门领域按钮展开副领域，或等待反转重铸。':'【主领域熔断中】本场已展开过领域。'});
        return false;
      }
      dName=att.domainName;
    }
    const raw=(att.skills&&att.skills.sixEyes||att.buff.blueMoon>0)?0:Math.round(att.maxCp*0.30);
    const cost=this.cpCost(att,raw);
    if(att.cp<cost){if(att.isPlayer)ev.push({type:'info',text:'咒力不足以展开领域（需30%咒力上限）。'});return false;}
    att.cp-=cost;
    if(useExtra)att.extraDomainUsed=true;else att.domainUsed=1;
    const bothUsedNow=!!(att.domainUsed&&(!hasExtra||att.extraDomainUsed));
    att.domainCd=bothUsedNow?(att.reverse?2:9999):0; // 两门都用完才进入熔断；只开一门时另一门仍可随时展开
    // 单独禁区·全智之星：增益型领域——耗50%咒力，全体队友全属性+100%，不造成伤害
    if(this.hasFlag(att,'soloZone')){
      ev.push({type:'domain',domainName:dName,actorName:att.name,side:att.side,isPlayer:att.isPlayer,text:`✦✦ ${att.name} 展开增益领域【${dName}】——全体队友全属性 +100%！ ✦✦`});
      this.boostTeam(att,1.0,ev,'全智之星领域');this.checkEnd(ev);return true;
    }
    const avg=(att.eff[0]+att.eff[1])/2;
    const dmg=Math.round(avg*6+att.maxCp*0.06);
    // 天逆鉾：对方阵营只要有持有者存活，本次展开的必中领域被当场无效化、无法造成伤害
    const foeSide=att.side==='enemy'?'ally':'enemy';
    const ama=this.alive(foeSide).find(x=>x.skills&&x.skills.tools&&x.skills.tools.ama);
    if(ama){
      ev.push({type:'domain',domainName:dName,actorName:att.name,side:att.side,isPlayer:att.isPlayer,text:`✦✦ ${att.name} 展开领域【${dName}】—— ✦✦`});
      ev.push({type:'skillcut',actorName:ama.name,text:'领域被天逆鉾破坏了'});
      ev.push({type:'domain',text:`【领域被天逆鉾破坏了】${ama.name} 手中的天逆鉾强制无效化术式，${att.name} 的必中领域未能造成任何伤害！`});
      this.checkEnd(ev);return true;
    }
    if(att.side==='enemy'){
      ev.push({type:'domain',domainName:dName,actorName:att.name,side:att.side,isPlayer:att.isPlayer,text:`✦✦ ${att.name} 展开领域【${dName}】——必中必杀，无处可逃！ ✦✦`});
      this.alive('ally').forEach(a=>{a.buff.vuln=Math.max(a.buff.vuln,3);this.dealDamage(att,a,att.isPlayer?dmg:Math.round(avg*3.5),1,'domain',ev,`${dName}·必中`,false,true);});
    }else{
      ev.push({type:'domain',domainName:dName,actorName:att.name,side:att.side,isPlayer:att.isPlayer,text:`✦✦ ${att.name} 展开领域【${dName}】——必中必杀，敌方全体笼罩！ ✦✦`});
      this.alive('enemy').forEach(e=>{e.buff.vuln=Math.max(e.buff.vuln,3);this.dealDamage(att,e,att.isPlayer?dmg:Math.round(avg*5),1,'domain',ev,`${dName}·必中`,false,true);});
    }
    this.checkEnd(ev);
    return true;
  }
  /** 极之番（生得术式终极奥义，熟练度300%领悟）：耗50%咒力上限，对敌全体造成效率500%伤害，释放后回满自身血；一场一次 */
  castUltimate(att,ev){
    if(!att.canUlt||att.ultUsed)return false;
    const raw=(att.skills&&att.skills.sixEyes||att.buff.blueMoon>0)?0:Math.round(att.maxCp*0.50);
    const cost=this.cpCost(att,raw);
    if(att.cp<cost){if(att.isPlayer)ev.push({type:'info',text:'咒力不足以释放极之番（需50%咒力上限）。'});return false;}
    att.cp-=cost;att.ultUsed=true;
    const avg=(att.eff[0]+att.eff[1])/2,dmg=Math.round(avg*5);
    const tName=att.techName||att.name;
    ev.push({type:'ultcut',actorName:att.isPlayer?'你':att.name,text:`极之番 · ${tName}`});
    const foes=att.side==='enemy'?this.alive('ally'):this.alive('enemy');
    foes.forEach(t=>this.dealDamage(att,t,dmg,1,'tech',ev,`极之番·${tName}`,false,false));
    const heal=Math.round(att.maxHp-att.hp);att.hp=att.maxHp;
    if(heal>0)ev.push({type:'heal',from:att.name,text:`${att.isPlayer?'你':att.name} 释放极之番后生命全部恢复（+${heal}）。`,heal});
    this.checkEnd(ev);
    return true;
  }
  dealDamage(att,tar,base,mult,kind,ev,label,flash,ignoreImmune){
    if(!tar.alive)return 0;
    let dmg=base*mult*randF(0.9,1.1);
    dmg*=(1+0.10*Math.floor(this.actionsTotal/15)); // 战意升温
    if(tar.buff.vuln>0)dmg*=1.30;
    if(att.buff&&att.buff.seal>0)dmg*=0.8;
    if(tar.buff.defend)dmg*=0.5;
    // 本地对战：领域伤害降低50%
    if(this.cfg&&this.cfg.versus&&kind==='domain')dmg*=0.5;
    // —— 苍月：锁定生命期间，任何来源的伤害都无法扣血（含领域/真伤）——
    if((tar.buff.blueMoon||0)>0){ev.push({type:'skill',text:`${tar.name}【苍月·天上天下唯我独尊】生命被锁定，${label} 无法造成损伤。`});return 0;}
    // —— 术式免疫 / 闪避（领域与空间斩无视）——
    if(!ignoreImmune&&kind!=='domain'){
      if(this.hasFlag(tar,'limitless')){ev.push({type:'skill',text:`${tar.name} 的【无下限·无穷】将 ${label} 完全化解（免疫非领域攻击）。`});return 0;}
      if(this.hasFlag(tar,'requiem')){ev.push({type:'skill',text:`${tar.name} 的【黄金体验镇魂曲】令 ${label} 归零无效。`});return 0;}
      if(this.hasFlag(tar,'swap')&&tar.ctl>att.ctl){ev.push({type:'skill',text:`${tar.name}【不义游戏】操控占优，闪避了 ${label}！`});return 0;}
      if(this.hasFlag(tar,'sky')&&kind==='melee'){ev.push({type:'skill',text:`${tar.name}【天空术式】扭曲空间，${label}（近战）伤害为0。`});return 0;}
      // 念写：30%概率完全闪避，闪避后下次攻击必暴击
      if(this.hasFlag(tar,'foresight')&&Math.random()<0.30){tar.buff.foresightCrit=true;ev.push({type:'skill',text:`${tar.name}【念写·未来视】预判了 ${label}，完全闪避！下次攻击必暴击。`});return 0;}
    }
    // —— 减伤类（钢铁之躯-40%；铁壁按血量比例；命之契防御契约-30%）——
    if(this.hasFlag(tar,'ironBody'))dmg*=0.60;
    if(this.hasFlag(tar,'ironWall')){const ratio=Math.max(0,tar.hp/tar.maxHp);dmg*=(1-0.50*ratio);} // 满血-50%，空血-0%
    if(tar.buff.fateType==='def')dmg*=0.70;
    // —— 魔虚罗·适应：每次承受某类攻击，该类后续按 adaptRate 递减（默认20%，完全适应体40%）——
    if(tar.skills&&tar.skills.adapt&&!ignoreImmune){
      const ar=tar.skills.adaptRate||0.20;
      if(kind==='melee'){dmg*=Math.max(0,1-ar*tar.buff.adaptM);tar.buff.adaptM++;}
      if(kind==='tech'){dmg*=Math.max(0,1-ar*tar.buff.adaptT);tar.buff.adaptT++;}
    }
    // —— 空间吞噬：承受50%伤害，另50%被吞噬转化为自身生命恢复（需有咒力维持）——
    if(this.hasFlag(tar,'spaceDevour')&&tar.cp>0){
      const swallowed=Math.round(dmg*0.5);dmg=Math.max(1,dmg-swallowed);
      const heal=Math.min(swallowed,tar.maxHp-tar.hp);
      if(heal>0){tar.hp+=heal;ev.push({type:'heal',from:tar.name,text:`【空间吞噬】${tar.name} 吞噬 ${swallowed} 点攻击伤害并转化为生命（+${heal}）。`,heal});}
    }
    dmg=Math.max(1,Math.round(dmg));
    if(flash){
      if(att.isPlayer){
        this.cfg.player.flashCount=(this.cfg.player.flashCount||0)+1;
        this.cfg.player.statBoost=+((this.cfg.player.statBoost||1)*1.10).toFixed(4);
        const P=this.cfg.player;
        P.maxHp=Math.round(P.maxHp*1.10);P.maxCp=Math.round(P.maxCp*1.10);P.ctl=Math.round((P.ctl||0)*1.10);
        P.melee=P.melee.map(v=>Math.round(v*1.10));P.eff=P.eff.map(v=>Math.round(v*1.10));
        att.maxHp=Math.round(att.maxHp*1.10);att.maxCp=Math.round(att.maxCp*1.10);att.ctl=Math.round((att.ctl||0)*1.10);
        att.melee=att.melee.map(v=>Math.round(v*1.10));att.eff=att.eff.map(v=>Math.round(v*1.10));
      }
      ev.push({type:'flash',text:`★ 黑 闪 ★ 空间被一击扭曲！本次伤害×10${att.isPlayer?'，且你全属性永久+10%':''}！`});
    }
    tar.hp-=dmg;
    ev.push({type:flash?'flash':'hit',from:att.name,to:tar.name,text:`${label} → 命中 ${tar.name}，造成 ${dmg} 点伤害。`,dmg});
    // 奇迹：死亡时耗30%咒力复活并回满
    if(tar.hp<=0&&tar.isPlayer&&this.hasFlag(tar,'miracle')){
      const need=this.cpCost(tar,Math.round(tar.maxCp*0.30));
      if(tar.cp>=need){tar.cp-=need;tar.hp=tar.maxHp;tar.buff.miracle=(tar.buff.miracle||0)+1;ev.push({type:'heal',text:`【奇迹】消耗30%咒力（-${need}），伤害转化再生，恢复100%生命！`,heal:tar.maxHp});return dmg;}
      ev.push({type:'info',text:`【奇迹】咒力不足以驱动再生（需${need}）……`});
    }
    if(tar.hp<=0&&tar.isPlayer)this.guardPlayerDeath(ev); // 死而替生/奇迹等：致死瞬间先尝试守护，避免被直接 kill
    if(tar.hp<=0)this.kill(tar,ev,att);
    return dmg;
  }
  kill(u,ev,killer){
    if(!u.alive)return;u.hp=0;u.alive=false;
    ev.push({type:'die',name:u.name,text:`${u.side==='enemy'?'◆':'◇'} ${u.name} 被击溃。`});
    const snap={name:u.name,maxHp:u.maxHp,maxCp:u.maxCp,melee:u.melee.slice(),eff:u.eff.slice(),li:u.li};
    // 本场池（供 NPC 羂索等召唤）
    if(u.side==='enemy'&&!u.summonTag&&this.killedPool.length<12)this.killedPool.push(snap);
    // 玩家持有咒灵操术/降灵术时，永久吸收（数值固定、按名去重、上限24）
    const P=this.cfg.player;
    if(u.side==='enemy'&&!u.summonTag&&killer&&killer.side==='ally'&&P&&
       (P.technique.flag==='spiritControl'||P.technique.flag==='seance')){
      if(!P.absorbed.some(x=>x.name===snap.name)&&P.absorbed.length<24){P.absorbed.push(snap);
        if(P.technique.flag==='spiritControl')ev.push({type:'skill',text:`【咒灵操术】吸收了被击溃的【${snap.name}】（数值固定，日后可召唤为式神）。`});}
    }
  }
  pickEnemyTarget(){
    // 母灵式神强嘲讽：100%成为第一攻击目标
    const taunt=this.alive('enemy').filter(u=>u.taunt);
    if(taunt.length)return taunt[rand(0,taunt.length-1)];
    // 傀儡嘲讽：对方傀儡在场时优先攻击傀儡
    const pups=this.alive('enemy').filter(u=>u.summonTag==='傀儡');
    const es=this.alive('enemy');if(!es.length)return null;
    if(pups.length&&Math.random()<0.8)return pups[rand(0,pups.length-1)];
    return es.sort((a,b)=>a.hp-b.hp)[0];
  }
  pickAllyTarget(){
    // 母灵式神强嘲讽：100%成为第一攻击目标
    const taunt=this.alive('ally').filter(u=>u.taunt);
    if(taunt.length)return taunt[rand(0,taunt.length-1)];
    const pups=this.alive('ally').filter(u=>u.summonTag==='傀儡');
    const mates=this.alive('ally').filter(u=>!u.isPlayer);const p=this.player;
    if(pups.length&&Math.random()<0.8)return pups[rand(0,pups.length-1)]; // 傀儡优先吸引火力
    if(!mates.length)return p.alive?p:null;
    const guards=mates.filter(m=>m.li>=(this._actorLi??0)&&!m.summonTag);
    if(p.alive){
      if(guards.length){if(Math.random()<0.9)return guards[rand(0,guards.length-1)];
        const o=mates.filter(m=>!guards.includes(m));if(o.length)return o[rand(0,o.length-1)];
        return Math.random()<0.5?p:guards[rand(0,guards.length-1)];}
      if(Math.random()<0.55)return p;return mates[rand(0,mates.length-1)];
    }
    return mates[rand(0,mates.length-1)];
  }
  /* ---------- NPC AI ---------- */
  npcAct(u,ev){
    this._actorLi=u.li;
    // 特殊蓄力技：五条悟虚式茈 / 宿傩空间斩
    if(this.npcChargeSkill(u,ev))return;
    // 极之番：残血（<40%）且蓝够半管时，一场一次的终极爆发
    if(u.canUlt&&!u.ultUsed&&u.hp<u.maxHp*0.40&&((u.skills&&u.skills.sixEyes)||u.cp>=u.maxCp*0.5)){if(this.castUltimate(u,ev))return;}
    if(u.canDomain&&(u.domainCd||0)<=0){
      let want=false;
      if(u.side==='enemy'){
        const ac=u.buff.actCount||0;
        // 敌方领域欲望：第二次自身行动起即积极展开（不再要求残血才开），血线越低越坚决，行动越多次越必开
        if(ac>=1){const drive=u.hp<u.maxHp*0.5?0.95:(ac>=3?0.9:0.6);want=Math.random()<drive;}
      }else want=(u.buff.actCount>=2);
      if(want){
        // AI 双领域：主领域已展开且副领域可用时，改开副领域，避免主领域按钮点空
        const hasExtra=!!(u.extraTech&&u.extraTech.domain);
        const useExtra=!!(u.domainUsed&&hasExtra&&!u.extraDomainUsed);
        this.castDomain(u,ev,useExtra);return;
      }
    }
    // 专属技能（五条悟苍赫 / 宿傩解捌开灶 / 九十九星之怒）
    if(this.npcSignatureSkill(u,ev))return;
    const target=u.side==='enemy'?this.pickAllyTarget():this.pickEnemyTarget();
    if(!target){ev.push({type:'info',text:`${u.name} 失去目标。`});return;}
    const cost=this.techCost(u);
    const allyMult=u.side==='ally'?(1+(this.cfg.player.allyBoost||0)):1;
    // 万里锁：持有者的攻击对敌方全体生效（天逆鉾破免疫在 performStrike 内处理）
    const chain=u.skills&&u.skills.tools&&u.skills.tools.chain;
    const foesAll=u.side==='enemy'?this.alive('ally'):this.alive('enemy');
    const list=chain?foesAll:[target];
    const lockBlue=u.buff.blueMoon>0; // 苍月锁蓝不耗咒力
    const pureMelee=!u.flag&&u.eff[1]<=1; // 无生得术式、咒效≈0（如伏黑甚尔）：纯体术型，稳定近战
    if(!pureMelee&&(lockBlue||u.cp>=cost)&&Math.random()<0.72){if(!lockBlue)u.cp-=cost;this._allyMult=allyMult;list.forEach(t=>{if(t&&t.alive)this.performStrike(u,t,'tech',ev);});this._allyMult=1;}
    else{this._allyMult=allyMult;list.forEach(t=>{if(t&&t.alive)this.performStrike(u,t,'melee',ev);});this._allyMult=1;}
  }
  /** NPC 专属技能（金色大字）：五条悟苍/赫；宿傩解/捌/开/灶；九十九由基星之怒/质量弹。返回 true=本回合用了专属技 */
  npcSignatureSkill(u,ev){
    const isSukuna=u.name.includes('宿傩'),isGojo=u.name==='五条悟',isTsukumo=u.name==='九十九由基';
    if(!isSukuna&&!isGojo&&!isTsukumo)return false;
    const avg=(u.eff[0]+u.eff[1])/2;
    const foes=u.side==='enemy'?this.alive('ally'):this.alive('enemy');
    if(!foes.length)return false;
    const singleT=u.side==='enemy'?this.pickAllyTarget():this.pickEnemyTarget();
    const hit=(scope,mult,label,fixed)=>{
      ev.push({type:'skillcut',actorName:u.name,text:label});
      const list=scope==='all'?foes:[singleT];
      list.forEach(t=>{if(t&&t.alive)this.dealDamage(u,t,fixed!=null?fixed:Math.round(avg*mult),1,'tech',ev,label,false,false);});
      this.afterStrike(ev);
    };
    // 九十九由基·星之怒：耗99%「当前血量」，给予敌方全体固定1000000毁灭伤害（血线充足且多敌时低概率）
    if(isTsukumo&&u.hp>u.maxHp*0.3&&foes.length>=2&&Math.random()<0.15){
      const cost=Math.round(u.hp*0.99);u.hp-=cost;
      ev.push({type:'hit',text:`九十九由基 燃烧99%生命（-${cost}）凝聚【星之怒】。`,dmg:cost});
      hit('all',0,'九十九由基·星之怒',1000000);return true;
    }
    if(Math.random()<0.38){
      if(isGojo){const r=Math.random();
        if(r<0.5)hit('all',1.5,'五条悟·苍（引力·全体）');else hit('one',2.0,'五条悟·赫（斥力·单体）');return true;}
      if(isSukuna){const r=Math.random();
        if(r<0.28)hit('all',1.2,'宿傩·解（无形斩·全体）');
        else if(r<0.56)hit('one',1.2,'宿傩·捌（必中斩·单体）');
        else if(r<0.80)hit('all',2.0,'宿傩·开（火焰·全体）');
        else hit('one',2.5,'宿傩·灶（炽焰·单体）');return true;}
      if(isTsukumo){hit('one',2.2,'九十九由基·质量弹');return true;}
    }
    return false;
  }
  /** 蓄力特殊技，返回 true 表示本回合用于蓄力/释放 */
  npcChargeSkill(u,ev){
    // 五条悟·虚式茈：蓄力一回合，下回合造成效率300%伤害
    if(u.skills.charge){
      if(u.buff.charge){
        u.buff.charge=false;const t=u.side==='enemy'?this.pickAllyTarget():this.pickEnemyTarget();
        if(t){ev.push({type:'skillcut',actorName:u.name,text:'五条悟 · 虚式「茈」'});const d=Math.round((u.eff[0]+u.eff[1])/2*u.skills.charge);this.dealDamage(u,t,d,1,'tech',ev,'五条悟·虚式「茈」',false,true);this.afterStrike(ev);return true;}
      }else if(u.hp<u.maxHp*0.8&&u.cp>=u.maxCp*0.1){u.buff.charge=true;ev.push({type:'info',text:`${u.name} 开始蓄力【虚式·茈】，下一击将造成恐怖伤害！`});return true;}
    }
    // 宿傩·空间斩（chargeSlash：蓄力一回合→固定真伤，无视术式豁免）
    if(u.skills.chargeSlash){
      if(u.buff.charge){u.buff.charge=false;const t=u.side==='enemy'?this.pickAllyTarget():this.pickEnemyTarget();
        if(t){ev.push({type:'skillcut',actorName:u.name,text:u.name+' · 空间斩'});const d=u.skills.chargeSlash.dmg;this.dealDamage(u,t,d,1,'tech',ev,u.name+'·空间斩（无法豁免）',false,true);this.afterStrike(ev);return true;}}
      else if(u.hp<u.maxHp*0.7&&!u.domainUsed){u.buff.charge=true;ev.push({type:'info',text:`${u.name} 开始凝聚【空间斩】，下一回合将落下无法被术式豁免的一击！`});return true;}
    }
    // 十影宿傩·空间斩：第 after 次行动后发动固定真伤
    if(u.skills.spaceSlash&&u.buff.actCount===u.skills.spaceSlash.after){
      const t=u.side==='enemy'?this.pickAllyTarget():this.pickEnemyTarget();
      if(t){ev.push({type:'skillcut',actorName:u.name,text:'十影宿傩 · 空间斩'});this.dealDamage(u,t,u.skills.spaceSlash.dmg,1,'tech',ev,'十影宿傩·空间斩（无法豁免）',false,true);this.afterStrike(ev);return true;}
    }
    return false;
  }
  guardPlayerDeath(ev){
    const p=this.player,P=this.cfg.player;
    if(p.hp>0||!p.alive)return;
    if(this.hasFlag(p,'reviveWin')&&!p.buff.saved){
      p.buff.saved=true;p.alive=true;p.hp=Math.round(p.maxHp*0.50);p.cp=Math.round(p.maxCp*0.50);
      ev.push({type:'skillcut',actorName:'你',text:'死而替生 · 替死夺式'});
      if(!P.stolen)P.stolen=[];if(!P.stolenTechs)P.stolenTechs=[];
      // 被击杀即胜：击溃所有敌人，并夺取其生得术式（多术式并存、各自独立熟练度）
      this.alive('enemy').forEach(e=>{
        if(e.flag&&!P.stolenTechs.some(t=>t.flag===e.flag)){
          P.stolenTechs.push({name:e.techName,flag:e.flag,domain:e.domainName,
            flags:(e.flags||[]).filter(f=>f!==e.flag),prof:30});
          if(!p.flags.includes(e.flag))p.flags.push(e.flag); // 当场立即生效
          P.notes.push(`死而替生，夺取了【${e.name}】的术式「${e.techName}」`);
          ev.push({type:'skill',text:`你夺取了【${e.name}】的生得术式「${e.techName}」（独立熟练度30%起）。`});
        }
        if(!P.stolen.includes(e.name))P.stolen.push(e.name);
        this.kill(e,ev);
      });
    }
  }
  /** 鏖战硬上限裁决：按双方存活单位的「剩余血量占比之和」比较，高者胜；保证有限步内必分胜负、绝不平局卡死 */
  forceSettle(ev){
    const score=side=>this.alive(side).reduce((s,u)=>s+Math.max(0,u.hp)/u.maxHp,0);
    const a=score('ally'),e=score('enemy');
    const win=a>=e;
    ev.push({type:'info',text:`鏖战已久，双方皆至强弩之末——按残存战力最终裁决，${win?'我方险胜！':'敌方占优，我方惜败。'}`});
    this.alive(win?'enemy':'ally').forEach(u=>{if(u.isPlayer)return;this.kill(u,ev);});
    // 判负方若含玩家，也让其倒下（不触发死而替生，这是裁决而非被击杀）
    if(!win){const p=this.player;if(p.alive){p.alive=false;p.hp=0;}}
    this.ended=true;this.result=win?'win':'lose';
    ev.push({type:'info',text:win?'敌方全部被击溃，战斗胜利！':'你与队友全部倒下——本场战斗战败。'});
    return this.pack(ev);
  }
  /** 玩家主动撤退：本场按战败(flee)结算，交由剧情/狩猎规则安全收尾 */
  escapeChance(){return Rules.escapeChance(this.player,this.alive("enemy"),u=>this.effSpeed(u));}
  flee(forced){
    const ev=this.events;this.events=[];
    if(this.ended)return this.pack(ev);
    if(!this.awaitingPlayer||!this.player.alive)return {events:ev,ended:false,retryInput:false};
    const chance=this.escapeChance();this.awaitingPlayer=false;
    const success=forced===undefined?Math.random()<chance:!!forced;
    if(success){this.ended=true;this.result="flee";ev.push({type:"info",text:"撤退成功！你脱离了战场（成功率 "+Math.round(chance*100)+"%）。"});}
    else{ev.push({type:"info",text:"撤退失败（成功率 "+Math.round(chance*100)+"%），消耗本次行动。"});this.afterAction(this.player,ev);}
    return this.pack(ev);
  }
  checkEnd(ev){
    if(this.ended){this.settleAmber(ev);return true;}
    // 玩家倒下：先尝试死而替生；若仍倒下，只要还有存活队友，战斗继续（队友代战），不直接判败
    if(!this.player.alive)this.guardPlayerDeath(ev);
    if(this.alive('enemy').length===0){this.ended=true;this.result='win';ev.push({type:'info',text:'敌方全部被击溃，战斗胜利！'});this.settleAmber(ev);return true;}
    if(this.alive('ally').length===0){this.ended=true;this.result='lose';ev.push({type:'info',text:'你与队友全部倒下——本场战斗战败。'});this.settleAmber(ev);return true;}
    if(!this.player.alive&&!this._downNotified){this._downNotified=true;ev.push({type:'info',text:'你倒下了——队友仍在战斗，继续为你而战！'});}
    return false;
  }
}

/* ============================ VI. 剧情引擎：全部剧情节点（严格按设定录入） ============================ */
/* 等级索引：四级0 三级1 准二级2 二级3 准一级4 一级5 特别一级6 准特级7 弱特级8 标准特级9 强特级10 超特级11
 * stage: {enemies,allies,intro,lose: 'die'|'continue'|'next', winNote}
 *   die=战败即死亡结局；continue=战败不死继续剧情；next=战败进入下一组 stage */
/* ================== 具名角色精确五维面板（严格按设定录入） ==================
 * spec = [咒力总量cp, 体术me, 体质hp, 咒力操控ctl, 咒力效率eff, 生得术式flag, 选项opt]
 *   前五项为属性等级索引（0四级…11超特级，可负）；hp 项为 HP_TIERS 索引，或 {f:固定血量}
 *   opt: rev=会反转术式 bf=会黑闪 dom=已会领域；sixEyes六眼(耗蓝0) charge=虚式茈效率倍率
 *        adapt=适应 regen=每回合回血比 summonMakora=开局召唤魔虚罗
 *        spaceSlash={after:n,dmg:x}=第n次行动后固定真伤  chargeSlash={dmg}=蓄力一回合固定真伤
 *        flags=双术式
 * 匹配优先级：名字#场景等级 → 名字 → 按 li 推导（泛用咒灵） */
const NPC_CHARS={
 '五条悟#11':[11,11,12,11,11,'limitless',{rev:1,bf:1,dom:1,sixEyes:1,charge:5.0}],
 '1指受肉宿傩#7':[7,7,7,7,7,'cleave',{rev:1,bf:0,dom:1}],
 '2指宿傩#8':[8,8,8,8,8,'cleave',{rev:1,bf:0,dom:1}],
 '伏黑惠#3':[2,1,4,2,3,'shadows',{rev:0,bf:0,dom:0}],
 '伏黑惠#4':[4,3,5,3,4,'shadows',{rev:0,bf:0,dom:1}],
 '钉崎野蔷薇#3':[3,2,3,3,3,'straw',{rev:0,bf:0,dom:0}],
 '钉崎野蔷薇#4':[4,5,5,4,5,'straw',{rev:0,bf:1,dom:0}],
 '咒胎怠天#7':[6,6,7,5,7,'cleave',{rev:1,bf:0,dom:0}],
 '漏壶#10':[9,8,9,10,10,'fire',{rev:1,bf:0,dom:1}],
 '顺平（二级变化人·精英）#3':[2,2,2,2,2,'moon',{rev:0,bf:0,dom:0}],
 '真人#8':[9,4,9,7,6,'idleTrans',{rev:1,bf:0,dom:1}],
 '真人#9':[9,7,8,9,9,'idleTrans',{rev:1,bf:1,dom:1}],
 '七海建人#6':[5,6,6,4,5,'ratio',{rev:0,bf:1,dom:0}],
 '东堂葵#6':[6,6,7,9,7,'swap',{rev:0,bf:1,dom:0}],
 '东堂葵#7':[8,8,8,10,8,'swap',{rev:0,bf:1,dom:0}],
 '花御#9':[8,7,9,8,9,'gu',{rev:1,bf:0,dom:1}],
 '禅院真希#0':[0,4,6,0,0,null,{rev:0,bf:0,dom:0}],
 '真希#4':[4,4,5,4,4,null,{rev:0,bf:0,dom:0}],
 '虎杖悠仁#5':[8,5,10,4,5,'cleave',{rev:0,bf:1,dom:0}],
 '虎杖悠仁#6':[9,6,10,6,6,'cleave',{rev:0,bf:1,dom:0}],
 '虎杖悠仁#7':[9,8,8,6,6,'cleave',{rev:0,bf:1,dom:0}],
 '虎杖悠仁#8':[9,10,{f:200000},8,9,'cleave',{rev:0,bf:1,dom:0}],
 '虎杖悠仁#10':[11,10,{f:300000},10,10,'cleave',{rev:1,bf:1,dom:1,flags:['blood']}],
 '血涂#8':[8,5,7,4,6,'rot',{rev:0,bf:0,dom:0}],
 '坏相#8':[7,6,6,5,7,'rot',{rev:0,bf:0,dom:0}],
 '胀相#9':[9,7,9,8,7,'blood',{rev:1,bf:0,dom:0}],
 '羂索#10':[10,8,9,9,10,'spiritControl',{rev:1,bf:0,dom:1}],
 '蝗虫#8':[7,8,7,7,7,null,{rev:1,bf:0,dom:0}],
 '魔虚罗#10':[10,9,10,4,4,null,{rev:1,bf:0,dom:0,adapt:1,regen:0.9}],
 '16指宿傩#10':[10,10,10,10,10,'cleave',{rev:1,bf:0,dom:1}],
 '陀艮#8':[8,7,8,7,8,'cannon',{rev:1,bf:0,dom:1}],
 '禅院家主#6':[7,6,6,5,6,'projection',{rev:0,bf:0,dom:0}],
 '伏黑甚尔#8':[0,10,11,0,0,null,{rev:0,bf:0,dom:0}],
 '里梅#8':[8,6,6,8,8,'cannon',{rev:1,bf:0,dom:1}],
 '九十九由基#9':[9,5,9,10,10,'mass',{rev:1,bf:1,dom:1}],
 '多鲁布#7':[7,5,6,7,6,'arms',{rev:0,bf:0,dom:1}],
 '黑沐死#8':[8,6,8,7,7,null,{rev:1,bf:0,dom:1}],
 '乌璐亨子#8':[8,4,7,8,8,'sky',{rev:0,bf:0,dom:1}],
 '石流龙#9':[10,6,9,8,10,'cannon',{rev:0,bf:0,dom:1}],
 '乙骨忧太#10':[11,8,10,10,10,'copy',{rev:1,bf:1,dom:1}],
 '日车宽见#8':[7,4,6,8,8,'judge',{rev:1,bf:0,dom:1}],
 '鹿紫云一#9':[9,9,9,8,9,'amber',{rev:0,bf:0,dom:0}],
 '秤金次#8':[7,7,9,8,7,'cannon',{rev:1,bf:0,dom:1}],
 '禅院直哉#9':[9,8,9,7,8,'projection',{rev:1,bf:0,dom:1}],
  '禅院直哉（人类）#5':[5,5,5,5,5,'projection',{rev:0,bf:0,dom:0}],
 '禅院真希·天裕暴君#8':[0,10,11,0,0,null,{rev:0,bf:0,dom:0}],
 '加茂宪纪#5':[4,4,6,6,5,'blood',{rev:0,bf:0,dom:0}],
 '十影宿傩#11':[11,11,{f:1300000},11,11,'cleave',{rev:1,bf:1,dom:1,flags:['shadows'],summonMakora:1,spaceSlash:{after:5,dmg:500000}}],
 '一削·神武真身宿傩#10':[11,10,{f:500000},10,10,'cleave',{rev:1,bf:1,dom:1,chargeSlash:{dmg:300000}}],
 '二削·神武真身宿傩#10':[10,10,{f:400000},10,10,'cleave',{rev:1,bf:1,dom:1,chargeSlash:{dmg:200000}}],
 '三削·神武真身宿傩#10':[10,10,{f:300000},10,10,'cleave',{rev:1,bf:1,dom:1,chargeSlash:{dmg:100000}}],
 '四削·神武真身宿傩#9':[9,10,{f:200000},9,10,'cleave',{rev:1,bf:1,dom:1,chargeSlash:{dmg:80000}}],
 '五削·神武真身宿傩#9':[9,10,{f:100000},9,10,'cleave',{rev:1,bf:1,dom:1,chargeSlash:{dmg:50000}}],
 // —— 怀玉篇（2006）专属面板 ——（spec 顺序：咒力/体术/体质/咒操/咒效）
 '生恶蠕虫#4':[5,3,4,4,4,null,{rev:0,bf:0,dom:1}],
 '庵歌姬#3':[3,2,4,4,2,'soloZone',{rev:0,bf:0,dom:0}],
 '17岁·五条悟#7':[9,4,6,10,7,'limitless',{rev:0,bf:1,dom:0}],
 '17岁·夏油杰#6':[7,6,5,7,6,'spiritControl',{rev:0,bf:1,dom:0}],
 'Q战斗员·科昆#5':[4,4,5,5,5,'cannon',{rev:0,bf:0,dom:0}],
 'Q的王牌·拜尔#6':[6,5,6,5,6,'cannon',{rev:0,bf:0,dom:0}],
 '拜星教雇佣的老头#5':[5,4,6,5,5,'cannon',{rev:0,bf:0,dom:0}],
 '拜星教雇佣的面罩男#6':[6,6,6,6,5,'cannon',{rev:0,bf:0,dom:0}],
 '伏黑甚尔#9':[0,10,12,0,0,null,{rev:0,bf:0,dom:0,tools:{ama:1,soul:1,cloud:1,chain:1}}],
 '17岁·五条悟·觉醒#10':[10,7,9,10,11,'limitless',{rev:1,bf:1,dom:1,sixEyes:1,charge:3.0}],
 // —— 未来篇（新宿决战数十年后）专属面板 ——（spec 顺序：咒力/体术/体质/咒操/咒效；12龙级~15标准神级）
 '人贩子#4':[5,2,5,4,4,'spaceDevour',{rev:0,bf:0,dom:0}],
 '乙骨犹花#3':[5,2,3,5,2,'jawClaw',{rev:0,bf:0,dom:0}],
 '乙骨真剑#3':[0,4,7,0,0,null,{rev:0,bf:0,dom:0,toolMelee:0.20}],
 '乙骨犹花·魔虚罗#10':[10,11,12,10,10,null,{rev:1,bf:0,dom:0,adapt:1,adaptRate:0.30,regen:1.0,regenCap:0.20}],
 '里香附体·乙骨真剑#10':[0,10,12,0,0,null,{rev:1,bf:0,dom:0,toolMelee:0.20}],
 '武田正树#5':[5,4,5,5,5,'motherSpirit',{rev:0,bf:0,dom:0}],
 '失去意识·马鲁#5':[5,4,5,2,5,'chaosHarmony',{rev:0,bf:0,dom:0}],
 '达布拉#10':[10,10,10,10,10,'massKiller',{rev:0,bf:0,dom:0}],
 '极限解放·达布拉#11':[11,11,11,11,11,'massKiller',{rev:1,bf:0,dom:1}],
 '乙骨犹花·完全适应魔虚罗#11':[11,11,12,11,11,null,{rev:1,bf:0,dom:0,adapt:1,adaptRate:0.40,regen:1.0,regenCap:0.40}],
 '解放·马鲁#6':[6,6,6,6,6,'chaosHarmony',{rev:0,bf:0,dom:0}],
 '奥斯基#6':[5,6,7,5,5,'aperture',{rev:0,bf:0,dom:0}],
 '68·虎杖悠仁#13':[13,14,16,13,14,'cleave',{rev:1,bf:1,dom:1,flags:['blood','limitless'],alwaysFlash:1}],
 '地狱·真人#10':[11,10,12,10,10,'idleTrans',{rev:1,bf:1,dom:1}]
};
function getCharSpec(name,li){return NPC_CHARS[name+'#'+li]||NPC_CHARS[name]||null;}
/** 按属性等级取该档稳定中值（NPC 精确面板用，不再随机±15%） */
function tierMidCp(i){i=clamp(i,-2,15);const r=tierCp(i);return Math.round((r[0]+r[1])/2);}
function tierMidDmg(i){i=clamp(i,-2,15);const r=tierDmg(i);return [Math.max(0,r[0]),Math.max(1,r[1])];}
function tierMidCtl(i){i=clamp(i,-2,15);const r=tierCtl(i);return Math.round((r[0]+r[1])/2);}
function charHp(specHp){if(specHp&&typeof specHp==='object'&&specHp.f)return specHp.f;const idx=clamp(specHp??1,0,HP_TIERS.length-1);return Math.round((HP_TIERS[idx][1][0]+HP_TIERS[idx][1][1])/2);}

const E=(name,li,type)=>({name,li,type:type||'咒灵'});
const STORY={
 3:{chapter:'宿傩受肉虎杖篇',title:'第3天 · 诅咒初现',
    intro:'你穿越后的第3天，异样的咒力气息在夜色中弥漫。一只咒灵拦住了去路——而更深处，寄宿于少年体内的古老诅咒，正在苏醒……',
    stages:[
      {enemies:[E('准二级咒灵',2)],allies:[],lose:'die'},
      {enemies:[E('1指受肉宿傩',7,'受肉体')],allies:[],lose:'next',
       intro:'击败咒灵的瞬间，两面宿傩的手指之力暴走——【1指受肉宿傩】出现在你面前！'},
      {enemies:[E('1指受肉宿傩',7,'受肉体')],allies:[E('五条悟',11,'咒术师'),E('伏黑惠',3,'咒术师')],lose:'continue',
       intro:'千钧一发——超特级咒术师【五条悟】登场，二级咒术师【伏黑惠】并肩而立，再度迎战！'}]},
 10:{chapter:'钉崎野蔷薇登场篇',title:'第10天 · 红发的咒术师',
    intro:'新都厅附近的咒灵事件现场，你与刚从乡下来到东京的红发少女相遇——钉崎野蔷薇加入了你的队伍。',
    stages:[{enemies:[E('二级咒灵',3)],allies:[E('钉崎野蔷薇',3,'咒术师')],lose:'die'}]},
 33:{chapter:'少年院篇',title:'第33天 · 少年院的咒胎',
    intro:'废弃少年院内，特级咒灵「咒胎怠天」盘踞。你与伏黑惠、钉崎野蔷薇一同踏入了这座牢笼……',
    stages:[
      {enemies:[E('咒胎怠天',7)],allies:[E('伏黑惠',3,'咒术师'),E('钉崎野蔷薇',3,'咒术师')],lose:'next'},
      {enemies:[E('咒胎怠天',7)],allies:[E('2指宿傩',8,'受肉体')],lose:'continue',
       intro:'形势急转直下，伏黑惠与钉崎野蔷薇暂时离场；【2指宿傩】现身接手战场！'}]},
 35:{chapter:'幼鱼与逆罚篇',title:'第35天 · 漏壶来袭',
    intro:'电影院中时间被静止——强特级咒灵【漏壶】悍然发动袭击。千钧一发之际，五条悟就在你身边。',
    stages:[{enemies:[E('漏壶',10)],allies:[E('五条悟',11,'咒术师')],lose:'die'}]},
 47:{chapter:'幼鱼与逆罚篇',title:'第47天 · 顺平',
    intro:'被真人利用的少年吉野顺平，以改造人之姿挡在你面前。这是一场你不想打、却不得不打的战斗。',
    stages:[{enemies:[E('顺平（二级变化人·精英）',3,'变化人')],allies:[],lose:'die',
      winQuote:'谢谢你出现在我的生命里，谢谢你……'}]},
 48:{chapter:'幼鱼与逆罚篇',title:'第48天 · 真人',
    intro:'下水道深处，轻视生命的弱特级咒灵【真人】露出笑容。特别一级咒术师七海建人拎着缠满咒力的钝刀与你并肩。',
    stages:[{enemies:[E('真人',8)],allies:[E('七海建人',6,'咒术师')],lose:'die'}]},
 62:{chapter:'京都姐妹校交流会篇',title:'第62天 · 交流会前哨',
    intro:'京都姐妹校交流会期间，咒灵潜入会场。第一波敌人迎面而来。',
    stages:[{enemies:[E('准一级咒灵',4)],allies:[],lose:'die'}]},
 63:{chapter:'京都姐妹校交流会篇',title:'第63天 · 东堂葵',
    intro:'“我叫东堂葵，特别一级咒术师！来，让我看看你的实力！”京都校的猛将向你发起单挑。此战即使败北也不会死亡。',
    stages:[{enemies:[E('东堂葵',6,'咒术师')],allies:[],lose:'continue',noFlip:true,
      winSkill:'blackFlash',winSkillText:'东堂葵认可了你的拳头：“不错嘛！”——在激战中你学会了技能【黑闪】：每次攻击10%概率触发，当次伤害×10，并使全属性永久提升10%。'}]},
 68:{chapter:'京都姐妹校交流会篇',title:'第68天 · 花御来袭',
    intro:'交流会被突袭打断，标准特级咒灵【花御】降临森林。',
    stages:[
      {enemies:[E('花御',9)],allies:[E('伏黑惠',3,'咒术师'),E('禅院真希',0,'咒术师')],lose:'next',
       intro:'第一战：你与伏黑惠、四级咒术师禅院真希联手迎击花御。'},
      {enemies:[E('花御',9)],allies:[E('虎杖悠仁',6,'咒术师'),E('东堂葵',6,'咒术师')],lose:'next',
       intro:'第二战：虎杖悠仁与东堂葵接替上场，黑白两道闪光夹击花御！'},
      {enemies:[E('花御',9)],allies:[E('五条悟',11,'咒术师')],lose:'continue',
       intro:'最终战：五条悟亲自下场——在最强面前，花御已无胜算。'}]},
 78:{chapter:'八十八桥篇',title:'第78天 · 八十八桥',
    intro:'八十八桥下埋藏着咒物的气息。进入战场前，先抽取你将被分配到的战场。',
    wheel:{title:'战场转盘',items:[
      {label:'咒胎战场',battle:{enemies:[E('咒胎怠天',7)],allies:[E('伏黑惠',4,'咒术师')],lose:'die',
        intro:'咒胎战场：你与准一级咒术师伏黑惠一同面对咒胎怠天。'}},
      {label:'血涂与坏相战场',battle:{enemies:[E('血涂',8,'受肉体'),E('坏相',8,'受肉体')],allies:[E('虎杖悠仁',6,'咒术师'),E('钉崎野蔷薇',4,'咒术师')],lose:'die',
        intro:'血涂与坏相战场：九相图的兄弟二人拦路，特别一级的虎杖与准一级的钉崎与你并肩！'}}]}},
 88:{chapter:'涩谷事变',title:'第88天 · 最前线的抉择',
    intro:'10月31日，涩谷。结界内人间地狱。是否与五条悟一起前往最前线？',
    wheel:{title:'抉择转盘',items:[
      {label:'是（30%）',weight:30,battle:{enemies:[E('漏壶',10),E('花御',9),E('胀相',9,'受肉体'),E('羂索',10,'诅咒师')],allies:[E('五条悟',11,'咒术师')],lose:'die',
        intro:'你选择追随五条悟突入最前线——漏壶、花御、胀相、羂索四大强敌同时现身！'}},
      {label:'否（70%）',weight:70,skipText:'你被分配到后方战线，第88天的最前线激战与你擦肩而过（涩谷的天空传来震耳欲聋的轰鸣）。'}]}},
 90:{chapter:'涩谷事变',title:'第90天 · 涩谷八方战场',
    intro:'涩谷全面混战，你被随机分配到八处战场之一。转动转盘决定你的战场。',
    wheel:{title:'第90天战场转盘',items:[
      {label:'蝗虫战场',battle:{enemies:[E('蝗虫',8)],allies:[E('虎杖悠仁',6,'咒术师')],lose:'die',intro:'蝗虫战场：你与特别一级咒术师虎杖悠仁对战弱特级咒灵蝗虫。'}},
      {label:'真人战场',battle:{enemies:[E('真人',9)],allies:[E('虎杖悠仁',6,'咒术师'),E('东堂葵',6,'咒术师')],lose:'die',intro:'真人战场：你与虎杖、东堂联手对战标准特级的真人。'}},
      {label:'魔虚罗战场',battle:{enemies:[E('魔虚罗',10,'式神')],allies:[E('16指宿傩',10,'受肉体')],lose:'die',intro:'魔虚罗战场：强特级式神魔虚罗降临，与你并肩的是强特级受肉体【16指宿傩】。'}},
      {label:'陀艮战场',battle:{enemies:[E('陀艮',8)],allies:[E('伏黑惠',4,'咒术师'),E('七海建人',6,'咒术师'),E('禅院家主',6,'咒术师'),E('真希',4,'咒术师'),E('伏黑甚尔',8,'人类')],lose:'die',intro:'陀艮战场：伏黑惠、七海建人、禅院家主、真希与伏黑甚尔齐聚，围攻弱特级咒灵陀艮。'}},
      {label:'漏壶宿傩战场',battle:{enemies:[E('漏壶',10)],allies:[E('16指宿傩',10,'受肉体')],lose:'die',intro:'漏壶宿傩战场：16指宿傩与你一同迎战强特级咒灵漏壶。'}},
      {label:'羂索里梅战场',battle:{enemies:[E('羂索',10,'诅咒师'),E('里梅',8,'受肉体')],allies:[E('九十九由基',9,'咒术师')],lose:'continue',intro:'羂索里梅战场：标准特级咒术师九十九由基与你对战羂索与里梅，此战败北也不会死亡。'}},
      {label:'胀相虎杖战场',battle:{enemies:[E('胀相',9,'受肉体')],allies:[E('虎杖悠仁',6,'咒术师')],lose:'continue',intro:'胀相虎杖战场：兄弟相残之战，你协助虎杖对战标准特级受肉体胀相，败北不死。'}},
      {label:'伏黑父子对决战场',battle:{enemies:[E('伏黑甚尔',8,'人类')],allies:[E('伏黑惠',4,'咒术师')],lose:'continue',intro:'伏黑父子对决战场：你协助伏黑惠对战其生父——弱特级人类伏黑甚尔，败北不死。'}}]}},
 105:{chapter:'死灭回游',title:'第105天 · 死灭回游四战场',
    intro:'死灭回游的杀阵开启，泳者们在各地厮杀。转动转盘，决定你被投入哪处战场。',
    wheel:{title:'死灭回游战场转盘',items:[
      {label:'仙台战场',battle:{enemies:[E('多鲁布',7,'诅咒师'),E('黑沐死',8),E('乌璐亨子',8,'受肉体'),E('石流龙',9,'受肉体')],allies:[E('乙骨忧太',10,'咒术师')],lose:'die',intro:'仙台战场：四泳者围城！强特级咒术师乙骨忧太与你共战多鲁布、黑沐死、乌璐亨子、石流龙。'}},
      {label:'新宿战场',battle:{enemies:[E('日车宽见',8,'咒灵')],allies:[E('虎杖悠仁',7,'咒术师')],lose:'continue',intro:'新宿战场：你与准特级咒术师虎杖悠仁对战弱特级的日车宽见，败北不会死亡。'}},
      {label:'涩谷战场',battle:{enemies:[E('鹿紫云一',9,'受肉体')],allies:[E('秤金次',8,'咒术师')],lose:'die',intro:'涩谷战场：弱特级咒术师秤金次与你对战标准特级受肉体鹿紫云一。'}},
      {label:'樱岛战场',battle:{enemies:[E('禅院直哉',9)],allies:[E('禅院真希·天裕暴君',8,'人类'),E('加茂宪纪',5,'咒术师')],lose:'die',intro:'樱岛战场：天与暴君之姿的禅院真希与一级咒术师加茂宪纪，同你对战标准特级咒灵禅院直哉。'}}]}},
 120:{chapter:'新宿决战',title:'第120天 · 新宿决战（六连战）',
    intro:'最终决战。两面宿傩以十影术式之姿君临新宿。这是人类与诅咒的最后战场——败而不馁，连战不息，直至最后一人。',
    final:true,
    stages:[
      {enemies:[E('十影宿傩',11,'受肉体')],allies:[E('五条悟',11,'咒术师')],lose:'next',intro:'【第一场】超特级的对决：五条悟 VS 十影宿傩，你与最强并肩！'},
      {enemies:[E('一削·神武真身宿傩',10,'受肉体')],allies:[E('鹿紫云一',9,'受肉体')],lose:'next',intro:'【第二场】宿傩被削去一臂。标准特级受肉体鹿紫云一抱定觉悟参战！'},
      {enemies:[E('二削·神武真身宿傩',10,'受肉体')],allies:[E('日车宽见',8,'咒术师'),E('虎杖悠仁',7,'咒术师')],lose:'next',intro:'【第三场】弱特级日车宽见与准特级虎杖悠仁接力上阵。'},
      {enemies:[E('三削·神武真身宿傩',10,'受肉体')],allies:[E('虎杖悠仁',8,'咒术师'),E('乙骨忧太',10,'咒术师')],lose:'next',intro:'【第四场】弱特级虎杖与强特级乙骨忧太联手强攻。'},
      {enemies:[E('四削·神武真身宿傩',9,'受肉体')],allies:[E('虎杖悠仁',8,'咒术师'),E('东堂葵',7,'咒术师')],lose:'next',intro:'【第五场】标准特级的宿傩再被削落，虎杖与准特级东堂的最佳组合登场。'},
      {enemies:[E('五削·神武真身宿傩',9,'受肉体')],allies:[E('虎杖悠仁',10,'咒术师')],lose:'die',intro:'【第六场·决战】强特级咒术师虎杖悠仁与你一同，向宿傩挥出最后一拳！此战若败，万劫不复。'}]}};
const EVENT_DAYS=Object.keys(STORY).map(Number).sort((a,b)=>a-b);

/* ===== 怀玉篇（2006）独立时间线：第0–30天，反派路线全程阵营翻转（原boss变队友、原高专队友变对手），第30天终战胜后转入主线第0天 ===== */
const KAI_STORY={
 6:{chapter:'怀玉篇',scenePrefix:'k',title:'第6天 · 废弃校舍的咒灵',
    intro:'2006年，你随高专二年级的五条悟、夏油杰一行执行任务。一栋废弃校舍里盘踞着准一级咒灵【生恶蠕虫】，庵歌姬被困其中……',
    stages:[
      {enemies:[E('生恶蠕虫',4)],allies:[E('庵歌姬',3,'咒术师')],lose:'next',noFlip:true,
       intro:'第一战：你与庵歌姬率先遭遇生恶蠕虫。此战即使败北也不会死亡——五条悟与夏油杰就在附近。'},
      {enemies:[E('生恶蠕虫',4)],allies:[E('17岁·五条悟',7,'咒术师'),E('17岁·夏油杰',6,'咒术师')],lose:'die',noFlip:true,
       intro:'第二战：17岁的五条悟与夏油杰赶到，两名二年级天才并肩围剿生恶蠕虫！'}]},
 12:{chapter:'怀玉篇',scenePrefix:'k',title:'第12天 · Q组织的袭击',
    intro:'咒诅师团体「Q」为了抹除星浆体护卫、阻挠天元同化悍然出手。一级诅咒师【Q战斗员·科昆】拦在面前，夏油杰与你一同迎战。',
    stages:[{enemies:[E('Q战斗员·科昆',5,'诅咒师')],allies:[E('17岁·夏油杰',6,'咒术师')],lose:'die',noFlip:true}]},
 13:{chapter:'怀玉篇',scenePrefix:'k',title:'第13天 · Q的王牌',
    intro:'Q组织祭出王牌【拜尔】，扬言要试试“当世最强”的成色。五条悟懒洋洋地站到了你身旁。',
    stages:[{enemies:[E('Q的王牌·拜尔',6,'诅咒师')],allies:[E('17岁·五条悟',7,'咒术师')],lose:'die',noFlip:true}]},
 18:{chapter:'怀玉篇',scenePrefix:'k',title:'第18天 · 拜星教的刺客',
    intro:'拜星教雇佣的诅咒师老头出手，目标是3000万悬赏的星浆体。夏油杰挡在你身前。',
    stages:[{enemies:[E('拜星教雇佣的老头',5,'诅咒师')],allies:[E('17岁·夏油杰',6,'咒术师')],lose:'die',noFlip:true}]},
 19:{chapter:'怀玉篇',scenePrefix:'k',title:'第19天 · 面罩男',
    intro:'拜星教最后的雇佣诅咒师——面罩男为3000万而来。五条悟嚼着糖，一脸轻松地迎战。',
    stages:[{enemies:[E('拜星教雇佣的面罩男',6,'诅咒师')],allies:[E('17岁·五条悟',7,'咒术师')],lose:'die',noFlip:true}]},
 30:{chapter:'怀玉篇',scenePrefix:'k',title:'第30天 · 天与暴君·伏黑甚尔',
    intro:'最终之日。零咒力却以纯粹肉身臻至“超地表”的天与暴君【伏黑甚尔】现身——他手持天逆鉾、释魂刀、游云、万里锁四件特殊道具，是17岁五条悟与夏油杰命定的死劫。',
    stages:[
      {enemies:[E('伏黑甚尔',9,'人类')],allies:[E('17岁·五条悟',7,'咒术师')],lose:'next',winNext:true,noFlip:true,
       intro:'第一战：五条悟率先迎战伏黑甚尔。此战败北不会死亡，战局将转入下一阶段。'},
      {enemies:[E('伏黑甚尔',9,'人类')],allies:[E('17岁·夏油杰',6,'咒术师')],lose:'next',winNext:true,noFlip:true,
       intro:'第二战：夏油杰接替上场，以咒灵操术迎战天与暴君。败北仍不会死亡。'},
      {enemies:[E('伏黑甚尔',9,'人类')],allies:[E('17岁·五条悟·觉醒',10,'咒术师')],lose:'die',gotoMain:true,
       intro:'最终战：濒死逆转、领悟反转术式与虚式「茈」的五条悟觉醒归来，与伏黑甚尔展开宿命对决。正派路线你将与觉醒悟并肩击溃甚尔；反派路线你将与甚尔联手挑战觉醒悟。战胜后时间线将推进至2018年主线【宿傩受肉篇】第0天。'}]}
};
const KAI_EVENT_DAYS=Object.keys(KAI_STORY).map(Number).sort((a,b)=>a-b);
// 怀玉篇反派路线全程阵营翻转：移除所有stage的noFlip，让原boss变队友、原高专队友变对手
Object.values(KAI_STORY).forEach(node=>node.stages.forEach(s=>delete s.noFlip));

/* ===== 未来篇（新宿决战数十年后）独立时间线：第0–60天，战斗集中在第7/18/25/30天，第30天先三战场转盘再决战地狱·真人，战胜即未来篇结局 ===== */
const FUTURE_STORY={
 7:{chapter:'未来篇',scenePrefix:'f',title:'第7天 · 人贩子咒诅师',
   intro:'数十年后的未来，咒术界由新世代支撑。你卷入了一名以【空间吞噬】术式掳掠弱者的准一级诅咒师「人贩子」事件，乙骨犹花与乙骨真剑两兄妹就在现场。',
   stages:[
     {enemies:[E('人贩子',4,'诅咒师')],allies:[E('乙骨犹花',3,'咒术师'),E('乙骨真剑',3,'咒术师')],lose:'next',
      intro:'第一战：你与乙骨犹花、乙骨真剑联手围剿人贩子。此战败北不会死亡——犹花体内的魔虚罗与里香附体的真剑将接管战局。'},
     {enemies:[E('人贩子',4,'诅咒师')],allies:[E('乙骨犹花·魔虚罗',10,'式神'),E('里香附体·乙骨真剑',10,'咒术师')],lose:'die',
      intro:'第二战：乙骨犹花化身完全适应的魔虚罗之姿，乙骨真剑则被里香附体——两名强特级战力与人贩子展开决战。此战败北即死。'}]},
 18:{chapter:'未来篇',scenePrefix:'f',title:'第18天 · 武田正树',
   intro:'以【母霊度暴威】召唤式神、专挑年幼孩子下手的一级诅咒师【武田正树】现身。失去意识的马鲁也被卷入战场。',
   stages:[
     {enemies:[E('武田正树',5,'诅咒师')],allies:[E('乙骨犹花',3,'咒术师'),E('乙骨真剑',3,'咒术师'),E('失去意识·马鲁',5,'咒术师')],lose:'next',
      intro:'第一战：你与乙骨兄妹、失去意识的马鲁一同迎战武田正树。败北不会死亡，犹花与真剑将解放真正的力量。'},
     {enemies:[E('武田正树',5,'诅咒师')],allies:[E('乙骨犹花·魔虚罗',10,'式神'),E('里香附体·乙骨真剑',10,'咒术师')],lose:'die',
      intro:'第二战：魔虚罗之姿的犹花与里香附体的真剑再度降临，强特级战力碾压战场。此战败北即死。'}]},
 25:{chapter:'未来篇',scenePrefix:'f',title:'第25天 · 达布拉',
   intro:'来自宇宙的强特级咒术师【达布拉】降临地球，他身负【质量的杀意与光】，只为寻找值得一战的对手。此刻无人能为你助阵——你必须独自接下他的第一击。',
   stages:[
     {enemies:[E('达布拉',10,'咒术师')],allies:[],lose:'continue',
      intro:'你独自迎战强特级的达布拉。此战即使败北也不会死亡——真正的决战尚在第30天。'}]},
 30:{chapter:'未来篇',scenePrefix:'f',title:'第30天 · 三战场与地狱真人',
   intro:'最终之日。地球的命运被分割为三处战场，而被改造至极致的咒灵【地狱·真人】在主战场张开了无为转变的领域。先转动转盘决定你被投入的战场，随后直面地狱·真人！',
   wheel:{title:'第30天 · 未来篇战场转盘',items:[
     {label:'牛头与魔虚罗战场',battle:{enemies:[E('极限解放·达布拉',11,'咒术师')],allies:[E('乙骨犹花·完全适应魔虚罗',11,'式神')],lose:'die',intro:'牛头与魔虚罗战场：超特级的极限解放·达布拉，与超特级完全适应魔虚罗之姿的乙骨犹花展开死斗。此战败北即死。'}},
     {label:'真剑与马鹿战场',battle:{enemies:[E('解放·马鲁',6,'咒术师')],allies:[E('里香附体·乙骨真剑',10,'咒术师')],lose:'die',intro:'真剑与马鹿战场：解放混沌与调和之力的马鲁，迎战里香附体的乙骨真剑。此战败北即死。'}},
     {label:'虎杖悠仁战场',battle:{enemies:[E('奥斯基',6,'咒术师')],allies:[E('68·虎杖悠仁',13,'咒术师')],lose:'die',intro:'虎杖悠仁战场：龙级巅峰、68岁的虎杖悠仁出手，以神级之姿碾压特别一级的奥斯基。此战败北即死。'}}]},
   stages:[
     {enemies:[E('地狱·真人',10,'咒灵')],allies:[E('68·虎杖悠仁',13,'咒术师')],lose:'die',futureFinal:true,
      intro:'最终决战：超特级咒灵【地狱·真人】以超地表之躯与无为转变降临！龙级巅峰的68岁虎杖悠仁与你并肩——这是未来篇的终局，战胜即迎来未来篇结局，败北则万劫不复。'}]}};
const FUTURE_EVENT_DAYS=Object.keys(FUTURE_STORY).map(Number).sort((a,b)=>a-b);
/** 未来篇主界面时代标签 */
function futureEraOfDay(d){
  if(d<=6)return'未来篇 · 新世代的日常';
  if(d<=17)return'未来篇 · 人贩子事件';
  if(d<=24)return'未来篇 · 武田正树事件';
  if(d<=29)return'未来篇 · 宇宙来客';
  return'未来篇 · 最终决战';
}
/** 怀玉篇主界面时代标签 */
function kaiEraOfDay(d){
  if(d<=5)return'怀玉篇 · 任务前夕';
  if(d<=11)return'怀玉篇 · Q组织初袭';
  if(d<=17)return'怀玉篇 · Q的王牌';
  if(d<=29)return'怀玉篇 · 拜星教追杀';
  return'怀玉篇 · 天与暴君决战';
}
/** 主界面时代标签 */
function eraOfDay(d){
  if(d<=4)return'宿傩受肉虎杖时期';
  if(d<=24)return'钉崎野蔷薇登场篇';
  if(d<=33)return'少年院篇';
  if(d<=48)return'幼鱼与逆罚篇';
  if(d<=68)return'京都姐妹校交流会篇';
  if(d<=87)return'八十八桥篇';
  if(d<=90)return'涩谷事变';
  if(d<=99)return'涩谷事变·善后';
  if(d<=119)return'死灭回游时期';
  return'新宿决战';
}

/* ============================ VII. 界面工具 & 战斗 UI ============================ */
function showModal(html){$('modalMask').classList.remove('hidden');$('modalBox').innerHTML=html;}
function closeModal(){$('modalMask').classList.add('hidden');$('modalBox').innerHTML='';}
function pct(cur,max){return clamp(Math.round(cur/max*100),0,100)+'%';}
/** 死战轮盘：撤退轮盘 / 生还轮盘。返回 Promise<boolean>，true=成功。 */
function showWheelOverlay(opts){
  return new Promise(resolve=>{
    const chance=clamp(Number(opts&&opts.chance)||0,0,1);
    const success=Math.random()<chance;
    const successDeg=chance*360;
    const title=(opts&&opts.title)||'轮 盘';
    const successLabel=(opts&&opts.successLabel)||'成 功';
    const failLabel=(opts&&opts.failLabel)||'失 败';
    const note=(opts&&opts.note)||'';
    const overlay=document.createElement('div');
    overlay.className='wheel-overlay';
    overlay.innerHTML='<div class="wheel-dialog"><h2>'+title+'</h2>'+
      '<div class="rw-stage"><div class="rw-disc" style="background:conic-gradient(#2dc653 0deg '+successDeg+'deg,#e01e37 '+successDeg+'deg 360deg)"></div>'+
      '<div class="rw-pointer-wrap" id="wheelPointer"><div class="rw-pointer"></div></div><div class="rw-hub"></div></div>'+
      '<div class="rw-legend"><span class="ok">'+successLabel+' '+Math.round(chance*100)+'%</span><span class="bad">'+failLabel+' '+Math.round((1-chance)*100)+'%</span></div>'+
      '<p class="rw-note">'+note+'</p><div class="center"><button class="btn" id="wheelSpin">转 动 轮 盘</button></div><div class="rw-result" id="wheelResult"></div></div>';
    document.body.appendChild(overlay);
    const pointer=overlay.querySelector('#wheelPointer');
    const spinBtn=overlay.querySelector('#wheelSpin');
    const resultEl=overlay.querySelector('#wheelResult');
    let spun=false,done=false;
    spinBtn.onclick=()=>{
      if(spun)return;spun=true;SFX.click();spinBtn.disabled=true;
      const arc=Math.max(0.001,successDeg);
      let angle;
      if(success){const span=Math.max(2,arc-16);angle=8+Math.random()*Math.max(1,span-8);}
      else{const start=Math.min(359,arc+8);angle=start+Math.random()*Math.max(1,351-start);}
      pointer.style.transform='rotate('+(angle+1440)+'deg)';
      setTimeout(()=>{
        resultEl.innerHTML='<div class="rw-outcome '+(success?'ok':'bad')+'">'+(success?successLabel:failLabel)+'</div>';
        const btn=document.createElement('button');btn.className='btn';btn.textContent='继 续';
        btn.onclick=()=>{if(done)return;done=true;overlay.remove();resolve(success);};
        resultEl.appendChild(btn);SFX.click();
      },2650);
    };
  });
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

/** 通用转盘模态（日常行动 / 抉择 / 战场 / 狩猎），Promise  resolve 选中项 */
function openWheelModal(opt){
  return new Promise(resolve=>{
    showModal(`
      <h2>${opt.title}</h2>
      <div style="display:flex;justify-content:center;margin:6px 0">
        <div class="wheel-box" style="position:relative;width:min(380px,72vw);height:min(380px,72vw)">
          <div class="wheel-pointer"></div>
          <canvas width="500" height="500" style="width:100%;height:100%;filter:drop-shadow(0 0 22px rgba(123,47,247,.35))"></canvas>
          <div class="wheel-hub">转盘</div>
        </div>
      </div>
      <div class="wheel-result" id="mWheelResult" style="margin:10px 0">点击抽取，聆听命运……</div>
      <div class="wheel-legend" id="mWheelLegend"></div>
      <div class="center" style="margin-top:14px"><button class="btn" id="mWheelSpin">抽 取</button></div>`);
    const cv=$('modalBox').querySelector('canvas');
    const wv=new WheelView(cv);wv.setItems(opt.items);
    $('mWheelLegend').innerHTML=wheelLegendHtml(opt.items);
    let done=false;
    const finish=(item)=>{if(done)return;done=true;setTimeout(()=>{closeModal();resolve(item);},opt.delay??900);};
    $('mWheelSpin').onclick=function(){
      this.disabled=true;
      wv.spin((item,idx)=>{
        $('mWheelLegend').innerHTML=wheelLegendHtml(opt.items,idx);
        const hitEl=$('mWheelLegend').querySelector('.lg-item.hit');if(hitEl)hitEl.scrollIntoView({block:'nearest'});
        $('mWheelResult').innerHTML=`<span class="hl">${item.label}</span>${item.desc?'<br><small>'+item.desc+'</small>':''}`;
        finish(item);
      });
    };
    if(opt.auto)$('mWheelSpin').click();
  });
}

/* ---------------- 战斗 UI ---------------- */
/* ============================ VII-0. 全屏特效 & 战斗台词 ============================ */
const Fx={
  _timer:null,
  /** kind: fx-quote(蓝台词) / fx-skill(金技能) / fx-ult(极之番·碎裂震屏) */
  show(kind,who,text,dur){
    dur=dur||(kind==='fx-ult'?2200:kind==='fx-quote'?2200:1600);
    return new Promise(res=>{
      const ov=$('fxOverlay');if(!ov){res();return;}
      clearTimeout(this._timer);
      ov.className='';void ov.offsetWidth;
      const w=$('fxWho'),m=$('fxMain');
      w.textContent=who?`【${who}】`:'';m.textContent=text;
      ov.classList.add('show',kind);
      if(kind==='fx-ult'){
        setTimeout(()=>ov.classList.add('ult-shake'),450);
        setTimeout(()=>ov.classList.add('cracked'),950);
      }
      this._timer=setTimeout(()=>{ov.className='';res();},dur);
    });
  },
  quote(who,text){return this.show('fx-quote',who,text);},
  skill(who,text){return this.show('fx-skill',who,text);},
  ult(who,text){return this.show('fx-ult',who,text);},
  async seq(list){for(const x of list)await this.show(x.kind||'fx-quote',x.who,x.text);}
};
/** 战斗台词表：key=场景(s+天数_场次/战场名)，value={角色名:{e进场,w胜利,l战败}} */
const QUOTES={
's3_0':{'准二级咒灵':{e:'女人.....我需要更多的女人！！！',l:'啊啊啊啊——',w:'与我融为一体吧！'}},
's3_1':{'1指受肉宿傩':{e:'我出来了！女人在哪？小孩在哪？啊哈哈哈哈！',l:'我记住你了小鬼，下次见面我就会杀了你',w:'现代咒术师弱到这种程度了吗？'}},
's3_2':{
 '1指受肉宿傩':{e:'我出来了！女人在哪？小孩在哪？啊哈哈哈哈！',l:'我记住你了小鬼，下次见面我就会杀了你',w:'现代咒术师弱到这种程度了吗？'},
 '五条悟':{e:'真有趣，那就让我来试试你的底色吧',l:'打得很爽啊......',w:'就这种程度嘛？让人失望。'},
 '伏黑惠':{e:'敢打我？由良由良......',l:'救，救命，我还不想死，牢师呢？乙骨学长呢？特级咒术师在哪里？快来救救我！！',w:'又是被大爹们带飞的一天~'}},
's10_0':{
 '二级咒灵':{e:'小妞~不想这个小鬼死的话，就乖乖把衣服脱了~欸嘿嘿嘿！！',l:'不！不可能......',w:'爽......爽！这个小妞的滋味真不错！'},
 '钉崎野蔷薇':{e:'该死！该死！该死！都怪我！',l:'该死的色孽咒灵......',w:'谢谢你，如果不是你，我可能只能......不过只是谢谢而已哦！你敢乱想我就杀了你！'}},
's33_0':{
 '咒胎怠天':{e:'嘻！嘻嘻嘻！',l:'嘎啊！！！',w:'嘻嘻嘻！'},
 '伏黑惠':{e:'敢打我？由良由良......',l:'救，救命，我还不想死，牢师呢？乙骨学长呢？特级咒术师在哪里？快来救救我！！',w:'又是被大爹们带飞的一天~'},
 '钉崎野蔷薇':{e:'你和伏黑快走！这里我来垫底！至少你们要活下去......',l:'谢谢能遇见你们，我的一生，没有遗憾。',w:'这不是很强嘛，你这家伙！比伏黑那家伙靠谱多了。'}},
's33_1':{
 '咒胎怠天':{e:'嘻！嘻嘻嘻！',l:'嘎啊！！！',w:'嘻嘻嘻！'},
 '2指宿傩':{e:'真让人不愉悦，你也要与我对着干吗？',l:'现代中居然还有这样的强者嘛，真让人愉悦。',w:'特级吗？就你们这帮家伙？也配和我齐名？'}},
's35_0':{
 '漏壶':{e:'你这个嚣张的小鬼！我会撕碎你那张轻浮的娃娃脸！',l:'居然......强大到这种地步，被脑花那家伙骗了！',w:'人类最强？就你这种水平吗？'},
 '五条悟':{e:'没关系的啦哈哈，因为你们这帮家伙真的很弱嘛~',l:'居然是规则系的能力嘛......大意了！',w:'咒灵这种东西就是弱啊，哪怕是天灾也不过如此。'}},
's47_0':{'顺平（二级变化人·精英）':{e:'求求你，杀了我',l:'谢谢你，出现在我的生命里，谢谢你......',w:'不......我都做了什么？'}},
's48_0':{
 '真人':{e:'为什么杀人？因为有趣啊哈哈哈！',l:'这，这不对吧？',w:'哈哈哈，把你改造成好用的家伙吧！'},
 '七海建人':{e:'你快走，这里我来垫底',l:'终于可以好好休息一下了......',w:'加完这场班，还有下场班.......'}},
's62_0':{'准一级咒灵':{e:'厄啊啊啊',l:'厄啊啊啊',w:'厄啊啊啊'}},
's63_0':{'东堂葵':{e:'你喜欢什么类型的女人？',l:'哼，有几分水平',w:'不过如此，真让人无趣的家伙'}},
's68_0':{
 '花御':{e:'漏壶的目的就是我的目的！',l:'对，对不起，漏壶......真人......',w:'我算是帮上忙了嘛？'},
 '伏黑惠':{e:'敢打我？由良由良......',l:'救，救命，我还不想死，牢师呢？乙骨学长呢？特级咒术师在哪里？快来救救我！！',w:'又是被大爹们带飞的一天~'},
 '禅院真希':{e:'你们快走，这里由我顶上！',l:'惠！停下！不要自爆！接下来交给他们吧。',w:'没想到你居然强到这个地步。'}},
's68_1':{
 '花御':{e:'又来了一些更强的家伙吗？',l:'对，对不起，漏壶......真人......',w:'我算是帮上忙了嘛？'},
 '虎杖悠仁':{e:'交给我们吧！',l:'对不起给你们添麻烦了.......',w:'你们这些伤人的咒灵！我会一个不剩的屠杀干净！'},
 '东堂葵':{e:'我们上！Bro！我来给你打辅助！',l:'操作不过来了.......',w:'打得漂亮！兄弟！'}},
's68_2':{
 '花御':{e:'不，不好！是五条悟！快走！',l:'呃啊啊啊啊！',w:'你居然这么强？我觉得复活宿傩是没有必要的.......'},
 '五条悟':{e:'又是你这家伙',l:'居然强到这种地步吗？大意了.......',w:'你们这些咒灵，说白了就是一群不入流的货色罢了！'}},
's78_咒胎战场':{
 '咒胎怠天':{e:'嘻嘻嘻',l:'嘎啊！',w:'嘻嘻嘻！'},
 '伏黑惠':{e:'尼玛，老子不自爆了，领域展开！',l:'嘎啊！！我还不想死，牢师呢？乙骨学长呢？特级咒术师在哪里？快来救救我！！',w:'OK啊家人们，找回自信了！'}},
's78_血涂与坏相战场':{
 '血涂':{e:'弟弟！我们上',l:'胀相哥哥.......我不想死.......',w:'好难过.......为什么，虎杖悠仁，你究竟是.......'},
 '坏相':{e:'哥哥！我们上',l:'哥哥，对不起，我没能帮上忙。',w:'心好痛，虎杖悠仁，你难道是.......'},
 '虎杖悠仁':{e:'这里我来上，钉崎！你们快走！',l:'对不起，哥哥......',w:'不知道为什么，心好痛.......'},
 '钉崎野蔷薇':{e:'呃哈哈哈哈哈！杀了你们！杀了你们！',l:'可惜......',w:'黑闪！！！！哈哈哈！爽了~'}},
's88_是（30%）':{
 '五条悟':{e:'堵上一切！0.2秒的领域展开！',l:'呵呵，那就暂时交给我的好学生们吧......',w:'也就这样吗？让宿傩过来吧。'},
 '漏壶':{e:'五条悟！看这里！',l:'百年后咒灵一定会获胜，即使活下来的人不是我......',w:'新世界是我们的！'},
 '花御':{e:'漏壶，我来支援你！',l:'活下去，漏壶',w:'一切顺利'},
 '胀相':{e:'啊啊，真麻烦',l:'对不起，我的弟弟们......',w:'虎杖悠仁，你在哪里。'},
 '羂索':{e:'哟，悟！好久不见~',l:'意料之外啊',w:'意料之中'}},
's90_蝗虫战场':{
 '蝗虫':{e:'我不笨，我不笨！',l:'我居然是笨蛋吗？',w:'哈哈哈，你们才是笨蛋~'},
 '虎杖悠仁':{e:'你吃过人，对不起，我要杀了你',l:'对不起，老师，没能帮上忙',w:'安息吧'}},
's90_真人战场':{
 '真人':{e:'又是你吗，悠仁。',l:'这、这不可能......',w:'灵魂的形状，真是丑陋啊。'},
 '虎杖悠仁':{e:'真人！！！我要杀了你！！',l:'对不起，钉崎、老师、七海海......',w:'真人，无论你转生多少次，只要我还活着，我就会无休止尽的杀了你'},
 '东堂葵':{e:'现在跟不上兄弟的人是你啊，东堂葵！你甘心吗？',l:'我的不义游戏结束了。',w:'如果满足于现状那就不是我，你要让兄弟再一个人独自战斗吗？东堂葵！！'}},
's90_魔虚罗战场':{
 '魔虚罗':{e:'嗡嗡嗡嗡',l:'嗡',w:'嗡嗡！'},
 '16指宿傩':{e:'居然强大到这个地步吗？伏黑惠，你真是有个好术式啊哈哈哈！',l:'居然没秒掉吗？可惜',w:'有点意思，打得我好痛快'}},
's90_陀艮战场':{
 '陀艮':{e:'我即是大海！',l:'漏壶，对不起。',w:'我也算是帮上忙了吧？'},
 '伏黑惠':{e:'我来当领域中和器，至于战斗？你们别想让我上，不然我就由良由良。',l:'忘记自爆了，该死，我还不想死，牢师呢？乙骨学长呢？特级咒术师在哪里？快来救救我！！',w:'哼，这都是我一个人的功劳'},
 '七海建人':{e:'你们走！我来垫后',l:'总算可以休息了吗',w:'还不能停，还有下一场战斗等着我'},
 '禅院家主':{e:'老头子我还能再发光发热一会呢',l:'直哉.......',w:'没有意识了吗？甚尔......'},
 '真希':{e:'老爷子，你走，我来垫后',l:'真依......对不起',w:'是你吗？甚尔堂哥？'},
 '伏黑甚尔':{e:'杀......',l:'唔.......',w:'杀，杀，杀！'}},
's90_漏壶宿傩战场':{
 '漏壶':{e:'我不在乎我的生死，我在乎的是千千万万的咒灵们',l:'为什么，我会哭？',w:'履行承诺吧，诅咒之王'},
 '16指宿傩':{e:'如果你能伤到我，我可以听你们的指挥',l:'呵，咒灵吗？',w:'不必妄自菲薄，你很强，我打得很愉悦'}},
's90_羂索里梅战场':{
 '羂索':{e:'一切将从我这里开始',l:'那就开启吧，死灭回游',w:'只有这种程度吗？'},
 '里梅':{e:'不要妨碍我们的计划！',l:'对不起，宿傩大人',w:'胜利的荣光是属于宿傩大人的'},
 '九十九由基':{e:'你喜欢什么类型的女人？',l:'哼，星之怒！',w:'哎哟，可惜，再努努力说不定人家也会喜欢上你呢？'}},
's90_胀相虎杖战场':{
 '胀相':{e:'虎杖悠仁！！还我弟弟的命来！',l:'对不起，是我的错，都怪我的选择错误',w:'对不起悠仁，是我的错，都怪我的选择错误才导致我们兄弟相残'},
 '虎杖悠仁':{e:'胀相哥......我会阻止你！',l:'对不起......',w:'我们一定还能做回兄弟。'}},
's90_伏黑父子对决战场':{
 '伏黑甚尔':{e:'小子，你叫什么名字',l:'不姓禅院就好。',w:'你不合适在咒术界生存，去当个普通人吧'},
 '伏黑惠':{e:'爸......爸爸？',l:'怎么会......',w:'他最后，是笑着的。'}},
's105_仙台战场':{
 '多鲁布':{e:'嘎嘎',l:'呃啊',w:'嘎嘎嘎'},
 '黑沐死':{e:'我喜欢铁的味道',l:'呃',w:'血！！！'},
 '乌璐亨子':{e:'你很喜欢说教嘛？',l:'我也想为自己而活',w:'这样就好了'},
 '石流龙':{e:'让我来尝尝，你是主菜还是甜点',l:'我吃饱了',w:'原来只是个餐前甜点吗'},
 '乙骨忧太':{e:'控制一下实力，别把他们打死了',l:'居然，失误了吗？',w:'请把分给我，谢谢？'}},
's105_新宿战场':{
 '虎杖悠仁':{e:'日车，我不想伤害你，把分给我',l:'你怎么停下了？',w:'谢谢你，日车'},
 '日车宽见':{e:'虎杖悠仁，我不想伤害你',l:'谢谢你让我找回一丝清醒',w:'你是无罪的，虎杖悠仁，可是为什么你要认罪？'}},
's105_涩谷战场':{
 '鹿紫云一':{e:'把音量调到最大！为你做好最后的送葬！',l:'快点给我个痛快吧',w:'性！？'},
 '秤金次':{e:'熊猫，你变瘦了不少啊？',l:'哦齁齁齁',w:'牵到小鹿的手啦家人们，看我不让他哦齁齁齁'}},
's105_樱岛战场':{
 '禅院直哉':{e:'杀了你',l:'呃啊！',w:'现在追上他们的人，是我！'},
 '禅院真希·天裕暴君':{e:'.......',l:'.......',w:'.......'},
 '加茂宪纪':{e:'尽我所能，为大家做出点贡献',l:'我尽力了吗？',w:'我有帮上忙吗？'}},
's120_0':{
 '五条悟':{e:'提前说好，你才是挑战者',l:'打得很爽啊',w:'会赢的'},
 '十影宿傩':{e:'魔虚罗！出来！',l:'结束了，打得漂亮五条悟，我认可你了',w:'真是令人愉悦，五条悟，我想我一辈子也不会忘记你了吧'}},
's120_1':{
 '一削·神武真身宿傩':{e:'少了一条手臂，也足够杀你。',l:'竟被逼到这份田地......',w:'这就是你们的极限吗？'},
 '鹿紫云一':{e:'一刻也没有为五条悟的死亡感到悲伤，立马赶到战场的是',l:'鹿紫云一什么的，无所谓的，忘了吧',w:'真是无趣啊宿傩，我想我下一刻就会忘了你吧'}},
's120_2':{
 '二削·神武真身宿傩':{e:'车轮战吗？正合我意。',l:'审判之剑......吗。',w:'你们的术式，对我无效。'},
 '日车宽见':{e:'我以审判员之名，剥夺你的武力！',l:'我的判决......到此为止了。',w:'有罪——宿傩，你被判有罪！'},
 '虎杖悠仁':{e:'日车先生，剩下的交给我们！',l:'还没......我还不能倒下！',w:'再来一拳！我还能再打！'}},
's120_3':{
 '三削·神武真身宿傩':{e:'复制术式？有点意思。',l:'乙骨忧太......棘手。',w:'不过如此。'},
 '虎杖悠仁':{e:'乙骨前辈，我们一起上！',l:'可恶......身体要散架了。',w:'还差一点，就差一点！'},
 '乙骨忧太':{e:'悠仁，我会把全部咒力借给你。',l:'咒力......见底了吗。',w:'这就是大家汇聚起来的力量！'}},
's120_4':{
 '四削·神武真身宿傩':{e:'不义游戏......烦人的交换。',l:'被摆了一道吗。',w:'你们的配合也就到此为止。'},
 '虎杖悠仁':{e:'东堂哥，再来一次最佳配合！',l:'拳头......握不住了。',w:'黑闪！给我中！'},
 '东堂葵':{e:'兄弟！我给你开路！',l:'不义游戏......用不了了。',w:'上吧兄弟，这一拳定胜负！'}},
's120_5':{
 '五削·神武真身宿傩':{e:'来吧，人类最后的拳头。',l:'......被小鬼打败了吗。',w:'诅咒之王，永不落败。'},
 '虎杖悠仁':{e:'宿傩！这一拳，是为了所有被你伤害的人！',l:'对不起......大家......',w:'我们......赢了啊。'}},
/* —— 怀玉篇（scene 前缀 k） —— */
'k6_0':{
 '生恶蠕虫':{e:'啊啊啊——',l:'不可能！',w:'又一个呵呵呵'},
 '庵歌姬':{e:'救命啊——',l:'我不想死呜呜呜！',w:'这都多亏了我呢'}},
'k6_1':{
 '生恶蠕虫':{e:'啊啊啊——',l:'不可能！',w:'又一个呵呵呵'},
 '17岁·五条悟':{e:'歌姬，你在哭吗？',l:'居然有这种实力吗',w:'咒灵这种东西真是弱爆了'},
 '17岁·夏油杰':{e:'哦？这里居然有个准一级咒灵',l:'强到这种地步吗',w:'不要欺负弱者啊，悟'}},
'k12_0':{
 'Q战斗员·科昆':{e:'乖乖交出那个女孩！不然就宰了你！',l:'这群小鬼，怎么可能这么强？',w:'知道Q组织的强大了吧！'},
 '17岁·夏油杰':{e:'我听不见，说话大声点',l:'强到这种地步吗',w:'看样子你们Q组织也就这种水平呢'}},
'k13_0':{
 'Q的王牌·拜尔':{e:'听说你是当世最强，我来试试你的成分',l:'这就是六眼吗.......',w:'知道Q组织的强大了吧！'},
 '17岁·五条悟':{e:'Q的王牌？那我来陪你玩玩',l:'强到这种地步吗',w:'最强者也只有勉强特别一级的水准吗？这个组织没救了'}},
'k18_0':{
 '拜星教雇佣的老头':{e:'哦？咒灵操术？',l:'你体术怎么会这么强......',w:'不要怪我，我也是拿钱办事'},
 '17岁·夏油杰':{e:'居然认识咒灵操术嘛？',l:'强到这种地步吗',w:'我可没说过我只练术式啊'}},
'k19_0':{
 '拜星教雇佣的面罩男':{e:'3000万的目标呵呵呵',l:'我的钱.......',w:'3000万到手'},
 '17岁·五条悟':{e:'你水准很高哦大叔，为什么要去当诅咒师呢？',l:'强到这种地步吗',w:'不错嘛大叔，来我这边上班吧，3000万对我来说也只是毛毛雨'}},
'k30_0':{
 '伏黑甚尔':{e:'不用自我介绍，我记不住男人的名字',l:'我的儿子.......随你处置',w:'当世最强吗？呵呵'},
 '17岁·五条悟':{e:'感受不到咒力的波动？',l:'我......',w:'没想到我也有被人带飞的一天'}},
'k30_1':{
 '伏黑甚尔':{e:'咒灵操术？乌合之众罢了',l:'我......失败了吗？',w:'居然输给了我这样的猴子吗？这就是当世最强的二人？'},
 '17岁·夏油杰':{e:'是吗？我这就送你去死',l:'悟.......',w:'逝去的人已无法回归......'}},
'k30_2':{
 '伏黑甚尔':{e:'真的假的？！',l:'我的儿子.......随你处置',w:'当世最强吗？呵呵'},
 '17岁·五条悟·觉醒':{e:'我感受到了！咒力的核心哈哈哈哈哈哈！！！',l:'强到这种地步吗',w:'天上天下，唯我独尊'}},
/* —— 未来篇（scene 前缀 f） —— */
'f7_0':{
 '人贩子':{e:'正因为如此，我才喜欢欺负弱者',l:'怎么可能？！你会这么强......你到底是谁？！',w:'太弱了呵呵呵。'},
 '乙骨犹花':{e:'放弃挣扎吧！你个坏蛋',l:'至少，不能让哥哥死.....布瑠布，由良由良',w:'呼，差点就要用十影了'},
 '乙骨真剑':{e:'我要证明，我比犹花要强',l:'犹花！可恶.....里香小姐！拜托了！',w:'哼'}},
'f7_1':{
 '人贩子':{e:'这是什么？',l:'怎么可能？！怎么会这么强......这到底是什么东西？！',w:'居然能赢？'},
 '乙骨犹花·魔虚罗':{e:'——',l:'——',w:'——'},
 '里香附体·乙骨真剑':{e:'真讨厌，你这家伙跟那个女人长得太像了',l:'犹太——',w:'哼，就这样吧'}},
'f18_0':{
 '武田正树':{e:'我最喜欢扮演一年级小学生了',l:'你确实很强，但我见识过更强的存在',w:'没有伙伴了吗？'},
 '乙骨犹花':{e:'哥哥！小心！',l:'至少，不能让哥哥死.....布瑠布，由良由良',w:'战争嘛.......'},
 '乙骨真剑':{e:'马鲁！该死！',l:'可恶.....里香小姐！拜托了！',w:'没事吧？马鲁'},
 '失去意识·马鲁':{e:'.......',l:'.......',w:'.......'}},
'f18_1':{
 '武田正树':{e:'这份压迫感，我只在虎杖悠仁身上看到过',l:'你确实很强，但我见识过更强的存在',w:'这，您居然能做到这个地步吗？'},
 '乙骨犹花·魔虚罗':{e:'——',l:'——',w:'——'},
 '里香附体·乙骨真剑':{e:'还来啊，好吧~',l:'犹太——',w:'可不能一直依赖我哦'}},
'f25_0':{
 '达布拉':{e:'我问！你们！在！干什么！',l:'这是我人生中第一次感到恐惧',w:'如果他性命不保我就杀光你们地球人'}},
'f30_牛头与魔虚罗战场':{
 '极限解放·达布拉':{e:'你能让我享受战斗吗？',l:'对不起，马鹿......',w:'不要怪我，我可是战士！'},
 '乙骨犹花·完全适应魔虚罗':{e:'——',l:'——',w:'——'}},
'f30_真剑与马鹿战场':{
 '解放·马鲁':{e:'真剑，这场战斗是不可避免的',l:'你这家伙......',w:'这场战斗的胜利我拿下了'},
 '里香附体·乙骨真剑':{e:'最后一次，小鬼',l:'犹太——',w:'我要去找犹太了，拜拜~'}},
'f30_虎杖悠仁战场':{
 '奥斯基':{e:'你这家伙！',l:'呃啊.......',w:'这是，神仙打架吗？'},
 '68·虎杖悠仁':{e:'你看起来挺肉的，应该不会死吧？',l:'神级？',w:'虎杖悠仁什么的，已经无所谓了'}},
'f30_0':{
 '地狱·真人':{e:'这里是我的主战场！',l:'怎么可能？？',w:'这是，神仙在打架吗？'},
 '68·虎杖悠仁':{e:'有干劲吗？真人',l:'你是......神级？',w:'这样就可以了吧？'}}
};
/** 进场台词列表（敌方先、我方后） */
function enterQuoteList(scene,units){
  const q=QUOTES[scene];if(!q)return[];const out=[];
  const push=u=>{const z=q[u.name];if(z&&z.e)out.push({who:u.name,text:z.e});};
  units.filter(u=>u.side==='enemy'&&!u.isPlayer).forEach(push);
  units.filter(u=>u.side==='ally'&&!u.isPlayer).forEach(push);
  return out;
}
/** 结算台词列表：玩家胜→敌人说战败(l)、队友说胜利(w)；玩家败反之 */
function endQuoteList(scene,units,playerWin){
  const q=QUOTES[scene];if(!q)return[];
  const line=(u)=>{const z=q[u.name];if(!z)return null;
    const t=u.side==='enemy'?(playerWin?z.l:z.w):(playerWin?z.w:z.l);
    return t?{who:u.name,text:t}:null;};
  const out=[];
  // 玩家胜：先敌人败辞，后队友胜辞；玩家败：先队友败辞，后敌人胜辞
  const firstSide=playerWin?'enemy':'ally',secondSide=playerWin?'ally':'enemy';
  [firstSide,secondSide].forEach(sd=>units.filter(u=>u.side===sd&&!u.isPlayer).forEach(u=>{const x=line(u);if(x)out.push(x);}));
  return out;
}

const BattleUI={
  speed:1,auto:false,_awaitingInput:false,_autoTimer:null,runId:0,_finished:false,resolve:null,_liveTimers:[],
  sd(ms){return ms/this.speed;},
  /** 受运行代号管控的延时：本场战斗结束/切换到下一场后，旧场遗留回调一律作废，杜绝跨场残留链导致断链/卡死 */
  later(ms,fn){
    const id=this.runId,t=setTimeout(()=>{if(id===this.runId)fn();},this.sd(ms));
    this._liveTimers.push(t);return t;
  },
  /** 固定时长（不被战斗倍速压缩）：用于台词/技能/领域/极之番等大字展现，保证高倍速下也至少停留约1秒以上 */
  laterFixed(ms,fn){
    const id=this.runId,t=setTimeout(()=>{if(id===this.runId)fn();},ms);
    this._liveTimers.push(t);return t;
  },
  _clearTimers(){clearTimeout(this._autoTimer);clearTimeout(this._domTimer);
    (this._liveTimers||[]).forEach(t=>clearTimeout(t));this._liveTimers=[];},
  run(cfg){
    return new Promise(resolve=>{
      this.runId++;this._finished=false;this._clearTimers(); // 开新一场：作废旧场全部异步链
      this.externalInput=null; // 单机模式清除本地对战输入回调
      const eng=new BattleEngine(cfg);this.eng=eng;this.selectedTargetIdx=null;
      this.speed=1;this.auto=false;this._awaitingInput=false;
      this.scene=cfg.scene||null;this._introDone=!this.scene; // 无场景（狩猎）不播剧情台词
      showModal(`
        <h2 style="letter-spacing:1px;font-size:18px">${cfg.deathmatch?'<span class="lethal-tag">死 战</span> ':''}${cfg.villain?'<span style="color:#ff5a5a">【反派路线】</span> ':''}${cfg.title||'战 斗'}</h2>
        <div id="battleRisk" class="battle-risk"></div>
        <div class="seq-wrap">
          <div class="seq-cap"><span>行动序列 · 速度决定行动条推进</span><span id="seqHint">1×</span></div>
          <div class="seq-axis" id="boOrder"></div>
        </div>
        <div class="battle-field">
          <div class="side-col ally"><h4>我方</h4><div id="bfAlly"></div></div>
          <div class="side-col enemy"><h4>敌方（点击头像选择攻击目标）</h4><div id="bfEnemy"></div></div>
        </div>
        <div class="battle-log" id="bfLog"></div>
        <div class="battle-tip" id="bfTip"></div>
        <div class="battle-ctl">
          <div class="ctl-group">自动战斗
            <button class="auto-btn" id="btnAuto">关</button>
          </div>
          <div class="ctl-group">速度
            <button class="spd-btn on" data-spd="1">1×</button>
            <button class="spd-btn" data-spd="2">2×</button>
            <button class="spd-btn" data-spd="3">3×</button>
            <button class="spd-btn" data-spd="5">5×</button>
          </div>
        </div>
        <div class="battle-actions" id="bfActions">
          <button class="btn small" id="actMelee">体 术 攻 击</button>
          <button class="btn small" id="actTech">咒 力 术 式</button>
          <button class="btn small" id="actDomain">领 域 展 开</button>
          <button class="btn small" id="actUlt" style="display:none">极 之 番</button>
          <button class="btn small ghost" id="actDefend">防 御</button>
          <button class="btn small ghost" id="actFlee" style="border-color:rgba(255,120,120,.5);color:#ff9a9a">撤 退</button>
          <button class="btn small" id="actAmber" style="display:none;border-color:rgba(255,170,60,.7);color:#ffd9a0">幻 兽 琥 珀</button>
          <button class="btn small" id="actLightSpeed" style="display:none;border-color:rgba(120,200,255,.7);color:#bfeaff">亚 光 速 形 态</button>
        </div>
        <div class="battle-actions" id="bfSigActions" style="margin-top:2px;display:none;flex-wrap:wrap"></div>`);
      $('battleRisk').innerHTML=cfg.deathmatch?'⚠ <b>死战</b>：撤退进入撤退轮盘；败北进入生还轮盘。':'非死战：本场败北不会直接死亡。';
      $('battleRisk').classList.toggle('lethal',!!cfg.deathmatch);
      $('modalMask').scrollTop=0;
      if(eng.events.length)eng.events.forEach(e=>this.appendLog(e));
      $('actMelee').onclick=()=>{SFX.click();this.input('melee');};
      $('actTech').onclick=()=>{SFX.click();this.input('tech');};
      $('actDomain').onclick=()=>{SFX.click();this.input('domain');};
      $('actUlt').onclick=()=>{SFX.click();this.input('ult');};
      $('actDefend').onclick=()=>{SFX.click();this.input('defend');};
      $('actFlee').onclick=()=>{SFX.click();this.tryFlee();};
      $('actAmber').onclick=()=>{SFX.click();this.activateForm('amber');};
      $('actLightSpeed').onclick=()=>{SFX.click();this.activateForm('lightSpeed');};
      $('btnAuto').onclick=()=>{
        this.auto=!this.auto;const b=$('btnAuto');
        b.textContent=this.auto?'开':'关';b.classList.toggle('on',this.auto);
        if(this.auto&&this._awaitingInput)this.scheduleAuto();
      };
      document.querySelectorAll('.spd-btn').forEach(b=>b.onclick=()=>{
        this.speed=+b.dataset.spd;
        document.querySelectorAll('.spd-btn').forEach(x=>x.classList.toggle('on',x===b));
        $('seqHint').textContent=this.speed+'×';
      });
      this.resolve=resolve;
      this.render();
      this._playIntro();
      this.loop();
    });
  },
  /** 进场台词：敌方先、我方后，蓝色大字依次呈现；播完前战斗轮轴暂不推进 */
  async _playIntro(){
    const id=this.runId;
    const list=enterQuoteList(this.scene,this.eng.units);
    if(!list.length){this._introDone=true;return;}
    for(const x of list){
      if(id!==this.runId)return;
      await Fx.quote(x.who,x.text);
    }
    if(id===this.runId)this._introDone=true;
  },
  appendLog(e){
    const box=$('bfLog');if(!box)return;
    const d=document.createElement('div');
    d.className=e.type==='hit'?'hit':e.type==='heal'?'heal':e.type==='domain'?'domain':e.type==='flash'?'flash':e.type==='die'?'lred':'sys';
    d.textContent=e.text;box.appendChild(d);box.scrollTop=box.scrollHeight;
  },
  /** 星铁式行动序列轴渲染 */
  renderSeq(){
    const first=this.eng.awaitingPlayer?this.eng.player:null;
    const seq=this.eng.previewOrder(8,first);const box=$('boOrder');if(!box)return;
    box.innerHTML=seq.map((u,i)=>{
      const cls=i===0?'current':i<=3?'':i<=5?'dim':'dim2';
      const ava=u.isPlayer?'你':(u.name||'?').slice(0,1);
      return `${i?'<span class="seq-arrow">›</span>':''}<div class="seq-node ${u.side} ${cls}" title="${u.name} · ${lvName(u.li)} · ${u.type||''}">
        <div class="seq-ava">${ava}</div><div class="seq-name">${u.isPlayer?'你':u.name}</div></div>`;
    }).join('');
  },
  unitBadges(u){
    const b=u.buff,bd=[];
    if(u.summonTag)bd.push(`<em class="bdg summon">${u.summonTag}</em>`);
    if(b.stun>0)bd.push('<em class="bdg stun">眩晕</em>');
    if(b.amberActive)bd.push('<em class="bdg" style="background:rgba(255,170,60,.18);color:#ffd9a0;border-color:rgba(255,170,60,.5)">幻兽琥珀</em>');
    if(b.lightSpeedActive)bd.push('<em class="bdg" style="background:rgba(120,200,255,.16);color:#bfeaff;border-color:rgba(120,200,255,.5)">亚光速</em>');
    if(b.defend)bd.push('<em class="bdg defend">防御</em>');
    if(b.charge)bd.push('<em class="bdg charge">蓄力中</em>');
    if(b.poison>0)bd.push(`<em class="bdg poison">毒×${b.poison}</em>`);
    if(b.gu>0)bd.push(`<em class="bdg gu">蛊×${b.gu}</em>`);
    if(u.skills&&u.skills.adapt&&(b.adaptM>0||b.adaptT>0))bd.push(`<em class="bdg adapt">适应 近${b.adaptM}/术${b.adaptT}</em>`);
    if(this.hasFlagUi(u,'ssj')&&b.ssj>0&&b.ssj<5)bd.push(`<em class="bdg ssj">超赛余${b.ssj}</em>`);
    if(u.reverse)bd.push('<em class="bdg rev">反转</em>');
    if(u.isPlayer?(this.eng&&this.eng.cfg&&this.eng.cfg.player&&this.eng.cfg.player.blackFlash):u.bf)bd.push('<em class="bdg" style="background:rgba(255,120,40,.18);color:#ff9a4a;border-color:rgba(255,140,60,.5)">黑闪</em>');
    if(u.canDomain&&u.domainUsed<1)bd.push('<em class="bdg dom">可领域</em>');
    if(u.canUlt&&!u.ultUsed)bd.push('<em class="bdg" style="background:rgba(255,200,60,.18);color:#ffd24a;border-color:rgba(255,200,60,.5)">极之番</em>');
    return bd.join('');
  },
  hasFlagUi(u,f){return u.flag===f||(u.flags&&u.flags.includes(f));},
  unitHtml(u,side){
    const idx=this.eng.units.indexOf(u);
    const sub=u.summonTag?u.summonTag:(u.techName&&u.techName!=='咒力'?u.techName:(u.type||''));
    return `<div class="unit ${u.alive?'':'dead'} ${side==='enemy'&&u.alive?'targetable':''} ${this.actingIdx===idx?'acting':''} ${u.summonTag?'is-summon':''}" data-idx="${idx}">
      <div class="uname"><span>${u.name}${u.isPlayer?'（你）':''}</span><span class="utype">${lvName(u.li)}${sub?'·'+sub:''}</span></div>
      <div class="badges">${this.unitBadges(u)}</div>
      <div class="mini-bar hp"><i style="width:${pct(u.hp,u.maxHp)}"></i></div>
      <div class="nums"><span>HP ${Math.max(0,Math.round(u.hp))}/${u.maxHp}</span></div>
      <div class="mini-bar cp"><i style="width:${pct(u.cp,u.maxCp)}"></i></div>
      <div class="nums"><span>CP ${Math.round(u.cp)}/${u.maxCp}</span></div>
      <div class="nums"><span>速度 ${this.eng.effSpeed(u).toFixed(1)}</span></div>
      <div class="mini-bar atb"><i style="width:${clamp(u.atb,0,100)}%"></i></div>
    </div>`;
  },
  render(){
    const eng=this.eng;
    this.actingIdx=null;
    $('bfAlly').innerHTML=eng.units.filter(u=>u.side==='ally').map(u=>this.unitHtml(u,'ally')).join('');
    $('bfEnemy').innerHTML=eng.units.filter(u=>u.side==='enemy').map(u=>this.unitHtml(u,'enemy')).join('');
    // 目标点击
    $('bfEnemy').querySelectorAll('.unit').forEach(el=>{
      el.onclick=()=>{const i=+el.dataset.idx;if(eng.units[i]&&eng.units[i].alive){this.selectedTargetIdx=i;this.render();}};
    });
    this.renderSeq();
    const p=eng.player;
    // 仅在真正等待玩家输入时启用指令按钮，防止敌人行动间隙误点导致额外行动
    const canInput=eng.awaitingPlayer&&!eng.ended;
    const amberActive=!!p.buff.amberActive,lightActive=!!p.buff.lightSpeedActive;
    ['actMelee','actTech','actDefend'].forEach(id=>{const b=$(id);if(b)b.disabled=!canInput;});
    if($('actFlee')){
      $('actFlee').disabled=!canInput||amberActive;
      $('actFlee').textContent=amberActive?'幻兽琥珀中·无法撤退':'撤退（成功率 '+Math.round(eng.escapeChance()*100)+'%）';
      $('actFlee').title=amberActive?'幻兽琥珀已开启，本场战斗无法撤退。':'只在你的回合可尝试；≥1.3倍速必成，<0.7倍速必败，中间按最快敌人的血量百分比计算。';
    }
    const amberBtn=$('actAmber');
    if(amberBtn){
      amberBtn.style.display=this.hasFlagUi(p,'amber')?'':'none';
      amberBtn.disabled=amberActive;
      amberBtn.textContent=amberActive?'幻兽琥珀·已开启':'幻 兽 琥 珀';
      amberBtn.title=amberActive?'幻兽琥珀已开启：战斗结束后必定死亡。':'开启后速度×1.8；战斗结束（无论胜负）必定死亡。';
    }
    const lsBtn=$('actLightSpeed');
    if(lsBtn){
      lsBtn.style.display=this.hasFlagUi(p,'massKiller')?'':'none';
      const lsReady=!!(eng.lightSpeedAvailable||p.reverse);
      lsBtn.disabled=lightActive||!lsReady;
      lsBtn.textContent=lightActive?'亚光速·已开启':(lsReady?'亚 光 速 形 态':'亚光速·冷却中');
      lsBtn.title=lightActive?'亚光速已开启：速度×2.5，咒力消耗×3，每次行动损失5%最大生命。':(lsReady?'开启亚光速：速度×2.5，咒力消耗×3，每次行动损失5%最大生命。':'连续三次战斗内只能使用一次；反转术式可解除限制。');
    }
    const domBtn=$('actDomain');
    const hasExtra=!!(p.extraTech&&p.extraTech.domain);
    if(domBtn){
      domBtn.disabled=!(canInput&&p.canDomain&&!p.domainUsed);
      domBtn.textContent=p.domainUsed?(hasExtra?'主领域·已展开':'领域·熔断中'):`领域·主｜${p.domainName||'展开'}`;
    }
    // 双术式时单独生成第二个领域按钮（副领域）
    let dom2=$('actDomain2');
    if(hasExtra){
      if(!dom2){dom2=document.createElement('button');dom2.className='btn small';dom2.id='actDomain2';
        dom2.onclick=()=>{SFX.click();this.input('domain',{forceExtra:true});};
        domBtn.insertAdjacentElement('afterend',dom2);}
      dom2.style.display='';
      dom2.disabled=!(canInput&&!p.extraDomainUsed);
      dom2.textContent=p.extraDomainUsed?'副领域·已展开':`领域·副｜${p.extraTech.domain}`;
    }else if(dom2){dom2.style.display='none';}
    const ultBtn=$('actUlt');
    if(ultBtn){
      const ultCost=eng.cpCost(p,Math.round(p.maxCp*0.5));
      const ultOk=p.canUlt&&!p.ultUsed&&((p.skills&&p.skills.sixEyes)||p.buff.blueMoon>0||p.cp>=ultCost);
      ultBtn.style.display=p.canUlt&&!p.ultUsed?'':'none';
      ultBtn.disabled=!(canInput&&ultOk);
      ultBtn.textContent=p.ultUsed?'极之番·已用':'极 之 番（耗半蓝·回满血）';
    }
    const cost=eng.techCost(p);
    $('actTech').textContent=`咒 力 术 式（耗${cost}）`;
    const t=eng.units[this.selectedTargetIdx];
    $('bfTip').textContent=(!t||!t.alive)?'系统将自动选择血量最低的敌人为目标':(`当前目标：${t.name}`);
    // 专属技能按钮（根据当前行动者名字动态显示）
    this._renderSigButtons(p,canInput);
  },
  _renderSigButtons(p,canInput){
    const box=$('bfSigActions');if(!box)return;
    if(!p||!p.name){box.style.display='none';box._sigKey='';return;}
    const skills=[];
    if(p.name==='五条悟')skills.push(['sig_aoi','苍（全体）'],['sig_ka','赫（单体）'],['sig_murasaki','虚式·茈（蓄力）']);
    else if(p.name==='十影宿傩')skills.push(['sig_kai','解（全体）'],['sig_hatsu','捌（单体）'],['sig_hiraku','开（全体）'],['sig_kamado','灶（单体）'],['sig_spaceSlash','空间斩']);
    else if(p.name.includes('宿傩'))skills.push(['sig_kai','解（全体）'],['sig_hatsu','捌（单体）'],['sig_hiraku','开（全体）'],['sig_kamado','灶（单体）'],['sig_sCharge','空间斩（蓄力）']);
    else if(p.name==='九十九由基')skills.push(['sig_hoshi','星之怒（全体）'],['sig_shitsuryo','质量弹（单体）']);
    // 本地对战：反转术式为主动技能（回5%血、封顶10万、耗本次行动）
    const isVersus=!!(this.eng&&this.eng.cfg&&this.eng.cfg.versus);
    if(isVersus&&p.reverse)skills.push(['sig_reverse','反转术式（回5%·上限10万）']);
    const sigKey=skills.map(s=>s[0]).join('|');
    if(!skills.length){box.style.display='none';box._sigKey='';return;}
    box.style.display='flex';
    // 只在按钮组合变化时重建，避免闪烁
    if(box._sigKey!==sigKey){
      box.innerHTML='';
      skills.forEach(([act,label])=>{
        const b=document.createElement('button');
        b.className='btn small';b.dataset.act=act;
        b.style.cssText='border-color:rgba(255,209,102,.5);color:#ffd24a;background:rgba(255,209,102,.08);font-size:12px';
        b.textContent=label;
        b.onclick=()=>{
          SFX.click();
          // 本地对战模式走外部输入回调（VSHostBattle），单机走BattleUI.input
          if(typeof this.externalInput==='function'){this.externalInput(act);}
          else{this.input(act);}
        };
        box.appendChild(b);
      });
      box._sigKey=sigKey;
    }
    // disabled状态由_updateBattleButtons统一控制
  },
  loop(){
    const id=this.runId;
    const step=()=>{
      if(id!==this.runId||!this.eng)return; // 已切换到下一场，旧链立即作废
      if(!this._introDone){this.later(180,()=>this.loop());return;} // 进场台词未播完，轮轴等待
      let r;
      try{r=this.eng.advance();}catch(err){console&&console.error&&console.error('战斗推进异常:',err);return this._battleFail(err);}
      this.render();
      if(r.events&&r.events.length){
        // 行动者高亮（使用引擎记录的实际行动者）
        if(this.eng.lastActor)this.flashCard(this.eng.units.indexOf(this.eng.lastActor));
        this.eventsAnim(r.events,()=>{
          if(id!==this.runId)return;
          if(r.ended)return this.finish(r.result==='win');
          if(r.needInput)return this.waitInput();
          this.later(240,()=>this.loop());
        });
      }else{
        if(r.ended)return this.finish(r.result==='win');
        if(r.needInput)return this.waitInput();
        this.later(120,()=>this.loop());
      }
    };
    this.later(250,step);
  },
  /** 战斗内任何意外都安全结算为战败，保证 Promise 绝不悬挂、剧情链不卡死 */
  _battleFail(err){
    if(typeof window!=='undefined'&&window.alert){try{window.alert('本场战斗出现异常，已按战败安全结算以继续剧情。');}catch(e){}}
    if(this._finished)return;this._finished=true;
    try{closeModal();}catch(e){}
    this.resolve&&this.resolve(false);this.resolve=null;
  },
  eventsAnim(events,cb){
    let i=0;
    const next=()=>{
      if(i>=events.length)return cb();
      const e=events[i++];
      this.appendLog(e);
      this.sfxFor(e);
      if(e.type==='domain')this.playDomainCut(e);
      else if(e.type==='skillcut'){if(SFX.skill)SFX.skill();Fx.skill(e.actorName,e.text);} // 普通技能：仅音效，不语音播报
      else if(e.type==='ultcut'){if(SFX.ult)SFX.ult();SFX.speak('极之番，'+(e.text||'').replace(/^极之番\s*·\s*/,''));Fx.ult(e.actorName,e.text);} // 极之番：音效+语音念诵
      // 飘字
      if(e.to){const idx=this.eng.units.findIndex(u=>u.name===e.to);this.floatNum(idx,e.dmg,'');}
      if(e.type==='heal'&&e.from){const idx=this.eng.units.findIndex(u=>u.name===e.from);this.floatNum(idx,e.heal,'heal');}
      this.render();
      // 大字展现（领域/极之番/技能）使用固定时长，不被倍速压缩，保证至少停留约1秒以上
      const bigHold=e.type==='domain'?2200:e.type==='ultcut'?2200:e.type==='skillcut'?1600:null;
      if(bigHold!=null)this.laterFixed(bigHold,next);
      else this.later(e.type==='flash'?420:300,next);
    };
    next();
  },
  /** 按事件类型配战斗音效 */
  sfxFor(e){
    if(e.type==='flash')return SFX.crit();
    if(e.type==='die')return SFX.die();
    if(e.type==='heal')return SFX.heal();
    if(e.type==='hit'&&e.to)return SFX.hit();
  },
  /** 领域展开：全屏超大红字 + 念诵「领域展开·领域名」+ 轰鸣音效 */
  playDomainCut(e){
    SFX.domain();
    SFX.speak(`领域展开，${e.domainName||''}`);
    const ov=$('domainOverlay');if(!ov)return;
    const nm=$('domName'),who=$('domWho');
    if(nm)nm.textContent=(e.domainName||'领域');
    if(who)who.textContent=e.isPlayer?'—— 你 ——':(e.side==='ally'?`队友 · ${e.actorName||''}`:`敌方 · ${e.actorName||''}`);
    ov.classList.remove('show');void ov.offsetWidth;ov.classList.add('show');
    ov.classList.remove('shake');void ov.offsetWidth;ov.classList.add('shake');
    clearTimeout(this._domTimer);
    this._domTimer=setTimeout(()=>ov.classList.remove('show'),2200);
  },
  flashCard(idx){
    if(idx<0)return;
    const side=this.eng.units[idx].side==='ally'?'bfAlly':'bfEnemy';
    const el=$(side).querySelector(`[data-idx="${idx}"]`);
    if(el){el.classList.add('acting');setTimeout(()=>el.classList.remove('acting'),500);}
  },
  floatNum(idx,val,cls){
    if(idx<0||!val)return;
    const u=this.eng.units[idx];const side=u.side==='ally'?'bfAlly':'bfEnemy';
    const el=$(side).querySelector(`[data-idx="${idx}"]`);if(!el)return;
    const f=document.createElement('div');f.className='float-dmg '+cls;
    f.textContent=(cls==='heal'?'+':'-')+val;el.appendChild(f);setTimeout(()=>f.remove(),1000);
  },
  waitInput(){
    this._awaitingInput=true;
    ['actMelee','actTech','actDefend','actFlee'].forEach(id=>{const b=$(id);if(b)b.disabled=false;});
    const p=this.eng.player;
    const hasExtra=!!(p.extraTech&&p.extraTech.domain);
    $('actDomain').disabled=!(p.canDomain&&!p.domainUsed);
    $('actDomain').textContent=p.domainUsed?(hasExtra?'主领域·已展开':'领域·熔断中'):`领域·主｜${p.domainName||'展开'}`;
    const dom2=$('actDomain2');
    if(dom2){dom2.style.display=hasExtra?'':'none';dom2.disabled=!(hasExtra&&!p.extraDomainUsed);
      if(hasExtra)dom2.textContent=p.extraDomainUsed?'副领域·已展开':`领域·副｜${p.extraTech.domain}`;}
    const ultBtn=$('actUlt');
    if(ultBtn){const ultOk=p.canUlt&&!p.ultUsed&&((p.skills&&p.skills.sixEyes)||p.cp>=p.maxCp*0.5);ultBtn.style.display=p.canUlt&&!p.ultUsed?'':'none';ultBtn.disabled=!ultOk;}
    $('bfTip').textContent=this.auto?'自动战斗中……（也可手动点指令接管）':'轮到你的行动——选择指令（可点击敌方头像切换目标）';
    if(this.auto)this.scheduleAuto();
  },
  /** 自动战斗：选择最优目标与指令 */
  autoChoose(){
    const p=this.eng.player,es=this.eng.alive('enemy');
    if(!es.length)return 'defend';
    // 目标：优先血量最低（收割），否则等级最高
    const target=es.slice().sort((a,b)=>(a.hp-b.hp)||(b.li-a.li))[0];
    this.selectedTargetIdx=this.eng.units.indexOf(target);
    const cost=this.eng.techCost(p);
    // 极之番：已学会、本场未用、蓝够半管，且多敌/强敌/敌方血线高时优先释放（一场仅一次）
    if(p.canUlt&&!p.ultUsed&&((p.skills&&p.skills.sixEyes)||p.cp>=p.maxCp*0.5)&&(es.length>=2||es.some(e=>e.li>=7)||target.hp>target.maxHp*0.5))return'ult';
    // 领域：可开且（多敌 / 强敌 / 敌方血线高）；双领域时主已用则自动开副领域
    if(p.canDomain&&((p.skills&&p.skills.sixEyes)||p.cp>=p.maxCp*0.30)&&(es.length>=2||es.some(e=>e.li>=7)||target.hp>target.maxHp*0.6)){
      if(!p.domainUsed)return'domain';
      if(p.extraTech&&p.extraTech.domain&&!p.extraDomainUsed)return'domain2';
    }
    // 残血且缺蓝 -> 防御回蓝
    if(p.hp<p.maxHp*0.28&&p.cp<cost)return'defend';
    if(p.cp>=cost)return Math.random()<0.88?'tech':'melee';
    return Math.random()<0.5?'melee':'defend';
  },
  scheduleAuto(){
    clearTimeout(this._autoTimer);
    const id=this.runId;
    this._autoTimer=setTimeout(()=>{
      if(id!==this.runId)return;
      if(!this.eng||this.eng.ended||!this._awaitingInput)return;
      this.input(this.autoChoose());
    },this.sd(420));
  },
  activateForm(kind){
    const eng=this.eng;if(!eng||eng.ended)return;
    const p=eng.player;if(!p||!p.alive)return;
    if(kind==='amber'){
      if(!this.hasFlagUi(p,'amber')||p.buff.amberActive)return;
      const msg='开启【幻兽琥珀】后，本场战斗结束后（无论胜负）你必定死亡，且本场无法撤退。确认开启？';
      const ok=(typeof window!=='undefined'&&typeof window.confirm==='function')?window.confirm(msg):true;
      if(!ok)return;
      p.buff.amberActive=true;p.amberUsed=true;
      if(eng.cfg&&eng.cfg.player)eng.cfg.player.amberUsed=true;
      this.appendLog({type:'skill',text:'【幻兽琥珀】开启！速度×1.8；战斗结束后你必定死亡，本场无法撤退。'});
    }else if(kind==='lightSpeed'){
      if(!this.hasFlagUi(p,'massKiller')||p.buff.lightSpeedActive)return;
      if(!(eng.lightSpeedAvailable||p.reverse)){
        this.appendLog({type:'info',text:'【亚光速形态】冷却中：连续三次战斗内只能使用一次。'});
        return;
      }
      p.buff.lightSpeedActive=true;p.lightSpeedUsed=true;
      if(eng.cfg&&eng.cfg.player)eng.cfg.player.lightSpeedUsedThisBattle=true;
      this.appendLog({type:'skill',text:'【亚光速形态】开启！速度×2.5，咒力消耗×3，每次行动损失5%最大生命。'});
    }else return;
    this.render();
  },
  async tryFlee(){
    if(!this.eng||this.eng.ended||!this.eng.awaitingPlayer||!this._awaitingInput)return;
    if(this.eng.player&&this.eng.player.buff.amberActive){this.appendLog({type:'info',text:'【幻兽琥珀】已开启，本场战斗无法撤退。'});return;}
    this._awaitingInput=false;clearTimeout(this._autoTimer);
    let success;
    if(this.eng.cfg&&this.eng.cfg.deathmatch){
      const chance=this.eng.escapeChance();
      success=(Game.showWheel?await Game.showWheel({title:'死战 · 撤退轮盘',chance,
        successLabel:'撤退成功',failLabel:'撤退失败',
        note:'成功：进入下一轮，无奖励。失败：继续当前战斗，并消耗本次行动。'}):Math.random()<chance);
    }else{
      success=undefined; // 非死战维持原来的直接判定
    }
    const r=this.eng.flee(success);this.render();
    this.eventsAnim(r.events,()=>{if(r.ended)this.finish(r.result==="win");else this.loop();});
  },
  input(action,opts){
    this._awaitingInput=false;clearTimeout(this._autoTimer);
    ['actMelee','actTech','actDomain','actDomain2','actUlt','actDefend','actFlee','actAmber','actLightSpeed'].forEach(id=>{const b=$(id);if(b)b.disabled=true;});
    if(action==='domain2'){action='domain';opts={forceExtra:true};}
    let r;
    try{r=this.eng.playerAct(action,this.selectedTargetIdx,opts);}
    catch(err){console&&console.error&&console.error('玩家行动异常:',err);return this._battleFail(err);}
    this.render();
    this.eventsAnim(r.events,()=>{
      if(r.ended)return this.finish(r.result==='win');
      if(r.retryInput)return this.waitInput(); // 熔断/缺蓝：不耗回合，重新等待指令
      this.loop();
    });
  },
  finish(win){
    if(this._finished)return;this._finished=true; // 幂等：一场只结算一次，杜绝重复 resolve/跨场误结算
    this.lastResult=this.eng?this.eng.result:null; // 记录 win/lose/flee，供狩猎区分主动撤退与战死
    const id=this.runId;
    (async()=>{
      // 结算台词：玩家胜→敌人败辞+队友胜辞，玩家败→队友败辞+敌人胜辞；主动撤退不播台词
      const list=this.lastResult==='flee'?[]:endQuoteList(this.scene,this.eng.units,win);
      for(const x of list){if(id!==this.runId)return;await Fx.quote(x.who,x.text);}
      this.later(900,()=>{if(id!==this.runId)return;closeModal();this.resolve&&this.resolve(win);this.resolve=null;});
    })();
  }
};

/* ============================ VII-b. 本地对战（局域网 P2P） ============================ */
/** WebRTC DataChannel 封装：纯前端无服务器，通过手动交换 SDP 连接码建立 P2P */
class NetPeer{
  constructor(isHost){
    this.isHost=isHost;this.dc=null;this.pc=null;this._msgCb=[];this._openCb=[];this._closeCb=[];
    this._pendingData=[];
  }
  _initPC(){
    // 局域网优先：用公共STUN确保跨子网也能连，纯内网host候选也能用
    const cfg={iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}]};
    try{this.pc=new RTCPeerConnection(cfg);}catch(e){this.pc=new webkitRTCPeerConnection(cfg);}
    this.pc.ondatachannel=e=>{this._setupDC(e.channel);};
  }
  _setupDC(dc){
    this.dc=dc;
    dc.onopen=()=>{this._openCb.forEach(c=>c());this._pendingData.forEach(d=>{try{dc.send(d);}catch(e){}});this._pendingData=[];};
    dc.onmessage=e=>{try{const m=JSON.parse(e.data);this._msgCb.forEach(c=>c(m));}catch(err){}};
    dc.onclose=()=>this._closeCb.forEach(c=>c());
  }
  /** 等待ICE收集完成（最多3秒），返回包含全部candidate的SDP */
  _waitICE(){
    return new Promise(res=>{
      if(this.pc.iceGatheringState==='complete')return res();
      let done=false;
      const finish=()=>{if(done)return;done=true;this.pc.onicecandidate=null;this.pc.onicegatheringstatechange=null;res();};
      this.pc.onicecandidate=e=>{if(!e.candidate)finish();};
      this.pc.onicegatheringstatechange=()=>{if(this.pc.iceGatheringState==='complete')finish();};
      setTimeout(finish,3000); // 兜底：3秒后强制返回
    });
  }
  /** 房主：创建 offer，返回邀请码（base64） */
  async createOffer(){
    this._initPC();
    this.dc=this.pc.createDataChannel('jjk-vs');
    this._setupDC(this.dc);
    const offer=await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitICE();
    return btoa(JSON.stringify(this.pc.localDescription));
  }
  /** 客户端：接收房主 offer，返回应答码 */
  async acceptOffer(offerStr){
    this._initPC();
    const desc=JSON.parse(atob(offerStr));
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
    const answer=await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._waitICE();
    return btoa(JSON.stringify(this.pc.localDescription));
  }
  /** 房主：接收客户端应答 */
  async acceptAnswer(answerStr){
    const desc=JSON.parse(atob(answerStr));
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
  }
  send(msg){
    const s=JSON.stringify(msg);
    if(this.dc&&this.dc.readyState==='open'){try{this.dc.send(s);}catch(e){this._pendingData.push(s);}}
    else this._pendingData.push(s);
  }
  onMessage(cb){this._msgCb.push(cb);}
  onOpen(cb){this._openCb.push(cb);}
  onClose(cb){this._closeCb.push(cb);}
  close(){try{this.dc&&this.dc.close();this.pc&&this.pc.close();}catch(e){}}
}

/** 本机对战：BroadcastChannel 封装（同设备多标签页自动发现） */
class LocalChannel{
  constructor(roomId){this.ch=new BroadcastChannel('jjk-vs-'+roomId);this._msgCb=[];this._openCb=[];
    this.ch.onmessage=e=>this._msgCb.forEach(c=>c(e.data));
    setTimeout(()=>this._openCb.forEach(c=>c()),50);
  }
  send(msg){try{this.ch.postMessage(msg);}catch(e){}}
  onMessage(cb){this._msgCb.push(cb);}
  onOpen(cb){this._openCb.push(cb);}
  onClose(){}
  close(){this.ch.close();}
}

/** 跨网对战：PeerJS 云信令（自动交换WebRTC信令，房主+多客人 mesh） */
class PeerJSChannel{
  constructor(roomCode,isHost){
    this.roomId='jjk-vs-'+roomCode;
    this.isHost=isHost;
    this.conns={};
    this.selfConn=null;
    this.peer=null;
    this._msgCb=[];this._openCb=[];this._closeCb=[];
    this._ready=false;
    this._guestQueue=[]; // 客人端：连接open前缓存待发消息
    this._connQueue={};  // 房主端：每个连接open前缓存
  }
  async connect(){
    // 等待async加载的PeerJS库就绪（最多3秒）
    for(let i=0;i<30&&typeof Peer==='undefined';i++)await new Promise(r=>setTimeout(r,100));
    if(typeof Peer==='undefined')throw new Error('跨网组件仍在加载，请稍等几秒重试（或改用本机/局域网对战）');
    const ICE={iceServers:[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'},
      {urls:'stun:global.stun.twilio.com:3478'}
    ]};
    return new Promise((res,rej)=>{
      const to=setTimeout(()=>rej(new Error('连接超时（15秒），请检查网络或改用局域网直连')),15000);
      if(this.isHost){
        this.peer=new Peer(this.roomId,{config:ICE});
        this.peer.on('open',()=>{clearTimeout(to);this._ready=true;res();});
        this.peer.on('error',e=>{clearTimeout(to);
          if(e.type==='unavailable-id')rej(new Error('房间码已被占用，请换一个'));
          else if(e.type==='network'||e.type==='server-error')rej(new Error('信令服务器连接失败，请检查网络后重试'));
          else rej(e);
        });
        this.peer.on('connection',conn=>{
          this.conns[conn.peer]=conn;
          this._connQueue[conn.peer]=[];
          this._setupConn(conn);
          conn.on('open',()=>{
            const q=this._connQueue[conn.peer]||[];
            q.forEach(m=>{try{conn.send(m);}catch(e){}});
            this._connQueue[conn.peer]=[];
            this._openCb.forEach(c=>c(conn.peer));
          });
        });
      }else{
        // 客人端：peer-unavailable可能是信令同步延迟，自动重试3次
        let tries=0;
        const startGuest=()=>{
          tries++;
          try{this.peer&&this.peer.destroy();}catch(e){}
          this.peer=new Peer({config:ICE});
          this.peer.on('open',()=>{
            const conn=this.peer.connect(this.roomId,{reliable:true});
            this.selfConn=conn;
            this._setupConn(conn);
            conn.on('open',()=>{
              clearTimeout(to);this._ready=true;
              this._guestQueue.forEach(m=>{try{conn.send(m);}catch(e){}});
              this._guestQueue=[];
              this._openCb.forEach(c=>c());res();
            });
            conn.on('error',e=>{if(tries<3)setTimeout(startGuest,1200);else{clearTimeout(to);rej(e);}});
          });
          this.peer.on('error',e=>{
            if(e.type==='peer-unavailable'){
              if(tries<3)setTimeout(startGuest,1200); // 重试
              else{clearTimeout(to);rej(new Error('房间不存在，请检查房间码（或房主尚未创建完成）'));}
            }else if(tries<3&&(e.type==='network'||e.type==='server-error'||e.type==='socket-error')){
              setTimeout(startGuest,1200);
            }else{clearTimeout(to);rej(e);}
          });
        };
        startGuest();
      }
    });
  }
  _setupConn(conn){
    conn.on('data',data=>this._msgCb.forEach(c=>c(data)));
    conn.on('close',()=>{delete this.conns[conn.peer];delete this._connQueue[conn.peer];this._closeCb.forEach(c=>c(conn.peer));});
  }
  send(msg){
    if(this.isHost){
      Object.values(this.conns).forEach(c=>{
        try{
          if(c.open)c.send(msg);
          else{const k=c.peer;this._connQueue[k]=this._connQueue[k]||[];this._connQueue[k].push(msg);}
        }catch(e){}
      });
    }else{
      if(this.selfConn&&this.selfConn.open){try{this.selfConn.send(msg);}catch(e){this._guestQueue.push(msg);}}
      else this._guestQueue.push(msg);
    }
  }
  sendTo(peerId,msg){
    const c=this.conns[peerId];
    if(!c)return;
    try{if(c.open)c.send(msg);else{this._connQueue[peerId]=this._connQueue[peerId]||[];this._connQueue[peerId].push(msg);}}catch(e){}
  }
  onMessage(cb){this._msgCb.push(cb);}
  onOpen(cb){this._openCb.push(cb);}
  onClose(cb){this._closeCb.push(cb);}
  close(){try{Object.values(this.conns).forEach(c=>c.close());this.selfConn&&this.selfConn.close();this.peer&&this.peer.destroy();}catch(e){}}
}

/** 本地对战主控 */
const VS={
  net:null,isHost:false,myId:null,myName:'玩家',roomId:null,
  players:[], // {id,name,team,char,ready,isHost}
  customChars:[], // 原创角色列表
  customCounter:0,
  selectedChar:null,selectedTeam:null,
  _battleHost:null, // 房主端战斗引擎
  _battleClientState:null, // 客户端收到的状态
  _battleResolve:null,
  _createSteps:null,_createIdx:0,_createResult:{},_createSpinning:false,_createSpeed:2,

  /* ---------- 大厅 ---------- */
  showLobby(){
    hideAllScreens();$('vsLobbyScreen').classList.remove('hidden');
    $('vsOnlineJoinPanel').classList.add('hidden');$('vsLanPanel').classList.add('hidden');
  },
  /** 生成6位数字房间码 */
  _genRoomCode(){return String(Math.floor(100000+Math.random()*900000));},
  /** 跨网对战：房主创建房间（PeerJS云信令，6位码） */
  async createOnlineRoom(){
    const code=this._genRoomCode();
    this.isHost=true;this.myId='host';this.roomId='online-'+code;
    this.onlineMode=true;this.onlineCode=code;this.connected=false;
    this.players=[{id:this.myId,name:'房主',team:'red',char:null,ready:false,isHost:true}];
    try{
      this.net=new PeerJSChannel(code,true);
      this.net.onMessage(m=>this._onMessage(m));
      this.net.onOpen(guestId=>{
        // 新客人连接：发welcome + 主动广播房间状态（双保险，确保老玩家看到新玩家）
        this.net.sendTo(guestId,{type:'welcome',id:guestId,assignedTeam:'blue'});
        this._broadcastRoom();
        this._updateConnUI();
      });
      await this.net.connect();
      this.connected=true;
      this._enterRoom();
    }catch(e){alert('跨网房间创建失败：'+e.message+'\n请检查网络，或改用局域网直连模式');this.leaveRoom();}
  },
  /** 跨网对战：客人加入房间 */
  async joinOnlineRoom(code){
    code=(code||'').trim();
    if(!code||code.length!==6||!/^\d{6}$/.test(code)){alert('请输入6位数字房间码');return;}
    this.isHost=false;this.myId='guest-'+Math.random().toString(36).slice(2,8);
    this.onlineMode=true;this.onlineCode=code;this.connected=false;
    this.players=[{id:this.myId,name:'玩家',team:'blue',char:null,ready:false,isHost:false}];
    try{
      this.net=new PeerJSChannel(code,false);
      this.net.onMessage(m=>this._onMessage(m));
      this.net.onOpen(()=>{
        this.connected=true;
        this.net.send({type:'hello',id:this.myId,name:'玩家'});
        this._updateConnUI();
      });
      this._enterRoom(); // 先进入房间显示"连接中"
      await this.net.connect();
    }catch(e){alert('加入房间失败：'+e.message);this.leaveRoom();}
  },
  async createRoom(){
    this.isHost=true;this.myId='host';this.roomId='room-'+Date.now();
    this.connected=false;this.inviteCode='';
    this.players=[{id:this.myId,name:'房主',team:'red',char:null,ready:false,isHost:true}];
    try{
      this.net=new NetPeer(true);
      this.net.onOpen(()=>this._onPeerConnected());
      this.net.onMessage(m=>this._onMessage(m));
      const code=await this.net.createOffer();
      this.inviteCode=code;
      // 直接进入房间，邀请码在房内显示
      this._enterRoom();
    }catch(e){alert('WebRTC 初始化失败：'+e.message);}
  },
  async joinRoom(){
    $('vsJoinPanel').classList.remove('hidden');
  },
  async doJoin(){
    const code=$('vsInviteCode').value.trim();
    if(!code){alert('请输入邀请码');return;}
    this.isHost=false;this.myId='guest-'+Math.random().toString(36).slice(2,8);
    this.connected=false;this.guestAnswer='';
    try{
      this.net=new NetPeer(false);
      this.net.onOpen(()=>this._onPeerConnected());
      this.net.onMessage(m=>this._onMessage(m));
      const answer=await this.net.acceptOffer(code);
      this.guestAnswer=answer;
      // 自动复制应答码到剪贴板
      try{const ta=document.createElement('textarea');ta.value=answer;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}catch(e){}
      // 直接进入房间，显示应答码等待房主输入
      this.players=[{id:this.myId,name:'玩家',team:'blue',char:null,ready:false,isHost:false}];
      this._enterRoom();
    }catch(e){alert('邀请码无效或连接失败：'+e.message);}
  },
  /** 房主在房间内粘贴客人应答码，建立连接 */
  async doRoomAnswer(){
    const ans=$('vsRoomAnswerInput').value.trim();
    if(!ans){alert('请输入客人的应答码');return;}
    try{
      await this.net.acceptAnswer(ans);
      $('vsRoomAnswerInput').value='';
    }catch(e){alert('应答码无效：'+e.message);}
  },
  /** 本机对战：房主开房间（BroadcastChannel） */
  localHost(){
    this.isHost=true;this.myId='host';this.roomId='local-'+Math.random().toString(36).slice(2,6);
    this.localMode=true;this.connected=false;
    this.net=new LocalChannel(this.roomId);
    this.net.onMessage(m=>this._onMessage(m));
    this.net.onOpen(()=>{
      this.connected=true;
      this.players=[{id:this.myId,name:'玩家1(房主)',team:'red',char:null,ready:false,isHost:true}];
      this._enterRoom();
      this._broadcastRoom();
    });
    alert('本机房间已创建。房间ID：'+this.roomId+'\n请在新标签页打开同一HTML文件，选择"本机对战→加入房间"，输入此ID。');
  },
  localJoin(){
    const id=prompt('输入房间ID：');
    if(!id)return;
    this.isHost=false;this.myId='guest-'+Math.random().toString(36).slice(2,8);
    this.roomId=id;this.localMode=true;this.connected=false;
    this.net=new LocalChannel(id);
    this.net.onMessage(m=>this._onMessage(m));
    this.net.onOpen(()=>{
      this.connected=true;
      this.net.send({type:'hello',id:this.myId,name:'玩家'});
    });
  },

  _onPeerConnected(){
    this.connected=true;
    if(this.isHost){
      // 房主：连接建立后，等客人发 hello
      this._updateConnUI();
    }else{
      // 客人：连接建立，发 hello 给房主
      this.net.send({type:'hello',id:this.myId,name:'玩家'});
      this._updateConnUI();
    }
  },

  _onMessage(m){
    try { m = sanitizePeerMessage(m); } catch { return; }
    switch(m.type){
      case 'hello':
        if(this.isHost){
          let p=this.players.find(x=>x.id===m.id);
          if(!p){
            p={id:m.id,name:m.name||'玩家',team:'blue',char:null,ready:false,isHost:false};
            this.players.push(p);
          }
          this.net.send({type:'welcome',id:m.id,assignedTeam:p.team});
          this._broadcastRoom();
        }
        break;
      case 'welcome':
        if(!this.isHost){
          this.selectedTeam=m.assignedTeam||'blue';
          const myP=this.players.find(p=>p.id===this.myId);
          if(myP){myP.team=this.selectedTeam;
            if(myP.char)this.net.send({type:'selectChar',id:this.myId,char:myP.char});
          }
          this._renderRoom();
        }
        break;
      case 'roomState':
        if(!this.isHost){
          // 兜底：确保自己在玩家列表中（防止房主广播时序导致自己丢失）
          let list=(m.players||[]).slice();
          if(!list.find(x=>x.id===this.myId)){
            const me=this.players.find(x=>x.id===this.myId)||{id:this.myId,name:'玩家',team:'blue',char:null,ready:false,isHost:false};
            list.push(me);
          }
          this.players=list;this._renderRoom();
        }
        break;
      case 'joinTeam':
        if(this.isHost){const p=this.players.find(x=>x.id===m.id);if(p){p.team=m.team;this._broadcastRoom();}}
        break;
      case 'selectChar':
        if(this.isHost){const p=this.players.find(x=>x.id===m.id);if(p){p.char=m.char;this._broadcastRoom();}}
        break;
      case 'ready':
        if(this.isHost){const p=this.players.find(x=>x.id===m.id);if(p){p.ready=m.ready;this._broadcastRoom();this._checkStart();}}
        break;
      case 'startBattle':
        if(!this.isHost){this._ensureClientBattle();}
        break;
      case 'battleState':
        if(!this.isHost){this._onBattleState(m);}
        break;
      case 'battleAction':
        if(this.isHost&&this._battleHost){this._battleHost.onClientAction(m);}
        break;
      case 'surrender':
        if(this.isHost&&this._battleHost){this._battleHost.applySurrender(m.playerId);}
        break;
      case 'abortBattle':
        // 房主解散战斗：所有客户端回房间
        if(!this.isHost){this._abortToRoom();}
        break;
      case 'battleEnd':
        if(!this.isHost){this._onBattleEnd(m);}
        break;
    }
  },

  _broadcastRoom(){if(this.isHost&&this.net)this.net.send({type:'roomState',players:this.players});},
  /** 客户端创建假eng（startBattle丢失时由battleState兜底调用） */
  _ensureClientBattle(){
    if(this._clientEng)return;
    this._clientEng={
      units:[],events:[],player:{},lastActor:null,
      awaitingPlayer:false,ended:false,
      techCost:(p)=>p?Math.max(0,p.cost||0):0,
      previewOrder:function(n,first){
        const alive=this.units.filter(u=>u.alive);
        alive.sort((a,b)=>(b.atb||0)-(a.atb||0));
        if(first){const i=alive.indexOf(first);if(i>0){alive.splice(i,1);alive.unshift(first);}}
        return alive.slice(0,n);
      },
      cfg:{versus:true,player:{blackFlash:false}}
    };
    this._showBattleModal('本地对战',this._clientEng);
  },

  /** 更新连接状态UI */
  _updateConnUI(){
    const hostBox=$('vsHostConnBox'),guestBox=$('vsGuestConnBox');
    const onlineHost=$('vsOnlineHostBox'),onlineGuest=$('vsOnlineGuestBox');
    // 先全部隐藏
    hostBox.classList.add('hidden');guestBox.classList.add('hidden');
    onlineHost.classList.add('hidden');onlineGuest.classList.add('hidden');
    if(this.onlineMode){
      if(this.isHost){
        onlineHost.classList.remove('hidden');
        $('vsOnlineCodeDisplay').textContent=this.onlineCode||'------';
        const guestCount=this.players.length-1;
        $('vsOnlineHostStatus').textContent=guestCount>0?`已连接 ${guestCount} 位玩家，等待更多人加入…`:'等待玩家加入…';
      }else{
        onlineGuest.classList.remove('hidden');
        $('vsOnlineGuestStatus').textContent=this.connected?'✅ 已连接到房间！':'⏳ 正在连接房间…';
      }
    }else if(this.localMode){
      // 本机对战：不显示连接信息
    }else if(this.isHost){
      hostBox.classList.remove('hidden');
      $('vsRoomInviteCode').value=this.inviteCode||'';
    }else{
      guestBox.classList.remove('hidden');
      $('vsGuestAnswerCode').value=this.guestAnswer||'';
      $('vsGuestConnText').textContent=this.connected?'✅ 已连接到房间！':'⏳ 确认码已复制到剪贴板，请发给房主，等待房主连接…';
    }
    $('vsConnStatus').textContent=this.connected?'✅ 已连接':'⏳ 等待连接…';
    $('vsConnStatus').style.color=this.connected?'#60e890':'#ffc060';
  },

  _enterRoom(){
    hideAllScreens();$('vsRoomScreen').classList.remove('hidden');
    $('vsRoomName').textContent=this.roomId;
    this._updateConnUI();
    this._renderRoom();
    this._renderCharPicker();
    // 第三方及以后：显示队伍选择
    const myP=this.players.find(p=>p.id===this.myId);
    if(this.players.length>=3||!myP){
      $('vsTeamPick').classList.remove('hidden');
    }else{
      $('vsTeamPick').classList.add('hidden');
      this.selectedTeam=myP?myP.team:'blue';
    }
    this._updateReadyBtn();
  },

  _renderRoom(){
    const red=this.players.filter(p=>p.team==='red');
    const blue=this.players.filter(p=>p.team==='blue');
    const renderSlot=(p)=>p?`<div class="vs-slot">
      <span class="vs-name">${p.name}${p.isHost?' 👑':''}${p.id===this.myId?' (你)':''}</span>
      <span style="font-size:11px;color:var(--txt3)">${p.char?(p.char.isCustom?p.char.name:p.char.name):'未选角色'}</span>
      <span class="vs-ready-tag ${p.ready?'ready':'notready'}">${p.ready?'已准备':'未准备'}</span>
    </div>`:'<div class="vs-slot empty">空位</div>';
    $('vsRedList').innerHTML=red.map(renderSlot).join('')+(red.length<4?'<div class="vs-slot empty">空位</div>':'');
    $('vsBlueList').innerHTML=blue.map(renderSlot).join('')+(blue.length<4?'<div class="vs-slot empty">空位</div>':'');
    $('vsPlayerCount').textContent=this.players.length+'/999 玩家';
    this._updateReadyBtn();
  },

  _renderCharPicker(){
    const grid=$('vsNpcGrid');
    // 显示全部固有NPC，按名称分组去重（同名不同等级取最高等级）
    const nameMap={};
    Object.keys(NPC_CHARS).forEach(k=>{
      const name=k.split('#')[0];
      const li=parseInt(k.split('#')[1])||0;
      if(!nameMap[name]||li>nameMap[name].li)nameMap[name]={key:k,li};
    });
    const npcs=Object.values(nameMap).sort((a,b)=>b.li-a.li).map(x=>x.key);
    grid.innerHTML=npcs.map(k=>{
      const name=k.split('#')[0];
      const spec=NPC_CHARS[k];
      const tech=spec[5]||'无';
      return `<div class="vs-npc-item" data-npckey="${k}">
        <div class="nname">${name}</div>
        <div class="ninfo">${LEVELS[spec[0]]||'?'}·${tech?'术式':'无术式'}</div>
      </div>`;
    }).join('');
    grid.querySelectorAll('.vs-npc-item').forEach(el=>{
      el.onclick=()=>{
        grid.querySelectorAll('.vs-npc-item').forEach(x=>x.classList.remove('on'));
        el.classList.add('on');
        const key=el.dataset.npckey;
        this.selectedChar={isCustom:false,name:key.split('#')[0],npcKey:key};
        this._sendSelectChar();
      };
    });
    // 原创角色列表
    this._renderCustomList();
  },

  _renderCustomList(){
    const list=$('vsCustomList');
    if(this.customChars.length===0){
      list.innerHTML='<div class="vs-custom-empty">尚未创建原创角色</div><button class="btn" id="vsCreateChar">＋ 创建原创角色（14连抽）</button>';
    }else{
      list.innerHTML=this.customChars.map((c,i)=>`<div class="vs-custom-item" data-cidx="${i}">
        <span style="font-weight:700">${c.name}</span>
        <span style="font-size:11px;color:var(--txt3)">${c.techniqueName||'?'}·${LEVELS[c.cpTier]||'?'}</span>
      </div>`).join('')+'<button class="btn" id="vsCreateChar" style="margin-top:8px">＋ 再创建一个</button>';
      list.querySelectorAll('.vs-custom-item').forEach(el=>{
        el.onclick=()=>{
          list.querySelectorAll('.vs-custom-item').forEach(x=>x.classList.remove('on'));
          el.classList.add('on');
          const idx=+el.dataset.cidx;
          this.selectedChar={isCustom:true,...this.customChars[idx]};
          this._sendSelectChar();
        };
      });
    }
    const btn=$('vsCreateChar');if(btn)btn.onclick=()=>this.startCreateChar();
  },

  _sendSelectChar(){
    const p=this.players.find(x=>x.id===this.myId);
    if(p)p.char=this.selectedChar;
    if(this.isHost)this._broadcastRoom();
    else this.net.send({type:'selectChar',id:this.myId,char:this.selectedChar});
    this._renderRoom();
  },

  joinTeam(team){
    this.selectedTeam=team;
    const p=this.players.find(x=>x.id===this.myId);
    if(p)p.team=team;
    if(this.isHost)this._broadcastRoom();
    else this.net.send({type:'joinTeam',id:this.myId,team});
    this._renderRoom();
  },

  toggleReady(){
    if(!this.connected){alert('等待连接建立后才能准备');return;}
    const p=this.players.find(x=>x.id===this.myId);
    if(!p||!p.char){alert('请先选择角色');return;}
    p.ready=!p.ready;
    if(this.isHost){this._broadcastRoom();this._checkStart();}
    else this.net.send({type:'ready',id:this.myId,ready:p.ready});
    this._renderRoom();
  },

  _checkStart(){
    if(!this.isHost)return;
    const allReady=this.players.length>=2&&this.players.every(p=>p.ready&&p.char);
    const hasRed=this.players.some(p=>p.team==='red');
    const hasBlue=this.players.some(p=>p.team==='blue');
    const btn=$('vsStartBattle');
    if(allReady&&hasRed&&hasBlue){btn.classList.remove('hidden');}
    else btn.classList.add('hidden');
  },

  startBattle(){
    if(!this.isHost)return;
    const red=this.players.filter(p=>p.team==='red');
    const blue=this.players.filter(p=>p.team==='blue');
    const fakePlayer={identity:'人类',age:18,gender:'男',face:'C',technique:{flag:null,name:'无',domain:'无',flags:[]},cpTier:0,ctlTier:0,meleeTier:0,hpTier:0,effTier:0,growth:0,growthMult:1,levelIndex:0,maxHp:100,maxCp:100,melee:[5,10],eff:[5,10],ctl:5,reverse:false,blackFlash:false,domainLearned:false,ultimateLearned:false,prof:0,sixEyes:false,jinTools:null,stolenTechs:[],absorbed:[],statBoost:{},isVillain:false,arc:'main',notes:[],name:'tmp'};
    const eng=new BattleEngine({player:fakePlayer,allies:[],enemies:[],versus:true});
    eng.units=[];eng.player=null;
    const allChars=[...red.map(p=>({p,side:'ally'})),...blue.map(p=>({p,side:'enemy'}))];
    const controllerMap={};
    allChars.forEach(({p,side})=>{
      const u=this._charToUnit(p.char,side);
      if(!u)return;
      u.controllerId=p.id;u.isPlayer=true;
      controllerMap[p.id]=u.name;
      eng.units.push(u);
    });
    eng.player=eng.units[0];
    eng.events=[];eng.ended=false;eng.result=null;eng.actionsTotal=0;eng.lastActor=null;eng.awaitingPlayer=false;
    // 重新执行进战召唤（构造时units被清空，需手动补召唤：傀儡操术傀儡/黑鸟操术乌鸦/十影宿傩魔虚罗）
    eng.units.filter(u=>u.alive).forEach(u=>{
      if(u.hasFlag('crows')){for(let i=0;i<3;i++)eng.addSummon(u,'乌鸦式神',0.30,'式神');}
      if(u.hasFlag('puppet'))eng.addSummon(u,'傀儡',0.70,'傀儡');
      if(u.skills&&u.skills.summonMakora)eng.addSummon(u,'魔虚罗·式神',1.0,'式神',{specName:'魔虚罗',specLi:10});
    });
    const config={title:'本地对战',versus:true};
    this.net.send({type:'startBattle',config});
    // 房主端也显示 BattleUI 完整界面
    this._showBattleModal('本地对战',eng);
    this._battleHost=new VSHostBattle(eng,this.players,this.net,controllerMap,()=>this._updateBattleButtons());
    this._battleHost.run().then(()=>{
      this.net.send({type:'battleEnd',result:eng.result});
      this._battleHost=null;
      this.players.forEach(p=>p.ready=false);
      this._broadcastRoom();
      try{closeModal();}catch(e){}
      this._enterRoom();
    });
  },

  _fakePlayer(){return {identity:'人类',age:18,gender:'男',face:'C',technique:{flag:null,name:'无',domain:'无',flags:[]},cpTier:0,ctlTier:0,meleeTier:0,hpTier:0,effTier:0,growth:0,growthMult:1,levelIndex:0,maxHp:100,maxCp:100,melee:[5,10],eff:[5,10],ctl:5,reverse:false,blackFlash:false,domainLearned:false,ultimateLearned:false,prof:0,sixEyes:false,jinTools:null,stolenTechs:[],absorbed:[],statBoost:{},isVillain:false,arc:'main',notes:[],name:'tmp'};},

  _charToUnit(char,side){
    const tmpEng=new BattleEngine({player:this._fakePlayer(),allies:[],enemies:[]});
    let u;
    if(char.isCustom){
      u=this._customToUnit(char,side,tmpEng);
    }else{
      const spec=NPC_CHARS[char.npcKey];
      if(!spec)return null;
      // 必须用npcKey里#后的综合等级查找，才能让getCharSpec精确命中spec（spec[0]是咒力总量等级，可能不一致）
      const li=parseInt(String(char.npcKey).split('#')[1])||spec[0];
      u=tmpEng.makeNpcUnit(char.name,li,'咒术师',side);
    }
    if(!u)return null;
    // 本地对战专属数值调整
    if(u.name==='五条悟'){u.maxHp=8000000;u.hp=8000000;}
    else if(u.name==='十影宿傩'){u.maxHp=10000000;u.hp=10000000;}
    return u;
  },

  _customToUnit(c,side,tmpEng){
    const cp=tierMidCp(c.cpTier),ctl=tierMidCtl(c.ctlTier),me=tierMidDmg(c.meleeTier),eff=tierMidDmg(c.effTier);
    const hpRange=npcHpRange(c.hpTier);
    const maxHp=Math.round((hpRange[0]+hpRange[1])/2);
    const flag=c.technique||null;
    const u=tmpEng.decorate({
      name:c.name,li:c.cpTier,type:'原创角色',side,isPlayer:false,
      maxHp,hp:maxHp,maxCp:cp,cp:cp,melee:me,eff:eff,ctl,
      atb:randF(0,8),speed:Math.round((cp+me[0]+eff[0]+ctl)/4+maxHp/200+10),
      reverse:!!c.reverse,bf:c.blackFlash?1:0,
      canDomain:!!c.domain,domainUsed:0,domainCd:0,flag,
      flags:flag?[flag]:[],
      techName:flag?tmpEng.techLabel(flag):'咒力',
      domainName:flag?(TECH_DOMAIN[flag]||'领域'):'领域',
      canUlt:!!c.ultimate,ultUsed:false,
      skills:{sixEyes:0,charge:0,adapt:0,regen:0,summonMakora:0,chargeSlash:null,spaceSlash:null,tools:null},
      alive:true
    });
    return u;
  },

  /* ---------- 战斗界面（复用 BattleUI 完整 UI） ---------- */
  _showBattleModal(title,eng){
    this._battleIsHost=!!this.isHost;
    BattleUI.runId++;BattleUI._clearTimers();
    BattleUI.eng=eng;BattleUI.selectedTargetIdx=null;BattleUI.actingIdx=null;BattleUI.scene=null;
    showModal(`
      <h2 style="letter-spacing:1px;font-size:18px">${title||'战 斗'}</h2>
      <div class="seq-wrap">
        <div class="seq-cap"><span>行动序列 · 速度决定行动条推进</span><span>1×（对战固定）</span></div>
        <div class="seq-axis" id="boOrder"></div>
      </div>
      <div class="battle-field">
        <div class="side-col ally"><h4>红方</h4><div id="bfAlly"></div></div>
        <div class="side-col enemy"><h4>蓝方（点击头像选择攻击目标）</h4><div id="bfEnemy"></div></div>
      </div>
      <div class="battle-log" id="bfLog"></div>
      <div class="battle-tip" id="bfTip"></div>
      <div class="battle-actions" id="bfActions">
        <button class="btn small" id="actMelee">体 术 攻 击</button>
        <button class="btn small" id="actTech">咒 力 术 式</button>
        <button class="btn small" id="actDomain">领 域 展 开</button>
        <button class="btn small" id="actUlt" style="display:none">极 之 番</button>
        <button class="btn small ghost" id="actDefend">防 御</button>
      </div>
      <div class="battle-actions" id="bfSigActions" style="margin-top:2px;display:none;flex-wrap:wrap"></div>
      <div class="battle-actions" style="margin-top:6px;justify-content:flex-end;gap:8px">
        <button class="btn small" id="vsSurrender" style="border-color:rgba(255,138,149,.5);color:#ff8a95;background:rgba(255,138,149,.08)">投 降（角色阵亡·可观战）</button>
        <button class="btn small ghost" id="vsQuitBattle">退出战斗（回房间等待）</button>
      </div>`);
    $('modalMask').scrollTop=0;
    if(eng.events&&eng.events.length)eng.events.forEach(e=>BattleUI.appendLog(e));
    const doAct=(action)=>{
      SFX.click();
      if(this._battleIsHost&&this._battleHost){
        const actor=eng.lastActor;
        if(!actor||actor.controllerId!==this.myId||!eng.awaitingPlayer)return;
        this._battleHost._pendingAction=action; // 统一由_loop处理，秒响应
      }else{
        this._sendAction(action);
      }
    };
    $('actMelee').onclick=()=>doAct('melee');
    $('actTech').onclick=()=>doAct('tech');
    $('actDomain').onclick=()=>doAct('domain');
    $('actUlt').onclick=()=>doAct('ult');
    $('actDefend').onclick=()=>doAct('defend');
    // 专属技能按钮走同一个doAct（避免走BattleUI单机循环导致卡死）
    BattleUI.externalInput=(act)=>doAct(act);
    const bSurr=$('vsSurrender');if(bSurr)bSurr.onclick=()=>{SFX.click();this._surrender();};
    const bQuit=$('vsQuitBattle');if(bQuit)bQuit.onclick=()=>{SFX.click();this._quitBattle();};
    BattleUI.render();
    this._updateBattleButtons();
  },

  _updateBattleButtons(){
    const eng=BattleUI.eng;if(!eng)return;
    const actor=eng.lastActor;
    const isMyTurn=eng.awaitingPlayer&&!eng.ended&&actor&&actor.controllerId===this.myId;
    ['actMelee','actTech','actDomain','actUlt','actDefend'].forEach(id=>{
      const b=$(id);if(b)b.disabled=!isMyTurn;
    });
    // 专属技能按钮只在自己回合启用；主动反转满血时禁用（避免无意义操作）
    const sigBox=$('bfSigActions');
    if(sigBox)sigBox.querySelectorAll('button').forEach(b=>{
      let enable=isMyTurn;
      if(b.dataset.act==='sig_reverse'&&actor&&actor.hp>=actor.maxHp)enable=false;
      b.disabled=!enable;
    });
    // 自己控制的单位全部阵亡后（已投降/被击败），禁用投降按钮，仅观战
    const myUnits=eng.units.filter(u=>u.controllerId===this.myId);
    const myAllDown=myUnits.length>0&&myUnits.every(u=>!u.alive);
    const bSurr=$('vsSurrender');if(bSurr)bSurr.disabled=!!eng.ended||myAllDown;
    const tip=$('bfTip');if(tip){
      if(eng.ended)tip.textContent='战斗结束';
      else if(myAllDown)tip.textContent='你的角色已倒下——继续观战中，也可点【退出战斗】回房间等待';
      else if(isMyTurn)tip.textContent='轮到你的角色行动——选择指令（10秒未选将自动出手）';
      else tip.textContent='等待其他玩家…';
    }
  },

  _onBattleState(m){
    if(!this._clientEng)this._ensureClientBattle(); // 兜底：startBattle丢失也能进战斗
    const eng=this._clientEng;if(!eng)return;
    const oldLen=(eng.events||[]).length;
    eng.units=m.units||[];
    eng.events=m.events||[];
    eng.ended=!!m.ended;
    eng.awaitingPlayer=!!m.needInput;
    if(m.currentActor){
      eng.lastActor=eng.units.find(u=>u.name===m.currentActor.name)||null;
    }else eng.lastActor=null;
    // 找到自己控制的单位作为 player
    const myP=this.players.find(p=>p.id===this.myId);
    if(myP){
      eng.player=eng.units.find(u=>u.controllerId===myP.id)||eng.units[0]||{};
    }else eng.player=eng.units[0]||{};
    // 追加新事件到战斗日志
    if(eng.events.length>oldLen){
      const newEv=eng.events.slice(oldLen);
      try{newEv.forEach(e=>BattleUI.appendLog(e));}catch(e){}
      // 播放技能/领域/极之番大字
      newEv.forEach(e=>{
        if(e.type==='domain'){try{BattleUI.playDomainCut&&BattleUI.playDomainCut(e);}catch(x){}}
        else if(e.type==='ultcut'){try{SFX.ult&&SFX.ult();Fx.ult&&Fx.ult(e.actorName||'',e.text);}catch(x){}}
        else if(e.type==='skillcut'){try{SFX.skill&&SFX.skill();Fx.skill&&Fx.skill(e.actorName||'',e.text||'');}catch(x){}}
      });
    }
    try{BattleUI.render();}catch(e){}
    this._updateBattleButtons();
  },

  _onBattleEnd(m){
    if(this._clientEng)this._clientEng.ended=true;
    try{BattleUI.render();}catch(e){}
    setTimeout(()=>{
      try{closeModal();}catch(e){}
      this._clientEng=null;
      this._enterRoom();
    },1500);
  },

  _sendAction(action){
    this.net.send({type:'battleAction',playerId:this.myId,action});
  },

  /** 投降：自己角色立即HP归0，但留在战斗界面继续观战 */
  _surrender(){
    if(!confirm('确定投降吗？你的角色将立即生命值归零，但你可以继续观战。'))return;
    if(this.isHost&&this._battleHost){this._battleHost.applySurrender(this.myId);}
    else if(this.net){this.net.send({type:'surrender',playerId:this.myId});}
  },
  /** 退出战斗：自己角色按投降处理，本地关闭战斗界面回房间，等待其他玩家打完 */
  _quitBattle(){
    if(!confirm('确定退出本场战斗吗？你将回到房间，等待其他玩家结束。'))return;
    if(this.isHost){
      // 房主是权威：房主退出则解散本场战斗，所有人回房间（避免无人推进导致卡死）
      if(this._battleHost){
        try{this._battleHost.eng.ended=true;}catch(e){}
        this.net.send({type:'abortBattle'});
        this._battleHost=null;
      }
      this._abortToRoom();
    }else{
      // 客户端：自己单位投降（房主继续推进），本地回房间
      try{this.net.send({type:'surrender',playerId:this.myId});}catch(e){}
      this._abortToRoom();
    }
  },
  /** 关闭战斗弹窗、清理客户端战斗状态、回到房间 */
  _abortToRoom(){
    this._clientEng=null;
    this._battleIsHost=false;
    try{closeModal();}catch(e){}
    try{this.players.forEach(p=>{/*保留准备状态，由房主战斗结束后统一重置*/});}catch(e){}
    this._enterRoom();
  },

  /* ---------- 创建原创角色（14连抽） ---------- */
  _buildCreateSteps(){
    return [
      {key:'identity',title:'初始身份',items:WHEEL_IDENTITY.map(x=>({label:x.label,weight:x.weight||1}))},
      {key:'age',title:'年龄',items:WHEEL_AGE.map(x=>({label:x.label,weight:1}))},
      {key:'gender',title:'性别',items:WHEEL_GENDER.map(x=>({label:x.label,weight:1}))},
      {key:'face',title:'颜值',items:WHEEL_FACE.map(x=>({label:x.label,weight:1}))},
      {key:'technique',title:'生得术式',items:WHEEL_TECHNIQUE.map(x=>({label:x.label,weight:1,flag:x.flag}))},
      {key:'cpTier',title:'咒力总量',items:CP_TIERS.map((x,i)=>({label:x,weight:TIER_W[i]||1,idx:i}))},
      {key:'ctlTier',title:'咒力操控',items:CTL_TIERS.map((x,i)=>({label:x,weight:TIER_W[i]||1,idx:i}))},
      {key:'meleeTier',title:'体术水平',items:DMG_TIERS.map((x,i)=>({label:x,weight:TIER_W[i]||1,idx:i}))},
      {key:'hpTier',title:'体质水平',items:HP_TIERS.map((x,i)=>({label:x,weight:1,idx:i}))},
      {key:'effTier',title:'咒力效率',items:DMG_TIERS.map((x,i)=>({label:x,weight:TIER_W[i]||1,idx:i}))},
      {key:'blackFlash',title:'是否学会黑闪',items:[{label:'是',weight:1,val:true},{label:'否',weight:1,val:false}]},
      {key:'domain',title:'是否学会领域',items:[{label:'是',weight:1,val:true},{label:'否',weight:1,val:false}]},
      {key:'reverse',title:'是否学会反转术式',items:[{label:'是',weight:1,val:true},{label:'否',weight:1,val:false}]},
      {key:'ultimate',title:'是否学会极之番',items:[{label:'是',weight:1,val:true},{label:'否',weight:1,val:false}]},
    ];
  },
  startCreateChar(){
    this._createSteps=this._buildCreateSteps();
    this._createIdx=0;this._createResult={};
    hideAllScreens();$('vsCreateScreen').classList.remove('hidden');
    this._drawCreateWheel();
    $('vsNextWheel').classList.add('hidden');$('vsConfirmChar').classList.add('hidden');$('vsSpin').classList.remove('hidden');$('vsQuickCreate')&&$('vsQuickCreate').classList.remove('hidden');
  },
  /** 一键创建：瞬间按权重摇完14项并直接生成角色 */
  quickCreateChar(){
    if(this._createSpinning)return;
    this._createSteps=this._buildCreateSteps();
    this._createResult={};
    this._createSteps.forEach((step,i)=>{
      const idx=weightedIndex(step.items.map(x=>x.weight||1));
      const item=step.items[idx];
      if(item.flag!==undefined)this._createResult[step.key]=item.flag;
      else if(item.idx!==undefined)this._createResult[step.key]=item.idx;
      else if(item.val!==undefined)this._createResult[step.key]=item.val;
      else this._createResult[step.key]=item.label;
      if(step.key==='technique')this._createResult.techniqueName=item.label;
    });
    this._createIdx=this._createSteps.length-1;
    SFX.spinStart&&SFX.spinStart();
    this.confirmCreateChar();
  },

  _drawCreateWheel(){
    const step=this._createSteps[this._createIdx];
    $('vsStepIdx').textContent=this._createIdx+1;
    $('vsWheelTitle').textContent=step.title;
    const canvas=$('vsWheelCanvas');const ctx=canvas.getContext('2d');
    const n=step.items.length;const cx=250,cy=250,r=230;
    ctx.clearRect(0,0,500,500);
    const colors=['#3d2670','#5a2d8a','#7a3da8','#4a1f6e','#6a2d9a','#2d1a5a'];
    step.items.forEach((it,i)=>{
      const a0=(i/n)*Math.PI*2-Math.PI/2;
      const a1=((i+1)/n)*Math.PI*2-Math.PI/2;
      ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a0,a1);ctx.closePath();
      ctx.fillStyle=colors[i%colors.length];ctx.fill();ctx.strokeStyle='rgba(255,255,255,.2)';ctx.stroke();
      ctx.save();ctx.translate(cx,cy);ctx.rotate((a0+a1)/2);
      ctx.fillStyle='#fff';ctx.font=`${n>10?11:14}px sans-serif`;ctx.textAlign='right';
      ctx.fillText(String(it.label).slice(0,6),r-15,5);ctx.restore();
    });
    $('vsWheelLegend').innerHTML=step.items.map((it,i)=>`<span style="display:inline-block;margin:2px 6px;font-size:11px;color:var(--txt2)">${it.label}</span>`).join('');
    $('vsWheelResult').textContent='点击抽取，决定你的'+step.title+'……';
  },

  doSpin(){
    if(this._createSpinning)return;
    this._createSpinning=true;
    const step=this._createSteps[this._createIdx];
    const idx=weightedIndex(step.items.map(x=>x.weight||1));
    const item=step.items[idx];
    const n=step.items.length;
    const targetAngle=360-(idx/n)*360-(360/n/2);
    const spins=5+Math.random()*3;
    const totalAngle=spins*360+targetAngle;
    const duration=3000/this._createSpeed;
    const canvas=$('vsWheelCanvas');
    canvas.style.transition=`transform ${duration}ms cubic-bezier(.17,.67,.12,.99)`;
    canvas.style.transform=`rotate(${totalAngle}deg)`;
    SFX.spinStart&&SFX.spinStart();
    setTimeout(()=>{
      this._createSpinning=false;
      canvas.style.transition='none';canvas.style.transform=`rotate(${targetAngle}deg)`;
      // 记录结果
      const key=step.key;
      if(item.flag!==undefined)this._createResult[key]=item.flag;
      else if(item.idx!==undefined)this._createResult[key]=item.idx;
      else if(item.val!==undefined)this._createResult[key]=item.val;
      else this._createResult[key]=item.label;
      if(key==='technique')this._createResult.techniqueName=item.label;
      $('vsWheelResult').innerHTML=`【${step.title}】抽取结果：<b style="color:#ffd24a">${item.label}</b>`;
      this._updateCreateAttrList();
      $('vsSpin').classList.add('hidden');
      if(this._createIdx<this._createSteps.length-1){
        $('vsNextWheel').classList.remove('hidden');
      }else{
        $('vsConfirmChar').classList.remove('hidden');
      }
    },duration+50);
  },

  _updateCreateAttrList(){
    const list=$('vsAttrList');
    const rows=this._createSteps.slice(0,this._createIdx+1).map(s=>{
      const v=this._createResult[s.key];
      let label=v;
      if(s.key==='cpTier'||s.key==='ctlTier')label=CP_TIERS[v];
      else if(s.key==='meleeTier'||s.key==='effTier')label=DMG_TIERS[v];
      else if(s.key==='hpTier')label=HP_TIERS[v];
      else if(s.key==='technique')label=this._createResult.techniqueName;
      return `<div class="attr-row"><span class="k">${s.title}</span><span class="v">${label}</span></div>`;
    });
    list.innerHTML=rows.join('');
  },

  nextCreateWheel(){
    this._createIdx++;
    $('vsNextWheel').classList.add('hidden');$('vsSpin').classList.remove('hidden');
    $('vsWheelCanvas').style.transform='rotate(0deg)';
    this._drawCreateWheel();
  },

  confirmCreateChar(){
    this.customCounter++;
    const name=String(this.customCounter).padStart(3,'0');
    const char={name,isCustom:true,...this._createResult};
    this.customChars.push(char);
    this.selectedChar={isCustom:true,...char};
    hideAllScreens();$('vsRoomScreen').classList.remove('hidden');
    this._renderCustomList();
    this._renderRoom();
    this._sendSelectChar();
  },

  _updateReadyBtn(){
    const p=this.players.find(x=>x.id===this.myId);
    const btn=$('vsReady');
    if(btn)btn.textContent=p&&p.ready?'取 消 准 备':'准 备';
    if(this.isHost){
      $('vsStartBattle').classList.toggle('hidden',!(this.players.length>=2&&this.players.every(p=>p.ready&&p.char)&&this.players.some(p=>p.team==='red')&&this.players.some(p=>p.team==='blue')));
    }
  },

  leaveRoom(){
    this.net&&this.net.close();
    this.net=null;this.players=[];this.customChars=[];this.customCounter=0;
    this.selectedChar=null;this.selectedTeam=null;
    this.isHost=false;this.connected=false;this.localMode=false;this.onlineMode=false;
    this.inviteCode='';this.guestAnswer='';this.myId='';this.roomId='';this.onlineCode='';
    this.showLobby();
  }
};

/** 房主端战斗控制器：权威运行 BattleEngine，广播状态给客户端，接收客户端操作 */
class VSHostBattle{
  constructor(eng,players,net,controllerMap,onRender){
    this.eng=eng;this.players=players;this.net=net;this.controllerMap=controllerMap||{};
    this._pendingAction=null;this.onRender=onRender||null;
  }
  run(){
    return new Promise(resolve=>{this.resolve=resolve;this._loop();});
  }
  _broadcast(allEvents){
    const eng=this.eng;
    const evs=allEvents||eng.events||[];
    const st={
      units:eng.units.map(u=>({
        name:u.name,side:u.side,hp:u.hp,maxHp:u.maxHp,cp:u.cp,maxCp:u.maxCp,alive:u.alive,
        atb:u.atb||0,speed:u.speed||0,li:u.li||0,type:u.type||'',techName:u.techName||'',
        summonTag:u.summonTag||'',isPlayer:!!u.isPlayer,controllerId:u.controllerId||'',
        buff:u.buff?{...u.buff}:{},flag:u.flag||null,flags:u.flags?[...u.flags]:[],
        reverse:!!u.reverse,bf:!!u.bf,canDomain:!!u.canDomain,canUlt:!!u.canUlt,
        ultUsed:!!u.ultUsed,domainCd:u.domainCd||0,domainUsed:u.domainUsed||0,
        skills:u.skills?{...u.skills}:null
      })),
      events:evs.slice(),
      currentActor:eng.lastActor?{name:eng.lastActor.name,side:eng.lastActor.side}:null,
      needInput:eng.awaitingPlayer||false,
      ended:eng.ended||false
    };
    this.net.send({type:'battleState',...st});
  }
  onClientAction(m){
    const charName=this.controllerMap[m.playerId];
    if(!charName||!this.eng.lastActor||this.eng.lastActor.name!==charName)return;
    if(!this.eng.awaitingPlayer)return;
    this._pendingAction=m.action;
  }
  /** 投降：该玩家全部单位立即生命值归零（仍可留在界面观战），若一方全灭则结束战斗 */
  applySurrender(pid){
    const eng=this.eng;
    const name=this.controllerMap[pid];
    let killed=false;
    eng.units.filter(u=>u.controllerId===pid&&u.alive).forEach(u=>{
      u.hp=0;u.alive=false;killed=true;
      eng.events.push({type:'die',text:`${u.name} 选择投降，生命值归零（仍可留下观战）。`});
    });
    if(!killed)return;
    // 若正在等待该投降者输入，立即跳出等待（其已死亡，下一次advance自动跳过）
    if(eng.awaitingPlayer&&eng.lastActor&&eng.lastActor.name===name){
      this._pendingAction='__surrenderSkip__';
    }
    const ev=[];eng.checkEnd(ev);if(ev.length)eng.events.push(...ev);
    this._broadcast();
    try{if(typeof BattleUI!=='undefined'&&BattleUI.eng===eng)BattleUI.render();}catch(e){}
    try{this.onRender&&this.onRender();}catch(e){}
  }
  async _loop(){
    const eng=this.eng;
    const allEvents=[];
    // 初始状态立即广播：确保所有客户端在第一次advance前就收到battleState并进战斗（防startBattle丢失）
    this._broadcast(allEvents);
    while(!eng.ended&&eng.actionsTotal<300){
      let r;
      try{r=eng.advance();}catch(e){console.error('战斗推进异常',e);break;}
      // advance()会清空eng.events并返回旧事件，累积到allEvents
      if(r.events&&r.events.length){
        allEvents.push(...r.events);
        try{if(typeof BattleUI!=='undefined'&&BattleUI.eng===eng)r.events.forEach(e=>BattleUI.appendLog(e));}catch(e){}
      }
      this._broadcast(allEvents);
      try{if(typeof BattleUI!=='undefined'&&BattleUI.eng===eng)BattleUI.render();}catch(e){}
      try{this.onRender&&this.onRender();}catch(e){}
      if(eng.ended)break;
      if(r.needInput&&eng.lastActor){
        const actor=eng.lastActor;
        const playerId=Object.keys(this.controllerMap).find(id=>this.controllerMap[id]===actor.name);
        if(playerId){
          // 等该玩家操作（超时10秒后自动选输出最高的选项），20ms轮询保证秒响应
          this._pendingAction=null;
          let waited=0;
          while(!this._pendingAction&&waited<10000&&!eng.ended){
            await this._sleep(20);waited+=20;
            // 等待期间每500ms心跳广播一次，让客户端持续同步（防丢消息导致卡界面）
            if(waited%500===0)this._broadcast(allEvents);
          }
          const action=this._pendingAction||this._aiChoose(actor);
          this._pendingAction=null;
          this._execPlayerAction(actor,action);
        }else{
          // 不应发生（所有角色都有controllerId），AI代打
          this._aiAct(actor);
        }
        await this._sleep(80);
      }else{
        await this._sleep(60);
      }
    }
    if(!eng.ended)eng.forceSettle(eng.events);
    this._broadcast(allEvents);
    await this._sleep(800);
    this.resolve&&this.resolve(eng.result);
  }
  _execPlayerAction(actor,action){
    const eng=this.eng;
    if(action==='__surrenderSkip__')return; // 投降者已死亡，跳过其本次行动
    const oldPlayer=eng.player;
    eng.player=actor;
    const foes=eng.units.filter(u=>u.alive&&u.side!==actor.side);
    const target=foes.sort((a,b)=>a.hp-b.hp)[0];
    const targetIdx=target?eng.units.indexOf(target):0;
    let r;
    try{r=eng.playerAct(action,targetIdx);}catch(e){console.error('玩家行动异常',e);r={retryInput:true};}
    // 合并playerAct返回的事件到eng.events，否则advance()拿不到战斗日志
    if(r&&r.events&&r.events.length)eng.events.push(...r.events);
    // 领域/极之番条件不足时 playerAct 返回 retryInput，降级为近战重试，避免卡死
    if(r&&r.retryInput){
      try{
        const r2=eng.playerAct('melee',targetIdx);
        if(r2&&r2.events&&r2.events.length)eng.events.push(...r2.events);
      }catch(e){}
    }
    eng.player=oldPlayer;
  }
  _aiChoose(u){
    // 10秒未操作：自动选择输出最高的选项
    // 1. 极之番（500%效率+回满血）：血量低且满足条件时最优先
    if(u.canUlt&&!u.ultUsed&&((u.skills&&u.skills.sixEyes)||u.cp>=u.maxCp*0.5)&&u.hp<u.maxHp*0.5)return'ult';
    // 2. 蓄力中的虚式茈/空间斩：直接释放
    if(u.buff.charge){
      if(u.skills&&u.skills.chargeSlash)return'sig_sCharge';
      return'sig_murasaki';
    }
    // 2.5 主动反转术式（本地对战）：残血且蓝够时优先保命
    if(u.reverse&&u.hp<u.maxHp*0.35&&u.hp<u.maxHp&&((u.skills&&u.skills.sixEyes)||u.cp>=u.maxCp*0.05))return'sig_reverse';
    // 3. 领域（没在冷却且咒力充足）
    if(u.canDomain&&(u.domainCd||0)<=0&&u.cp>=u.maxCp*0.3)return'domain';
    // 4. 专属技能（选伤害最高的）
    if(u.name==='五条悟')return'sig_ka'; // 赫单体2.0
    if(u.name.includes('宿傩'))return'sig_kamado'; // 灶单体2.5
    if(u.name==='九十九由基'){if(u.hp>u.maxHp*0.3)return'sig_hoshi';return'sig_shitsuryo';}
    // 5. 十影宿傩空间斩：第5次行动后自动发动
    if(u.skills&&u.skills.spaceSlash&&u.buff.actCount>=u.skills.spaceSlash.after)return'sig_spaceSlash';
    // 6. 术式（咒力充足时）
    if(u.flag&&u.cp>=this.eng.techCost(u))return'tech';
    // 7. 近战兜底
    return'melee';
  }
  _aiAct(u){this._execPlayerAction(u,this._aiChoose(u));}
  _sleep(ms){return new Promise(r=>setTimeout(r,ms));}
}

/* ============================ VIII. 游戏主控 ============================ */
const Game={
  player:null,day:0,draws:{},logEl:null,
  /* ---------- 创建流程：12 转盘 ---------- */
  createSteps:[
    {title:'初始身份',items:WHEEL_IDENTITY,key:'identity'},
    {title:'穿越的时间点',items:WHEEL_ERA,key:'era'},
    {title:'穿越后的年龄',items:WHEEL_AGE,key:'age'},
    {title:'穿越后的性别',items:WHEEL_GENDER,key:'gender'},
    {title:'穿越后的颜值',items:WHEEL_FACE,key:'face'},
    {title:'生得术式',items:WHEEL_TECHNIQUE.map(t=>({label:t.name,desc:t.desc,name:t.name,flag:t.flag,domain:t.domain,flags:t.flags})),key:'technique'},
    {title:'初始咒力总量',items:buildStatWheel('cp'),key:'cp'},
    {title:'初始咒力操控',items:buildStatWheel('ctl'),key:'ctl'},
    {title:'初始体术水平',items:buildStatWheel('melee'),key:'melee'},
    {title:'初始体质水平',items:WHEEL_HP,key:'hp'},
    {title:'初始咒力效率',items:buildStatWheel('eff'),key:'eff'},
    {title:'成长值',items:WHEEL_GROWTH,key:'growth'}],
  stepIdx:0,wheel:null,autoTimer:null,
  startCreate(){
    $('titleScreen').classList.add('hidden');
    $('mainScreen').classList.add('hidden');
    $('createScreen').classList.remove('hidden');
    this.draws={};this.stepIdx=0;
    if(!this.wheel)this.wheel=new WheelView($('wheelCanvas'));
    $('progressDots').innerHTML=this.createSteps.map((_,i)=>`<div class="dot"></div>`).join('');
    this.loadStep(0);
  },
  loadStep(i){
    this.stepIdx=i;
    const s=this.createSteps[i];
    $('stepIdx').textContent=i+1;
    $('wheelTitle').textContent=s.title;
    $('wheelResult').textContent='点击「抽取」转动命运之轮……';
    $('btnSpin').disabled=false;$('btnSpin').classList.remove('hidden');
    $('btnNextWheel').classList.add('hidden');
    this.wheel.setItems(s.items);
    $('wheelLegend').innerHTML=wheelLegendHtml(s.items);
    $('wheelLegend').scrollTop=0;
    document.querySelectorAll('#progressDots .dot').forEach((d,k)=>{
      d.className='dot'+(k<i?' done':k===i?' cur':'');
    });
    this.renderCreateAttrs();
  },
  doSpin(){
    $('btnSpin').disabled=true;
    const s=this.createSteps[this.stepIdx];
    this.wheel.spin((item,idx)=>{
      const picked=deepCopy(item);
      if(s.key==='hp')picked.tierIdx=idx;
      this.draws[s.key]=picked;
      $('wheelLegend').innerHTML=wheelLegendHtml(s.items,idx);
      const hitEl=$('wheelLegend').querySelector('.lg-item.hit');if(hitEl)hitEl.scrollIntoView({block:'nearest'});
      $('wheelResult').innerHTML=`<span class="hl">${item.label}</span>${item.desc?'<br><small>'+item.desc+'</small>':''}`;
      this.renderCreateAttrs();
      const btn=$('btnNextWheel');
      btn.classList.remove('hidden');
      btn.textContent=this.stepIdx===11?'✔ 进入《咒术回战》世界':'前往下一个转盘 →';
      clearTimeout(this.autoTimer);
      // 所有身份：抽中后必须先选择阵营（正派/反派/自由），再进入下一步
      if(s.key==='identity'&&!picked.faction){
        btn.classList.add('hidden');
        this.chooseFaction(picked);
        return;
      }
      this.autoTimer=setTimeout(()=>this.nextStep(),1800);
    });
  },
  /** 三阵营选择（所有身份通用） */
  chooseFaction(picked){
    showModal(`<h2>选择你在咒术世界的阵营</h2>
      <p style="line-height:1.9">无视你的身份，你可以自由选择在这场诅咒之战中站在哪一方：</p>
      <div style="display:flex;flex-direction:column;gap:12px;margin:16px 0">
        <button class="btn" id="facHero" style="text-align:left">🟦 <b>高专阵营（咒术师一方）</b><br><small>初始好感：高专 +50，诅咒 −50。与高专并肩。</small></button>
        <button class="btn" id="facVillain" style="text-align:left">🟥 <b>诅咒阵营（诅咒一方）</b><br><small>初始好感：高专 −50，诅咒 +50。原主线敌友翻转，保留原版反派路线难度。</small></button>
        <button class="btn" id="facFree" style="text-align:left">⬛ <b>中立阵营（孤高的第三方）</b><br><small>初始好感：双方均为0。孤身面对双方；放过对手可增加好感与下次获救机会。</small></button>
      </div>`);
    const done=(fac,label)=>{
      picked.faction=fac;picked.factionLabel=label;
      $('wheelResult').innerHTML=`<span class="hl">${picked.label}</span><br><small>${picked.desc}</small><br><span style="color:var(--gold)">已选择阵营：${label}</span>`;
      this.renderCreateAttrs();
      closeModal();
      const btn=$('btnNextWheel');btn.classList.remove('hidden');
      this.autoTimer=setTimeout(()=>this.nextStep(),1600);
    };
    $('facHero').onclick=()=>done('hero','高专阵营');
    $('facVillain').onclick=()=>done('villain','诅咒阵营');
    $('facFree').onclick=()=>done('free','中立阵营');
  },
  nextStep(){
    clearTimeout(this.autoTimer);
    if(this.stepIdx<11){this.loadStep(this.stepIdx+1);}
    else{this.finishCreate();}
  },
  renderCreateAttrs(){
    const nameMap={identity:'初始身份',era:'穿越时间点',age:'年龄',gender:'性别',face:'颜值',technique:'生得术式',
      cp:'咒力总量',ctl:'咒力操控',melee:'体术水平',hp:'体质水平',eff:'咒力效率',growth:'成长值'};
    const keys=Object.keys(nameMap);
    const got=keys.filter(k=>this.draws[k]);
    if(!got.length){$('createAttrList').innerHTML='<div class="attr-row"><span class="k">尚未抽取</span><span class="v" style="color:var(--txt3)">命运的轮盘尚未开始转动……</span></div>';return;}
    $('createAttrList').innerHTML=got.map(k=>{
      const d=this.draws[k];
      return `<div class="attr-row"><span class="k">${nameMap[k]}</span><span class="v">${d.label}${d.desc?`<br><small>${d.desc}</small>`:''}</span></div>`;
    }).join('');
  },
  finishCreate(){
    this.player=Player.create(this.draws);
    this.day=this.player.startDay;
    this.over=false; // 游戏结束标志：ending后置true，dailyAction/剧情推进立即停止，防止结局后仍可操作
    $('titleScreen').classList.add('hidden');
    $('createScreen').classList.add('hidden');
    $('mainScreen').classList.remove('hidden');
    this.logEl=$('mainLog');
    this.addLog('lp',`════ 你穿越到了《咒术回战》的世界 ════`);
    this.addLog('lg',`时间点：${this.player.eraLabel}（游戏第 ${this.day} 天）。${this.player.eraDesc}`);
    this.addLog('lg',`身份【${this.player.identity}】：${this.player.identityDesc}`);
    this.addLog('lg',`生得术式【${this.player.technique.name}】：${this.player.technique.desc}`);
    this.addLog('lgold',`综合评级：${lvName(this.player.levelIndex)}｜成长：${this.player.growthLabel}（固定增量×${this.player.growthMult}）｜${this.player.ageNote}`);
    const arcTip=this.player.arc==='kaigyo'?'怀玉篇历时30天，第30天战胜伏黑甚尔后将转入主线第0天。'
      :this.player.arc==='future'?'未来篇历时60天，战斗在第7、18、25、30天，第30天击败地狱·真人迎来未来篇结局。'
      :'转动行动转盘度过每一天，剧情日将自动触发战斗；第120天新宿决战后可选择进入未来篇。';
    this.addLog('lg',`提示：${arcTip}`);
    this.render();
  },
  /* ---------- 主界面渲染 ---------- */
  addLog(cls,txt){
    if(!this.logEl)return;
    const d=document.createElement('div');d.className=cls||'lg';d.textContent=txt;
    this.logEl.appendChild(d);this.logEl.scrollTop=this.logEl.scrollHeight;
  },
  render(){
    const P=this.player;if(!P)return;
    const T=this.currentStory(),ED=this.currentEventDays(),isKai=P.arc==='kaigyo',isFuture=P.arc==='future';
    const arcLabel=isKai?('怀玉篇 · '+kaiEraOfDay(this.day)):isFuture?('未来篇 · '+futureEraOfDay(this.day)):eraOfDay(this.day);
    $('dayNum').textContent=this.day;$('dayEra').textContent=arcLabel;
    const nextD=ED.find(d=>d>this.day);
    $('chapterTag').textContent=nextD?`下一剧情：第${nextD}天 · ${T[nextD].chapter}`:(isKai?'怀玉篇终局将近':isFuture?'未来篇终局将近':'终局将近');
    $('playerCard').innerHTML=`
      <h3>角色面板</h3>
      <div class="stat-line"><span>身份 / 年龄</span><b>${P.identity}${P.isFree?' <span style=\"color:#c08bff\">（中立阵营）</span>':P.isVillain?' <span style=\"color:#ff5a5a\">（诅咒阵营）</span>':' <span style=\"color:#7fd0ff\">（高专阵营）</span>'} · ${P.age}岁 · ${P.gender}</b></div>
      <div class="stat-line"><span>颜值 / 成长</span><b>${P.face}级 · ${faceAuraName(P.faceIdx)?'【'+faceAuraName(P.faceIdx)+'】':''}（队友${P.allyBoost>=0?'+':''}${Math.round(P.allyBoost*100)}%） / ${P.growthLabel}（固定×${P.growthMult}）</b></div>
      <div class="stat-line"><span>生得术式</span><b style="font-size:12px">${P.technique.name}（领域·${P.technique.domain}）</b></div>
      ${P.extraTech?`<div class="stat-line"><span>第二术式</span><b style="font-size:12px;color:var(--gold)">${P.extraTech.name}（领域·${P.extraTech.domain}）</b></div>`:''}
      <div class="stat-line"><span>综合评级</span><b style="color:var(--gold)">${lvName(P.levelIndex)}</b></div>
      <div class="stat-line" style="margin-top:8px"><span>体质层级</span><b style="font-size:12px">${HP_TIERS[hpTierIndexOf(P.maxHp)][0]}</b></div>
      <div style="font-size:12px;color:var(--txt2)">生命 HP <b style="color:#ff9aa4">${Math.round(P.hp)}/${P.maxHp}</b></div>
      <div class="bar hp"><i style="width:${pct(P.hp,P.maxHp)}"></i></div>
      <div style="margin-top:8px;font-size:12px;color:var(--txt2)">咒力 CP【${lvName(tierIndexOf(P.maxCp,CP_TIERS))}】 <b style="color:#8fdcf5">${Math.round(P.cp)}/${P.maxCp}</b></div>
      <div class="bar cp"><i style="width:${pct(P.cp,P.maxCp)}"></i></div>
      <div class="stat-line" style="margin-top:8px"><span>体术伤害【${lvName(tierIndexOf(P.melee[1],DMG_TIERS))}】</span><b>${P.melee[0]}~${P.melee[1]}</b></div>
      <div class="stat-line"><span>术式伤害【${lvName(tierIndexOf(P.eff[1],DMG_TIERS))}】</span><b>${P.eff[0]}~${P.eff[1]}</b></div>
      <div class="stat-line"><span>咒力操控【${lvName(tierIndexOf(P.ctl,CTL_TIERS))}】</span><b>减免 ${P.ctl}</b></div>
      <div class="stat-line"><span>术式熟练度（300%领悟极之番）</span><b>${Math.round(P.prof)}%${P.domainLearned?' ✔领域':''}${P.ultimateLearned?' ✔极之番':''}</b></div>
      <div class="bar"><i style="width:${clamp(P.prof/3,0,100)}%"></i></div>`;
    const sk=[];
    sk.push(P.domainLearned?'✔ 领域展开（大招；用后熔断，反转者间隔一回合可再开）':'✘ 领域展开（熟练度100%领悟）');
    sk.push(P.ultimateLearned?'✔ 极之番（熟练度300%领悟：耗半蓝、敌全体500%、回满血，每场一次）':'✘ 极之番（熟练度300%领悟终极奥义）');
    sk.push(P.reverse?'✔ 反转术式（被动：回合耗5%咒力回20%血）':'✘ 反转术式（每场战斗5%几率领悟）');
    sk.push(P.blackFlash?'✔ 黑闪（10%触发，伤害×10+五维+10%）':'✘ 黑闪（战斗5%自行领悟，或战胜东堂葵学会）');
    if(P.sixEyes)sk.push('★ 六眼（怀玉篇奖励：所有咒力消耗为0）');
    if(P.jinTools)sk.push('★ 伏黑甚尔四道具（怀玉篇奖励：天逆鉾破术式/吞领域、释魂刀+游云近战×1.8、万里锁攻击打全体）');
    sk.push(`主术式：${P.technique.name}（领域：${P.technique.domain}）`);
    if(P.extraTech)sk.push(`★ 第二术式：${P.extraTech.name}（领域：${P.extraTech.domain}，双术式被动叠加、双领域可依次展开）`);
    (P.stolenTechs||[]).forEach(t=>sk.push(`夺取术式：${t.name}（熟练度${Math.round(t.prof)}%${t.domain?'，领域：'+t.domain:''}）`));
    $('skillList').innerHTML=sk.map(s=>'<div>· '+s+'</div>').join('');
    // 下一事件
    if(nextD){
      const node=T[nextD];
      $('nextEvent').innerHTML=`距下一剧情事件还有 <b style="color:var(--gold)">${nextD-this.day}</b> 天｜第${nextD}天【${node.title}】`;
    }else{$('nextEvent').innerHTML=isKai?'怀玉篇剧情已全部触发，终局将近。':isFuture?'未来篇剧情已全部触发，终局将近。':'所有主线剧情已落幕。';}
  },
  showDetail(){
    const P=this.player;
    showModal(`<h2>详细属性</h2>
      <p style="line-height:2.2">
      <b>穿越档案</b>：${P.identity}，${P.age}岁，${P.gender}，颜值${P.face}；穿越时间点【${P.eraLabel}】（第${P.startDay}天）。<br>
      <b>生得术式</b>：${P.technique.name}——${P.technique.desc}<br>
      <b>成长资质</b>：${P.growthLabel}（每次修炼/战胜按当前等级给<b>固定数值</b>，系数×${P.growthMult}，不随已有属性滚动）。${P.ageNote}。<br>
      <b>体质层级</b>：${HP_TIERS[hpTierIndexOf(P.maxHp)][0]}（最大生命 ${P.maxHp}）<br>
      <b>咒力总量【${lvName(tierIndexOf(P.maxCp,CP_TIERS))}】</b>：${P.maxCp}（综合评级${lvName(Player.evalLevel(P))}）｜<b>咒力操控【${lvName(tierIndexOf(P.ctl,CTL_TIERS))}】</b>：减免 ${P.ctl}<br>
      <b>体术【${lvName(tierIndexOf(P.melee[1],DMG_TIERS))}】</b>：${P.melee[0]}~${P.melee[1]}｜<b>术式伤害【${lvName(tierIndexOf(P.eff[1],DMG_TIERS))}】</b>：${P.eff[0]}~${P.eff[1]}<br>
      <b>速度</b>：${campaignSpeed(P).toFixed(2)}（体质基础×咒效权重×术式倍率；档位+档内进度）<br>
      <b>术式熟练度</b>：${Math.round(P.prof)}%｜黑闪累计加成×${P.statBoost}<br>
      <b>战绩</b>：剧情/战斗 ${P.battleCount} 场，狩猎 ${P.huntCount} 次，击溃敌人 ${P.killCount}，触发黑闪 ${P.flashCount} 次。
      </p><div class="center"><button class="btn" onclick="closeModal()">闭</button></div>`);
  },
  /* ---------- 每日行动 ---------- */
  async dailyAction(){
    if(this.over)return; // 结局已触发，彻底锁死日常推进
    $('btnActionWheel').disabled=true;
    this.day++;
    // 怀玉篇兜底：超过30天未进入主线，自动跳转（防止任何残留bug导致无限转盘）
    if(this.player.arc==='kaigyo'&&this.day>30){
      this.addLog('lgold','怀玉篇已至终点，时间线自动推进至2018年主线……');
      return this.advanceMainAfterEscape();
    }
    // 未来篇兜底：超过60天仍未结束（正常应在第30天击败地狱·真人），直接结算未来篇结局，防止无限转盘
    if(this.player.arc==='future'&&this.day>60){
      this.addLog('lgold','未来篇已至终点，地狱·真人之乱终被平息……');
      return this.ending('futureWin');
    }
    const T=this.currentStory();
    if(T[this.day]&&this.day>=this.player.startDay){
      this.render();this.addLog('lred',`◆ 第${this.day}天——剧情事件【${T[this.day].title}】触发！`);
      try{await this.triggerEvent(this.day);}
      catch(err){console&&console.error&&console.error('剧情推进异常:',err);this.addLog('lred','剧情推进出现异常，已安全收尾。');
        const _node=T[this.day];if(_node&&_node.final)return this.ending('loseFinal',_node);}
      if(this.over)return; // 剧情中已触发结局（战死/终局），不再恢复按钮、不再render
      this.afterBattleRecover();
      this.render();
      $('btnActionWheel').disabled=false;
      return;
    }
    const pick=await openWheelModal({title:`第 ${this.day} 天 · 行动转盘`,items:WHEEL_DAILY});
    if(pick.act==='hunt'){await this.hunt();}
    else{const txt=Player.train(this.player,pick.act);this.addLog('lcyan',`【${pick.label}】${txt}`);}
    if(this.over)return; // 狩猎战死已触发结局
    this.render();
    $('btnActionWheel').disabled=false;
  },
  afterBattleRecover(){const P=this.player;P.hp=P.maxHp;P.cp=P.maxCp;},
  /** 当前所处时间线的剧情表与事件日：怀玉独立时间线用 KAI_STORY，转入主线后用 STORY */
  currentStory(){if(!this.player)return STORY;if(this.player.arc==='kaigyo')return KAI_STORY;if(this.player.arc==='future')return FUTURE_STORY;return STORY;},
  currentEventDays(){if(!this.player)return EVENT_DAYS;if(this.player.arc==='kaigyo')return KAI_EVENT_DAYS;if(this.player.arc==='future')return FUTURE_EVENT_DAYS;return EVENT_DAYS;},
  /** 怀玉篇第30天终战胜出：转入主线【宿傩受肉篇】，从主线第0天重新开始 */
  async enterMainArc(){
    const P=this.player;
    await this.showEraBanner('怀玉篇结束 · 十年以后......',2000);
    P.arc='main';this.day=0;P.startDay=0;
    P.eraLabel='宿傩受肉虎杖时期';P.eraDesc='故事原点，一切诅咒的开端。';
    // 注：怀玉篇后时间推进十年，角色年龄+10岁，并重算年龄成长系数（半人半受肉体永久+30%不受影响）
    const oldAge=P.age;P.age+=10;
    P.ageGrowthBonus=+ageGrowthBonus(P.age,P.identity).toFixed(3);
    P.notes.push(`怀玉篇跨越十年，年龄由${oldAge}岁增长为${P.age}岁`);
    this.addLog('lgold',`★ 十年光阴流逝：你的年龄由 ${oldAge} 岁变为 ${P.age} 岁（年龄成长系数 ${P.ageGrowthBonus>=0?'+':''}${Math.round(P.ageGrowthBonus*100)}%）。`);
    P.notes.push('怀玉篇第30天战胜伏黑甚尔，时间线推进至2018年主线，从宿傩受肉篇第0天重新启程');
    // 怀玉篇终局奖励：反派战胜觉醒五条悟→获得六眼；正派战胜伏黑甚尔→获得甚尔全部四件道具
    if(P.isVillain){
      P.sixEyes=true;P.notes.push('怀玉篇反派路线：与伏黑甚尔联手击溃觉醒五条悟，夺取【六眼】——所有咒力消耗变为0');
      this.addLog('lgold','★ 怀玉篇奖励：你击败了觉醒的五条悟，夺取了【六眼】！今后所有咒力消耗均为0。');
    }else{
      P.jinTools={ama:1,soul:1,cloud:1,chain:1};
      P.notes.push('怀玉篇正派路线：战胜伏黑甚尔，缴获其全部特殊道具（天逆鉾/释魂刀/游云/万里锁），主线中可使用');
      this.addLog('lgold','★ 怀玉篇奖励：你缴获了伏黑甚尔的四件特殊道具——天逆鉾（破术式/吞领域）、释魂刀+游云（近战×1.8）、万里锁（攻击打全体），主线中全程生效！');
    }
    this.addLog('lgold','★ 怀玉篇完结：你协助觉醒的五条悟击溃了伏黑甚尔。时间线向前奔流——');
    this.addLog('lg','时间线跳转：主线【宿傩受肉虎杖时期】，游戏天数重置为第 0 天，接下来将沿主线一路打到第120天新宿决战。');
    await this.storyModal('时间线跳转 · 进入主线',
      '伏黑甚尔倒下的瞬间，2006年的怀玉之夏落下帷幕。\n\n你随时间的洪流来到2018年——【宿傩受肉虎杖时期】，游戏天数从第 0 天重新计起。你在怀玉篇积累的全部属性、术式熟练度与技能都将保留，'
      +(P.isVillain?'你从觉醒五条悟处夺取的【六眼】（咒力消耗为0）':'你从伏黑甚尔处缴获的四件特殊道具')+'也将在主线中全程生效。接下来将沿主线经历宿傩受肉、少年院、涩谷事变、死灭回游，直到第120天新宿决战迎来结局。','怀玉篇 → 主线');
    this.render();
  },
  /** 主线新宿决战终局胜利：先判定术式圆满可领悟第二术式，再询问是否进入未来篇；其余终局直接胜利结局 */
  async resolveFinalWin(){
    if(this.player&&this.player.arc==='main'){
      await this.drawExtraTech();
      return this.askFuture();
    }
    return this.ending('win');
  },
  /** 新宿决战胜利后：若主术式熟练度达300%，额外抽取一门不重复的生得术式（双术式/双领域） */
  async drawExtraTech(){
    const P=this.player;
    if(!(P.prof>=300)||P.extraTech)return;
    const owned=new Set([P.technique.flag,...(P.stolenTechs||[]).map(t=>t.flag)]);
    const pool=WHEEL_TECHNIQUE.filter(t=>!owned.has(t.flag));
    if(!pool.length)return;
    await this.storyModal('术式圆满 · 领悟第二生得术式',
      `你的主生得术式【${P.technique.name}】熟练度已达 300% 圆满。经新宿决战的生死淬炼，你的灵魂额外容纳了一门全新的生得术式！`,
      '极之番 · 双术式觉醒');
    const items=pool.map(t=>({label:t.name,weight:1,desc:t.desc}));
    const pick=await openWheelModal({title:'领悟第二生得术式（不可与已有重复）',items});
    const full=WHEEL_TECHNIQUE.find(t=>t.name===pick.label);
    if(full){
      P.extraTech={name:full.name,flag:full.flag,domain:full.domain,prof:300};
      P.notes.push(`新宿决战后术式圆满，额外领悟第二生得术式【${full.name}】（领域·${full.domain}）`);
      this.addLog('lgold',`★ 你额外领悟了第二生得术式【${full.name}】！两门术式的被动在战斗中同时生效，且可先后展开两个领域。`);
    }
  },
  /** 新宿决战（主线终局）胜利后：询问是否进入未来篇 */
  askFuture(){
    return new Promise(res=>{
      showModal(`<h2>新宿决战 · 胜利</h2>
        <div class="center" style="color:var(--gold);letter-spacing:3px;margin:8px 0">十影宿傩终被击溃</div>
        <p style="line-height:2">新宿的硝烟散去，诅咒之王的时代画上句点。岁月长河仍在向前奔流——数十年后，新世代的咒术师将面对全新的威胁。<br><br>是否要跨越时光，进入【未来篇】继续你的旅程？</p>
        <div style="display:flex;gap:12px;justify-content:center;margin-top:16px">
          <button class="btn" id="goFuture" style="flex:1">➤ 进入未来篇</button>
          <button class="btn" id="endHere" style="flex:1">就此寿终正寝</button>
        </div>`);
      $('goFuture').onclick=()=>{closeModal();res(this.enterFutureArc());};
      $('endHere').onclick=()=>{closeModal();res(this.ending('win'));};
    });
  },
  /** 进入未来篇独立时间线：全屏大字中转 + 按身份施加全局增减益 + 天数重置 */
  async enterFutureArc(){
    const P=this.player;
    await this.showEraBanner('新宿决战结束 · 数十年以后......',2000);
    // 身份状态倍率
    const id=P.identity;let mult=1,statusName='岁月如常';
    if(id==='咒术师'){mult=0.5;statusName='衰老';}
    else if(id==='诅咒师'){mult=0.3;statusName='严重衰老';}
    else if(id==='咒灵'){mult=0.7;statusName='相持衰弱';}
    else if(id==='普通人类'){mult=0.1;statusName='垂暮';}
    else if(id==='受肉体'){mult=1.1;statusName='正值壮年';}
    else if(id==='半人半受肉体'){mult=2.0;statusName='左脚踩右脚';}
    P.maxHp=Math.round(P.maxHp*mult);P.maxCp=Math.round(P.maxCp*mult);P.ctl=Math.round((P.ctl||0)*mult);
    P.melee=P.melee.map(v=>Math.max(0,Math.round(v*mult)));P.eff=P.eff.map(v=>Math.max(0,Math.round(v*mult)));
    P.hp=P.maxHp;P.cp=P.maxCp;P.levelIndex=Player.evalLevel(P);
    P.arc='future';this.day=0;P.startDay=0;P.futureStatus={name:statusName,mult};
    P.notes.push(`新宿决战后跨越至未来篇，获得身份状态【${statusName}】（全属性×${mult}）`);
    this.addLog('lgold',`★ 时间线跳转：你进入了【未来篇】。因身份【${P.identity}】，你获得状态【${statusName}】，全属性×${mult}。`);
    this.addLog('lg','未来篇历时60天，战斗集中在第7、18、25、30天；第30天先经三战场转盘，再决战地狱·真人，战胜即迎来未来篇结局。');
    await this.storyModal('时间线跳转 · 进入未来篇',
      `新宿决战数十年后，世界换了模样。\n\n你以【${P.identity}】之身跨越岁月，获得状态【${statusName}】（全属性×${mult}）。乙骨犹花、乙骨真剑、失去意识的马鲁、来自宇宙的达布拉，以及68岁仍屹立不倒的虎杖悠仁——新世代的故事，正等待你书写。第30天，地狱·真人将张开最终的杀阵。`,'新宿决战 → 未来篇');
    this.render();
  },
  flipSides(enemies,allies,noFlip){
    // 中立阵营：不属于任何一方，原BOSS与原队友全部成为敌人，孤身作战
    if(this.player.isFree){
      return {enemies:[...deepCopy(enemies||[]),...deepCopy(allies||[])],allies:[],villain:false,free:true};
    }
    const v=!!this.player.isVillain&&!noFlip;
    if(!v)return {enemies:deepCopy(enemies||[]),allies:deepCopy(allies||[]),villain:false};
    return {enemies:deepCopy(allies||[]),allies:deepCopy(enemies||[]),villain:true};
  },
  async hunt(){
    const P=this.player;
    const pool=Player.huntPool(P);
    const items=pool.map(p=>({label:`${lvName(p.tier)}咒灵`,weight:p.weight,tier:p.tier}));
    const pick=await openWheelModal({title:'狩猎转盘（同级咒灵权重50%）',items});
    this.addLog('lg',`你外出狩猎，遭遇了【${pick.label}】。`);
    let win;
    try{win=await BattleUI.run({title:`狩猎 · ${pick.label}`,player:P,
      enemies:[{name:lvName(pick.tier)+'咒灵',li:pick.tier,type:'咒灵',wild:true}],allies:[]});}
    catch(err){console&&console.error&&console.error('狩猎异常:',err);win=false;}
    P.battleCount++;
    this.afterBattleRecover();
    if(win){P.huntCount++;P.killCount++;const t=Player.reward(P,pick.tier);this.addLog('lgreen',`狩猎成功！${t}`);}
    else if(BattleUI.lastResult==='flee'){this.addLog('lg','你主动脱离了狩猎，安全返回，未获收益。');}
    else if(P.isVillain){this.addLog('lgold','【反派路线】你从狩猎中脱身，未致死亡。');}
    else{this.ending('death',{title:'狩猎咒灵'});}
  },
  /* ---------- 剧情事件 ---------- */
  async triggerEvent(day){
    const node=this.currentStory()[day],P=this.player;
    await this.storyModal(node.title,node.intro,node.chapter);
    if(node.wheel){
      const pick=await openWheelModal({title:node.wheel.title,items:node.wheel.items});
      if(pick.skipText){this.addLog('lg',pick.skipText);return;}
      const b=pick.battle;
      await this.storyModal(node.title+' · '+pick.label,b.intro);
      await this.runBattleCfg(day,b,node,pick.label);
      // 未来篇第30天：三战场转盘战结束后，若未触发结局，衔接最终连战（地狱·真人）
      if(!this.over&&node.stages&&node.stages.length){await this.runStage(day,node,0);}
    }else{
      await this.runStage(day,node,0);
    }
  },
  runStage(day,node,si){
    const stage=node.stages[si];
    return (async()=>{
      if(this.over)return; // 结局已触发，连战递归立即终止
      if(stage.intro)await this.storyModal(node.title+(node.stages.length>1?`（第${si+1}场）`:''),stage.intro);
      const sides=this.flipSides(stage.enemies,stage.allies,stage.noFlip);
      const isLast=si>=node.stages.length-1;
      // 反派/中立阵营：翻转或孤立后若没有敌人，不交战直接推进
      if(sides.enemies.length===0){
        this.addLog('lgold',sides.villain?'【反派路线】此处尽是同阵营的存在，未发生交战，你顺势推进。':'此处无敌对目标，你顺势推进。');
        if(node.final)return isLast?this.resolveFinalWin():this.runStage(day,node,si+1);
        return;
      }
      let win;
      try{
        win=await BattleUI.run({title:`${node.title}${node.stages.length>1?' · 第'+(si+1)+'场':''}`,player:this.player,
          enemies:sides.enemies,allies:sides.allies,villain:sides.villain,scene:`${node.scenePrefix||'s'}${day}_${si}`});
      }catch(err){console&&console.error&&console.error('连战第'+(si+1)+'场异常:',err);win=false;
        this.addLog('lred','本场战斗出现异常，已按战败安全结算并继续剧情。');}
      this.player.battleCount++;
      this.afterBattleRecover();
      // 反派·新宿决战：必须依次击溃六组正派，赢则进下一组、输也由宿傩掩护撤到下一组，仅第六场终局
      const villainFinal=node.final&&sides.villain;
      if(win){
        this.player.killCount+=sides.enemies.length;
        const maxLi=Math.max(...sides.enemies.map(e=>e.li));
        const rw=Player.reward(this.player,maxLi);
        this.addLog('lgreen',`✔ 战胜：${node.title}。${rw}`);
        if(stage.winQuote){await this.storyModal('顺平的遗言','',null,`<div class="story-quote">「${stage.winQuote}」</div>`);}
        if(stage.winSkill==='blackFlash'&&!this.player.blackFlash){
          this.player.blackFlash=true;this.player.notes.push('京都篇战胜东堂葵，学会【黑闪】');
          await this.storyModal('领悟 · 黑闪',stage.winSkillText);
          this.addLog('lgold','★ 你学会了【黑闪】！');
        }
        if(villainFinal){
          if(isLast)return this.resolveFinalWin();
          this.addLog('lgold','【反派路线】你击溃了这组咒术师，新宿决战继续——扑向下一组对手。');
          return this.runStage(day,node,si+1);
        }
        // 怀玉篇第30天终战胜出：转入主线【宿傩受肉篇】第0天
        if(stage.gotoMain){this.addLog('lgreen','✔ 伏黑甚尔被觉醒的五条悟击溃，怀玉篇到此结束！');return this.enterMainArc();}
        // 未来篇第30天最终战胜出：未来篇结局
        if(stage.futureFinal){this.addLog('lgreen','✔ 地狱·真人被击溃，未来篇的危机就此平息！');return this.ending('futureWin');}
        // 强制连战（怀玉第30天前两场：胜也必须推进到觉醒悟的终局场）
        if(stage.winNext&&!isLast){this.addLog('lgold','战局未止，立刻转入下一阶段——');return this.runStage(day,node,si+1);}
        if(node.final)return this.resolveFinalWin();
        return;
      }
      // 战败分支
      if(this.over)return; // 结局已在战斗中触发（安全兜底）
      if(villainFinal){
        if(isLast)return this.ending('loseFinal',node);
        this.addLog('lred','【反派路线】宿傩掩护你撤出本场，重整后扑向下一组咒术师。');
        return this.runStage(day,node,si+1);
      }
      // 连战场（怀玉第30天前两场 / 新宿前五场）：败北也强制进入下一场，优先级高于反派撤退
      if(stage.lose==='next'){
        const ns=node.stages[si+1];
        if(!ns){this.addLog('lg','同伴们完成了收尾。');return;}
        this.addLog('lred','本场败北，战局进入下一阶段……');
        return this.runStage(day,node,si+1);
      }
      // 反派普通剧情战：战败一律安全撤退、不死亡（高容错，避免前中期被五条悟等高墙堵死）
      // 唯一例外：怀玉篇最终战(gotoMain)反派战败必须死亡结算，否则会卡在怀玉篇无限转盘（node.final 已在 villainFinal 分支拦截）
      if(sides.villain&&!stage.gotoMain){
        this.addLog('lgold','【反派路线】你从容撤退保住性命，剧情继续推进。');
        return;
      }
      if(stage.lose==='die'){
        if(node.final)return this.ending('loseFinal',node);
        return this.ending('death',node);
      }
      if(stage.lose==='continue'){
        this.addLog('lred','你在本场战斗中倒下，但剧情并未因此终结——同伴接住了战局。');
        return;
      }
    })();
  },
  async runBattleCfg(day,b,node,sceneLabel){
    if(this.over)return;
    const sides=this.flipSides(b.enemies,b.allies,b.noFlip);
    if(sides.enemies.length===0){this.addLog('lgold','此处无敌对目标，你顺势推进。');return;}
    let win;
    try{win=await BattleUI.run({title:node.title,player:this.player,enemies:sides.enemies,allies:sides.allies,villain:sides.villain,scene:`${node.scenePrefix||'s'}${day}_${sceneLabel}`});}
    catch(err){console&&console.error&&console.error('剧情战斗异常:',err);win=false;this.addLog('lred','本场战斗出现异常，已按战败安全结算。');}
    this.player.battleCount++;this.afterBattleRecover();
    if(win){
      this.player.killCount+=sides.enemies.length;
      const rw=Player.reward(this.player,Math.max(...sides.enemies.map(e=>e.li)));
      this.addLog('lgreen',`✔ 战胜：${node.title}。${rw}`);
    }else{
      if(sides.villain&&!node.final){this.addLog('lgold','【反派路线】你从容撤退保住性命，剧情继续推进。');}
      else if(b.lose==='continue'){this.addLog('lred','你在本场战斗中倒下，但同伴掩护你撤出，未致死亡。');}
      else if(node.final){this.ending('loseFinal',node);}
      else{this.ending('death',node);}
    }
  },
  storyModal(title,text,chapter,extraHtml){
    return new Promise(res=>{
      showModal(`<h2>${title}</h2>${chapter?`<div class="center" style="color:var(--purple);letter-spacing:3px;margin-bottom:10px">${chapter}</div>`:''}
        <p>${text||''}</p>${extraHtml||''}
        <div class="center"><button class="btn" id="storyOk">继 续</button></div>`);
      $('storyOk').onclick=()=>{closeModal();res();};
    });
  },
  /** 全屏大字（时间线跳转等），占据全屏 ms 毫秒后自动消失 */
  showEraBanner(text,ms=2000){
    return new Promise(res=>{
      const el=$('eraBanner'),tx=$('eraBannerText');
      tx.textContent=text;el.classList.remove('hidden');
      setTimeout(()=>{el.classList.add('hidden');res();},ms);
    });
  },
  /* ---------- 结局与后日谈 ---------- */
  ending(kind,node){
    const P=this.player;
    this.over=true; // 锁定游戏：任何后续 dailyAction/连战推进都立即停止
    closeModal();$('mainScreen').classList.add('hidden');
    let screen=document.createElement('section');screen.className='screen';
    const records=`
      <div class="records">
        <div class="r-item"><span>初始身份</span><b>${P.identity}</b></div>
        <div class="r-item"><span>穿越时间点</span><b>${P.originEraLabel&&P.originEraLabel!==P.eraLabel?P.originEraLabel+' → '+P.eraLabel:P.eraLabel}</b></div>
        <div class="r-item"><span>年龄 / 性别 / 颜值</span><b>${P.age}岁 / ${P.gender} / ${P.face}</b></div>
        <div class="r-item"><span>生得术式</span><b>${P.technique.name}</b></div>
        <div class="r-item"><span>最终综合评级</span><b>${lvName(P.levelIndex)}</b></div>
        <div class="r-item"><span>最终咒力总量</span><b>【${lvName(tierIndexOf(P.maxCp,CP_TIERS))}】${P.maxCp}</b></div>
        <div class="r-item"><span>最终生命上限</span><b>${P.maxHp}</b></div>
        <div class="r-item"><span>术式伤害区间</span><b>【${lvName(tierIndexOf(P.eff[1],DMG_TIERS))}】${P.eff[0]}~${P.eff[1]}</b></div>
        <div class="r-item"><span>历经战斗 / 狩猎</span><b>${P.battleCount} 场 / ${P.huntCount} 次</b></div>
        <div class="r-item"><span>黑闪触发</span><b>${P.flashCount} 次（累计加成×${P.statBoost}）</b></div>
      </div>`;
    const skills=[];
    if(P.domainLearned)skills.push('术式熟练度圆满，展开过自己的领域');
    if(P.reverse)skills.push('在生死边缘掌握了反转术式');
    if(P.blackFlash)skills.push('掌握黑闪');
    if(P.sixEyes)skills.push('怀玉篇夺取【六眼】，咒力消耗为0');
    if(P.jinTools)skills.push('怀玉篇缴获伏黑甚尔四件特殊道具');
    if(P.stolen.length)skills.push('通过死而替生夺取了：'+P.stolen.join('、'));
    let title='',tcls='',body='';
    if(kind==='futureWin'){
      title='未 来 篇 · 地 狱 真 人 讨 灭';tcls='win';
      body=`第30天，地狱·真人的无为转变领域在你与68岁虎杖悠仁的联手之下崩解——这位被改造至极致的咒灵，连同宇宙来客带来的灾厄，一同归于虚无。\n\n你以【${P.identity}】之身、凭【${P.technique.name}】，从新宿决战的废墟跨越数十年岁月，在未来的世界再次守护了所有人。${P.futureStatus?'跨越时光时，你身负【'+P.futureStatus.name+'】之态（全属性×'+P.futureStatus.mult+'），仍走到了最后。':''}${skills.length?'\n\n你的传奇履历：'+skills.join('；')+'。':''}${P.notes.length?'\n\n旅途印记：\n· '+P.notes.slice(-8).join('\n· '):''}\n\n后日谈（未来篇）：乙骨犹花与乙骨真剑继承了前辈们的意志，新世代的咒术界依旧有人挺身而出。68岁的虎杖悠仁望着天空，像是在与故人们低语。而你——跨越了两个时代的穿越者，名字成为了未来咒术界最神秘的传说。轮回转盘缓缓停止，这一次，是属于未来的结局。`;
    }else if(kind==='win'){
      title='新 宿 决 战 · 胜 利';tcls='win';
      body=P.isVillain
       ?`新宿的废墟上，人类最强五条悟与咒术师联军相继倒下——你与诅咒一方并肩作战到最后，亲眼见证了咒术师时代的落幕。\n\n你以【${P.identity}】之身、凭【${P.technique.name}】，从${P.eraLabel}起步，一路站到了诅咒的王座旁。${skills.length?'你的传奇履历：'+skills.join('；')+'。':''}${P.notes.length?'\n\n旅途印记：\n· '+P.notes.slice(-8).join('\n· '):''}\n\n后日谈（反派路线）：诅咒的时代彻底降临，阴影重新笼罩世界。而你——作为亲手改写战局的穿越者，名字被诅咒们以敬畏之音传颂。轮回转盘停止，这一次，是属于诅咒的结局。`
       :`五条悟、虎杖、乙骨、东堂……无数咒术师的意志汇于你一身。第120天，随着最后一击落下，两面宿傩的诅咒终于消散在新宿的晨光里。\n\n你以【${P.identity}】之身、凭【${P.technique.name}】，从${P.eraLabel}起步，一路走到了诅咒时代的终幕。${skills.length?'你的传奇履历：'+skills.join('；')+'。':''}${P.notes.length?'\n\n旅途印记：\n· '+P.notes.slice(-8).join('\n· '):''}\n\n后日谈：咒术高专恢复了往日的课程，东京的街头不再有咒灵徘徊。而你——作为亲历了一切的穿越者，你的名字被悄然载入咒术界的隐秘档案。轮回转盘停止，这一次，是最好的结局。`;
    }else if(kind==='loseFinal'){
      title='新 宿 决 战 · 败 北';tcls='lose';
      body=`六连战接连败北，第五削的宿傩终究未能被阻止。你倒在新宿的废墟中，意识沉入黑暗。\n\n以【${P.identity}】之身、凭【${P.technique.name}】，你从${P.eraLabel}坚持到了最终决战，历经 ${P.battleCount} 场战斗——这份斗志无人可以否定。${P.notes.length?'\n\n旅途印记：\n· '+P.notes.slice(-8).join('\n· '):''}\n\n后日谈（战败）：诅咒的时代以最沉重的方式落幕，幸存的人们在废墟上重建一切。某个世界线里，轮回转盘仍在等待下一位穿越者改写结局。`;
    }else{
      title='战 死 · 轮 回 终 止';tcls='lose';
      body=`你倒在了【${node?node.title:'战场'}】。\n\n穿越者的生命只有一次——战败即死亡，没有第二种惩罚，也没有重来。你的档案永远停在了第 ${this.day} 天：【${P.identity}】，术式【${P.technique.name}】，最终评级${lvName(P.levelIndex)}。${P.notes.length?'\n\n旅途印记：\n· '+P.notes.slice(-8).join('\n· '):''}\n\n后日谈：咒术界少了一位无名的战士，而诅咒仍在暗处涌动。轮回转盘缓缓停下——要再试一次吗？下一次，或许就能活到新宿决战的终幕。`;
    }
    screen.innerHTML=`<div class="ending-wrap">
      <div class="ending-title ${tcls}">${title}</div>
      ${records}
      <div class="ending-text"><b>▍后日谈</b>\n\n${body}</div>
      <div class="center" style="margin-top:20px"><button class="btn" onclick="location.reload()">重 新 转 动 轮 回</button></div>
    </div>`;
    document.body.appendChild(screen);
    window.scrollTo(0,0);
  }
};

Game.showWheel=showWheelOverlay;

/* ================= 自定义战役：阵营 / 生死选择 / 世界线 ================= */
const CampaignUI={
  changeText(changes){
    return changes.map(c=>Rules.labels[c.camp]+' '+(c.actual>0?'+':'')+c.actual+' → '+c.value+
      (c.adjusted!==c.requested?'（背叛惩罚后变动 '+c.adjusted+'）':'')).join('；');
  },
  panel(){
    const P=Rules.init(Game.player),dead=Object.values(P.deadCharacters||{});
    const deadText=dead.length?dead.slice(0,4).map(d=>d.name).join('、')+(dead.length>4?' 等'+dead.length+'人':''):'无';
    return '<div class="faction-panel"><h3>阵营关系</h3><p>当前：'+P.factionLabel+'</p>'+
      Rules.camps.map(c=>{
        const canJoin=c!==P.faction&&P.reputation[c]>=50;
        const special=P.sparedCamps[c]>0&&P.killedCamps[c]===0;
        return '<div class="reputation-row"><span>'+Rules.labels[c]+'</span><b>'+P.reputation[c]+' / 100</b></div>'+
        '<meter min="-100" max="100" value="'+P.reputation[c]+'" aria-label="'+Rules.labels[c]+'好感度"></meter>'+
        (P.betrayed[c]?'<small class="betrayal-note">弑同阵营者：后续战后好感增加减半、减少加倍</small>':'')+
        (special?'<small>特殊生还：曾放过该阵营且未击杀 → '+(c==='hero'?'70%':'30%')+'</small>':'')+
        (canJoin?'<small class="join-hint">好感 ≥50，可在详情中'+(P.faction==='free'?'加入':'倒戈')+'</small>':'');
      }).join('')+
      '<small>已阵亡：'+deadText+'</small>'+
      (P.lightSpeedCd>0?'<small class="join-hint">亚光速冷却：还需 '+P.lightSpeedCd+' 场战斗</small>':'')+
      '<button class="btn small ghost" id="btnFaction">阵营详情 / 加入阵营</button></div>';
  },
  showFactions(){
    const P=Rules.init(Game.player),busy=$('btnActionWheel').disabled||Game.over;
    const dead=Object.values(P.deadCharacters||{});
    showModal('<h2>阵营关系</h2><p>当前属于'+P.factionLabel+'。好感度范围 −100 至 +100；目标好感度 ≥50 才可加入。</p>'+
      Rules.camps.map(c=>'<section class="faction-choice"><h3>'+Rules.labels[c]+' · '+P.reputation[c]+'</h3>'+
      (P.betrayed[c]?'<p class="betrayal-note">已留下弑同阵营者记录：战后好感增加×0.5、减少×2。</p>':'')+
      (P.sparedCamps[c]>0&&P.killedCamps[c]===0?'<p class="join-hint">特殊生还：曾放过该阵营且未击杀 → '+(c==='hero'?'70%':'30%')+'（真人除外）。</p>':'')+
      '<button class="btn" id="join-'+c+'" '+(busy||c===P.faction||P.reputation[c]<50?'disabled':'')+'>'+
      (c===P.faction?'当前阵营':P.reputation[c]<50?'好感度不足50':P.faction==='free'?'加入此阵营':'倒戈至此阵营')+'</button></section>').join('')+
      '<p>本局已处决 '+P.executions+' 人，主动放过 '+P.sparedCount+' 人。</p>'+
      '<p class="dead-list">已阵亡角色（不再出现在后续剧情战斗中）：'+
      (dead.length?dead.map(d=>d.name+'（已阵亡）').join('、'):'无')+'</p>'+
      '<details class="rules-help"><summary>规则速查</summary><ul>'+
      '<li><b>死战</b>：不再弹出战前提醒，只保留战斗上方红色提示。撤退进入撤退轮盘；败北进入生还轮盘。</li>'+
      '<li><b>处置</b>：战胜时生命高于30%可选择杀死/放过；不高于30%自动击杀并照常结算好感。只有具名剧情角色触发处置与好感，野生咒灵、杂兵、式神不计入。</li>'+
      '<li><b>中立</b>：杀死一方角色 → 另一方好感 +10、被杀方 −30；放过 → 败方阵营 +10，并计入该阵营的特殊生还记录。</li>'+
      '<li><b>有阵营</b>：杀死敌对阵营 → 己方 +10、敌方 −10；杀死己方阵营 → 己方 −120，敌方 +20，并<b>立即逐出己方阵营、转为中立</b>；此后该阵营好感增加减半、减少加倍。诅咒阵营杀死非特级咒灵不降己方好感。</li>'+
      '<li><b>生还轮盘</b>：特殊生还 = 曾放过该阵营且从未击杀该阵营任何人（高专70%、诅咒30%）；普通生还 = 该阵营好感 >70（40%＋超出70的点数×1%，上限70%）。每个阵营取较高的一项；混合敌队取最不愿放过的阵营；真人一票否决。进入哪种轮盘由较高概率决定，概率为0时不进入轮盘。</li>'+
      '<li><b>撤退</b>：死战时进入撤退轮盘：成功进入下一轮且无奖励；失败继续当前战斗并消耗本次行动。非死战仍直接判定。速度 ≥ 最快敌人1.3倍 → 必成；<0.7倍 → 必败；中间按 0.5×（己方血量% ÷ 最快敌人血量%），上限75%、下限5%。</li>'+
      '<li><b>加入/倒戈</b>：好感 ≥50 可加入；中立加入时另一阵营 −30；已有阵营者倒戈时原阵营 −100。</li>'+
      '<li><b>速度</b>：体质基础（档位+档内进度）×咒效权重（0.88+0.02×档位进度）×术式最高倍率。投射×1.45且有效速度保底20（减速前），无下限×1.1，神速/琥珀×1.3/1.8，质量杀意/亚光速×1.25/2.5。多个术式取最高。</li>'+
      '<li><b>琥珀/亚光速</b>：NPC HP<40%自动开启；玩家用战斗内按钮手动开启。琥珀：速度×1.8，本场无法撤退，战斗结束（无论胜负）必定死亡。亚光速：速度×2.5，所有咒力消耗×3，每次行动损失5%最大生命；连续三次战斗只能用一次，反转术式可解除冷却。</li>'+
      '<li><b>已阵亡</b>：死亡角色及其其他形态不再出现在后续剧情战斗中；剧情文本会标注「（已阵亡）」。</li>'+
      '</ul></details>'+
      '<button class="btn ghost" id="factionClose">返回</button>');
    $('factionClose').onclick=closeModal;
    Rules.camps.forEach(c=>{$('join-'+c).onclick=()=>{
      if(busy||P.reputation[c]<50||P.faction===c)return;
      showModal('<h2>确认'+(P.faction==='free'?'加入':'倒戈')+' · '+Rules.labels[c]+'</h2><p>'+
        (P.faction==='free'?'另一阵营好感 −30。':'原阵营好感 −100。')+
        '已发生的死亡和背叛记录会保留，后续敌友关系随新阵营改变。</p>'+
        '<button class="btn" id="confirmJoin">确认加入</button> <button class="btn ghost" id="cancelJoin">返回</button>');
      $('cancelJoin').onclick=()=>this.showFactions();
      $('confirmJoin').onclick=()=>{
        const result=Rules.join(P,c);if(!result.ok)return;
        const text='你加入了'+Rules.labels[c]+'。'+this.changeText(result.changes);
        P.notes.push(text);Game.addLog('lgold',text);closeModal();Game.render();
      };
    };});
  },
  async afterVictory(cfg,eng){
    const P=Rules.init(cfg.player),ratio=eng.player.hp/eng.player.maxHp;
    const seen=new Set();let handled=0;
    for(const enemy of cfg.enemies){
      if(enemy.summonTag)continue;
      // 野生咒灵、杂兵、式神只打一场，不进入剧情处置与阵营好感。
      if(!Rules.persistent(enemy))continue;
      const key=Rules.characterKey(enemy.name);
      if(seen.has(key))continue;seen.add(key);
      handled++;
      let choice='kill';
      if(ratio>0.3){
        choice=await new Promise(resolve=>{
          showModal('<h2>胜负已定 · 如何处置对手</h2><p class="outcome-health">你的战后生命：'+
            Math.max(0,Math.round(eng.player.hp))+' / '+eng.player.maxHp+'（'+(ratio*100).toFixed(1)+'%）</p>'+
            '<p class="outcome-tip">生命高于30%，你可以选择杀死或放过对方。此选择会改变阵营好感，并影响该角色在后续剧情中的出场。</p>'+
            '<h3>'+enemy.name+'</h3><p>所属：'+(Rules.labels[Rules.campOf(enemy)]||'无所属阵营')+
            '。杀死后，同一角色的其他形态也将从后续剧情战斗中缺席，状态记为「已阵亡」。</p>'+
            '<div class="disposition-preview"><p><b>杀死：</b>'+this.previewDisposition(P,enemy,'kill')+
            '</p><p><b>放过：</b>'+this.previewDisposition(P,enemy,'spare')+'。该角色仍可能在后续剧情中出现。</p></div>'+
            '<div class="outcome-actions"><button class="btn danger" id="executeEnemy">杀死对方</button>'+
            '<button class="btn" id="spareEnemy">放过对方</button></div>');
          let done=false;
          const finish=c=>{if(done)return;done=true;closeModal();resolve(c);};
          $('executeEnemy').onclick=()=>finish('kill');$('spareEnemy').onclick=()=>finish('spare');
        });
      }
      const result=Rules.disposition(P,enemy,choice);
      const text=(choice==='kill'?'你杀死了':'你放过了')+'【'+enemy.name+'】。'+
        (ratio<=0.3?'战后生命不高于30%，按击杀结算。':'')+this.changeText(result.changes)+
        (result.betrayal?'；该阵营已记录背叛，今后战后好感增加减半、减少加倍。':'')+
        (result.expelled?'；你被逐出'+Rules.labels[result.camp]+'，转为中立阵营。':'')+
        (choice==='kill'&&result.camp&&P.sparedCamps[result.camp]>0?'；该阵营特殊生还已失效。':'')+
        (result.exempt?'；非特级咒灵豁免，不触发同阵营惩罚。':'');
      P.notes.push(text);Game.addLog(choice==='kill'?'lred':'lgreen',text);
    }
    if(!handled&&cfg.enemies.length)Game.addLog('lg','本场对手为野生咒灵、杂兵或式神，不触发杀死/放过处置，也不改变阵营好感。');
  },
  previewDisposition(P,e,choice){
    const result=Rules.disposition(deepCopy(P),e,choice);
    return (this.changeText(result.changes)||'不改变好感度')+
      (result.betrayal?'；触发永久背叛惩罚':'')+
      (result.exempt?'；非特级咒灵豁免':'')+
      (result.expelled?'；杀死后会被逐出'+Rules.labels[result.camp]+'，转为中立阵营':'')+
      (choice==='kill'&&result.camp&&P.sparedCamps[result.camp]>0?'；杀死会使该阵营特殊生还失效':'')+
      (choice==='spare'&&result.camp?'；特殊生还条件：已放过'+Rules.labels[result.camp]+(P.killedCamps[result.camp]?'（已击杀过该阵营，失效）':'且未击杀 → '+(result.camp==='hero'?'70%':'30%')):'');
  },
  async fight(sides,options){
    const P=Rules.init(Game.player),cfg=Object.assign({},options,{player:P,enemies:sides.enemies,allies:sides.allies,villain:sides.villain});
    P.amberUsed=false;P.lightSpeedUsedThisBattle=false;
    cfg.lightSpeedAvailable=!!P.reverse||!P.lightSpeedCd||P.lightSpeedCd<=0;
    let win;
    try{win=await BattleUI.run(cfg);}
    catch(error){Game.addLog('lred','战斗运行异常，已停止本场结算；不扣好感、不记死亡。');throw error;}
    const eng=BattleUI.eng;
    P.battleCount++;
    const settle=(result)=>{
      if(P.lightSpeedUsedThisBattle){if(!P.reverse)P.lightSpeedCd=2;}
      else if(P.lightSpeedCd>0)P.lightSpeedCd--;
      if(P.reverse)P.lightSpeedCd=0;
      P.lightSpeedUsedThisBattle=false;
      if(eng.player&&eng.player.amberUsed){
        P.amberUsed=true;P.notes.push('开启幻兽琥珀，战斗结束后被雷兽反噬而死。');
        Game.addLog('lred','【幻兽琥珀反噬】战斗结束，你被雷兽之力吞没。');
        Game.ending('death',{title:'幻兽琥珀反噬'});
        return 'amberDeath';
      }
      return result;
    };
    if(win){
      // 必须在奖励和回满生命之前读取战斗引擎的真实血线。
      await this.afterVictory(cfg,eng);
      P.killCount+=cfg.enemies.length;
      Game.afterBattleRecover();
      const reward=Player.reward(P,Math.max(...cfg.enemies.map(e=>e.li)));
      Game.addLog('lgreen','✔ 战胜：'+cfg.title+'。'+reward);
      return settle('win');
    }
    if(BattleUI.lastResult==='flee'){
      Game.afterBattleRecover();Game.addLog('lg','你成功撤离战场，未获得战胜奖励。');return settle('flee');
    }
    if(cfg.deathmatch){
      const survivors=eng.units.filter(u=>u.side==='enemy'&&u.alive&&!u.summonTag).map(u=>
        Object.assign({},u,cfg.enemies.find(e=>e.name===u.name)||{}));
      const info=Rules.survivalInfo(P,survivors.length?survivors:cfg.enemies);
      if(eng.player&&eng.player.amberUsed){
        Game.addLog('lred','【幻兽琥珀】反噬已注定，生还轮盘不会开启。');
      }else if(info.chance>0){
        const typeLabel=info.type==='special'?'特殊生还':'普通生还';
        const note=info.type==='special'
          ? '你曾放过'+Rules.labels[info.camp]+'角色，且从未击杀该阵营任何人。'
          : '该阵营好感：'+P.reputation[info.camp]+'。';
        const survived=Game.showWheel?await Game.showWheel({title:'死战 · '+typeLabel+'轮盘',chance:info.chance,
          successLabel:'生 还',failLabel:'死 亡',note}):Math.random()<info.chance;
        if(survived){
          const text='你在死战中败北，但在'+typeLabel+'轮盘上生还（'+Math.round(info.chance*100)+'%）。没有战胜奖励。';
          P.notes.push(text);Game.addLog('lgold',text);
          Game.afterBattleRecover();return settle('spared');
        }
        Game.addLog('lred','死战'+typeLabel+'轮盘失败（'+Math.round(info.chance*100)+'%）。');
      }else{
        Game.addLog('lred',info.type==='mahito'?'死战败北：真人绝不会放过你。':'死战败北：没有可用的生还概率。');
      }
    }
    Game.afterBattleRecover();return settle('lose');
  }
};

const originalRender=Game.render;
Game.render=function(){
  originalRender.call(this);if(!this.player)return;
  $('playerCard').insertAdjacentHTML('beforeend',
    '<div class="stat-line"><span>速度</span><b>'+campaignSpeed(this.player).toFixed(2)+'</b></div>'+CampaignUI.panel());
  $('btnFaction').onclick=()=>CampaignUI.showFactions();
};
Game.flipSides=function(enemies,allies,noFlip){
  const P=Rules.init(this.player);
  const prepare=list=>deepCopy(list||[]).map(e=>Object.assign(e,{faction:Rules.campOf(e)})).filter(e=>{
    const record=P.deadCharacters[Rules.characterKey(e.name)];
    // 有死亡记录就跳过该角色的所有形态（包括式神/变化形态），只排除野生杂兵与召唤物。
    if(record&&!e.wild&&!e.summonTag){this.addLog('lgold','【角色缺席】'+e.name+'已阵亡，本场不再参战。');return false;}
    return true;
  });
  const es=prepare(enemies),as=prepare(allies);
  if(P.isFree)return {enemies:es.concat(as),allies:[],villain:false,free:true};
  const villain=P.isVillain&&!noFlip;
  return {enemies:villain?as:es,allies:villain?es:as,villain};
};
Game.hunt=async function(){
  const P=Rules.init(this.player);
  const items=Player.huntPool(P).map(p=>({label:lvName(p.tier)+'咒灵',weight:p.weight,tier:p.tier}));
  const pick=await openWheelModal({title:'狩猎转盘（同级咒灵权重50%）',items});
  const sides={enemies:[{name:pick.label,li:pick.tier,type:'咒灵',wild:true,faction:'villain'}],allies:[],villain:false};
  this.addLog('lg','你外出狩猎，遭遇了【'+pick.label+'】。');
  const result=await CampaignUI.fight(sides,{title:'狩猎 · '+pick.label,deathmatch:!P.isVillain});
  if(this.over)return;
  if(result==='win')P.huntCount++;
  else if(result==='lose'&&!P.isVillain)this.ending('death',{title:'狩猎咒灵'});
  else if(result==='lose')this.addLog('lgold','诅咒路线：本场为非死战，你在败北后脱身。');
};
Game.runStage=async function(day,node,si){
  if(this.over)return;
  const stage=node.stages[si];if(!stage)return;
  if(stage.intro)await this.storyModal(node.title+'（第'+(si+1)+'场）',stage.intro);
  const sides=this.flipSides(stage.enemies,stage.allies,stage.noFlip);
  const last=si>=node.stages.length-1,villainFinal=node.final&&sides.villain;
  const deathmatch=villainFinal?last:stage.lose==='die'&&(!sides.villain||!!stage.gotoMain);
  if(!sides.enemies.length){
    this.addLog('lgold','本场没有可参战的敌方角色，跳过交战，不发放战斗奖励。');
    if(!last)return this.runStage(day,node,si+1);
    if(stage.gotoMain)return this.enterMainArc();
    if(stage.futureFinal)return this.ending('futureWin');
    if(node.final)return this.resolveFinalWin();
    return;
  }
  const result=await CampaignUI.fight(sides,{title:node.title+(node.stages.length>1?' · 第'+(si+1)+'场':''),deathmatch,scene:(node.scenePrefix||'s')+day+'_'+si});
  if(this.over)return;
  if(result==='win'){
    if(stage.winSkill==='blackFlash'&&!this.player.blackFlash){
      this.player.blackFlash=true;this.player.notes.push('京都篇战胜东堂葵，学会黑闪');
      await this.storyModal('领悟 · 黑闪','你在这场战斗中领悟了黑闪。');
    }
    if(villainFinal)return last?this.resolveFinalWin():this.runStage(day,node,si+1);
    if(stage.gotoMain)return this.enterMainArc();
    if(stage.futureFinal)return this.ending('futureWin');
    if(stage.winNext&&!last)return this.runStage(day,node,si+1);
    if(node.final)return this.resolveFinalWin();
    return;
  }
  if(result==='spared'||result==='flee'){
    if(stage.gotoMain)return this.advanceMainAfterEscape();
    if(stage.futureFinal||(node.final&&last))return this.ending('survived',node);
    if((stage.lose==='next'||villainFinal)&&!last)return this.runStage(day,node,si+1);
    return;
  }
  if(villainFinal)return last?this.ending('loseFinal',node):this.runStage(day,node,si+1);
  if(stage.lose==='next')return last?undefined:this.runStage(day,node,si+1);
  if(deathmatch)return this.ending(node.final?'loseFinal':'death',node);
  this.addLog('lg','本场为非死战，战败后剧情继续。');
};
Game.runBattleCfg=async function(day,b,node,sceneLabel){
  if(this.over)return;
  const sides=this.flipSides(b.enemies,b.allies,b.noFlip);
  if(!sides.enemies.length){this.addLog('lgold','本场敌方角色已缺席，跳过交战，不发放奖励。');return;}
  const deathmatch=!(sides.villain&&!node.final)&&b.lose!=='continue';
  const result=await CampaignUI.fight(sides,{title:node.title,deathmatch,scene:(node.scenePrefix||'s')+day+'_'+sceneLabel});
  if(this.over)return;
  if(result==='lose'&&deathmatch)this.ending(node.final?'loseFinal':'death',node);
};
Game.advanceMainAfterEscape=async function(){
  const P=this.player;
  P.arc='main';P.startDay=0;this.day=0;P.age+=10;P.ageGrowthBonus=+ageGrowthBonus(P.age,P.identity).toFixed(3);
  P.eraLabel='宿傩受肉虎杖时期';P.eraDesc='你在怀玉终战中幸存，十年后继续自己的旅途。';
  P.notes.push('怀玉终战幸存，未获战胜奖励，十年后进入主线。');
  await this.storyModal('怀玉篇 · 幸存者的十年','你保住了性命，却没有赢得终战。没有获得六眼或甚尔道具。十年后，你进入2018年主线。');
  this.render();
};
const originalStoryModal=Game.storyModal;
Game.storyModal=function(title,text,chapter,extraHtml){
  // 死战提醒/结算属于规则提示，不做「已阵亡」标注。
  if(text&&this.player&&this.player.deadCharacters&&!/死战/.test(title||'')){
    const dead=[];
    for(const [key,record] of Object.entries(this.player.deadCharacters)){
      const names=[...(Rules.aliasList?Rules.aliasList(key):[key]),(record&&record.name)||key].filter(Boolean);
      if(names.some(n=>text.includes(n)))dead.push({key,record,names});
    }
    if(dead.length){
      // 角色名均为中文、·、#、全角括号，不含正则元字符，可直接拼进分组。
      const marks=[...new Set(dead.flatMap(d=>d.names))].filter(n=>text.includes(n)).sort((a,b)=>b.length-a.length);
      if(marks.length){
        const re=new RegExp('('+marks.join('|')+')','g');
        const marked=text.replace(re,(m,_name,offset,whole)=>
          whole.slice(offset+m.length).startsWith('（已阵亡）')?m:m+'（已阵亡）');
        text='【世界线已改变】'+dead.map(d=>d.key).join('、')+'已阵亡，后续不再参战。\n\n'+marked;
      }
    }
  }
  return originalStoryModal.call(this,title,text,chapter,extraHtml);
};
const originalEnding=Game.ending;
Game.ending=function(kind,node){
  if(kind!=='survived')originalEnding.call(this,kind,node);
  else{
    this.over=true;closeModal();hideAllScreens();
    const section=document.createElement('section');section.className='screen';
    section.innerHTML='<div class="ending-wrap"><h2 class="ending-title">终战 · 生还</h2><p>你没有赢得最后的战斗，但保住了性命。本次旅程以生还结束，不授予通关奖励。</p><button class="btn" onclick="location.reload()">重新开始</button></div>';
    document.body.appendChild(section);
  }
  const P=Rules.init(this.player),wrap=document.querySelector('.ending-wrap');
  if(wrap){
    // 旧结局文案假定全部敌人死亡；用实际处置记录取代，避免放过后仍宣称被消灭。
    const story=wrap.querySelector('.ending-text');
    if(story)story.textContent=(kind==='win'||kind==='futureWin'?'你赢得了终战。':'你未能赢得终战。')+
      '\n本次世界线由战后选择决定：处决 '+P.executions+' 人，放过 '+P.sparedCount+' 人。已阵亡角色不再出现在后续剧情中。\n'+P.notes.slice(-12).join('\n');
    const summary=document.createElement('p');summary.className='campaign-summary';
    summary.textContent='最终阵营：'+P.factionLabel+'｜高专好感 '+P.reputation.hero+'｜诅咒好感 '+P.reputation.villain+
      '｜已阵亡：'+(Object.values(P.deadCharacters).map(d=>d.name+'（已阵亡）').join('、')||'无');
    wrap.appendChild(summary);
    if(kind==='futureWin'){const heading=wrap.querySelector('.ending-title');if(heading)heading.textContent='未来篇 · 终战胜利';}
  }
};


/* 把数据与逻辑暴露给测试环境（浏览器中无副作用） */
// Production: game state stays inside its lexical closure.

/* ============================ IX. 事件绑定 & 启动 ============================ */
$('btnStart').onclick=()=>Game.startCreate();
$('btnRestartTitle').onclick=()=>location.reload();
$('btnVersus').onclick=()=>{SFX.click();VS.showLobby();};
// —— 跨网对战（PeerJS云信令）——
$('vsOnlineCreate').onclick=()=>{SFX.click();VS.createOnlineRoom();};
$('vsOnlineJoin').onclick=()=>{SFX.click();$('vsOnlineJoinPanel').classList.remove('hidden');$('vsLanPanel').classList.add('hidden');$('vsOnlineCode').focus();};
$('vsDoOnlineJoin').onclick=()=>{SFX.click();VS.joinOnlineRoom($('vsOnlineCode').value);};
$('vsCopyOnlineCode').onclick=()=>{SFX.click();
  const ta=document.createElement('textarea');ta.value=$('vsOnlineCodeDisplay').textContent;
  document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);
};
// —— 局域网直连（备选）——
$('vsLanToggle').onclick=()=>{SFX.click();const p=$('vsLanPanel');p.classList.toggle('hidden');$('vsOnlineJoinPanel').classList.add('hidden');};
$('vsLanCreate').onclick=()=>{SFX.click();VS.createRoom();};
// —— 本机对战 ——
$('vsLocalPlay').onclick=()=>{SFX.click();
  const act=prompt('本机对战：\n1 = 创建本机房间（房主）\n2 = 加入本机房间（输入房间ID）');
  if(act==='1')VS.localHost();
  else if(act==='2')VS.localJoin();
};
$('vsDoJoin').onclick=()=>{SFX.click();VS.doJoin();};
$('vsRoomAnswerBtn').onclick=()=>{SFX.click();VS.doRoomAnswer();};
$('vsCopyInvite').onclick=()=>{SFX.click();$('vsRoomInviteCode').select();document.execCommand('copy');};
$('vsCopyGuestAnswer').onclick=()=>{SFX.click();$('vsGuestAnswerCode').select();document.execCommand('copy');};
$('vsBackTitle').onclick=()=>{SFX.click();VS.leaveRoom();hideAllScreens();$('titleScreen').classList.remove('hidden');};
// —— 本地对战房间 ——
$('vsReady').onclick=()=>{SFX.click();VS.toggleReady();};
$('vsStartBattle').onclick=()=>{SFX.click();VS.startBattle();};
$('vsLeaveRoom').onclick=()=>{SFX.click();VS.leaveRoom();};
$('vsJoinRed').onclick=()=>{SFX.click();VS.joinTeam('red');};
$('vsJoinBlue').onclick=()=>{SFX.click();VS.joinTeam('blue');};
// —— 角色选择 tab ——
document.querySelectorAll('.vs-tab').forEach(b=>b.onclick=()=>{
  SFX.click();
  document.querySelectorAll('.vs-tab').forEach(x=>x.classList.remove('on'));b.classList.add('on');
  const isNpc=b.dataset.vstab==='npc';
  $('vsNpcGrid').classList.toggle('hidden',!isNpc);
  $('vsCustomList').classList.toggle('hidden',isNpc);
});
// —— 原创角色转盘 ——
$('vsSpin').onclick=()=>{SFX.click();VS.doSpin();};
$('vsQuickCreate').onclick=()=>{SFX.click();VS.quickCreateChar();};
$('vsNextWheel').onclick=()=>{SFX.click();VS.nextCreateWheel();};
$('vsConfirmChar').onclick=()=>{SFX.click();VS.confirmCreateChar();};
document.querySelectorAll('.vwspd').forEach(b=>b.onclick=()=>{
  SFX.click();VS._createSpeed=+b.dataset.vwspd;
  document.querySelectorAll('.vwspd').forEach(x=>x.classList.toggle('on',x===b));
});
$('btnSpin').onclick=()=>Game.doSpin();
$('btnNextWheel').onclick=()=>Game.nextStep();
$('btnActionWheel').onclick=()=>Game.dailyAction();
$('btnShowAttr').onclick=()=>Game.showDetail();
$('modalMask').addEventListener('click',e=>{/* 战斗/剧情模态禁止点遮罩关闭，防误触 */});
// —— 抽取/开始按钮点击音 ——
['btnStart','btnSpin','btnNextWheel','btnActionWheel','btnShowAttr','btnRestartTitle'].forEach(id=>{const el=$(id);if(el)el.addEventListener('click',()=>SFX.click());});
// —— 音效开关 ——
(function(){const b=$('btnSound');if(!b)return;
  const sync=()=>{b.textContent=SFX.muted?'🔇 音效关':'🔊 音效开';b.classList.toggle('off',SFX.muted);};
  sync();b.onclick=()=>{SFX.setMuted(!SFX.muted);if(!SFX.muted)SFX.unlock()||SFX.click();sync();};})();
// —— 语音念诵独立开关（只控制领域/极之番的语音播报，不影响音效与大字特效）——
(function(){const b=$('btnVoice');if(!b)return;
  const sync=()=>{b.textContent=SFX.voiceOn===false?'🗣 语音关':'🗣 语音开';b.classList.toggle('off',SFX.voiceOn===false);};
  sync();b.onclick=()=>{SFX.setVoice(SFX.voiceOn===false);if(SFX.voiceOn!==false)SFX.unlock();SFX.click();sync();};})();
// —— 全屏切换（特性检测，兼容不同浏览器）——
(function(){const b=$('btnFullscreen');if(!b)return;
  const fe=()=>document.fullscreenElement||document.webkitFullscreenElement;
  b.onclick=()=>{SFX.click();
    try{
      if(!fe()){const el=document.documentElement;(el.requestFullscreen||el.webkitRequestFullscreen||function(){}).call(el);}
      else{(document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);}
    }catch(e){}
  };
  const upd=()=>{b.textContent=fe()?'⛶ 退出全屏':'⛶ 全屏';};
  document.addEventListener('fullscreenchange',upd);document.addEventListener('webkitfullscreenchange',upd);})();
// —— 转盘转速 1×/2×/3× ——
document.querySelectorAll('.wspd').forEach(b=>{
  if(+b.dataset.wspd===SPIN_SPEED){document.querySelectorAll('.wspd').forEach(x=>x.classList.remove('on'));b.classList.add('on');}
  b.onclick=()=>{SFX.click();SPIN_SPEED=+b.dataset.wspd;
    try{localStorage.setItem('jjk_spin_speed',SPIN_SPEED);}catch(e){}
    document.querySelectorAll('.wspd').forEach(x=>x.classList.toggle('on',x===b));};
});


Object.defineProperty(window, "closeModal", {value: closeModal, writable:false, configurable:false});
})();