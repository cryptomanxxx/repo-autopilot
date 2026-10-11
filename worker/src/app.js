import {githubClient,GitHubError,readLimited} from './github.js';
import {textFiles,selectContext,buildMessages,answer,applyEdits,displayText,DEFAULT_CONTEXT_CHARS,DEFAULT_MODEL} from './agent.js';

const encoder=new TextEncoder();
const HOUR=3600000,MAX_TEXT=8000,MAX_IMAGE_CHARS=1500000,MAX_BODY=1600000;
const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const randomHex=(bytes=32)=>hex(crypto.getRandomValues(new Uint8Array(bytes)));
const base64url=bytes=>{let s='';for(const b of bytes) s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
const fromBase64url=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const sha256=async text=>new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)));

// Errors whose message is written for the owner and safe to show in the chat.
export class UserError extends Error {constructor(status,message) {super(message);this.status=status;}}

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
  const url=new URL(request.url);
  if(!env.REPOSITORY||!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.REPOSITORY)||!env.GITHUB_CLIENT_ID||!env.GITHUB_CLIENT_SECRET) return {error:'The chat is not configured yet: set REPOSITORY, GITHUB_CLIENT_ID and the GITHUB_CLIENT_SECRET secret.'};
  const origin=env.CHAT_ORIGIN?new URL(env.CHAT_ORIGIN).origin:url.origin;
  return {origin,repository:env.REPOSITORY,owner:(env.AUTOPILOT_USER||env.REPOSITORY.split('/')[0]).toLowerCase(),secure:origin.startsWith('https:'),sameOrigin:url.origin===origin};
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

export async function handle(request,env,{fetchImpl=fetch,now=Date.now}={}) {
  const config=settings(env,request);
  const url=new URL(request.url);
  const secure=Boolean(config.secure);
  try {
    if(!url.pathname.startsWith('/api/')&&!url.pathname.startsWith('/auth/')) {
      if(!env.ASSETS) return withHeaders(new Response('Not found',{status:404}),secure);
      return withHeaders(await env.ASSETS.fetch(request),secure);
    }
    if(config.error) return withHeaders(json(503,{error:config.error}),secure);
    if(!config.sameOrigin) return withHeaders(json(404,{error:'Not found.'}),secure);
    return withHeaders(await route(request,env,config,url,{fetchImpl,now}),secure);
  } catch(error) {
    if(error instanceof UserError) return withHeaders(json(error.status,{error:error.message}),secure);
    console.error('chat request failed',error?.stack||error);
    // Plain Errors from this Worker carry messages written for the owner; anything else may be internal.
    const message=error?.constructor===Error||error instanceof GitHubError?error.message:'Request failed. Please try again.';
    return withHeaders(json(500,{error:message}),secure);
  }
}

async function route(request,env,config,url,{fetchImpl,now}) {
  const store=env.CHAT.get(env.CHAT.idFromName('main'));
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
    const pending=await openState(env.GITHUB_CLIENT_SECRET,url.searchParams.get('state'),now());
    const code=url.searchParams.get('code');
    if(!pending||pending.browser!==cookies(request).autopilot_login||!code) throw new UserError(403,'The sign-in expired or did not start in this browser. Sign in again.');
    const exchange=await fetchImpl('https://github.com/login/oauth/access_token',{method:'POST',redirect:'manual',headers:{Accept:'application/json','Content-Type':'application/json','User-Agent':'repo-autopilot-chat'},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:callback,code_verifier:pending.verifier}),signal:AbortSignal.timeout(20000)});
    const token=exchange.ok?await exchange.json():{};
    if(!token.access_token||token.error) throw new UserError(403,'GitHub sign-in failed. Try again.');
    // GitHub App user tokens (ghu_ prefix) carry no OAuth scopes and only reach repositories where
    // the app is installed, with the app's permissions. Anything else means an OAuth app was configured.
    if(!token.access_token.startsWith('ghu_')||token.scope) throw new UserError(403,'Use the client ID and secret of a GitHub App, not an OAuth app.');
    const userResponse=await fetchImpl('https://api.github.com/user',{redirect:'manual',headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'repo-autopilot-chat'},signal:AbortSignal.timeout(20000)});
    const user=userResponse.ok?await userResponse.json():{};
    if(typeof user.login!=='string'||user.login.toLowerCase()!==config.owner) throw new UserError(403,'Sign in with the repository owner account.');
    const id=randomHex(),lifetime=Number.isFinite(token.expires_in)&&token.expires_in>0?token.expires_in*1000:8*HOUR;
    await store.createSession({hash:hex(await sha256(id)),token:token.access_token,csrf:randomHex(),login:user.login,expires:now()+Math.min(lifetime,8*HOUR)});
    return redirect('/',[cookie(sessionCookie,id),cookie('autopilot_login','',{path:'/auth'})]);
  }

  const sessionId=cookies(request)[sessionCookie];
  const hash=sessionId&&/^[0-9a-f]{64}$/.test(sessionId)?hex(await sha256(sessionId)):null;
  const session=hash?await store.getSession(hash):null;
  if(request.method==='GET'&&url.pathname==='/api/session') return json(200,session?{login:session.login,csrf:session.csrf,repository:config.repository,model:env.MODEL||DEFAULT_MODEL}:{login:null,repository:config.repository});
  if(!session) throw new UserError(401,'Sign in to chat.');

  if(request.method==='GET'&&url.pathname==='/api/conversations') return json(200,{conversations:await store.listConversations()});
  const conversationPath=/^\/api\/conversations\/([0-9a-f]{32})$/.exec(url.pathname);
  if(request.method==='GET'&&conversationPath) {
    const conversation=await store.getConversation(conversationPath[1]);
    if(!conversation) throw new UserError(404,'Conversation not found.');
    return json(200,{...conversation,messages:conversation.messages.map(m=>({id:m.id,role:m.role,content:m.content,hasImage:m.hasImage,created:m.created,prUrl:m.prUrl,proposal:m.proposal?{title:m.proposal.title,paths:[...new Set(m.proposal.edits.map(e=>e.path))]}:null}))});
  }
  if(request.method!=='POST') throw new UserError(405,'Unsupported request.');
  if(request.headers.get('Origin')!==config.origin||request.headers.get('X-CSRF-Token')!==session.csrf) throw new UserError(403,'The request could not be verified. Reload the page.');
  if(url.pathname==='/api/logout') {
    await store.deleteSession(hash);
    return json(200,{ok:true},{'Set-Cookie':cookie(sessionCookie,'')});
  }
  const body=await readJson(request);
  const github=()=>githubClient({repository:config.repository,token:session.token,fetchImpl});
  const run=async work=>{
    try {return await work();}
    catch(error) {
      if(error instanceof GitHubError&&error.status===401) {await store.deleteSession(hash);throw new UserError(401,'Your GitHub sign-in has expired. Sign in again.');}
      throw error;
    }
  };
  if(url.pathname==='/api/chat') return run(()=>chat(body,{env,store,github,config,fetchImpl}));
  if(url.pathname==='/api/pull-request') return run(()=>pullRequest(body,{store,github}));
  throw new UserError(404,'Not found.');
}

async function chat(body,{env,store,github,config,fetchImpl}) {
  const text=typeof body.text==='string'?body.text.trim():'';
  if(!text||text.length>MAX_TEXT) throw new UserError(400,`Write a message between 1 and ${MAX_TEXT} characters.`);
  const image=validateImage(body.image);
  let conversation=null;
  if(body.conversation!==undefined&&body.conversation!==null) {
    if(typeof body.conversation!=='string'||!/^[0-9a-f]{32}$/.test(body.conversation)) throw new UserError(400,'Invalid conversation.');
    conversation=await store.getConversation(body.conversation);
    if(!conversation) throw new UserError(404,'Conversation not found.');
  }
  const lock=randomHex(16);
  if(!await store.acquireLock('model',lock,180000)) throw new UserError(429,'The agent is still answering another message. Wait until it has finished.');
  try {
    const client=github(),head=await client.head(),archive=await client.archive(head.sha),files=textFiles(archive);
    const history=conversation?.messages||[];
    const query=[...history.filter(m=>m.role==='user').slice(-2).map(m=>m.content),text].join('\n');
    const context=selectContext(files,query,Number(env.CONTEXT_CHARS)||DEFAULT_CONTEXT_CHARS);
    const messages=buildMessages({repository:config.repository,head,context,history,text,image});
    const result=await answer(env,{messages,files,existingPaths:[...archive.keys()],fetchImpl});
    const content=result.error?`${result.reply}\n\n⚠ The proposed change could not be applied: ${result.error} Ask the agent to try again.`:result.reply;
    const id=conversation?.id||randomHex(16);
    await store.saveExchange({conversation:id,title:conversation?null:text.replace(/\s+/g,' ').slice(0,80),user:{content:text,hasImage:Boolean(image)},assistant:{content,proposal:result.proposal?{...result.proposal,baseSha:head.sha}:null}});
    return json(200,{conversation:id});
  } finally {await store.releaseLock('model',lock);}
}

async function pullRequest(body,{store,github}) {
  if(typeof body.conversation!=='string'||!/^[0-9a-f]{32}$/.test(body.conversation)||!Number.isSafeInteger(body.message)||body.message<1) throw new UserError(400,'Invalid request.');
  const lock=randomHex(16);
  if(!await store.acquireLock('pull-request',lock,120000)) throw new UserError(429,'A pull request is already being created. Wait a moment.');
  try {
    const message=await store.getMessage(body.conversation,body.message);
    if(!message||message.role!=='assistant'||!message.proposal) throw new UserError(404,'This message has no proposed change.');
    if(message.prUrl) return json(200,{url:message.prUrl});
    const client=github(),head=await client.head(),archive=await client.archive(head.sha);
    let files;
    try {files=applyEdits(message.proposal.edits,textFiles(archive),[...archive.keys()]);}
    catch(error) {throw new UserError(409,`The change no longer applies to the current code: ${error.message} Ask the agent to redo it.`);}
    const conversation=await store.getConversation(body.conversation);
    const title=message.proposal.title||conversation.title;
    const description=`${displayText(message.content).slice(0,4000)}\n\n---\nCreated from the Repo Autopilot chat on ${head.sha.slice(0,10)}. Agent-generated: review the diff and CI before merging.`;
    let url;
    try {url=await client.createPullRequest({base:head.branch,parent:head.sha,files,branch:`autopilot/chat-${body.conversation.slice(0,8)}-${body.message}-${Date.now().toString(36)}`,title,body:description});}
    catch(error) {
      if(error instanceof GitHubError&&[403,404].includes(error.status)) throw new UserError(403,`GitHub refused to create the pull request (HTTP ${error.status}). Check that the GitHub App is installed on this repository with Contents and Pull requests set to Read and write.`);
      throw error;
    }
    await store.setPullRequest(body.conversation,body.message,url);
    return json(200,{url});
  } finally {await store.releaseLock('pull-request',lock);}
}
