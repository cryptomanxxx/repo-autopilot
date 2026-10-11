import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ChatStoreLogic} from '../worker/src/store.js';
import {readTar} from '../worker/src/github.js';
import {selectContext,parseEdits,applyEdits,buildMessages,answer,textFiles,displayText,readableFile,WORKER_SOURCES,callModel} from '../worker/src/agent.js';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {handle,validateImage} from '../worker/src/app.js';

// Adapter giving node:sqlite the Durable Object `sql.exec(query, ...bindings).toArray()` shape.
const sqlite=()=>{const db=new DatabaseSync(':memory:');return {exec:(query,...bindings)=>{const rows=db.prepare(query).all(...bindings);return {toArray:()=>rows};}};};

function tar(entries) {
  const blocks=[];
  const header=(name,size,type,mode='0000644')=>{
    const h=Buffer.alloc(512);
    h.write(name.slice(0,100),0);h.write(mode+'\0',100);h.write('0000000\0',108);h.write('0000000\0',116);
    h.write(size.toString(8).padStart(11,'0')+'\0',124);h.write('00000000000\0',136);h.write('        ',148);h.write(type,156);h.write('ustar\0',257);h.write('00',263);
    let sum=0;for(const b of h) sum+=b;h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);return h;
  };
  for(const entry of entries) {
    const data=Buffer.from(entry.content);
    blocks.push(header(entry.name,data.length,entry.type||'0',entry.mode),data,Buffer.alloc((512-data.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const pax=path=>{const body=` path=${path}\n`;let length=body.length+2;if(String(length).length+body.length!==length) length=String(length+1).length+body.length;return `${length}${body}`;};
const repoTar=(files,executable=[])=>tar([{name:'pax_global_header',type:'g',content:'52 comment=0123456789012345678901234567890123456789\n'},{name:'owner-repo-0123456/',type:'5',content:''},...Object.entries(files).map(([path,content])=>({name:`owner-repo-0123456/${path}`,content,mode:executable.includes(path)?'0000755':'0000644'}))]);

test('store keeps sessions, locks, exchanges and pull request links consistent',()=>{
  let time=1000;const store=new ChatStoreLogic(sqlite(),()=>time);
  store.createSession({hash:'h',token:'ghu_x',csrf:'c',login:'owner',expires:time+10*3600000});
  assert.equal(store.getSession('h').login,'owner');
  time+=8*3600000;assert.equal(store.getSession('h'),null,'sessions never outlive eight hours');
  assert.equal(store.acquireLock('model','a',100),true);assert.equal(store.acquireLock('model','b',100),false);
  time+=101;assert.equal(store.acquireLock('model','b',100),true,'expired locks are taken over');
  store.releaseLock('model','a');assert.equal(store.acquireLock('model','c',100),false,'a former holder cannot release the new lock');
  store.releaseLock('model','b');assert.equal(store.acquireLock('model','c',100),true);
  assert.throws(()=>store.saveExchange({conversation:'missing',title:null,user:{content:'a'},assistant:{content:'b'}}),/not found/);
  const ids=store.saveExchange({conversation:'c1',title:'First',user:{content:'Hi',hasImage:true},assistant:{content:'Hello',proposal:{edits:[{path:'a.js',search:'x',replace:'y'}]}}});
  const conversation=store.getConversation('c1');
  assert.deepEqual(conversation.messages.map(m=>[m.id,m.role,m.hasImage]),[[ids.user,'user',true],[ids.assistant,'assistant',false]]);
  store.setPullRequest('c1',ids.assistant,'https://github.com/o/r/pull/1');store.setPullRequest('c1',ids.assistant,'https://github.com/o/r/pull/2');
  assert.equal(store.getMessage('c1',ids.assistant).prUrl,'https://github.com/o/r/pull/1','the first pull request link is kept');
  assert.equal(store.getMessage('other',ids.assistant),null);
  assert.equal(store.listConversations()[0].title,'First');
  for(let i=0;i<20;i++) store.createSession({hash:`s${i}`,token:'t',csrf:'c',login:'o',expires:time+1000+i});
  store.createSession({hash:'x',token:'t',csrf:'c',login:'o',expires:time+5000});
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM sessions')[0].n,20);
  assert.equal(store.getSession('s0'),null,'the oldest session makes room for a new sign-in');
  assert.equal(store.getSession('x').login,'o');assert.equal(store.getSession('s19').login,'o');
});

test('archive reader handles GitHub prefixes, pax paths and skips non-files',()=>{
  const long='src/'+'nested/'.repeat(20)+'file.js';
  const bytes=tar([{name:'pax_global_header',type:'g',content:'52 comment=abc\n'},{name:'repo-sha/',type:'5',content:''},{name:'repo-sha/README.md',content:'# Hi'},{name:'PaxHeader',type:'x',content:pax(`repo-sha/${long}`)},{name:'repo-sha/truncated-name',content:'long',mode:'0000755'},{name:'repo-sha/link',type:'2',content:''}]);
  const {files,executable}=readTar(new Uint8Array(bytes));
  assert.deepEqual([...files.keys()],['README.md',long]);
  assert.deepEqual([...executable],[long]);
  assert.equal(new TextDecoder().decode(files.get(long)),'long');
  assert.throws(()=>readTar(new Uint8Array(bytes.subarray(0,1100))),/truncated/);
});

test('archive reader matches real git archive output, including long paths',()=>{
  const dir=mkdtempSync(join(tmpdir(),'autopilot-archive-'));
  try {
    const paths=['README.md','src/'+'deep-directory-name/'.repeat(8)+'module.js','public/ünïcode.css'];
    for(const path of paths) {mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),`content of ${path}\n`);}
    const git=(...args)=>execFileSync('git',['-c','user.name=t','-c','user.email=t@example.com','-c','commit.gpgsign=false',...args],{cwd:dir});
    git('init','-q');git('add','.');git('update-index','--chmod=+x',paths[1]);git('commit','-qm','x');
    const {files,executable}=readTar(new Uint8Array(git('archive','--format=tar','--prefix=owner-repo-abc1234/','HEAD')));
    assert.deepEqual([...files.keys()].sort(),[...paths].sort());
    assert.deepEqual([...executable],[paths[1]]);
    for(const path of paths) assert.equal(new TextDecoder().decode(files.get(path)),`content of ${path}\n`);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('context prefers named and related files within the budget',()=>{
  const files={'public/app.js':'const workflow=1;','public/style.css':'.x{}','src/github.js':'workflow runs number','README.md':'x'.repeat(500)};
  const context=selectContext(files,'Fix the workflow number in src/github.js',100);
  assert.deepEqual(context.included.map(f=>f.path),['src/github.js','public/app.js','public/style.css']);
  assert.deepEqual(context.listing,['README.md','public/app.js','public/style.css','src/github.js']);
  assert.equal(readableFile('.github/workflows/ci.yml',10),true);
  assert.equal(readableFile('.env',10),false);assert.equal(readableFile('dist/app.js',10),false);assert.equal(readableFile('public/logo.png',10),false);
  const decoded=textFiles(new Map([['a.js',new TextEncoder().encode('a\r\nb')],['bom.js',new Uint8Array([0xef,0xbb,0xbf,0x61])],['b.js',new Uint8Array([0xff,0xfe])],['c.png',new Uint8Array([1])]]));
  assert.deepEqual(decoded,{'a.js':'a\r\nb','bom.js':'\ufeffa'},'line endings and BOM are kept byte for byte');
});

test('edit blocks are parsed, applied exactly once and limited to allowed paths',()=>{
  const reply='Change it.\nPR-TITLE: Rename x\n```\n<<<<<<< SEARCH public/app.js\nconst x=1;\n=======\nconst y=1;\n>>>>>>> REPLACE\n```\n<<<<<<< SEARCH public/new.js\n=======\nexport const z=1;\n>>>>>>> REPLACE\n';
  const {edits,title}=parseEdits(reply);
  assert.equal(title,'Rename x');assert.equal(edits.length,2);
  const files={'public/app.js':'// a\nconst x=1;\n','public/dup.js':'a\na\n','src/agent.js':'x\n'};
  assert.deepEqual(applyEdits(edits,files,Object.keys(files)),[{path:'public/app.js',content:'// a\nconst y=1;\n'},{path:'public/new.js',content:'export const z=1;\n'}]);
  assert.equal(displayText(reply).includes('SEARCH'),false);
  const inline=parseEdits('<<<<<<< SEARCH public/index.html\n<span>V0.1</span>\n=======\n<span>V0.2</span>\n>>>>>>> REPLACE').edits;
  assert.deepEqual(applyEdits(inline,{'public/index.html':'<p><span>V0.1</span></p>'},['public/index.html']),[{path:'public/index.html',content:'<p><span>V0.2</span></p>'}],'part of a line can be replaced');
  const removal=parseEdits('<<<<<<< SEARCH public/app.js\nconst x=1;\n=======\n>>>>>>> REPLACE').edits;
  assert.deepEqual(applyEdits(removal,{'public/app.js':'a\nconst x=1;\nb\n'},['public/app.js']),[{path:'public/app.js',content:'a\nb\n'}],'removed lines leave no blank line');
  const block=(path,search,replace='b\n')=>[{path,search,replace}];
  assert.throws(()=>applyEdits(block('public/app.js','missing\n'),files,Object.keys(files)),/does not match/);
  assert.throws(()=>applyEdits(block('public/dup.js','a\n'),files,Object.keys(files)),/more than one/);
  assert.throws(()=>applyEdits(block('src/agent.js','x\n'),files,Object.keys(files)),/may not be edited/);
  assert.throws(()=>applyEdits(block('.github/workflows/ci.yml',''),files,Object.keys(files)),/may not be edited/);
  assert.throws(()=>applyEdits(block('public/app.js',''),files,Object.keys(files)),/already exists/);
  assert.throws(()=>parseEdits('<<<<<<< SEARCH a.js\nx\n=======\ny\n'),/malformed/);
  const crlf={'public/win.js':'\ufeffa\r\nb\r\nc\r\n'};
  assert.deepEqual(applyEdits(parseEdits('<<<<<<< SEARCH public/win.js\na\nb\n=======\na\nB\n>>>>>>> REPLACE').edits,crlf,Object.keys(crlf)),[{path:'public/win.js',content:'\ufeffa\r\nB\r\nc\r\n'}],'CRLF files keep their line endings');
  const windows={'public/w.js':'one();\r\ntwo();\r\n'};
  assert.deepEqual(applyEdits(parseEdits('<<<<<<< SEARCH public/w.js\none();\n=======\none();\nextra();\n>>>>>>> REPLACE').edits,windows,['public/w.js']),[{path:'public/w.js',content:'one();\r\nextra();\r\ntwo();\r\n'}],'new lines in a CRLF file use CRLF');
  const apply=(source,search,replace)=>applyEdits(parseEdits(`<<<<<<< SEARCH public/m.js\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`).edits,{'public/m.js':source},['public/m.js'])[0].content;
  assert.equal(apply('a\nb\nc\nx\r\ny\r\n','x\ny','x\nY\nz'),'a\nb\nc\nx\r\nY\r\nz\r\n','a CRLF region of a mostly-LF file matches and stays CRLF');
  assert.equal(apply('A\r\nB\r\np\nq\nC\r\n','p\nq','p\nQ'),'A\r\nB\r\np\nQ\nC\r\n','an LF region of a CRLF file stays LF');
  assert.equal(apply('one\ntwo\r\nthree\n','two','two\n2b'),'one\ntwo\r\n2b\r\nthree\n','a single-line match uses its own line ending');
  assert.equal(apply('one\r\nlast','last','last\nmore'),'one\r\nlast\r\nmore','a last line without an ending uses the previous line');
  assert.throws(()=>apply('p\nq\r\np\r\nq','p\nq','x'),/more than one place/,'matches across both line endings are ambiguous');
  const mixed={'public/mixed.js':'a\nb\r\nc\n'};
  assert.deepEqual(applyEdits(parseEdits('<<<<<<< SEARCH public/mixed.js\na\nb\n=======\na\nB\n>>>>>>> REPLACE').edits,mixed,Object.keys(mixed)),[{path:'public/mixed.js',content:'a\nB\r\nc\n'}],'mixed line endings still match LF text');
  for(const path of WORKER_SOURCES) assert.throws(()=>applyEdits(block(path,'x'),{[path]:'x'},[path]),/may not be edited/,path);
  assert.throws(()=>applyEdits(block('public/app.js','const x=1;','const x=1;'),files,Object.keys(files)),/do not change/);
  const many=Object.fromEntries(Array.from({length:9},(_,i)=>[`public/f${i}.js`,'a']));
  assert.throws(()=>applyEdits(Object.keys(many).map(path=>({path,search:'a',replace:'b'})),many,Object.keys(many)),/at most 8 files/);
  const big={'public/big.js':'a'+'x'.repeat(90000)};
  assert.equal(applyEdits(block('public/big.js','a','b'),big,['public/big.js'])[0].content.length,90001,'large readable files can be edited');
});

test('every repository file bundled into the Worker is read-only for the chat agent',()=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),seen=new Set(),pending=['worker/src/index.js'];
  while(pending.length) {
    const file=pending.pop();if(seen.has(file)) continue;seen.add(file);
    for(const [,spec] of readFileSync(join(root,file),'utf8').matchAll(/from\s+'(\.[^']+)'/g)) pending.push(join(dirname(file),spec));
  }
  assert.deepEqual([...seen].filter(f=>!f.startsWith('worker/')).sort(),[...WORKER_SOURCES].sort());
});

test('messages carry files, history and the current image',()=>{
  const messages=buildMessages({repository:'o/r',head:{branch:'main',sha:'a'.repeat(40)},context:{included:[{path:'a.js',text:'code'}],listing:['a.js','b.png']},history:[{role:'user',content:'Old',hasImage:true},{role:'assistant',content:'Reply'}],text:'Now',image:'data:image/jpeg;base64,AAAA'});
  assert.match(messages[0].content,/----- FILE a\.js -----\ncode/);
  assert.match(messages[1].content,/no longer available/);
  assert.equal(messages[2].role,'assistant');
  assert.deepEqual(messages[3].content[1],{type:'image_url',image_url:{url:'data:image/jpeg;base64,AAAA'}});
});

test('a failed edit gets one correction round before it is reported',async()=>{
  const replies=['<<<<<<< SEARCH public/a.js\nwrong\n=======\nnew\n>>>>>>> REPLACE','<<<<<<< SEARCH public/a.js\nold\n=======\nnew\n>>>>>>> REPLACE'];
  const calls=[];const env={AI:{run:async(model,input)=>{calls.push(input);return {response:replies.shift()};}}};
  const result=await answer(env,{messages:[{role:'user',content:'x'}],files:{'public/a.js':'old\n'},existingPaths:['public/a.js']});
  assert.equal(result.error,null);assert.equal(result.proposal.edits[0].search,'old');
  assert.match(calls[1].messages.at(-1).content,/does not match/);
  assert.equal(calls[0].max_tokens,4096);
  const failing={AI:{run:async()=>({response:'<<<<<<< SEARCH public/a.js\nwrong\n=======\nnew\n>>>>>>> REPLACE'})}};
  const failed=await answer(failing,{messages:[],files:{'public/a.js':'old\n'},existingPaths:['public/a.js']});
  assert.equal(failed.proposal,null);assert.match(failed.error,/does not match/);
  await assert.rejects(answer({AI:{run:async()=>{throw new Error('3036: daily free allocation exceeded');}}},{messages:[],files:{},existingPaths:[]}),/daily free allocation/);
});

test('a model that never answers times out instead of holding the chat lock',async()=>{
  mock.timers.enable({apis:['setTimeout']});
  try {
    const pending=callModel({AI:{run:()=>new Promise(()=>{})}},[]);
    mock.timers.tick(150000);
    await assert.rejects(pending,/timed out after 150 seconds/);
  } finally {mock.timers.reset();}
});

test('model provider failures and cut-off answers are explained',async()=>{
  const env={MODEL_PROVIDER:'openai-compatible',MODEL_BASE_URL:'https://models.example/v1',MODEL_API_KEY:'k',MODEL:'m'};
  await assert.rejects(callModel({...env,MODEL_BASE_URL:'not a url'},[]),/Configure MODEL_BASE_URL/);
  await assert.rejects(callModel({...env,MODEL:undefined},[]),/AUTOPILOT_CHAT_MODEL/);
  assert.equal((await callModel({...env,MODEL:'@cf/meta/llama-3.1-8b-instruct'},[],{fetchImpl:async()=>Response.json({choices:[{message:{content:'ok'}}]})})).text,'ok','Cloudflare models work through the OpenAI-compatible endpoint');
  await assert.rejects(callModel({...env,MODEL_BASE_URL:'http://models.example'},[]),/Configure MODEL_BASE_URL/);
  await assert.rejects(callModel(env,[],{fetchImpl:async()=>{throw Object.assign(new Error('x'),{name:'TimeoutError'});}}),/timed out after 150 seconds/);
  await assert.rejects(callModel(env,[],{fetchImpl:async()=>new Response('<html>',{status:200})}),/no valid response/);
  await assert.rejects(callModel(env,[],{fetchImpl:async()=>new Response('{}',{status:429})}),/HTTP 429/);
  let sent;
  assert.deepEqual(await callModel(env,[{role:'user',content:'hi'}],{fetchImpl:async(url,options)=>{sent={url,options};return Response.json({choices:[{message:{content:'Hi'},finish_reason:'length'}]});}}),{text:'Hi',truncated:true});
  assert.equal(sent.url,'https://models.example/v1/chat/completions');assert.equal(sent.options.headers.Authorization,'Bearer k');
  assert.deepEqual(await callModel({AI:{run:async()=>({response:'Long',usage:{completion_tokens:4096}})}},[]),{text:'Long',truncated:true});
  assert.deepEqual(await callModel({AI:{run:async()=>({response:'Short',usage:{completion_tokens:10}})}},[]),{text:'Short',truncated:false});
  // A cut-off answer never becomes a proposal, even when a complete edit block was written before the limit.
  const block='Two edits.\n<<<<<<< SEARCH public/a.js\nold\n=======\nnew\n>>>>>>> REPLACE\n<<<<<<< SEARCH public/b.js\nol';
  let calls=0;const cut=await answer({AI:{run:async()=>(calls++,{response:block,usage:{completion_tokens:4096}})}},{messages:[],files:{'public/a.js':'old\n'},existingPaths:['public/a.js']});
  assert.equal(cut.proposal,null);assert.match(cut.error,/cut off/);assert.match(cut.reply,/\[The answer was cut off/);assert.equal(calls,1,'no correction round is spent');
  const prose=await answer({AI:{run:async()=>({response:'A long explanation',usage:{completion_tokens:4096}})}},{messages:[],files:{},existingPaths:[]});
  assert.deepEqual([prose.proposal,prose.error],[null,null]);assert.match(prose.reply,/cut off/);
});

test('images must be small PNG or JPEG data URLs',()=>{
  const png='data:image/png;base64,'+Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]).toString('base64');
  const jpeg='data:image/jpeg;base64,'+Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0]).toString('base64');
  assert.equal(validateImage(png),png);assert.equal(validateImage(jpeg),jpeg);assert.equal(validateImage(undefined),null);
  for(const image of ['https://example.com/a.png','data:image/svg+xml;base64,AAAA','data:image/png;base64,'+Buffer.from('not a png!!!').toString('base64'),jpeg.replace('jpeg','png'),'data:image/jpeg;base64,'+'A'.repeat(1500001),42]) assert.throws(()=>validateImage(image),/PNG or JPEG/);
});

function environment({time=()=>1000}={}) {
  const store=new ChatStoreLogic(sqlite(),time);
  const env={REPOSITORY:'owner/repo',GITHUB_CLIENT_ID:'Iv1.client',GITHUB_CLIENT_SECRET:'client-secret-value',CHAT:{idFromName:()=> 'main',get:()=>store},ASSETS:{fetch:async()=>new Response('<html>',{headers:{'Content-Type':'text/html'}})},AI:{run:async()=>({response:'Hello'})}};
  return {env,store};
}
const files={'public/app.js':'const title="Old";\n','README.md':'# Repo\n'};
function github({calls,head='a'.repeat(40),login='owner',token='ghu_user',repoFiles=files,writeStatus=201,executable=[],refStatus=201,pullStatus=201,openPulls=[]}) {
  return async(url,options={})=>{
    const method=options.method||'GET';calls.push({url,method,options});
    const ok=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
    if(url==='https://github.com/login/oauth/access_token') return ok({access_token:token,expires_in:28800,scope:''});
    if(url==='https://api.github.com/user') return ok({login});
    const path=url.replace('https://api.github.com/repos/owner/repo','');
    if(path==='') return ok({default_branch:'main',private:false});
    if(path==='/git/ref/heads/main') return ok({object:{sha:head}});
    if(path===`/tarball/${head}`) return new Response(gzipSync(repoTar(repoFiles,executable)));
    if(path===`/git/commits/${head}`) return ok({tree:{sha:'tree0'}});
    if(method==='POST'&&path==='/git/trees') return ok({sha:'tree1'},writeStatus);
    if(method==='POST'&&path==='/git/commits') return ok({sha:'commit1'},201);
    if(method==='POST'&&path==='/git/refs') return ok({},refStatus);
    if(method==='PATCH'&&path.startsWith('/git/refs/heads/autopilot/chat-')) return ok({});
    if(method==='POST'&&path==='/pulls') return ok({html_url:'https://github.com/owner/repo/pull/7'},pullStatus);
    if(method==='GET'&&path.startsWith('/pulls?state=open&head=owner%3Aautopilot%2Fchat-')) return ok(openPulls);
    return ok({message:'not found'},404);
  };
}
const ORIGIN='https://chat.example.workers.dev';
const request=(path,{method='GET',cookie,body,headers={}}={})=>new Request(ORIGIN+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body!==undefined?JSON.stringify(body):undefined});

async function signIn(env,fetchImpl,now=Date.now) {
  const login=await handle(request('/auth/login'),env,{fetchImpl,now});
  assert.equal(login.status,303);
  const target=new URL(login.headers.get('Location'));
  assert.equal(target.origin+target.pathname,'https://github.com/login/oauth/authorize');
  assert.equal(target.searchParams.get('redirect_uri'),`${ORIGIN}/auth/callback`);
  assert.equal(target.searchParams.get('code_challenge_method'),'S256');
  const browser=login.headers.get('Set-Cookie').match(/autopilot_login=([0-9a-f]+)/)[1];
  return {state:target.searchParams.get('state'),browser,callback:(state=target.searchParams.get('state'),cookie=`autopilot_login=${browser}`)=>handle(request(`/auth/callback?code=c&state=${encodeURIComponent(state)}`,{cookie}),env,{fetchImpl})};
}
async function session(env,fetchImpl) {
  const response=await (await signIn(env,fetchImpl)).callback();
  assert.equal(response.status,303);
  const cookie=response.headers.getSetCookie().find(c=>c.startsWith('__Host-autopilot_session='));
  assert.match(cookie,/HttpOnly; SameSite=Lax; Max-Age=28800; Secure/);
  const id=cookie.split(';')[0];
  const info=await (await handle(request('/api/session',{cookie:id}),env,{fetchImpl})).json();
  return {cookie:id,csrf:info.csrf,info};
}
const post=(path,auth,body,headers={})=>request(path,{method:'POST',cookie:auth.cookie,body,headers:{Origin:ORIGIN,'X-CSRF-Token':auth.csrf,...headers}});

test('sign-in requires the owner, a GitHub App token and the starting browser',async()=>{
  const calls=[];
  const {env,store}=environment();
  const fetchImpl=github({calls});
  const auth=await session(env,fetchImpl);
  assert.equal(auth.info.login,'owner');assert.equal(auth.info.repository,'owner/repo');
  const exchange=calls.find(c=>c.url.includes('access_token'));
  assert.equal(JSON.parse(exchange.options.body).code_verifier.length,64);
  assert.equal(store.rows('SELECT token FROM sessions')[0].token,'ghu_user');
  assert.equal(store.rows('SELECT hash FROM sessions')[0].hash.includes(auth.cookie.split('=')[1]),false,'only a hash of the session id is stored');
  const start=await signIn(env,fetchImpl);
  const sessions=()=>store.rows('SELECT COUNT(*) AS n FROM sessions')[0].n;
  for(const response of [await start.callback(start.state,'autopilot_login=other'),await start.callback('tampered'),await start.callback(start.state,'')]) {
    assert.equal(response.status,303);assert.equal(response.headers.get('Location'),'/?signin=expired');
  }
  assert.equal(sessions(),1,'failed callbacks create no session');
  const cancelled=await handle(request(`/auth/callback?error=access_denied&state=${encodeURIComponent(start.state)}`,{cookie:`autopilot_login=${start.browser}`}),env,{fetchImpl});
  assert.equal(cancelled.headers.get('Location'),'/?signin=cancelled');
  for(const [options,reason] of [[{login:'someone-else'},'owner'],[{token:'gho_oauth'},'app']]) {
    const other=environment(),attempt=await signIn(other.env,github({calls:[],...options}));
    const response=await attempt.callback();
    assert.equal(response.headers.get('Location'),`/?signin=${reason}`);assert.equal(other.store.rows('SELECT COUNT(*) AS n FROM sessions')[0].n,0);
  }
  const network=environment(),attempt=await signIn(network.env,fetchImpl);
  const offline=async url=>{if(url.includes('access_token')) throw Object.assign(new Error('reset'),{name:'TimeoutError'});return fetchImpl(url);};
  const dropped=await handle(request(`/auth/callback?code=c&state=${encodeURIComponent(attempt.state)}`,{cookie:`autopilot_login=${attempt.browser}`}),network.env,{fetchImpl:offline});
  assert.equal(dropped.headers.get('Location'),'/?signin=failed','network failures return to the chat page');
  const misconfigured=await handle(request(`/auth/callback?error=redirect_uri_mismatch&state=${encodeURIComponent(attempt.state)}`,{cookie:`autopilot_login=${attempt.browser}`}),network.env,{fetchImpl});
  assert.equal(misconfigured.headers.get('Location'),'/?signin=github');
  const forged=await handle(request('/auth/callback?error=access_denied',{cookie:`autopilot_login=${attempt.browser}`}),network.env,{fetchImpl});
  assert.equal(forged.headers.get('Location'),'/?signin=cancelled');assert.equal(forged.headers.get('Set-Cookie'),null,'another page cannot clear a pending sign-in');
  const expired=environment();let now=1000;
  const late=await signIn(expired.env,fetchImpl,()=>now);now+=601000;
  assert.equal((await handle(request(`/auth/callback?code=c&state=${encodeURIComponent(late.state)}`,{cookie:`autopilot_login=${late.browser}`}),expired.env,{fetchImpl,now:()=>now})).headers.get('Location'),'/?signin=expired');
});

test('API rejects missing sessions, foreign origins and missing CSRF tokens',async()=>{
  const {env}=environment(),fetchImpl=github({calls:[]});
  assert.equal((await handle(request('/api/conversations'),env,{fetchImpl})).status,401);
  assert.deepEqual(await (await handle(request('/api/session'),env,{fetchImpl})).json(),{login:null,repository:'owner/repo'});
  const auth=await session(env,fetchImpl);
  for(const headers of [{Origin:'https://evil.example'},{'X-CSRF-Token':'wrong'}]) assert.equal((await handle(post('/api/chat',auth,{text:'hi'},headers),env,{fetchImpl})).status,403);
  assert.equal((await handle(request('/api/chat',{method:'POST',cookie:auth.cookie,body:'x',headers:{Origin:ORIGIN,'X-CSRF-Token':auth.csrf,'Content-Type':'text/plain'}}),env,{fetchImpl})).status,415);
  const page=await handle(request('/'),env,{fetchImpl});
  assert.match(page.headers.get('Content-Security-Policy'),/default-src 'self'/);assert.equal(page.headers.get('X-Frame-Options'),'DENY');
  assert.equal((await handle(request('/api/session'),{...env,GITHUB_CLIENT_SECRET:''},{fetchImpl})).status,503);
  assert.equal((await handle(request('/api/session'),{...env,CHAT_ORIGIN:'https://other.example'},{fetchImpl})).status,404);
  for(const broken of [{CHAT_ORIGIN:'chat.example.com'},{REPOSITORY:'owner/..'},{REPOSITORY:'https://github.com/owner/repo'}]) {
    const response=await handle(request('/api/session'),{...env,...broken},{fetchImpl});
    assert.equal(response.status,503,JSON.stringify(broken));assert.match((await response.json()).error,/not configured/);
  }
  assert.equal((await handle(request('/'),{...env,CHAT_ORIGIN:'chat.example.com'},{fetchImpl})).status,200,'pages still load with a broken setting');
  const logout=await handle(post('/api/logout',auth,{}),env,{fetchImpl});
  assert.match(logout.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal((await handle(request('/api/conversations',{cookie:auth.cookie}),env,{fetchImpl})).status,401);
});

test('chat answers from repository files and opens a pull request on request',async()=>{
  const calls=[],{env,store}=environment(),fetchImpl=github({calls});
  const inputs=[];
  env.AI.run=async(model,input)=>{inputs.push({model,input});return {response:'Renaming the title.\nPR-TITLE: New title\n<<<<<<< SEARCH public/app.js\nconst title="Old";\n=======\nconst title="New";\n>>>>>>> REPLACE'};};
  const auth=await session(env,fetchImpl);
  const sent=await handle(post('/api/chat',auth,{text:'Change the title in public/app.js'}),env,{fetchImpl});
  assert.equal(sent.status,200);
  const {conversation}=await sent.json();
  assert.match(conversation,/^[0-9a-f]{32}$/);
  assert.equal(inputs[0].model,'@cf/meta/llama-4-scout-17b-16e-instruct');
  assert.match(inputs[0].input.messages[0].content,/----- FILE public\/app\.js -----\nconst title="Old";/);
  assert.ok(calls.filter(c=>c.url.startsWith('https://api.github.com/repos/')).every(c=>c.options.headers.Authorization==='Bearer ghu_user'&&c.options.headers['User-Agent']));
  const thread=await (await handle(request(`/api/conversations/${conversation}`,{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal(thread.title,'Change the title in public/app.js');
  const reply=thread.messages[1];
  assert.deepEqual(reply.proposal,{title:'New title',paths:['public/app.js']});
  assert.equal(JSON.stringify(thread).includes('ghu_user'),false);
  const created=await handle(post('/api/pull-request',auth,{conversation,message:reply.id}),env,{fetchImpl});
  assert.deepEqual(await created.json(),{url:'https://github.com/owner/repo/pull/7'});
  const tree=JSON.parse(calls.find(c=>c.method==='POST'&&c.url.endsWith('/git/trees')).options.body);
  assert.deepEqual(tree,{base_tree:'tree0',tree:[{path:'public/app.js',mode:'100644',type:'blob',content:'const title="New";\n'}]});
  const pull=JSON.parse(calls.find(c=>c.url.endsWith('/pulls')).options.body);
  assert.equal(pull.title,'New title');assert.equal(pull.base,'main');assert.match(pull.head,/^autopilot\/chat-/);assert.equal(pull.body.includes('<<<<<<<'),false);
  const writes=calls.filter(c=>c.method==='POST').length;
  assert.deepEqual(await (await handle(post('/api/pull-request',auth,{conversation,message:reply.id}),env,{fetchImpl})).json(),{url:'https://github.com/owner/repo/pull/7'});
  assert.equal(calls.filter(c=>c.method==='POST').length,writes,'a second click reuses the existing pull request');
  assert.equal((await handle(post('/api/pull-request',auth,{conversation,message:thread.messages[0].id}),env,{fetchImpl})).status,404);
  assert.equal(store.acquireLock('model','t',1),true,'the model lock is released after answering');
});

test('pull requests keep file modes and can be retried after a partial failure',async()=>{
  const calls=[],{env,store}=environment();
  env.AI.run=async()=>({response:'<<<<<<< SEARCH public/app.js\nconst title="Old";\n=======\nconst title="New";\n>>>>>>> REPLACE'});
  const auth=await session(env,github({calls}));
  const {conversation}=await (await handle(post('/api/chat',auth,{text:'Change it'}),env,{fetchImpl:github({calls})})).json();
  const message=store.getConversation(conversation).messages[1].id;
  const failed=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:github({calls,pullStatus:502,executable:['public/app.js']})});
  assert.equal(failed.status,500);assert.match((await failed.json()).error,/HTTP 502/);
  assert.equal(JSON.parse(calls.findLast(c=>c.url.endsWith('/git/trees')&&c.method==='POST').options.body).tree[0].mode,'100755','executable files stay executable');
  const branch=JSON.parse(calls.findLast(c=>c.url.endsWith('/git/refs')).options.body).ref.replace('refs/heads/','');
  // Leftover branch without a pull request: it is moved to the new commit and the PR is opened.
  calls.length=0;
  const retried=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:github({calls,refStatus:422})});
  assert.deepEqual(await retried.json(),{url:'https://github.com/owner/repo/pull/7'});
  const patch=calls.find(c=>c.method==='PATCH');
  assert.equal(patch.url.split('/git/refs/heads/')[1],branch,'the retry reuses the same branch');assert.equal(JSON.parse(patch.options.body).force,true);
  // A pull request opened from the branch after the first check is reused, not overwritten.
  store.sql.exec('UPDATE messages SET pr_url = NULL');calls.length=0;let lookups=0;
  const racing=github({calls,refStatus:422});
  const raced=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:async(url,options)=>url.includes('/pulls?state=open')?(calls.push({url,method:'GET',options}),Response.json(lookups++?[{html_url:'https://github.com/owner/repo/pull/9'}]:[])):racing(url,options)});
  assert.deepEqual(await raced.json(),{url:'https://github.com/owner/repo/pull/9'});
  assert.equal(calls.some(c=>c.method==='PATCH'),false);
  // A pull request that exists but was never recorded is reused without touching its branch.
  store.sql.exec('UPDATE messages SET pr_url = NULL');calls.length=0;
  const reused=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:github({calls,refStatus:422,openPulls:[{html_url:'https://github.com/owner/repo/pull/8'}]})});
  assert.deepEqual(await reused.json(),{url:'https://github.com/owner/repo/pull/8'});
  assert.equal(calls.some(c=>c.method!=='GET'),false,'an open pull request is reused without any write, so its commits are never overwritten');
  assert.equal(store.getMessage(conversation,message).prUrl,'https://github.com/owner/repo/pull/8');
});

test('internal failures are reported without their details',async()=>{
  const {env,store}=environment();
  const auth=await session(env,github({calls:[]}));
  store.listConversations=()=>{throw new Error('SQLITE_CORRUPT: internal details');};
  const response=await handle(request('/api/conversations',{cookie:auth.cookie}),env,{fetchImpl:github({calls:[]})});
  assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Request failed. Please try again.'});
});

test('chat reports stale changes, busy agent, expired tokens and refused writes',async()=>{
  const calls=[],{env,store}=environment();
  env.AI.run=async()=>({response:'<<<<<<< SEARCH public/app.js\nconst title="Old";\n=======\nconst title="New";\n>>>>>>> REPLACE'});
  const auth=await session(env,github({calls}));
  const {conversation}=await (await handle(post('/api/chat',auth,{text:'Change it'}),env,{fetchImpl:github({calls})})).json();
  const message=store.getConversation(conversation).messages[1].id;
  const moved=github({calls,head:'b'.repeat(40),repoFiles:{'public/app.js':'const title="Changed";\n'}});
  const stale=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:moved});
  assert.equal(stale.status,409);assert.match((await stale.json()).error,/no longer applies/);
  const refused=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:github({calls,writeStatus:403})});
  assert.equal(refused.status,403);assert.match((await refused.json()).error,/Contents and Pull requests/);
  assert.equal(store.acquireLock('pull-request','t',1),true);store.releaseLock('pull-request','t');
  store.acquireLock('model','other',60000);
  assert.equal((await handle(post('/api/chat',auth,{text:'Again',conversation}),env,{fetchImpl:github({calls})})).status,429);
  assert.equal(store.acquireLock('model','x',1),false,'a rejected request does not release the holder\'s lock');
  store.releaseLock('model','other');
  assert.equal((await handle(post('/api/chat',auth,{text:'x',conversation:'f'.repeat(32)}),env,{fetchImpl:github({calls})})).status,404);
  assert.equal((await handle(post('/api/chat',auth,{text:''}),env,{fetchImpl:github({calls})})).status,400);
  env.AI.run=async()=>{throw new Error('3036: Account limited');};
  const failed=await handle(post('/api/chat',auth,{text:'Hello',conversation}),env,{fetchImpl:github({calls})});
  assert.equal(failed.status,500);assert.match((await failed.json()).error,/Account limited/);
  assert.equal(store.getConversation(conversation).messages.length,2,'a failed answer stores nothing');
  const expiredToken=async(url,options)=>url.startsWith('https://api.github.com/repos/')?new Response('{}',{status:401}):github({calls})(url,options);
  const expired=await handle(post('/api/chat',auth,{text:'Hello',conversation}),env,{fetchImpl:expiredToken});
  assert.equal(expired.status,401);
  assert.equal((await handle(request('/api/conversations',{cookie:auth.cookie}),env,{fetchImpl:expiredToken})).status,401,'the expired session is removed');
});

test('dashboard API serves live GitHub data per pull request and caches it briefly',async()=>{
  let time=1000;
  const {env,store}=environment({time:()=>time});
  const calls=[];
  const pr=(number,state)=>({number,title:`PR ${number}`,html_url:`https://github.com/owner/repo/pull/${number}`,state:state==='merged'?'closed':state,merged_at:state==='merged'?'2026-10-01T00:00:00Z':null,draft:false,head:{sha:String(number).repeat(40).slice(0,40)},created_at:'2026-10-01T00:00:00Z',updated_at:`2026-10-0${number}T00:00:00Z`});
  const pulls=[pr(1,'open'),pr(2,'merged')];
  const fetchImpl=async(url,options={})=>{
    calls.push({url,options});
    const ok=value=>Response.json(value);
    if(url==='https://github.com/login/oauth/access_token') return ok({access_token:'ghu_user',expires_in:28800,scope:''});
    if(url==='https://api.github.com/user') return ok({login:'owner'});
    if(url==='https://api.github.com/graphql') return ok({data:{repository:{pullRequest:{headRefOid:pulls[JSON.parse(options.body).variables.number-1].head.sha,mergeStateStatus:'CLEAN',reviewDecision:null,reviewThreads:{pageInfo:{hasNextPage:false},nodes:[]}}}}});
    const path=url.replace('https://api.github.com/repos/owner/repo','');
    if(path==='') return ok({full_name:'owner/repo',html_url:'https://github.com/owner/repo'});
    if(path.startsWith('/pulls?state=all')) return ok(pulls);
    if(path.startsWith('/actions/runs')) return ok({workflow_runs:[{id:5,run_number:12,name:'CI',display_title:'Fix',status:'completed',conclusion:'success',head_branch:'main',head_sha:'a',html_url:'https://github.com/owner/repo/actions/runs/5',updated_at:'2026-10-01T00:00:00Z'}]});
    const single=/^\/pulls\/(\d+)$/.exec(path);
    if(single) return ok(pulls[Number(single[1])-1]);
    if(/\/check-runs/.test(path)) return ok({total_count:1,check_runs:[{name:'test',status:'completed',conclusion:'success'}]});
    if(/\/status\?/.test(path)) return ok({statuses:[]});
    return ok([]);
  };
  const auth=await session(env,fetchImpl);
  const get=(path)=>handle(request(path,{cookie:auth.cookie}),env,{fetchImpl,now:()=>time});
  calls.length=0;
  const overview=await (await get('/api/dashboard')).json();
  assert.equal(overview.repository,'owner/repo');
  assert.deepEqual(overview.pulls.map(p=>[p.number,p.state]),[[1,'open'],[2,'merged']]);
  assert.equal(overview.workflows[0].runNumber,12);
  assert.equal(calls.length,3,'the overview needs three GitHub calls');
  assert.ok(calls.every(c=>c.options.headers['User-Agent']==='repo-autopilot-chat'&&c.options.headers.Authorization==='Bearer ghu_user'),'Workers requests identify themselves to GitHub');
  calls.length=0;
  const detail=await (await get('/api/dashboard/pulls/1?updated=2026-10-01T00:00:00Z')).json();
  assert.equal(detail.number,1);assert.equal(detail.ci,'success');assert.equal(detail.state,'open');assert.ok(detail.readiness.label);
  assert.ok(calls.length<=10,`one pull request needs at most ten GitHub calls (used ${calls.length})`);
  assert.ok(calls.filter(c=>c.url==='https://api.github.com/graphql').every(c=>c.options.headers['User-Agent']));
  calls.length=0;
  await get('/api/dashboard');await get('/api/dashboard/pulls/1?updated=2026-10-01T00:00:00Z');
  assert.equal(calls.length,0,'repeated loads within a minute come from the cache');
  await get('/api/dashboard/pulls/1?updated=2026-10-05T00:00:00Z');
  assert.ok(calls.length>0,'a newer updatedAt bypasses the cache');
  calls.length=0;await get('/api/dashboard?fresh=1');
  assert.equal(calls.length,3,'Refresh bypasses the cache');
  calls.length=0;time+=61000;await get('/api/dashboard');
  assert.equal(calls.length,3,'cached data expires after a minute');
  calls.length=0;
  await get('/api/dashboard/pulls/2?updated=x');time+=600000;await get('/api/dashboard/pulls/2?updated=x');
  assert.ok(calls.length>0&&calls.length<=10);
  const before=calls.length;await get('/api/dashboard/pulls/2?updated=x');
  assert.equal(calls.length,before,'merged pull requests stay cached for longer');
  for(const path of ['/api/dashboard/pulls/0','/api/dashboard/pulls/abc','/api/dashboard/other']) assert.equal((await get(path)).status,404,path);
  assert.equal((await get(`/api/dashboard/pulls/1?updated=${'x'.repeat(41)}`)).status,400);
  assert.equal((await handle(request('/api/dashboard'),env,{fetchImpl})).status,401,'the dashboard requires sign-in');
  const failing=async(url,options)=>url.startsWith('https://api.github.com/repos/')?new Response('{}',{status:502}):fetchImpl(url,options);
  const failed=await handle(request('/api/dashboard?fresh=1',{cookie:auth.cookie}),env,{fetchImpl:failing,now:()=>time});
  assert.equal(failed.status,502,'GitHub refusals are reported as such, not as server errors');assert.match((await failed.json()).error,/GitHub request failed \(502\)/);
  const missing=async(url,options)=>/\/pulls\/77$/.test(url)?new Response('{}',{status:404}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard/pulls/77',{cookie:auth.cookie}),env,{fetchImpl:missing,now:()=>time})).status,404);
  // A pull request whose details partly failed is shown, but not cached.
  const flaky=async(url,options)=>/\/pulls\/2\/reviews/.test(url)?new Response('{}',{status:503}):fetchImpl(url,options);
  const partial=await (await handle(request('/api/dashboard/pulls/2?updated=y',{cookie:auth.cookie}),env,{fetchImpl:flaky,now:()=>time})).json();
  assert.match(partial.detailError,/503/);assert.equal(partial.unresolvedThreads,0,'verification still succeeds next to a partial failure');
  assert.ok(store.getCache('pull:2:y'),'a partial failure is cached briefly');
  time+=31000;assert.equal(store.getCache('pull:2:y'),null,'and retried after 30 seconds');
  const limited=async(url,options)=>url.includes('/actions/runs')||url.endsWith('/repos/owner/repo')?new Response('{}',{status:429}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard?fresh=1',{cookie:auth.cookie}),env,{fetchImpl:limited,now:()=>time})).status,429,'rate limits keep their status');
  const expired=async(url,options)=>url.startsWith('https://api.github.com/repos/')?new Response('{}',{status:401}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard?fresh=1',{cookie:auth.cookie}),env,{fetchImpl:expired,now:()=>time})).status,401);
  assert.equal((await get('/api/dashboard')).status,401,'an expired GitHub token ends the session');
});
