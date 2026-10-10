import {collectTasks} from '../src/tasks.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {createGitHub,repositoryName} from '../src/github.js';

export async function publishSnapshot({repository,token,authorizedUser,fetchImpl=fetch,output=new URL('../dist/data/',import.meta.url)}={}) {
  const repo=repositoryName(repository);
  if(!token) throw new Error('Authenticated snapshot requires GITHUB_TOKEN.');
  // Pages is public: never publish private repository metadata or comment bodies.
  async function verifyPublic() {
    const response=await fetchImpl(`https://api.github.com/repos/${repo}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
    if(!response.ok) throw new Error('Cannot verify public repository visibility.');
    const metadata=await response.json();
    if(metadata.private !== false || metadata.visibility && metadata.visibility !== 'public') throw new Error('Only public repositories may be published.');
  }
  await verifyPublic();
  const snapshot=await createGitHub({token,fetchImpl,pullLimit:5}).snapshot(repo);
  // Explicit public projection prevents future server-only fields leaking to Pages.
  const data={repository:snapshot.repository,url:snapshot.url,fetchedAt:snapshot.fetchedAt,autonomy:false,scope:snapshot.scope,warnings:snapshot.warnings,
    pulls:snapshot.pulls.map(p=>({number:p.number,title:p.title,url:p.url,state:p.state,draft:p.draft,headSha:p.headSha,openedAt:p.openedAt,updatedAt:p.updatedAt,mergedAt:p.mergedAt,ci:p.ci,codex:p.codex,progress:p.progress,readiness:p.readiness,unresolvedThreads:p.unresolvedThreads,detailError:p.detailError})),workflows:snapshot.workflows};
  try {data.tasks=await collectTasks(repo,{token,authorizedUser,fetchImpl});} catch {data.tasks=[];data.warnings=[...data.warnings,'Agent task history is unavailable.'];}
  await mkdir(output,{recursive:true});
  await verifyPublic();
  await writeFile(new URL('snapshot.json',output),JSON.stringify(data));
  console.log(`Published public snapshot for ${repo}.`);
  return data;
}
if(process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) await publishSnapshot({repository:process.env.GITHUB_REPOSITORY,token:process.env.GITHUB_TOKEN,authorizedUser:process.env.AUTOPILOT_TASK_USER});
