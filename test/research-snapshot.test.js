import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDashboardSample,dashboardAnalytics} from '../src/research-snapshot.js';
const repository='owner/repo',updatedAt='2026-11-03T10:00:00Z';
const opts={repository,start:'2026-11-01T00:00:00Z',end:'2026-11-04T00:00:00Z'};
const url=n=>'https://github.com/'+repository+'/pull/'+n;
const listed=(n=1,extra={})=>({number:n,url:url(n),state:'merged',updatedAt,...extra});
const detail=(n=1,extra={})=>({...listed(n),headSha:'a'.repeat(40),openedAt:'2026-11-01T12:00:00Z',mergedAt:'2026-11-02T12:00:00Z',ci:'success',checksComplete:true,postMergeCi:{sha:'b'.repeat(40),state:'failure',complete:true,available:true},progress:{reviewCount:2,truncated:false,updatesAfterReview:3,findings:{p1:0,p2:1,incomplete:false}},...extra});
const overview=(pulls=[listed()])=>({repository,fetchedAt:'2026-11-04T12:00:00Z',pulls});
const run=(o=overview(),d=[detail()])=>dashboardAnalytics(o,d,opts);
test('maps existing dashboard fields and separates CI',()=>{
 const r=run();assert.equal(r.openedInWindow,1);assert.equal(r.mergedInWindow,1);assert.equal(r.prCI.counts.success,1);assert.equal(r.mainCI.counts.failure,1);assert.equal(r.reviewRounds.observedTotal,2);assert.equal(r.reviewRounds.lowerBound,true);assert.equal(r.commitsAfterReview.observedTotal,3);
});
test('fallback timestamp is never treated as actual opening',()=>{
 const r=run(overview(),[detail(1,{detailError:'unavailable',openedAt:updatedAt})]);assert.equal(r.openedUnknown,1);assert.equal(r.mergedUnknown,1);assert.equal(r.prCI.counts.unknown,1);assert.equal(r.mainCI.counts.unknown,1);assert.equal(r.dashboardCoverage.unavailable,1);
});
test('missing detail is unknown not zero',()=>{const r=run(overview(),[]);assert.equal(r.reviewRounds.unknown,1);assert.equal(r.dashboardCoverage.unavailable,1);});
test('changed timestamp or state is stale',()=>{for(const changes of [{updatedAt:'2026-11-03T11:00:00Z'},{state:'open'}]){const r=run(overview(),[detail(1,changes)]);assert.equal(r.dashboardCoverage.stale,1);assert.equal(r.prCI.counts.success,0);assert.equal(r.mergedInWindow,0);}});
test('rejects another repository overview',()=>assert.throws(()=>run({...overview(),repository:'other/repo'}),RangeError));
test('foreign detail not counted as current head',()=>{const r=run(overview(),[detail(1,{url:'https://github.com/other/repo/pull/1'})]);assert.equal(r.dashboardCoverage.unbound,1);assert.equal(r.prCI.counts.unknown,1);});
test('missing head not counted as success',()=>{const r=run(overview(),[detail(1,{headSha:''})]);assert.equal(r.dashboardCoverage.unbound,1);assert.equal(r.prCI.counts.success,0);});
test('main CI requires available merge SHA',()=>{const r=run(overview(),[detail(1,{postMergeCi:{state:'success',complete:true,available:true,sha:null}})]);assert.equal(r.mainCI.counts.unknown,1);});
test('incomplete checks never become green',()=>{const r=run(overview(),[detail(1,{checksComplete:false,postMergeCi:{state:'success',complete:false,available:true,sha:'b'.repeat(40)}})]);assert.equal(r.prCI.counts.incomplete,1);assert.equal(r.mainCI.counts.incomplete,1);});
test('truncated findings lower bound and commits unknown',()=>{const r=run(overview(),[detail(1,{progress:{reviewCount:3,truncated:true,updatesAfterReview:4,findings:{p1:1,p2:0,incomplete:true}}})]);assert.equal(r.p1.lowerBound,true);assert.equal(r.commitsAfterReview.unknown,1);});
test('pinned extra outside recent sample ignored',()=>{const r=run(overview(),[detail(),detail(2)]);assert.equal(r.population,1);assert.equal(r.dashboardCoverage.ignoredExtra,1);});
test('duplicate detail does not select green',()=>{const r=run(overview(),[detail(),detail(1,{ci:'failure'})]);assert.equal(r.dashboardCoverage.unavailable,1);assert.equal(r.prCI.counts.success,0);});
test('duplicates in overview do not inflate totals',()=>{const r=run(overview([listed(),listed()]));assert.equal(r.population,1);assert.equal(r.dashboardCoverage.duplicateListed,1);});
test('sample bounds and coverage explicit',()=>{assert.throws(()=>normalizeDashboardSample(overview(Array.from({length:31},(_,i)=>listed(i+1))),[],opts),RangeError);const r=run();assert.equal(r.dashboardCoverage.completeHistory,false);assert.equal(r.humanInterventions,null);});
