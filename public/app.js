import {createGitHub, repositoryName} from './github.js';
const $ = id => document.getElementById(id);
function el(tag, text, className) {const node = document.createElement(tag);node.textContent = text;if(className) node.className = className;return node;}
function link(text, url) {const node = el('a',text);if(typeof url === 'string' && url.startsWith('https://github.com/')) {node.href=url;node.target='_blank';node.rel='noopener noreferrer';}return node;}
function cell(label,text,className='') {const node=el('span','',`list-cell ${className}`);node.append(el('span',label,'cell-label'),el('span',text));return node;}
const staticMode = document.documentElement.dataset.mode === 'static';
const github = createGitHub({pullLimit:5});
const configuredRepository='cryptomanxxx/repo-autopilot';
const snapshots = new Map();
let latestData=null;
let loading=false;
let backgroundRefresh=false;
let usingSavedSnapshot=false;
function applyFilters() {
  const choice=$('pr-filter').value;
  for(const row of $('pulls').querySelectorAll('.pr-row')) row.hidden=!(choice === 'all' || row.dataset.state === choice || choice === 'attention' && row.dataset.attention === 'true');
  const workflow=$('workflow-filter').value;
  for(const row of $('workflows').querySelectorAll('.workflow-row:not(.list-head)')) row.hidden=workflow !== 'all' && row.dataset.category !== workflow;
}
for(const id of ['pr-filter','workflow-filter']) $(id).addEventListener('change',applyFilters);
function updateAge() {
  if(!latestData) return;
  const age=Math.max(0,Math.floor((Date.now()-Date.parse(latestData.fetchedAt))/60000));
  if(!Number.isFinite(age)) {$('data-age').textContent='Data timestamp unavailable';return;}
  $('data-age').textContent=`Data updated ${age} minute${age === 1 ? '' : 's'} ago · ${usingSavedSnapshot ? 'Page checks saved data every minute' : 'Refresh manually to get latest data'}`;
}
setInterval(()=>{
  updateAge();
  if(!document.hidden && !loading && usingSavedSnapshot) {
    try {if(repositoryName($('repo').value).toLowerCase() !== configuredRepository) return;} catch {return;}
    backgroundRefresh=true;$('repository').requestSubmit();
  }
},60000);
$('mode-note').textContent = staticMode ? 'Repo Autopilot uses saved GitHub Actions data · No login required. Other public repositories use GitHub’s anonymous API limits.' : 'Local server mode · Credentials stay on the server.';
const selected = new URLSearchParams(location.search).get('repo');
$('repo').value = selected || configuredRepository;
$('repository').addEventListener('submit',async event => {
  event.preventDefault();if(loading) return;loading=true;const automatic=backgroundRefresh;backgroundRefresh=false;const expanded=new Set([...$('pulls').querySelectorAll('details[open]')].map(n=>n.dataset.number));const button = event.target.querySelector('button');button.disabled=true;
  $('status').textContent=automatic ? 'Checking saved data…' : 'Fetching GitHub data…';if(!automatic) $('dashboard').hidden=true;
  try {
    const repo = repositoryName($('repo').value);
    $('repo').value = repo;
    let data;
    const savedSnapshot=staticMode && repo.toLowerCase() === configuredRepository;
    if(savedSnapshot) {
      const response=await fetch('./data/snapshot.json',{cache:'no-store'});
      if(!response.ok) throw new Error('Saved snapshot is not available yet. Please try again after the GitHub Pages deployment finishes.');
      data=await response.json();
      if(data.repository?.toLowerCase() !== configuredRepository) throw new Error('Saved snapshot repository does not match.');
    } else if(staticMode) {
      const cached = snapshots.get(repo);
      if(cached && Date.now()-cached.at < 60000) data = cached.data;
      else {data = await github.snapshot(repo);if(snapshots.size >= 20) snapshots.delete(snapshots.keys().next().value);snapshots.set(repo,{at:Date.now(),data});}
    } else {
      const response = await fetch(`./api/dashboard?repo=${encodeURIComponent(repo)}`);
      data = await response.json();if(!response.ok) throw new Error(data.error || 'Unable to load dashboard.');
    }
    $('summary').replaceChildren(el('strong',data.repository),el('span',`Snapshot: ${new Date(data.fetchedAt).toLocaleString()}`),el('span',`${data.pulls.filter(p=>p.state==='open').length} open in recent PRs`));
    const snapshotAge=Date.now()-Date.parse(data.fetchedAt);
    if(savedSnapshot && (!Number.isFinite(snapshotAge) || snapshotAge>30*60*1000 || snapshotAge < -60000)) {
      data={...data,pulls:data.pulls.map(pr=>pr.readiness.state === 'ready' ? {...pr,readiness:{state:'unknown',label:'Cannot verify merge readiness',reasons:['Saved snapshot is stale; check current GitHub status']}} : pr)};
    }
    usingSavedSnapshot=savedSnapshot;latestData=data;updateAge();
    $('pulls').replaceChildren();
    const headings=el('div','','pr-summary list-head');for(const title of ['PR','Merge','CI','Codex','#Reviews','#Changes']) headings.append(el('span',title));headings.setAttribute('aria-hidden','true');$('pulls').append(headings);
    for(const pr of data.pulls) {
      const node=el('details','','pr-row');
      node.dataset.number=String(pr.number);node.dataset.state=pr.state;node.dataset.attention=String(pr.state === 'open' && pr.readiness.state !== 'ready');node.open=expanded.has(String(pr.number));
      const summary=el('summary','','pr-summary');
      const progress=pr.progress;
      const waiting=['running','requested'].includes(pr.codex.state);
      const codexText=pr.codex.state === 'clear' ? '✅ Reviewed · clear' : pr.codex.state === 'findings' ? '⚠ Findings' : waiting ? '🔄 Pending' : progress.currentCompleted ? '✓ Reviewed · unverified' : '❔ Unverified';
      summary.append(cell('PR',`#${pr.number} ${pr.title}`,'pr-title'),cell('Merge',pr.readiness.label,`readiness-${pr.readiness.state}`),cell('CI',pr.ci === 'success' ? '✅ Passed' : pr.ci === 'failure' ? '❌ Failed' : pr.ci,`ci-${pr.ci}`),cell('Codex',codexText,`codex-${pr.codex.state}`),cell('Reviews',progress.reviewCount === null ? '?' : `≥${progress.reviewCount}`),cell('Code changes',String(progress.updatesAfterReview ?? '?')));
      summary.append(el('span','Details','expand-label'));
      node.append(summary);
      const detail=el('div','','pr-detail');
      const flow=el('ol','','review-flow');
      for(const event of progress.events || []) {const step=el('li','',`flow-${event.kind}`);step.append(el('strong',event.label),el('span',`${new Date(event.at).toLocaleString()}${event.commit ? ' · '+event.commit.slice(0,10) : ''}`,'muted'));flow.append(step);}
      detail.append(el('h3','PR activity'),el('p','Observed GitHub history · Updates with saved data; code changes do not prove an agent fixed findings. Earlier events may be missing.','muted'),flow);
      for(const reason of pr.readiness.reasons) detail.append(el('p',reason,'muted'));
      detail.append(el('p',`${['running','findings','clear'].includes(pr.codex.state) || progress.currentCompleted ? '✅' : '❔'} Codex review acknowledged`));
      detail.append(el('p',`${waiting ? '🔄' : progress.currentCompleted ? '✅' : '⏳'} Latest code review ${waiting ? 'pending' : progress.currentCompleted ? 'completed' : 'not verified'}`));
      detail.append(el('p',pr.codex.label,`codex-status codex-${pr.codex.state}`));
      detail.append(el('p',`Completed reviews: ${progress.reviewCount === null ? 'unknown' : `at least ${progress.reviewCount}`} · Commits after review: ${progress.updatesAfterReview ?? 'unknown'}`));
      detail.append(el('p','Code changes count commits after review; they do not confirm that findings were fixed.','muted'));
      detail.append(el('p',`Head: ${pr.headSha.slice(0,10)} · Opened: ${new Date(pr.openedAt).toLocaleString()}`));
      detail.append(el('p',pr.mergedAt ? `Merged: ${new Date(pr.mergedAt).toLocaleString()}` : `Updated: ${new Date(pr.updatedAt).toLocaleString()}`));
      detail.append(el('p',`${pr.state}${pr.draft ? ' · draft' : ''}`));
      if(pr.detailError) detail.append(el('p',`Details unavailable: ${pr.detailError}`,'error'));
      detail.append(link('View PR and review history on GitHub',pr.url));
      node.append(detail);$('pulls').append(node);
    }
    if(!data.pulls.length) $('pulls').append(el('p','No pull requests found.'));
    $('workflows').replaceChildren(...data.workflows.map(r=>{
      const node=el('div','','workflow-row');
      node.dataset.category=/deploy|pages/i.test(r.name) ? 'deployment' : /(?:\bci\b|test|build|lint|continuous integration|check)/i.test(r.name) ? 'ci' : 'other';
      const title=el('span','','workflow-title');title.append(link(r.title || r.name,r.url));
      node.append(title,cell('Workflow',r.name),cell('Status',r.conclusion || r.status),cell('Branch',r.branch),cell('Updated',new Date(r.updatedAt).toLocaleString()));
      return node;
    }));
    const workflowHead=el('div','','workflow-row list-head');for(const title of ['Run','Workflow','Status','Branch','Updated']) workflowHead.append(el('span',title));workflowHead.setAttribute('aria-hidden','true');$('workflows').prepend(workflowHead);
    if(!data.workflows.length) $('workflows').append(el('p','No workflow runs found.'));
    applyFilters();
    $('scope').textContent=[data.scope,...data.warnings].join(' ');$('dashboard').hidden=false;
    const age=Date.now()-Date.parse(data.fetchedAt);
    $('status').textContent=savedSnapshot ? `Loaded saved GitHub Actions snapshot. Updates after PR, review and CI events, with a scheduled refresh every 15 minutes.${!Number.isFinite(age) || age>30*60*1000 || age < -60000 ? ' This snapshot is over 30 minutes old or its timestamp cannot be verified; check GitHub before merging.' : ''}` : 'Loaded. Submit again to refresh (snapshots cached for 60 seconds).';
  } catch(error) {$('status').textContent=automatic ? `Refresh failed; showing previous data. ${error.message}` : error.message;if(automatic && latestData) $('dashboard').hidden=false;} finally {button.disabled=false;loading=false;}
});
