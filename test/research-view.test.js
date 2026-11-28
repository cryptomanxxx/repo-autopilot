import test from 'node:test';
import assert from 'node:assert/strict';
import {completedWindow,researchModel,renderResearch} from '../worker/public/research-view.js';
const repository='owner/repo',fetchedAt='2026-11-28T07:00:00Z',now=Date.parse(fetchedAt);
const snapshot={repository,overview:{repository,fetchedAt,pulls:[]},details:[]};

test('completed days exclude current UTC day',()=>{
 assert.deepEqual(completedWindow(fetchedAt,7),{start:'2026-11-21T00:00:00.000Z',end:'2026-11-28T00:00:00.000Z'});
 assert.equal(completedWindow(fetchedAt,90).start,'2026-08-30T00:00:00.000Z');
 assert.throws(()=>completedWindow(fetchedAt,1),RangeError);
});
test('no data or another repository does not render a sample',()=>{
 assert.equal(researchModel(null,repository,7,now),null);
 assert.equal(researchModel(snapshot,'other/repo',7,now),null);
});
test('empty sample is explicit and case-insensitive repository selection works',()=>{
 const m=researchModel(snapshot,'OWNER/REPO',7,now);
 assert.equal(m.stats.population,0);assert.equal(m.stats.autonomousPRs,null);assert.equal(m.stale,false);
});
test('age, failed refresh and invalidation mark earlier samples',()=>{
 assert.equal(researchModel(snapshot,repository,7,now+180000).stale,true);
 assert.equal(researchModel(snapshot,repository,7,now-1).stale,true);
 assert.equal(researchModel({...snapshot,failed:true},repository,7,now).stale,true);
 assert.equal(researchModel({...snapshot,invalidated:true},repository,7,now).stale,true);
});
test('invalid sample is not presented as zero',()=>{
 const container={replaceChildren(){this.cleared=true;}},status={};
 renderResearch({snapshot:{...snapshot,overview:{...snapshot.overview,fetchedAt:'bad'}},repository,days:7,now,container,status});
 assert.equal(container.cleared,true);assert.match(status.textContent,/unavailable/);
});
test('no sample clears old output and offers manual loading',()=>{
 const container={replaceChildren(){this.cleared=true;}},status={};
 renderResearch({snapshot:null,repository,days:7,now,container,status});
 assert.equal(container.cleared,true);assert.match(status.textContent,/No dashboard sample/);
});
