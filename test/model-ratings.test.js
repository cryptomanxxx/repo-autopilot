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
  reading:'333|1,10,3'
};

test('every task passes its reference answer and fails a wrong one',()=>{
  for(const task of TASKS) {
    assert.equal(task.grade(GOOD[task.id]),true,task.id);
    assert.equal(task.grade('I cannot help with that.'),false,task.id);
  }
  assert.equal(TASKS[0].grade('```js\nfunction median(v) { return v.sort()[Math.floor(v.length / 2)]; }\n```'),false,'the original bug fails');
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

test('stars come from the tasks passed, one less for a slow model, never below one',()=>{
  assert.deepEqual([5,4,3,2,1,0].map(p=>stars(p,10)),[5,4,3,2,1,1]);
  assert.deepEqual([stars(5,46),stars(1,90),stars(5,null)],[4,1,5]);
});

test('the ratings file accepts only its exact format',()=>{
  const entry={stars:4,passed:4,total:5,seconds:12.5,testedAt:'2026-10-19'};
  assert.ok(validate({...empty(),models:{'hip:GLM-5.2-AWQ-INT4':entry}}));
  for(const models of [{'other:x':entry},{'hip:x':{...entry,stars:5}},{'hip:x':{...entry,note:'x'}},{'hip:x':{...entry,testedAt:'soon'}},
    {['hip:'+lease]:entry},{'hip: x':entry},{'hip:x\n':entry}])
    assert.throws(()=>validate({...empty(),models}),/Invalid model ratings/);
  assert.throws(()=>validate({...empty(),extra:1}),/top-level/);
  assert.ok(validate(JSON.parse(readFileSync(new URL('../worker/src/model-ratings.json',import.meta.url),'utf8'))),'the committed file is valid');
});

test('the run: collect through the gateway, grade, publish a summary',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ratings-'));
  const calls=[];
  const server=createServer((request,response)=>{
    assert.equal(request.headers.authorization,'Bearer '+lease);
    if(request.method==='GET'&&request.url==='/v1/models') {
      response.setHeader('Content-Type','application/json');
      return response.end(JSON.stringify({providers:{blablador:'ok',hip:'ok'},data:[
        {id:'blablador:good',provider:'blablador'},{id:'hip:bad',provider:'hip'},{id:'hip:down',provider:'hip'},{id:'hip:old',provider:'hip'}]}));
    }
    let body='';
    request.on('data',chunk=>{body+=chunk;});
    request.on('end',()=>{
      const {model,messages}=JSON.parse(body);
      calls.push(model);
      if(model==='hip:down') {response.statusCode=502;return response.end('{"error":"AI provider returned HTTP 502"}');}
      const task=TASKS.find(t=>t.prompt===messages[1].content);
      response.setHeader('Content-Type','application/json');
      response.end(JSON.stringify({choices:[{message:{role:'assistant',content:model==='blablador:good'?GOOD[task.id]:'no idea'}}]}));
    });
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    writeFileSync(join(dir,'lease'),lease);
    const current={...empty(),models:{'hip:old':{stars:2,passed:2,total:5,seconds:3,testedAt:'2026-01-02'},'hip:down':{stars:3,passed:3,total:5,seconds:3,testedAt:'2026-01-01'}}};
    writeFileSync(join(dir,'current.json'),JSON.stringify(current));
    const env={...process.env,AI_GATEWAY_URL:'http://127.0.0.1:'+server.address().port,LEASE_FILE:join(dir,'lease'),
      OUT:join(dir,'answers.json'),RATINGS:join(dir,'current.json'),PROVIDER:'all',MAX_MODELS:'3'};
    const collected=await run(process.execPath,[script('collect.mjs')],{env});
    assert.doesNotMatch(collected.stdout+collected.stderr,/g1\./,'the lease is never printed');
    const answers=readFileSync(join(dir,'answers.json'),'utf8');
    assert.doesNotMatch(answers,/g1\./);
    // Untested models first, then the oldest; hip:old (tested longest ago) does not fit in three.
    assert.deepEqual(JSON.parse(answers).models.map(m=>m.id),['blablador:good','hip:bad','hip:down']);
    assert.equal(calls.length,15);
    await run(process.execPath,[script('grade.mjs'),join(dir,'answers.json'),join(dir,'current.json'),join(dir,'next.json')]);
    const next=validate(JSON.parse(readFileSync(join(dir,'next.json'),'utf8')));
    assert.deepEqual(Object.keys(next.models),['blablador:good','hip:bad','hip:down','hip:old']);
    assert.deepEqual([next.models['blablador:good'].stars,next.models['blablador:good'].passed],[5,5]);
    assert.deepEqual([next.models['hip:bad'].stars,next.models['hip:bad'].passed],[1,0]);
    assert.deepEqual(next.models['hip:down'],current.models['hip:down'],'a model the provider could not serve keeps its rating');
    const {stdout:summary}=await run(process.execPath,[script('publish.mjs'),join(dir,'next.json'),join(dir,'current.json')]);
    assert.match(summary,/\| blablador:good \| ⭐⭐⭐⭐⭐ \| 5\/5 \|/);
    assert.doesNotMatch(summary,/hip:old|hip:down/,'only changed ratings are listed');
    writeFileSync(join(dir,'broken.json'),JSON.stringify({...next,models:{'hip:x':{stars:5,passed:0,total:5,seconds:1,testedAt:'2026-10-19'}}}));
    await assert.rejects(run(process.execPath,[script('publish.mjs'),join(dir,'broken.json'),join(dir,'current.json')]));
  } finally {
    server.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
