import test from 'node:test';
import assert from 'node:assert/strict';
import {readPrivateSymphony} from '../worker/src/symphony-private-read.js';
import {SYMPHONY_REVISION} from '../worker/public/symphony-state.js';
const repository='owner/repo',stamp=Date.parse('2026-11-28T07:00:00Z');
const permit={repository,revision:SYMPHONY_REVISION,ownerAuthorized:true,repositoryAccessVerified:true,privateHostVerified:true,scopeVerified:true,includedCapacityVerified:true,noPaidFallback:true,readApproved:true,expiresAt:stamp+60000};
const sample=()=>({schemaVersion:1,repository,upstreamRevision:SYMPHONY_REVISION,generatedAt:'2026-11-28T07:00:00Z',state:'snapshot',counts:{running:0,retrying:1,blocked:2},totals:{inputTokens:10,outputTokens:5,totalTokens:15,aggregateRuntimeSeconds:2.5}});
const bytes=v=>new TextEncoder().encode(JSON.stringify(v));
function fixture(options={},payload=sample()){
 const calls=[];
 const run=()=>readPrivateSymphony({repository,permit,now:()=>stamp,transport:async request=>{calls.push(request);return bytes(payload);},...options});
 return {calls,run};
}
test('missing or false prerequisite blocks all transport',async()=>{
 for(const key of ['ownerAuthorized','repositoryAccessVerified','privateHostVerified','scopeVerified','includedCapacityVerified','noPaidFallback','readApproved']){
  const f=fixture({permit:{...permit,[key]:false}});assert.equal((await f.run()).state,'blocked');assert.equal(f.calls.length,0);
 }
 for(const p of [undefined,{...permit,repository:'other/repo'},{...permit,revision:'main'},{...permit,expiresAt:stamp}]){const f=fixture({permit:p});assert.equal((await f.run()).state,'blocked');assert.equal(f.calls.length,0);}
});
test('one scoped aggregate read with bounded deadline and no authority',async()=>{
 const f=fixture(),x=await f.run();assert.deepEqual(f.calls,[{repository,revision:SYMPHONY_REVISION,operation:'read_aggregate_v1',deadline:stamp+10000}]);assert.equal(x.observation.counts.running,0);assert.equal(x.stopVerified,false);assert.equal(x.sourceVerified,false);assert.equal(x.dispatchAuthorized,false);assert.equal(x.actualCost,null);
});
test('wrong repo, revision, version and unexpected fields fail',async()=>{
 for(const patch of [{repository:'other/repo'},{upstreamRevision:'main'},{schemaVersion:2},{message:'private'},{counts:{...sample().counts,private:'secret'}}]){const f=fixture({}, {...sample(),...patch});await assert.rejects(f.run());assert.equal(f.calls.length,1);}
});
test('unavailable response never becomes zero counts',async()=>{const f=fixture({}, {...sample(),state:'unavailable',counts:null,totals:null});const x=await f.run();assert.equal(x.state,'unavailable');assert.equal(x.observation,null);assert.equal(x.stopVerified,false);});
test('invalid count, time or totals rejected',async()=>{for(const patch of [{generatedAt:'2026-11-28T07:00:01Z'},{generatedAt:'2026-02-30T00:00:00Z'},{counts:{running:-1,retrying:0,blocked:0}},{totals:{...sample().totals,aggregateRuntimeSeconds:-1}},{state:'unavailable'}])await assert.rejects(fixture({}, {...sample(),...patch}).run());});
test('invalid bytes and oversized response rejected',async()=>{for(const response of [new Uint8Array(),new Uint8Array([255]),new Uint8Array(16385),'{}'])await assert.rejects(fixture({transport:async()=>response}).run());});
test('expiry and elapsed deadline reject late responses',async()=>{for(const elapsed of [10000,60000]){let t=stamp;await assert.rejects(fixture({now:()=>t,transport:async()=>{t+=elapsed;return bytes(sample());}}).run());}});
test('transport errors propagate without fallback or retry',async()=>{let calls=0;await assert.rejects(fixture({transport:async()=>{calls++;throw Error('offline');}}).run());assert.equal(calls,1);});
test('stale historical state stays stale',async()=>{const f=fixture({}, {...sample(),generatedAt:'2026-11-28T06:57:00Z'});assert.equal((await f.run()).stale,true);});
