import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewProgress,mergeReadiness} from '../src/progress.js';
const bot={login:'chatgpt-codex-connector[bot]'};
const head='abcdef1234567890';
const review={user:bot,state:'COMMENTED',commit_id:head,submitted_at:'2026-10-10T12:00:00Z'};
test('counts completed rounds once and counts subsequent commits as changes',()=>{
 const outcome={user:bot,created_at:review.submitted_at,body:'Codex Review: No issues. **Reviewed commit:** `abcdef1`'};
 const p=reviewProgress('bbbbbbb',{reviews:[review],comments:[outcome],commits:[{sha:head},{sha:'aaaaaaa'},{sha:'bbbbbbb'}]});
 assert.equal(p.reviewCount,1);assert.equal(p.updatesAfterReview,2);assert.equal(p.currentCompleted,false);
 assert.equal(reviewProgress(head,{reviews:[review]}).currentCompleted,true);
});
test('acknowledgement alone is not a completed review and truncated history is uncertain',()=>{
 const body='<!-- codex-pull-request-review-summary -->\n| Code Review | Running | `abcdef1` |';
 assert.equal(reviewProgress(head,{comments:[{user:bot,body}]}).reviewCount,0);
 const p=reviewProgress(head,{reviews:[review],commits:[{sha:head}],truncated:true});
 assert.equal(p.currentCompleted,false);assert.equal(p.updatesAfterReview,null);
});
const pr={state:'open',mergeable:true};
const verified={ci:'success',codex:{state:'clear'},verification:{complete:true,mergeStateStatus:'CLEAN',unresolvedThreads:0}};
test('ready requires current Codex clearance, complete checks and authenticated merge verification',()=>{
 assert.equal(mergeReadiness(pr,verified).state,'ready');
 for(const change of [{verification:{complete:false}},{checksComplete:false},{codex:{state:'unknown'}},{verification:{complete:true,mergeStateStatus:'UNKNOWN'}}]) assert.equal(mergeReadiness(pr,{...verified,...change}).state,'unknown');
});
test('reports blockers and terminal PR states',()=>{
 for(const change of [{ci:'failure'},{ci:'pending'},{codex:{state:'findings'}},{codex:{state:'running'}},{verification:{complete:true,unresolvedThreads:1}},{verification:{complete:true,reviewDecision:'REVIEW_REQUIRED'}},{verification:{complete:true,mergeStateStatus:'BLOCKED'}}]) assert.equal(mergeReadiness(pr,{...verified,...change}).state,'not_ready');
 assert.equal(mergeReadiness({...pr,draft:true},verified).state,'not_ready');
 assert.equal(mergeReadiness({...pr,mergeable:false},verified).state,'not_ready');
 assert.equal(mergeReadiness({...pr,merged:true},verified).state,'merged');
 assert.equal(mergeReadiness({state:'closed'},verified).state,'closed');
});

test('activity flow orders observed requests, reviews, changes, clear and merge without inventing fixes',()=>{
 const comments=[{user:{login:'human'},body:'@codex review',created_at:'2026-10-10T12:01:00Z'}];
 const reviews=[{...review,submitted_at:'2026-10-10T12:02:00Z'}];
 const commits=[{sha:'bbbbbbb',commit:{committer:{date:'2026-10-10T12:03:00Z'}}}];
 comments.push({user:bot,body:'<!-- codex-pull-request-review-summary -->\n| Code Review | Completed <relative-time datetime="2026-10-10T12:02:00Z">done</relative-time> | `abcdef1` |'});
 const p=reviewProgress(head,{openedAt:'2026-10-10T12:00:00Z',mergedAt:'2026-10-10T12:05:00Z',comments,reviews,commits,reactions:[{user:bot,content:'+1',created_at:'2026-10-10T12:04:00Z'}]});
 assert.deepEqual(p.events.map(e=>e.kind),['opened','requested','reviewed','changed','clear','merged']);
 assert.equal(p.events.some(e=>/fixed|agent/i.test(e.label)),false);
 const stale=reviewProgress('ccccccc',{reviews,reactions:[{user:bot,content:'+1',created_at:'2026-10-10T12:04:00Z'}]});
 assert.equal(stale.events.some(e=>e.kind==='clear'),false);
});

test('timeline thumb requires completed current-head summary, not just a review',()=>{
 const p=reviewProgress(head,{reviews:[review],reactions:[{user:bot,content:'+1',created_at:'2026-10-10T12:04:00Z'}]});
 assert.equal(p.events.some(e=>e.kind==='clear'),false);
});
