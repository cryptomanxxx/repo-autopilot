const state={csrf:'',conversation:null,image:null,busy:false,previewUrl:null,imageSelection:0};
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
  $('account').textContent=message;$('login').hidden=false;$('logout').hidden=true;$('chat').hidden=true;
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
  state.conversation=id;
  if(!id) {history.replaceState(null,'',location.pathname);$('conversation-title').textContent='New conversation';renderMessages([]);await loadConversations();return;}
  history.replaceState(null,'',`#${id}`);
  try {
    const conversation=await api(`/api/conversations/${id}`);
    if(state.conversation!==id) return;
    $('conversation-title').textContent=conversation.title;renderMessages(conversation.messages);
    await loadConversations();
  } catch(error) {status(error.message);}
}

async function createPullRequest(message,button) {
  if(state.busy) return;
  state.busy=true;button.disabled=true;status('Creating pull request…');
  try {
    await api('/api/pull-request',{conversation:state.conversation,message},120000);
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
  state.imageSelection++;state.image=null;$('image').value='';$('preview').hidden=true;$('remove-image').hidden=true;
  if(state.previewUrl) URL.revokeObjectURL(state.previewUrl);state.previewUrl=null;
}
async function attach(file) {
  if(!file) return;
  clearImage();const selection=state.imageSelection;
  if(!/^image\/(png|jpeg|webp)$/.test(file.type)||file.size>20000000) {status('Choose a PNG, JPEG or WebP image.');return;}
  try {
    const data=await prepareImage(file);
    if(selection!==state.imageSelection) return;
    state.image=data;state.previewUrl=URL.createObjectURL(file);$('preview').src=state.previewUrl;$('preview').hidden=false;$('remove-image').hidden=false;status('Image attached.');
  } catch {if(selection===state.imageSelection) {clearImage();status('Could not read the image.');}}
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
  const text=$('message').value.trim();if(!text) return;
  state.busy=true;$('send').disabled=true;$('message').disabled=true;$('image').disabled=true;
  const container=$('messages');container.querySelector('.empty')?.remove();
  container.append(renderMessage({role:'user',content:text,hasImage:Boolean(state.image)}));
  const thinking=document.createElement('p');thinking.className='muted thinking';thinking.textContent='The agent is reading the code and writing an answer…';container.append(thinking);thinking.scrollIntoView({block:'end'});
  status('');
  try {
    const result=await api('/api/chat',{conversation:state.conversation,text,image:state.image},240000);
    $('message').value='';clearImage();
    state.busy=false;await openConversation(result.conversation);
  } catch(error) {
    thinking.remove();container.lastElementChild?.remove();
    status(error.name==='TimeoutError'?'The agent did not answer in time. Try again.':error.message);
  } finally {state.busy=false;$('send').disabled=false;$('message').disabled=false;$('image').disabled=false;}
};
$('new-conversation').onclick=()=>{if(!state.busy) {status('');openConversation(null);$('message').focus();}};
$('logout').onclick=async()=>{try {await api('/api/logout',{});} catch {} location.replace('/');};

try {
  const session=await api('/api/session');
  if(!session.login) showSignedOut(`Sign in with the owner account of ${session.repository}.`);
  else {
    state.csrf=session.csrf;
    $('account').textContent=`${session.repository} · ${session.login} · model ${session.model}`;
    $('logout').hidden=false;$('chat').hidden=false;
    const id=/^#([0-9a-f]{32})$/.exec(location.hash)?.[1]||null;
    await openConversation(id);
  }
} catch(error) {$('account').textContent=error.message||'The chat is unavailable. Try again later.';}
