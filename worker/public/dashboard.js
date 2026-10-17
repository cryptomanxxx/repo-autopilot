import {renderSummary,renderPulls,renderWorkflows,applyFilters,mergeBlocker,el,link} from './dashboard-view.js';

const $=id=>document.getElementById(id);
const REFRESH_MS=180000,VERSION_MS=15000;
// "Show more" raises these in steps, up to the server's maximum.
const PULLS={step:6,max:30},RUNS={step:15,max:60};
let pullLimit=PULLS.step,runLimit=RUNS.step;
let api=null,repository=()=>'',data=null,loading=false,lastLoad=0,pendingPull=null,pinned=null,version=null,merging=false,retried=null,reloadAfter=false,notice='',noticeFrom=0,loads=0;
const askedCodex=new Set();
const status=text=>{$('dashboard-status').replaceChildren(text);};
const filters=()=>applyFilters({pullFilter:$('pr-filter'),workflowFilter:$('workflow-filter'),pulls:$('pulls'),workflows:$('workflows')});

// Shown when one pull request's details cannot be loaded; the rest of the dashboard still renders.
function unavailable(pr,error) {
  return {...pr,draft:false,headSha:'',openedAt:pr.updatedAt,mergedAt:null,ci:'unknown',checksComplete:false,unresolvedThreads:null,
    readiness:{state:'unknown',label:'Details unavailable',reasons:[]},codex:{state:'unknown',label:'Codex: details unavailable'},
    progress:{reviewCount:null,updatesAfterReview:null,currentCompleted:false},detailError:error.message};
}

function updateAge() {
  if(!data) return;
  const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(data.fetchedAt))/60000));
  $('data-age').textContent=`Live GitHub data · loaded ${minutes} minute${minutes===1?'':'s'} ago · ${version===null?'refreshes every 3 minutes while this tab is open':'updates when GitHub reports a change'}`;
}

function openPending() {
  if(pendingPull===null||!data) return;
  const number=pendingPull;pendingPull=null;
  const row=$('pulls').querySelector(`details[data-number="${number}"]`);
  if(row) {
    retried=null;
    $('pr-filter').value='all';filters();
    row.open=true;row.scrollIntoView({block:'start'});
  } else if(retried!==number) {
    // A pull request opened moments ago may be missing from earlier data: load fresh data once.
    retried=number;pendingPull=number;
    setTimeout(()=>loadDashboard({fresh:true}),0);
  } else if(pinned!==number) {
    // An older pull request, opened by a link: it is loaded by itself and shown after the recent ones.
    pinned=number;pendingPull=number;
    setTimeout(()=>loadDashboard(),0);
  } else {
    retried=null;pinned=null;
    status(el('span',`PR #${number} could not be loaded. `));
    $('dashboard-status').append(link('Open it on GitHub',`https://github.com/${data.repository}/pull/${number}`));
  }
}

export async function loadDashboard({fresh=false}={}) {
  if(loading||!api||$('dashboard-view').hidden) return;
  loading=true;$('refresh').disabled=true;
  const load=++loads;
  // Every request of one load uses the repository selected when it started.
  const target=repository(),query=`repo=${encodeURIComponent(target)}`;
  if(!data) status('Loading live GitHub data…');
  try {
    // The version is read first, so a change reported while loading triggers one more load.
    const seen=(await api(`/api/dashboard/version?${query}`)).version;
    const limits=`${pullLimit>PULLS.step?`&pulls=${pullLimit}`:''}${runLimit>RUNS.step?`&runs=${runLimit}`:''}`;
    const overview=await api(`/api/dashboard?${query}${limits}${fresh?'&fresh=1':''}`);
    // Each pull request is loaded by its own request so every Worker call stays within its GitHub budget.
    const pulls=await Promise.all(overview.pulls.map(pr=>api(`/api/dashboard/pulls/${pr.number}?${query}&updated=${encodeURIComponent(pr.updatedAt)}${fresh?'&fresh=1':''}`).catch(error=>unavailable(pr,error))));
    // A linked pull request older than the overview stays shown below it; one that cannot be read is dropped.
    const extra=pinned&&!overview.pulls.some(pr=>pr.number===pinned)?await api(`/api/dashboard/pulls/${pinned}?${query}${fresh?'&fresh=1':''}`).catch(()=>null):null;
    if(extra) pulls.push(extra);
    if(target!==repository()) return;
    version=seen>0?seen:version;
    data={...overview,pulls,warnings:[...overview.warnings,...pulls.flatMap(pr=>pr.warnings||[])]};
    // The summary counts the recent pull requests only, not a linked older one shown below them.
    renderSummary($('summary'),extra?{...data,pulls:pulls.slice(0,-1)}:data);
    renderPulls($('pulls'),data.pulls,{onMerge:mergePull,onCodex:askCodex,askedCodex:(kind,pr)=>pr.codexReviewAsked===true||askedCodex.has(`${kind}:${target}#${pr.number}@${pr.headSha}`)});
    renderWorkflows($('workflows'),data.workflows);
    // More can exist only when a list came back full.
    $('more-pulls').hidden=overview.pulls.length<pullLimit||pullLimit>=PULLS.max;
    $('more-runs').hidden=data.workflows.length<runLimit||runLimit>=RUNS.max;
    filters();
    $('scope').textContent=[data.scope,...data.warnings].join(' ');
    // A merge outcome stays until a load started after the merge shows its result.
    status(notice);if(load>=noticeFrom) notice='';
    updateAge();openPending();
  } catch(error) {
    if(target===repository()) status(data?`Refresh failed; showing earlier data. ${error.message}`:error.message);
  } finally {
    // Connected apps do not depend on GitHub, so they load even when the dashboard data fails, and the
    // owner can always revoke one.
    loadConnections();
    loading=false;lastLoad=Date.now();$('refresh').disabled=false;
    // The repository changed while loading, or a merge finished during it: load again.
    if(target!==repository()||reloadAfter) {reloadAfter=false;lastLoad=0;loadDashboard();}
  }
}

// Squash-merges after confirmation. The server checks everything again and merges only the head shown
// here, and only if the unverified items it finds are the ones confirmed in this dialog.
async function mergePull(pr,button) {
  if(merging||mergeBlocker(pr)) return;
  const confirmed=pr.readiness.state==='ready'?[]:pr.readiness.reasons;
  const unverified=confirmed.length?`\n\nNot everything is verified:\n- ${confirmed.join('\n- ')}`:'';
  if(!confirm(`Merge PR #${pr.number} "${pr.title}" into the default branch?${unverified}`)) return;
  const target=repository();
  merging=true;button.disabled=true;status(`Merging PR #${pr.number}…`);
  let outcome;
  try {
    await api('/api/merge',{repository:target,number:pr.number,sha:pr.headSha,confirmed},60000);
    outcome=`PR #${pr.number} merged.`;
  } catch(error) {outcome=error.message;}
  finally {
    merging=false;
    // The data shown is stale now: a load already running or a hidden tab reloads it later, the next
    // time the tab is shown. The outcome is shown now and again once that reload completes.
    lastLoad=0;reloadAfter=loading;
    if(target===repository()) {status(outcome);notice=outcome;noticeFrom=loads+1;}
    loadDashboard();
  }
}

// Asks Codex to review the head shown; the server posts the comment once per commit.
async function askCodex(action,pr,button) {
  const target=repository();
  button.disabled=true;status(`Asking Codex to review PR #${pr.number}…`);
  try {
    const {already}=await api(`/api/codex-${action.kind}`,{repository:target,number:pr.number,sha:pr.headSha});
    askedCodex.add(`${action.kind}:${target}#${pr.number}@${pr.headSha}`);
    button.textContent=action.asked;
    if(target===repository()) status(already?`Codex was already asked to review PR #${pr.number} at this commit.`:`Asked Codex to review PR #${pr.number}. Its result appears here when done.`);
  } catch(error) {
    button.disabled=false;
    if(target===repository()) status(error.message);
  }
}

// Apps connected through the Claude/ChatGPT connector, with a button to revoke each. Reading them needs
// no GitHub request.
async function loadConnections() {
  let data;
  try {data=await api('/api/connections');} catch {return;}
  $('mcp-url').textContent=data.endpoint;
  const list=$('connections');list.replaceChildren();
  if(!data.connections.length) {list.append(el('p','No apps connected yet.','muted connection-empty'));return;}
  for(const c of data.connections) {
    const row=el('div','','connection-row');
    const revoke=el('button','Revoke','secondary');revoke.type='button';
    revoke.onclick=async()=>{
      if(!confirm(`Revoke ${c.name}? It loses access to Repo Autopilot at once.`)) return;
      revoke.disabled=true;
      try {await api('/api/connections/revoke',{id:c.id});status(`${c.name} was revoked.`);} catch(error) {status(error.message);revoke.disabled=false;return;}
      loadConnections();
    };
    row.append(el('strong',c.name),el('span',c.redirectHost?`returns to ${c.redirectHost}`:'','muted small'),el('span',`connected ${new Date(c.created).toLocaleDateString()} · last used ${new Date(c.used).toLocaleString()}`,'muted small'),revoke);
    list.append(row);
  }
}

// Webhook events move the repository's version on; checking it costs no GitHub request.
async function checkVersion() {
  if(loading||!data||$('dashboard-view').hidden||document.hidden) return;
  const target=repository();
  try {
    const {version:current}=await api(`/api/dashboard/version?repo=${encodeURIComponent(target)}`);
    if(target===repository()&&current>0&&current!==version) loadDashboard();
  } catch {}
}

// Called when another repository is selected: forget the old data and load the new one if visible.
export function setRepository() {
  data=null;version=null;pendingPull=null;pinned=null;retried=null;notice='';pullLimit=PULLS.step;runLimit=RUNS.step;
  $('more-pulls').hidden=true;$('more-runs').hidden=true;
  for(const id of ['summary','pulls','workflows']) $(id).replaceChildren();
  $('scope').textContent='';$('data-age').textContent='';status('');
  loadDashboard();
}

export function startDashboard(request,{isVisible,selected}) {
  api=request;repository=selected;
  setInterval(()=>{if(isVisible()) checkVersion();},VERSION_MS);
  for(const id of ['pr-filter','workflow-filter']) $(id).addEventListener('change',filters);
  $('refresh').onclick=()=>loadDashboard({fresh:true});
  $('copy-mcp').onclick=async()=>{try {await navigator.clipboard.writeText($('mcp-url').textContent);status('Connector address copied.');} catch {status('Select the address and copy it.');}};
  // A load already running finishes first; the larger list is loaded right after it.
  const more=(id,raise)=>{$(id).onclick=()=>{raise();$(id).hidden=true;if(loading) reloadAfter=true;else loadDashboard();};};
  more('more-pulls',()=>{pullLimit=Math.min(PULLS.max,pullLimit+PULLS.step);});
  more('more-runs',()=>{runLimit=Math.min(RUNS.max,runLimit+RUNS.step);});
  setInterval(()=>{
    updateAge();
    if(isVisible()&&!document.hidden&&Date.now()-lastLoad>=REFRESH_MS) loadDashboard();
  },30000);
  document.addEventListener('visibilitychange',()=>{if(isVisible()&&!document.hidden&&Date.now()-lastLoad>=60000) loadDashboard();});
}

// Called when the dashboard tab is shown; loads data the first time and when it is older than a minute.
export function showDashboard() {
  if(!data||Date.now()-lastLoad>=60000) loadDashboard();
  else openPending();
}

// A message for the dashboard's status line that stays through the next load.
export function dashboardNotice(text) {notice=text;noticeFrom=0;status(text);}

export function showPull(number) {
  pendingPull=number;
  if(data&&!loading) openPending();
}
