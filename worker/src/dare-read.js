// Prepared adapter only: not wired into the Worker, routes or UI.
// The trusted host must independently resolve repository access, cost policy,
// and explicit operator approval. No default live allowance.
import {STATUS_PATH,validateStatusShape} from '../../src/dare-status-shape.js';
const MAX=65536;
const SHA=/^[a-f0-9]{40}$/;
const REPO=/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
const error=()=>new Error('DARE status unavailable or invalid.');
export async function workerBlobSha(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX)throw error();
  const header=new TextEncoder().encode('blob '+bytes.byteLength+'\0');
  const input=new Uint8Array(header.length+bytes.length);
  input.set(header);input.set(bytes,header.length);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',input)),v=>v.toString(16).padStart(2,'0')).join('');
}
async function boundedJSON(response){
  if(!response.ok||!response.body)throw error();
  const limit=128*1024;
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw error();}chunks.push(value);}
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function decodeFile(file){
  if(file?.type!=='file'||file.path!==STATUS_PATH||file.encoding!=='base64'||!SHA.test(file.sha||'')||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX||typeof file.content!=='string'||file.content.length>100000)throw error();
  const base=file.content.replace(/\r?\n/g,'');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base))throw error();
  const decoded=atob(base);
  if(decoded.length!==file.size||btoa(decoded)!==base)throw error();
  return Uint8Array.from(decoded,c=>c.charCodeAt(0));
}
// Transport is injectable for offline fixtures. The permit is a trusted host
// assertion, NOT a billing or authorization verification mechanism.
export async function prepareDareRead({repository,token,permit,fetchImpl=fetch,now=Date.now}={}){
  if(permit?.operatorApproved!==true||permit?.includedCapacityVerified!==true||permit?.noPaidFallback!==true||permit?.authorizedRepository!==repository||!Number.isSafeInteger(permit?.expiresAt)||!Number.isSafeInteger(now())||permit.expiresAt<=now())return {state:'blocked',reason:'Live read prerequisites not established.',dispatchAuthorized:false};
  if(typeof repository!=='string'||!REPO.test(repository)||['.','..'].includes(repository.split('/')[1])||typeof token!=='string'||!token)throw error();
  const root='https://api.github.com/repos/'+repository;
  const get=async path=>{
    if(now()>=permit.expiresAt)throw error();
    const response=await fetchImpl(root+path,{method:'GET',redirect:'error',headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','User-Agent':'repo-autopilot-chat','X-GitHub-Api-Version':'2022-11-28'},signal:AbortSignal.timeout(15000)});
    return boundedJSON(response);
  };
  // Resolve default branch through repository metadata; pin contents to the
  // exact commit rather than trusting a mutable branch or payload revision.
  const meta=await get('');
  if(meta.full_name!==repository||typeof meta.default_branch!=='string'||!meta.default_branch||meta.default_branch.length>255)throw error();
  const ref=await get('/commits/'+encodeURIComponent(meta.default_branch));
  if(!SHA.test(ref.sha||''))throw error();
  const file=await get('/contents/'+STATUS_PATH+'?ref='+ref.sha);
  const bytes=decodeFile(file);
  const retrievedAt=new Date(now()).toISOString();
  if(now()>=permit.expiresAt)throw error();
  const result=validateStatusShape(bytes,{selectedRepository:repository,source:{repository,path:STATUS_PATH,containingRevision:ref.sha,blobSha:file.sha,retrievedAt},computedBlobSha:await workerBlobSha(bytes)});
  return {state:'available',...result};
}
