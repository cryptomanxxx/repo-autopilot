import {readFile} from 'node:fs/promises';
import {repositoryName} from '../src/github.js';

export async function publishData({repository,token,content,fetchImpl=fetch}) {
  const repo=repositoryName(repository);
  if(!token) throw new Error('Data publishing requires GITHUB_TOKEN.');
  const snapshot=JSON.parse(content);
  if(snapshot.repository?.toLowerCase() !== repo.toLowerCase()) throw new Error('Snapshot repository mismatch.');
  async function request(path,method='GET',body,allowMissing=false) {
    const response=await fetchImpl(`https://api.github.com/repos/${repo}/${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(15000)});
    if(allowMissing && response.status === 404) return null;
    if(!response.ok) throw new Error(`Data publishing failed (HTTP ${response.status}).`);
    return response.json();
  }
  const metadata=await request('');
  if(metadata.private !== false || metadata.visibility && metadata.visibility !== 'public') throw new Error('Only public repositories may publish data.');
  const ref=await request('git/ref/heads/dashboard-data','GET',undefined,true);
  const parent=ref?.object.sha || (await request(`git/ref/heads/${metadata.default_branch}`)).object.sha;
  const commit=await request(`git/commits/${parent}`);
  const tree=await request('git/trees','POST',{base_tree:commit.tree.sha,tree:[{path:'data/snapshot.json',mode:'100644',type:'blob',content}]});
  const next=await request('git/commits','POST',{message:'Refresh public dashboard snapshot',tree:tree.sha,parents:[parent]});
  // A fast-forward update rejects concurrent writers rather than overwriting them.
  await request(ref ? 'git/refs/heads/dashboard-data' : 'git/refs',ref ? 'PATCH' : 'POST',ref ? {sha:next.sha,force:false} : {ref:'refs/heads/dashboard-data',sha:next.sha});
  console.log('Published dashboard data independently of GitHub Pages.');
}
if(process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) await publishData({repository:process.env.GITHUB_REPOSITORY,token:process.env.GITHUB_TOKEN,content:await readFile(new URL('../dist/data/snapshot.json',import.meta.url),'utf8')});
