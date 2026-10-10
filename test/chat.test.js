import test from 'node:test';
import assert from 'node:assert/strict';
import {createChat,validateScreenshot} from '../src/chat.js';
import {createChatServer} from '../src/chat-server.js';
import {TASK_MARKER} from '../src/agent.js';

test('image uploads reject remote URLs, disguised data and oversized payloads',()=>{
  for(const image of ['https://private-host/image.png','data:image/png;base64,YmFk','data:image/svg+xml;base64,AAAA','x'.repeat(2800001)]) assert.throws(()=>validateScreenshot(image));
});
test('chat sends owner tasks and handles screenshot failures before issue creation',async()=>{
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>url.endsWith('/issues')?{number:22,html_url:'https://github.com/owner/repo/issues/22'}:{private:false}};};
  const chat=createChat({repository:'owner/repo',token:'secret',fetchImpl});
  assert.equal((await chat.send({text:'Improve spacing'})).number,22);
  assert.match(JSON.parse(calls.at(-1).body).body,/repo-autopilot-task/);
  assert.equal(calls.at(-1).body.includes('secret'),false);
  const image='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
  await assert.rejects(chat.send({text:'Look here',image}),/not configured/);
  assert.equal(calls.filter(c=>c.url.endsWith('/issues')).length,1);
});
test('chat refuses private repos and foreign or closed tasks',async()=>{
  for(const issue of [{private:true},{private:false,foreign:true},{private:false,closed:true}]) {
    const chat=createChat({repository:'owner/repo',token:'secret',fetchImpl:async url=>({ok:true,json:async()=>url.endsWith('/repos/owner/repo')?{private:issue.private}:{number:1,state:issue.closed?'closed':'open',user:{login:issue.foreign?'other':'owner'},title:'Autopilot task: x',body:TASK_MARKER+'\nx'}})});
    await assert.rejects(chat.send({number:1,text:'More context'}),/public repository|authorized|closed/);
  }
});
test('OAuth browser binding, server-only tokens, CSRF and logout',async t=>{
  const calls=[];
  const remote=async(url,options)=>{
    calls.push({url,...options});
    let data=url.endsWith('/access_token')?{access_token:'private-token'}:url.endsWith('/user')?{login:'owner'}:url.endsWith('/issues')?{number:22,html_url:'https://github.com/owner/repo/issues/22'}:{private:false};
    return {ok:true,json:async()=>data};
  };
  const server=createChatServer({origin:'https://chat.example',repository:'owner/repo',clientId:'client',clientSecret:'private-secret',fetchImpl:remote});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const login=await fetch(url+'/auth/login',{redirect:'manual'}),target=new URL(login.headers.get('location'));
  const loginCookie=login.headers.getSetCookie()[0].split(';')[0];
  assert.equal(target.searchParams.get('scope'),'public_repo');assert.equal(target.searchParams.get('code_challenge_method'),'S256');
  let r=await fetch(url+'/auth/callback?code=x&state='+target.searchParams.get('state'),{headers:{Cookie:'autopilot_login=wrong'},redirect:'manual'});assert.equal(r.status,403);assert.equal(calls.length,0);
  const again=await fetch(url+'/auth/login',{redirect:'manual'}),newTarget=new URL(again.headers.get('location'));
  r=await fetch(url+'/auth/callback?code=x&state='+newTarget.searchParams.get('state'),{headers:{Cookie:again.headers.getSetCookie()[0].split(';')[0]},redirect:'manual'});
  assert.equal(r.status,303);
  const sessionCookie=r.headers.getSetCookie().find(c=>c.startsWith('autopilot_session=')).split(';')[0];
  assert.match(r.headers.getSetCookie()[0],/HttpOnly/);assert.match(r.headers.getSetCookie()[0],/Secure/);
  const session=await (await fetch(url+'/api/session',{headers:{Cookie:sessionCookie}})).json();assert.equal(session.login,'owner');assert.equal(JSON.stringify(session).includes('private-token'),false);
  r=await fetch(url+'/api/send',{method:'POST',headers:{Cookie:sessionCookie,'Content-Type':'application/json',Origin:'https://other.example','X-CSRF-Token':session.csrf},body:JSON.stringify({text:'x'})});assert.equal(r.status,403);
  r=await fetch(url+'/api/send',{method:'POST',headers:{Cookie:sessionCookie,'Content-Type':'application/json',Origin:'https://chat.example','X-CSRF-Token':session.csrf},body:JSON.stringify({text:'x'})});assert.equal(r.status,200);
  r=await fetch(url+'/api/send',{method:'POST',headers:{Cookie:sessionCookie,'Content-Type':'application/json',Origin:'https://chat.example','X-CSRF-Token':session.csrf},body:JSON.stringify({text:'x'})});assert.equal(r.status,429);
  r=await fetch(url+'/api/logout',{method:'POST',headers:{Cookie:sessionCookie,Origin:'https://chat.example','Content-Type':'application/json','X-CSRF-Token':session.csrf},body:'{}'});assert.equal(r.status,200);
  r=await fetch(url+'/api/tasks',{headers:{Cookie:sessionCookie}});assert.equal(r.status,401);
  assert.equal(loginCookie.includes('private'),false);
});

test('screenshots become text observations, never GitHub image data',async()=>{
  const calls=[];const image='data:image/png;base64,'+Buffer.from([137,80,78,71,13,10,26,10]).toString('base64');
  const chat=createChat({repository:'owner/repo',token:'github-token',groqKey:'vision-secret',fetchImpl:async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>url.startsWith('https://api.groq.com')?{choices:[{finish_reason:'stop',message:{content:'Visible label: Refresh dashboard data'}}]}:url.endsWith('/issues')?{number:22,html_url:'https://github.com/owner/repo/issues/22'}:{private:false}};}});
  await chat.send({text:'Add run numbers',image});
  const vision=JSON.parse(calls.find(c=>c.url.startsWith('https://api.groq.com')).body);assert.equal(vision.model,'qwen/qwen3.8-27b');assert.equal(vision.messages[0].content[1].image_url.url,image);
  const published=calls.find(c=>c.url.endsWith('/issues')).body;assert.match(published,/Visible label/);assert.equal(published.includes('base64'),false);assert.equal(published.includes('vision-secret'),false);
});
test('follow-up messages remain in the same authorized task',async()=>{
  const calls=[];
  const chat=createChat({repository:'owner/repo',token:'token',fetchImpl:async(url,options)=>{calls.push({url,...options});return {ok:true,json:async()=>url.endsWith('/repos/owner/repo')?{private:false}:url.includes('/comments?')?[{user:{login:'github-actions[bot]'},body:'<!-- repo-autopilot-agent -->\n**Agent: needs input**'}]:{number:21,state:'open',user:{login:'owner'},title:'Autopilot task: x',body:TASK_MARKER+'\nx',html_url:'https://github.com/owner/repo/issues/21'}};}});
  assert.equal((await chat.send({number:21,text:'Look at src/github.js'})).number,21);
  const posted=calls.find(c=>c.method==='POST');assert.match(posted.url,/issues\/21\/comments$/);assert.match(JSON.parse(posted.body).body,/repo-autopilot-reply/);
});
