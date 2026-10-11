// GitHub REST access for the chat Worker. Every call uses the signed-in owner's GitHub App user
// token, so the Worker holds no standing write credential of its own.
const API='https://api.github.com';
export const MAX_ARCHIVE_BYTES=12_000_000;

export class GitHubError extends PublicError {
  constructor(status,path) {super(`GitHub request failed (HTTP ${status}).`);this.status=status;this.path=path;}
}

import {repositoryName} from '../../src/github.js';
import {PublicError} from './errors.js';

export function githubClient({repository,token,fetchImpl=fetch}) {
  if(repositoryName(repository)!==repository) throw new PublicError('Invalid repository configuration.');
  const headers=accept=>({Authorization:`Bearer ${token}`,Accept:accept,'User-Agent':'repo-autopilot-chat','X-GitHub-Api-Version':'2022-11-28'});
  async function api(path,{method='GET',body}={}) {
    const response=await fetchImpl(`${API}/repos/${repository}${path?'/'+path:''}`,{method,headers:{...headers('application/vnd.github+json'),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new GitHubError(response.status,path);
    return response.json();
  }
  return {
    api,
    async head() {
      const metadata=await api('');
      const branch=metadata.default_branch;
      if(typeof branch!=='string'||!branch) throw new PublicError('Repository default branch is unavailable.');
      const ref=await api(`git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
      if(!/^[0-9a-f]{40}$/.test(ref.object?.sha||'')) throw new PublicError('Repository head is unavailable.');
      return {branch,sha:ref.object.sha};
    },
    // One archive request reads the whole tree, which keeps each chat message far below the
    // Workers subrequest limit regardless of how many files the repository has.
    async archive(sha) {
      const response=await fetchImpl(`${API}/repos/${repository}/tarball/${sha}`,{headers:headers('application/vnd.github+json'),signal:AbortSignal.timeout(30000)});
      if(!response.ok) throw new GitHubError(response.status,'tarball');
      return readTar(await readLimited(response.body.pipeThrough(new DecompressionStream('gzip')),MAX_ARCHIVE_BYTES));
    },
    // Safe to repeat for the same branch: a retry after a partial failure moves the branch to the
    // new commit and reuses an open pull request instead of creating another.
    async createPullRequest({base,parent,files,branch,title,body}) {
      const commit=await api(`git/commits/${parent}`);
      const current=await api(`git/trees/${commit.tree.sha}?recursive=1`);
      const modes=new Map((current.tree||[]).map(entry=>[entry.path,entry.mode]));
      const tree=await api('git/trees',{method:'POST',body:{base_tree:commit.tree.sha,tree:files.map(f=>({path:f.path,mode:modes.get(f.path)==='100755'?'100755':'100644',type:'blob',content:f.content}))}});
      const next=await api('git/commits',{method:'POST',body:{message:title,tree:tree.sha,parents:[parent]}});
      try {await api('git/refs',{method:'POST',body:{ref:`refs/heads/${branch}`,sha:next.sha}});}
      catch(error) {
        if(!(error instanceof GitHubError&&error.status===422)) throw error;
        await api(`git/refs/heads/${branch}`,{method:'PATCH',body:{sha:next.sha,force:true}});
      }
      let pull;
      try {pull=await api('pulls',{method:'POST',body:{title,head:branch,base,body}});}
      catch(error) {
        if(!(error instanceof GitHubError&&error.status===422)) throw error;
        [pull]=await api(`pulls?state=open&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}`);
        if(!pull) throw error;
      }
      if(typeof pull.html_url!=='string'||!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pull.html_url)) throw new PublicError('GitHub returned an unexpected pull request URL.');
      return pull.html_url;
    }
  };
}

export async function readLimited(stream,limit) {
  const reader=stream.getReader(),chunks=[];let size=0;
  for(;;) {
    const {done,value}=await reader.read();
    if(done) break;
    size+=value.byteLength;
    if(size>limit) {await reader.cancel();throw new PublicError('Repository archive is too large for the chat agent.');}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

// Minimal reader for the ustar/pax archives GitHub produces with `git archive`. Returns
// {path: Uint8Array} for regular files with the leading `<owner>-<repo>-<sha>/` folder removed.
export function readTar(bytes) {
  const files=new Map(),utf8=new TextDecoder();
  const field=(header,start,length)=>{let end=start;while(end<start+length&&header[end]!==0) end++;return utf8.decode(header.subarray(start,end));};
  let offset=0,paxPath=null,ended=false;
  while(offset+512<=bytes.length) {
    const header=bytes.subarray(offset,offset+512);
    if(header.every(b=>b===0)) {ended=true;break;}
    const sizeField=field(header,124,12).trim();
    if(!/^[0-7]*$/.test(sizeField)) throw new PublicError('Unsupported repository archive entry.');
    const size=parseInt(sizeField||'0',8),type=header[156]===0?'0':String.fromCharCode(header[156]);
    const start=offset+512,end=start+size;
    if(end>bytes.length) throw new PublicError('Repository archive is truncated.');
    if(type==='x') {
      paxPath=null;
      for(const record of utf8.decode(bytes.subarray(start,end)).split('\n')) {
        const match=/^\d+ path=(.*)$/s.exec(record);
        if(match) paxPath=match[1];
      }
    } else {
      if(type==='0') {
        const prefix=field(header,257,6)==='ustar'?field(header,345,155):'';
        const name=paxPath??(prefix?`${prefix}/${field(header,0,100)}`:field(header,0,100));
        const slash=name.indexOf('/');
        if(slash>0&&slash<name.length-1) files.set(name.slice(slash+1),bytes.subarray(start,end));
      }
      if(type!=='g') paxPath=null;
    }
    offset=start+Math.ceil(size/512)*512;
  }
  // A complete archive ends with zero blocks; anything else means files may be missing.
  if(!ended) throw new PublicError('Repository archive is truncated.');
  return files;
}
