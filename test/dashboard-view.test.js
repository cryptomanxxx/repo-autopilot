import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeBlocker} from '../worker/public/dashboard-view.js';

test('the dashboard offers merging only after a Codex 👍 and with no known blocker',()=>{
  const pr={codex:{state:'clear'},readiness:{state:'unknown',reasons:['GitHub merge eligibility is not confirmed']}};
  assert.equal(mergeBlocker(pr),'','unverified items are confirmed in the dialog, not blocking');
  assert.equal(mergeBlocker({...pr,readiness:{state:'ready',reasons:[]}}),'');
  for(const state of ['findings','running','requested','unverified','unknown']) assert.match(mergeBlocker({...pr,codex:{state}}),/Codex 👍/);
  assert.match(mergeBlocker({...pr,readiness:{state:'not_ready',reasons:['CI failed']}}),/Not ready: CI failed/);
});
