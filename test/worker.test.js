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
import {selectContext,parseEdits,applyEdits,findFile,buildMessages,answer,textFiles,displayText,readableFile,WORKER_SOURCES,callModel,generalEditablePath,editPolicy} from '../worker/src/agent.js';
import {createHmac,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {handle,validateImage,webhookTargets,deployedVersion} from '../worker/src/app.js';

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
  assert.equal(store.listConversations('o/r',{home:true})[0].title,'First','conversations without a repository belong to the home repository');
  assert.deepEqual(store.listConversations('o/r'),[],'and to no other');
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
  assert.equal(parseEdits('<<<<<<< SEARCH docs/release.md\nPR-TITLE: old\n=======\nPR-TITLE: new\n>>>>>>> REPLACE').title,null,'a PR-TITLE line changed by an edit is not the title');
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

test('an edit block without a file path is matched to the one file its text belongs to',async()=>{
  const files={'README.md':'# Repo\n\nAn app, with no special configuration.\n','public/app.js':'const a=1;\n','public/b.js':'const a=1;\n','src/agent.js':'secret();\n'};
  const reply='PR-TITLE: Shorter intro\n<<<<<<< SEARCH\nAn app, with no special configuration.\n=======\nAn app.\n>>>>>>> REPLACE';
  assert.equal(parseEdits(reply).edits[0].path,null);
  const env={AI:{run:async()=>({response:reply})}};
  const result=await answer(env,{messages:[],files,existingPaths:Object.keys(files)});
  assert.equal(result.error,null);assert.equal(result.proposal.edits[0].path,'README.md','the stored proposal names the file');
  assert.deepEqual(applyEdits(result.proposal.edits,files,Object.keys(files)),[{path:'README.md',content:'# Repo\n\nAn app.\n'}]);
  assert.throws(()=>findFile('const a=1;',files),/matches several files \(public\/app\.js, public\/b\.js\)/);
  assert.throws(()=>findFile('secret();',files),/src\/agent\.js may not be edited/);
  assert.throws(()=>findFile('missing',files),/matches no file exactly/);
  assert.throws(()=>findFile('',files),/must name it/);
  assert.equal(findFile('  \n  ',{'public/w.js':'a\r\n  \r\n  \r\nb'}),'public/w.js','a whitespace-only search still matches CRLF files');
  assert.equal(displayText(reply),'','path-less blocks are left out of the PR description too');
});

test('a failed edit gets one correction round before it is reported',async()=>{
  const replies=['<<<<<<< SEARCH public/a.js\nwrong\n=======\nnew\n>>>>>>> REPLACE','<<<<<<< SEARCH public/a.js\nold\n=======\nnew\n>>>>>>> REPLACE'];
  const calls=[];const env={AI:{run:async(model,input)=>{calls.push(input);return {response:replies.shift()};}}};
  const steps=[];
  const result=await answer(env,{messages:[{role:'user',content:'x'}],files:{'public/a.js':'old\n'},existingPaths:['public/a.js'],onStep:text=>steps.push(text)});
  assert.equal(result.error,null);assert.equal(result.proposal.edits[0].search,'old');
  assert.equal(steps.length,3);assert.match(steps[1],/did not apply .*correct it/,'the correction round is reported as a step');
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
function github({calls,head='a'.repeat(40),login='owner',token='ghu_user',repoFiles=files,writeStatus=201,executable=[],refStatus=201,pullStatus=201,openPulls=[],mergeStatus=200,mergeBase='main',mergeCi='success',detailStatus=200,retargetAfter=Infinity,compareStatus=200,defaultAfter=Infinity,codex='clear',commentStatus=201,closeAfter=Infinity,headAfter=Infinity}) {
  return async(url,options={})=>{
    const method=options.method||'GET';calls.push({url,method,options});
    const ok=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
    if(url==='https://github.com/login/oauth/access_token') return ok({access_token:token,expires_in:28800,scope:''});
    if(url==='https://api.github.com/user') return ok({login});
    if(url==='https://api.github.com/user/installations?per_page=100') return ok({installations:[{id:1}]});
    if(url.startsWith('https://api.github.com/user/installations/1/repositories')) return ok({repositories:[{full_name:'owner/repo',private:false,pushed_at:'2026-10-01T00:00:00Z'},{full_name:'owner/other',private:true,pushed_at:'2026-10-02T00:00:00Z'}]});
    const path=url.replace('https://api.github.com/repos/owner/repo','');
    if(path==='') return ok({default_branch:calls.filter(c=>c.url==='https://api.github.com/repos/owner/repo').length>defaultAfter?'trunk':'main',private:false});
    if(path==='/git/ref/heads/main') return ok({object:{sha:head}});
    if(path===`/tarball/${head}`) return new Response(gzipSync(repoTar(repoFiles,executable)));
    if(path===`/git/commits/${head}`) return ok({tree:{sha:'tree0'}});
    if(method==='POST'&&path==='/git/trees') return ok({sha:'tree1'},writeStatus);
    if(method==='POST'&&path==='/git/commits') return ok({sha:'commit1'},201);
    if(method==='POST'&&path==='/git/refs') return ok({},refStatus);
    if(method==='PATCH'&&path.startsWith('/git/refs/heads/autopilot/chat-')) return ok({});
    if(method==='GET'&&path===`/compare/${head}...commit1`) return ok({files:[{filename:'public/app.js',status:'modified',additions:1,deletions:1}]},compareStatus);
    if(method==='POST'&&path==='/pulls') return ok({html_url:'https://github.com/owner/repo/pull/7'},pullStatus);
    if(method==='GET'&&path.startsWith('/pulls?state=open&head=owner%3Aautopilot%2Fchat-')) return ok(openPulls);
    if(method==='GET'&&path==='/pulls/7') return ok({number:7,state:calls.filter(c=>c.url.endsWith('/pulls/7')).length>closeAfter?'closed':'open',merged:false,title:'New title',base:{ref:calls.filter(c=>c.url.endsWith('/pulls/7')).length>retargetAfter?'release':mergeBase},head:{sha:calls.filter(c=>c.url.endsWith('/pulls/7')).length>headAfter?'d'.repeat(40):'b'.repeat(40),ref:'autopilot/chat-abc-2',repo:{full_name:'owner/repo'}}});
    if(path==='/pulls/7/reviews?per_page=100'&&codex==='findings') return ok([{user:{login:'chatgpt-codex-connector[bot]'},state:'COMMENTED',commit_id:'b'.repeat(40),submitted_at:'2026-10-13T12:00:00Z',body:'Here are some automated review suggestions for this pull request.'}],detailStatus);
    if(path==='/issues/7/comments?per_page=100'&&codex==='clear') return ok([{user:{login:'chatgpt-codex-connector[bot]'},body:"Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `bbbbbbbbbb`",created_at:'2026-10-13T12:00:00Z'}],detailStatus);
    if(/^\/(pulls\/7\/(reviews|comments|commits)|issues\/7\/(comments|reactions))\?per_page=100$/.test(path)) return ok([],detailStatus);
    if(path===`/commits/${'b'.repeat(40)}/status?per_page=100`) return ok({statuses:[]});
    if(path===`/commits/${'b'.repeat(40)}/check-runs?per_page=100`) return ok({total_count:1,check_runs:[{name:'test',status:'completed',conclusion:mergeCi}]});
    if(method==='POST'&&path==='/issues/7/comments') return ok({id:1},commentStatus);
    if(method==='PUT'&&path==='/pulls/7/merge') return ok({merged:true},mergeStatus);
    if(method==='DELETE'&&path==='/git/refs/heads/autopilot/chat-abc-2') return new Response(null,{status:204});
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
// A chat answer streams lines of JSON; this returns its steps and its last (done or error) line.
async function streamed(response) {
  assert.match(response.headers.get('Content-Type'),/ndjson/);
  const events=(await response.text()).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  return {...events.at(-1),steps:events.filter(e=>e.type==='step').map(e=>e.text)};
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
  const {conversation,type,steps}=await streamed(sent);
  assert.equal(type,'done');assert.match(steps[0],/^Read owner\/(repo|other) · main @ aaaaaaa · \d+ files$/);
  assert.ok(steps.some(step=>/^Checking 1 proposed edit against/.test(step)),steps.join(' | '));
  assert.match(conversation,/^[0-9a-f]{32}$/);
  assert.equal(inputs[0].model,'@cf/meta/llama-4-scout-17b-16e-instruct');
  assert.match(inputs[0].input.messages[0].content,/----- FILE public\/app\.js -----\nconst title="Old";/);
  assert.ok(calls.filter(c=>c.url.startsWith('https://api.github.com/repos/')).every(c=>c.options.headers.Authorization==='Bearer ghu_user'&&c.options.headers['User-Agent']));
  const thread=await (await handle(request(`/api/conversations/${conversation}`,{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal(thread.title,'Change the title in public/app.js');
  const reply=thread.messages[1];
  assert.deepEqual(reply.proposal,{title:'New title',paths:['public/app.js']});
  assert.deepEqual(reply.meta,{repository:'owner/repo',branch:'main',sha:'a'.repeat(40),read:2,files:2},'an answer records the code it was based on');
  assert.equal(thread.messages[0].meta,null);
  calls.length=0;
  const head=await (await handle(request('/api/head?repo=owner/repo',{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.deepEqual(head,{branch:'main',sha:'a'.repeat(40)});
  await handle(request('/api/head?repo=owner/repo',{cookie:auth.cookie}),env,{fetchImpl});
  assert.equal(calls.length,0,'the commit the chat just read is cached for comparisons');
  store.rows("DELETE FROM cache WHERE key = 'head:owner/repo'");
  await handle(request('/api/head?repo=owner/repo',{cookie:auth.cookie}),env,{fetchImpl});await handle(request('/api/head?repo=owner/repo',{cookie:auth.cookie}),env,{fetchImpl});
  assert.equal(calls.length,2,'the latest commit is read once and cached briefly');
  store.rows("DELETE FROM cache WHERE key = 'head:owner/repo'");
  const pushed=async(url,options)=>{if(url.endsWith('/git/ref/heads/main')) store.invalidate('owner/repo',{head:true});return fetchImpl(url,options);};
  await handle(request('/api/head?repo=owner/repo',{cookie:auth.cookie}),env,{fetchImpl:pushed});
  assert.equal(store.getCache('head:owner/repo'),null,'a commit read while a push arrived is not cached');
  assert.equal(JSON.stringify(thread).includes('ghu_user'),false);
  const created=await handle(post('/api/pull-request',auth,{conversation,message:reply.id}),env,{fetchImpl});
  assert.deepEqual(await created.json(),{url:'https://github.com/owner/repo/pull/7'});
  const tree=JSON.parse(calls.find(c=>c.method==='POST'&&c.url.endsWith('/git/trees')).options.body);
  assert.deepEqual(tree,{base_tree:'tree0',tree:[{path:'public/app.js',mode:'100644',type:'blob',content:'const title="New";\n'}]});
  const pull=JSON.parse(calls.find(c=>c.url.endsWith('/pulls')).options.body);
  assert.equal(pull.title,'New title');assert.equal(pull.base,'main');assert.match(pull.head,/^autopilot\/chat-/);assert.equal(pull.body.includes('<<<<<<<'),false);
  assert.ok(calls.some(c=>c.url.endsWith(`/compare/${'a'.repeat(40)}...commit1`)),'line counts come from GitHub\'s diff of the new commit');
  assert.match(pull.body,/^## Request\n\n> Change the title in public\/app\.js\n\n## What the agent changed\n\nRenaming the title\.\n\n## Files\n\n- `public\/app\.js`: \+1 −1 lines\n\n---\nCreated from the Repo Autopilot chat/,'the description is written from the request, the explanation and the edits');
  const writes=calls.filter(c=>c.method==='POST').length;
  assert.deepEqual(await (await handle(post('/api/pull-request',auth,{conversation,message:reply.id}),env,{fetchImpl})).json(),{url:'https://github.com/owner/repo/pull/7'});
  assert.equal(calls.filter(c=>c.method==='POST').length,writes,'a second click reuses the existing pull request');
  assert.equal((await handle(post('/api/pull-request',auth,{conversation,message:thread.messages[0].id}),env,{fetchImpl})).status,404);
  assert.equal(store.acquireLock('model','t',1),true,'the model lock is released after answering');
  // The dashboard sends the unverified items it showed and the owner confirmed; the server checks them again.
  const shown=await (await handle(request('/api/dashboard/pulls/7',{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal(shown.readiness.state,'unknown');assert.equal(shown.codex.state,'clear');
  const confirmed=shown.readiness.reasons;
  const merge=(extra={},fetch=fetchImpl)=>handle(post('/api/merge',auth,{repository:'owner/repo',number:7,sha:'b'.repeat(40),confirmed,...extra}),env,{fetchImpl:fetch});
  calls.length=0;
  store.setCache('pull:owner/repo:7:',{stale:true},60000);assert.ok(store.getCache('pull:owner/repo:7:'));
  assert.equal((await merge({sha:'c'.repeat(40)})).status,409,'a pull request with new commits is not merged');
  assert.equal(store.getCache('pull:owner/repo:7:'),null,'the refused status is not served again from the cache');
  const unconfirmed=await merge({confirmed:undefined});
  assert.equal(unconfirmed.status,409);assert.match((await unconfirmed.json()).error,/status changed: .*Check it again/,'unverified items must have been confirmed');
  assert.equal(calls.some(c=>c.method==='PUT'),false);
  const unreadable=await merge({},github({calls:[],detailStatus:503}));
  assert.equal(unreadable.status,409);assert.match((await unreadable.json()).error,/Could not check PR #7's current status/,'a status that cannot be read refuses the merge');
  const uncleared=[],waiting=await merge({},github({calls:uncleared,codex:'none'}));
  assert.equal(waiting.status,409);assert.match((await waiting.json()).error,/no Codex 👍 for its current code/,'merging needs a Codex 👍 on the current head');
  assert.equal(uncleared.some(c=>c.method==='PUT'),false);
  const failing=[],red=await merge({},github({calls:failing,mergeCi:'failure'}));
  assert.equal(red.status,409);assert.match((await red.json()).error,/not ready to merge: CI failed/);
  assert.equal(failing.some(c=>c.method==='PUT'),false,'blockers are checked again on the server before merging');
  const blocked=await merge({},github({calls:[],mergeStatus:405}));
  assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/cannot merge PR #7 yet/);
  const retargeted=await merge({},github({calls:[],mergeBase:'release'}));
  assert.equal(retargeted.status,409);assert.match((await retargeted.json()).error,/now targets release instead of the default branch main/);
  const moving=[],moved=await merge({},github({calls:moving,retargetAfter:1}));
  assert.equal(moved.status,409);assert.match((await moved.json()).error,/now targets release/,'a retarget during the status check is caught');
  assert.equal(moving.some(c=>c.method==='PUT'),false);
  const late=[],retargetedLate=await merge({},github({calls:late,retargetAfter:2}));
  assert.equal(retargetedLate.status,409);assert.match((await retargetedLate.json()).error,/now targets release/,'a retarget after the readiness checks is caught');
  assert.equal(late.some(c=>c.method==='PUT'),false);
  const renaming=[],renamed=await merge({},github({calls:renaming,defaultAfter:1}));
  assert.equal(renamed.status,409);assert.match((await renamed.json()).error,/instead of the default branch trunk/,'a new default branch during the status check is caught');
  assert.equal(renaming.some(c=>c.method==='PUT'),false);
  for(const sha of [undefined,'','b'.repeat(39),42]) assert.equal((await merge({sha})).status,400,'the reviewed head commit is required: '+sha);
  calls.length=0;
  const merged=await merge();
  assert.deepEqual(await merged.json(),{merged:true});
  assert.deepEqual(JSON.parse(calls.find(c=>c.method==='PUT').options.body),{sha:'b'.repeat(40),merge_method:'squash',commit_title:'New title (#7)'},'merged exactly at the head that was shown');
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.url.endsWith('/git/refs/heads/autopilot/chat-abc-2')),'the chat branch is removed');
  store.sql.exec('UPDATE messages SET pr_url = NULL');calls.length=0;
  assert.equal((await merge()).status,200);
  assert.equal(calls.some(c=>c.method==='DELETE'),false,'a pull request not opened from the chat keeps its branch, whatever its name');
  store.sql.exec("UPDATE messages SET pr_url = 'https://github.com/owner/repo/pull/7' WHERE id = ?",reply.id);
  assert.ok(store.getVersion('owner/repo')>0,'open dashboards reload');
  assert.equal((await merge({number:8})).status,404,'an unknown pull request is not found');
  for(const extra of [{repository:undefined},{number:'7'},{number:0}]) assert.equal((await merge(extra)).status,400);

});

test('Codex can no longer be asked to fix its findings',async()=>{
  const calls=[],{env}=environment(),fetchImpl=github({calls,codex:'findings'});
  const auth=await session(env,fetchImpl);
  assert.equal((await handle(post('/api/codex-fix',auth,{repository:'owner/repo',number:7,sha:'b'.repeat(40)}),env,{fetchImpl})).status,404);
  assert.equal(calls.some(c=>c.method==='POST'&&c.url.endsWith('/comments')),false);
  const shown=await (await handle(request('/api/dashboard/pulls/7',{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal('codexFixAsked' in shown,false);
});

test('Codex can be asked to review code it has not reviewed, once per head commit',async()=>{
  const calls=[],{env,store}=environment(),fetchImpl=github({calls,codex:'none'});
  const auth=await session(env,fetchImpl);
  const ask=(extra={},fetch=fetchImpl)=>handle(post('/api/codex-review',auth,{repository:'owner/repo',number:7,sha:'b'.repeat(40),...extra}),env,{fetchImpl:fetch});
  assert.deepEqual(await (await ask()).json(),{asked:true});
  const comments=calls.filter(c=>c.method==='POST'&&c.url.endsWith('/issues/7/comments'));
  assert.deepEqual(comments.map(c=>JSON.parse(c.options.body)),[{body:'@codex review'}],'the comment Codex reviews on');
  const shown=await (await handle(request('/api/dashboard/pulls/7',{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal(shown.codexReviewAsked,true);
  calls.length=0;
  assert.deepEqual(await (await ask()).json(),{asked:true,already:true});
  assert.equal(calls.some(c=>c.method==='POST'&&c.url.endsWith('/comments')),false,'asked at most once per commit');
  const seen=github({calls:[],codex:'none'}),visible=async(url,options)=>url.endsWith('/issues/7/comments?per_page=100')?Response.json([{user:{login:'owner'},body:'@codex review',created_at:'2026-10-13T12:00:00Z'}]):seen(url,options);
  assert.deepEqual(await (await ask({},visible)).json(),{asked:true,already:true},'a retry after the posted request shows up on GitHub is still answered as already asked');
  store.rows('DELETE FROM codex_reviews');
  for(const [codex,reason] of [['clear',/already cleared/],['findings',/has findings/]]) {
    const seen=[],refused=await ask({sha:'b'.repeat(40)},github({calls:seen,codex}));
    assert.equal(refused.status,409);assert.match((await refused.json()).error,reason);
    assert.equal(seen.some(c=>c.method==='POST'&&c.url.endsWith('/comments')),false);
  }
  assert.equal((await ask({sha:'c'.repeat(40)})).status,409,'only for the head commit that was shown');
  const base=github({calls:[],codex:'none'}),cut=[];
  const full=await ask({},async(url,options)=>{cut.push({url,method:options?.method||'GET'});return url.endsWith('/issues/7/reactions?per_page=100')?Response.json(Array.from({length:100},()=>({user:{login:'someone'},content:'+1'}))):base(url,options);});
  assert.equal(full.status,409);assert.match((await full.json()).error,/history is too long/,'a cut-off history may hide a request, so no review is asked for');
  assert.equal(cut.some(c=>c.method==='POST'&&c.url.endsWith('/comments')),false);
  const longer=await ask({},async(url,options)=>url.endsWith('/pulls/7/commits?per_page=100')?Response.json(Array.from({length:100},(_,i)=>({sha:String(i).padStart(40,'0'),commit:{committer:{date:'2026-10-01T00:00:00Z'}}}))):base(url,options));
  assert.equal(longer.status,409);assert.match((await longer.json()).error,/history is too long/,'a commit list without the head cannot date its requests');
  const pushing=[],pushed=await ask({},github({calls:pushing,codex:'none',headAfter:2}));
  assert.equal(pushed.status,409);assert.match((await pushed.json()).error,/new commits/,'a push during the status check is caught before posting');
  assert.equal(pushing.some(c=>c.method==='POST'&&c.url.endsWith('/comments')),false);
});

test('pull requests keep file modes and can be retried after a partial failure',async()=>{
  const calls=[],{env,store}=environment();
  env.AI.run=async()=>({response:'<<<<<<< SEARCH public/app.js\nconst title="Old";\n=======\nconst title="New";\n>>>>>>> REPLACE'});
  const auth=await session(env,github({calls}));
  const {conversation}=await streamed(await handle(post('/api/chat',auth,{text:'Change it'}),env,{fetchImpl:github({calls})}));
  const message=store.getConversation(conversation).messages[1].id;
  const failed=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:github({calls,pullStatus:502,executable:['public/app.js']})});
  assert.equal(failed.status,500);assert.match((await failed.json()).error,/HTTP 502/);
  assert.equal(JSON.parse(calls.findLast(c=>c.url.endsWith('/git/trees')&&c.method==='POST').options.body).tree[0].mode,'100755','executable files stay executable');
  const branch=JSON.parse(calls.findLast(c=>c.url.endsWith('/git/refs')).options.body).ref.replace('refs/heads/','');
  // Leftover branch without a pull request: it is moved to the new commit and the PR is opened.
  calls.length=0;
  const retried=await handle(post('/api/pull-request',auth,{conversation,message}),env,{fetchImpl:github({calls,refStatus:422,compareStatus:500})});
  assert.deepEqual(await retried.json(),{url:'https://github.com/owner/repo/pull/7'});
  assert.match(JSON.parse(calls.find(c=>c.method==='POST'&&c.url.endsWith('/pulls')).options.body).body,/## Files\n\n- `public\/app\.js`\n\n---/,'without GitHub\'s counts the files are still listed');
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
  const {conversation}=await streamed(await handle(post('/api/chat',auth,{text:'Change it'}),env,{fetchImpl:github({calls})}));
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
  const failure=await streamed(failed);
  assert.equal(failure.type,'error');assert.match(failure.error,/Account limited/);
  assert.equal(store.acquireLock('model','t2',1),true,'a failed answer releases the model lock');store.releaseLock('model','t2');
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
    if(url==='https://api.github.com/user/installations?per_page=100') return ok({installations:[{id:1}]});
    if(url.startsWith('https://api.github.com/user/installations/1/repositories')) return ok({repositories:[{full_name:'owner/repo',private:false,pushed_at:'2026-10-01T00:00:00Z'},{full_name:'owner/other',private:true,pushed_at:'2026-10-02T00:00:00Z'}]});
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
  const repoCalls=()=>calls.filter(c=>c.url.startsWith('https://api.github.com/repos/'));
  const get=(path)=>handle(request(path,{cookie:auth.cookie}),env,{fetchImpl,now:()=>time});
  calls.length=0;
  const overview=await (await get('/api/dashboard')).json();
  assert.equal(overview.repository,'owner/repo');
  assert.deepEqual(overview.pulls.map(p=>[p.number,p.state]),[[1,'open'],[2,'merged']]);
  assert.equal(overview.workflows[0].runNumber,12);
  assert.equal(repoCalls().length,3,'the overview needs three GitHub calls');
  assert.ok(calls.every(c=>c.options.headers['User-Agent']==='repo-autopilot-chat'&&c.options.headers.Authorization==='Bearer ghu_user'),'Workers requests identify themselves to GitHub');
  calls.length=0;
  // "Show more" asks for larger lists in steps; each size has its own cache entry.
  await get('/api/dashboard?pulls=12&runs=30');
  assert.ok(calls.some(c=>c.url.includes('/pulls?')&&c.url.includes('per_page=12'))&&calls.some(c=>c.url.includes('/actions/runs?per_page=30')));
  assert.ok(store.getCache('overview:owner/repo:12:30'));
  for(const bad of ['pulls=7','pulls=36','runs=0','runs=75','pulls=x','pulls=012']) assert.equal((await get(`/api/dashboard?${bad}`)).status,400,bad);
  calls.length=0;
  const detail=await (await get('/api/dashboard/pulls/1?updated=2026-10-01T00:00:00Z')).json();
  assert.equal(detail.number,1);assert.equal(detail.ci,'success');assert.equal(detail.state,'open');assert.ok(detail.readiness.label);
  assert.ok(repoCalls().length<=10,`one pull request needs at most ten GitHub calls (used ${repoCalls().length})`);
  assert.equal(calls.filter(c=>c.url.endsWith('/pulls/1')).length,2,'an open pull request is read again after its details');
  assert.ok(calls.filter(c=>c.url==='https://api.github.com/graphql').every(c=>c.options.headers['User-Agent']));
  calls.length=0;
  await get('/api/dashboard');await get('/api/dashboard/pulls/1?updated=2026-10-01T00:00:00Z');
  assert.equal(repoCalls().length,0,'repeated loads within a minute come from the cache');
  await get('/api/dashboard/pulls/1?updated=2026-10-05T00:00:00Z');
  assert.ok(repoCalls().length>0,'a newer updatedAt bypasses the cache');
  calls.length=0;await get('/api/dashboard?fresh=1');
  assert.equal(repoCalls().length,3,'Refresh bypasses the cache');
  calls.length=0;time+=61000;await get('/api/dashboard');
  assert.equal(repoCalls().length,3,'cached data expires after a minute');
  calls.length=0;
  await get('/api/dashboard/pulls/2?updated=x');time+=600000;await get('/api/dashboard/pulls/2?updated=x');
  assert.ok(repoCalls().length>0&&repoCalls().length<=10);
  const before=repoCalls().length;await get('/api/dashboard/pulls/2?updated=x');
  assert.equal(repoCalls().length,before,'merged pull requests stay cached for longer');
  for(const path of ['/api/dashboard/pulls/0','/api/dashboard/pulls/abc','/api/dashboard/other']) assert.equal((await get(path)).status,404,path);
  assert.equal((await get(`/api/dashboard/pulls/1?updated=${'x'.repeat(41)}`)).status,400);
  assert.equal((await handle(request('/api/dashboard'),env,{fetchImpl})).status,401,'the dashboard requires sign-in');
  const failing=async(url,options)=>url.startsWith('https://api.github.com/repos/')?new Response('{}',{status:502}):fetchImpl(url,options);
  const failed=await handle(request('/api/dashboard?fresh=1',{cookie:auth.cookie}),env,{fetchImpl:failing,now:()=>time});
  assert.equal(failed.status,502,'GitHub refusals are reported as such, not as server errors');
  assert.equal(store.getCache('overview:owner/repo')?.refused,undefined,'GitHub server errors are not cached');assert.match((await failed.json()).error,/GitHub request failed \(502\)/);
  const missing=async(url,options)=>/\/pulls\/77$/.test(url)?new Response('{}',{status:404}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard/pulls/77',{cookie:auth.cookie}),env,{fetchImpl:missing,now:()=>time})).status,404);
  // A pull request whose details partly failed is shown, but not cached.
  const flaky=async(url,options)=>/\/pulls\/2\/reviews/.test(url)?new Response('{}',{status:503}):fetchImpl(url,options);
  const partial=await (await handle(request('/api/dashboard/pulls/2?updated=y',{cookie:auth.cookie}),env,{fetchImpl:flaky,now:()=>time})).json();
  assert.match(partial.detailError,/503/);assert.equal(partial.unresolvedThreads,0,'verification still succeeds next to a partial failure');
  assert.ok(store.getCache('pull:owner/repo:2:y'),'a partial failure is cached briefly');
  time+=31000;assert.equal(store.getCache('pull:owner/repo:2:y'),null,'and retried after 30 seconds');
  const limited=async(url,options)=>url.includes('/actions/runs')||url.endsWith('/repos/owner/repo')?new Response('{}',{status:429}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard?fresh=1',{cookie:auth.cookie}),env,{fetchImpl:limited,now:()=>time})).status,429,'rate limits keep their status');
  calls.length=0;
  assert.equal((await get('/api/dashboard')).status,429,'a refusal is remembered briefly');assert.equal(repoCalls().length,0);
  time+=31000;
  // A push between the two reads of an open pull request is reported and not cached.
  let reads=0;
  const pushed=async(url,options)=>{if(/\/pulls\/1$/.test(url)&&++reads===2) return Response.json({...pulls[0],head:{sha:'f'.repeat(40)}});return fetchImpl(url,options);};
  const changed=await (await handle(request('/api/dashboard/pulls/1?updated=z',{cookie:auth.cookie}),env,{fetchImpl:pushed,now:()=>time})).json();
  assert.match(changed.detailError,/changed during loading/);assert.equal(changed.headSha,'f'.repeat(40));
  assert.equal(store.getCache('pull:owner/repo:1:z'),null,'a pull request that changed while loading is read again next time');
  const expired=async(url,options)=>url.startsWith('https://api.github.com/repos/')?new Response('{}',{status:401}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard?fresh=1',{cookie:auth.cookie}),env,{fetchImpl:expired,now:()=>time})).status,401);
  assert.equal((await get('/api/dashboard')).status,401,'an expired GitHub token ends the session');
  // An expired token found while loading details also ends the session instead of showing missing details.
  const again=await session(env,fetchImpl);
  const lateExpiry=async(url,options)=>/\/pulls\/1\/reviews/.test(url)?new Response('{}',{status:401}):fetchImpl(url,options);
  assert.equal((await handle(request('/api/dashboard/pulls/1?updated=w',{cookie:again.cookie}),env,{fetchImpl:lateExpiry,now:()=>time})).status,401);
  assert.equal((await handle(request('/api/dashboard',{cookie:again.cookie}),env,{fetchImpl,now:()=>time})).status,401);
});

test('other repositories use the general edit rules; the app\'s own repository keeps the strict ones',()=>{
  for(const path of ['src/App.tsx','app/page.tsx','lib/util.ts','styles/main.scss','docs/guide.md','server/main.py','index.html','components/Card.vue','cmd/server/main.go','src/lib.rs','app/src/main/java/App.java','Program.cs','lib/thing.rb','src/Kernel.php','src/main.cpp','Sources/App/main.swift','lib/app.ex','src/main/scala/project/App.scala','R/analysis.R','src/App.TSX','bin/cli.js','src/build-tools.ts'])
    assert.equal(generalEditablePath(path),true,path);
  for(const path of ['.github/workflows/ci.yml','.env','src/.env.local','package.json','package-lock.json','tsconfig.json','vite.config.ts','next.config.mjs','requirements.txt','api/requirements-dev.txt','setup.py','node_modules/x/index.js','dist/app.js','src/../x.ts','/abs.ts','a//b.ts','deploy.sh','src\\a.ts','src/data.json','dev-requirements.txt','requirements/base.txt','constraints.txt','CMakeLists.txt','tests/conftest.py','noxfile.py','docs/conf.py','gulpfile.js','Gruntfile.js','karma.conf.js','webpack.prod.js','vitest.workspace.ts','Vite.Config.ts','vite.config.prod.ts','build.rs','build.gradle.kts','pom.xml','go.mod','Cargo.toml','Package.swift','project.clj','build.clj','mix.exs','Setup.hs','conanfile.py','fabfile.py','magefile.go','premake5.lua','project/Dependencies.scala','wdio.conf.ts','karma.conf.cjs','target/generated-sources/Foo.java','obj/Debug/Foo.cs','bin/Debug/Foo.cs','App/bin/Release/x.cs','DerivedData/Foo.swift','Pods/A/B.swift','_build/dev/x.ex','deps/phoenix/lib/x.ex','src/__pycache__/a.py','Build/out.js','webpack.dev.cjs','webpack.prod.mjs','webpack.common.ts','gulpfile.babel.js','rollup.base.mjs',42])
    assert.equal(generalEditablePath(path),false,String(path));
  assert.equal(editPolicy('Owner/Repo','owner/repo').allowed('src/App.tsx'),false,'the home repository keeps its strict list');
  assert.equal(editPolicy('owner/other','owner/repo').allowed('src/App.tsx'),true);
  assert.throws(()=>applyEdits([{path:'.github/workflows/ci.yml',search:'',replace:'x'}],{},[],generalEditablePath),/may not be edited/);
});

test('store adds the repository column to conversations saved before repository selection',()=>{
  const db=sqlite();
  db.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)');
  db.exec('INSERT INTO conversations (id, title, created, updated) VALUES (?, ?, 1, 1)','a'.repeat(32),'Old');
  const store=new ChatStoreLogic(db,()=>5);
  new ChatStoreLogic(db,()=>5);
  assert.deepEqual(store.listConversations('owner/repo',{home:true}).map(c=>c.title),['Old'],'old conversations belong to the home repository');
  assert.deepEqual(store.listConversations('owner/other'),[]);
  store.saveExchange({conversation:'b'.repeat(32),title:'New',repository:'Owner/Other',user:{content:'q'},assistant:{content:'a'}});
  assert.deepEqual(store.listConversations('owner/other').map(c=>c.title),['New'],'repository names compare without case');
  assert.deepEqual({...store.getConversationInfo('b'.repeat(32))},{title:'New',repository:'Owner/Other'});
  const sha='c'.repeat(40);
  store.setCache('overview:owner/repo',1,60000);store.setCache('overview:owner/repo:12:15',1,60000);store.setCache('overview:owner/repo2:12:15',1,60000);store.setCache('pull:owner/repo2:5:x',1,60000);store.setCache('pull:owner/repo:50:x',1,60000);
  for(const number of [5,6]) store.setDashboardCache(`pull:owner/repo:${number}:x`,{number},60000,{repository:'Owner/Repo',version:0,pull:{number,sha:number===6?sha:'d'.repeat(40)}});
  assert.equal(store.invalidate('Owner/Repo',{overview:true,pulls:[5]}),1);
  assert.deepEqual(store.rows('SELECT key FROM cache ORDER BY key').map(r=>r.key),['overview:owner/repo2:12:15','pull:owner/repo2:5:x','pull:owner/repo:50:x','pull:owner/repo:6:x'],'only PR 5 and the overviews of this repository are dropped');
  assert.equal(store.invalidate('owner/repo',{sha:'e'.repeat(40)}),null,'a commit of no loaded pull request changes nothing');
  assert.equal(store.invalidate('owner/repo',{sha}),2,'a check on a pull request\'s head commit drops that pull request');
  assert.deepEqual(store.rows('SELECT key FROM cache ORDER BY key').map(r=>r.key),['overview:owner/repo2:12:15','pull:owner/repo2:5:x','pull:owner/repo:50:x']);
  assert.equal(store.getVersion('OWNER/REPO'),2);assert.equal(store.getVersion('owner/other'),0);
  store.setDashboardCache('pull:owner/repo:7:x',{},60000,{repository:'owner/repo',version:1});
  assert.equal(store.getCache('pull:owner/repo:7:x'),null,'data loaded before a webhook event is not cached');
  store.setDashboardCache('pull:owner/repo:5:y',{},60000,{repository:'owner/repo',version:1,pull:{number:5,sha:'f'.repeat(40)}});
  assert.deepEqual(store.rows('SELECT sha FROM heads WHERE number = 5').map(r=>r.sha),['d'.repeat(40)],'nor does it replace a newer head commit');
  store.setDashboardCache('pull:owner/repo:7:x',{},60000,{repository:'owner/repo',version:2});
  assert.deepEqual(store.getCache('pull:owner/repo:7:x'),{});
  store.setCache('head:owner/repo',{sha:'x'},60000);
  assert.equal(store.invalidate('owner/repo',{head:true}),3);assert.equal(store.getCache('head:owner/repo'),null,'a push drops the cached latest commit');
  const first=store.startDashboardLoad('owner/repo'),late='1'.repeat(40);
  assert.equal(store.invalidate('owner/repo',{sha:late}),null,'a status for a commit not loaded yet changes nothing at once');
  store.setDashboardCache('pull:owner/repo:8:x',{},60000,{repository:'owner/repo',...first,pull:{number:8,sha:late}});
  assert.equal(store.getCache('pull:owner/repo:8:x'),null,'a first load that overlapped a status for its commit is not cached');
  assert.equal(store.getVersion('owner/repo'),4,'and open dashboards reload once');
  store.setDashboardCache('pull:owner/repo:8:x',{},60000,{repository:'owner/repo',...store.startDashboardLoad('owner/repo'),pull:{number:8,sha:late}});
  assert.deepEqual(store.getCache('pull:owner/repo:8:x'),{},'the reload is cached');
  assert.equal(store.invalidate('owner/repo',{sha:late}),5,'later events for the commit find the pull request');
});

test('the repository list shows where the app is installed and limits every API call to it',async()=>{
  const calls=[],{env}=environment(),fetchImpl=github({calls});
  const auth=await session(env,fetchImpl);
  const get=path=>handle(request(path,{cookie:auth.cookie}),env,{fetchImpl});
  const installationCalls=()=>calls.filter(c=>c.url.includes('/user/installations')).length;
  calls.length=0;
  assert.equal((await get('/api/conversations')).status,200);assert.equal((await get('/api/conversations?repo=OWNER/REPO')).status,200);
  assert.equal(installationCalls(),0,'the app\'s own repository needs no lookup');
  assert.deepEqual(await (await get('/api/repos')).json(),{home:'owner/repo',repositories:[{fullName:'owner/other',private:true,pushedAt:'2026-10-02T00:00:00Z'},{fullName:'owner/repo',private:false,pushedAt:'2026-10-01T00:00:00Z'}]});
  const listed=installationCalls();
  assert.equal((await get('/api/conversations?repo=owner/other')).status,200);
  assert.equal(installationCalls(),listed,'the list is cached');
  await get('/api/repos?fresh=1');assert.ok(installationCalls()>listed,'Reload list reads GitHub again');
  calls.length=0;
  const missing=await get('/api/dashboard?repo=owner/private-elsewhere');
  assert.equal(missing.status,403);assert.match((await missing.json()).error,/Install the GitHub App/);
  assert.ok(installationCalls()>0,'an unknown repository is looked up once more in case the app was just installed');
  assert.equal(calls.some(c=>c.url.includes('/repos/owner/private-elsewhere')),false,'GitHub is never asked for a repository outside the list');
  for(const repo of ['owner/..','not-a-repo','a/b/c']) assert.equal((await get(`/api/conversations?repo=${encodeURIComponent(repo)}`)).status,400,repo);
  assert.equal((await handle(post('/api/chat',auth,{text:'hi',repo:'owner/private-elsewhere'}),env,{fetchImpl})).status,403);
  const alone=environment(),only=async(url,options)=>url.includes('/user/installations/')?Response.json({repositories:[{full_name:'owner/other'}]}):github({calls:[]})(url,options);
  const soloAuth=await session(alone.env,only);
  assert.deepEqual((await (await handle(request('/api/repos',{cookie:soloAuth.cookie}),alone.env,{fetchImpl:only})).json()).repositories.map(r=>r.fullName),['owner/repo','owner/other'],'the app\'s own repository is always listed');
});

test('chat in another repository keeps its conversations there and uses the general edit rules',async()=>{
  const calls=[],{env}=environment();
  const base=github({calls:[],repoFiles:{'src/App.tsx':'export const title="Old";\n','.github/workflows/ci.yml':'on: push\n','README.md':'# Other\n'}});
  const fetchImpl=async(url,options={})=>{calls.push({url,method:options.method||'GET'});return base(url.replace('/repos/owner/other','/repos/owner/repo'),options);};
  const inputs=[];
  env.AI.run=async(model,input)=>{inputs.push(input);return {response:'PR-TITLE: New title\n<<<<<<< SEARCH src/App.tsx\nexport const title="Old";\n=======\nexport const title="New";\n>>>>>>> REPLACE'};};
  const auth=await session(env,fetchImpl);
  calls.length=0;
  const sent=await handle(post('/api/chat',auth,{text:'Change the title in src/App.tsx',repo:'owner/other'}),env,{fetchImpl});
  assert.equal(sent.status,200);
  const {conversation,type,steps}=await streamed(sent);
  assert.equal(type,'done');assert.match(steps[0],/^Read owner\/(repo|other) · main @ aaaaaaa · \d+ files$/);
  assert.ok(steps.some(step=>/^Checking 1 proposed edit against/.test(step)),steps.join(' | '));
  assert.match(inputs[0].messages[0].content,/Repository: owner\/other,/);
  assert.match(inputs[0].messages[0].content,/never files in hidden folders/);
  assert.ok(calls.some(c=>c.url.includes('/repos/owner/other/tarball/')),'the selected repository is read');
  assert.equal(calls.some(c=>c.url.includes('/repos/owner/repo/')),false,'the app\'s own repository is not touched');
  const list=repo=>handle(request(`/api/conversations?repo=${repo}`,{cookie:auth.cookie}),env,{fetchImpl}).then(r=>r.json()).then(r=>r.conversations.map(c=>c.id));
  assert.deepEqual(await list('owner/other'),[conversation]);assert.deepEqual(await list('owner/repo'),[]);
  const thread=await (await handle(request(`/api/conversations/${conversation}`,{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal(thread.repository,'owner/other');assert.deepEqual(thread.messages[1].proposal.paths,['src/App.tsx']);
  const moved=await handle(post('/api/chat',auth,{conversation,text:'more',repo:'owner/repo'}),env,{fetchImpl});
  assert.equal(moved.status,409,'a conversation cannot move to another repository');
  calls.length=0;
  const created=await handle(post('/api/pull-request',auth,{conversation,message:thread.messages[1].id}),env,{fetchImpl});
  assert.equal(created.status,200);
  assert.ok(calls.some(c=>c.method==='POST'&&c.url==='https://api.github.com/repos/owner/other/pulls'),'the pull request is opened in the conversation\'s repository');
  env.AI.run=async()=>({response:'<<<<<<< SEARCH .github/workflows/ci.yml\non: push\n=======\non: pull_request\n>>>>>>> REPLACE'});
  const refused=await streamed(await handle(post('/api/chat',auth,{text:'Change CI',repo:'owner/other'}),env,{fetchImpl}));
  const answer=await (await handle(request(`/api/conversations/${refused.conversation}`,{cookie:auth.cookie}),env,{fetchImpl})).json();
  assert.equal(answer.messages[1].proposal,null,'workflows in other repositories cannot be edited');
});

const WEBHOOK_SECRET='webhook-secret-value';
const hook=(payload,{event='pull_request',secret=WEBHOOK_SECRET,signature,method='POST'}={})=>{
  const body=typeof payload==='string'?payload:JSON.stringify(payload);
  const headers={'X-GitHub-Event':event,'Content-Type':'application/json'};
  const sig=signature??`sha256=${createHmac('sha256',secret).update(body).digest('hex')}`;
  if(sig) headers['X-Hub-Signature-256']=sig;
  return new Request(`${ORIGIN}/api/webhook`,{method,headers,body:method==='POST'?body:undefined});
};

test('webhook events verified with the secret drop affected cache entries and move the version on',async()=>{
  const {env,store}=environment(),fetchImpl=github({calls:[]});
  const payload={action:'synchronize',pull_request:{number:5},repository:{full_name:'Owner/Repo'}};
  assert.equal((await handle(hook(payload),env,{fetchImpl})).status,404,'without a secret the endpoint is off');
  env.WEBHOOK_SECRET=WEBHOOK_SECRET;
  assert.equal((await handle(hook(payload,{method:'GET'}),env,{fetchImpl})).status,405);
  assert.equal((await handle(hook({zen:'hi'},{event:'ping'}),{...env,CHAT_ORIGIN:'https://autopilot.example.com'},{fetchImpl})).status,204,'deliveries to the workers.dev address work with a custom origin');
  for(const options of [{signature:''},{secret:'wrong'},{signature:'sha256=abc'},{signature:'sha1=0000000000000000000000000000000000000000'}])
    assert.equal((await handle(hook(payload,options),env,{fetchImpl})).status,401,JSON.stringify(options));
  assert.equal(store.getVersion('owner/repo'),0,'unsigned events change nothing');
  assert.equal((await handle(hook('not json'),env,{fetchImpl})).status,400);
  store.setCache('overview:owner/repo',1,60000);store.setCache('pull:owner/repo:5:x',1,60000);store.setCache('pull:owner/repo:6:x',1,60000);
  const accepted=await handle(hook(payload),env,{fetchImpl});
  assert.equal(accepted.status,204);
  assert.deepEqual(store.rows('SELECT key FROM cache ORDER BY key').map(r=>r.key),['pull:owner/repo:6:x']);
  assert.equal((await handle(hook({zen:'hi',repository:{full_name:'owner/repo'}},{event:'ping'}),env,{fetchImpl})).status,204);
  assert.equal((await handle(hook({sha:'f'.repeat(40),repository:{full_name:'owner/repo'}},{event:'status'}),env,{fetchImpl})).status,204);
  assert.equal(store.getVersion('owner/repo'),1,'events that change nothing shown do not reload dashboards');
  const big='x'.repeat(5000001);
  assert.equal((await handle(hook(big),env,{fetchImpl})).status,413);
  const auth=await session(env,fetchImpl);
  const version=repo=>handle(request(`/api/dashboard/version?repo=${repo}`,{cookie:auth.cookie}),env,{fetchImpl});
  assert.deepEqual(await (await version('owner/repo')).json(),{version:1});
  assert.deepEqual(await (await version('owner/other')).json(),{version:0});
  assert.equal((await version('owner/..')).status,400);
  assert.equal((await handle(request('/api/dashboard/version?repo=owner/repo'),env,{fetchImpl})).status,401,'the version requires sign-in');
});

test('webhook events map to the dashboard data they change',()=>{
  assert.deepEqual(webhookTargets('pull_request',{pull_request:{number:3}}),{overview:true,pulls:[3]});
  assert.deepEqual(webhookTargets('pull_request_review_thread',{pull_request:{number:3}}),{overview:true,pulls:[3]});
  assert.deepEqual(webhookTargets('issue_comment',{issue:{number:4,pull_request:{}}}),{overview:true,pulls:[4]});
  assert.equal(webhookTargets('issue_comment',{issue:{number:4}}),null,'comments on plain issues change nothing shown');
  const sha='a'.repeat(40);
  assert.deepEqual(webhookTargets('check_run',{check_run:{head_sha:sha,pull_requests:[{number:2},{number:'x'}]}}),{overview:false,pulls:[2],sha});
  assert.deepEqual(webhookTargets('check_suite',{check_suite:{head_sha:'main',pull_requests:[]}}),{overview:false,pulls:[],sha:null});
  assert.deepEqual(webhookTargets('status',{sha}),{overview:false,pulls:[],sha});
  assert.deepEqual(webhookTargets('workflow_run',{workflow_run:{pull_requests:[{number:9}]}}),{overview:true,pulls:[9]});
  for(const event of ['ping','push','installation','star']) assert.equal(webhookTargets(event,{}),null,event);
  assert.deepEqual(webhookTargets('push',{ref:'refs/heads/main',repository:{default_branch:'main'}}),{overview:false,pulls:[],head:true});
  assert.equal(webhookTargets('push',{ref:'refs/heads/feature',repository:{default_branch:'main'}}),null,'pushes to other branches change nothing shown');
});

test('the session reports the deployed commit only when the deploy workflow recorded a valid one',async()=>{
  const sha='ABCDEF0123456789abcdef0123456789abcdef01';
  assert.deepEqual(deployedVersion({DEPLOYED_COMMIT:sha,DEPLOYED_AT:'2026-10-13T18:30:00Z'}),{commit:sha.toLowerCase(),at:'2026-10-13T18:30:00.000Z'});
  assert.deepEqual(deployedVersion({DEPLOYED_COMMIT:sha,DEPLOYED_AT:'soon'}),{commit:sha.toLowerCase(),at:null});
  for(const commit of [undefined,'','abc1234',`${sha}0`,'<script>']) assert.equal(deployedVersion({DEPLOYED_COMMIT:commit}),null);
  const {env}=environment(),fetchImpl=github({calls:[]});
  assert.equal((await session(env,fetchImpl)).info.deployed,null);
  const deployed=environment();
  assert.equal((await session({...deployed.env,DEPLOYED_COMMIT:sha},fetchImpl)).info.deployed.commit,sha.toLowerCase());
  assert.equal((await (await handle(request('/api/session'),{...deployed.env,DEPLOYED_COMMIT:sha},{fetchImpl})).json()).deployed,undefined,'signed-out visitors see no version');
});

test('a chat app connects through OAuth, reads through MCP, keeps working after the GitHub token expires, and can be revoked',async()=>{
  let time=1_000_000;
  const {env,store}=environment({time:()=>time});
  const calls=[],base=github({calls});
  let renewals=0;
  const fetchImpl=async(url,options={})=>{
    if(url==='https://github.com/login/oauth/access_token') {
      const body=JSON.parse(options.body);calls.push({url,method:'POST',options});
      if(body.grant_type==='refresh_token') {renewals++;return Response.json(body.refresh_token===`ghr_${renewals}`?{access_token:`ghu_renewed${renewals}`,expires_in:28800,refresh_token:`ghr_${renewals+1}`,refresh_token_expires_in:15811200}:{error:'bad_refresh_token'});}
      return Response.json({access_token:'ghu_first',expires_in:28800,refresh_token:'ghr_1',refresh_token_expires_in:15811200,scope:''});
    }
    return base(url,options);
  };
  const call=(path,options={})=>handle(request(path,options),env,{fetchImpl,now:()=>time});
  const form=(path,fields,headers={})=>handle(new Request(ORIGIN+path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams(fields)}),env,{fetchImpl,now:()=>time});

  const resource=await (await call('/.well-known/oauth-protected-resource')).json();
  assert.deepEqual([resource.resource,resource.authorization_servers],[`${ORIGIN}/mcp`,[ORIGIN]]);
  const metadata=await (await call('/.well-known/oauth-authorization-server')).json();
  assert.equal(metadata.registration_endpoint,`${ORIGIN}/oauth/register`);assert.ok(metadata.scopes_supported.includes('offline_access'),'ChatGPT looks for offline_access before relying on refresh tokens');assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
  const anonymous=await call('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'initialize'}});
  assert.equal(anonymous.status,401);assert.match(anonymous.headers.get('WWW-Authenticate'),/resource_metadata="https:\/\/chat\.example\.workers\.dev\/\.well-known\/oauth-protected-resource"/);

  assert.equal((await call('/oauth/register',{method:'POST',body:{redirect_uris:['http://evil.example/cb']}})).status,400,'redirects must be https or local');
  const registered=await call('/oauth/register',{method:'POST',body:{client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback'],token_endpoint_auth_method:'none'}});
  assert.equal(registered.status,201);
  const {client_id}=await registered.json();
  const verifier='v'.repeat(50),challenge=createHash('sha256').update(verifier).digest('base64url');
  const authorize=(extra={})=>call(`/oauth/authorize?${new URLSearchParams({response_type:'code',client_id,redirect_uri:'https://claude.ai/api/mcp/auth_callback',code_challenge:challenge,code_challenge_method:'S256',state:'xyz',resource:`${ORIGIN}/mcp`,...extra})}`);
  assert.equal((await authorize({redirect_uri:'https://evil.example/cb'})).status,400,'an unregistered redirect is never followed');
  const consent=await authorize();
  assert.equal(consent.status,200);
  const html=await consent.text();
  assert.match(html,/Claude/);assert.match(html,/claude\.ai/);assert.match(html,/cannot change, comment on or merge anything/);
  assert.match(consent.headers.get('Content-Security-Policy'),/form-action 'self' https:\/\/github\.com https:\/\/claude\.ai/);
  const sealed=html.match(/name="request" value="([^"]+)"/)[1],nonce=html.match(/name="consent" value="([0-9a-f]+)"/)[1];
  const consentCookie=consent.headers.get('Set-Cookie').split(';')[0];
  const fields={request:sealed,consent:nonce,decision:'allow'};
  assert.equal((await form('/oauth/authorize',fields,{Origin:'https://evil.example',Cookie:consentCookie})).status,400,'another site cannot submit the consent');
  assert.equal((await form('/oauth/authorize',fields,{Origin:ORIGIN})).status,400,'the consent cookie must come with it');
  assert.equal(consent.headers.get('Referrer-Policy'),'same-origin','browsers may name the origin when the form is sent');
  assert.equal((await form('/oauth/authorize',fields,{Origin:'null',Cookie:consentCookie,'Sec-Fetch-Site':'cross-site'})).status,400,'a withheld origin needs the browser\'s same-site signal');
  const nullOrigin=await form('/oauth/authorize',{...fields,decision:'deny'},{Origin:'null',Cookie:consentCookie,'Sec-Fetch-Site':'same-origin'});
  assert.equal(nullOrigin.status,303,'a browser that withholds the origin but reports same-origin is accepted');
  const denied=await form('/oauth/authorize',{...fields,decision:'deny'},{Origin:ORIGIN,Cookie:consentCookie});
  assert.match(denied.headers.get('Location'),/^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=access_denied/);
  const allowed=await form('/oauth/authorize',fields,{Origin:ORIGIN,Cookie:consentCookie});
  assert.equal(allowed.status,303);
  const toGithub=new URL(allowed.headers.get('Location'));
  assert.equal(toGithub.origin+toGithub.pathname,'https://github.com/login/oauth/authorize');
  const browser=allowed.headers.getSetCookie().find(c=>c.startsWith('autopilot_login=')).match(/autopilot_login=([0-9a-f]+)/)[1];
  const back=await call(`/auth/callback?code=c&state=${encodeURIComponent(toGithub.searchParams.get('state'))}`,{cookie:`autopilot_login=${browser}`});
  assert.equal(back.status,303);
  const returned=new URL(back.headers.get('Location'));
  assert.equal(returned.origin+returned.pathname,'https://claude.ai/api/mcp/auth_callback');
  assert.deepEqual([returned.searchParams.get('state'),returned.searchParams.get('iss')],['xyz',ORIGIN]);
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM sessions')[0].n,0,'connecting opens no dashboard session');
  assert.equal(store.rows('SELECT github FROM oauth_grants')[0].github.includes('ghr_'),false,'GitHub tokens are stored sealed');

  const code=returned.searchParams.get('code');
  const exchange=fields=>form('/oauth/token',{grant_type:'authorization_code',code,redirect_uri:'https://claude.ai/api/mcp/auth_callback',client_id,...fields});
  assert.equal((await (await exchange({code_verifier:'w'.repeat(50)})).json()).error,'invalid_grant','the PKCE verifier must match');
  const tokens=await (await exchange({code_verifier:verifier})).json();
  assert.equal((await (await exchange({code_verifier:verifier})).json()).error,'invalid_grant','a code is used once');
  assert.equal(tokens.token_type,'Bearer');
  const rpc=(method,params,token=tokens.access_token)=>call('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method,params},headers:{Authorization:`Bearer ${token}`}});
  const init=await (await rpc('initialize',{protocolVersion:'2025-06-18'})).json();
  assert.equal(init.result.protocolVersion,'2025-06-18');assert.equal(init.result.serverInfo.name,'repo-autopilot');
  const {result:{tools}}=await (await rpc('tools/list')).json();
  assert.ok(tools.every(t=>t.annotations.readOnlyHint===true),'every tool only reads');
  const listed=await (await rpc('tools/call',{name:'list_repositories',arguments:{}})).json();
  assert.match(listed.result.content[0].text,/owner\/repo/);
  assert.equal(listed.result.structuredContent.truncated,false);
  assert.equal(calls.filter(c=>c.url.includes('/user/installations')).at(-1).options.headers.Authorization,'Bearer ghu_first');

  // Hours later both tokens have expired: the app refreshes its own, and the Worker renews GitHub's.
  time+=9*3600000;
  assert.equal((await rpc('tools/list')).status,401,'access tokens last an hour');
  assert.equal((await (await form('/oauth/token',{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id:'f'.repeat(32)})).json()).error,'invalid_grant','another client cannot use it');
  const refreshed=await (await form('/oauth/token',{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id})).json();
  assert.ok(refreshed.access_token,'a wrong client does not burn the refresh token');
  assert.equal((await (await form('/oauth/token',{grant_type:'refresh_token',refresh_token:tokens.refresh_token,client_id})).json()).error,'invalid_grant','refresh tokens rotate');
  store.rows("DELETE FROM cache WHERE key LIKE 'repos:%'");
  // Two calls at once renew GitHub's token only once; both get an answer and the connection stays.
  const both=await Promise.all([1,2].map(async()=>(await rpc('tools/call',{name:'list_repositories',arguments:{}},refreshed.access_token)).json()));
  for(const later of both) assert.match(later.result.content[0].text,/owner\/repo/);
  assert.equal(renewals,1,'GitHub is asked to renew once');
  assert.equal(calls.filter(c=>c.url.includes('/user/installations')).at(-1).options.headers.Authorization,'Bearer ghu_renewed1');

  // The owner sees the app in the dashboard and revokes it.
  const auth=await session(env,fetchImpl);
  const {connections,endpoint}=await (await call('/api/connections',{cookie:auth.cookie})).json();
  assert.equal(endpoint,`${ORIGIN}/mcp`);assert.deepEqual(connections.map(c=>[c.name,c.redirectHost]),[['Claude','claude.ai']]);
  assert.equal((await handle(post('/api/connections/revoke',auth,{id:connections[0].id}),env,{fetchImpl,now:()=>time})).status,200);
  assert.equal((await rpc('tools/list',{},refreshed.access_token)).status,401,'a revoked app is signed out');
  assert.equal((await (await call('/api/connections',{cookie:auth.cookie})).json()).connections.length,0);
});

test('a cancelled GitHub sign-in returns the error to the connecting app, and pending connections are capped',async()=>{
  const {env,store}=environment(),fetchImpl=github({calls:[]});
  const call=(path,options={})=>handle(request(path,options),env,{fetchImpl});
  const {client_id}=await (await call('/oauth/register',{method:'POST',body:{client_name:'ChatGPT',redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect']}})).json();
  const start=async()=>{
    const consent=await call(`/oauth/authorize?${new URLSearchParams({response_type:'code',client_id,redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',code_challenge:'c'.repeat(43),code_challenge_method:'S256',state:'st'})}`);
    const html=await consent.text();
    const allowed=await handle(new Request(ORIGIN+'/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:ORIGIN,Cookie:consent.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({request:html.match(/name="request" value="([^"]+)"/)[1],consent:html.match(/name="consent" value="([0-9a-f]+)"/)[1],decision:'allow'})}),env,{fetchImpl});
    return {state:new URL(allowed.headers.get('Location')).searchParams.get('state'),browser:allowed.headers.getSetCookie().find(c=>c.startsWith('autopilot_login=')).match(/=([0-9a-f]+)/)[1]};
  };
  const {state,browser}=await start();
  const cancelled=await call(`/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,{cookie:`autopilot_login=${browser}`});
  const back=new URL(cancelled.headers.get('Location'));
  assert.equal(back.origin+back.pathname,'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.deepEqual([back.searchParams.get('error'),back.searchParams.get('state')],['access_denied','st']);
  for(let i=0;i<25;i++) await start();
  assert.equal(store.rows('SELECT COUNT(*) AS n FROM oauth_pending')[0].n,20,'at most 20 connections wait for GitHub');
});

// Connects a chat app through the connector's OAuth flow and returns its access token.
async function connectApp(env,fetchImpl) {
  const call=(path,options={})=>handle(request(path,options),env,{fetchImpl});
  const {client_id}=await (await call('/oauth/register',{method:'POST',body:{client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback']}})).json();
  const verifier='x'.repeat(50),challenge=createHash('sha256').update(verifier).digest('base64url');
  const consent=await call(`/oauth/authorize?${new URLSearchParams({response_type:'code',client_id,redirect_uri:'https://claude.ai/api/mcp/auth_callback',code_challenge:challenge,code_challenge_method:'S256'})}`);
  const html=await consent.text();
  const allowed=await handle(new Request(ORIGIN+'/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:ORIGIN,Cookie:consent.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({request:html.match(/name="request" value="([^"]+)"/)[1],consent:html.match(/name="consent" value="([0-9a-f]+)"/)[1],decision:'allow'})}),env,{fetchImpl});
  const browser=allowed.headers.getSetCookie().find(c=>c.startsWith('autopilot_login=')).match(/=([0-9a-f]+)/)[1];
  const back=await call(`/auth/callback?code=c&state=${encodeURIComponent(new URL(allowed.headers.get('Location')).searchParams.get('state'))}`,{cookie:`autopilot_login=${browser}`});
  const code=new URL(back.headers.get('Location')).searchParams.get('code');
  const tokens=await (await handle(new Request(ORIGIN+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:'https://claude.ai/api/mcp/auth_callback',client_id,code_verifier:verifier})}),env,{fetchImpl})).json();
  return tokens.access_token;
}

test('the connector lists pull requests and shows one as the dashboard does, from the same cache',async()=>{
  const {env,store}=environment(),calls=[];let runsDenied=false,failedChecks=false,logAuth,logRanges=[],openDenied=false,detailsDenied=false,movingHead=false,movingBase=false,moves=0;
  const bot={login:'chatgpt-codex-connector[bot]'},head='b'.repeat(40);
  const pulls=[
    {number:1,title:'Add the benchmark',html_url:'https://github.com/owner/repo/pull/1',state:'open',merged_at:null,updated_at:'2026-10-16T10:00:00Z',created_at:'2026-10-16T09:00:00Z',draft:false,head:{sha:head},base:{ref:'main'},mergeable:true,changed_files:10,additions:120,deletions:30,commits:2},
    {number:2,title:'Update sources',html_url:'https://github.com/owner/repo/pull/2',state:'closed',merged_at:'2026-10-15T10:00:00Z',updated_at:'2026-10-15T10:00:00Z',created_at:'2026-10-15T09:00:00Z',draft:false,head:{sha:'c'.repeat(40)},base:{ref:'main'},mergeable:null},
  ];
  const finding={id:11,user:bot,body:'**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>  Fix sampling parameters**\n\nThe sampler uses temperature 2.0, which makes the benchmark noisy. Use 0.2.\n\nUseful? React with 👍 / 👎.\n\n<!-- codex-code-review-finding:v1 -->',path:'research/bench.py',line:68,original_commit_id:'a'.repeat(40),created_at:'2026-10-16T09:30:00Z',html_url:'https://github.com/owner/repo/pull/1#discussion_r11'};
  const fetchImpl=async(url,options={})=>{
    calls.push({url,options});
    const ok=value=>Response.json(value);
    if(url==='https://github.com/login/oauth/access_token') return ok({access_token:'ghu_user',expires_in:28800,refresh_token:'ghr_1',refresh_token_expires_in:15811200,scope:''});
    if(url==='https://api.github.com/user') return ok({login:'owner'});
    if(url==='https://api.github.com/user/installations?per_page=100') return ok({installations:[{id:1}]});
    if(url.startsWith('https://api.github.com/user/installations/1/repositories')) return ok({repositories:[{full_name:'owner/repo',private:false,pushed_at:'2026-10-01T00:00:00Z'}]});
    if(url==='https://api.github.com/graphql') return ok({data:{repository:{pullRequest:{headRefOid:pulls[JSON.parse(options.body).variables.number-1].head.sha,mergeStateStatus:'BLOCKED',reviewDecision:null,reviewThreads:{pageInfo:{hasNextPage:false},nodes:[{isResolved:false,isOutdated:true,comments:{nodes:[{fullDatabaseId:'11'}]}}]}}}}});
    const path=url.replace('https://api.github.com/repos/owner/repo','');
    if(path==='') return ok({full_name:'owner/repo',html_url:'https://github.com/owner/repo'});
    if(path.startsWith('/pulls?state=all')) return ok(pulls);
    if(detailsDenied&&path.startsWith('/pulls/1/reviews')) return new Response('{}',{status:503});
    if(path.startsWith('/pulls?state=open')) return openDenied?new Response('{}',{status:503}):ok(pulls.filter(p=>p.state==='open'));
    if(path.startsWith('/actions/runs')&&runsDenied) return new Response(JSON.stringify({message:'Resource not accessible by integration'}),{status:403,headers:{'Content-Type':'application/json'}});
    if(path.startsWith('/actions/runs')) {
      const run=(id,n,name,status,conclusion,branch)=>({id,run_number:n,name,display_title:`Run ${n}`,status,conclusion,head_branch:branch,head_sha:'d'.repeat(40),html_url:`https://github.com/owner/repo/actions/runs/${id}`,updated_at:`2026-10-16T1${n%10}:00:00Z`});
      return ok({workflow_runs:[run(3,13,'CI','in_progress',null,'feature'),run(2,12,'CI','completed','failure','feature'),run(1,11,'Deploy','completed','success','main')]});
    }
    const single=/^\/pulls\/(\d+)$/.exec(path);
    if(single&&movingHead&&single[1]==='1') return ok({...pulls[0],head:{sha:String(++moves).padStart(40,'0')}});
    if(single&&movingBase&&single[1]==='1') return ok({...pulls[0],base:{ref:'main',sha:String(++moves).padStart(40,'0')}});
    if(single) return pulls[Number(single[1])-1]?ok(pulls[Number(single[1])-1]):new Response('{}',{status:404});
    if(path==='/pulls/1/comments?per_page=100') return ok([finding]);
    if(path==='/pulls/1/files?per_page=100&page=1') {
      const file=(filename,patch,extra={})=>({filename,status:'modified',additions:3,deletions:1,patch,blob_url:`https://github.com/owner/repo/blob/${head}/${filename}`,...extra});
      return ok([file('a.js','@@ -1 +1 @@\n-old\n+new'),file('b.js','@@ -1 +1 @@\n-x\n+y',{status:'renamed',previous_filename:'old.js'}),file('old.js','+fresh',{status:'added'}),file('moved.js','+m',{status:'renamed',previous_filename:'gone.js'}),file('logo.png',undefined,{status:'added'}),file('big.js','+'.repeat(5000)),...[1,2,3,4].map(n=>file(`c${n}.js`,'-'.repeat(3000)))]);
    }
    if(failedChecks&&path===`/commits/${head}/check-runs?per_page=100`) return ok({total_count:2,check_runs:[{id:77,name:'test',app:{slug:'github-actions'},status:'completed',conclusion:'failure',html_url:'https://github.com/owner/repo/runs/77',details_url:'https://github.com/owner/repo/actions/runs/5/job/991',output:{title:'1 test failed',summary:'cart totals'+'.'.repeat(1600),annotations_count:23}},{id:78,name:'lint',app:{slug:'github-actions'},status:'completed',conclusion:'success',html_url:'https://github.com/owner/repo/runs/78',output:{}}]});
    if(path==='/check-runs/77/annotations?per_page=20') return ok([{path:'src/cart.js',start_line:7,annotation_level:'failure',message:'expected 10.00, got 10.01'}]);
    if(path==='/actions/jobs/991/logs') return new Response(null,{status:302,headers:{Location:'https://logs.example/job77'}});
    if(url==='https://logs.example/job77') {
      // Like blob storage: only start-end ranges.
      logAuth=options.headers?.Authorization;logRanges.push(options.headers?.Range);
      const log='x'.repeat(20000)+'\n2026-10-16T10:00:00.0000000Z npm test\n2026-10-16T10:00:01.0000000Z \u001b[31mnot ok 3 - cart totals\u001b[0m\n';
      const range=/^bytes=(\d+)-(\d+)$/.exec(options.headers?.Range||'');
      if(!range) return new Response('',{status:416});
      const [from,to]=[Number(range[1]),Math.min(Number(range[2]),log.length-1)];
      return new Response(log.slice(from,to+1),{status:206,headers:{'Content-Range':`bytes ${from}-${to}/${log.length}`}});
    }
    if(/\/check-runs/.test(path)) return ok({total_count:1,check_runs:[{name:'test',status:'in_progress',conclusion:null}]});
    if(/\/status\?/.test(path)) return ok({statuses:[]});
    return ok([]);
  };
  const token=await connectApp(env,fetchImpl);
  const tool=async(name,args)=>(await (await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},headers:{Authorization:`Bearer ${token}`}}),env,{fetchImpl})).json()).result;
  const {result:{tools}}=await (await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/list'},headers:{Authorization:`Bearer ${token}`}}),env,{fetchImpl})).json();
  assert.deepEqual(tools.map(t=>t.name),['list_repositories','list_pull_requests','pull_request_status','list_workflow_runs','pull_request_checks','pull_request_files','codex_findings','waiting_on_me']);
  // The pull request tools are shown with the Repo Autopilot card (MCP Apps); the card is read with the same sign-in.
  const rpc=async(method,params)=>(await (await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method,params},headers:{Authorization:`Bearer ${token}`}}),env,{fetchImpl})).json());
  // Every message, notifications included, leaves one line in the Worker's logs, without tokens or arguments.
  const logged=[],log=console.log;console.log=line=>logged.push(line);
  try {
    const sent=await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',method:'notifications/initialized'},headers:{Authorization:`Bearer ${token}`}}),env,{fetchImpl});
    assert.equal(sent.status,202);
    await rpc('resources/read',{uri:'ui://repo-autopilot/pull-requests.html'});
    await rpc('resources/read',{uri:'ui://x?secret=abc123'});
    await rpc('secret/method-xyz');
    await handle(new Request(ORIGIN+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:'{not json'}),env,{fetchImpl});
  } finally {console.log=log;}
  const lines=logged.map(line=>JSON.parse(line));
  assert.deepEqual(lines.map(l=>[l.connector,l.notification??false,l.resource??null,l.app,l.claude]),[['notifications/initialized',true,null,'Claude',true],['resources/read',false,'ui://repo-autopilot/pull-requests.html','Claude',true],['resources/read',false,'unknown','Claude',true],['unknown',false,null,'Claude',true],['parse-error',false,null,'Claude',true]]);
  assert.ok(!logged.some(line=>line.includes(token)||line.includes('abc123')||line.includes('xyz')),'nothing the app sent beyond known values reaches the logs');
  const card='ui://repo-autopilot/pull-requests.html';
  assert.deepEqual(tools.map(t=>t._meta?.ui?.resourceUri??null),[null,card,card,null,null,null,null,null]);
  // The checks of a pull request, with what a failed one says: annotations and the end of its job log,
  // read from the signed log address without the token.
  failedChecks=true;
  const checks=await tool('pull_request_checks',{number:1});
  failedChecks=false;
  assert.deepEqual(checks.structuredContent.checks.map(c=>[c.name,c.conclusion]),[['test','failure'],['lint','success']]);
  assert.match(checks.content[0].text,/1 failed · 0 running · 1 passed/);
  assert.match(checks.content[0].text,/✗ test: failure · https:\/\/github.com\/owner\/repo\/runs\/77/);
  assert.match(checks.content[0].text,/src\/cart.js:7 failure: expected 10.00, got 10.01/);
  assert.match(checks.content[0].text,/Last lines of the log:\n      \[… earlier output cut\]\n      x+\n      npm test\n      not ok 3 - cart totals\n/,'a log tail longer than 4000 characters says its start is cut');
  assert.equal(logAuth,undefined,'the log download is not sent the GitHub token');
  assert.deepEqual(logRanges,['bytes=0-0',`bytes=${20000+1+'2026-10-16T10:00:00.0000000Z npm test\n2026-10-16T10:00:01.0000000Z \u001b[31mnot ok 3 - cart totals\u001b[0m\n'.length-16384}-${20000+1+'2026-10-16T10:00:00.0000000Z npm test\n2026-10-16T10:00:01.0000000Z \u001b[31mnot ok 3 - cart totals\u001b[0m\n'.length-1}`],'the log length is read first, then its end, in start-end ranges');
  assert.match(checks.content[0].text,/22 more annotations are not shown/);
  assert.ok(checks.structuredContent.checks[0].summary.endsWith(' […]')&&checks.content[0].text.includes('(the whole summary is on the check)'),'a cut summary says so');
  assert.match((await tool('pull_request_checks',{number:9})).content[0].text,/has no pull request #9/);
  // What a pull request changes: every file, and the diffs within a fixed budget.
  const changes=await tool('pull_request_files',{number:1});
  assert.equal(changes.structuredContent.changedWhileRead,false);
  assert.match(changes.content[0].text,/10 changed files · \+120 −30 · 2 commits/);
  assert.match(changes.content[0].text,/a\.js: modified · \+3 −1\n    @@ -1 \+1 @@\n    -old\n    \+new/);
  assert.match(changes.content[0].text,/b\.js \(renamed from old\.js\): renamed/);
  assert.match(changes.content[0].text,/logo\.png: added · \+3 −1\n    No diff from GitHub/);
  const byPath=Object.fromEntries(changes.structuredContent.files.map(f=>[f.path,f]));
  assert.ok(byPath['big.js'].patchCut&&byPath['big.js'].patch.endsWith('[… diff cut here; the whole diff is on GitHub]'),'a long diff is cut and says so');
  assert.ok(byPath['c3.js'].patchCut,'the last diff is cut to what is left of the budget');
  assert.ok(byPath['c4.js'].patchLeftOut&&byPath['c4.js'].patch===null);
  assert.match(changes.content[0].text,/1 more diffs are not shown here; ask again with path for one file\./);
  assert.equal(changes.structuredContent.patchesLeftOut,1);
  const one=await tool('pull_request_files',{number:1,path:'big.js'});
  assert.deepEqual(one.structuredContent.files.map(f=>[f.path,f.patch.length,f.patchCut]),[['big.js',5000,false]],'one file asked for by path gets its whole diff');
  assert.deepEqual((await tool('pull_request_files',{number:1,path:'old.js'})).structuredContent.files.map(f=>f.path),['old.js'],'the file now at a path comes before one renamed from it');
  assert.deepEqual((await tool('pull_request_files',{number:1,path:'gone.js'})).structuredContent.files.map(f=>f.path),['moved.js'],'a renamed file is found by its old path');
  assert.match((await tool('pull_request_files',{number:1,path:'none.js'})).content[0].text,/none\.js is not among the files on page 1\./);
  assert.match((await tool('pull_request_files',{number:9})).content[0].text,/has no pull request #9/);
  assert.match((await tool('pull_request_files',{number:1,path:' a.js'})).content[0].text,/ a\.js is not among the files/,'the path is matched as given, not trimmed');
  movingHead=true;
  const moving=await tool('pull_request_files',{number:1});
  movingHead=false;
  assert.ok(moving.structuredContent.changedWhileRead&&moving.content[0].text.includes('The pull request changed while it was read'),'a push during the read is reported');
  assert.equal(moves,3,'the pull request is read again after the files, and the files once more after a change');
  movingBase=true;
  assert.ok((await tool('pull_request_files',{number:1})).structuredContent.changedWhileRead,'a new base during the read is reported too');
  movingBase=false;
  // Codex findings with their full text, without the badge, the feedback prompt or markers.
  const full=await tool('codex_findings',{number:1,fresh:true});
  assert.equal(full.structuredContent.findings[0].text,'The sampler uses temperature 2.0, which makes the benchmark noisy. Use 0.2.');
  assert.match(full.content[0].text,/P2 Fix sampling parameters \(research\/bench.py:68/);
  assert.match(full.content[0].text,/    The sampler uses temperature 2.0/);
  assert.equal((await tool('codex_findings',{number:1,state:'fixed'})).structuredContent.findings.length,0);
  assert.ok(full.structuredContent.findings.every(f=>['open','waiting','unverified','fixed'].includes(f.state)),'states use the tool\'s own names');
  // What needs the owner, across repositories: each open pull request with what it waits on.
  const attention=await tool('waiting_on_me',{});
  assert.deepEqual(attention.structuredContent.repositories,['owner/repo']);
  assert.deepEqual(attention.structuredContent.pulls.map(p=>[p.repository,p.number,p.next]),[['owner/repo',1,'fix']]);
  assert.match(attention.content[0].text,/^Fix: owner\/repo #1 Add the benchmark \(.*\) · https:\/\/chat.example.workers.dev\/\?repo=owner%2Frepo#pr-1$/m);
  // Fresh reads the details from GitHub again instead of the cache.
  const before=calls.filter(c=>c.url.includes('/pulls/1/reviews')).length;
  await tool('waiting_on_me',{fresh:true});
  assert.equal(calls.filter(c=>c.url.includes('/pulls/1/reviews')).length,before+1,'a fresh list reloads the details');
  // A fresh list also reads the repositories again.
  const installs=()=>calls.filter(c=>c.url.startsWith('https://api.github.com/user/installations?')).length;
  const listed0=installs();
  await tool('waiting_on_me',{fresh:true});
  assert.equal(installs(),listed0+1,'a fresh list reloads the repositories');
  // Details GitHub would not give are a pull request to check, not one to wait on.
  detailsDenied=true;
  const unloaded=await tool('waiting_on_me',{fresh:true});
  detailsDenied=false;
  assert.equal(unloaded.structuredContent.pulls[0].next,'check');
  assert.match(unloaded.structuredContent.pulls[0].reasons[0],/^details could not be read: /);
  await tool('waiting_on_me',{fresh:true});
  // A repository that cannot be read leaves the answer open, not an all-clear.
  openDenied=true;
  const unread=await tool('waiting_on_me',{});
  openDenied=false;
  assert.equal(unread.structuredContent.complete,false);
  assert.match(unread.content[0].text,/No open pull requests were found in the repositories that could be read\.\nCould not read owner\/repo: GitHub request failed \(503\)\./);
  // Workflow runs, as the dashboard lists them, narrowed to failed ones or a branch when asked.
  const runs=await tool('list_workflow_runs',{});
  assert.deepEqual(runs.structuredContent.runs.map(r=>[r.runNumber,r.workflow,r.status,r.conclusion,r.branch]),[[13,'CI','in_progress',null,'feature'],[12,'CI','completed','failure','feature'],[11,'Deploy','completed','success','main']]);
  assert.match(runs.content[0].text,/#12 CI · Run 12: failure · branch feature · ddddddd · .* · https:\/\/github.com\/owner\/repo\/actions\/runs\/2/);
  assert.match(runs.content[0].text,/#13 CI · Run 13: in progress/);
  assert.deepEqual((await tool('list_workflow_runs',{failed_only:true})).structuredContent.runs.map(r=>r.runNumber),[12]);
  assert.deepEqual((await tool('list_workflow_runs',{branch:'main'})).structuredContent.runs.map(r=>r.runNumber),[11]);
  assert.deepEqual((await tool('list_workflow_runs',{limit:2})).structuredContent,{...(await tool('list_workflow_runs',{limit:2})).structuredContent,mayHaveMore:true});
  assert.equal((await tool('list_workflow_runs',{limit:2})).structuredContent.runs.length,2);
  assert.match((await tool('list_workflow_runs',{limit:99})).content[0].text,/limit must be a number from 1 to 60/);
  assert.equal(runs.structuredContent.available,true);
  // Runs GitHub will not show are reported as unreadable, not as none.
  runsDenied=true;
  const denied=await tool('list_workflow_runs',{fresh:true});
  assert.deepEqual([denied.structuredContent.available,denied.structuredContent.runs.length],[false,0]);
  assert.match(denied.structuredContent.error,/GitHub Actions runs are unavailable/);
  assert.match(denied.content[0].text,/workflow runs could not be read/);
  assert.doesNotMatch(denied.content[0].text,/No workflow runs found/);
  runsDenied=false;

  assert.equal(tools[1]._meta['ui/resourceUri'],card,'older hosts read the flat key');
  assert.deepEqual((await rpc('initialize',{protocolVersion:'2025-06-18'})).result.capabilities.resources,{listChanged:false});
  // MCP Apps is answered in kind: only a chat app that declares the extension hears it back.
  assert.equal((await rpc('initialize',{protocolVersion:'2025-06-18'})).result.capabilities.extensions,undefined);
  const declared=await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{extensions:{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}}}});
  assert.deepEqual(declared.result.capabilities.extensions,{'io.modelcontextprotocol/ui':{mimeTypes:['text/html;profile=mcp-app']}});
  const {result:{resources}}=await rpc('resources/list');
  assert.deepEqual(resources.map(r=>[r.uri,r.mimeType]),[[card,'text/html;profile=mcp-app']]);
  const {result:{contents:[content]}}=await rpc('resources/read',{uri:card});
  assert.equal(content.mimeType,'text/html;profile=mcp-app');
  assert.deepEqual(content._meta.ui.csp,{connectDomains:[],resourceDomains:[]},'the card loads nothing and connects nowhere');
  // Claude loads the card from its sandbox origin, named after this connector's address.
  const expected=createHash('sha256').update(`${ORIGIN}/mcp`).digest('hex').slice(0,32)+'.claudemcpcontent.com';
  assert.equal(content._meta.ui.domain,expected,'a Claude connection gets Claude\'s sandbox origin');
  assert.match(content.text,/^<!doctype html>/);assert.match(content.text,/ui\/initialize/);
  assert.match(content.text,/<a id="dashboard" href="https:\/\/[^"]+\/">/,'the card links to this dashboard');
  assert.doesNotMatch(content.text,/<script[^>]+src=/,'no external scripts');
  assert.equal((await rpc('resources/read',{uri:'ui://other'})).error.code,-32002);
  const unsigned=await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:card}}}),env,{fetchImpl});
  assert.equal(unsigned.status,401,'the card is not served without a sign-in');

  const listed=await tool('list_pull_requests',{});
  assert.equal(listed.structuredContent.repository,'owner/repo','the app\'s own repository is the default');
  const [open,merged]=listed.structuredContent.pulls;
  assert.deepEqual([open.number,open.ci,open.findingCounts.waiting],[1,'pending',1]);
  assert.equal(merged.detailsLoaded,false,'closed pull requests are not loaded from GitHub by the list');
  assert.deepEqual([listed.structuredContent.limit,listed.structuredContent.mayHaveMore],[6,false],'two pull requests are all there are');
  assert.match(tools[1].description,/Lists the 6 most recently updated/);
  assert.match(listed.content[0].text,/#1 Add the benchmark: open · Not ready to merge · CI running/);
  assert.match(listed.content[0].text,/#2 Update sources \(merged\): details not loaded/);
  // Every pull request links to this Worker's dashboard, which opens its repository and the pull request.
  const link=n=>`${ORIGIN}/?repo=owner%2Frepo#pr-${n}`;
  assert.deepEqual(listed.structuredContent.pulls.map(p=>p.dashboardUrl),[link(1),link(2)]);
  assert.ok(listed.content[0].text.includes(`${ORIGIN}/?repo=owner%2Frepo#dashboard`),'the repository link opens the dashboard tab');
  assert.equal(listed.structuredContent.dashboardUrl,`${ORIGIN}/?repo=owner%2Frepo#dashboard`);
  assert.ok(listed.content[0].text.includes(`CI running`)&&listed.content[0].text.includes(`dashboard ${link(1)}`)&&listed.content[0].text.includes(`dashboard ${link(2)}`));

  calls.length=0;
  const status=await tool('pull_request_status',{number:1});
  assert.equal(status.structuredContent.dashboardUrl,link(1));
  assert.ok(status.content[0].text.includes(`Dashboard: ${link(1)}`)&&status.content[0].text.includes(`Merging happens in the Repo Autopilot dashboard: ${link(1)}`));
  assert.equal(calls.filter(c=>c.url.startsWith('https://api.github.com/repos/')).length,0,'the status comes from the cache the list filled');
  calls.length=0;
  await tool('pull_request_status',{number:1,fresh:true});
  assert.ok(calls.some(c=>c.url.endsWith('/repos/owner/repo/pulls/1')),'fresh reads GitHub again instead of the cache');
  assert.match((await tool('pull_request_status',{number:1,fresh:'yes'})).content[0].text,/fresh must be true or false/);
  // A chat app holding an older tool list may send the flag as text; it is read like the boolean.
  calls.length=0;
  assert.equal((await tool('pull_request_status',{number:1,fresh:'true'})).isError,undefined);
  assert.ok(calls.some(c=>c.url.endsWith('/repos/owner/repo/pulls/1')),'"true" reads GitHub again');
  assert.equal((await tool('pull_request_status',{number:1,fresh:'false'})).isError,undefined);
  calls.length=0;
  assert.match(status.content[0].text,/Merge: Not ready to merge/);
  assert.match(status.content[0].text,/🔄 P2 Fix sampling parameters \(research\/bench\.py:68; older commit aaaaaaa; code changed, waiting for Codex\)/);
  assert.equal(status.structuredContent.findings[0].commit,'a'.repeat(40));
  assert.equal(status.structuredContent.findings[0].state,'changed');
  assert.match((await tool('pull_request_status',{number:9})).content[0].text,/no pull request #9/);
  // A pull request whose details fail is listed as not loaded; the rest of the list still comes back.
  pulls[0].updated_at='2026-10-16T11:00:00Z';
  const failing=fetchImpl;let broken=true;
  const flaky=async(url,options)=>broken&&url.endsWith('/repos/owner/repo/pulls/1')?new Response('{}',{status:502}):failing(url,options);
  store.rows("DELETE FROM cache WHERE key LIKE 'overview:%'");
  const partial=(await (await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_pull_requests',arguments:{}}},headers:{Authorization:`Bearer ${token}`}}),env,{fetchImpl:flaky})).json()).result;
  assert.equal(partial.isError,undefined);
  assert.match(partial.content[0].text,/#1 Add the benchmark \(open\): details could not be read/);
  // GitHub not answering at all (a network failure or a timeout) is also one unavailable row, with a safe message.
  const unreachable=async(url,options)=>url.endsWith('/repos/owner/repo/pulls/1')?Promise.reject(new TypeError('socket detail xyz')):failing(url,options);
  pulls[0].updated_at='2026-10-16T12:00:00Z';
  store.rows("DELETE FROM cache WHERE key LIKE 'overview:%'");
  const offline=(await (await handle(request('/mcp',{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_pull_requests',arguments:{}}},headers:{Authorization:`Bearer ${token}`}}),env,{fetchImpl:unreachable})).json()).result;
  assert.equal(offline.isError,undefined);
  assert.match(offline.content[0].text,/#1 Add the benchmark \(open\): details could not be read \(GitHub could not be reached/);
  assert.doesNotMatch(offline.content[0].text,/socket detail xyz/);
  broken=false;
  const other=await tool('pull_request_status',{repository:'someone/else',number:1});
  assert.equal(other.isError,true);assert.match(other.content[0].text,/cannot reach someone\/else/);
});

test('each OAuth step leaves one line in the logs, without codes or tokens',async()=>{
  const {env}=environment(),fetchImpl=github({calls:[]});
  const logged=[],log=console.log;console.log=line=>logged.push(line);
  let token;
  try {
    token=await connectApp(env,fetchImpl);
    await handle(new Request(ORIGIN+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'refresh_token',refresh_token:'secret-refresh-xyz'})}),env,{fetchImpl});
    await handle(new Request(ORIGIN+'/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code:'secret-code-xyz',code_verifier:'v'.repeat(43),client_id:'x',redirect_uri:'https://claude.ai/api/mcp/auth_callback'})}),env,{fetchImpl});
  } finally {console.log=log;}
  const lines=logged.map(line=>JSON.parse(line)).filter(l=>l.connector==='oauth');
  assert.deepEqual(lines.map(l=>[l.step,l.status,l.error??null,l.to??null,l.grant??null]),[
    ['register',201,null,null,null],['consent',200,null,null,null],['decision',303,null,'github.com',null],
    ['github',303,null,'claude.ai',null],['token',200,null,null,'authorization_code'],['token',400,'invalid_grant',null,'refresh_token'],['token',400,'invalid_grant',null,'authorization_code']]);
  assert.ok(!logged.some(line=>line.includes(token)||line.includes('secret-code-xyz')||line.includes('secret-refresh-xyz')||line.includes('code=')),'no codes or tokens in the logs');
});

test('the consent page allows only its own script, which shows the click and stops a second one',async()=>{
  const {env}=environment(),fetchImpl=github({calls:[]});
  const call=(path,options={})=>handle(request(path,options),env,{fetchImpl});
  const {client_id}=await (await call('/oauth/register',{method:'POST',body:{client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback']}})).json();
  const consent=await call(`/oauth/authorize?${new URLSearchParams({response_type:'code',client_id,redirect_uri:'https://claude.ai/api/mcp/auth_callback',code_challenge:'c'.repeat(43),code_challenge_method:'S256'})}`);
  const html=await consent.text(),scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  assert.equal(scripts.length,1);
  assert.match(scripts[0],/Opening GitHub…/);
  const hash=`'sha256-${createHash('sha256').update(scripts[0]).digest('base64')}'`;
  assert.match(consent.headers.get('Content-Security-Policy'),new RegExp(`script-src ${hash.replace(/[+/]/g,c=>'\\'+c)};`));
});

test('an OAuth step that throws is logged as a 500',async()=>{
  const {env,store}=environment(),fetchImpl=github({calls:[]});
  store.registerClient=async()=>{throw new Error('storage down');};
  const logged=[],log=console.log,error=console.error;console.log=line=>logged.push(line);console.error=()=>{};
  let response;
  try {response=await handle(request('/oauth/register',{method:'POST',body:{client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback']}}),env,{fetchImpl});}
  finally {console.log=log;console.error=error;}
  assert.equal(response.status,500);
  assert.deepEqual(logged.map(line=>JSON.parse(line)).filter(l=>l.connector==='oauth'),[{connector:'oauth',step:'register',status:500,error:'exception'}]);
});

test('a GitHub callback that throws while finishing a connection is logged as a 500',async()=>{
  const {env,store}=environment(),fetchImpl=github({calls:[]});
  const call=(path,options={})=>handle(request(path,options),env,{fetchImpl});
  const {client_id}=await (await call('/oauth/register',{method:'POST',body:{client_name:'Claude',redirect_uris:['https://claude.ai/api/mcp/auth_callback']}})).json();
  const consent=await call(`/oauth/authorize?${new URLSearchParams({response_type:'code',client_id,redirect_uri:'https://claude.ai/api/mcp/auth_callback',code_challenge:'c'.repeat(43),code_challenge_method:'S256'})}`);
  const html=await consent.text();
  const allowed=await handle(new Request(ORIGIN+'/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:ORIGIN,Cookie:consent.headers.get('Set-Cookie').split(';')[0]},body:new URLSearchParams({request:html.match(/name="request" value="([^"]+)"/)[1],consent:html.match(/name="consent" value="([0-9a-f]+)"/)[1],decision:'allow'})}),env,{fetchImpl});
  const browser=allowed.headers.getSetCookie().find(c=>c.startsWith('autopilot_login=')).match(/=([0-9a-f]+)/)[1];
  const state=new URL(allowed.headers.get('Location')).searchParams.get('state');
  store.takePending=async()=>{throw new Error('storage down');};
  const logged=[],log=console.log,error=console.error;console.log=line=>logged.push(line);console.error=()=>{};
  let response;
  try {response=await call(`/auth/callback?error=access_denied&state=${encodeURIComponent(state)}`,{cookie:`autopilot_login=${browser}`});}
  finally {console.log=log;console.error=error;}
  assert.equal(response.status,500);
  assert.deepEqual(logged.map(line=>JSON.parse(line)).filter(l=>l.connector==='oauth'),[{connector:'oauth',step:'github',status:500,error:'exception'}]);
});

