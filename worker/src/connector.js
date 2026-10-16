// The Claude/ChatGPT connector: a small OAuth 2.1 authorization server and a read-only MCP endpoint.
//
// A chat app registers itself (dynamic client registration), sends the owner to /oauth/authorize, where
// the owner allows it and signs in with GitHub, and then trades the code for tokens. The GitHub tokens
// from that sign-in, including the refresh token, are kept sealed in the app's grant, so the connector
// keeps working until the owner revokes it in the dashboard. The tools only read.
import {hex,randomHex,base64url,sha256,seal,unseal,sealState} from './crypto.js';
import {readLimited} from './github.js';

const HOUR=3600000,DAY=24*HOUR;
export const ACCESS_MS=HOUR,CODE_MS=60000,PENDING_MS=600000,NO_EXPIRY_MS=180*DAY;
export const MCP_PROTOCOLS=['2025-11-25','2025-06-18','2025-03-26'];
// offline_access is advertised because clients such as ChatGPT ask for it before relying on refresh
// tokens; every connection gets one either way.
const SCOPES=['read','offline_access'];
const GRANT='github-grant',CONSENT='connector-consent',MAX_FORM=16384,MAX_MCP=65536;

export const isConnectorPath=path=>path==='/mcp'||path.startsWith('/oauth/')||path.startsWith('/.well-known/oauth-');

const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Access-Control-Expose-Headers':'WWW-Authenticate, Mcp-Session-Id'};
const json=(status,value,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...CORS,...headers}});
const oauthError=(status,error,description)=>json(status,{error,error_description:description});
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const cookieValue=(request,name)=>{for(const part of (request.headers.get('Cookie')||'').split(';')) {const i=part.indexOf('=');if(i>0&&part.slice(0,i).trim()===name) return part.slice(i+1).trim();}return null;};
const tokenHash=async value=>hex(await sha256(value));

// Redirect addresses must be https, or http on the local machine (for desktop clients such as Claude Code).
export function validRedirect(value) {
  if(typeof value!=='string'||value.length>500) return false;
  let url;try {url=new URL(value);} catch {return false;}
  if(url.hash||url.username||url.password) return false;
  if(url.protocol==='https:') return true;
  return url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
}

async function readBody(request,limit) {
  if(Number(request.headers.get('Content-Length')||0)>limit||!request.body) return request.body?null:'';
  try {return new TextDecoder().decode(await readLimited(request.body,limit));} catch {return null;}
}
async function readParams(request) {
  const text=await readBody(request,MAX_FORM);
  if(text===null) return null;
  if((request.headers.get('Content-Type')||'').startsWith('application/json')) {
    try {const value=JSON.parse(text);return value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typeof v==='string'?v:JSON.stringify(v)])):null;} catch {return null;}
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export function resourceMetadata(origin) {
  return {resource:`${origin}/mcp`,authorization_servers:[origin],bearer_methods_supported:['header'],scopes_supported:SCOPES,resource_name:'Repo Autopilot'};
}
export function serverMetadata(origin) {
  return {issuer:origin,authorization_endpoint:`${origin}/oauth/authorize`,token_endpoint:`${origin}/oauth/token`,registration_endpoint:`${origin}/oauth/register`,response_types_supported:['code'],response_modes_supported:['query'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:SCOPES,authorization_response_iss_parameter_supported:true};
}

// The authorization request, checked in full before anything is shown. Problems with the client or its
// redirect address are shown on the page; once the redirect address is trusted, they go back to it.
async function authorizationRequest(params,{store,origin}) {
  const client=params.client_id?await store.getClient(params.client_id):null;
  if(!client) return {page:'This app is not registered with Repo Autopilot. Remove the connector and add it again.'};
  const redirectUri=params.redirect_uri;
  if(!redirectUri||!client.redirectUris.includes(redirectUri)) return {page:'This app asked to return to an address it did not register. Remove the connector and add it again.'};
  const back=(error,description)=>({redirectUri,error,description,state:params.state});
  if(params.response_type!=='code') return back('unsupported_response_type','Only the authorization code flow is supported.');
  if(params.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge||'')) return back('invalid_request','A PKCE S256 code challenge is required.');
  if(params.resource&&params.resource.replace(/\/$/,'')!==`${origin}/mcp`) return back('invalid_target','This server only issues tokens for its /mcp endpoint.');
  if(params.state&&params.state.length>1000) return back('invalid_request','The state is too long.');
  return {client,request:{clientId:client.id,redirectUri,challenge:params.code_challenge,state:params.state||null}};
}
function redirectBack({redirectUri,state},params,origin) {
  const target=new URL(redirectUri);
  for(const [k,v] of Object.entries(params)) target.searchParams.set(k,v);
  if(state) target.searchParams.set('state',state);
  target.searchParams.set('iss',origin);
  return new Response(null,{status:303,headers:{Location:target.href,'Cache-Control':'no-store'}});
}

function page(title,body,{csp,cookie}={}) {
  const headers=new Headers({'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  if(csp) headers.set('Content-Security-Policy',csp);
  if(cookie) headers.append('Set-Cookie',cookie);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><link rel="stylesheet" href="/dashboard.css"><link rel="stylesheet" href="/chat.css"></head><body><main class="connect"><header><span class="eyebrow">REPO AUTOPILOT</span><h1>${escape(title)}</h1></header>${body}</main></body></html>`,{status:200,headers});
}
const errorPage=message=>{const response=page('Cannot connect',`<p>${escape(message)}</p>`);return new Response(response.body,{status:400,headers:response.headers});};

// The consent page. Its form carries the sealed request and a value that must match a cookie set with
// it, so another site cannot submit it on the owner's behalf: the cookie is not sent on cross-site posts.
async function showConsent(params,{store,env,origin,secure,now}) {
  const checked=await authorizationRequest(params,{store,origin});
  if(checked.page) return errorPage(checked.page);
  if(checked.error) return redirectBack(checked,{error:checked.error,error_description:checked.description},origin);
  const consent=randomHex(16);
  const sealed=await seal(env.GITHUB_CLIENT_SECRET,CONSENT,{...checked.request,consent,expires:now()+PENDING_MS});
  const host=new URL(checked.request.redirectUri).host;
  const body=`<p>The app <strong>${escape(checked.client.name)}</strong> wants to read your Repo Autopilot status. Afterwards you return to <strong>${escape(host)}</strong>.</p>
<p>It will be able to read pull requests, CI, Codex reviews and findings in the repositories where the Repo Autopilot GitHub App is installed. It cannot change, comment on or merge anything.</p>
<p class="muted">Next you sign in with GitHub. The app stays connected until you revoke it under <strong>Connected apps</strong> in the dashboard.</p>
<form method="post" action="/oauth/authorize" class="actions"><input type="hidden" name="request" value="${escape(sealed)}"><input type="hidden" name="consent" value="${consent}"><button name="decision" value="allow">Allow and sign in with GitHub</button><button name="decision" value="deny" class="secondary">Deny</button></form>`;
  const redirectOrigin=new URL(checked.request.redirectUri).origin;
  const csp=`default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com ${redirectOrigin}`;
  return page(`Connect ${checked.client.name}?`,body,{csp,cookie:`autopilot_consent=${consent}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=600${secure?'; Secure':''}`});
}

async function decideConsent(request,{store,env,origin,secure,now}) {
  if(request.headers.get('Origin')!==origin) return errorPage('The request could not be verified. Start connecting again from the app.');
  const form=await readParams(request);
  const sealed=form&&await unseal(env.GITHUB_CLIENT_SECRET,CONSENT,form.request);
  if(!sealed||sealed.expires<=now()||!form.consent||form.consent!==sealed.consent||cookieValue(request,'autopilot_consent')!==sealed.consent) return errorPage('This page has expired. Start connecting again from the app.');
  const client=await store.getClient(sealed.clientId);
  if(!client||!client.redirectUris.includes(sealed.redirectUri)) return errorPage('This app is no longer registered. Remove the connector and add it again.');
  const clear=`autopilot_consent=; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=0${secure?'; Secure':''}`;
  if(form.decision!=='allow') {
    const response=redirectBack(sealed,{error:'access_denied',error_description:'The owner denied access.'},origin);
    response.headers.append('Set-Cookie',clear);return response;
  }
  // Allowed: sign in with GitHub, like the dashboard does, and finish in the sign-in callback.
  const pending=randomHex(16);
  await store.putPending(pending,{clientId:sealed.clientId,redirectUri:sealed.redirectUri,challenge:sealed.challenge,state:sealed.state},PENDING_MS);
  const browser=randomHex(),verifier=randomHex();
  const state=await sealState(env.GITHUB_CLIENT_SECRET,{browser,verifier,connect:pending,expires:now()+PENDING_MS});
  const target=new URL('https://github.com/login/oauth/authorize');
  for(const [k,v] of Object.entries({client_id:env.GITHUB_CLIENT_ID,redirect_uri:`${origin}/auth/callback`,state,code_challenge:base64url(await sha256(verifier)),code_challenge_method:'S256'})) target.searchParams.set(k,v);
  const headers=new Headers({Location:target.href,'Cache-Control':'no-store'});
  headers.append('Set-Cookie',clear);
  headers.append('Set-Cookie',`autopilot_login=${browser}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure?'; Secure':''}`);
  return new Response(null,{status:303,headers});
}

// Called by the sign-in callback when a connection's GitHub sign-in fails or is cancelled: the app gets the
// error at its own redirect address instead of waiting. Returns null when nothing is pending any more.
export async function failConnect({pending,reason,store,origin}) {
  const request=await store.takePending(pending);
  if(!request) return null;
  const error=reason==='cancelled'?'access_denied':reason==='owner'||reason==='app'?'access_denied':'server_error';
  const description={cancelled:'The GitHub sign-in was cancelled.',owner:'Only the owner of this Repo Autopilot can connect apps.',app:'The GitHub sign-in did not use the Repo Autopilot GitHub App.'}[reason]||'The GitHub sign-in failed. Try connecting again.';
  return redirectBack(request,{error,error_description:description},origin);
}

// Called by the sign-in callback once GitHub confirmed the owner: the app is connected and gets its code.
export async function finishConnect({pending,token,login,store,env,origin,now}) {
  const request=await store.takePending(pending);
  if(!request) return null;
  const at=now(),seconds=value=>Number.isFinite(value)&&value>0?value*1000:null;
  const github={access:token.access_token,accessExpires:seconds(token.expires_in)&&at+seconds(token.expires_in),refresh:token.refresh_token||null,refreshExpires:token.refresh_token&&seconds(token.refresh_token_expires_in)?at+seconds(token.refresh_token_expires_in):null};
  // The grant lasts as long as GitHub lets its tokens be renewed.
  const expires=github.refresh?(github.refreshExpires||at+NO_EXPIRY_MS):(github.accessExpires||at+NO_EXPIRY_MS);
  const grantId=randomHex(16),code=randomHex();
  await store.createGrant({id:grantId,clientId:request.clientId,login,github:await seal(env.GITHUB_CLIENT_SECRET,GRANT,github),expires});
  await store.putToken({hash:await tokenHash(code),grantId,kind:'code',data:{clientId:request.clientId,redirectUri:request.redirectUri,challenge:request.challenge},expires:at+CODE_MS});
  return redirectBack(request,{code},origin);
}

async function register(request,{store}) {
  const params=await readParams(request);
  if(!params) return oauthError(400,'invalid_client_metadata','Send the client metadata as JSON.');
  let redirectUris;try {redirectUris=JSON.parse(params.redirect_uris||'null');} catch {redirectUris=null;}
  if(!Array.isArray(redirectUris)||!redirectUris.length||redirectUris.length>5||!redirectUris.every(validRedirect)) return oauthError(400,'invalid_redirect_uri','Give 1 to 5 redirect addresses, each https or http on localhost.');
  if(params.token_endpoint_auth_method&&params.token_endpoint_auth_method!=='none') return oauthError(400,'invalid_client_metadata','Only public clients (token_endpoint_auth_method "none") are supported.');
  const name=(params.client_name||'').replace(/[\u0000-\u001f]/g,'').trim().slice(0,80)||'MCP client';
  const id=randomHex(16);
  await store.registerClient({id,name,redirectUris});
  return json(201,{client_id:id,client_id_issued_at:Math.floor(Date.now()/1000),client_name:name,redirect_uris:redirectUris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
}

async function issueTokens(grant,clientId,{store,now}) {
  const access=randomHex(),refresh=randomHex(),at=now();
  await store.putToken({hash:await tokenHash(access),grantId:grant.id,kind:'access',expires:at+ACCESS_MS});
  // The app's refresh token lasts as long as the grant, so an app unused for months still reconnects.
  await store.putToken({hash:await tokenHash(refresh),grantId:grant.id,kind:'refresh',data:{clientId},expires:grant.expires});
  return json(200,{access_token:access,token_type:'Bearer',expires_in:ACCESS_MS/1000,refresh_token:refresh,scope:SCOPES.join(' ')});
}
async function token(request,{store,now}) {
  const params=await readParams(request);
  if(!params) return oauthError(400,'invalid_request','Send the token request as a form.');
  if(params.grant_type==='authorization_code') {
    if(!params.code||!params.code_verifier||!/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier)) return oauthError(400,'invalid_request','The code and its PKCE verifier are required.');
    // The code is checked first and only then used up, so a wrong attempt cannot burn the app's code.
    const hash=await tokenHash(params.code),code=await store.getToken(hash,'code');
    if(!code||code.data.clientId!==params.client_id||code.data.redirectUri!==params.redirect_uri) return oauthError(400,'invalid_grant','The code is invalid, expired or already used.');
    if(base64url(await sha256(params.code_verifier))!==code.data.challenge) return oauthError(400,'invalid_grant','The PKCE verifier does not match.');
    if(!await store.takeToken(hash,'code')) return oauthError(400,'invalid_grant','The code is invalid, expired or already used.');
    const grant=await store.getGrant(code.grantId);
    if(!grant) return oauthError(400,'invalid_grant','The connection was revoked.');
    return issueTokens(grant,params.client_id,{store,now});
  }
  if(params.grant_type==='refresh_token') {
    // Checked before it is used up, so a request with the wrong client cannot burn the app's token.
    const hash=params.refresh_token?await tokenHash(params.refresh_token):null;
    const old=hash&&await store.getToken(hash,'refresh');
    if(!old||(params.client_id&&old.data.clientId!==params.client_id)) return oauthError(400,'invalid_grant','The refresh token is invalid or expired. Connect again.');
    if(!await store.takeToken(hash,'refresh')) return oauthError(400,'invalid_grant','The refresh token was already used. Connect again.');
    const grant=await store.getGrant(old.grantId);
    if(!grant) return oauthError(400,'invalid_grant','The connection was revoked. Connect again.');
    return issueTokens(grant,old.data.clientId,{store,now});
  }
  return oauthError(400,'unsupported_grant_type','Use authorization_code or refresh_token.');
}

// The GitHub token of a connected app, renewed with GitHub when it is about to expire. Returns null when
// GitHub no longer accepts the grant, which is then removed so the app asks the owner to connect again,
// and undefined when it cannot be renewed right now.
//
// GitHub invalidates a refresh token once it is used, so renewals of one grant are serialized with a lock:
// a request that finds another one renewing waits for it and uses the tokens it stored.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function githubToken(grant,{store,env,fetchImpl,now}) {
  const open=async value=>unseal(env.GITHUB_CLIENT_SECRET,GRANT,value);
  const usable=github=>github?.access&&(!github.accessExpires||github.accessExpires-60000>now());
  let github=await open(grant.github);
  if(!github?.access) {await store.deleteGrant(grant.id);return null;}
  if(usable(github)) return github.access;
  // One store call per second while waiting keeps a request well within the Workers subrequest limit.
  const lock=`grant-renewal:${grant.id}`,owner=randomHex(8);
  for(let attempt=0;;attempt++) {
    const {locked,grant:latest}=await store.tryRenewal(grant.id,owner,30000);
    if(locked) break;
    if(!latest) return null;
    if(latest.github!==grant.github) {const renewed=await open(latest.github);if(usable(renewed)) return renewed.access;}
    if(attempt>=10) return undefined;
    await sleep(1000);
  }
  try {
    // Read the grant again under the lock: another request may have renewed it meanwhile.
    const latest=await store.getGrant(grant.id);
    if(!latest) return null;
    github=await open(latest.github);
    if(!github?.access) {await store.deleteGrant(grant.id);return null;}
    if(usable(github)) return github.access;
    if(!github.refresh||(github.refreshExpires&&github.refreshExpires<=now())) {await store.deleteGrant(grant.id);return null;}
    let renewed;
    try {
      const response=await fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',redirect:'manual',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'repo-autopilot-chat'},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:github.refresh}),signal:AbortSignal.timeout(20000)});
      if(!response.ok) return undefined;
      renewed=await response.json();
    } catch {return undefined;}
    if(!renewed?.access_token) {
      // GitHub answers an unusable refresh token with an error: the grant cannot be renewed any more.
      if(renewed?.error) {await store.deleteGrant(grant.id);return null;}
      return undefined;
    }
    const at=now(),seconds=value=>Number.isFinite(value)&&value>0?value*1000:null;
    const next={access:renewed.access_token,accessExpires:seconds(renewed.expires_in)&&at+seconds(renewed.expires_in),refresh:renewed.refresh_token||github.refresh,refreshExpires:seconds(renewed.refresh_token_expires_in)?at+seconds(renewed.refresh_token_expires_in):github.refreshExpires};
    if(!await store.replaceGrantGithub(grant.id,latest.github,await seal(env.GITHUB_CLIENT_SECRET,GRANT,next),next.refreshExpires||latest.expires)) return undefined;
    return next.access;
  } finally {await store.releaseLock(lock,owner);}
}

const rpcResult=(id,result)=>json(200,{jsonrpc:'2.0',id,result});
const rpcError=(id,code,message)=>json(200,{jsonrpc:'2.0',id,error:{code,message}});
const unauthorized=(origin,invalid)=>json(401,{error:invalid?'invalid_token':'unauthorized',error_description:'Connect Repo Autopilot again.'},{'WWW-Authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"${invalid?', error="invalid_token"':''}`});

async function mcp(request,{store,env,origin,fetchImpl,now,tools}) {
  if(request.method!=='POST') return json(405,{error:'Use POST.'},{Allow:'POST, OPTIONS'});
  const bearer=/^Bearer\s+([0-9a-f]{64})$/i.exec(request.headers.get('Authorization')||'')?.[1];
  if(!bearer) return unauthorized(origin,Boolean(request.headers.get('Authorization')));
  const access=await store.getToken(await tokenHash(bearer.toLowerCase()),'access');
  const grant=access&&await store.getGrant(access.grantId);
  if(!grant) return unauthorized(origin,true);
  const text=await readBody(request,MAX_MCP);
  let message;try {message=JSON.parse(text);} catch {return json(400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error.'}});}
  if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string') return json(400,{jsonrpc:'2.0',id:null,error:{code:-32600,message:'Send one JSON-RPC 2.0 request.'}});
  // Notifications and responses need no answer.
  if(!('id' in message)) return new Response(null,{status:202,headers:CORS});
  const {id,method,params={}}=message;
  await store.touchGrant(grant.id);
  if(method==='initialize') {
    const requested=params?.protocolVersion;
    return rpcResult(id,{protocolVersion:MCP_PROTOCOLS.includes(requested)?requested:MCP_PROTOCOLS[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:'repo-autopilot',title:'Repo Autopilot',version:'0.2.0'},instructions:'Read-only access to the owner\'s Repo Autopilot. For now it lists the repositories Repo Autopilot can read. Nothing can be changed through these tools; merging happens in the Repo Autopilot dashboard.'});
  }
  if(method==='ping') return rpcResult(id,{});
  if(method==='tools/list') return rpcResult(id,{tools:tools.map(({run,...tool})=>tool)});
  if(method==='tools/call') {
    const tool=tools.find(t=>t.name===params?.name);
    if(!tool) return rpcError(id,-32602,`Unknown tool: ${params?.name}`);
    const token=await githubToken(grant,{store,env,fetchImpl,now});
    if(token===null) return unauthorized(origin,true);
    if(token===undefined) return rpcResult(id,{isError:true,content:[{type:'text',text:'GitHub could not renew the sign-in just now. Try again in a minute.'}]});
    try {return rpcResult(id,await tool.run(params.arguments||{},{token,grantId:grant.id}));}
    catch(error) {
      if(error?.status===401) {await store.deleteGrant(grant.id);return unauthorized(origin,true);}
      return rpcResult(id,{isError:true,content:[{type:'text',text:error?.expose?error.message:'Reading from GitHub failed. Try again.'}]});
    }
  }
  return rpcError(id,-32601,`Method not found: ${method}`);
}

// Routes the connector's paths. Returns null for paths it does not own.
export async function connector(request,url,context) {
  const {origin}=context;
  if(request.method==='OPTIONS') return new Response(null,{status:204,headers:{...CORS,'Access-Control-Max-Age':'86400'}});
  if(url.pathname==='/.well-known/oauth-protected-resource'||url.pathname==='/.well-known/oauth-protected-resource/mcp') return json(200,resourceMetadata(origin));
  if(url.pathname==='/.well-known/oauth-authorization-server') return json(200,serverMetadata(origin));
  if(url.pathname==='/oauth/register'&&request.method==='POST') return register(request,context);
  if(url.pathname==='/oauth/token'&&request.method==='POST') return token(request,context);
  if(url.pathname==='/oauth/authorize'&&request.method==='GET') return showConsent(Object.fromEntries(url.searchParams),context);
  if(url.pathname==='/oauth/authorize'&&request.method==='POST') return decideConsent(request,context);
  if(url.pathname==='/mcp') return mcp(request,context);
  return json(404,{error:'Not found.'});
}
