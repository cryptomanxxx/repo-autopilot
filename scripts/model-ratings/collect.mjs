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
// Untested models first, the providers taking turns, then those tested longest ago, so that each
// run rates some of every provider's models without rerating one provider's models while another
// still has untested ones.
const ordered=(catalog.data||[])
  .filter(row=>validId(row?.id)&&(PROVIDER==='all'||row.provider===PROVIDER))
  .sort((a,b)=>(previous[a.id]?.testedAt||'').localeCompare(previous[b.id]?.testedAt||'')||a.id.localeCompare(b.id));
// Each run starts the turns at a different provider and model (by the workflow's run number), so
// that small runs alternate and an untested model that keeps failing does not block the others.
const turn=Math.max(0,Number.parseInt(process.env.GITHUB_RUN_NUMBER,10)||0);
const rotate=(list,by)=>list.length?[...list.slice(by%list.length),...list.slice(0,by%list.length)]:list;
const providers=rotate([...new Set(ordered.map(row=>row.provider))].sort(),turn);
function inTurn(rows) {
  const queues=new Map(providers.map(provider=>[provider,[]]));
  for(const row of rows) queues.get(row.provider).push(row);
  for(const [provider,queue] of queues) queues.set(provider,rotate(queue,Math.floor(turn/providers.length)));
  const result=[];
  while([...queues.values()].some(queue=>queue.length))
    for(const queue of queues.values()) if(queue.length) result.push(queue.shift());
  return result;
}
// Rated models are simply taken oldest rating first: rerating moves a model to the back, so the
// providers keep taking turns there too.
const chosen=[...inTurn(ordered.filter(row=>!previous[row.id])),...ordered.filter(row=>previous[row.id])].slice(0,limit);
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

// A model whose provider fails this many tasks in a row is given up for this run, so that one
// struggling provider does not use up the lease; it stays untested and comes first next time.
const GIVE_UP_AFTER=3;
const models=[],givenUp=new Set();
let stopped=false;
for(const row of chosen) {
  const answers=[];
  let failures=0;
  for(const task of TASKS) {
    const result=await ask(row.id,task);
    if(result.status==='stopped') {stopped=true;break;}
    answers.push({task:task.id,...result});
    failures=result.status==='ok'?0:failures+1;
    if(failures>=GIVE_UP_AFTER) break;
  }
  if(stopped) {console.log(`Stopped at ${row.id}: the lease is used up or about to expire.`);break;}
  if(failures>=GIVE_UP_AFTER) {givenUp.add(row.id);console.log(`${row.id}: given up after ${GIVE_UP_AFTER} provider errors in a row`);}
  else console.log(`${row.id}: ${answers.filter(a=>a.status==='ok').length}/${TASKS.length} answered`);
  models.push({id:row.id,answers});
}
// A task the provider failed is asked once more at the end, when its first try may have hit a busy
// moment. Only a model with every task answered is rated.
retry: for(const model of models) {
  if(stopped||givenUp.has(model.id)) continue;
  for(const [index,answer] of model.answers.entries()) {
    if(answer.status!=='error') continue;
    const result=await ask(model.id,TASKS.find(task=>task.id===answer.task));
    if(result.status==='stopped') {stopped=true;break retry;}
    model.answers[index]={task:answer.task,...result};
    console.log(`${model.id}: ${answer.task} asked again, ${result.status==='ok'?'answered':'failed again'}`);
  }
}
writeFileSync(OUT,JSON.stringify({version:1,collectedAt:new Date().toISOString(),models}));
