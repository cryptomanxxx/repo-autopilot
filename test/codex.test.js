import test from 'node:test';
import assert from 'node:assert/strict';
import {codexStatus} from '../src/codex.js';
const head='abcdef0123456789abcdef0123456789abcdef01';
const user={login:'chatgpt-codex-connector[bot]'};
const at='2026-10-10T12:00:00Z', later='2026-10-10T12:00:01Z';
const summary=(sha='abcdef0')=>({user,body:`<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${at}">time</relative-time> | \`${sha}\` | Manual request |`,html_url:'https://github.com/a/b/pull/1'});
const thumb={user,content:'+1',created_at:later};
test('current completed review plus subsequent Codex thumb yields clear status',()=>assert.equal(codexStatus(head,{comments:[summary()],reactions:[thumb]}).state,'clear'));
test('thumb alone, old summary and foreign thumbs never establish current clearance',()=>{assert.equal(codexStatus(head,{reactions:[thumb]}).state,'unverified');assert.equal(codexStatus(head,{comments:[summary('1234567')],reactions:[thumb]}).state,'unverified');assert.equal(codexStatus(head,{comments:[summary()],reactions:[{...thumb,user:{login:'someone'}}]}).state,'unverified');assert.equal(codexStatus(head,{comments:[summary()],reactions:[{...thumb,created_at:'2026-10-09'}]}).state,'unverified');});
test('latest current outcome overrides earlier findings, but newer findings override clearance',()=>{const finding={user,original_commit_id:head,created_at:at};const clear={user,created_at:later,body:'Codex Review: Didn\'t find any major issues.\n**Reviewed commit:** `abcdef0123`'};assert.equal(codexStatus(head,{inline:[finding],comments:[clear]}).state,'clear');assert.equal(codexStatus(head,{inline:[{...finding,created_at:'2026-10-10T12:01:00Z'}],comments:[clear]}).state,'findings');});
test('new requests, running summaries and truncated histories stay distinct',()=>{assert.equal(codexStatus(head,{comments:[summary(),{user:{login:'owner'},body:'@codex review',created_at:'2026-10-10T12:02:00Z'}],reactions:[thumb]}).state,'requested');const running=summary();running.body=running.body.replace('Completed','In progress');assert.equal(codexStatus(head,{comments:[running]}).state,'running');assert.equal(codexStatus(head,{comments:[summary()],reactions:[thumb],truncated:true}).state,'incomplete');assert.equal(codexStatus(head).state,'unknown');});
test('a review request made before the current head was committed does not count for it',()=>{
  const ask={user:{login:'owner'},body:'@codex review',created_at:'2026-10-10T12:02:00Z'};
  assert.equal(codexStatus(head,{comments:[ask],headAt:'2026-10-10T12:05:00Z'}).state,'unknown','asked about earlier code');
  assert.equal(codexStatus(head,{comments:[ask],headAt:'2026-10-10T12:01:00Z'}).state,'requested','asked after this commit');
  assert.equal(codexStatus(head,{comments:[ask]}).state,'requested','without the commit time every request counts, as before');
});

test('a Codex clearance carries the time it was given',()=>{
  assert.equal(codexStatus(head,{comments:[summary()],reactions:[thumb]}).clearedAt,new Date(thumb.created_at).toISOString());
  assert.equal(codexStatus(head,{reactions:[thumb]}).clearedAt,undefined);
});

test('bot account rejection is distinct from pending and never clears code',()=>{
  const request={user:{login:'github-actions[bot]'},body:'@codex review',created_at:'2026-10-10T12:02:00Z'};
  const rejected={user,body:'To use Codex here, [create a Codex account and connect to github](https://chatgpt.com/codex/cloud/settings/connectors).',created_at:'2026-10-10T12:02:03Z',html_url:'https://github.com/a/b/pull/1#issuecomment-1'};
  const retry={...request,user:{login:'owner'},created_at:'2026-10-10T12:03:00Z'};
  const state=comments=>codexStatus(head,{comments});
  assert.equal(state([request,rejected]).state,'rejected');
  assert.equal(state([request,rejected]).retryAnchor,Date.parse(rejected.created_at));
  assert.equal(state([request,{...rejected,user:{login:'owner'}}]).state,'requested');
  assert.equal(state([request,rejected,retry]).state,'requested');
  assert.equal(state([request,rejected,retry,{user,created_at:'2026-10-10T12:04:00Z',body:"Codex Review: Didn't find any major issues.\\n**Reviewed commit:** `abcdef0123`"}]).state,'clear');
  assert.equal(codexStatus(head,{comments:[request,rejected],headAt:'2026-10-10T12:05:00Z'}).state,'unverified');
  assert.equal(codexStatus(head,{comments:[request,rejected],truncated:true}).state,'incomplete');
});
