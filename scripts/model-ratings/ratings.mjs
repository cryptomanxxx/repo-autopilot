// The model ratings file (worker/src/model-ratings.json): its format, how a run's results become
// stars, and the strict check every file passes before it is committed or deployed.
export const PROVIDERS=Object.freeze(['blablador','hip']);
export const TASK_IDS=Object.freeze(['bugfix','implement','edit','json','reading','bugfix-deep','implement-csv','reading-async','edit-multi']);
// Bumped whenever the tasks change: ratings from other tasks are not comparable and are dropped.
export const VERSION=2;
// A model slower than this (median seconds per answer) loses one star.
export const SLOW_SECONDS=45;
const MAX_MODELS=1000;
const LEASE=/g1\.[A-Za-z0-9_-]{30,400}\.[A-Za-z0-9_-]{43}/;
export const validId=id=>typeof id==='string'&&id.length<=220&&!LEASE.test(id)&&
  /^([a-z]+):(.+)$/s.test(id)&&PROVIDERS.includes(id.slice(0,id.indexOf(':')))&&
  !/[\u0000-\u001f\u007f]/.test(id)&&id.slice(id.indexOf(':')+1)===id.slice(id.indexOf(':')+1).trim();

// The share of tasks passed gives the stars: all is ⭐⭐⭐⭐⭐, at least 85% ⭐⭐⭐⭐, 65% ⭐⭐⭐, 40% ⭐⭐,
// less ⭐. A slow model loses one.
export function stars(passed,seconds,total=TASK_IDS.length) {
  const share=passed/total;
  const base=share>=1?5:share>=0.85?4:share>=0.65?3:share>=0.4?2:1;
  return seconds!==null&&seconds>SLOW_SECONDS&&base>1?base-1:base;
}
export const median=list=>{
  if(!list.length) return null;
  const sorted=[...list].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  return Math.round((sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2)*10)/10;
};
export const empty=()=>({version:VERSION,tasks:[...TASK_IDS],models:{}});

// Throws unless the value is exactly a ratings file; returns it otherwise.
export function validate(value) {
  const fail=reason=>{throw new Error('Invalid model ratings: '+reason);};
  const plain=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
  if(!plain(value)||Object.keys(value).sort().join()!=='models,tasks,version') fail('top-level keys');
  if(value.version!==VERSION) fail('version');
  if(JSON.stringify(value.tasks)!==JSON.stringify(TASK_IDS)) fail('tasks');
  if(!plain(value.models)||Object.keys(value.models).length>MAX_MODELS) fail('models');
  for(const [id,entry] of Object.entries(value.models)) {
    if(!validId(id)) fail('model id '+JSON.stringify(id).slice(0,80));
    if(!plain(entry)||Object.keys(entry).sort().join()!=='passed,seconds,stars,testedAt,total') fail('entry keys for '+id);
    const {passed,seconds,stars:given,testedAt,total}=entry;
    if(total!==TASK_IDS.length||!Number.isInteger(passed)||passed<0||passed>total) fail('passed for '+id);
    if(seconds!==null&&(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0||seconds>600)) fail('seconds for '+id);
    if(given!==stars(passed,seconds)) fail('stars for '+id);
    if(typeof testedAt!=='string'||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/.test(testedAt)||Number.isNaN(Date.parse(testedAt))) fail('date for '+id);
  }
  return value;
}
