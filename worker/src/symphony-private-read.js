// Unconnected private read contract. The injected transport must be a trusted
// host-bound service, never a browser-provided URL or native Symphony endpoint.
import {SYMPHONY_REVISION} from '../public/symphony-state.js';
const MAX=16384;
const repo=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(v)&&!['.','..'].includes(v.split('/')[1]);
const exact=(v,keys)=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const time=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.replace('Z','.000Z');
const fail=()=>new Error('Private Symphony observation unavailable.');
const blocked=()=>({state:'blocked',sourceVerified:false,dispatchAuthorized:false,observation:null});
// These trusted host assertions are prerequisites, not verification mechanisms.
// No issuer, production binding, route or default transport exists.
export async function readPrivateSymphony({repository,permit,transport,now=Date.now}={}){
  const started=now();
  if(!repo(repository)||permit?.repository!==repository||permit?.revision!==SYMPHONY_REVISION||permit?.ownerAuthorized!==true||permit?.repositoryAccessVerified!==true||permit?.privateHostVerified!==true||permit?.scopeVerified!==true||permit?.includedCapacityVerified!==true||permit?.noPaidFallback!==true||permit?.readApproved!==true||!Number.isSafeInteger(started)||!Number.isSafeInteger(permit?.expiresAt)||permit.expiresAt<=started||typeof transport!=='function')return blocked();
  // One injected read only, no fallback, retries, arbitrary URL or refresh.
  // Transport must enforce its own deadline and authenticate the private host.
  const bytes=await transport({repository,revision:SYMPHONY_REVISION,operation:'read_aggregate_v1',deadline:Math.min(started+10000,permit.expiresAt)});
  const observed=now();
  if(!Number.isSafeInteger(observed)||observed<started||observed>=permit.expiresAt||observed>=started+10000||!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>MAX)throw fail();
  let v;
  try{v=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{throw fail();}
  if(!exact(v,['schemaVersion','repository','upstreamRevision','generatedAt','state','counts','totals'])||v.schemaVersion!==1||v.repository!==repository||v.upstreamRevision!==SYMPHONY_REVISION||!time(v.generatedAt)||Date.parse(v.generatedAt)>observed)throw fail();
  if(v.state==='unavailable'){
    if(v.counts!==null||v.totals!==null)throw fail();
  }else if(v.state==='snapshot'){
    if(!exact(v.counts,['running','retrying','blocked'])||!Object.values(v.counts).every(integer)||!exact(v.totals,['inputTokens','outputTokens','totalTokens','aggregateRuntimeSeconds'])||!['inputTokens','outputTokens','totalTokens'].every(k=>integer(v.totals[k]))||typeof v.totals.aggregateRuntimeSeconds!=='number'||!Number.isFinite(v.totals.aggregateRuntimeSeconds)||v.totals.aggregateRuntimeSeconds<0)throw fail();
  }else throw fail();
  // Scope/revision fields alone are not authenticated provenance. Until a
  // production trust boundary is independently qualified, never label verified.
  return {state:v.state,repository,generatedAt:v.generatedAt,observedAt:new Date(observed).toISOString(),stale:observed-Date.parse(v.generatedAt)>=180000,observation:v.state==='snapshot'?{counts:v.counts,totals:v.totals}:null,sourceVerified:false,dispatchAuthorized:false,actualCost:null,remainingQuota:null,stopVerified:false};
}
