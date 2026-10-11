import {startDashboard,showDashboard,showPull} from './dashboard.js';
const state={csrf:'',conversation:null,image:null,busy:false,previewUrl:null,imageSelection:0,preparing:false,tab:null,repository:''};
const $=id=>document.getElementById(id);
const status=text=>{$('status').textContent=text;};
const MAX_SIDE=1600,MAX_DATA_URL=1400000;

async function api(path,body,timeout=30000) {
  const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':state.csrf}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
  let value={};try {value=await response.json();} catch {}
  if(response.status===401&&path!=='/api/session') {showSignedOut(value.error||'Sign in again.');throw new Error(value.error||'Sign in again.');}
  if(!response.ok) throw new Error(value.error||`Request failed (HTTP ${response.status}).`);
  return value;
}

function showSignedOut(message) {
  $('account').textContent=message;$('login').hidden=false;$('logout').hidden=true;
  for(const id of ['tabs','chat','dashboard-view']) $(id).hidden=true;
}

// The address keeps the open tab: #dashboard, #pr-<number>, #chat and #chat/<conversation>.
function chatHash() {return state.conversation?`#chat/${state.conversation}`:'#chat';}
function showTab(tab,{hash}={}) {
  state.tab=tab;
  try {localStorage.setItem('autopilot-tab',tab);} catch {}
  for(const [name,panel] of [['dashboard','dashboard-view'],['chat','chat']]) {
    $(panel).hidden=name!==tab;$(`tab-${name}`).setAttribute('aria-selected',String(name===tab));
  }
  history.replaceState(null,'',hash??(tab==='chat'?chatHash():'#dashboard'));
  if(tab==='dashboard') showDashboard();
}
function followPull(url) {
  const prefix=`https://github.com/${state.repository}/pull/`.toLowerCase();
  const rest=typeof url==='string'&&url.toLowerCase().startsWith(prefix)?url.slice(prefix.length):'';
  return /^[1-9]\d{0,8}$/.test(rest)?Number(rest):null;
}

// Splits text into prose and code: ``` fences and SEARCH/REPLACE edit blocks are shown as code.
function renderContent(text) {
  const fragment=document.createDocumentFragment();
  const pattern=/```[^\n]*\n([\s\S]*?)```|^<<<<<<< SEARCH[^\n]*\n[\s\S]*?^>>>>>>> REPLACE[ \t]*$/gm;
  let last=0;
  for(const match of text.matchAll(pattern)) {
    if(match.index>last) {const p=document.createElement('p');p.textContent=text.slice(last,match.index).trim();if(p.textContent) fragment.append(p);}
    const pre=document.createElement('pre');pre.textContent=match[1]??match[0];fragment.append(pre);
    last=match.index+match[0].length;
  }
  const rest=text.slice(last).trim();
  if(rest) {const p=document.createElement('p');p.textContent=rest;fragment.append(p);}
  return fragment;
}

function renderMessage(message) {
  const item=document.createElement('article');item.className=`message ${message.role}`;
  const label=document.createElement('strong');label.textContent=message.role==='user'?'You':'Agent';item.append(label);
  if(message.hasImage) {const note=document.createElement('span');note.className='muted small';note.textContent=' · image attached';item.append(note);}
  item.append(renderContent(message.content));
  if(message.proposal) {
    const box=document.createElement('div');box.className='proposal';
    const files=document.createElement('p');files.textContent=`Proposed change: ${message.proposal.paths.join(', ')}`;box.append(files);
    if(message.prUrl) {
      const link=document.createElement('a');link.href=message.prUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open pull request';box.append(link);
      const number=followPull(message.prUrl);
      if(number) {const follow=document.createElement('button');follow.type='button';follow.className='secondary';follow.textContent='Follow in dashboard';follow.onclick=()=>{showPull(number);showTab('dashboard',{hash:`#pr-${number}`});};box.append(follow);}
    } else if(message.id) {
      const button=document.createElement('button');button.textContent='Create pull request';
      button.onclick=()=>createPullRequest(message.id,button);box.append(button);
    }
    item.append(box);
  }
  return item;
}

function renderMessages(messages) {
  const container=$('messages');container.replaceChildren();
  if(!messages.length) {const p=document.createElement('p');p.className='muted empty';p.textContent='Ask about the code or describe a change. The agent reads the repository\'s current files and can propose edits; you decide whether to open a pull request.';container.append(p);}
  for(const message of messages) container.append(renderMessage(message));
  container.lastElementChild?.scrollIntoView({block:'end'});
}

async function loadConversations() {
  const {conversations}=await api('/api/conversations');
  const list=$('conversations');list.replaceChildren();
  for(const conversation of conversations) {
    const item=document.createElement('li'),button=document.createElement('button');
    button.className='conversation'+(conversation.id===state.conversation?' active':'');
    button.textContent=conversation.title;button.title=new Date(conversation.updated).toLocaleString();
    button.onclick=()=>openConversation(conversation.id);
    item.append(button);list.append(item);
  }
}

async function openConversation(id) {
  if(state.busy) return;
  const previous=state.conversation;let failed=false;
  state.conversation=id;
  if(state.tab==='chat') history.replaceState(null,'',chatHash());
  if(!id) {$('conversation-title').textContent='New conversation';renderMessages([]);await loadConversations();return;}
  try {
    const conversation=await api(`/api/conversations/${id}`);
    if(state.conversation!==id) return;
    $('conversation-title').textContent=conversation.title;renderMessages(conversation.messages);
  } catch(error) {
    // Keep sending to the conversation that is actually on screen.
    if(state.conversation===id) {state.conversation=previous;if(state.tab==='chat') history.replaceState(null,'',chatHash());}
    status(error.message);failed=true;
  }
  try {await loadConversations();} catch(error) {if(!failed) status(error.message);}
}

async function createPullRequest(message,button) {
  if(state.busy) return;
  state.busy=true;button.disabled=true;status('Creating pull request…');
  try {
    await api('/api/pull-request',{conversation:state.conversation,message},250000);
    status('Pull request created. CI runs on GitHub.');
    state.busy=false;await openConversation(state.conversation);
  } catch(error) {status(error.message);button.disabled=false;}
  finally {state.busy=false;}
}

// Screenshots are scaled down in the browser and sent as JPEG, which keeps uploads small and fast.
async function prepareImage(file) {
  const bitmap=await createImageBitmap(file);
  for(const [side,quality] of [[MAX_SIDE,0.85],[1200,0.75],[900,0.7]]) {
    const scale=Math.min(1,side/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
    const context=canvas.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
    const data=canvas.toDataURL('image/jpeg',quality);
    if(data.length<=MAX_DATA_URL) {bitmap.close();return data;}
  }
  bitmap.close();throw new Error('The image is too large.');
}
function clearImage() {
  state.imageSelection++;state.preparing=false;state.image=null;$('image').value='';$('preview').hidden=true;$('remove-image').hidden=true;
  if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);state.previewUrl=null;
}
async function attach(file) {
  if(!file) return;
  clearImage();const selection=state.imageSelection;
  if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>20000000) {status('Choose a PNG, JPEG or WebP image.');return;}
  state.preparing=true;status('Preparing image…');
  try {
    const data=await prepareImage(file);
    if(selection!==state.imageSelection) return;
    state.image=data;state.previewUrl=URL.createObjectURL(file);$('preview').src=state.previewUrl;$('preview').hidden=false;$('remove-image').hidden=false;status('Image attached.');
  } catch {if(selection===state.imageSelection) {clearImage();status('Could not read the image.');}}
  finally {if(selection===state.imageSelection) state.preparing=false;}
}
$('image').onchange=()=>attach($('image').files[0]);
$('remove-image').onclick=()=>{clearImage();status('');};
$('message').addEventListener('paste',event=>{
  const file=[...(event.clipboardData?.items||[])].find(item=>item.kind==='file'&&item.type.startsWith('image/'))?.getAsFile();
  if(file) {event.preventDefault();attach(file);}
});
$('message').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)) {event.preventDefault();$('composer').requestSubmit();}});

$('composer').onsubmit=async event=>{
  event.preventDefault();
  if(state.busy) return;
  if(state.preparing) {status('Wait until the image is ready.');return;}
  const text=$('message').value.trim();if(!text) return;
  state.busy=true;$('send').disabled=true;$('message').disabled=true;$('image').disabled=true;
  const container=$('messages');container.querySelector('.empty')?.remove();
  container.append(renderMessage({role:'user',content:text,hasImage:Boolean(state.image)}));
  const thinking=document.createElement('p');thinking.className='muted thinking';thinking.textContent='The agent is reading the code and writing an answer…';container.append(thinking);thinking.scrollIntoView({block:'end'});
  status('');
  try {
    const result=await api('/api/chat',{conversation:state.conversation,text,image:state.image},430000);
    $('message').value='';clearImage();thinking.remove();
    state.busy=false;state.conversation=result.conversation;await openConversation(result.conversation);
  } catch(error) {
    thinking.remove();container.lastElementChild?.remove();
    status(error.name==='TimeoutError'?'The agent did not answer in time. Try again.':error.message);
  } finally {state.busy=false;$('send').disabled=false;$('message').disabled=false;$('image').disabled=false;}
};
$('new-conversation').onclick=()=>{if(!state.busy) {status('');openConversation(null);$('message').focus();}};
$('logout').onclick=async()=>{try {await api('/api/logout',{});} catch {} location.replace('/');};

const SIGN_IN_PROBLEMS={cancelled:'Sign-in was cancelled.',expired:'The sign-in expired or started in another browser. Try again.',failed:'GitHub sign-in failed. Try again.',app:'The chat must use the client ID and secret of a GitHub App, not an OAuth app.',owner:'Only the repository owner account can use this chat.',github:'GitHub rejected the sign-in. Check the GitHub App\'s callback URL and client ID.'};
const signInProblem=SIGN_IN_PROBLEMS[new URLSearchParams(location.search).get('signin')];
if(location.search) history.replaceState(null,'',location.pathname+location.hash);
$('tab-dashboard').onclick=()=>showTab('dashboard');
$('tab-chat').onclick=()=>showTab('chat');
try {
  const session=await api('/api/session');
  if(!session.login) showSignedOut(signInProblem?`${signInProblem} Sign in with the owner account of ${session.repository}.`:`Sign in with the owner account of ${session.repository}.`);
  else {
    state.csrf=session.csrf;state.repository=session.repository;
    $('account').textContent=`${session.repository} · ${session.login} · model ${session.model}`;
    $('logout').hidden=false;$('tabs').hidden=false;
    startDashboard(api,{isVisible:()=>state.tab==='dashboard'});
    // Older chat links used #<conversation>; they still open the chat.
    const hash=location.hash,conversation=/^#(?:chat\/)?([0-9a-f]{32})$/.exec(hash)?.[1]||null,pull=/^#pr-([1-9]\d{0,8})$/.exec(hash)?.[1];
    let saved=null;try {saved=localStorage.getItem('autopilot-tab');} catch {}
    const tab=conversation||hash==='#chat'?'chat':pull||hash==='#dashboard'?'dashboard':saved==='chat'?'chat':'dashboard';
    if(pull) showPull(Number(pull));
    state.tab=tab;
    await openConversation(conversation);
    showTab(tab,{hash:pull?`#pr-${pull}`:undefined});
  }
} catch(error) {$('account').textContent=error.message||'Repo Autopilot is unavailable. Try again later.';}
