import {createHash} from 'node:crypto';

export const STATUS_PATH='research/dare-status.v1.json';
const MAX=65536;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const repo=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(v)&&!['.','..'].includes(v.split('/')[1]);
const id=v=>typeof v==='string'&&/^DARE-\d{3}$/.test(v);
const plain=(v,n)=>typeof v==='string'&&v.length>=1&&v.length<=n&&!/[\x00-\x1f\x7f]/.test(v);
const path=v=>plain(v,512)&&/^research\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(v)&&v.split('/').every(s=>s!=='.'&&s!=='..');
const one=(v,values)=>values.includes(v);
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const arr=(v,max)=>Array.isArray(v)&&v.length<=max;
function requireThat(ok,label){if(!ok)throw new TypeError('Invalid DARE status: '+label);}
function day(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
function instant(v){return typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;}

// JSON.parse alone silently accepts duplicate object keys. Scan valid JSON
// tokens as a second check, bounding nesting and comparing decoded keys.
function uniqueKeys(text){
  const tokens=text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)||[];
  let i=0;
  function scan(depth){
    requireThat(depth<=12,'nesting');
    const t=tokens[i++];
    if(t==='{'){
      const seen=new Set();
      if(tokens[i]==='}'){i++;return;}
      for(;;){const k=JSON.parse(tokens[i++]);requireThat(!seen.has(k),'duplicate key');seen.add(k);i++;scan(depth+1);if(tokens[i++]==='}')return;}
    }else if(t==='['){
      if(tokens[i]===']'){i++;return;}
      for(;;){scan(depth+1);if(tokens[i++]===']')return;}
    }
  }
  scan(0);requireThat(i===tokens.length,'tokens');
}
export function gitBlobSha(bytes){return createHash('sha1').update('blob '+bytes.byteLength+'\0').update(bytes).digest('hex');}

// source is trusted retrieval metadata supplied by the future authorized
// adapter. Hash matching checks bytes, not GitHub authorization or ancestry.
export function validateDareStatus(bytes,{selectedRepository,source}={}){
  requireThat(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=MAX,'byte size');
  requireThat(repo(selectedRepository)&&exact(source,['repository','path','containingRevision','blobSha','retrievedAt'])&&source.repository===selectedRepository&&source.path===STATUS_PATH&&sha(source.containingRevision)&&sha(source.blobSha)&&instant(source.retrievedAt),'source binding');
  requireThat(gitBlobSha(bytes)===source.blobSha,'blob mismatch');
  let text,value;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);value=JSON.parse(text);}catch{throw new TypeError('Invalid DARE status: UTF-8/JSON');}
  uniqueKeys(text);
  requireThat(exact(value,['schemaVersion','repository','roadmap','asOf','basisRevision','kind','liveExecution','incrementalBudget','phases']),'root fields');
  requireThat(value.schemaVersion===1&&value.repository===selectedRepository&&path(value.roadmap)&&day(value.asOf)&&value.asOf<=source.retrievedAt.slice(0,10)&&sha(value.basisRevision)&&value.kind==='maintainer_status_snapshot'&&value.liveExecution==='not_authorized','root values');
  const budget=value.incrementalBudget;
  requireThat(exact(budget,['currency','maximum','actual'])&&budget.currency==='SEK'&&budget.maximum===0&&(budget.actual===null||typeof budget.actual==='number'&&Number.isFinite(budget.actual)&&budget.actual>=0),'budget');
  requireThat(arr(value.phases,50),'phases');
  const phases=new Map();
  for(const p of value.phases){
    requireThat(exact(p,['id','title','dependsOn','development','gate','scientificAcceptance','evidence','blockers'])&&id(p.id)&&!phases.has(p.id)&&plain(p.title,120),'phase identity');
    requireThat(arr(p.dependsOn,50)&&p.dependsOn.every(id)&&new Set(p.dependsOn).size===p.dependsOn.length,'dependencies');
    requireThat(one(p.development,['planned','documented','implemented','in_progress','unknown'])&&one(p.gate,['not_evaluated','blocked','review_required','passed','unknown'])&&one(p.scientificAcceptance,['not_assessed','accepted','rejected','unknown']),'phase states');
    requireThat(arr(p.evidence,20)&&p.evidence.every(e=>exact(e,['path','kind','status'])&&path(e.path)&&one(e.kind,['audit','qualification','offline_test_report','integrity_notice','protocol','offline_candidate_capture','other'])&&one(e.status,['documented','reported','superseded','unverified','independently_verified'])),'evidence');
    requireThat(arr(p.blockers,20)&&p.blockers.every(s=>plain(s,500)),'blockers');
    phases.set(p.id,p);
  }
  const visiting=new Set(),done=new Set();
  function visit(key){requireThat(phases.has(key)&&!visiting.has(key),'missing dependency or cycle');if(done.has(key))return;visiting.add(key);for(const d of phases.get(key).dependsOn)visit(d);visiting.delete(key);done.add(key);}
  for(const key of phases.keys())visit(key);
  return {status:value,source:{...source},claimsOnly:true,dispatchAuthorized:false,budgetViolationReported:budget.actual!==null&&budget.actual>0};
}
