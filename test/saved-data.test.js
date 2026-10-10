import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSavedData} from '../public/saved-data.js';
import {publishData} from '../scripts/publish-data.js';

test('selects newest snapshot and tolerates an unavailable data branch',async()=>{
  const repo='example/project';
  const data=time=>({repository:repo,fetchedAt:time});
  const old=data('2026-10-10T10:00:00Z'),fresh=data('2026-10-10T10:01:00Z');
  assert.deepEqual(await loadSavedData(repo,{fetchImpl:async url=>({ok:true,json:async()=>url.startsWith('https:') ? old : fresh})}),fresh);
  assert.deepEqual(await loadSavedData(repo,{fetchImpl:async url=>({ok:!url.startsWith('https:'),json:async()=>fresh})}),fresh);
  await assert.rejects(loadSavedData(repo,{fetchImpl:async()=>({ok:true,json:async()=>({...fresh,repository:'wrong/repo'})})}),/unavailable/);
});

test('data publishing writes only the snapshot to a separate branch',async()=>{
  const calls=[];
  const responses=[{private:false,default_branch:'main'},null,{object:{sha:'main'}},{tree:{sha:'base'}},{sha:'tree'},{sha:'commit'},{}];
  await publishData({repository:'example/project',token:'test-secret',content:JSON.stringify({repository:'example/project'}),fetchImpl:async(url,options)=>{
    calls.push({url,...options});const data=responses.shift();return {ok:data !== null,status:data === null ? 404 : 200,json:async()=>data};
  }});
  const tree=JSON.parse(calls[4].body);assert.equal(tree.tree.length,1);assert.equal(tree.tree[0].path,'data/snapshot.json');
  assert.equal(calls[0].url,'https://api.github.com/repos/example/project');
  assert.deepEqual(JSON.parse(calls[6].body),{ref:'refs/heads/dashboard-data',sha:'commit'});
  assert.equal(calls.some(c=>c.body?.includes('test-secret')),false);
});

test('private repository cannot publish a data branch',async()=>{
  let calls=0;
  await assert.rejects(publishData({repository:'example/project',token:'secret',content:'{"repository":"example/project"}',fetchImpl:async()=>{calls++;return {ok:true,json:async()=>({private:true})};}}),/Only public/);
  assert.equal(calls,1);
});
