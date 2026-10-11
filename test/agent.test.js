import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedAgentPath,validateEdits,taskInstruction,pendingTaskReply,agentMessages,applyAgentChanges,runAgent,TASK_MARKER,AGENT_MARKER,REPLY_MARKER} from '../src/agent.js';
import {taskUrl} from '../public/task-ui.js';
import {collectTasks} from '../src/tasks.js';

test('agent rejects infrastructure, hidden paths, duplicate edits and oversized changes',()=>{
  for(const p of ['.github/workflows/ci.yml','scripts/run-agent.js','src/agent.js','src/tasks.js','public/../.env','public/.env','package.json','public/a\\b.js']) assert.equal(allowedAgentPath(p),false,p);
  assert.equal(allowedAgentPath('public/app.js'),true);
  assert.throws(()=>validateEdits({summary:'x',files:[{path:'.github/workflows/ci.yml',content:'bad'}]},{}));
  assert.throws(()=>validateEdits({summary:'x',files:[{path:'public/app.js',content:'x'},{path:'public/app.js',content:'y'}]},{}));
  assert.throws(()=>validateEdits({summary:'x',files:[{path:'public/app.js',content:'x'.repeat(60001)}]},{}));
  assert.deepEqual(validateEdits({summary:'x',files:[{path:'public/app.js',content:'new',sha:'injected'}]},{}).files,[{path:'public/app.js',content:'new'}]);
});
test('existing files omitted from context cannot be replaced but new files are allowed',()=>{
  const result={summary:'change',files:[{path:'public/omitted.js',content:'invented replacement'}]};
  assert.throws(()=>validateEdits(result,{'public/app.js':'source'},['public/app.js','public/omitted.js']),/unread file/);
  assert.equal(validateEdits(result,{'public/app.js':'source'},['public/app.js']).files.length,1);
});

function harness({author='owner',closed=false,edits=[{path:'public/app.js',content:'new source'}]}={}) {
  const calls=[];let reads=0;
  const fetchImpl=async(url,options)=>{
    calls.push({url,...options});let data;
    if(url.startsWith('https://api.groq.com/')) data={choices:[{message:{content:JSON.stringify({summary:'Changed spacing',changes:edits.map(f=>({path:f.path,before:'old source',after:f.content}))})}}]};
    else if(url.endsWith('/repos/owner/project')) data={private:false,default_branch:'main'};
    else if(url.endsWith('/issues/1')) {reads++;data={state:closed && reads>1 ? 'closed' : 'open',user:{login:author},title:'Autopilot task: improve spacing',body:TASK_MARKER+'\nImprove spacing'};}
    else if(url.includes('/comments?')) data=[];
    else if(url.endsWith('/comments')) data={};
    else if(url.includes('/git/ref/heads/main')) data={object:{sha:'main'}};
    else if(url.includes('/git/commits/main')) data={tree:{sha:'base'}};
    else if(url.includes('/git/trees/base')) data={tree:[{type:'blob',path:'public/app.js',size:3,sha:'blob'}]};
    else if(url.includes('/git/blobs/blob')) data={encoding:'base64',content:Buffer.from('old source').toString('base64')};
    else if(url.endsWith('/git/trees')) data={sha:'newtree'};
    else if(url.endsWith('/git/commits')) data={sha:'commit'};
    else if(url.endsWith('/git/refs')) data={};
    else throw new Error('Unexpected test request '+url);
    return {ok:true,json:async()=>data};
  };
  return {calls,fetchImpl};
}
const config={repository:'owner/project',issueNumber:1,token:'github-secret',groqKey:'groq-secret',expectedTask:{title:'Autopilot task: improve spacing',body:TASK_MARKER+'\nImprove spacing'}};
test('owner task generates a reviewable branch and no pull request or merge',async()=>{
  const h=harness();await runAgent({...config,fetchImpl:h.fetchImpl});
  const ref=h.calls.find(c=>c.url.endsWith('/git/refs'));assert.deepEqual(JSON.parse(ref.body),{ref:'refs/heads/autopilot/task-1',sha:'commit'});
  assert.equal(h.calls.some(c=>c.url.includes('/pulls')),false);
  const model=h.calls.find(c=>c.url.startsWith('https://api.groq.com/'));assert.equal(model.body.includes('github-secret'),false);assert.equal(model.body.includes('groq-secret'),false);
  assert.equal(JSON.parse(model.body).model,'openai/gpt-oss-120b');assert.equal(JSON.parse(model.body).reasoning_effort,'low');assert.equal(JSON.parse(model.body).max_completion_tokens,1500);
  const last=h.calls.filter(c=>c.url.endsWith('/comments')).at(-1);assert.match(JSON.parse(last.body).body,/ready for PR/);assert.match(JSON.parse(last.body).body,/Tests have not run yet/);
});
test('configured GitHub App opens the pull request with its own token, never merges',async()=>{
  const h=harness();
  await runAgent({...config,appToken:'app-secret',fetchImpl:(url,options)=>url.endsWith('/pulls')?(h.calls.push({url,...options}),Promise.resolve({ok:true,json:async()=>({html_url:'https://github.com/owner/project/pull/7'})})):h.fetchImpl(url,options)});
  const pull=h.calls.find(c=>c.url.endsWith('/pulls'));
  assert.equal(pull.headers.Authorization,'Bearer app-secret');assert.deepEqual({head:JSON.parse(pull.body).head,base:JSON.parse(pull.body).base},{head:'autopilot/task-1',base:'main'});
  for(const path of ['/git/trees','/git/commits','/git/refs']) assert.equal(h.calls.find(c=>c.url.endsWith(path)).headers.Authorization,'Bearer app-secret',path);
  assert.equal(h.calls.some(c=>/merge/.test(c.url)),false);
  const comments=h.calls.filter(c=>c.url.endsWith('/comments'));
  assert.ok(comments.every(c=>c.headers.Authorization==='Bearer github-secret'));
  assert.match(JSON.parse(comments.at(-1).body).body,/\[Open pull request\]\(https:\/\/github\.com\/owner\/project\/pull\/7\)/);
  assert.equal(h.calls.find(c=>c.url.startsWith('https://api.groq.com/')).body.includes('app-secret'),false);
});
test('a failed automatic pull request falls back to the compare link',async()=>{
  const h=harness();
  await runAgent({...config,appToken:'app-secret',fetchImpl:(url,options)=>url.endsWith('/pulls')?Promise.resolve({ok:false,status:422}):h.fetchImpl(url,options)});
  const body=JSON.parse(h.calls.filter(c=>c.url.endsWith('/comments')).at(-1).body).body;
  assert.match(body,/Agent: ready for PR/);assert.match(body,/Review changes and create PR/);assert.equal(body.includes('Open pull request'),false);
});
test('notification failure after branch publication retains ready status and compare link',async()=>{
  const h=harness();let notifications=0;
  await runAgent({...config,fetchImpl:async(url,options)=>{
    if(url.endsWith('/comments') && options.method==='POST' && ++notifications===2) return {ok:false,status:503};
    return h.fetchImpl(url,options);
  }});
  assert.equal(h.calls.filter(c=>c.url.endsWith('/git/refs')).length,1);
  const replies=h.calls.filter(c=>c.url.endsWith('/comments')).map(c=>JSON.parse(c.body).body);
  assert.match(replies.at(-1),/Agent: ready for PR/);assert.match(replies.at(-1),/Review changes and create PR/);assert.equal(replies.some(body=>body.includes('Agent: failed')),false);
});
test('unauthorized tasks never call Groq or create branches',async()=>{
  const h=harness({author:'someone-else'});await runAgent({...config,fetchImpl:h.fetchImpl});assert.equal(h.calls.length,2);
});
test('missing Groq key reports failure on authorized tasks without model calls',async()=>{
  for(const groqKey of [undefined,'','  ']) {
    const h=harness();await assert.rejects(runAgent({...config,groqKey,fetchImpl:h.fetchImpl}),/not configured/);
    const comment=h.calls.find(c=>c.url.endsWith('/comments'));assert.match(JSON.parse(comment.body).body,/Agent: failed/);
    assert.equal(h.calls.some(c=>c.url.startsWith('https://api.groq.com/')),false);
  }
  const h=harness({author:'other'});await runAgent({...config,groqKey:undefined,fetchImpl:h.fetchImpl});assert.equal(h.calls.length,2);
});
test('configured task user can authorize tasks without matching the repository owner',async()=>{
  const h=harness({author:'maintainer'});await runAgent({...config,authorizedUser:'Maintainer',fetchImpl:h.fetchImpl});assert.equal(h.calls.some(c=>c.url.endsWith('/git/refs')),true);
});
test('task edited after the authorized event does not start the agent',async()=>{
  const h=harness();await runAgent({...config,expectedTask:{...config.expectedTask,body:'different task'},fetchImpl:h.fetchImpl});assert.equal(h.calls.length,2);
});
test('closed tasks and unsupported model edits never publish a branch',async()=>{
  for(const options of [{closed:true},{edits:[{path:'.github/workflows/bad.yml',content:'bad'}]}]) {
    const h=harness(options);
    if(options.edits) await assert.rejects(runAgent({...config,fetchImpl:h.fetchImpl}),/unsupported/);
    else await runAgent({...config,fetchImpl:h.fetchImpl});
    assert.equal(h.calls.some(c=>c.url.endsWith('/git/refs')),false);
  }
});
test('task URL preserves instructions as encoded text and needs GitHub confirmation',()=>{
  const text='Fix <script> & # spacing\nPlease';const url=new URL(taskUrl('owner/project',text));
  assert.equal(url.pathname,'/owner/project/issues/new');assert.equal(url.searchParams.get('body'),TASK_MARKER+'\n'+text);
});
test('task history includes only owner tasks and marked agent replies',async()=>{
  const task={number:1,title:'Autopilot task: spacing',body:TASK_MARKER+'\nFix spacing',user:{login:'owner'},html_url:'https://github.com/owner/project/issues/1',state:'open'};
  const tasks=await collectTasks('owner/project',{token:'secret',authorizedUser:'Owner',fetchImpl:async url=>({ok:true,json:async()=>url.includes('/comments') ? [{user:{login:'intruder'},body:AGENT_MARKER+'\n**Agent: ready for PR**'},{user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: working**\nReading code'}] : [task,{...task,user:{login:'other'}}]})});
  assert.equal(tasks.length,1);assert.equal(tasks[0].status,'working');assert.equal(tasks[0].messages.length,2);
});
test('task history finds the latest marked reply after the first 100 comments',async()=>{
  const task={number:1,title:'Autopilot task: spacing',body:TASK_MARKER+'\nFix spacing',user:{login:'owner'},html_url:'https://github.com/owner/project/issues/1',state:'open'};
  const first=[{user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: working**'},...Array.from({length:99},()=>({user:{login:'other'},body:'ordinary comment'}))];
  const last=[{user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: ready for PR**\n[Review changes and create PR](https://github.com/owner/project/compare/main...autopilot/task-1)'}];
  const tasks=await collectTasks('owner/project',{token:'secret',fetchImpl:async url=>({ok:true,json:async()=>!url.includes('/comments?') ? [task] : url.includes('page=2') ? last : first})});
  assert.equal(tasks[0].status,'ready for PR');assert.match(tasks[0].compareUrl,/autopilot\/task-1/);
});

test('model request stays below free-tier budget with Unicode and large source',()=>{
  const messages=agentMessages('Refresh workflow number',{'public/app.js':('const workflow="日本語";\n').repeat(5000),'src/github.js':'x'.repeat(30000)});
  assert.ok(Buffer.byteLength(JSON.stringify(messages),'utf8')<=6000);
  assert.throws(()=>agentMessages('日'.repeat(6000),{}),/budget/);
});
test('exact replacements preserve unread source and reject ambiguous matches',()=>{
  const files={'public/app.js':'prefix\nold\nsuffix'};
  assert.equal(applyAgentChanges({summary:'x',changes:[{path:'public/app.js',before:'old',after:'new'}]},files).files[0].content,'prefix\nnew\nsuffix');
  for(const before of ['','missing','old']) assert.throws(()=>applyAgentChanges({changes:[{path:'public/app.js',before,after:'new'}]},{'public/app.js':'old old'}));
  assert.throws(()=>applyAgentChanges({changes:[{path:'public/unread.js',before:'x',after:'y'}]},files),/unsupported/);
});

test('truncated generation and oversized request never publish a branch',async()=>{
  for(const response of [{ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{}'}}]})},{ok:false,status:413}]) {
    const h=harness();
    await assert.rejects(runAgent({...config,fetchImpl:(url,options)=>url.startsWith('https://api.groq.com/') ? Promise.resolve(response) : h.fetchImpl(url,options)}),/budget|account limit/);
    assert.equal(h.calls.some(c=>c.url.endsWith('/git/refs')),false);
  }
});

test('code search finds relevant code beyond file headers within the request budget',()=>{
  const source='// unrelated\n'.repeat(300)+'const runs = data.workflow_runs.map(r => ({title:r.display_title, id:r.id}));';
  const messages=agentMessages('GitHub Actions workflow körning behöver nummer',{'src/github.js':source});
  assert.match(messages[1].content,/workflow_runs/);
  assert.ok(Buffer.byteLength(JSON.stringify(messages))<=6000);
});
test('an owner reply resumes a waiting task once, with its own branch',async()=>{
  const reply={id:123,user:{login:'owner'},body:REPLY_MARKER+'\nPlease change public/app.js'};
  const bot={user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**\nMore details needed'};
  const h=harness();
  const fetchImpl=(url,options)=>url.includes('/comments?')?Promise.resolve({ok:true,json:async()=>[bot,reply]}):url.endsWith('/issues/comments/123')?Promise.resolve({ok:true,json:async()=>reply}):h.fetchImpl(url,options);
  await runAgent({...config,expectedComment:reply,fetchImpl});
  assert.match(h.calls.find(c=>c.url.endsWith('/git/refs')).body,/task-1-reply-123/);
  assert.match(h.calls.find(c=>c.url.startsWith('https://api.groq.com/')).body,/Please change/);
  assert.match(JSON.parse(h.calls.filter(c=>c.url.endsWith('/comments')).at(-1).body).body,/attempt:123/);
  for(const history of [[{...bot,body:bot.body+'\n<!-- repo-autopilot-attempt:123 -->'},reply],[bot,{...reply,user:{login:'other'}}],[{...bot,body:AGENT_MARKER+'\n**Agent: working**'},reply]]) {
    const h2=harness();await runAgent({...config,expectedComment:reply,fetchImpl:(url,options)=>url.includes('/comments?')?Promise.resolve({ok:true,json:async()=>history}):h2.fetchImpl(url,options)});
    assert.equal(h2.calls.some(c=>c.url.startsWith('https://api.groq.com/')),false);
  }
});

test('continuations retain the question and earlier reply context without exceeding the model budget',()=>{
  const issue={body:TASK_MARKER+'\nChange the workflow title'};
  const comments=[{id:1,user:{login:'owner'},body:REPLY_MARKER+'\nI mean workflow runs'}, {id:2,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**\nWhich option: 1. Run ID, or 2. Run number?'},{id:3,user:{login:'owner'},body:REPLY_MARKER+'\nThe second option'}];
  const instruction=taskInstruction(issue,comments,'owner',3);
  assert.match(instruction,/Run number/);assert.match(instruction,/The second option/);assert.match(instruction,/I mean workflow runs/);
  assert.ok(instruction.indexOf('Which option')<instruction.indexOf('The second option'));
  for(const char of ['日','"','\\']) {
    const long={body:TASK_MARKER+'\n'+char.repeat(3500)};
    const history=[{id:2,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**\n'+char.repeat(3000)},{id:3,user:{login:'owner'},body:REPLY_MARKER+'\n'+char.repeat(3500)}];
    const bounded=taskInstruction(long,history,'owner',3);
    assert.ok(Buffer.byteLength(JSON.stringify(agentMessages(bounded,{'public/app.js':'source'})),'utf8')<=6000);
    assert.ok(Buffer.byteLength(JSON.stringify(agentMessages(taskInstruction(long,[],'owner'),{})),'utf8')<=6000);
  }
});
test('pending owner replies count only after the latest agent status',()=>{
  const waiting={id:1,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**'};
  const reply={id:2,user:{login:'owner'},body:REPLY_MARKER+'\nSecond option'};
  assert.equal(pendingTaskReply([waiting,reply],'OWNER'),true);
  assert.equal(pendingTaskReply([reply,waiting],'owner'),false);
  assert.equal(pendingTaskReply([waiting,{...reply,user:{login:'other'}}],'owner'),false);
});

test('task snapshots display a pending follow-up as queued',async()=>{
  const tasks=await collectTasks('owner/project',{token:'x',fetchImpl:async url=>({ok:true,json:async()=>url.includes('/comments?')?[{id:1,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**'},{id:2,user:{login:'owner'},body:REPLY_MARKER+'\nThe second option'}]:[{number:1,state:'open',user:{login:'owner'},title:'Autopilot task: improve spacing',body:TASK_MARKER+'\nImprove spacing'}]})});
  assert.equal(tasks[0].status,'queued');
});

test('queued GitHub replies older than the latest clarification cannot resume',async()=>{
  const reply={id:2,user:{login:'owner'},body:REPLY_MARKER+'\nThe second option'};
  const history=[{id:1,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**\nFirst question'},reply,{id:3,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: needs input**\nA newer question'}];
  const h=harness();await runAgent({...config,expectedComment:reply,fetchImpl:(url,options)=>url.includes('/comments?')?Promise.resolve({ok:true,json:async()=>history}):h.fetchImpl(url,options)});
  assert.equal(h.calls.some(c=>c.url.startsWith('https://api.groq.com/')),false);
  assert.equal(h.calls.some(c=>c.url.endsWith('/git/refs')),false);
});

test('ineligible replies preserve working and ready status in snapshots',async()=>{
  for(const status of ['working','ready for PR']) {
    const history=[{id:1,user:{login:'github-actions[bot]'},body:AGENT_MARKER+'\n**Agent: '+status+'**'},{id:2,user:{login:'owner'},body:REPLY_MARKER+'\nExtra reply'}];
    assert.equal(pendingTaskReply(history,'owner'),false);
    const tasks=await collectTasks('owner/project',{token:'x',fetchImpl:async url=>({ok:true,json:async()=>url.includes('/comments?')?history:[{number:1,state:'open',user:{login:'owner'},title:'Autopilot task: x',body:TASK_MARKER+'\nx'}]})});
    assert.equal(tasks[0].status,status);
  }
});
test('task history exposes an app-opened pull request link only for this repository',async()=>{
  const task={number:1,state:'open',user:{login:'owner'},title:'Autopilot task: x',body:TASK_MARKER+'\nx'};
  for(const [link,expected] of [['https://github.com/owner/project/pull/7','https://github.com/owner/project/pull/7'],['https://github.com/evil/project/pull/7',null],['https://github.com/owner/project/pull/7/files',null]]) {
    const tasks=await collectTasks('owner/project',{token:'x',fetchImpl:async url=>({ok:true,json:async()=>url.includes('/comments?')?[{id:1,user:{login:'github-actions[bot]'},body:AGENT_MARKER+`\n**Agent: ready for PR**\n[Open pull request](${link})`}]:[task]})});
    assert.equal(tasks[0].pullUrl,expected);assert.equal(tasks[0].status,'ready for PR');
  }
});
