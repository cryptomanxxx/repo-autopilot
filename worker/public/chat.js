import {startDashboard,showDashboard,showPull,setRepository,dashboardNotice} from './dashboard.js';
const state={agent:'',agents:[],agentId:null,models:{},modelId:'',csrf:'',conversation:null,image:null,busy:false,previewUrl:null,imageSelection:0,preparing:false,tab:null,repository:'',home:'',login:'',model:'',deployed:null,conversationRequest:0};
const $=id=>document.getElementById(id);
const status=text=>{$('status').textContent=text;};
const MAX_SIDE=1600,MAX_DATA_URL=1400000;

const request=(path,body,timeout)=>fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':state.csrf}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
async function readResponse(response,path) {
  let value={};try {value=await response.json();} catch {}
  if(response.status===401&&path!=='/api/session') {showSignedOut(value.error||'Sign in again.');throw new Error(value.error||'Sign in again.');}
  if(!response.ok) throw new Error(value.error||`Request failed (HTTP ${response.status}).`);
  return value;
}
async function api(path,body,timeout=30000) {return readResponse(await request(path,body,timeout),path);}

// The chat answer arrives as lines of JSON: progress steps and, where the model streams, answer text
// (delta, or reset when a new answer replaces it), then a done or an error line.
async function chatStream(body,onStep,onDelta=()=>{}) {
  const response=await request('/api/chat',body,430000);
  if(!(response.headers.get('Content-Type')||'').includes('ndjson')) return readResponse(response,'/api/chat');
  const reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer='',last=null;
  for(;;) {
    const {value,done}=await reader.read();
    if(done) break;
    buffer+=value;
    for(let end=buffer.indexOf('\n');end>=0;end=buffer.indexOf('\n')) {
      const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);
      if(!line) continue;
      const event=JSON.parse(line);
      if(event.type==='step') onStep(event.text);
      else if(event.type==='delta') onDelta(event.text);
      else if(event.type==='reset') onDelta(null);
      else last=event;
    }
  }
  if(last?.type==='done') return last;
  throw new Error(last?.error||'The connection to the agent was lost. Open the conversation again to see whether the answer was saved.');
}

function showSignedOut(message) {
  $('account').textContent=message;$('login').hidden=false;$('logout').hidden=true;state.tab=null;
  for(const id of ['tabs','chat','dashboard-view','repo-bar']) $(id).hidden=true;
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
// hideTitle drops the first PR-TITLE line found in the prose, never one inside code or an edit.
function renderContent(text,{hideTitle=false}={}) {
  const fragment=document.createDocumentFragment();
  const pattern=/```[^\n]*\n([\s\S]*?)```|^<<<<<<< SEARCH[^\n]*\n[\s\S]*?^>>>>>>> REPLACE[ \t]*$/gm;
  let last=0;
  for(const match of text.matchAll(pattern)) {
    if(match.index>last) prose(text.slice(last,match.index));
    const pre=document.createElement('pre');pre.textContent=match[1]??match[0];fragment.append(pre);
    last=match.index+match[0].length;
  }
  prose(text.slice(last));
  return fragment;
  function prose(part) {
    if(hideTitle&&/^PR-TITLE:/m.test(part)) {part=part.replace(/^PR-TITLE:.*(?:\r?\n|$)/m,'');hideTitle=false;}
    const p=document.createElement('p');p.textContent=part.trim();if(p.textContent) fragment.append(p);
  }
}

const shortSha=sha=>sha.slice(0,7);
const targetText=(base,branch,moved)=>`Opens a pull request into ${base} from the new branch ${branch}.${moved?` The edits are applied to the latest ${base}; if they no longer fit, you will be told.`:''}`;
// Which code an answer is based on; marked when the branch has moved on since.
function renderMeta(meta) {
  const line=document.createElement('p');line.className='meta muted small';
  line.textContent=`${meta.repository} · ${meta.branch} @ ${shortSha(meta.sha)} · read ${meta.read} of ${meta.files} files`;
  line.dataset.sha=meta.sha;line.dataset.branch=meta.branch;
  const stale=document.createElement('span');stale.className='stale';stale.hidden=true;line.append(stale);
  return line;
}
const ciText={success:'✅ CI passed',failure:'❌ CI failed',pending:'⏳ CI running'};
const codexText={clear:'👍 Codex clear',findings:'⚠ Codex findings',running:'🔄 Codex reviewing',requested:'🔄 Codex reviewing',incomplete:'❔ Codex history too long to check'};
function pullStatusText(pr) {
  if(pr.state==='merged') return `PR #${pr.number} · merged`;
  if(pr.state==='closed') return `PR #${pr.number} · closed without merge`;
  return [`PR #${pr.number}`,ciText[pr.ci]||'CI unknown',codexText[pr.codex?.state]||'Codex not reviewed yet',pr.readiness?.label].filter(Boolean).join(' · ');
}

function renderMessage(message) {
  const item=document.createElement('article');item.className=`message ${message.role}`;
  const label=document.createElement('strong');label.textContent=message.role==='user'?'You':[message.meta?.agent||'Agent',message.meta?.agent&&message.meta?.model].filter(Boolean).join(' · ');item.append(label);
  if(message.hasImage) {const note=document.createElement('span');note.className='muted small';note.textContent=' · image attached';item.append(note);}
  if(message.role==='assistant'&&message.meta) item.append(renderMeta(message.meta));
  // An answer's PR-TITLE line is shown with its proposed change instead.
  item.append(renderContent(message.content,{hideTitle:message.role==='assistant'&&Boolean(message.proposal?.title)}));
  if(message.proposal) {
    const box=document.createElement('div');box.className='proposal';
    const files=document.createElement('p');files.textContent=`Proposed change${message.proposal.title?`: ${message.proposal.title}`:''} · ${message.proposal.paths.join(', ')}`;box.append(files);
    if(message.prUrl) {
      const number=followPull(message.prUrl);
      if(number) {const badge=document.createElement('p');badge.className='pr-status';badge.dataset.number=String(number);badge.textContent=`PR #${number}`;box.append(badge);}
      const link=document.createElement('a');link.href=message.prUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open pull request';box.append(link);
      if(number) {const follow=document.createElement('button');follow.type='button';follow.className='secondary';follow.textContent='Follow in dashboard';follow.onclick=()=>{showTab('dashboard',{hash:`#pr-${number}`});showPull(number);};box.append(follow);}
    } else if(message.id) {
      // Pull requests are opened from a new branch on the latest default branch (see /api/pull-request).
      const target=document.createElement('p');target.className='muted small target';
      target.dataset.branch=`autopilot/chat-${(state.conversation||'').slice(0,12)}-${message.id}`;
      target.textContent=targetText(message.meta?.branch||'the default branch',target.dataset.branch,false);
      box.append(target);
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
  refreshThread();
}

// Live details of the open conversation: whether the branch has moved on since each answer, and the
// status of pull requests opened from it. Webhook events move the repository's version on; without
// them the details are still read again every few minutes.
let threadVersion=null,threadRefreshed=0;
async function refreshThread() {
  threadRefreshed=Date.now();
  const conversation=state.conversation,repository=state.repository,container=$('messages');
  const metas=[...container.querySelectorAll('.meta')],pulls=[...container.querySelectorAll('.pr-status')],targets=container.querySelectorAll('.target');
  if(!conversation||(!metas.length&&!pulls.length&&!targets.length)) return;
  const repo=`repo=${encodeURIComponent(repository)}`;
  const current=()=>state.conversation===conversation&&state.repository===repository;
  // The version is read first, so an event that arrives during this refresh triggers another one.
  try {const {version}=await api(`/api/dashboard/version?${repo}`);if(current()) threadVersion=version;} catch {}
  if(!current()) return;
  if(metas.length||targets.length) api(`/api/head?${repo}`).then(head=>{
    if(!current()) return;
    for(const line of metas) {
      // A renamed or replaced default branch counts as a change too.
      const stale=line.querySelector('.stale');stale.hidden=line.dataset.branch===head.branch&&line.dataset.sha===head.sha;
      stale.textContent=line.dataset.branch===head.branch?` · ${head.branch} has moved on to ${shortSha(head.sha)}`:` · the default branch is now ${head.branch} @ ${shortSha(head.sha)}`;
    }
    // Pull requests are always opened on the latest default branch.
    for(const target of targets) {
      const line=target.closest('.message')?.querySelector('.meta');
      target.textContent=targetText(head.branch,target.dataset.branch,Boolean(line&&!line.querySelector('.stale').hidden));
    }
  }).catch(()=>{});
  for(const element of pulls) api(`/api/dashboard/pulls/${element.dataset.number}?${repo}`).then(pr=>{if(current()) element.textContent=pullStatusText(pr);}).catch(()=>{});
}
setInterval(async()=>{
  if(state.tab!=='chat'||document.hidden||!state.conversation||!$('messages').querySelector('.meta,.pr-status,.target')) return;
  try {
    const {version}=await api(`/api/dashboard/version?repo=${encodeURIComponent(state.repository)}`);
    if(version!==threadVersion||Date.now()-threadRefreshed>=180000) refreshThread();
  } catch {}
},15000);

// The repository picker. The choice is remembered on this device; conversations belong to a repository.
const sameRepo=(a,b)=>a.toLowerCase()===b.toLowerCase();
function repoLabel(name) {
  const [owner,repo]=name.split('/');
  return sameRepo(owner,state.home.split('/')[0])?repo:name;
}
// The agent picker, shown when there is more than one agent. The choice is remembered on this device.
const AGENT_KEY='autopilot-agent';
function fillAgents() {
  let remembered=null;
  try {remembered=localStorage.getItem(AGENT_KEY);} catch {}
  const chosen=state.agents.find(a=>a.id===remembered)||state.agents[0];
  state.agentId=chosen?.id||null;
  if(chosen) state.agent=chosen.name;
  $('agent').replaceChildren(...state.agents.map(a=>Object.assign(document.createElement('option'),{value:a.id,textContent:a.name,selected:a.id===state.agentId})));
  $('agent-row').hidden=state.agents.length<2;
}
$('agent').onchange=()=>{
  const chosen=state.agents.find(a=>a.id===$('agent').value);
  if(!chosen) return;
  state.agentId=chosen.id;state.agent=chosen.name;
  try {localStorage.setItem(AGENT_KEY,chosen.id);} catch {}
  fillModels();showAccount();
};
// The model picker: the agent's standard model, then every chat model its provider lists, with the
// context length. Models too small for the files the chat sends are marked. Remembered per agent.
const MODEL_KEY='autopilot-model:',SMALL_CONTEXT=32768;
const contextText=length=>length?` · ${length>=1000?`${Math.round(length/1024)}k`:length}`:'';
async function loadModels() {
  try {
    const {agents}=await api('/api/models');
    state.models=Object.fromEntries((agents||[]).map(a=>[a.id,Array.isArray(a.models)?a.models:[]]));
  } catch {state.models={};}
  fillModels();showAccount();
}
function fillModels() {
  const agent=state.agents.find(a=>a.id===state.agentId),models=state.models[state.agentId]||[];
  let remembered='';
  try {remembered=localStorage.getItem(MODEL_KEY+state.agentId)||'';} catch {}
  state.modelId=models.some(m=>m.id===remembered)?remembered:'';
  const standard=Object.assign(document.createElement('option'),{value:'',textContent:`Standard${agent?.modelName?` (${agent.modelName})`:''}`});
  const option=m=>Object.assign(document.createElement('option'),{value:m.id,
    textContent:`${m.contextLength&&m.contextLength<SMALL_CONTEXT?'⚠ ':''}${m.name}${contextText(m.contextLength)}`,
    title:m.contextLength&&m.contextLength<SMALL_CONTEXT?'Small context: it may not fit the repository files the chat sends.':''});
  // Providers such as Blablador list short, stable alias-* names next to their long model names; the
  // aliases come first in a group of their own.
  const aliases=models.filter(m=>/^alias-/i.test(m.name)),others=models.filter(m=>!/^alias-/i.test(m.name));
  const groups=aliases.length&&others.length?[['Aliases',aliases],['All models',others]].map(([label,list])=>{const g=document.createElement('optgroup');g.label=label;g.append(...list.map(option));return g;}):models.map(option);
  $('model').replaceChildren(standard,...groups);
  $('model').value=state.modelId;
  $('model-row').hidden=!models.length;
}
$('model').onchange=()=>{
  state.modelId=$('model').value;
  try {state.modelId?localStorage.setItem(MODEL_KEY+state.agentId,state.modelId):localStorage.removeItem(MODEL_KEY+state.agentId);} catch {}
  showAccount();
};
// The live version: the commit the deploy workflow shipped, linked to GitHub, and when.
function showAccount() {
  const account=$('account'),deployed=state.deployed;
  const agent=state.agents.find(a=>a.id===state.agentId);
  account.replaceChildren(`${state.login} · model ${agent?(state.modelId?`${agent.name} ${state.modelId.slice(state.modelId.indexOf(':')+1)} (AI gateway)`:agent.label):state.model} · `);
  if(!deployed) {account.append('version unknown');return;}
  const link=document.createElement('a');
  link.href=`https://github.com/${state.home}/commit/${deployed.commit}`;link.target='_blank';link.rel='noopener noreferrer';
  link.textContent=`version ${deployed.commit.slice(0,7)}`;link.id='deployed-version';
  account.append(link);
  if(deployed.at) account.append(` · deployed ${new Date(deployed.at).toLocaleString()}`);
}
function addRepoOption(name) {
  const picker=$('repo-picker');
  if(![...picker.options].some(option=>sameRepo(option.value,name))) picker.append(new Option(repoLabel(name),name));
  picker.value=[...picker.options].find(option=>sameRepo(option.value,name)).value;
}
function fillRepos(repositories) {
  const picker=$('repo-picker');
  picker.replaceChildren(...repositories.map(r=>new Option(`${repoLabel(r.fullName)}${r.private?' · private':''}`,r.fullName)));
  // A repository the app no longer reaches (uninstalled or renamed) gives way to the app's own.
  if(repositories.some(r=>sameRepo(r.fullName,state.repository))) addRepoOption(state.repository);
  else selectRepository(state.home);
}
async function loadRepos(fresh=false) {
  const {repositories}=await api(`/api/repos${fresh?'?fresh=1':''}`);
  return repositories;
}
// keepConversation: the open conversation already belongs to the new repository.
function selectRepository(name,{keepConversation=false}={}) {
  addRepoOption(name);
  if(sameRepo(name,state.repository)) return;
  state.repository=name;
  try {localStorage.setItem('autopilot-repo',name);} catch {}
  setRepository();
  if(state.tab==='dashboard') history.replaceState(null,'','#dashboard');
  if(!keepConversation) {status('');openConversation(null);}
}
const setBusy=busy=>{state.busy=busy;$('repo-picker').disabled=busy;$('repo-reload').disabled=busy;$('agent').disabled=busy;$('model').disabled=busy;};

async function loadConversations() {
  const repository=state.repository,request=++state.conversationRequest,list=$('conversations');
  // Another repository's conversations are removed at once, not when (or if) the new list arrives.
  if(list.dataset.repository!==repository) {list.replaceChildren();list.dataset.repository=repository;}
  const {conversations}=await api(`/api/conversations?repo=${encodeURIComponent(repository)}`);
  // A slower answer for an earlier repository must not replace the current list.
  if(request!==state.conversationRequest) return;
  list.replaceChildren();
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
  if(!id) {
    $('conversation-title').textContent='New conversation';renderMessages([]);
    try {await loadConversations();} catch(error) {status(error.message);}
    return;
  }
  try {
    const conversation=await api(`/api/conversations/${id}`);
    if(state.conversation!==id) return;
    if(conversation.repository) selectRepository(conversation.repository,{keepConversation:true});
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
  setBusy(true);button.disabled=true;status('Creating pull request…');
  try {
    await api('/api/pull-request',{conversation:state.conversation,message},250000);
    status('Pull request created. CI runs on GitHub.');
    setBusy(false);await openConversation(state.conversation);
  } catch(error) {status(error.message);button.disabled=false;}
  finally {setBusy(false);}
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
  setBusy(true);$('send').disabled=true;$('message').disabled=true;$('image').disabled=true;
  const container=$('messages');container.querySelector('.empty')?.remove();
  container.append(renderMessage({role:'user',content:text,hasImage:Boolean(state.image)}));
  // What the agent is doing, step by step; the current step is the last one.
  const thinking=document.createElement('ol');thinking.className='steps muted';container.append(thinking);
  const step=text=>{thinking.lastElementChild?.classList.add('done');const item=document.createElement('li');item.textContent=text;thinking.append(item);item.scrollIntoView({block:'end'});};
  step(`Reading the latest code of ${state.repository}…`);
  // The answer as it streams in. Edit blocks are left out of the preview; the saved answer shows the change.
  const live=document.createElement('article');live.className='message assistant';live.hidden=true;
  const liveText=document.createElement('p');live.append(Object.assign(document.createElement('strong'),{textContent:[state.agent||'Agent',state.modelId&&state.modelId.slice(state.modelId.indexOf(':')+1)].filter(Boolean).join(' · ')}),liveText);container.append(live);
  let streamed='';
  const delta=piece=>{
    streamed=piece===null?'':streamed+piece;
    const [prose,...edits]=streamed.split(/^<<<<<<< SEARCH/m);
    liveText.textContent=prose.trimEnd()+(edits.length?'\n\n…writing the proposed edits':'');
    live.hidden=!streamed;if(streamed) live.scrollIntoView({block:'end'});
  };
  status('');
  try {
    const result=await chatStream({conversation:state.conversation,repo:state.conversation?undefined:state.repository,text,image:state.image,agent:state.agentId||undefined,model:state.modelId||undefined},step,delta);
    $('message').value='';clearImage();thinking.remove();live.remove();
    setBusy(false);state.conversation=result.conversation;await openConversation(result.conversation);
  } catch(error) {
    live.remove();thinking.remove();container.lastElementChild?.remove();
    status(error.name==='TimeoutError'?'The agent did not answer in time. Try again.':error.message);
  } finally {setBusy(false);$('send').disabled=false;$('message').disabled=false;$('image').disabled=false;}
};
$('new-conversation').onclick=()=>{if(!state.busy) {status('');openConversation(null);$('message').focus();}};
$('logout').onclick=async()=>{try {await api('/api/logout',{});} catch {} location.replace('/');};

const SIGN_IN_PROBLEMS={cancelled:'Sign-in was cancelled.',expired:'The sign-in expired or started in another browser. Try again.',failed:'GitHub sign-in failed. Try again.',app:'The chat must use the client ID and secret of a GitHub App, not an OAuth app.',owner:'Only the repository owner account can use this chat.',github:'GitHub rejected the sign-in. Check the GitHub App\'s callback URL and client ID.'};
const signInProblem=SIGN_IN_PROBLEMS[new URLSearchParams(location.search).get('signin')];
// A link from the connector names the repository of the pull request it opens (?repo=owner/name#pr-12).
// One opened while signed out is kept for this tab through the sign-in, which returns to "/".
let linked={repo:new URLSearchParams(location.search).get('repo'),hash:location.hash};
const LINK_KEY='autopilot-link',LINKED_HASH=/^#(?:pr-\d+|dashboard)$/;
if(location.search) history.replaceState(null,'',location.pathname+location.hash);
$('tab-dashboard').onclick=()=>showTab('dashboard');
$('tab-chat').onclick=()=>showTab('chat');
$('repo-picker').onchange=()=>{if(state.busy) $('repo-picker').value=state.repository;else selectRepository($('repo-picker').value);};
$('repo-reload').onclick=async()=>{
  setBusy(true);status('Reloading repositories…');
  let repositories=null;
  try {repositories=await loadRepos(true);status('');} catch(error) {status(error.message);}
  finally {setBusy(false);}
  if(repositories) fillRepos(repositories);
};
try {
  const session=await api('/api/session');
  if(!session.login) {
    try {if(linked.repo||LINKED_HASH.test(linked.hash)) sessionStorage.setItem(LINK_KEY,JSON.stringify(linked));} catch {}
    showSignedOut(signInProblem?`${signInProblem} Sign in with the owner account of ${session.repository}.`:`Sign in with the owner account of ${session.repository}.`);
  } else {
    try {
      const saved=!linked.repo&&!linked.hash?JSON.parse(sessionStorage.getItem(LINK_KEY)||'null'):null;
      sessionStorage.removeItem(LINK_KEY);
      if(saved) {
        linked={repo:typeof saved.repo==='string'?saved.repo:null,hash:LINKED_HASH.test(saved.hash)?saved.hash:''};
        if(linked.hash) history.replaceState(null,'',location.pathname+linked.hash);
      }
    } catch {}
    Object.assign(state,{csrf:session.csrf,home:session.repository,repository:session.repository,login:session.login,model:session.model,agent:session.agent||'',agents:Array.isArray(session.agents)?session.agents:[],deployed:session.deployed||null});
    fillAgents();
    showAccount();
    if(state.agents.length>1) loadModels();
    // The remembered repository is used when it is still reachable; otherwise the app's own.
    let repositories=[{fullName:session.repository,private:false}],remembered=null;
    try {repositories=await loadRepos();} catch(error) {status(error.message);}
    try {remembered=localStorage.getItem('autopilot-repo');} catch {}
    const reachable=name=>name&&repositories.find(r=>sameRepo(r.fullName,name))?.fullName;
    state.repository=reachable(linked.repo)||reachable(remembered)||session.repository;
    // A pull request number belongs to the linked repository: when that one cannot be opened, the number is
    // dropped instead of opening the same number in another repository.
    if(linked.repo&&!reachable(linked.repo)&&/^#pr-/.test(location.hash)) {
      history.replaceState(null,'',`${location.pathname}#dashboard`);
      dashboardNotice(`The linked repository ${linked.repo} is not available here.`);
    }
    fillRepos(repositories);
    $('logout').hidden=false;$('tabs').hidden=false;$('repo-bar').hidden=false;
    startDashboard(api,{isVisible:()=>state.tab==='dashboard',selected:()=>state.repository});
    // Older chat links used #<conversation>; they still open the chat.
    const hash=location.hash,conversation=/^#(?:chat\/)?([0-9a-f]{32})$/.exec(hash)?.[1]||null,pull=/^#pr-([1-9]\d{0,8})$/.exec(hash)?.[1];
    let saved=null;try {saved=localStorage.getItem('autopilot-tab');} catch {}
    const tab=conversation||hash==='#chat'?'chat':pull||hash==='#dashboard'?'dashboard':saved==='chat'?'chat':'dashboard';
    state.tab=tab;
    // The dashboard starts loading at once instead of waiting for the conversation list.
    const chat=openConversation(conversation);
    showTab(tab,{hash:pull?`#pr-${pull}`:undefined});
    if(pull) showPull(Number(pull));
    await chat;
  }
} catch(error) {$('account').textContent=error.message||'Repo Autopilot is unavailable. Try again later.';}
