// RA-S01: pure aggregation of explicitly normalized, bounded PR snapshots.
// No network, provider calls, persistence, or inference of autonomous activity.
const DAY=86400000;
const CI=['success','failure','pending','skipped','unknown','incomplete'];
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
function timestamp(v) {
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) return null;
  const n=Date.parse(v);
  if(!Number.isFinite(n)) return null;
  return new Date(n).toISOString()===v.replace(/Z$/,v.includes('.')?'Z':'.000Z')?n:null;
}
function ciState(value,complete) {
  if(complete!==true) return complete===false?'incomplete':'unknown';
  return CI.includes(value)?value:'unknown';
}
function distribution(values) {
  values.sort((a,b)=>a-b);
  const n=values.length;
  if(!n) return {n:0,meanMs:null,medianMs:null,minMs:null,maxMs:null};
  return {n,meanMs:values.reduce((a,b)=>a+b,0)/n,
    medianMs:(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2,
    minMs:values[0],maxMs:values[n-1]};
}
function counts() {return Object.fromEntries(CI.map(k=>[k,0]));}
function metric() {return {observedTotal:0,known:0,unknown:0,lowerBound:false};}
function addMetric(m,value,complete) {
  const n=count(value);
  if(n===null) {m.unknown++;return;}
  m.known++;m.observedTotal+=n;
  if(complete!==true) m.lowerBound=true;
}
export function aggregatePulls(records,{repository,start,end,fetchedAt}={}) {
  const from=timestamp(start),to=timestamp(end),observed=timestamp(fetchedAt);
  if(typeof repository!=='string'||! /^[\w.-]+\/[\w.-]+$/.test(repository)||
      from===null||to===null||observed===null||to<=from||to>observed||
      from%DAY!==0||to%DAY!==0||to-from>366*DAY||
      !Array.isArray(records)||records.length>1000) throw new RangeError('Invalid analytics scope');
  const days=[];
  for(let t=from;t<to;t+=DAY) days.push({date:new Date(t).toISOString().slice(0,10),opened:0,merged:0});
  // Duplicates with conflicting content are excluded rather than selecting a green snapshot.
  const groups=new Map();
  let invalid=0,duplicates=0,conflicts=0;
  for(const p of records) {
    if(!p||p.repository!==repository||!Number.isSafeInteger(p.number)||p.number<=0) {invalid++;continue;}
    const row={number:p.number,openedAt:p.openedAt??null,mergedAt:p.mergedAt??null,merged:p.merged??null,
      prCI:p.prCI??null,prCIComplete:p.prCIComplete??null,mainCI:p.mainCI??null,mainCIComplete:p.mainCIComplete??null,
      reviewRounds:p.reviewRounds??null,p1:p.p1??null,p2:p.p2??null,commitsAfterReview:p.commitsAfterReview??null,
      reviewComplete:p.reviewComplete??null,findingsComplete:p.findingsComplete??null,commitsComplete:p.commitsComplete??null};
    const key=p.number;
    if(groups.has(key)) {
      duplicates++;
      const prior=groups.get(key);
      if(prior!==null&&JSON.stringify(prior)!==JSON.stringify(row)) {groups.set(key,null);conflicts++;}
    } else groups.set(key,row);
  }
  const prCI=counts(),mainCI=counts(),duration=[],reviewRounds=metric(),p1=metric(),p2=metric(),commitsAfterReview=metric();
  let population=0,openedUnknown=0,mergedUnknown=0,openedOutside=0,mergedOutside=0,notMerged=0,invalidDuration=0,mergedInWindow=0,openedInWindow=0,mergedPopulation=0;
  for(const p of groups.values()) {
    if(!p) continue;
    population++;
    const o=timestamp(p.openedAt),m=timestamp(p.mergedAt);
    const validOpen=o!==null&&o<=observed;
    const validMerge=p.merged===true&&m!==null&&m<=observed&&(o===null||m>=o);
    if(!validOpen) openedUnknown++;
    else if(o>=from&&o<to) {days[Math.floor((o-from)/DAY)].opened++;openedInWindow++;}
    else openedOutside++;
    if(p.merged===true) mergedPopulation++;
    if(p.merged===false&&p.mergedAt===null) notMerged++;
    else if(!validMerge) mergedUnknown++;
    else if(m>=from&&m<to) {
      days[Math.floor((m-from)/DAY)].merged++;mergedInWindow++;
      if(validOpen) duration.push(m-o);else invalidDuration++;
    } else mergedOutside++;
    // CI and review distributions describe the retrieved snapshot population, not historical events.
    prCI[ciState(p.prCI,p.prCIComplete)]++;
    if(p.merged===true) mainCI[ciState(p.mainCI,p.mainCIComplete)]++;
    addMetric(reviewRounds,p.reviewRounds,false); // edited Codex summaries imply a lower bound
    addMetric(p1,p.p1,p.findingsComplete);
    addMetric(p2,p.p2,p.findingsComplete);
    addMetric(commitsAfterReview,p.commitsAfterReview,p.commitsComplete);
  }
  return {repository,start,end,fetchedAt,coverage:'retrieved_sample_only',inputCount:records.length,
    population,invalid,duplicates,conflicts,days,openedInWindow,mergedInWindow,
    openedUnknown,mergedUnknown,openedOutside,mergedOutside,notMerged,
    duration:distribution(duration),invalidDuration,
    prCI:{denominator:population,counts:prCI},mainCI:{denominator:mergedPopulation,counts:mainCI},
    reviewRounds,p1,p2,commitsAfterReview,
    humanInterventions:null,autonomousPRs:null,agentRuntime:null,incrementalCost:null,scientificAcceptance:null};
}
