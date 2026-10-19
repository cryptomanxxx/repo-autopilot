// Collects the answers of the model rating run: every chosen model gets each task once through the
// AI gateway, one call at a time. Reads the run's gateway lease from LEASE_FILE and never prints it;
// writes only the models' answers and timings to OUT. Grading happens in a later job.
import {readFileSync,writeFileSync} from 'node:fs';
import {TASKS,SYSTEM} from './tasks.mjs';
import {validId,validate} from './ratings.mjs';

const {AI_GATEWAY_URL:gateway,LEASE_FILE,OUT,RATINGS,PROVIDER='all',MAX_MODELS='8'}=process.env;
const lease=readFileSync(LEASE_FILE,'utf8').trim();
const expires=JSON.parse(Buffer.from(lease.split('.')[1],'base64url').toString('utf8')).exp;
// Each model takes one call per task; a lease allows 100 calls.
const limit=Math.max(1,Math.min(Math.floor(100/TASKS.length),Number.parseInt(MAX_MODELS,10)||8));
const secondsLeft=()=>expires-Math.floor(Date.now()/1000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const headers={Authorization:'Bearer '+lease,'Content-Type':'application/json'};

let previous={};
// Ratings from an older set of tasks count as untested.
try {previous=validate(JSON.parse(readFileSync(RATINGS,'utf8'))).models;} catch {}

const listed=await fetch(gateway+'/v1/models',{headers,signal:AbortSignal.timeout(30000)});
if(!listed.ok) throw new Error('The gateway did not list the models (HTTP '+listed.status+').');
const catalog=await listed.json();
for(const [provider,status] of Object.entries(catalog.providers||{})) console.log(`Provider ${provider}: ${status}`);
// Untested models first, then those tested longest ago. Within each of the two groups the providers
// take turns, so that each run rates some of every provider's models without rerating one
// provider's models while another still has untested ones.
const ordered=(catalog.data||[])
  .filter(row=>validId(row?.id)&&(PROVIDER==='all'||row.provider===PROVIDER))
  .sort((a,b)=>(previous[a.id]?.testedAt||'').localeCompare(previous[b.id]?.testedAt||'')||a.id.localeCompare(b.id));
function inTurn(rows) {
  const queues=new Map();
  for(const row of rows) queues.set(row.provider,[...(queues.get(row.provider)||[]),row]);
  const result=[];
  while([...queues.values()].some(queue=>queue.length))
    for(const queue of queues.values()) if(queue.length) result.push(queue.shift());
  return result;
}
const chosen=[...inTurn(ordered.filter(row=>!previous[row.id])),...inTurn(ordered.filter(row=>previous[row.id]))].slice(0,limit);
console.log(`Rating ${chosen.length} model(s): ${chosen.map(row=>row.id).join(', ')}`);

// One answer. The gateway's per-minute limits answer 429 for a while; that is waited out.
async function ask(model,task) {
  for(let attempt=0;attempt<8;attempt++) {
    if(secondsLeft()<150) return {status:'stopped'};
    const started=Date.now();
    let response;
    try {
      response=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers,signal:AbortSignal.timeout(125000),
        body:JSON.stringify({model,messages:[{role:'system',content:SYSTEM},{role:'user',content:task.prompt}],max_tokens:4096,temperature:0,stream:false})});
    } catch {return {status:'error',error:'no response'};}
    if(response.status===429) {
      const reason=(await response.json().catch(()=>({}))).error||'';
      if(/exhausted/i.test(reason)) return {status:'stopped'};
      await sleep(15000);continue;
    }
    if(!response.ok) {await response.body?.cancel();return {status:'error',error:'HTTP '+response.status};}
    const data=await response.json().catch(()=>null);
    const text=data?.choices?.[0]?.message?.content;
    if(typeof text!=='string') return {status:'error',error:'no answer text'};
    return {status:'ok',seconds:Math.round((Date.now()-started)/100)/10,text:text.slice(0,20000)};
  }
  return {status:'error',error:'rate limited'};
}

const models=[];
outer: for(const row of chosen) {
  const answers=[];
  for(const task of TASKS) {
    const result=await ask(row.id,task);
    if(result.status==='stopped') {console.log(`Stopped before ${row.id}: the lease is used up or about to expire.`);break outer;}
    answers.push({task:task.id,...result});
  }
  console.log(`${row.id}: ${answers.filter(a=>a.status==='ok').length}/${TASKS.length} answered`);
  models.push({id:row.id,answers});
}
writeFileSync(OUT,JSON.stringify({version:1,collectedAt:new Date().toISOString(),models}));
