import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDareRead,workerBlobSha} from '../worker/src/dare-read.js';
import {gitBlobSha} from '../src/dare-status.js';
const repository='owner/repo',stamp=Date.parse('2026-11-28T07:00:00Z'),revision='b'.repeat(40);
const status={schemaVersion:1,repository,roadmap:'research/DARE-ROADMAP.md',asOf:'2026-11-28',basisRevision:'a'.repeat(40),kind:'maintainer_status_snapshot',liveExecution:'not_authorized',incrementalBudget:{currency:'SEK',maximum:0,actual:null},phases:[]};
const bytes=new TextEncoder().encode(JSON.stringify(status));
const file={type:'file',path:'research/dare-status.v1.json',size:bytes.length,encoding:'base64',sha:gitBlobSha(bytes),content:Buffer.from(bytes).toString('base64')};
const permit={operatorApproved:true,includedCapacityVerified:true,noPaidFallback:true,authorizedRepository:repository,expiresAt:stamp+60000};
function fixture({responses=[{full_name:repository,default_branch:'main'},{sha:revision},file],options={}}={}){
 const calls=[];
 const fetchImpl=async(url,init)=>{calls.push({url,init});const item=responses[calls.length-1];if(item instanceof Response)return item;return new Response(JSON.stringify(item));};
 const run=()=>prepareDareRead({repository,token:'fixture-only',permit,fetchImpl,now:()=>stamp,...options});
 return {calls,run};
}
test('Web Crypto blob hash agrees with existing Node implementation',async()=>assert.equal(await workerBlobSha(bytes),gitBlobSha(bytes)));
test('missing approval, cost verification, scope or expiry makes zero requests',async()=>{
 for(const patch of [{operatorApproved:false},{includedCapacityVerified:false},{noPaidFallback:false},{authorizedRepository:'other/repo'},{expiresAt:stamp},{}]){
  const f=fixture({options:{permit:Object.keys(patch).length?{...permit,...patch}:undefined}});
  assert.equal((await f.run()).state,'blocked');assert.equal(f.calls.length,0);
 }
});
test('successful fixture uses three GETs and pins contents to returned commit',async()=>{
 const f=fixture();const x=await f.run();assert.equal(x.state,'available');assert.equal(x.source.containingRevision,revision);assert.equal(x.status.basisRevision,'a'.repeat(40));assert.equal(x.dispatchAuthorized,false);
 assert.deepEqual(f.calls.map(c=>c.url),['https://api.github.com/repos/owner/repo','https://api.github.com/repos/owner/repo/commits/main','https://api.github.com/repos/owner/repo/contents/research/dare-status.v1.json?ref='+revision]);
 for(const c of f.calls){assert.equal(c.init.method,'GET');assert.equal(c.init.redirect,'error');}
});
test('unexpected repository identity fails before next request',async()=>{const f=fixture({responses:[{full_name:'other/repo',default_branch:'main'}]});await assert.rejects(f.run());assert.equal(f.calls.length,1);});
test('invalid revision fails without reading contents',async()=>{const f=fixture({responses:[{full_name:repository,default_branch:'main'},{sha:'main'}]});await assert.rejects(f.run());assert.equal(f.calls.length,2);});
test('missing file or throttling stops without retry',async()=>{for(const code of [404,403,429]){const f=fixture({responses:[{full_name:repository,default_branch:'main'},{sha:revision},new Response('',{status:code})]});await assert.rejects(f.run());assert.equal(f.calls.length,3);}});
test('reject malformed or unbound contents',async()=>{for(const patch of [{type:'symlink'},{path:'research/other.json'},{encoding:'utf8'},{size:65537},{sha:'0'.repeat(40)},{content:'!!!!'},{size:1}]){const f=fixture({responses:[{full_name:repository,default_branch:'main'},{sha:revision},{...file,...patch}]});await assert.rejects(f.run());assert.equal(f.calls.length,3);}});
test('bounded response rejects oversized body without subsequent calls',async()=>{const f=fixture({responses:[new Response('x'.repeat(131073))]});await assert.rejects(f.run());assert.equal(f.calls.length,1);});
test('expired permit during read stops before further GET',async()=>{let clock=stamp;const f=fixture({options:{now:()=>clock,fetchImpl:async()=>{clock=permit.expiresAt;return new Response(JSON.stringify({full_name:repository,default_branch:'main'}));}}});await assert.rejects(f.run());});
test('invalid repository and token cannot initiate requests',async()=>{const f=fixture({options:{repository:'owner/..',permit:{...permit,authorizedRepository:'owner/..'}}});await assert.rejects(f.run());assert.equal(f.calls.length,0);const g=fixture({options:{token:''}});await assert.rejects(g.run());assert.equal(g.calls.length,0);});
