import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TASKS} from '../scripts/model-ratings/tasks.mjs';
import {validate,stars,empty} from '../scripts/model-ratings/ratings.mjs';

const run=promisify(execFile);
const script=name=>new URL('../scripts/model-ratings/'+name,import.meta.url).pathname;
const exp=Math.floor(Date.now()/1000)+1800;
const lease='g1.'+Buffer.from(JSON.stringify({v:1,exp,nonce:'a'.repeat(64)})).toString('base64url')+'.'+'S'.repeat(43);
const GOOD={
  bugfix:'```js\nfunction median(values) {\n  const s = [...values].sort((a, b) => a - b), m = Math.floor(s.length / 2);\n  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;\n}\n```',
  implement:'<think>Units in order.</think>\n```js\nexport function parseDuration(text) {\n  if (typeof text !== "string" || !text) return null;\n  const m = /^(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?$/.exec(text);\n  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : null;\n}\n```',
  edit:"<<<<<<< SEARCH\n  timeoutMs: 5000,\n=======\n  timeoutMs: 10000,\n  region: 'eu-west-1',\n>>>>>>> REPLACE",
  json:'{"files": ["README.md", "src/app.js", "test/app.test.js"], "added": 4, "removed": 3}',
  reading:'333|1,10,3',
  'bugfix-deep':'```js\nfunction deepEqual(a, b) {\n  if (Number.isNaN(a) && Number.isNaN(b)) return true;\n  if (a === b) return true;\n  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;\n  if (Array.isArray(a) !== Array.isArray(b)) return false;\n  if (Array.isArray(a) && a.length !== b.length) return false;\n  const keys = Object.keys(a);\n  if (keys.length !== Object.keys(b).length) return false;\n  return keys.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));\n}\n```',
  'implement-csv':'```js\nfunction parseCsvLine(line) {\n  if (typeof line !== "string") return null;\n  const fields = [];\n  let i = 0;\n  for (;;) {\n    if (line[i] === \'"\') {\n      let field = "";\n      i++;\n      for (;;) {\n        if (i >= line.length) return null;\n        if (line[i] === \'"\') {\n          if (line[i + 1] === \'"\') { field += \'"\'; i += 2; continue; }\n          i++;\n          break;\n        }\n        field += line[i++];\n      }\n      fields.push(field);\n      if (i === line.length) return fields;\n      if (line[i] !== ",") return null;\n      i++;\n    } else {\n      const end = line.indexOf(",", i);\n      const stop = end === -1 ? line.length : end;\n      const field = line.slice(i, stop);\n      if (field.includes(\'"\')) return null;\n      fields.push(field);\n      if (end === -1) return fields;\n      i = end + 1;\n    }\n  }\n}\n```',
  'reading-async':'`a,s,p1,m,b,p2,t`',
  'edit-multi':'<<<<<<< SEARCH\n  maxUsers: 10,\n=======\n  maxUsers: 25,\n>>>>>>> REPLACE\n\n<<<<<<< SEARCH\n  return `${plan.name}: ${plan.users} users`;\n=======\n  return `${plan.name}: ${plan.users} users, ${plan.projects} projects`;\n>>>>>>> REPLACE'
};

test('every task passes its reference answer and fails a wrong one',()=>{
  for(const task of TASKS) {
    assert.equal(task.grade(GOOD[task.id]),true,task.id);
    assert.equal(task.grade('I cannot help with that.'),false,task.id);
  }
  assert.equal(TASKS[0].grade('```js\nfunction median(v) { return v.sort()[Math.floor(v.length / 2)]; }\n```'),false,'the original bug fails');
  // The harder tasks also fail answers that are only nearly right.
  const task=id=>TASKS.find(t=>t.id===id);
  assert.equal(task('bugfix-deep').grade('```js\nfunction deepEqual(a, b) {\n  if (a === b) return true;\n  if (typeof a !== "object" || typeof b !== "object") return false;\n  const keys = Object.keys(a);\n  for (const key of keys) if (!deepEqual(a[key], b[key])) return false;\n  return true;\n}\n```'),false,'the original deepEqual');
  assert.equal(task('bugfix-deep').grade(GOOD['bugfix-deep'].replace('if (Array.isArray(a) !== Array.isArray(b)) return false;\n','')),false,'arrays and objects mixed');
  assert.equal(task('implement-csv').grade('```js\nfunction parseCsvLine(line) { return typeof line === "string" ? line.split(",") : null; }\n```'),false,'a plain split');
  assert.equal(task('reading-async').grade('a,s,p1,p2,m,b,t'),false);
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('  maxUsers: 10,','  maxUsers: 11,')),false,'a SEARCH that does not match the file');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].split('\n\n')[0]),false,'only one of the two changes');
  const PLANS_TEXT='  maxUsers: 10,\n  maxProjects: 5,\n};\n\nexport function describe(plan) {\n  return `${plan.name}: ${plan.users} users`;';
  assert.equal(task('edit-multi').grade(`<<<<<<< SEARCH\n${PLANS_TEXT}\n=======\n${PLANS_TEXT.replace('10','25').replace('users`','users, ${plan.projects} projects`')}\n>>>>>>> REPLACE`),false,'one block making both changes');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('return `${plan.name}: ${plan.users} users, ${plan.projects} projects`','return \'${plan.name}: ${plan.users} users, ${plan.projects} projects\'')),false,'a plain string instead of a template literal');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('users, ${plan.projects} projects`','users,${plan.projects}projects`')),false,'spaces inside a template literal count');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('  maxUsers: 25,','maxUsers:25 ,')),true,'spacing outside strings does not');
  assert.equal(task('edit').grade(GOOD.edit.replace("'eu-west-1'",'"eu-west-1"')),true,'either quote style');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('maxUsers: 25','maxUsers: 2 5')),false,'whitespace that splits a token');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('  return `${plan.name}: ${plan.users} users, ${plan.projects}','  return\n    `${plan.name}: ${plan.users} users, ${plan.projects}')),false,'a line break after return');
  assert.equal(task('bugfix-deep').grade(GOOD['bugfix-deep'].replace('if (Number.isNaN(a) && Number.isNaN(b)) return true;','if (Number.isNaN(a)) return true;')),false,'NaN equal to anything');
  assert.equal(task('bugfix-deep').grade(GOOD['bugfix-deep'].replace('  const keys = Object.keys(a);','  if (Array.isArray(a)) return a.every((value, index) => deepEqual(value, b[index]));\n  const keys = Object.keys(a);')),false,'arrays of different lengths');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace('return `${plan.name}: ${plan.users} users, ${plan.projects} projects`;','return "Team: 4 users, 2 projects";')),false,'a describe() that ignores its argument');
  assert.equal(task('bugfix-deep').grade(GOOD['bugfix-deep'].replace('if (Array.isArray(a) !== Array.isArray(b)) return false;','if (Array.isArray(a) && !Array.isArray(b)) return false;')),false,'an object equal to an array');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi']+'\n\n<<<<<<< SEARCH\n  maxProjects: 5,\n'),false,'an incomplete extra block');
  assert.equal(task('edit').grade(GOOD.edit.replace('<<<<<<< SEARCH','<<<<<<< SEARCH wrong.js')),false,'a block naming another file');
  assert.equal(task('edit').grade("<<<<<<< SEARCH\nexport const config = {\n  retries: 3,\n  timeoutMs: 5000,\n=======\n/* export const config */ const config = {\n  retries: 3,\n  timeoutMs: 10000,\n  region: 'eu-west-1',\n>>>>>>> REPLACE"),false,'an export left only in a comment');
  const whole=extra=>`<<<<<<< SEARCH\nexport const config = {\n  retries: 3,\n  timeoutMs: 5000,\n  verbose: false,\n};\n=======\nexport const config = {\n  retries: 3,\n  timeoutMs: 10000,\n  region: 'eu-west-1',\n  verbose: false,\n};${extra}\n>>>>>>> REPLACE`;
  assert.equal(task('edit').grade(whole('')),true,'the whole file in one block');
  assert.equal(task('edit').grade(whole('\nexport default 1;')),false,'an added default export');
  assert.equal(task('bugfix-deep').grade(GOOD['bugfix-deep'].replace('  if (Array.isArray(a) && a.length !== b.length) return false;\n','')),false,'sparse arrays of different lengths');
  assert.equal(task('edit').grade(GOOD.edit.replace('<<<<<<< SEARCH','<<<<<<< SEARCH config.js')),true,'a block naming the task file');
  assert.equal(task('edit-multi').grade(GOOD['edit-multi'].replace(/>>>>>>> REPLACE$/,'>>>>>>> REPLACE junk')),false,'a malformed closing marker');
  assert.equal(task('implement-csv').grade(GOOD['implement-csv'].replace('      if (field.includes(\'"\')) return null;\n','')),false,'a quote inside an unquoted field');
  assert.equal(task('bugfix-deep').grade(GOOD['bugfix-deep'].replace('  if (Array.isArray(a) !== Array.isArray(b)) return false;','  if (Array.isArray(a) !== Array.isArray(b)) return false;\n  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));')),false,'arrays with extra properties');
  assert.equal(task('edit').grade("<<<<<<< SEARCH\nexport const config = {\n  retries: 3,\n  timeoutMs: 5000,\n=======\nconst config = {\n  retries: 3,\n  timeoutMs: 10000,\n  region: 'eu-west-1',\n>>>>>>> REPLACE"),false,'an edit that drops the export');
  assert.equal(task('implement-csv').grade(GOOD['implement-csv'].replace('      if (i === line.length) return fields;\n      if (line[i] !== ",") return null;\n      i++;','      if (i === line.length) return fields;\n      if (line[i] !== ",") return null;\n      i++;\n      if (i === line.length) return fields;')),false,'a trailing empty field after a quoted one');
});

test('model code runs without file access, environment or unlimited time',()=>{
  const median=TASKS.find(task=>task.id==='bugfix');
  assert.equal(median.grade('```js\nfunction median() { require("fs").readFileSync("/etc/hostname"); return 2; }\n```'),false);
  assert.equal(median.grade('```js\nfunction median() { if (process.env.HOME !== undefined) throw 1; return 2; }\n```'),false);
  assert.equal(median.grade('```js\nwhile (true) {}\n```'),false);
  assert.equal(median.grade('```js\nfunction median() { return 2; }\nfor (;;) {}\n```'),false);
});

test('model code cannot rewrite the harness that reports the result',()=>{
  const median=TASKS.find(task=>task.id==='bugfix');
  for(const attack of [
    "console.log = x => process.stdout.write(String(x).replace(':false', ':true') + '\\n');",
    "Array.prototype.every = () => true;",
    "globalThis.process && process.exit(0);",
    "this.constructor.constructor('return process')().stdout.write('x:true\\n');"
  ]) assert.equal(median.grade('```js\nfunction median() { return 0; }\n'+attack+'\n```'),false,attack);
  assert.equal(median.grade('```js\nfunction median(v) { return { valueOf: () => 2 }; }\n```'),false,'only primitive results pass');
});

test('the isolated sandbox runs model code with no network as the user nobody',{skip:process.getuid?.()!==0&&'needs root or sudo for a network namespace'},()=>{
  process.env.MODEL_SANDBOX='isolated';
  try {
    assert.equal(TASKS[0].grade(GOOD.bugfix),true);
    assert.equal(TASKS[0].grade('```js\nfunction median() { return 2; }\n```'),false);
  } finally {delete process.env.MODEL_SANDBOX;}
});

test('a model is rated only when the provider answered every task',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-grade-'));
  try {
    const answers=(ok,errors)=>TASKS.map((task,index)=>index<ok?{task:task.id,status:'ok',seconds:1,text:GOOD[task.id]}:index<ok+errors?{task:task.id,status:'error',error:'HTTP 502'}:null).filter(Boolean);
    // A provider error never counts as a failed task: one missing answer leaves the model unrated.
    writeFileSync(join(dir,'answers.json'),JSON.stringify({version:1,models:[{id:'hip:almost',answers:answers(TASKS.length-1,1)},{id:'hip:all',answers:answers(TASKS.length,0)}]}));
    await run(process.execPath,[script('grade.mjs'),join(dir,'answers.json'),join(dir,'next.json')]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir,'next.json'),'utf8')).models),['hip:all']);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('stars come from the tasks passed, one less for a slow model, never below one',()=>{
  assert.deepEqual([9,8,7,6,5,4,3,0].map(p=>stars(p,10)),[5,4,3,3,2,2,1,1]);
  assert.deepEqual([stars(9,46),stars(1,90),stars(9,null)],[4,1,5]);
});

test('the ratings file accepts only its exact format',()=>{
  const entry={stars:4,passed:8,total:9,seconds:12.5,testedAt:'2026-10-19'};
  assert.ok(validate({...empty(),models:{'hip:GLM-5.2-AWQ-INT4':entry}}));
  for(const models of [{'other:x':entry},{'hip:x':{...entry,stars:5}},{'hip:x':{...entry,note:'x'}},{'hip:x':{...entry,testedAt:'soon'}},
    {['hip:'+lease]:entry},{'hip: x':entry},{'hip:x\n':entry}])
    assert.throws(()=>validate({...empty(),models}),/Invalid model ratings/);
  assert.throws(()=>validate({...empty(),extra:1}),/top-level/);
  assert.throws(()=>validate({version:1,tasks:['bugfix','implement','edit','json','reading'],models:{}}),/version/,'ratings from older tasks are dropped');
});

test('the run: collect through the gateway, grade, publish a summary',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-'));
  const calls=[];
  let flaked=0,stored=null;
  const server=createServer((request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+lease);
    if(request.method==='GET'&&request.url==='/v1/ratings') {
      response.setHeader('Content-Type','application/json');
      return response.end(JSON.stringify(stored));
    }
    if(request.method==='GET'&&request.url==='/v1/models') {
      response.setHeader('Content-Type','application/json');
      return response.end(JSON.stringify({providers:{blablador:'ok',hip:'ok'},data:[
        {id:'blablador:good',provider:'blablador'},{id:'blablador:later',provider:'blablador'},{id:'blablador:third',provider:'blablador'},{id:'hip:bad',provider:'hip'},{id:'hip:down',provider:'hip'},{id:'hip:old',provider:'hip'}]}));
    }
    let body='';
    request.on('data',chunk=>{body+=chunk;});
    request.on('end',()=>{
      const {model,messages}=JSON.parse(body);
      calls.push(model);
      const task=TASKS.find(t=>t.prompt===messages[1].content);
      // hip:down always fails; blablador:good fails its first json task once, which is asked again.
      if(model==='hip:down'||model==='blablador:good'&&task.id==='json'&&!flaked++) {response.statusCode=502;return response.end('{"error":"AI provider returned HTTP 502"}');}
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({choices:[{message:{role:'assistant',content:model==='blablador:good'?GOOD[task.id]:'no idea'}}]}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    writeFileSync(join(dir,'lease'),lease);
    const current={...empty(),models:{'hip:old':{stars:2,passed:4,total:9,seconds:3,testedAt:'2026-01-02'},'hip:down':{stars:3,passed:6,total:9,seconds:3,testedAt:'2026-01-01'}}};
    stored=current;
    const env={...process.env,GITHUB_RUN_NUMBER:'0',AI_GATEWAY_URL:'http://127.0.0.1:'+server.address().port,LEASE_FILE:join(dir,'lease'),
      OUT:join(dir,'answers.json'),PROVIDER:'all',MAX_MODELS:'5'};
    const collected=await run(process.execPath,[script('collect.mjs')],{env});
    assert.doesNotMatch(collected.stdout+collected.stderr,/g1\./,'the lease is never printed');
    const answers=readFileSync(join(dir,'answers.json'),'utf8');
    assert.doesNotMatch(answers,/g1\./);
    // Untested models first (the providers taking turns while both have some), then the oldest
    // tested; hip:old (tested most recently) does not fit in five.
    assert.deepEqual(JSON.parse(answers).models.map(m=>m.id),['blablador:good','hip:bad','blablador:later','blablador:third','hip:down']);
    // hip:down is given up at its third error; blablador:good's failed task is asked again.
    assert.equal(calls.length,4*TASKS.length+1+3);
    assert.equal(calls.filter(id=>id==='hip:down').length,3);
    // Each run number starts the turns at another provider, then at another model of it, so that
    // one-model runs alternate and an untested model that keeps failing does not block the rest.
    stored={...empty(),models:{'blablador:good':current.models['hip:old']}};
    const oneModel=async turn=>{
      await run(process.execPath,[script('collect.mjs')],{env:{...env,GITHUB_RUN_NUMBER:String(turn),OUT:join(dir,'one-answers.json'),MAX_MODELS:'1'}});
      return JSON.parse(readFileSync(join(dir,'one-answers.json'),'utf8')).models.map(m=>m.id)[0];
    };
    assert.deepEqual([await oneModel(0),await oneModel(1),await oneModel(2)],['blablador:later','hip:bad','blablador:third']);
    // Once everything is rated, the oldest rating goes first, whichever provider it belongs to.
    const all=Object.fromEntries(['blablador:good','blablador:later','blablador:third','hip:bad','hip:down','hip:old'].map((id,i)=>[id,{...current.models['hip:old'],testedAt:`2026-0${i<3?5:4}-0${i+1}`}]));
    stored={...empty(),models:all};
    await run(process.execPath,[script('collect.mjs')],{env:{...env,OUT:join(dir,'all-answers.json'),MAX_MODELS:'1'}});
    assert.deepEqual(JSON.parse(readFileSync(join(dir,'all-answers.json'),'utf8')).models.map(m=>m.id),['hip:bad']);
    await run(process.execPath,[script('grade.mjs'),join(dir,'answers.json'),join(dir,'next.json')]);
    const next=validate(JSON.parse(readFileSync(join(dir,'next.json'),'utf8')));
    // Only this run's rated models are sent; the gateway merges them into the stored ratings.
    assert.deepEqual(Object.keys(next.models),['blablador:good','blablador:later','blablador:third','hip:bad']);
    assert.deepEqual([next.models['blablador:good'].stars,next.models['blablador:good'].passed],[5,9]);
    assert.deepEqual([next.models['hip:bad'].stars,next.models['hip:bad'].passed],[1,0]);
    assert.equal(next.models['hip:down'],undefined,'a model the provider could not serve is left out, so it keeps its stored rating');
    const {stdout:summary}=await run(process.execPath,[script('publish.mjs'),join(dir,'next.json')]);
    assert.match(summary,/\| blablador:good \| ⭐⭐⭐⭐⭐ \| 9\/9 \|/);
    assert.doesNotMatch(summary,/hip:old|hip:down/,'only this run\'s ratings are listed');
    writeFileSync(join(dir,'broken.json'),JSON.stringify({...next,models:{'hip:x':{stars:5,passed:0,total:5,seconds:1,testedAt:'2026-10-19'}}}));
    await assert.rejects(run(process.execPath,[script('publish.mjs'),join(dir,'broken.json')]));
  } finally {
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a run starts a model only while its tasks and a few retries fit in the lease',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-budget-'));
  let calls=0;
  const ids=Array.from({length:12},(_,i)=>`hip:m${String(i).padStart(2,'0')}`);
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.method==='GET') return response.end(JSON.stringify({providers:{hip:'ok'},data:ids.map(id=>({id,provider:'hip'}))}));
    request.resume();
    request.on('end',()=>{calls++;response.end(JSON.stringify({choices:[{message:{role:'assistant',content:'no idea'}}]}));});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    writeFileSync(join(dir,'lease'),lease);
    await run(process.execPath,[script('collect.mjs')],{env:{...process.env,GITHUB_RUN_NUMBER:'0',AI_GATEWAY_URL:'http://127.0.0.1:'+server.address().port,
      LEASE_FILE:join(dir,'lease'),OUT:join(dir,'answers.json'),PROVIDER:'all',MAX_MODELS:'10'}});
    // The largest accepted run, ten models, fits with its retry reserve.
    assert.equal(JSON.parse(readFileSync(join(dir,'answers.json'),'utf8')).models.length,Math.floor((100-2)/TASKS.length));
    assert.ok(calls<=100);
  } finally {
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a model whose provider fails more tasks than can be retried is given up without retries',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-giveup-'));
  let calls=0;
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.method==='GET') return response.end(JSON.stringify({providers:{hip:'ok'},data:[{id:'hip:flaky',provider:'hip'}]}));
    request.resume();
    // Every second call fails, so the errors are never consecutive.
    request.on('end',()=>{
      if(calls++%2) {response.statusCode=502;return response.end('{"error":"AI provider returned HTTP 502"}');}
      response.end(JSON.stringify({choices:[{message:{role:'assistant',content:'no idea'}}]}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    writeFileSync(join(dir,'lease'),lease);
    await run(process.execPath,[script('collect.mjs')],{env:{...process.env,GITHUB_RUN_NUMBER:'0',AI_GATEWAY_URL:'http://127.0.0.1:'+server.address().port,
      LEASE_FILE:join(dir,'lease'),OUT:join(dir,'answers.json'),PROVIDER:'all',MAX_MODELS:'1'}});
    // Given up at its third error (the sixth call), with no retries spent on it.
    assert.equal(calls,6);
    assert.equal(JSON.parse(readFileSync(join(dir,'answers.json'),'utf8')).models[0].answers.length,6);
  } finally {
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('an answer without text says why: the finish reason, output tokens and reasoning size',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-empty-'));
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.method==='GET') return response.end(JSON.stringify({providers:{hip:'ok'},data:[{id:'hip:thinker',provider:'hip'}]}));
    request.resume();
    request.on('end',()=>response.end(JSON.stringify({choices:[{finish_reason:'length',message:{role:'assistant',content:null,reasoning_content:'hmm '.repeat(50)}}],usage:{completion_tokens:4096}})));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    writeFileSync(join(dir,'lease'),lease);
    await run(process.execPath,[script('collect.mjs')],{env:{...process.env,GITHUB_RUN_NUMBER:'0',AI_GATEWAY_URL:'http://127.0.0.1:'+server.address().port,
      LEASE_FILE:join(dir,'lease'),OUT:join(dir,'answers.json'),PROVIDER:'all',MAX_MODELS:'1'}});
    const [answer]=JSON.parse(readFileSync(join(dir,'answers.json'),'utf8')).models[0].answers;
    assert.equal(answer.status,'error');
    assert.equal(answer.error,'no answer text (finish length, 4096 output tokens, 200 characters of reasoning)');
  } finally {
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test('a model too slow to answer gets failed tasks and a low rating, not a provider error',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-slow-'));
  let calls=0;
  const server=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.method==='GET') return response.end(JSON.stringify({providers:{hip:'ok'},data:[{id:'hip:slow',provider:'hip'}]}));
    request.resume();
    // Like the gateway when a generation outlives its time limit: HTTP 502 after a long wait.
    request.on('end',()=>{calls++;setTimeout(()=>{response.statusCode=502;response.end('{"error":"AI provider unavailable"}');},1200);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    writeFileSync(join(dir,'lease'),lease);
    const {stdout}=await run(process.execPath,[script('collect.mjs')],{env:{...process.env,GITHUB_RUN_NUMBER:'0',TIMEOUT_SECONDS:'1',AI_GATEWAY_URL:'http://127.0.0.1:'+server.address().port,
      LEASE_FILE:join(dir,'lease'),OUT:join(dir,'answers.json'),PROVIDER:'all',MAX_MODELS:'1'}});
    // Two timeouts, then the rest is failed without asking; the cause is logged.
    assert.equal(calls,2);
    assert.match(stdout,/hip:slow: bugfix: no answer within 1 s after 1\.\d s/);
    const answers=JSON.parse(readFileSync(join(dir,'answers.json'),'utf8')).models[0].answers;
    assert.deepEqual([answers.length,answers.every(a=>a.status==='timeout')],[TASKS.length,true]);
    await run(process.execPath,[script('grade.mjs'),join(dir,'answers.json'),join(dir,'next.json')]);
    const rated=JSON.parse(readFileSync(join(dir,'next.json'),'utf8')).models['hip:slow'];
    assert.deepEqual([rated.stars,rated.passed],[1,0],'rated, with every task failed');
  } finally {
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
