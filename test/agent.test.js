import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedAgentPath,validateEdits,runAgent,TASK_MARKER,AGENT_MARKER} from '../src/agent.js';
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
    if(url.startsWith('https://api.groq.com/')) data={choices:[{message:{content:JSON.stringify({summary:'Changed spacing',files:edits})}}]};
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
  const last=h.calls.filter(c=>c.url.endsWith('/comments')).at(-1);assert.match(JSON.parse(last.body).body,/ready for PR/);assert.match(JSON.parse(last.body).body,/Tests have not run yet/);
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
