/* 自定义规则 v3：阵营 / 生死 / 速度（档位内连续）/ 撤退。 */
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.JJKRules=factory();
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  const camps=['hero','villain'];
  const labels={hero:'高专阵营',villain:'诅咒阵营',free:'中立阵营'};
  const tuning={
    baseSpeedOffset:9.375, baseSpeedPerTier:1.25,
    effWeightBase:0.88, effWeightPerTier:0.02,
    projectionFloor:20,
    guaranteedEscapeRatio:1.3, failedEscapeRatio:0.7,
    escapeHpCoeff:0.5, escapeCap:0.75, escapeFloor:0.05,
    techniqueSpeed:{limitless:1.1,projection:1.45,godSpeed:1.3,amber:1.3,massKiller:1.25,tsukumo:1.2},
    amberSpeed:1.8, lightSpeed:2.5
  };
  const aliases={
    '两面宿傩':['两面宿傩','宿傩'],
    '五条悟':['五条悟','五条'],
    '虎杖悠仁':['虎杖悠仁','虎杖'],
    '禅院真希':['禅院真希','真希'],
    '乙骨犹花':['乙骨犹花','犹花'],
    '乙骨真剑':['乙骨真剑','真剑'],
    '乙骨忧太':['乙骨忧太','忧太'],
    '伏黑甚尔':['伏黑甚尔','甚尔'],
    '夏油杰':['夏油杰','夏油'],
    '钉崎野蔷薇':['钉崎野蔷薇','钉崎'],
    '七海建人':['七海建人','七海'],
    '东堂葵':['东堂葵','东堂']
  };
  function aliasList(key){return (aliases[key]||[key]).slice();}
  function init(P){
    P.faction=P.faction||(P.isFree?'free':P.isVillain?'villain':'hero');
    P.isFree=P.faction==='free';P.isVillain=P.faction==='villain';P.factionLabel=labels[P.faction];
    if(!P.reputation)P.reputation={hero:P.faction==='hero'?50:P.faction==='villain'?-50:0,villain:P.faction==='villain'?50:P.faction==='hero'?-50:0};
    P.betrayed=P.betrayed||{hero:false,villain:false};
    P.mercyPending=P.mercyPending||{hero:false,villain:false};
    P.sparedCamps=P.sparedCamps||{hero:0,villain:0};
    P.killedCamps=P.killedCamps||{hero:0,villain:0};
    P.deadCharacters=P.deadCharacters||{};P.executions=P.executions||0;P.sparedCount=P.sparedCount||0;
    P.lightSpeedCd=P.lightSpeedCd||0;
    return P;
  }
  function characterKey(name){
    if(/宿傩/.test(name))return '两面宿傩';
    if(/五条悟/.test(name))return '五条悟';
    if(/真人/.test(name))return '真人';
    if(/虎杖悠仁/.test(name))return '虎杖悠仁';
    if(/真希/.test(name))return '禅院真希';
    if(/乙骨犹花/.test(name))return '乙骨犹花';
    if(/乙骨真剑/.test(name))return '乙骨真剑';
    if(/乙骨忧太/.test(name))return '乙骨忧太';
    if(/达布拉/.test(name))return '达布拉';
    if(/马鲁/.test(name))return '马鲁';
    if(/夏油杰/.test(name))return '夏油杰';
    if(/伏黑甚尔/.test(name))return '伏黑甚尔';
    if(/伏黑惠/.test(name))return '伏黑惠';
    if(/禅院直哉/.test(name))return '禅院直哉';
    if(/钉崎/.test(name))return '钉崎野蔷薇';
    if(/七海/.test(name))return '七海建人';
    if(/东堂/.test(name))return '东堂葵';
    return String(name||'').split('#')[0];
  }
  /** 只有具名剧情角色才会死亡、缺席后续战斗；野生咒灵、杂兵、式神不进入死亡名单。 */
  function persistent(enemy){
    const name=String(enemy.name||'');
    if(enemy.wild||enemy.summonTag)return false;
    if(enemy.type==='式神'||enemy.type==='傀儡')return false;
    if(/^(?:咒术师|诅咒师|受肉体|变化人|人类|式神|傀儡|咒灵)$/.test(name))return false;
    return !/^(?:不入流|准四级|四级|三级|准二级|二级|准一级|一级|特别一级|准特级|弱特级|标准特级|强特级|超特级)咒灵$/.test(name);
  }
  function campOf(e){
    if(e.faction===null||e.faction==='free')return null;
    if(camps.includes(e.faction))return e.faction;
    const name=e.name||'';
    if(/五条悟|夏油杰|虎杖悠仁|伏黑惠|钉崎|七海|东堂|真希|禅院家主|九十九|乙骨|日车|秤金次|加茂|庵歌姬/.test(name))return 'hero';
    if(/宿傩|真人|羂索|里梅|伏黑甚尔|禅院直哉/.test(name))return 'villain';
    if(e.type==='式神')return null;
    if(e.type==='咒灵'||e.type==='诅咒师'||e.type==='受肉体'||e.type==='变化人')return 'villain';
    if(e.type==='咒术师')return 'hero';
    return null;
  }
  function change(P,camp,delta,raw=false){
    init(P);const before=P.reputation[camp];
    const adjusted=raw?delta:P.betrayed[camp]?(delta>0?delta/2:delta*2):delta;
    P.reputation[camp]=clamp(before+adjusted,-100,100);
    return {camp,requested:delta,adjusted,actual:P.reputation[camp]-before,value:P.reputation[camp]};
  }
  function disposition(P,e,choice){
    init(P);const camp=campOf(e),changes=[];let betrayal=false,exempt=false,expelled=false;
    if(choice==='kill'){
      P.executions++;
      if(persistent(e)){
        const key=characterKey(e.name);
        P.deadCharacters[key]={name:e.name,faction:camp,key};
      }
      if(camp){
        P.killedCamps[camp]=(P.killedCamps[camp]||0)+1;
        const other=camp==='hero'?'villain':'hero';
        if(P.faction==='free')changes.push(change(P,other,10),change(P,camp,-30));
        else if(P.faction!==camp)changes.push(change(P,P.faction,10),change(P,camp,-10));
        else if(P.faction==='villain'&&e.type==='咒灵'&&Number(e.li)<7){exempt=true;}
        else{
          changes.push(change(P,camp,-120));
          P.betrayed[camp]=true;betrayal=true;
          changes.push(change(P,other,20));
          // 弑同阵营：立即逐出，转为中立。
          P.faction='free';P.isFree=true;P.isVillain=false;P.factionLabel=labels.free;
          P.mercyPending={hero:false,villain:false};expelled=true;
        }
      }
    }else if(choice==='spare'){
      P.sparedCount++;
      if(camp)P.sparedCamps[camp]=(P.sparedCamps[camp]||0)+1;
      if(P.faction==='free'&&camp){changes.push(change(P,camp,10));P.mercyPending[camp]=true;}
    }else throw Error('Unknown disposition');
    return {choice,camp,changes,betrayal,exempt,expelled};
  }
  function beginEncounter(P,enemies){
    init(P);const ticket={hero:false,villain:false};
    for(const camp of new Set(enemies.map(campOf).filter(Boolean))){
      ticket[camp]=P.faction==='free'&&!!P.mercyPending[camp];P.mercyPending[camp]=false;
    }
    return ticket;
  }
  /** 获救判定详情：混合敌队取最不愿放过你的存活对手；真人一票否决。 */
  function mercyInfo(P,enemies,ticket={}){
    init(P);
    if(!enemies||!enemies.length)return {chance:0,source:'none',camp:null,name:null};
    if(enemies.some(e=>/真人/.test(e.name||'')))return {chance:0,source:'mahito',camp:'villain',name:'真人'};
    let worst=null;
    for(const e of enemies){
      const c=campOf(e);let info;
      if(!c)info={chance:0,source:'none',camp:null,name:e.name||''};
      else{
        const gratitude=(P.faction==='free'&&ticket[c])?(c==='hero'?0.7:0.3):0;
        const favor=P.reputation[c]>70?Math.min(0.7,0.4+(P.reputation[c]-70)*0.01):0;
        const chance=Math.max(gratitude,favor);
        const source=chance<=0?'none':(gratitude>=favor?'gratitude':'favor');
        info={chance,source,camp:c,name:e.name||''};
      }
      if(!worst||info.chance<worst.chance)worst=info;
    }
    return worst||{chance:0,source:'none',camp:null,name:null};
  }
  function mercyChance(P,enemies,ticket={}){return mercyInfo(P,enemies,ticket).chance;}
  /**
   * 死战生还轮盘：特殊生还（曾放过该阵营且从未击杀该阵营）vs 普通生还（好感>70）。
   * 每个阵营取较高的一项；混合敌队取最不愿放过的阵营；真人一票否决。
   */
  function survivalInfo(P,enemies){
    init(P);
    if(!enemies||!enemies.length)return {chance:0,type:'none',camp:null,name:null,special:0,normal:0};
    if(enemies.some(e=>/真人/.test(e.name||'')))return {chance:0,type:'mahito',camp:'villain',name:'真人',special:0,normal:0};
    const present=[...new Set(enemies.map(campOf).filter(Boolean))];
    if(!present.length)return {chance:0,type:'none',camp:null,name:null,special:0,normal:0};
    let worst=null;
    for(const c of present){
      const spared=(P.sparedCamps&&P.sparedCamps[c])||0;
      const killed=(P.killedCamps&&P.killedCamps[c])||0;
      const special=(spared>0&&killed===0)?(c==='hero'?0.7:0.3):0;
      const rep=P.reputation[c];
      const normal=rep>70?Math.min(0.7,0.4+(rep-70)*0.01):0;
      const chance=Math.max(special,normal);
      const type=chance<=0?'none':(special>=normal?'special':'normal');
      const name=(enemies.find(e=>campOf(e)===c)||{}).name||null;
      const info={chance,type,camp:c,name,special,normal};
      if(!worst||chance<worst.chance)worst=info;
    }
    return worst||{chance:0,type:'none',camp:null,name:null,special:0,normal:0};
  }
  function join(P,camp){
    init(P);if(!camps.includes(camp)||camp===P.faction||P.reputation[camp]<50)return {ok:false,changes:[]};
    const old=P.faction,other=camp==='hero'?'villain':'hero';
    const changes=[change(P,old==='free'?other:old,old==='free'?-30:-100,true)];
    P.faction=camp;P.isFree=false;P.isVillain=camp==='villain';P.factionLabel=labels[camp];
    P.mercyPending={hero:false,villain:false};
    return {ok:true,old,camp,changes};
  }
  /** 连续速度评分：档位 + 档内百分比，由 game.js 计算后传入。 */
  function baseSpeed(hpScore,effScore){
    const B=tuning.baseSpeedOffset+tuning.baseSpeedPerTier*Math.max(0,hpScore);
    const W=tuning.effWeightBase+tuning.effWeightPerTier*Math.max(0,effScore);
    return B*W;
  }
  /** 多个速度术式取最高，不叠乘。 */
  function techniqueMultiplier(flags){
    return [...new Set(flags||[])].reduce((m,f)=>Math.max(m,tuning.techniqueSpeed[f]||1),1);
  }
  /** 战斗中的二段形态：琥珀/亚光速取更高倍率。 */
  function activeTechniqueMultiplier(flags,amberActive,lightSpeedActive){
    const set=new Set(flags||[]);let m=techniqueMultiplier([...set]);
    if(amberActive&&set.has('amber'))m=Math.max(m,tuning.amberSpeed);
    if(lightSpeedActive&&set.has('massKiller'))m=Math.max(m,tuning.lightSpeed);
    return m;
  }
  /** 新撤退规则：≥1.3 必成，<0.7 必败，中间按最快敌人血量百分比。 */
  function escapeChance(player,enemies,effectiveSpeed=u=>u.speed){
    if(!player||player.alive===false||player.hp<=0)return 0;
    const foes=enemies.filter(e=>e.alive!==false&&e.hp>0);if(!foes.length)return 1;
    const fastest=foes.reduce((a,e)=>effectiveSpeed(e)>effectiveSpeed(a)?e:a);
    const ratio=effectiveSpeed(player)/Math.max(0.05,effectiveSpeed(fastest));
    if(ratio>=tuning.guaranteedEscapeRatio)return 1;
    if(ratio<tuning.failedEscapeRatio)return 0;
    const hpPct=u=>clamp(u.hp/Math.max(1,u.maxHp),0,1);
    const hpRatio=hpPct(player)/Math.max(0.01,hpPct(fastest));
    return clamp(tuning.escapeHpCoeff*hpRatio,tuning.escapeFloor,tuning.escapeCap);
  }
  return {labels,camps,tuning,aliases,aliasList,init,characterKey,persistent,campOf,change,disposition,beginEncounter,mercyInfo,mercyChance,survivalInfo,join,baseSpeed,techniqueMultiplier,activeTechniqueMultiplier,escapeChance};
});
