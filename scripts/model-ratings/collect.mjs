// Collects the answers of the model rating run: every chosen model gets each task once through the
// AI gateway, one call at a time. Reads the run's gateway lease from LEASE_FILE and never prints it;
// writes only the models' answers and timings to OUT. Grading happens in a later job.
import {readFileSync,writeFileSync} from 'node:fs';
import {TASKS,SYSTEM} from './tasks.mjs';
import {validId,validate} from './ratings.mjs';
// The same output limit as the agent chat gives gateway models, so a rating measures what the chat gets.
import {GATEWAY_OUTPUT_TOKENS as OUTPUT_TOKENS} from '../../worker/src/agent.js';

const {AI_GATEWAY_URL:gateway,LEASE_FILE,OUT,PROVIDER='all',MAX_MODELS='8',TIMEOUT_SECONDS='110'}=process.env;
// The gateway gives up on a generation after 120 seconds (and answers 502). A call that fails after
// this long is a model too slow for the task, not a provider error: it counts as a failed task.
const timeoutSeconds=Number(TIMEOUT_SECONDS)>0?Number(TIMEOUT_SECONDS):110;
// After this many timeouts a model is clearly too slow; its remaining tasks count as failed unasked.
const SLOW_AFTER=2;
const MAX_ANSWER_CHARS=64000;
const lease=readFileSync(LEASE_FILE,'utf8').trim();
const expires=JSON.parse(Buffer.from(lease.split('.')[1],'base64url').toString('utf8')).exp;
// The lease allows 100 calls. A model is started only while its tasks and a few retries still fit,
// so at most ten models (of nine tasks) fit in one run.
const LEASE_CALLS=100,RETRY_RESERVE=2;
const limit=Math.max(1,Math.min(Math.floor((LEASE_CALLS-RETRY_RESERVE)/TASKS.length),Number.parseInt(MAX_MODELS,10)||8));
const secondsLeft=()=>expires-Math.floor(Date.now()/1000);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const headers={Authorization:'Bearer '+lease,'Content-Type':'application/json'};

// The ratings stored in the gateway, to rate untested models first and then the oldest ones.
// Ratings from an older set of tasks count as untested.
let previous={};
try {
  const stored=await fetch(gateway+'/v1/ratings',{headers,signal:AbortSignal.timeout(30000)});
  if(stored.ok) previous=validate(await stored.json()).models;
} catch {}
console.log(`Stored ratings: ${Object.keys(previous).length}`);

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
console.log(`Output limit: ${OUTPUT_TOKENS} tokens per answer, ${timeoutSeconds} s per answer`);

let spent=0;
// Why an answer had no text: a model that thinks first may spend the whole output limit on its
// reasoning (finish reason "length") before writing the answer. Only counts and short names are logged.
function emptyDetails(data) {
  const choice=data?.choices?.[0],message=choice?.message;
  const reasoning=message?.reasoning_content??message?.reasoning;
  const parts=[];
  if(typeof choice?.finish_reason==='string') parts.push('finish '+choice.finish_reason.replace(/[^a-z_]/gi,'').slice(0,20));
  if(Number.isSafeInteger(data?.usage?.completion_tokens)) parts.push(data.usage.completion_tokens+' output tokens');
  if(typeof reasoning==='string') parts.push(reasoning.length+' characters of reasoning');
  if(Array.isArray(message?.tool_calls)) parts.push(message.tool_calls.length+' tool calls');
  if(!choice) parts.push('no choices');
  return parts.length?' ('+parts.join(', ')+')':'';
}
// The output limit for one task: OUTPUT_TOKENS, or less for a model whose context window would not
// hold the task and that many tokens (its provider refuses such a request with HTTP 400). The prompt is
// counted generously at three characters per token. row.cap lowers it further after such a refusal.
// The fallback leaves room for the prompt (well under 1,000 tokens) even in a 4,096-token context.
const FALLBACK_TOKENS=3072;
const knownContext=row=>Number.isSafeInteger(row.context_length)&&row.context_length>0;
function outputLimit(row,task) {
  const cap=row.cap??OUTPUT_TOKENS,context=row.context_length;
  if(!knownContext(row)) return cap;
  const room=context-Math.ceil((SYSTEM.length+task.prompt.length)/3)-64;
  return Math.max(256,Math.min(cap,room));
}
// One answer. The gateway's per-minute limits answer 429 for a while; that is waited out.
async function ask(row,task) {
  const model=row.id;
  for(let attempt=0;attempt<8;attempt++) {
    const maxTokens=outputLimit(row,task);
    if(secondsLeft()<150) return {status:'stopped'};
    const started=Date.now(),elapsed=()=>Math.round((Date.now()-started)/100)/10;
    const timedOut=()=>({status:'timeout',seconds:elapsed(),error:'no answer within '+timeoutSeconds+' s'});
    let response;
    try {
      response=await fetch(gateway+'/v1/chat/completions',{method:'POST',headers,signal:AbortSignal.timeout((timeoutSeconds+15)*1000),
        body:JSON.stringify({model,messages:[{role:'system',content:SYSTEM},{role:'user',content:task.prompt}],max_tokens:maxTokens,temperature:0,stream:false})});
    } catch {spent++;return elapsed()>=timeoutSeconds?timedOut():{status:'error',error:'no response'};}
    if(response.status===429) {
      const reason=(await response.json().catch(()=>({}))).error||'';
      if(/exhausted/i.test(reason)) return {status:'stopped'};
      await sleep(15000);continue;
    }
    // Every answered request uses one of the lease's calls, a provider error included.
    spent++;
    if(!response.ok) {
      await response.body?.cancel();
      // A model whose context window is unknown and too small for the full limit: asked once more at
      // once with a lower limit, which then holds for its remaining tasks.
      if(response.status===400&&maxTokens>FALLBACK_TOKENS&&!knownContext(row)) {
        row.cap=FALLBACK_TOKENS;
        console.log(`${model}: HTTP 400 at ${maxTokens} output tokens; asking with ${FALLBACK_TOKENS}`);
        continue;
      }
      return elapsed()>=timeoutSeconds?timedOut():{status:'error',error:'HTTP '+response.status};
    }
    const data=await response.json().catch(()=>null);
    const text=data?.choices?.[0]?.message?.content;
    const blank=typeof text!=='string'||!text.trim();
    if(blank&&elapsed()>=timeoutSeconds) return timedOut();
    // The whole output limit spent thinking (no text, or only blanks) is the model's own failure, as in
    // the chat: a failed task like a timeout, not a provider error.
    if(blank&&data?.choices?.[0]?.finish_reason==='length') return {status:'timeout',seconds:elapsed(),error:'no answer within the output limit'+emptyDetails(data)};
    if(typeof text!=='string') return {status:'error',error:'no answer text'+emptyDetails(data)};
    // Room for a whole answer at the output limit (8192 tokens are at most some 40,000 characters).
    return {status:'ok',seconds:elapsed(),text:text.slice(0,MAX_ANSWER_CHARS)};
  }
  return {status:'error',error:'rate limited'};
}

// Each model gets one call per task plus at most RETRY_RESERVE retries. A model whose provider fails
// more tasks than can be retried is given up at once, so a struggling provider cannot use up the
// lease; it stays untested and comes first next time. A timeout is not a provider error: it is a
// failed task, and after SLOW_AFTER of them the model's remaining tasks are failed without asking.
const models=[];
let stopped=false;
for(const row of chosen) {
  // A model of unknown context may need one more call, for the lower output limit after a refusal.
  const reserve=RETRY_RESERVE+(knownContext(row)?0:1);
  if(spent+TASKS.length+reserve>LEASE_CALLS) {console.log(`Stopped before ${row.id}: not enough of the lease's calls left.`);break;}
  const answers=[];
  let errors=0,timeouts=0;
  const smallest=Math.min(...TASKS.map(task=>outputLimit(row,task)));
  if(smallest<OUTPUT_TOKENS) console.log(`${row.id}: output limit down to ${smallest} tokens for its ${row.context_length}-token context`);
  for(const task of TASKS) {
    if(timeouts>=SLOW_AFTER) {answers.push({task:task.id,status:'timeout',seconds:null,error:'not asked: too slow'});continue;}
    const result=await ask(row,task);
    if(result.status==='stopped') {stopped=true;break;}
    answers.push({task:task.id,...result});
    if(result.status!=='ok') console.log(`${row.id}: ${task.id}: ${result.error}${result.seconds!==undefined?` after ${result.seconds} s`:''}`);
    if(result.status==='timeout') timeouts++;
    if(result.status==='error'&&++errors>RETRY_RESERVE) break;
  }
  if(stopped) {console.log(`Stopped at ${row.id}: the lease is used up or about to expire.`);break;}
  if(errors>RETRY_RESERVE) {
    console.log(`${row.id}: given up after ${errors} provider errors`);
  } else {
    // A failed task is asked once more right away, as its first try may have hit a busy moment.
    // Only a model with every task answered is rated.
    for(const [index,answer] of answers.entries()) {
      if(answer.status!=='error') continue;
      const result=await ask(row,TASKS.find(task=>task.id===answer.task));
      if(result.status==='stopped') {stopped=true;break;}
      answers[index]={task:answer.task,...result};
      console.log(`${row.id}: ${answer.task} asked again: ${result.status==='ok'?'answered':result.error}`);
    }
    console.log(`${row.id}: ${answers.filter(a=>a.status==='ok').length}/${TASKS.length} answered${timeouts?`, ${answers.filter(a=>a.status==='timeout').length} too slow`:''}`);
  }
  models.push({id:row.id,answers});
  if(stopped) break;
}
writeFileSync(OUT,JSON.stringify({version:1,collectedAt:new Date().toISOString(),models}));
