import {renderSummary,renderPulls,renderWorkflows,applyFilters,mergeBlocker,el,link} from './dashboard-view.js';

const $=id=>document.getElementById(id);
const REFRESH_MS=180000,VERSION_MS=15000;
let api=null,repository=()=>'',data=null,loading=false,lastLoad=0,pendingPull=null,version=null,merging=false,retried=null;
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
  } else {
    retried=null;
    status(el('span',`PR #${number} is not among the ${data.pulls.length} most recently updated pull requests. `));
    $('dashboard-status').append(link('Open it on GitHub',`https://github.com/${data.repository}/pull/${number}`));
  }
}

export async function loadDashboard({fresh=false}={}) {
  if(loading||!api||$('dashboard-view').hidden) return;
  loading=true;$('refresh').disabled=true;
  // Every request of one load uses the repository selected when it started.
  const target=repository(),query=`repo=${encodeURIComponent(target)}`;
  if(!data) status('Loading live GitHub data…');
  try {
    // The version is read first, so a change reported while loading triggers one more load.
    const seen=(await api(`/api/dashboard/version?${query}`)).version;
    const overview=await api(`/api/dashboard?${query}${fresh?'&fresh=1':''}`);
    // Each pull request is loaded by its own request so every Worker call stays within its GitHub budget.
    const pulls=await Promise.all(overview.pulls.map(pr=>api(`/api/dashboard/pulls/${pr.number}?${query}&updated=${encodeURIComponent(pr.updatedAt)}${fresh?'&fresh=1':''}`).catch(error=>unavailable(pr,error))));
    if(target!==repository()) return;
    version=seen>0?seen:version;
    data={...overview,pulls,warnings:[...overview.warnings,...pulls.flatMap(pr=>pr.warnings||[])]};
    renderSummary($('summary'),data);
    renderPulls($('pulls'),data.pulls,{onMerge:mergePull});
    renderWorkflows($('workflows'),data.workflows);
    filters();
    $('scope').textContent=[data.scope,...data.warnings].join(' ');
    status('');updateAge();openPending();
  } catch(error) {
    if(target===repository()) status(data?`Refresh failed; showing earlier data. ${error.message}`:error.message);
  } finally {
    loading=false;lastLoad=Date.now();$('refresh').disabled=false;
    // The repository changed while loading: load the one now selected.
    if(target!==repository()) loadDashboard();
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
    // The outcome stays visible after the reload, which clears the status line.
    await loadDashboard();
    if(target===repository()) status(outcome);
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
  data=null;version=null;pendingPull=null;retried=null;
  for(const id of ['summary','pulls','workflows']) $(id).replaceChildren();
  $('scope').textContent='';$('data-age').textContent='';status('');
  loadDashboard();
}

export function startDashboard(request,{isVisible,selected}) {
  api=request;repository=selected;
  setInterval(()=>{if(isVisible()) checkVersion();},VERSION_MS);
  for(const id of ['pr-filter','workflow-filter']) $(id).addEventListener('change',filters);
  $('refresh').onclick=()=>loadDashboard({fresh:true});
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

export function showPull(number) {
  pendingPull=number;
  if(data&&!loading) openPending();
}
