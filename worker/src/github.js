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
    return response.status===204?null:response.json();
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
    // Safe to repeat for the same branch after a partial failure: an open pull request for the
    // branch is reused untouched; a leftover branch without one is moved to the new commit.
    async createPullRequest({base,parent,files,executable,branch,title,body}) {
      const openPull=async()=>(await api(`pulls?state=open&head=${encodeURIComponent(`${repository.split('/')[0]}:${branch}`)}`))[0];
      const pullUrl=pull=>{
        if(typeof pull?.html_url!=='string'||!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pull.html_url)) throw new PublicError('GitHub returned an unexpected pull request URL.');
        return pull.html_url;
      };
      const open=await openPull();
      if(open) return pullUrl(open);
      const commit=await api(`git/commits/${parent}`);
      const tree=await api('git/trees',{method:'POST',body:{base_tree:commit.tree.sha,tree:files.map(f=>({path:f.path,mode:executable.has(f.path)?'100755':'100644',type:'blob',content:f.content}))}});
      const next=await api('git/commits',{method:'POST',body:{message:title,tree:tree.sha,parents:[parent]}});
      try {await api('git/refs',{method:'POST',body:{ref:`refs/heads/${branch}`,sha:next.sha}});}
      catch(error) {
        if(!(error instanceof GitHubError&&error.status===422)) throw error;
        // A pull request may have been opened from the branch since the check above.
        const opened=await openPull();
        if(opened) return pullUrl(opened);
        await api(`git/refs/heads/${branch}`,{method:'PATCH',body:{sha:next.sha,force:true}});
      }
      // The description may depend on the new commit, such as GitHub's own count of the changed lines.
      const description=typeof body==='function'?await body(next.sha):body;
      try {return pullUrl(await api('pulls',{method:'POST',body:{title,head:branch,base,body:description}}));}
      catch(error) {
        if(!(error instanceof GitHubError&&error.status===422)) throw error;
        const existing=await openPull();
        if(!existing) throw error;
        return pullUrl(existing);
      }
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

// Minimal reader for the ustar/pax archives GitHub produces with `git archive`. Returns the regular
// files (path -> bytes, without the leading `<owner>-<repo>-<sha>/` folder) and the executable paths.
export function readTar(bytes) {
  const files=new Map(),executable=new Set(),utf8=new TextDecoder();
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
        if(slash>0&&slash<name.length-1) {
          const path=name.slice(slash+1);
          files.set(path,bytes.subarray(start,end));
          if(parseInt(field(header,100,8).trim()||'0',8)&0o111) executable.add(path);
        }
      }
      if(type!=='g') paxPath=null;
    }
    offset=start+Math.ceil(size/512)*512;
  }
  // A complete archive ends with zero blocks; anything else means files may be missing.
  if(!ended) throw new PublicError('Repository archive is truncated.');
  return {files,executable};
}
