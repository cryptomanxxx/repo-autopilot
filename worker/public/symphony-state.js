// Offline, aggregate-only normalization of the pinned upstream state presenter.
// No network transport, persistent storage, task identifiers or control authority.
export const SYMPHONY_REVISION='be10a1b79df723d6d7612b5651c8522704dafb2e';
const MAX_BYTES=262144,MAX_ROWS=1000;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const count=v=>Number.isSafeInteger(v)&&v>=0;
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v.replace('Z','.000Z');
function invalid(){throw new TypeError('Invalid Symphony state snapshot');}
function unavailable(reason){return {state:'unavailable',reason,running:null,retrying:null,blocked:null,queued:null,failed:null,totals:null,rateLimits:null,actualCost:null,dispatchAuthorized:false,sourceVerified:false};}
export function normalizeSymphonyState(bytes,{upstreamRevision,inspectedAt=Date.now()}={}){
  if(upstreamRevision!==SYMPHONY_REVISION||!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>MAX_BYTES||!Number.isSafeInteger(inspectedAt)||!Number.isFinite(new Date(inspectedAt).getTime()))invalid();
  let payload;
  try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{invalid();}
  if(!record(payload)||!timestamp(payload.generated_at))invalid();
  const generated=Date.parse(payload.generated_at);
  // Upstream timestamps are second precision. Future timestamps are invalid,
  // not evidence of fresh status. Local inspection cannot prove clock sync.
  if(generated>inspectedAt)invalid();
  if(Object.hasOwn(payload,'error')){
    if(!record(payload.error)||!['snapshot_timeout','snapshot_unavailable'].includes(payload.error.code)||['counts','running','retrying','blocked','codex_totals','rate_limits'].some(k=>Object.hasOwn(payload,k)))invalid();
    return {...unavailable(payload.error.code),generatedAt:payload.generated_at,inspectedAt:new Date(inspectedAt).toISOString()};
  }
  if(!record(payload.counts)||!record(payload.codex_totals)||!Object.hasOwn(payload,'rate_limits'))invalid();
  const identities=new Set(),counts={};
  for(const name of ['running','retrying','blocked']){
    const rows=payload[name],n=payload.counts[name];
    if(!count(n)||!Array.isArray(rows)||rows.length>MAX_ROWS||rows.length!==n)invalid();
    counts[name]=n;
    for(const row of rows){
      if(!record(row)||typeof row.issue_id!=='string'||!row.issue_id||row.issue_id.length>256||identities.has(row.issue_id)||typeof row.issue_identifier!=='string'||!row.issue_identifier||row.issue_identifier.length>256)invalid();
      identities.add(row.issue_id);
      if(name==='running'&&!count(row.turn_count))invalid();
      if(name==='retrying'&&(!count(row.attempt)||row.attempt<1))invalid();
    }
  }
  const totals=payload.codex_totals;
  for(const name of ['input_tokens','output_tokens','total_tokens'])if(!count(totals[name]))invalid();
  if(typeof totals.seconds_running!=='number'||!Number.isFinite(totals.seconds_running)||totals.seconds_running<0)invalid();
  if(payload.rate_limits!==null&&!record(payload.rate_limits))invalid();
  return {state:'snapshot',generatedAt:payload.generated_at,inspectedAt:new Date(inspectedAt).toISOString(),ageMs:inspectedAt-generated,
    stale:inspectedAt-generated>=180000,...counts,queued:null,failed:null,
    totals:{inputTokens:totals.input_tokens,outputTokens:totals.output_tokens,totalTokens:totals.total_tokens,aggregateRuntimeSeconds:totals.seconds_running},
    rateLimits:null,rateLimitPayloadPresent:payload.rate_limits!==null,actualCost:null,dispatchAuthorized:false,sourceVerified:false};
}
