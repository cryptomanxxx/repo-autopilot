import {githubClient,GitHubError,readLimited} from './github.js';
import {repositoryName,createGitHub} from '../../src/github.js';
import {PublicError,UserError} from './errors.js';
export {UserError};
import {textFiles,selectContext,buildMessages,answer,applyEdits,displayText,editPolicy,DEFAULT_CONTEXT_CHARS,DEFAULT_MODEL} from './agent.js';

const encoder=new TextEncoder();
const HOUR=3600000,MAX_TEXT=8000,MAX_IMAGE_CHARS=1500000,MAX_BODY=1600000;
// Each dashboard request stays far below the Workers subrequest limit: the overview needs three GitHub
// calls and each pull request is loaded by its own request with at most ten.
export const DASHBOARD_PULLS=6,HEAD_CACHE_MS=60000,OPEN_CACHE_MS=60000,CLOSED_CACHE_MS=HOUR,ERROR_CACHE_MS=30000,REPOS_CACHE_MS=300000,WEBHOOK_MAX_BYTES=5000000;
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const randomHex=(bytes=32)=>hex(crypto.getRandomValues(new Uint8Array(bytes)));
const base64url=bytes=>{let s='';for(const b of bytes) s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const fromBase64url=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const sha256=async text=>new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)));


let keyCache=null;
async function stateKey(secret) {
  if(keyCache?.secret===secret) return keyCache.key;
  const base=await crypto.subtle.importKey('raw',encoder.encode(secret),'HKDF',false,['deriveKey']);
  const key=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('repo-autopilot-chat'),info:encoder.encode('oauth-state')},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  keyCache={secret,key};return key;
}
async function sealState(secret,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await stateKey(secret),encoder.encode(JSON.stringify(value))));
  const out=new Uint8Array(12+sealed.length);out.set(iv);out.set(sealed,12);
  return base64url(out);
}
async function openState(secret,value,now) {
  try {
    if(typeof value!=='string'||value.length>1024) return null;
    const bytes=fromBase64url(value);
    const data=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12)},await stateKey(secret),bytes.subarray(12))));
    return data.expires>now?data:null;
  } catch {return null;}
}

export function validateImage(image) {
  if(image===undefined||image===null) return null;
  const invalid=()=>new UserError(400,'Attach a PNG or JPEG image smaller than about 1 MB.');
  if(typeof image!=='string'||image.length>MAX_IMAGE_CHARS) throw invalid();
  const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if(!match||match[2].length%4!==0) throw invalid();
  const head=atob(match[2].slice(0,12));
  const png=head.startsWith('\x89PNG\r\n\x1a\n'),jpeg=head.startsWith('\xff\xd8\xff');
  if(match[1]==='png'?!png:!jpeg) throw invalid();
  return image;
}

function settings(env,request) {
  const url=new URL(request.url),error={error:'The chat is not configured yet: set REPOSITORY, GITHUB_CLIENT_ID and the GITHUB_CLIENT_SECRET secret (and CHAT_ORIGIN, if used, to an https:// origin).'};
  let repository,origin;
  try {repository=repositoryName(env.REPOSITORY);origin=env.CHAT_ORIGIN?new URL(env.CHAT_ORIGIN).origin:url.origin;} catch {return {...error,secure:url.protocol==='https:'};}
  if(repository!==env.REPOSITORY||!env.GITHUB_CLIENT_ID||!env.GITHUB_CLIENT_SECRET||origin==='null') return {...error,secure:url.protocol==='https:'};
  return {origin,repository,owner:(env.AUTOPILOT_USER||repository.split('/')[0]).toLowerCase(),secure:origin.startsWith('https:'),sameOrigin:url.origin===origin};
}

const SECURITY_HEADERS={
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'
};
function withHeaders(response,secure,extra={}) {
  const result=new Response(response.body,response);
  for(const [k,v] of Object.entries({...SECURITY_HEADERS,...extra})) result.headers.set(k,v);
  if(secure) result.headers.set('Strict-Transport-Security','max-age=31536000');
  return result;
}
const json=(status,value,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
const redirect=(location,cookies=[])=>{const h=new Headers({Location:location,'Cache-Control':'no-store'});for(const c of cookies) h.append('Set-Cookie',c);return new Response(null,{status:303,headers:h});};
function cookies(request) {
  const out={};
  for(const part of (request.headers.get('Cookie')||'').split(';')) {const i=part.indexOf('=');if(i>0) out[part.slice(0,i).trim()]=part.slice(i+1).trim();}
  return out;
}

async function readJson(request) {
  if(!request.headers.get('Content-Type')?.startsWith('application/json')) throw new UserError(415,'Send JSON.');
  if(Number(request.headers.get('Content-Length')||0)>MAX_BODY) throw new UserError(413,'The message is too large. Use a smaller image.');
  if(!request.body) return {};
  let bytes;
  try {bytes=await readLimited(request.body,MAX_BODY);} catch {throw new UserError(413,'The message is too large. Use a smaller image.');}
  try {const value=JSON.parse(new TextDecoder().decode(bytes));if(value&&typeof value==='object'&&!Array.isArray(value)) return value;} catch {}
  throw new UserError(400,'Invalid request.');
}

const chatStore=env=>env.CHAT.get(env.CHAT.idFromName('main'));

export async function handle(request,env,{fetchImpl=fetch,now=Date.now}={}) {
  const config=settings(env,request);
  const url=new URL(request.url);
  const secure=Boolean(config.secure);
  try {
    if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/auth/')) {
      if(!env.ASSETS) return withHeaders(new Response('Not found',{status:404}),secure);
      return withHeaders(await env.ASSETS.fetch(request),secure);
    }
    // GitHub signs webhook deliveries, so they need neither the app's settings nor its browser origin.
    if(url.pathname==='/api/webhook') return withHeaders(await webhook(request,env,chatStore(env)),secure);
    if(config.error) return withHeaders(json(503,{error:config.error}),secure);
    if(!config.sameOrigin) return withHeaders(json(404,{error:'Not found.'}),secure);
    return withHeaders(await route(request,env,config,url,{fetchImpl,now}),secure);
  } catch(error) {
    if(error instanceof UserError) return withHeaders(json(error.status,{error:error.message}),secure);
    console.error('chat request failed',error?.stack||error);
    const message=error instanceof PublicError?error.message:'Request failed. Please try again.';
    return withHeaders(json(500,{error:message}),secure);
  }
}

async function route(request,env,config,url,{fetchImpl,now}) {
  const store=chatStore(env);
  const sessionCookie=config.secure?'__Host-autopilot_session':'autopilot_session';
  const cookie=(name,value,{path='/',maxAge}={})=>`${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge??(value?28800:0)}${config.secure?'; Secure':''}`;
  const callback=`${config.origin}/auth/callback`;

  if(request.method==='GET'&&url.pathname==='/auth/login') {
    const browser=randomHex(),verifier=randomHex();
    const state=await sealState(env.GITHUB_CLIENT_SECRET,{browser,verifier,expires:now()+600000});
    const target=new URL('https://github.com/login/oauth/authorize');
    for(const [k,v] of Object.entries({client_id:env.GITHUB_CLIENT_ID,redirect_uri:callback,state,code_challenge:base64url(await sha256(verifier)),code_challenge_method:'S256'})) target.searchParams.set(k,v);
    return redirect(target.href,[cookie('autopilot_login',browser,{path:'/auth',maxAge:600})]);
  }
  if(request.method==='GET'&&url.pathname==='/auth/callback') {
    // Sign-in problems return to the chat page, which explains them, instead of showing raw JSON.
    // The pending sign-in cookie is only cleared for this browser's own, valid state.
    const githubError=url.searchParams.get('error'),code=url.searchParams.get('code');
    const reason=githubError?(githubError==='access_denied'?'cancelled':'github'):'expired';
    const pending=await openState(env.GITHUB_CLIENT_SECRET,url.searchParams.get('state'),now());
    if(!pending||pending.browser!==cookies(request).autopilot_login) return redirect(`/?signin=${reason}`);
    const failed=reason=>redirect(`/?signin=${reason}`,[cookie('autopilot_login','',{path:'/auth'})]);
    if(githubError) return failed(reason);
    if(!code) return failed('failed');
    let token,user;
    try {
      const exchange=await fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',redirect:'manual',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'repo-autopilot-chat'},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:callback,code_verifier:pending.verifier}),signal:AbortSignal.timeout(20000)});
      token=exchange.ok?await exchange.json().catch(()=>({})):{};
      if(!token.access_token||token.error) return failed('failed');
      // GitHub App user tokens (ghu_ prefix) carry no OAuth scopes and only reach repositories where
      // the app is installed, with the app's permissions. Anything else means an OAuth app was configured.
      if(!token.access_token.startsWith('ghu_')||token.scope) return failed('app');
      const userResponse=await fetchImpl('https://api.github.com/user',{redirect:'manual',headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'repo-autopilot-chat'},signal:AbortSignal.timeout(20000)});
      user=userResponse.ok?await userResponse.json().catch(()=>({})):{};
    } catch(error) {console.error('sign-in failed',error?.stack||error);return failed('failed');}
    if(typeof user.login!=='string'||user.login.toLowerCase()!==config.owner) return failed('owner');
    const id=randomHex(),lifetime=Number.isFinite(token.expires_in)&&token.expires_in>0?token.expires_in*1000:8*HOUR;
    await store.createSession({hash:hex(await sha256(id)),token:token.access_token,csrf:randomHex(),login:user.login,expires:now()+Math.min(lifetime,8*HOUR)});
    return redirect('/',[cookie(sessionCookie,id),cookie('autopilot_login','',{path:'/auth'})]);
  }


  const sessionId=cookies(request)[sessionCookie];
  const hash=sessionId&&/^[0-9a-f]{64}$/.test(sessionId)?hex(await sha256(sessionId)):null;
  const session=hash?await store.getSession(hash):null;
  if(request.method==='GET'&&url.pathname==='/api/session') return json(200,session?{login:session.login,csrf:session.csrf,repository:config.repository,model:env.MODEL||DEFAULT_MODEL}:{login:null,repository:config.repository});
  if(!session) throw new UserError(401,'Sign in to chat.');

  const github=repository=>githubClient({repository,token:session.token,fetchImpl});
  const access={store,session,hash,config,fetchImpl};
  const run=async work=>{
    try {return await work();}
    catch(error) {
      if((error instanceof GitHubError||Number.isInteger(error?.status))&&error.status===401) {await store.deleteSession(hash);throw new UserError(401,'Your GitHub sign-in has expired. Sign in again.');}
      throw error;
    }
  };
  if(request.method==='GET'&&url.pathname==='/api/repos') return run(async()=>{
    const repositories=await accessibleRepos({...access,fresh:url.searchParams.get('fresh')==='1'});
    const home=repositories.some(r=>r.fullName.toLowerCase()===config.repository.toLowerCase())?[]:[{fullName:config.repository,private:false,pushedAt:null}];
    return json(200,{home:config.repository,repositories:[...home,...repositories]});
  });
  // The version is only a counter moved by webhooks, so it needs no GitHub request.
  if(request.method==='GET'&&url.pathname==='/api/dashboard/version') {
    let repository;try {repository=repositoryName(url.searchParams.get('repo')||config.repository);} catch {throw new UserError(400,'Invalid repository.');}
    return json(200,{version:await store.getVersion(repository)});
  }
  if(request.method==='GET'&&(url.pathname==='/api/dashboard'||url.pathname.startsWith('/api/dashboard/'))) return run(async()=>dashboard(url,{store,session,fetchImpl,repository:await resolveRepository(url.searchParams.get('repo'),access)}));
  if(request.method==='GET'&&url.pathname==='/api/conversations') return run(async()=>{
    const repository=await resolveRepository(url.searchParams.get('repo'),access);
    return json(200,{conversations:await store.listConversations(repository,{home:repository.toLowerCase()===config.repository.toLowerCase()})});
  });
  const conversationPath=/^\/api\/conversations\/([0-9a-f]{32})$/.exec(url.pathname);
  if(request.method==='GET'&&conversationPath) {
    const conversation=await store.getConversation(conversationPath[1]);
    if(!conversation) throw new UserError(404,'Conversation not found.');
    return json(200,{...conversation,repository:conversation.repository||config.repository,messages:conversation.messages.map(m=>({id:m.id,role:m.role,content:m.content,hasImage:m.hasImage,created:m.created,prUrl:m.prUrl,meta:m.meta,proposal:m.proposal?{title:m.proposal.title,paths:[...new Set(m.proposal.edits.map(e=>e.path))]}:null}))});
  }
  // The default branch's latest commit, so the chat can tell when an answer is based on older code.
  if(request.method==='GET'&&url.pathname==='/api/head') return run(async()=>{
    const repository=await resolveRepository(url.searchParams.get('repo'),access),key=`head:${repository.toLowerCase()}`;
    const cached=await store.getCache(key);
    if(cached) return json(200,cached);
    const load=await store.startDashboardLoad(repository),head=await github(repository).head();
    await store.setDashboardCache(key,head,HEAD_CACHE_MS,{repository,...load});
    return json(200,head);
  });
  if(request.method!=='POST') throw new UserError(405,'Unsupported request.');
  if(request.headers.get('Origin')!==config.origin||request.headers.get('X-CSRF-Token')!==session.csrf) throw new UserError(403,'The request could not be verified. Reload the page.');
  if(url.pathname==='/api/logout') {
    await store.deleteSession(hash);
    return json(200,{ok:true},{'Set-Cookie':cookie(sessionCookie,'')});
  }
  const body=await readJson(request);
  if(url.pathname==='/api/chat') return run(()=>chat(body,{env,store,github,config,access,fetchImpl}));
  if(url.pathname==='/api/pull-request') return run(()=>pullRequest(body,{store,github,config,access}));
  if(url.pathname==='/api/merge') return run(()=>mergePullRequest(body,{store,github,config,access}));
  throw new UserError(404,'Not found.');
}

// Repositories the owner can open: those where the GitHub App is installed, which are the only ones a
// GitHub App user token reaches. Cached per session for a few minutes; most recently pushed first.
async function accessibleRepos({store,session,hash,fetchImpl,fresh=false}) {
  const key=`repos:${hash}`;
  if(!fresh) {const cached=await store.getCache(key);if(cached) return cached;}
  const get=async path=>{
    const response=await fetchImpl(`https://api.github.com${path}`,{headers:{Authorization:`Bearer ${session.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'repo-autopilot-chat'},signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new GitHubError(response.status,path);
    return response.json();
  };
  const found=new Map();
  const {installations=[]}=await get('/user/installations?per_page=100');
  // At most 11 GitHub calls, so a request that reads the list twice stays within the subrequest limit.
  for(const installation of installations.slice(0,5)) {
    if(!Number.isSafeInteger(installation?.id)) continue;
    for(let page=1;page<=2;page++) {
      const {repositories=[]}=await get(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`);
      for(const repo of repositories) if(typeof repo?.full_name==='string') found.set(repo.full_name.toLowerCase(),{fullName:repo.full_name,private:Boolean(repo.private),pushedAt:repo.pushed_at||null});
      if(repositories.length<100) break;
    }
  }
  const list=[...found.values()].sort((a,b)=>String(b.pushedAt).localeCompare(String(a.pushedAt))||a.fullName.localeCompare(b.fullName));
  await store.setCache(key,list,REPOS_CACHE_MS);
  return list;
}

// The repository a request works on: the requested one if the owner can reach it, else the app's own.
// A repository the app was just installed on is found by reading the list again once.
async function resolveRepository(requested,access) {
  let name=access.config.repository;
  if(requested!==null&&requested!==undefined&&requested!=='') {
    try {name=repositoryName(requested);} catch {throw new UserError(400,'Invalid repository.');}
  }
  // The app's own repository is always allowed and needs no lookup, as before repository selection.
  if(name.toLowerCase()===access.config.repository.toLowerCase()) return access.config.repository;
  const find=list=>list.find(r=>r.fullName.toLowerCase()===name.toLowerCase())?.fullName;
  const found=find(await accessibleRepos(access))||find(await accessibleRepos({...access,fresh:true}));
  if(!found) throw new UserError(403,`Repo Autopilot cannot reach ${name}. Install the GitHub App on that repository.`);
  return found;
}

// Which cached data a GitHub webhook event makes stale. null: the event changes nothing shown.
// Check and status events name a commit; it is matched with the head commits of loaded pull requests, so
// events for other branches (such as pushes to the default branch) cause no reload.
export function webhookTargets(event,payload) {
  const numbers=list=>Array.isArray(list)?list.map(item=>item?.number).filter(n=>Number.isSafeInteger(n)&&n>0):[];
  const commit=sha=>typeof sha==='string'&&/^[0-9a-f]{40}$/.test(sha)?sha:null;
  switch(event) {
    case 'pull_request': case 'pull_request_review': case 'pull_request_review_comment': case 'pull_request_review_thread':
      return {overview:true,pulls:numbers([payload.pull_request])};
    case 'issue_comment': return payload.issue?.pull_request?{overview:true,pulls:numbers([payload.issue])}:null;
    case 'check_run': case 'check_suite':
      return {overview:false,pulls:numbers(payload[event]?.pull_requests),sha:commit(payload[event]?.head_sha)};
    case 'status': return {overview:false,pulls:[],sha:commit(payload.sha)};
    case 'workflow_run': return {overview:true,pulls:numbers(payload.workflow_run?.pull_requests)};
    // A push to the default branch moves the commit that chat answers are compared with.
    case 'push': return payload.ref&&payload.ref===`refs/heads/${payload.repository?.default_branch}`?{overview:false,pulls:[],head:true}:null;
    default: return null;
  }
}

// GitHub App webhook: verifies GitHub's HMAC signature, then drops the cached data the event affects.
// Open dashboards notice the new version within seconds and reload only what changed.
async function webhook(request,env,store) {
  if(!env.WEBHOOK_SECRET) throw new UserError(404,'Not found.');
  if(request.method!=='POST') throw new UserError(405,'Unsupported request.');
  const signature=/^sha256=([0-9a-f]{64})$/.exec(request.headers.get('X-Hub-Signature-256')||'');
  if(!signature||!request.body) throw new UserError(401,'Invalid signature.');
  if(Number(request.headers.get('Content-Length')||0)>WEBHOOK_MAX_BYTES) throw new UserError(413,'Payload too large.');
  let body;
  try {body=await readLimited(request.body,WEBHOOK_MAX_BYTES);} catch {throw new UserError(413,'Payload too large.');}
  const key=await crypto.subtle.importKey('raw',encoder.encode(env.WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const expected=Uint8Array.from(signature[1].match(/../g),pair=>parseInt(pair,16));
  if(!await crypto.subtle.verify('HMAC',key,expected,body)) throw new UserError(401,'Invalid signature.');
  let payload;
  try {payload=JSON.parse(new TextDecoder().decode(body));} catch {throw new UserError(400,'Invalid payload.');}
  const targets=webhookTargets(request.headers.get('X-GitHub-Event')||'',payload||{});
  const repository=payload?.repository?.full_name;
  if(targets&&typeof repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) await store.invalidate(repository,targets);
  return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
}

// Live dashboard data from GitHub, cached briefly so several tabs and refreshes share requests.
// The client passes each pull request's updatedAt, so new commits or comments bypass the cache.
async function dashboard(url,{store,session,fetchImpl,repository}) {
  const client=createGitHub({token:session.token,fetchImpl,pullLimit:DASHBOARD_PULLS,userAgent:'repo-autopilot-chat'});
  const fresh=url.searchParams.get('fresh')==='1';
  const pull=/^\/api\/dashboard\/pulls\/([1-9]\d{0,8})$/.exec(url.pathname);
  if(url.pathname!=='/api/dashboard'&&!pull) throw new UserError(404,'Not found.');
  const updated=url.searchParams.get('updated')||'';
  if(updated.length>40) throw new UserError(400,'Invalid request.');
  const repo=repository.toLowerCase(),key=pull?`pull:${repo}:${pull[1]}:${updated}`:`overview:${repo}`;
  const cached=fresh?null:await store.getCache(key);
  if(cached?.refused) throw new UserError(cached.refused.status,cached.refused.message);
  if(cached) return json(200,cached);
  const load=await store.startDashboardLoad(repository);
  let value,changed=false;
  try {
    if(pull) {
      const {item,warnings,changed:moved}=await client.pullDetails(repository,await client.pull(repository,Number(pull[1])));
      value={...item,warnings};changed=moved;
    } else {
      const {repo:ignored,pulls,...rest}=await client.overview(repository);
      value={...rest,pulls:pulls.map(p=>({number:p.number,title:p.title,url:p.html_url,state:p.merged_at?'merged':p.state,updatedAt:p.updated_at}))};
    }
  } catch(error) {
    // createGitHub reports GitHub failures with a status and a message written for the owner. An expired
    // token (401) ends the session in run(); other refusals are reported as GitHub's, not as server errors.
    if(error?.status===401) throw error;
    if(Number.isInteger(error?.status)) {
      const refused={status:[403,404,429].includes(error.status)?error.status:502,message:error.message};
      // A refusal (a missing permission, a rate limit) is remembered briefly so reloads do not repeat it;
      // GitHub server errors are not, so a recovered GitHub is used at once. Caching is best-effort.
      if([403,429].includes(error.status)) {try {await store.setCache(key,{refused},ERROR_CACHE_MS);} catch {}}
      throw new UserError(refused.status,refused.message);
    }
    throw error;
  }
  // A result with a failed part is cached only briefly, so a transient GitHub error does not stick. A pull
  // request that changed while loading is not cached at all: the next load should read it again.
  if(!changed) await store.setDashboardCache(key,value,value.detailError?ERROR_CACHE_MS:pull&&value.state!=='open'&&value.unresolvedThreads!==null?CLOSED_CACHE_MS:OPEN_CACHE_MS,{repository,...load,pull:pull?{number:Number(pull[1]),sha:value.headSha}:null});
  return json(200,value);
}

async function chat(body,{env,store,github,config,access,fetchImpl}) {
  const text=typeof body.text==='string'?body.text.trim():'';
  if(!text||text.length>MAX_TEXT) throw new UserError(400,`Write a message between 1 and ${MAX_TEXT} characters.`);
  const image=validateImage(body.image);
  let conversation=null;
  if(body.conversation!==undefined&&body.conversation!==null) {
    if(typeof body.conversation!=='string'||!/^[0-9a-f]{32}$/.test(body.conversation)) throw new UserError(400,'Invalid conversation.');
    conversation=await store.getConversation(body.conversation);
    if(!conversation) throw new UserError(404,'Conversation not found.');
  }
  // A conversation stays with the repository it started in; a new one uses the selected repository.
  const saved=conversation?conversation.repository||config.repository:null;
  if(saved&&body.repo&&String(body.repo).toLowerCase()!==saved.toLowerCase()) throw new UserError(409,`This conversation belongs to ${saved}. Start a new conversation for another repository.`);
  const repository=await resolveRepository(saved||body.repo,access),policy=editPolicy(repository,config.repository);
  const lock=randomHex(16);
  // Longer than the worst case below: GitHub reads plus two model calls of at most 150 s each.
  if(!await store.acquireLock('model',lock,420000)) throw new UserError(429,'The agent is still answering another message. Wait until it has finished.');
  let streaming=false;
  try {
    // GitHub is read before the answer starts streaming, so its refusals keep their HTTP status.
    const load=await store.startDashboardLoad(repository);
    const client=github(repository),head=await client.head(),archive=(await client.archive(head.sha)).files,files=textFiles(archive);
    // The latest commit just read is also what the chat compares answers with, unless a push arrived meanwhile.
    await store.setDashboardCache(`head:${repository.toLowerCase()}`,head,HEAD_CACHE_MS,{repository,...load});
    const history=conversation?.messages||[];
    const query=[...history.filter(m=>m.role==='user').slice(-2).map(m=>m.content),text].join('\n');
    const context=selectContext(files,query,Number(env.CONTEXT_CHARS)||DEFAULT_CONTEXT_CHARS);
    const meta={repository,branch:head.branch,sha:head.sha,read:context.included.length,files:Object.keys(files).length};
    const messages=buildMessages({repository,head,context,history,text,image,rule:policy.rule});
    streaming=true;
    // The answer streams progress steps as lines of JSON, ending with a done or an error line.
    return progressStream(async send=>{
      try {
        send({type:'step',text:`Read ${repository} · ${head.branch} @ ${head.sha.slice(0,7)} · ${meta.files} files`});
        send({type:'step',text:`Chose ${meta.read} relevant file${meta.read===1?'':'s'}; asking the model…`});
        const result=await answer(env,{messages,files,existingPaths:[...archive.keys()],allowed:policy.allowed,fetchImpl,onStep:text=>send({type:'step',text})});
        const content=result.error?`${result.reply}\n\n⚠ The proposed change could not be applied: ${result.error} Ask the agent to try again.`:result.reply;
        const id=conversation?.id||randomHex(16);
        await store.saveExchange({conversation:id,title:conversation?null:text.replace(/\s+/g,' ').slice(0,80),repository:conversation?null:repository,user:{content:text,hasImage:Boolean(image)},assistant:{content,proposal:result.proposal,meta}});
        send({type:'done',conversation:id});
      } catch(error) {
        if(!(error instanceof UserError||error instanceof PublicError)) console.error('chat request failed',error?.stack||error);
        send({type:'error',status:Number.isInteger(error?.status)?error.status:500,error:error instanceof UserError||error instanceof PublicError?error.message:'Request failed. Please try again.'});
      } finally {await store.releaseLock('model',lock);}
    });
  } finally {if(!streaming) await store.releaseLock('model',lock);}
}

function progressStream(work) {
  const {readable,writable}=new TransformStream(),writer=writable.getWriter();
  const send=value=>{writer.write(encoder.encode(JSON.stringify(value)+'\n')).catch(()=>{});};
  work(send).catch(error=>console.error('chat stream failed',error?.stack||error)).finally(()=>writer.close().catch(()=>{}));
  return new Response(readable,{status:200,headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store'}});
}

// Lines added and removed between two versions of a file: common lines at both ends are skipped and
// the rest is compared line by line (a longest-common-subsequence diff, bounded for very large edits).
export function lineChanges(before,after) {
  const a=before===undefined?[]:before.replace(/\r\n/g,'\n').split('\n'),b=after.replace(/\r\n/g,'\n').split('\n');
  let start=0;while(start<a.length&&start<b.length&&a[start]===b[start]) start++;
  let endA=a.length,endB=b.length;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]) {endA--;endB--;}
  const x=a.slice(start,endA),y=b.slice(start,endB);
  if(x.length*y.length>4000000) return {added:y.length,removed:x.length};
  let previous=new Array(y.length+1).fill(0);
  for(let i=1;i<=x.length;i++) {
    const row=new Array(y.length+1).fill(0);
    for(let j=1;j<=y.length;j++) row[j]=x[i-1]===y[j-1]?previous[j-1]+1:Math.max(previous[j],row[j-1]);
    previous=row;
  }
  const common=previous[y.length];
  return {added:y.length-common,removed:x.length-common};
}

// The pull request description: what the owner asked for, the agent's explanation and what changes.
export function pullDescription({request,explanation,changes,sha}) {
  const quote=text=>text.trim().slice(0,1500).split('\n').map(line=>`> ${line}`).join('\n');
  const file=({path,added,removed,created})=>`- \`${path}\`${created?' (new file)':''}: +${added} −${removed} line${added+removed===1?'':'s'}`;
  return [
    request.trim()?`## Request\n\n${quote(request)}`:'',
    explanation.trim()?`## What the agent changed\n\n${explanation.trim().slice(0,3000)}`:'',
    `## Files\n\n${changes.map(file).join('\n')}`,
    `---\nCreated from the Repo Autopilot chat on ${sha.slice(0,10)}. Agent-generated: review the diff and CI before merging.`,
  ].filter(Boolean).join('\n\n');
}

// Merges the pull request opened from an answer, exactly at the head commit the owner saw checked.
// GitHub still enforces branch protection, required checks and reviews.
async function mergePullRequest(body,{store,github,config,access}) {
  if(typeof body.conversation!=='string'||!/^[0-9a-f]{32}$/.test(body.conversation)||!Number.isSafeInteger(body.message)||body.message<1) throw new UserError(400,'Invalid request.');
  // The head commit whose status the owner saw is required: nothing else is ever merged.
  if(typeof body.sha!=='string'||!/^[0-9a-f]{40}$/.test(body.sha)) throw new UserError(400,'Reload the pull request status before merging.');
  const message=await store.getMessage(body.conversation,body.message);
  const info=await store.getConversationInfo(body.conversation);
  const repository=await resolveRepository(info?.repository||config.repository,access);
  const prefix=`https://github.com/${repository}/pull/`.toLowerCase(),url=typeof message?.prUrl==='string'?message.prUrl:'';
  const rest=url.toLowerCase().startsWith(prefix)?url.slice(prefix.length):'',number=/^[1-9]\d{0,8}$/.test(rest)?Number(rest):0;
  if(!number) throw new UserError(404,'This message has no pull request to merge.');
  const lock=randomHex(16);
  if(!await store.acquireLock('merge',lock,60000)) throw new UserError(429,'A merge is already in progress. Wait a moment.');
  try {
    const client=github(repository),pull=await client.api(`pulls/${number}`);
    if(pull.merged) return json(200,{merged:true});
    if(pull.state!=='open') throw new UserError(409,`PR #${number} is closed.`);
    // The chat promises a merge into the default branch; a retargeted pull request is merged on GitHub.
    const {default_branch:defaultBranch}=await client.api('');
    if(pull.base?.ref!==defaultBranch) throw new UserError(409,`PR #${number} now targets ${pull.base?.ref||'another branch'} instead of the default branch ${defaultBranch}. Merge it on GitHub if that is intended.`);
    if(body.sha!==pull.head?.sha) throw new UserError(409,`PR #${number} has new commits since its status was shown. Check it again before merging.`);
    try {await client.api(`pulls/${number}/merge`,{method:'PUT',body:{sha:body.sha,merge_method:'squash',commit_title:`${pull.title} (#${number})`}});}
    catch(error) {
      if(!(error instanceof GitHubError)) throw error;
      if(error.status===405) throw new UserError(409,`GitHub cannot merge PR #${number} yet: required checks, reviews or branch rules are not satisfied, or it has conflicts.`);
      if(error.status===409) throw new UserError(409,`PR #${number} changed while merging. Check it again.`);
      if([403,404].includes(error.status)) throw new UserError(403,`GitHub refused to merge PR #${number} (HTTP ${error.status}). Check that the GitHub App has Contents and Pull requests set to Read and write.`);
      throw error;
    }
    // The chat's own branch is removed once merged; failures leave it for GitHub's own cleanup.
    const ref=pull.head?.ref;
    if(typeof ref==='string'&&ref.startsWith('autopilot/chat-')&&pull.head?.repo?.full_name?.toLowerCase()===repository.toLowerCase()) {
      try {await client.api(`git/refs/heads/${ref.split('/').map(encodeURIComponent).join('/')}`,{method:'DELETE'});} catch {}
    }
    await store.invalidate(repository,{overview:true,pulls:[number],head:true});
    return json(200,{merged:true});
  } finally {await store.releaseLock('merge',lock);}
}

async function pullRequest(body,{store,github,config,access}) {
  if(typeof body.conversation!=='string'||!/^[0-9a-f]{32}$/.test(body.conversation)||!Number.isSafeInteger(body.message)||body.message<1) throw new UserError(400,'Invalid request.');
  const lock=randomHex(16);
  if(!await store.acquireLock('pull-request',lock,240000)) throw new UserError(429,'A pull request is already being created. Wait a moment.');
  try {
    const message=await store.getMessage(body.conversation,body.message);
    if(!message||message.role!=='assistant'||!message.proposal) throw new UserError(404,'This message has no proposed change.');
    if(message.prUrl) return json(200,{url:message.prUrl});
    const info=await store.getConversationInfo(body.conversation);
    const repository=await resolveRepository(info?.repository||config.repository,access),policy=editPolicy(repository,config.repository);
    const client=github(repository),head=await client.head(),{files:archive,executable}=await client.archive(head.sha);
    const edited=new Set(message.proposal.edits.map(e=>e.path));
    let files;const originals=textFiles(new Map([...archive].filter(([path])=>edited.has(path))));
    try {files=applyEdits(message.proposal.edits,originals,[...archive.keys()],policy.allowed);}
    catch(error) {throw new UserError(409,`The change no longer applies to the current code: ${error.message} Ask the agent to redo it.`);}
    const title=message.proposal.title||info?.title||'Change from the agent chat';
    const conversation=await store.getConversation(body.conversation);
    const request=conversation?.messages.filter(m=>m.role==='user'&&m.id<message.id).at(-1)?.content||'';
    const description=pullDescription({request,explanation:displayText(message.content),changes:files.map(f=>({path:f.path,created:originals[f.path]===undefined,...lineChanges(originals[f.path],f.content)})),sha:head.sha});
    let url;
    try {url=await client.createPullRequest({base:head.branch,parent:head.sha,files,executable,branch:`autopilot/chat-${body.conversation.slice(0,12)}-${body.message}`,title,body:description});}
    catch(error) {
      if(error instanceof GitHubError&&[403,404].includes(error.status)) throw new UserError(403,`GitHub refused to create the pull request (HTTP ${error.status}). Check that the GitHub App is installed on this repository with Contents and Pull requests set to Read and write.`);
      throw error;
    }
    await store.setPullRequest(body.conversation,body.message,url);
    return json(200,{url});
  } finally {await store.releaseLock('pull-request',lock);}
}
