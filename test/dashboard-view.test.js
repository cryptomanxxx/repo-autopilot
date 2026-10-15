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

test('a Codex finding is fixed when its thread is resolved or Codex cleared the current code, never just because code changed',()=>{
  const state=(f,cleared)=>findingStatus(f,{cleared}).state;
  assert.equal(state({resolved:true,outdated:false}),'fixed');
  assert.equal(findingStatus({resolved:true}).why,'resolved on GitHub');
  assert.equal(state({resolved:false,outdated:false},true),'fixed','a Codex 👍 on the current code clears earlier findings');
  assert.match(findingStatus({resolved:null},{cleared:true}).why,/Codex 👍/);
  assert.equal(state({resolved:false,outdated:true}),'changed','changed code waits for Codex');
  assert.equal(state({resolved:false,outdated:false}),'open');
  assert.equal(state({resolved:null,outdated:null}),'unverified');
});
