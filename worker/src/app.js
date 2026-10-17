import {githubClient,GitHubError,readLimited} from './github.js';
import {repositoryName,createGitHub} from '../../src/github.js';
import {PublicError,UserError} from './errors.js';
import {hex,randomHex,base64url,sha256,sealState,openState} from './crypto.js';
import {connector,isConnectorPath,finishConnect,failConnect,logOauth,githubHandoff} from './connector.js';
import {connectorTools} from './tools.js';
export {UserError};
import {textFiles,selectContext,buildMessages,answer,applyEdits,displayText,editPolicy,DEFAULT_CONTEXT_CHARS,DEFAULT_MODEL} from './agent.js';

const encoder=new TextEncoder();
const HOUR=3600000,MAX_TEXT=8000,MAX_IMAGE_CHARS=1500000,MAX_BODY=1600000;
// Each dashboard request stays far below the Workers subrequest limit: the overview needs three GitHub
// calls and each pull request is loaded by its own request with at most ten.
// "Show more" raises the overview's limits in steps, up to a maximum.
export const DASHBOARD_PULLS=6,DASHBOARD_MAX_PULLS=30,DASHBOARD_RUNS=15,DASHBOARD_MAX_RUNS=60,HEAD_CACHE_MS=60000,OPEN_CACHE_MS=60000,CLOSED_CACHE_MS=HOUR,ERROR_CACHE_MS=30000,REPOS_CACHE_MS=300000,WEBHOOK_MAX_BYTES=5000000;
// The commit and time the deploy workflow recorded; null when the Worker was deployed some other way.
export function deployedVersion(env) {
  const commit=/^[0-9a-f]{40}$/i.test(env.DEPLOYED_COMMIT||'')?env.DEPLOYED_COMMIT.toLowerCase():null;
  const at=Date.parse(env.DEPLOYED_AT||'');
  return commit?{commit,at:Number.isNaN(at)?null:new Date(at).toISOString()}:null;
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
  // A page that sets its own policies (the connector's consent page) keeps them.
  for(const [k,v] of Object.entries({...SECURITY_HEADERS,...extra})) if(!(['Content-Security-Policy','Referrer-Policy'].includes(k)&&response.headers.has(k))) result.headers.set(k,v);
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
    // The Claude/ChatGPT connector: OAuth endpoints and the MCP endpoint.
    if(isConnectorPath(url.pathname)) {
      if(config.error) return withHeaders(json(503,{error:config.error}),secure);
      if(!config.sameOrigin) return withHeaders(json(404,{error:'Not found.'}),secure);
      const store=chatStore(env);
      return withHeaders(await connector(request,url,{store,env,origin:config.origin,secure,fetchImpl,now,tools:connectorTools({store,fetchImpl,config,readRepos,resolveRepository,dashboardData,pullLimit:DASHBOARD_PULLS,runStep:DASHBOARD_RUNS,runMax:DASHBOARD_MAX_RUNS})}),secure);
    }
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
    return githubHandoff(target.href,[cookie('autopilot_login',browser,{path:'/auth',maxAge:600})]);
  }
  if(request.method==='GET'&&url.pathname==='/auth/callback') {
    // Sign-in problems return to the chat page, which explains them, instead of showing raw JSON.
    // The pending sign-in cookie is only cleared for this browser's own, valid state.
    const githubError=url.searchParams.get('error'),code=url.searchParams.get('code');
    const reason=githubError?(githubError==='access_denied'?'cancelled':'github'):'expired';
    const pending=await openState(env.GITHUB_CLIENT_SECRET,url.searchParams.get('state'),now());
    if(!pending||pending.browser!==cookies(request).autopilot_login) {
      // A connection whose sign-in came back to another browser than the one that started it.
      if(pending?.connect) await logOauth('github',new Response(null,{status:400}),{reason:'browser'});
      return redirect(`/?signin=${reason}`);
    }
    // A connection whose callback fails with an exception is logged too, as the 500 it is answered with.
    const logThrown=async run=>{
      try {return await run();}
      catch(error) {console.log(JSON.stringify({connector:'oauth',step:'github',status:500,error:'exception'}));throw error;}
    };
    const failed=async reason=>{
      // A connection in progress reports the failure to the app that started it.
      const back=pending.connect&&await logThrown(()=>failConnect({pending:pending.connect,reason,store,origin:config.origin}));
      if(back) {back.headers.append('Set-Cookie',cookie('autopilot_login','',{path:'/auth'}));return logOauth('github',back,{reason});}
      if(pending.connect) await logOauth('github',new Response(null,{status:400}),{reason});
      return redirect(`/?signin=${reason}`,[cookie('autopilot_login','',{path:'/auth'})]);
    };
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
    // A sign-in started by connecting Claude or ChatGPT finishes the connection instead of opening the dashboard.
    if(pending.connect) {
      const connected=await logThrown(()=>finishConnect({pending:pending.connect,token,login:user.login,store,env,origin:config.origin,now}));
      if(!connected) return failed('expired');
      connected.headers.append('Set-Cookie',cookie('autopilot_login','',{path:'/auth'}));
      return logOauth('github',connected);
    }
    const id=randomHex(),lifetime=Number.isFinite(token.expires_in)&&token.expires_in>0?token.expires_in*1000:8*HOUR;
    await store.createSession({hash:hex(await sha256(id)),token:token.access_token,csrf:randomHex(),login:user.login,expires:now()+Math.min(lifetime,8*HOUR)});
    return redirect('/',[cookie(sessionCookie,id),cookie('autopilot_login','',{path:'/auth'})]);
  }


  const sessionId=cookies(request)[sessionCookie];
  const hash=sessionId&&/^[0-9a-f]{64}$/.test(sessionId)?hex(await sha256(sessionId)):null;
  const session=hash?await store.getSession(hash):null;
  if(request.method==='GET'&&url.pathname==='/api/session') return json(200,session?{login:session.login,csrf:session.csrf,repository:config.repository,model:env.MODEL||DEFAULT_MODEL,deployed:deployedVersion(env)}:{login:null,repository:config.repository});
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
  // Apps connected through the connector, which the owner can revoke.
  if(request.method==='GET'&&url.pathname==='/api/connections') return json(200,{endpoint:`${config.origin}/mcp`,connections:await store.listGrants()});
  if(request.method!=='POST') throw new UserError(405,'Unsupported request.');
  if(request.headers.get('Origin')!==config.origin||request.headers.get('X-CSRF-Token')!==session.csrf) throw new UserError(403,'The request could not be verified. Reload the page.');
  if(url.pathname==='/api/logout') {
    await store.deleteSession(hash);
    return json(200,{ok:true},{'Set-Cookie':cookie(sessionCookie,'')});
  }
  const body=await readJson(request);
  if(url.pathname==='/api/chat') return run(()=>chat(body,{env,store,github,config,access,fetchImpl}));
  if(url.pathname==='/api/pull-request') return run(()=>pullRequest(body,{store,github,config,access}));
  if(url.pathname==='/api/merge') return run(()=>mergePullRequest(body,{store,github,access}));
  if(url.pathname==='/api/codex-review') return run(()=>askCodex('review',body,{store,github,access}));
  if(url.pathname==='/api/connections/revoke') {
    if(typeof body.id!=='string'||!/^[0-9a-f]{32}$/.test(body.id)) throw new UserError(400,'Invalid request.');
    await store.deleteGrant(body.id);
    return json(200,{revoked:true});
  }
  throw new UserError(404,'Not found.');
}

// Repositories the owner can open: those where the GitHub App is installed, which are the only ones a
// GitHub App user token reaches. Cached per session for a few minutes; most recently pushed first.
async function accessibleRepos(options) {return (await readRepos(options)).list;}
// The same list, and whether it was cut off at the limits below.
async function readRepos({store,session,hash,fetchImpl,fresh=false}) {
  const key=`repos:${hash}`;
  if(!fresh) {
    const cached=await store.getCache(key);
    if(cached) return Array.isArray(cached)?{list:cached,truncated:false}:cached;
  }
  const get=async path=>{
    const response=await fetchImpl(`https://api.github.com${path}`,{headers:{Authorization:`Bearer ${session.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'repo-autopilot-chat'},signal:AbortSignal.timeout(20000)});
    if(!response.ok) throw new GitHubError(response.status,path);
    return response.json();
  };
  const found=new Map();
  const {installations=[]}=await get('/user/installations?per_page=100');
  // At most 11 GitHub calls, so a request that reads the list twice stays within the subrequest limit.
  let truncated=installations.length>5;
  for(const installation of installations.slice(0,5)) {
    if(!Number.isSafeInteger(installation?.id)) continue;
    for(let page=1;page<=2;page++) {
      const {repositories=[]}=await get(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`);
      for(const repo of repositories) if(typeof repo?.full_name==='string') found.set(repo.full_name.toLowerCase(),{fullName:repo.full_name,private:Boolean(repo.private),pushedAt:repo.pushed_at||null});
      if(repositories.length<100) break;
      if(page===2) truncated=true;
    }
  }
  const list=[...found.values()].sort((a,b)=>String(b.pushedAt).localeCompare(String(a.pushedAt))||a.fullName.localeCompare(b.fullName));
  const result={list,truncated};
  await store.setCache(key,result,REPOS_CACHE_MS);
  return result;
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
  const limit=(name,step,max)=>{
    const value=url.searchParams.get(name);
    if(value===null) return step;
    if(!/^[1-9]\d{0,2}$/.test(value)||Number(value)%step||Number(value)>max) throw new UserError(400,'Invalid request.');
    return Number(value);
  };
  const pullLimit=limit('pulls',DASHBOARD_PULLS,DASHBOARD_MAX_PULLS),runLimit=limit('runs',DASHBOARD_RUNS,DASHBOARD_MAX_RUNS);
  const fresh=url.searchParams.get('fresh')==='1';
  const pull=/^\/api\/dashboard\/pulls\/([1-9]\d{0,8})$/.exec(url.pathname);
  if(url.pathname!=='/api/dashboard'&&!pull) throw new UserError(404,'Not found.');
  const updated=url.searchParams.get('updated')||'';
  if(updated.length>40) throw new UserError(400,'Invalid request.');
  const value=await dashboardData({store,token:session.token,fetchImpl,repository,number:pull?Number(pull[1]):null,updated,pullLimit,runLimit,fresh});
  // Whether Codex was already asked to review the head is read on every response, outside the cache.
  return json(200,pull&&value?.state==='open'&&value.headSha?{...value,codexReviewAsked:await store.hasCodexRequest('review',repository,value.number,value.headSha)}:value);
}

// The dashboard's data, from the cache when it is current: the overview of a repository, or one pull
// request's details when a number is given. The connector's tools read the same data.
export async function dashboardData({store,token,fetchImpl,repository,number=null,updated='',pullLimit=DASHBOARD_PULLS,runLimit=DASHBOARD_RUNS,fresh=false,cachedOnly=false}) {
  const client=createGitHub({token,fetchImpl,pullLimit,runLimit,userAgent:'repo-autopilot-chat'});
  const repo=repository.toLowerCase(),key=number?`pull:${repo}:${number}:${updated}`:`overview:${repo}${pullLimit===DASHBOARD_PULLS&&runLimit===DASHBOARD_RUNS?'':`:${pullLimit}:${runLimit}`}`;
  const cached=fresh?null:await store.getCache(key);
  if(cached?.refused) throw new UserError(cached.refused.status,cached.refused.message);
  if(cached||cachedOnly) return cached;
  const load=await store.startDashboardLoad(repository);
  let value,changed=false;
  try {
    if(number) {
      const {item,warnings,changed:moved}=await client.pullDetails(repository,await client.pull(repository,number));
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
  if(!changed) await store.setDashboardCache(key,value,value.detailError?ERROR_CACHE_MS:number&&value.state!=='open'&&value.unresolvedThreads!==null?CLOSED_CACHE_MS:OPEN_CACHE_MS,{repository,...load,pull:number?{number,sha:value.headSha}:null});
  return value;
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

// The pull request description: what the owner asked for, the agent's explanation and what changes.
export function pullDescription({request,explanation,changes,sha}) {
  const quote=text=>text.trim().slice(0,1500).split('\n').map(line=>`> ${line}`).join('\n');
  // Line counts come from GitHub's diff; without them the files are still listed.
  const file=({path,added,removed,created})=>`- \`${path}\`${created?' (new file)':''}${Number.isInteger(added)&&Number.isInteger(removed)?`: +${added} −${removed} line${added+removed===1?'':'s'}`:''}`;
  return [
    request.trim()?`## Request\n\n${quote(request)}`:'',
    explanation.trim()?`## What the agent changed\n\n${explanation.trim().slice(0,3000)}`:'',
    `## Files\n\n${changes.map(file).join('\n')}`,
    `---\nCreated from the Repo Autopilot chat on ${sha.slice(0,10)}. Agent-generated: review the diff and CI before merging.`,
  ].filter(Boolean).join('\n\n');
}

// Asks Codex on the pull request to review the current code. The comment is posted with the owner's
// GitHub account, at most once per head commit, and only while Codex's state for the head shown still
// calls for it.
const CODEX_REQUESTS={
  // A review is asked for only when there is no review evidence at all for the current commit.
  review:{comment:'@codex review',wanted:state=>({findings:'Codex already reviewed the current code and has findings.',clear:'Codex already cleared the current code.',running:'Codex is reviewing the current code.',requested:'A Codex review was already requested.',incomplete:'its Codex history is too long to check here; request a review on GitHub if needed.'})[state]||''},
};
async function askCodex(kind,body,{store,github,access}) {
  const request=CODEX_REQUESTS[kind];
  if(typeof body.repository!=='string'||!Number.isSafeInteger(body.number)||body.number<1) throw new UserError(400,'Invalid request.');
  if(typeof body.sha!=='string'||!/^[0-9a-f]{40}$/.test(body.sha)) throw new UserError(400,'Reload the pull request status first.');
  const repository=await resolveRepository(body.repository,access),number=body.number,client=github(repository);
  let pull;
  try {pull=await client.api(`pulls/${number}`);}
  catch(error) {if(error instanceof GitHubError&&error.status===404) throw new UserError(404,`PR #${number} was not found.`);throw error;}
  if(pull.state!=='open'||pull.merged) throw new UserError(409,`PR #${number} is no longer open.`);
  if(pull.head?.sha!==body.sha) {await store.invalidate(repository,{pulls:[number]});throw new UserError(409,`PR #${number} has new commits since its status was shown. Check it again.`);}
  // A request already made for this commit is answered as such first: once posted, the comment itself
  // changes Codex's state (to requested, for a review), so a retry after a lost response is no error.
  if(await store.hasCodexRequest(kind,repository,number,body.sha)) return json(200,{asked:true,already:true});
  // Codex's state may have changed since the dashboard showed it.
  const status=createGitHub({token:access.session.token,fetchImpl:access.fetchImpl,userAgent:'repo-autopilot-chat'});
  const {item}=await status.pullDetails(repository,pull);
  if(item.detailError) throw new UserError(409,`Could not check PR #${number}'s current Codex status: ${item.detailError} Try again.`);
  if(item.state!=='open') {await store.invalidate(repository,{overview:true,pulls:[number]});throw new UserError(409,`PR #${number} is no longer open.`);}
  if(item.headSha!==body.sha) {await store.invalidate(repository,{pulls:[number]});throw new UserError(409,`PR #${number} has new commits since its status was shown. Check it again.`);}
  const unwanted=request.wanted(item.codex?.state);
  if(unwanted) {await store.invalidate(repository,{pulls:[number]});throw new UserError(409,`PR #${number}: ${unwanted}`);}
  // The comment applies to the whole pull request, so its head is read once more right before claiming
  // and posting: a push during the status check must not get a request recorded for the older commit.
  const latest=await client.api(`pulls/${number}`);
  if(latest.state!=='open'||latest.merged) {await store.invalidate(repository,{overview:true,pulls:[number]});throw new UserError(409,`PR #${number} is no longer open.`);}
  if(latest.head?.sha!==body.sha) {await store.invalidate(repository,{pulls:[number]});throw new UserError(409,`PR #${number} has new commits since its status was shown. Check it again.`);}
  // Asking again for the same commit is not an error: the button then shows that Codex was asked.
  if(!await store.claimCodexRequest(kind,repository,number,body.sha)) return json(200,{asked:true,already:true});
  try {await client.api(`issues/${number}/comments`,{method:'POST',body:{body:request.comment}});}
  catch(error) {
    // Only a refusal from GitHub proves no comment was posted; after a timeout or a server error the
    // comment may exist, so the claim stays and nothing is posted twice.
    if(error instanceof GitHubError&&error.status>=400&&error.status<500) await store.releaseCodexRequest(kind,repository,number,body.sha);
    if(error instanceof GitHubError&&[403,404].includes(error.status)) throw new UserError(403,`GitHub refused the comment on PR #${number} (HTTP ${error.status}). Check that the GitHub App has Pull requests set to Read and write.`);
    throw error;
  }
  await store.invalidate(repository,{pulls:[number]});
  return json(200,{asked:true});
}

// Merges a pull request from the dashboard, exactly at the head commit the owner saw checked, once Codex
// has cleared that commit.
// GitHub still enforces branch protection, required checks and reviews.
async function mergePullRequest(body,{store,github,access}) {
  if(typeof body.repository!=='string'||!Number.isSafeInteger(body.number)||body.number<1) throw new UserError(400,'Invalid request.');
  // The head commit whose status the owner saw is required: nothing else is ever merged.
  if(typeof body.sha!=='string'||!/^[0-9a-f]{40}$/.test(body.sha)) throw new UserError(400,'Reload the pull request status before merging.');
  const repository=await resolveRepository(body.repository,access),number=body.number;
  const lock=randomHex(16);
  if(!await store.acquireLock('merge',lock,60000)) throw new UserError(429,'A merge is already in progress. Wait a moment.');
  try {
    // Every refusal drops the dashboard's cached status for this pull request, so the reload that
    // follows it shows the current state instead of the one that was refused.
    const refuse=async message=>{await store.invalidate(repository,{pulls:[number]});throw new UserError(409,message);};
    const client=github(repository);
    let pull;
    try {pull=await client.api(`pulls/${number}`);}
    catch(error) {if(error instanceof GitHubError&&error.status===404) throw new UserError(404,`PR #${number} was not found.`);throw error;}
    if(pull.merged) {await store.invalidate(repository,{overview:true,pulls:[number]});return json(200,{merged:true});}
    if(pull.state!=='open') await refuse(`PR #${number} is closed.`);
    // The dashboard promises a merge into the default branch; a retargeted pull request is merged on GitHub.
    const {default_branch:defaultBranch}=await client.api('');
    if(pull.base?.ref!==defaultBranch) await refuse(`PR #${number} now targets ${pull.base?.ref||'another branch'} instead of the default branch ${defaultBranch}. Merge it on GitHub if that is intended.`);
    if(body.sha!==pull.head?.sha) await refuse(`PR #${number} has new commits since its status was shown. Check it again before merging.`);
    // Blockers can appear without a new commit (failed CI, Codex findings, requested changes), so the
    // readiness the dashboard shows is computed again here and enforced, not only in the browser. It fails
    // closed: a status that cannot be read, or unverified items the owner did not confirm, refuse the merge.
    const status=createGitHub({token:access.session.token,fetchImpl:access.fetchImpl,userAgent:'repo-autopilot-chat'});
    const {item}=await status.pullDetails(repository,pull);
    // GitHub's merge call guards the head but not the base, so the pull request and the default branch
    // are read once more after all the checks above: a retarget or a new default branch is caught here.
    const [{default_branch:currentDefault},latest]=await Promise.all([client.api(''),client.api(`pulls/${number}`)]);
    for(const base of [item.baseRef,latest.base?.ref]) if(base!==currentDefault) await refuse(`PR #${number} now targets ${base||'another branch'} instead of the default branch ${currentDefault}. Merge it on GitHub if that is intended.`);
    if(latest.state!=='open'||latest.merged) await refuse(`PR #${number} is no longer open.`);
    if(item.headSha!==body.sha||latest.head?.sha!==body.sha) await refuse(`PR #${number} has new commits since its status was shown. Check it again before merging.`);
    if(item.detailError) await refuse(`Could not check PR #${number}'s current status: ${item.detailError} Try again.`);
    // The dashboard offers merging only once Codex has cleared the current code; so does the server.
    if(item.codex?.state!=='clear') await refuse(`PR #${number} has no Codex 👍 for its current code yet.`);
    if(item.readiness.state==='not_ready') await refuse(`PR #${number} is not ready to merge: ${item.readiness.reasons.join('; ')}.`);
    const confirmed=Array.isArray(body.confirmed)?body.confirmed:[];
    const unconfirmed=item.readiness.state==='ready'?[]:item.readiness.reasons.filter(reason=>!confirmed.includes(reason));
    if(unconfirmed.length) await refuse(`PR #${number}'s status changed: ${unconfirmed.join('; ')}. Check it again before merging.`);
    try {await client.api(`pulls/${number}/merge`,{method:'PUT',body:{sha:body.sha,merge_method:'squash',commit_title:`${pull.title} (#${number})`}});}
    catch(error) {
      if(!(error instanceof GitHubError)) throw error;
      if(error.status===405) await refuse(`GitHub cannot merge PR #${number} yet: required checks, reviews or branch rules are not satisfied, or it has conflicts.`);
      if(error.status===409) await refuse(`PR #${number} changed while merging. Check it again.`);
      if([403,404].includes(error.status)) throw new UserError(403,`GitHub refused to merge PR #${number} (HTTP ${error.status}). Check that the GitHub App has Contents and Pull requests set to Read and write.`);
      throw error;
    }
    // The branch of a pull request opened from the chat is removed once merged; other pull requests keep
    // theirs, and failures leave it for GitHub's own cleanup.
    const ref=pull.head?.ref;
    if(typeof ref==='string'&&ref.startsWith('autopilot/chat-')&&pull.head?.repo?.full_name?.toLowerCase()===repository.toLowerCase()&&await store.isChatPullRequest(`https://github.com/${repository}/pull/${number}`)) {
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
    // GitHub counts the changed lines of the new commit exactly as its diff shows them.
    const description=async commit=>{
      let counted=new Map();
      try {counted=new Map(((await client.api(`compare/${head.sha}...${commit}`)).files||[]).map(f=>[f.filename,f]));} catch {}
      const changes=files.map(f=>{const count=counted.get(f.path);return {path:f.path,created:originals[f.path]===undefined,added:count?.additions,removed:count?.deletions};});
      return pullDescription({request,explanation:displayText(message.content),changes,sha:head.sha});
    };
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
