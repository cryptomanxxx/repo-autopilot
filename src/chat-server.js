import http from 'node:http';
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createChat} from './chat.js';
import {collectTasks} from './tasks.js';
import {repositoryName} from './github.js';

const random=()=>randomBytes(32).toString('hex');
export function createChatServer({origin,repository,authorizedUser,clientId,clientSecret,groqKey,fetchImpl=fetch,now=Date.now}) {
  const base=new URL(origin),repo=repositoryName(repository),owner=(authorizedUser||repo.split('/')[0]).toLowerCase();
  if(base.pathname!=='/'||base.search||base.hash||base.username||base.password||!(base.protocol==='https:'||(base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname)))) throw new Error('Configure a public HTTPS CHAT_ORIGIN, or localhost for development.');
  if(!clientId||!clientSecret) throw new Error('Configure the GitHub App client ID and client secret.');
  const secure=base.protocol==='https:',sessions=new Map(),taskLocks=new Set(),stateKey=randomBytes(32);
  const encodeState=value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',stateKey,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64url');};
  const decodeState=value=>{try {if(typeof value!=='string'||value.length>1024) return null;const bytes=Buffer.from(value,'base64url');const cipher=createDecipheriv('aes-256-gcm',stateKey,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));const data=JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8'));return data.expires>now()?data:null;} catch {return null;}};
  const cookie=(name,value,path='/')=>`${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${value?28800:0}${secure?'; Secure':''}`;
  const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=')));
  const prune=map=>{for(const [id,item] of map) if(item.expires<=now()) map.delete(id);};
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  const redirect=(res,path)=>{res.writeHead(303,{Location:path});res.end();};
  const remote=async(url,options={})=>{
    const r=await fetchImpl(url,{...options,redirect:'error',signal:AbortSignal.timeout(20000)});
    if(!r.ok) throw new Error('GitHub authentication failed.');return r.json();
  };
  return http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if(secure) res.setHeader('Strict-Transport-Security','max-age=31536000');
    let session;
    try {
      const url=new URL(req.url,base);
      prune(sessions);
      session=sessions.get(cookies(req).autopilot_session);
      if(req.method==='GET'&&url.pathname==='/auth/login') {
        const browser=random(),verifier=random();
        const state=encodeState({browser,verifier,expires:now()+600000});
        const {createHash}=await import('node:crypto');
        res.setHeader('Set-Cookie',cookie('autopilot_login',browser,'/auth'));
        const target=new URL('https://github.com/login/oauth/authorize');
        for(const [k,v] of Object.entries({client_id:clientId,redirect_uri:base.origin+'/auth/callback',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'})) target.searchParams.set(k,v);
        return redirect(res,target.href);
      }
      if(req.method==='GET'&&url.pathname==='/auth/callback') {
        const pending=decodeState(url.searchParams.get('state'));
        if(!pending||pending.browser!==cookies(req).autopilot_login||!url.searchParams.get('code')) return json(res,403,{error:'Login expired or did not match this browser. Sign in again.'});
        const token=await remote('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({client_id:clientId,client_secret:clientSecret,code:url.searchParams.get('code'),redirect_uri:base.origin+'/auth/callback',code_verifier:pending.verifier})});
        if(!token.access_token||token.error) throw new Error('GitHub authentication failed.');
        // GitHub App user tokens carry no OAuth scopes: they can only act where the app is installed, with the
        // app's permissions. A non-empty scope means an OAuth app was configured, which could reach every repository.
        if(token.scope) return json(res,403,{error:'GitHub App credentials are required. Configure the GitHub App client ID and secret, not an OAuth app.'});
        const user=await remote('https://api.github.com/user',{headers:{Authorization:`Bearer ${token.access_token}`,Accept:'application/vnd.github+json','User-Agent':'repo-autopilot-chat/0.1'}});
        if(user.login?.toLowerCase()!==owner) return json(res,403,{error:'Sign in with the configured repository owner account.'});
        if(sessions.size>=100) return json(res,429,{error:'Please try again later.'});
        const tokenLifetime=Number.isFinite(token.expires_in)&&token.expires_in>0?token.expires_in*1000:28800000;
        const id=random();sessions.set(id,{token:token.access_token,csrf:random(),login:user.login,expires:now()+Math.min(28800000,tokenLifetime),lastSend:0,busy:false});
        res.setHeader('Set-Cookie',[cookie('autopilot_session',id),cookie('autopilot_login','','/auth')]);return redirect(res,'/');
      }
      if(req.method==='GET'&&url.pathname==='/api/session') return json(res,200,session?{login:session.login,csrf:session.csrf,repository:repo}:{login:null,repository:repo});
      if(url.pathname.startsWith('/api/')) {
        if(!session) return json(res,401,{error:'Sign in to chat.'});
        const chat=createChat({repository:repo,authorizedUser:owner,token:session.token,groqKey,fetchImpl});
        if(req.method==='GET'&&url.pathname==='/api/tasks') return json(res,200,await collectTasks(repo,{authorizedUser:owner,token:session.token,fetchImpl}));
        if(req.method==='GET'&&url.pathname==='/api/messages') return json(res,200,await chat.messages(Number(url.searchParams.get('number'))));
        if(req.method!=='POST') return json(res,405,{error:'Unsupported request.'});
        if(req.headers.origin!==base.origin||req.headers['x-csrf-token']!==session.csrf||!req.headers['content-type']?.startsWith('application/json')) return json(res,403,{error:'Request could not be verified.'});
        if(url.pathname==='/api/logout') {sessions.delete(cookies(req).autopilot_session);res.setHeader('Set-Cookie',cookie('autopilot_session',''));return json(res,200,{ok:true});}
        if(url.pathname!=='/api/send') return json(res,404,{error:'Not found.'});
        if(session.busy||(session.lastSend&&now()-session.lastSend<60000)) return json(res,429,{error:'Wait one minute before sending another message.'});
        session.busy=true;session.lastSend=now();
        try {
          let size=0;const chunks=[];
          for await(const chunk of req) {size+=chunk.length;if(size>2900000) throw new Error('Message is too large. Use an image smaller than 2 MB.');chunks.push(chunk);}
          const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const taskNumber=payload.number;
          if(taskNumber!==undefined&&taskNumber!==null&&(!Number.isSafeInteger(taskNumber)||taskNumber<1)) throw new Error('Invalid task number.');
          if(taskNumber&&taskLocks.has(taskNumber)) throw new Error('Wait for the agent: another session is sending to this task.');
          if(taskNumber) taskLocks.add(taskNumber);
          try {return json(res,200,await chat.send(payload));} finally {if(taskNumber) taskLocks.delete(taskNumber);}
        } finally {session.busy=false;}
      }
      const assets={'/':['chat.html','text/html'],'/chat.js':['chat.js','text/javascript'],'/style.css':['style.css','text/css']};
      const asset=assets[url.pathname];
      if(req.method!=='GET'||!asset) return json(res,404,{error:'Not found.'});
      const content=await readFile(new URL('../public/'+asset[0],import.meta.url));res.writeHead(200,{'Content-Type':asset[1]});res.end(content);
    } catch(error) {
      const safe=/^(Attach |Invalid |Write |Chat supports|This |Wait |Screenshot |GitHub |Message is too large)/.test(error.message)?error.message:'Request failed. Please try again.';
      json(res,400,{error:safe});
    }
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  createChatServer({origin:process.env.CHAT_ORIGIN,repository:process.env.GITHUB_REPOSITORY,authorizedUser:process.env.AUTOPILOT_TASK_USER,clientId:process.env.GITHUB_CLIENT_ID,clientSecret:process.env.GITHUB_CLIENT_SECRET,groqKey:process.env.GROQ_API_KEY}).listen(Number(process.env.PORT||3001),process.env.HOST||'127.0.0.1',()=>console.log('Repo Autopilot chat server started.'));
}
