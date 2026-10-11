import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {publishSnapshot} from '../scripts/snapshot-pages.js';

test('public snapshot uses authentication but publishes neither secrets nor raw comments',async()=>{
 const dir=await mkdtemp(`${tmpdir()}/autopilot-snapshot-`);
 try {
  const fetchImpl=async(url,options)=>{
   assert.equal(options.headers.Authorization,'Bearer secret-never-publish');
   let data=[];
   if(url.endsWith('/repos/a/b')) data={private:false,visibility:'public',full_name:'a/b'};
   else if(url.includes('/pulls?')) data=[{number:1,state:'closed',head:{sha:'abcdef1'},title:'Test PR'}];
   else if(url.includes('/actions/runs')) data={workflow_runs:[{id:7,run_number:5,name:'Refresh dashboard data',status:'in_progress',conclusion:null},{id:8,run_number:4,name:'CI',status:'completed',conclusion:'success'}]};
   else if(url.includes('/check-runs')) data={check_runs:[]};
   else if(url.includes('/status?')) data={statuses:[]};
   else if(url.includes('/issues/1/comments')) data=[{user:{login:'chatgpt-codex-connector[bot]'},body:'raw-comment-never-publish'}];
   return {ok:true,json:async()=>data};
  };
  await publishSnapshot({repository:'a/b',token:'secret-never-publish',currentRunId:'7',fetchImpl,output:pathToFileURL(`${dir}/`)});
  const text=await readFile(`${dir}/snapshot.json`,'utf8');
  assert.equal(text.includes('secret-never-publish'),false);
  assert.equal(text.includes('raw-comment-never-publish'),false);
  assert.equal(JSON.parse(text).pulls[0].readiness.state,'closed');
  const [current,other]=JSON.parse(text).workflows;
  assert.deepEqual([current.runNumber,current.status,current.current],[5,'publishing',true]);
  assert.deepEqual([other.runNumber,other.conclusion,other.current],[4,'success',undefined]);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('missing token, private visibility and collection errors fail closed',async()=>{
 await assert.rejects(publishSnapshot({repository:'a/b'}),/GITHUB_TOKEN/);
 for(const metadata of [{private:true},{},{private:false,visibility:'internal'}]) await assert.rejects(publishSnapshot({repository:'a/b',token:'test',fetchImpl:async()=>({ok:true,json:async()=>metadata})}),/Only public/);
 await assert.rejects(publishSnapshot({repository:'a/b',token:'test',fetchImpl:async()=>({ok:false})}),/visibility/);
});

test('collection failure does not overwrite a previously saved snapshot',async()=>{
 const dir=await mkdtemp(`${tmpdir()}/autopilot-preserve-`);
 const {writeFile}=await import('node:fs/promises');
 try {
  await writeFile(`${dir}/snapshot.json`,'previous snapshot');
  let calls=0;
  await assert.rejects(publishSnapshot({repository:'a/b',token:'test',output:pathToFileURL(`${dir}/`),fetchImpl:async()=>++calls===1 ? {ok:true,json:async()=>({private:false})} : {ok:false,status:403}}));
  assert.equal(await readFile(`${dir}/snapshot.json`,'utf8'),'previous snapshot');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('visibility changes during collection prevent publication and preserve previous data',async()=>{
 const dir=await mkdtemp(`${tmpdir()}/autopilot-visibility-`);
 const {writeFile}=await import('node:fs/promises');
 try {
  for(const finalResult of [{ok:true,json:async()=>({private:true})},{ok:false,status:403}]) {
   await writeFile(`${dir}/snapshot.json`,'previous public snapshot');
   let metadataCalls=0;
   const fetchImpl=async(url)=>{
    if(url.endsWith('/repos/a/b')) {
     metadataCalls++;
     if(metadataCalls===3) return finalResult;
     return {ok:true,json:async()=>({private:false,full_name:'a/b'})};
    }
    return {ok:true,json:async()=>url.includes('/actions/runs')?{workflow_runs:[]}:[]};
   };
   await assert.rejects(publishSnapshot({repository:'a/b',token:'test',fetchImpl,output:pathToFileURL(`${dir}/`)}));
   assert.equal(metadataCalls,3);
   assert.equal(await readFile(`${dir}/snapshot.json`,'utf8'),'previous public snapshot');
  }
 } finally {await rm(dir,{recursive:true,force:true});}
});
