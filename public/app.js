import {createGitHub, repositoryName} from './github.js';
import {loadSavedData} from './saved-data.js';
import {renderSummary,renderPulls,renderWorkflows,applyFilters as filter} from './dashboard-view.js';
const $ = id => document.getElementById(id);
const staticMode = document.documentElement.dataset.mode === 'static';
const github = createGitHub({pullLimit:5});
const configuredRepository='cryptomanxxx/repo-autopilot';
const snapshots = new Map();
let latestData=null;
let loading=false;
let backgroundRefresh=false;
let usingSavedSnapshot=false;
let lastRefresh=0;
const activeWork=()=>latestData?.pulls.some(pr=>pr.state === 'open');
const applyFilters=()=>filter({pullFilter:$('pr-filter'),workflowFilter:$('workflow-filter'),pulls:$('pulls'),workflows:$('workflows')});
for(const id of ['pr-filter','workflow-filter']) $(id).addEventListener('change',applyFilters);
function updateAge() {
  if(!latestData) return;
  const age=Math.max(0,Math.floor((Date.now()-Date.parse(latestData.fetchedAt))/60000));
  if(!Number.isFinite(age)) {$('data-age').textContent='Data timestamp unavailable';return;}
  $('data-age').textContent=`Data updated ${age} minute${age === 1 ? '' : 's'} ago · ${usingSavedSnapshot ? activeWork() ? 'Page checks saved data every 20 seconds' : 'Page checks saved data every minute' : 'Refresh manually to get latest data'}`;
}
setInterval(()=>{
  updateAge();
  if(!document.hidden && !loading && usingSavedSnapshot && Date.now()-lastRefresh >= (activeWork() ? 20000 : 60000)) {
    try {if(repositoryName($('repo').value).toLowerCase() !== configuredRepository) return;} catch {return;}
    lastRefresh=Date.now();backgroundRefresh=true;$('repository').requestSubmit();
  }
},20000);
$('mode-note').textContent = staticMode ? 'Repo Autopilot uses saved GitHub Actions data · No login required. Other public repositories use GitHub’s anonymous API limits.' : 'Local server mode · Credentials stay on the server.';
const selected = new URLSearchParams(location.search).get('repo');
$('repo').value = selected || configuredRepository;
$('repository').addEventListener('submit',async event => {
  event.preventDefault();if(loading) return;loading=true;const automatic=backgroundRefresh;backgroundRefresh=false;const button = event.target.querySelector('button');button.disabled=true;
  $('status').textContent=automatic ? 'Checking saved data…' : 'Fetching GitHub data…';if(!automatic) $('dashboard').hidden=true;
  try {
    const repo = repositoryName($('repo').value);
    $('repo').value = repo;
    let data;
    const savedSnapshot=staticMode && repo.toLowerCase() === configuredRepository;
    if(savedSnapshot) {
      data=await loadSavedData(configuredRepository);
      if(latestData?.repository === data.repository && Date.parse(latestData.fetchedAt)>Date.parse(data.fetchedAt)) data=latestData;
    } else if(staticMode) {
      const cached = snapshots.get(repo);
      if(cached && Date.now()-cached.at < 60000) data = cached.data;
      else {data = await github.snapshot(repo);if(snapshots.size >= 20) snapshots.delete(snapshots.keys().next().value);snapshots.set(repo,{at:Date.now(),data});}
    } else {
      const response = await fetch(`./api/dashboard?repo=${encodeURIComponent(repo)}`);
      data = await response.json();if(!response.ok) throw new Error(data.error || 'Unable to load dashboard.');
    }
    renderSummary($('summary'),data);
    const snapshotAge=Date.now()-Date.parse(data.fetchedAt);
    if(savedSnapshot && (!Number.isFinite(snapshotAge) || snapshotAge>30*60*1000 || snapshotAge < -60000)) {
      data={...data,pulls:data.pulls.map(pr=>pr.readiness.state === 'ready' ? {...pr,readiness:{state:'unknown',label:'Cannot verify merge readiness',reasons:['Saved snapshot is stale; check current GitHub status']}} : pr)};
    }
    usingSavedSnapshot=savedSnapshot;latestData=data;updateAge();
    renderPulls($('pulls'),data.pulls);
    renderWorkflows($('workflows'),data.workflows);
    applyFilters();
    $('scope').textContent=[data.scope,...data.warnings].join(' ');$('dashboard').hidden=false;
    const age=Date.now()-Date.parse(data.fetchedAt);
    $('status').textContent=savedSnapshot ? `Loaded saved GitHub Actions snapshot. Data updates independently of Pages after PR, review and CI events; scheduled refresh every 15 minutes.${!Number.isFinite(age) || age>30*60*1000 || age < -60000 ? ' This snapshot is over 30 minutes old or its timestamp cannot be verified; check GitHub before merging.' : ''}` : 'Loaded. Submit again to refresh (snapshots cached for 60 seconds).';
  } catch(error) {$('status').textContent=automatic ? `Refresh failed; showing previous data. ${error.message}` : error.message;if(automatic && latestData) $('dashboard').hidden=false;} finally {button.disabled=false;loading=false;}
});
