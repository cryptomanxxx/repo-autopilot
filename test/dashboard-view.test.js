import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeBlocker,CODEX_ACTIONS,findingStatus} from '../worker/public/dashboard-view.js';

test('the dashboard offers merging only after a Codex 👍 and with no known blocker',()=>{
  const pr={codex:{state:'clear'},readiness:{state:'unknown',reasons:['GitHub merge eligibility is not confirmed']}};
  assert.equal(mergeBlocker(pr),'','unverified items are confirmed in the dialog, not blocking');
  assert.equal(mergeBlocker({...pr,readiness:{state:'ready',reasons:[]}}),'');
  for(const state of ['findings','running','requested','unverified','unknown']) assert.match(mergeBlocker({...pr,codex:{state}}),/Codex 👍/);
  assert.match(mergeBlocker({...pr,readiness:{state:'not_ready',reasons:['CI failed']}}),/Not ready: CI failed/);
});

test('the dashboard offers to ask Codex to review code it has not reviewed, and never to fix',()=>{
  const offered=state=>CODEX_ACTIONS.filter(a=>a.show(state)).map(a=>a.kind);
  assert.deepEqual(offered('findings'),[],'findings are fixed in the pull request, not by asking Codex');
  for(const state of ['unknown','unverified']) assert.deepEqual(offered(state),['review']);
  for(const state of ['clear','running','requested','incomplete']) assert.deepEqual(offered(state),[],'nothing to ask while Codex is busy or done, or its history is cut off');
});

test('a Codex finding is fixed when its thread is resolved or a later Codex 👍 cleared the code, never just because code changed',()=>{
  const at='2026-10-15T01:00:00Z',later='2026-10-15T02:00:00Z',earlier='2026-10-15T00:00:00Z';
  const state=(f,clearedAt)=>findingStatus({at,...f},{clearedAt}).state;
  assert.equal(state({resolved:true,outdated:false}),'fixed');
  assert.equal(findingStatus({resolved:true}).why,'resolved on GitHub');
  assert.equal(state({resolved:false,outdated:false},later),'fixed','a Codex 👍 after the finding clears it');
  assert.match(findingStatus({at,resolved:null},{clearedAt:later}).why,/Codex 👍/);
  assert.equal(state({resolved:false,outdated:false},earlier),'open','a 👍 from before the finding was reported does not cover it');
  assert.equal(state({resolved:false,outdated:true},earlier),'changed');
  assert.equal(findingStatus({resolved:false},{clearedAt:later}).state,'open','a finding without a time is not cleared');
  assert.equal(state({resolved:false,outdated:true}),'changed','changed code waits for Codex');
  assert.equal(state({resolved:false,outdated:false}),'open');
  assert.equal(state({resolved:null,outdated:null}),'unverified');
});

test('connector summaries keep unknown findings and unknown commits apart from known ones',async()=>{
  const {pullSummary}=await import('../worker/src/tools.js');
  const base={number:1,title:'T',readiness:{state:'unknown',label:'Details unavailable',reasons:[]},codex:{state:'unknown',label:'Codex: details unavailable'}};
  const failed=pullSummary({...base,progress:{reviewCount:null},detailError:'GitHub request failed (502).'});
  assert.deepEqual([failed.findingsAvailable,failed.findingCounts],[false,null],'a failed load is not "no findings"');
  const unknown=pullSummary({...base,progress:{findings:{items:[{priority:'P2',title:'F',at:'2026-10-16T00:00:00Z',commit:null,current:false,resolved:null}]}}});
  assert.equal(unknown.findings[0].commit,null);
});
