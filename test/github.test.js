import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryName,ciState,createGitHub} from '../src/github.js';
test('repository paths cannot escape the GitHub repo endpoint',()=>{assert.equal(repositoryName('octocat/Hello-World'),'octocat/Hello-World');for(const bad of ['a/../secrets','https://evil.example/a/b','a/b?x=y','a/..','a/b/c']) assert.throws(()=>repositoryName(bad));});
test('missing, failed, unfinished and successful checks remain distinct',()=>{assert.equal(ciState([],[]),'unknown');assert.equal(ciState([{status:'in_progress'}],[]),'pending');assert.equal(ciState([{status:'completed',conclusion:'success'}],[{state:'failure'}]),'failure');assert.equal(ciState([{status:'completed',conclusion:'success'}],[]),'success');assert.equal(ciState([{status:'completed',conclusion:null}],[]),'pending');});
test('API failures never become a successful snapshot',async()=>{const api=createGitHub({fetchImpl:async()=>({ok:false,status:403})});await assert.rejects(api.snapshot('a/b'),/access denied/);});
test('snapshot ties checks to head SHA and retains Codex feedback',async()=>{const paths=[];const api=createGitHub({fetchImpl:async(url)=>{paths.push(url);let data={};if(url.endsWith('/repos/a/b')) data={full_name:'a/b',html_url:'https://github.com/a/b'};else if(url.includes('/pulls?')) data=[{number:1,title:'PR',html_url:'https://github.com/a/b/pull/1',state:'closed',head:{sha:'abc'}}];else if(url.includes('/actions/runs')) data={workflow_runs:[]};else if(url.includes('/check-runs')) data={check_runs:[{status:'completed',conclusion:'success'}]};else if(url.includes('/status?')) data={statuses:[]};else if(url.includes('/issues/')) data=[{user:{login:'chatgpt-codex-connector[bot]'},body:'Fix this',html_url:'https://github.com/a/b/pull/1'}];else data=[];return {ok:true,json:async()=>data};}});const result=await api.snapshot('a/b');assert.equal(result.autonomy,false);assert.equal(result.pulls[0].ci,'success');assert.equal(result.pulls[0].codexComments[0].body,'Fix this');assert.ok(paths.some(p=>p.includes('/commits/abc/check-runs')));});

test('completed stale checks are terminal failures, including alongside pending checks',()=>{const stale={status:'completed',conclusion:'stale'};assert.equal(ciState([stale],[]),'failure');assert.equal(ciState([stale,{status:'in_progress'}],[]),'failure');});

test('repository input accepts full GitHub URLs and surrounding whitespace',()=>{
  for(const value of ['a/b','  a/b  ','https://github.com/a/b','https://github.com/a/b/','https://github.com/a/b.git','https://github.com/a/b?tab=readme#readme']) assert.equal(repositoryName(value),'a/b');
  for(const value of [null,'','https://github.com/a/./b','https://github.com/a/../b','https://github.com/a/%2e%2e','https://github.com@evil.example/a/b','https://evil.example/a/b','https://github.com/a/b/pull/1','https://github.com/a/.','https://github.com/a/..','https://github.com/a/b%2fc']) assert.throws(()=>repositoryName(value));
});

test('authenticated merge verification cannot approve a changed head or truncated threads',async()=>{
 for(const variant of ['clean','changed','truncated','error']) {
  const head='abcdef1234567890';
  const pr={number:1,state:'open',head:{sha:head},mergeable:true};
  const fetchImpl=async(url,options)=>{
   let data=[];
   if(url.endsWith('/graphql')) {
    assert.equal(options.method,'POST');
    data=variant==='error'?{errors:[{message:'denied'}]}:{data:{repository:{pullRequest:{headRefOid:variant==='changed'?'bbbbbbb':head,mergeStateStatus:'CLEAN',reviewDecision:null,reviewThreads:{pageInfo:{hasNextPage:variant==='truncated'},nodes:[]}}}}};
   } else if(url.endsWith('/repos/a/b')) data={full_name:'a/b'};
   else if(url.includes('/pulls?')) data=[pr];
   else if(url.endsWith('/pulls/1')) data=pr;
   else if(url.includes('/actions/runs')) data={workflow_runs:[]};
   else if(url.includes('/check-runs')) data={check_runs:[{status:'completed',conclusion:'success'}]};
   else if(url.includes('/status?')) data={statuses:[]};
   else if(url.includes('/issues/1/comments')) data=[{user:{login:'chatgpt-codex-connector[bot]'},created_at:'2026-10-10T12:00:00Z',body:'Codex Review: Didn\'t find any major issues. Breezy!\n**Reviewed commit:** `abcdef1234567890`'}];
   return {ok:true,json:async()=>data};
  };
  const result=await createGitHub({token:'test-token',fetchImpl}).snapshot('a/b');
  assert.equal(result.pulls[0].readiness.state,variant==='clean'?'ready':'unknown');
 }
});

test('dashboard refresh signal cannot substitute for real CI',()=>{
 const signal={name:'repo-autopilot-review-refresh-signal',status:'completed',conclusion:'success'};
 assert.equal(ciState([signal],[]),'unknown');
 assert.equal(ciState([signal,{name:'test',status:'in_progress'}],[]),'pending');
 assert.equal(ciState([signal,{name:'test',status:'completed',conclusion:'failure'}],[]),'failure');
 assert.equal(ciState([signal,{name:'test',status:'completed',conclusion:'success'}],[]),'success');
});

test('a snapshot without access to workflow runs still lists pull requests, with a warning',async()=>{
  const api=createGitHub({userAgent:'test-agent',fetchImpl:async(url,options)=>{
    assert.equal(options.headers['User-Agent'],'test-agent');
    if(url.includes('/actions/runs')) return {ok:false,status:403,json:async()=>({})};
    return {ok:true,json:async()=>url.includes('/pulls?')?[]:{full_name:'a/b',html_url:'https://github.com/a/b'}};
  }});
  const data=await api.snapshot('a/b');
  assert.deepEqual(data.workflows,[]);assert.match(data.warnings[0],/GitHub Actions runs are unavailable: GitHub access denied/);
  const browser=createGitHub({fetchImpl:async(url,options)=>{assert.equal(options.headers['User-Agent'],undefined,'browsers keep their own User-Agent');return {ok:true,json:async()=>url.includes('/actions/runs')?{workflow_runs:[]}:url.includes('/pulls?')?[]:{full_name:'a/b'}};}});
  await browser.snapshot('a/b');
});

test('Codex findings show whether their review thread was resolved on GitHub',async()=>{
 const head='abcdef1234567890',pr={number:1,state:'open',head:{sha:head},mergeable:true};
 const finding=(id,title)=>({id,user:{login:'chatgpt-codex-connector[bot]'},body:`**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>  ${title}**`,original_commit_id:head,created_at:'2026-10-10T12:00:00Z',html_url:`https://github.com/a/b/pull/1#discussion_r${id}`});
 const fetchImpl=async url=>{
  let data=[];
  if(url.endsWith('/graphql')) data={data:{repository:{pullRequest:{headRefOid:head,mergeStateStatus:'BLOCKED',reviewDecision:null,reviewThreads:{pageInfo:{hasNextPage:false},nodes:[{isResolved:true,isOutdated:true,comments:{nodes:[{fullDatabaseId:'11'}]}},{isResolved:false,isOutdated:false,comments:{nodes:[{fullDatabaseId:'12'}]}},{isResolved:false,isOutdated:true,comments:{nodes:[{fullDatabaseId:'14'}]}}]}}}}};
  else if(url.endsWith('/pulls/1')) data=pr;
  else if(url.includes('/pulls/1/comments')) data=[finding(11,'Fixed already'),finding(12,'Still open'),finding(13,'Not a thread yet'),finding(14,'Code changed since')];
  else if(url.includes('/check-runs')) data={check_runs:[]};
  else if(url.includes('/status?')) data={statuses:[]};
  return {ok:true,json:async()=>data};
 };
 const {item}=await createGitHub({token:'test-token',fetchImpl}).pullDetails('a/b',pr);
 assert.deepEqual(item.progress.findings.items.map(f=>[f.title,f.resolved,f.outdated]),[['Fixed already',true,true],['Still open',false,false],['Not a thread yet',null,null],['Code changed since',false,true]]);
});
