import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {createGitHub} from '../src/github.js';

test('Pages build publishes only static assets with project-relative URLs',async()=>{
  execFileSync(process.execPath,['scripts/build-pages.js']);
  assert.deepEqual((await readdir('dist')).sort(),['app.js','codex.js','github.js','index.html','style.css']);
  const html=await readFile('dist/index.html','utf8');
  assert.match(html,/data-mode="static"/);
  assert.match(html,/href="\.\/style.css"/);
  assert.match(html,/src="\.\/app.js"/);
  const app=await readFile('dist/app.js','utf8');
  assert.match(app,/from '\.\/github.js'/);
  // An injected build-time environment secret must not appear in any output.
  for(const name of await readdir('dist')) assert.equal((await readFile(`dist/${name}`,'utf8')).includes('test-pages-secret-never-publish'),false);
});

test('hosted snapshot requests only five PRs and sends no Authorization header',async()=>{
  let sawPulls=false;
  const api=createGitHub({pullLimit:5,fetchImpl:async(url,options)=>{
    assert.equal(options.headers.Authorization,undefined);
    if(url.includes('/pulls?')) {assert.match(url,/per_page=5$/);sawPulls=true;return {ok:true,json:async()=>[]};}
    return {ok:true,json:async()=>url.includes('/actions/runs')?{workflow_runs:[]}:{full_name:'example/project',html_url:'https://github.com/example/project'}};
  }});
  const data=await api.snapshot('example/project');
  assert.equal(sawPulls,true);assert.match(data.scope,/^5 most/);assert.equal(data.autonomy,false);
});
