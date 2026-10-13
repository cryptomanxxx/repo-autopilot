// Dashboard rendering for the Repo Autopilot app.
// It only builds DOM nodes from dashboard data and never fetches anything itself.
export function el(tag,text,className) {const node=document.createElement(tag);node.textContent=text;if(className) node.className=className;return node;}
export function link(text,url) {const node=el('a',text);if(typeof url==='string'&&url.startsWith('https://github.com/')) {node.href=url;node.target='_blank';node.rel='noopener noreferrer';}return node;}
function cell(label,text,className='') {const node=el('span','',`list-cell ${className}`);node.append(el('span',label,'cell-label'),el('span',text));return node;}

export function renderSummary(container,data) {
  container.replaceChildren(el('strong',data.repository),el('span',`Snapshot: ${new Date(data.fetchedAt).toLocaleString()}`),el('span',`${data.pulls.filter(p=>p.state==='open').length} open in recent PRs`));
}

// Merging is offered for open pull requests once Codex has cleared the current code and GitHub reports
// no blocker; the button stays visible but disabled until then, saying why.
export function mergeBlocker(pr) {
  if(pr.codex?.state!=='clear') return 'Waiting for a Codex 👍 on the current code.';
  if(pr.readiness?.state==='not_ready') return `Not ready: ${pr.readiness.reasons.join('; ')}.`;
  return '';
}
// Codex can be asked, once per commit, to fix its findings on the current code, or to review code it
// has not reviewed yet; an incomplete history offers neither, since it may hide either.
export const CODEX_ACTIONS=[
  {kind:'fix',show:state=>state==='findings',label:'Ask Codex to fix',asked:'Codex asked to fix',title:'Comments "@codex address that feedback" on the pull request; Codex then pushes a fix.'},
  {kind:'review',show:state=>['unknown','unverified'].includes(state),label:'Ask Codex to review',asked:'Codex review requested',title:'Comments "@codex review" on the pull request.'},
];
function mergeBar(pr,{onMerge,onCodex,askedCodex}) {
  const bar=el('div','','merge-bar'),button=el('button','Merge','merge');
  const blocker=mergeBlocker(pr);
  button.type='button';button.disabled=Boolean(blocker);
  if(!blocker) button.classList.add('merge-ready');
  button.onclick=()=>onMerge(pr,button);
  bar.append(button);
  for(const action of CODEX_ACTIONS) {
    if(!onCodex||!action.show(pr.codex?.state)) continue;
    const asked=askedCodex(action.kind),ask=el('button',asked?action.asked:action.label,`secondary codex-${action.kind}`);
    ask.type='button';ask.disabled=asked;ask.title=action.title;
    ask.onclick=()=>onCodex(action,pr,ask);
    bar.append(ask);
  }
  bar.append(el('span',blocker||'Codex 👍 on the current code. Squash-merges into the default branch after you confirm.','muted'));
  return bar;
}

export function renderPull(pr,{open=false,onMerge,onCodex,askedCodex=()=>false}={}) {
  const node=el('details','','pr-row');
  node.dataset.number=String(pr.number);node.dataset.state=pr.state;node.dataset.attention=String(pr.state==='open'&&pr.readiness.state!=='ready');node.open=open;
  const summary=el('summary','','pr-summary');
  const progress=pr.progress;
  const waiting=['running','requested'].includes(pr.codex.state);
  const codexText=pr.codex.state==='clear'?'✅ Reviewed · clear':pr.codex.state==='findings'?'⚠ Findings':waiting?'🔄 Pending':pr.codex.state==='incomplete'?'❔ History incomplete':progress.currentCompleted?'✓ Reviewed · unverified':'❔ Unverified';
  summary.append(cell('PR',`#${pr.number} ${pr.title}`,'pr-title'),cell('Merge',pr.readiness.label,`readiness-${pr.readiness.state}`),cell('CI',pr.ci==='success'?'✅ Passed':pr.ci==='failure'?'❌ Failed':pr.ci,`ci-${pr.ci}`),cell('Codex',codexText,`codex-${pr.codex.state}`),cell('Reviews',progress.reviewCount===null?'?':`≥${progress.reviewCount}`),cell('Commits',String(progress.updatesAfterReview??'?')),cell('P1',progress.findings?`${progress.findings.incomplete?'≥':''}${progress.findings.p1}`:'?'),cell('P2',progress.findings?`${progress.findings.incomplete?'≥':''}${progress.findings.p2}`:'?'));
  summary.append(el('span','Details','expand-label'));
  node.append(summary);
  const detail=el('div','','pr-detail');
  if(pr.state==='open'&&!pr.detailError&&onMerge) detail.append(mergeBar(pr,{onMerge,onCodex,askedCodex}));
  const flow=el('ol','','review-flow');
  for(const event of progress.events||[]) {const step=el('li','',`flow-${event.kind}`);step.append(el('strong',event.label),el('span',`${new Date(event.at).toLocaleString()}${event.commit?' · '+event.commit.slice(0,10):''}`,'muted'));flow.append(step);}
  detail.append(el('h3','PR activity'),el('p','Observed GitHub history; code changes do not prove an agent fixed findings. Earlier events may be missing.','muted'),flow);
  for(const reason of pr.readiness.reasons) detail.append(el('p',reason,'muted'));
  detail.append(el('p',`${['running','findings','clear'].includes(pr.codex.state)||progress.currentCompleted?'✅':'❔'} Codex review acknowledged`));
  detail.append(el('p',`${waiting?'🔄':progress.currentCompleted?'✅':'⏳'} Latest code review ${waiting?'pending':progress.currentCompleted?'completed':'not verified'}`));
  detail.append(el('p',pr.codex.label,`codex-status codex-${pr.codex.state}`));
  detail.append(el('p',`Completed reviews: ${progress.reviewCount===null?'unknown':`at least ${progress.reviewCount}`} · Commits after review: ${progress.updatesAfterReview??'unknown'}`));
  detail.append(el('p',`Historical Codex findings: ${progress.findings?.p1??'?'} P1 · ${progress.findings?.p2??'?'} P2${progress.findings?.incomplete?' (incomplete history)':''} · Unresolved review threads: ${pr.unresolvedThreads??'unverified'}`));
  detail.append(el('p','Commits count commits after review; they do not confirm that findings were fixed.','muted'));
  detail.append(el('p',`Head: ${pr.headSha.slice(0,10)} · Opened: ${new Date(pr.openedAt).toLocaleString()}`));
  detail.append(el('p',pr.mergedAt?`Merged: ${new Date(pr.mergedAt).toLocaleString()}`:`Updated: ${new Date(pr.updatedAt).toLocaleString()}`));
  detail.append(el('p',`${pr.state}${pr.draft?' · draft':''}`));
  if(pr.detailError) detail.append(el('p',`Details unavailable: ${pr.detailError}`,'error'));
  detail.append(link('View PR and review history on GitHub',pr.url));
  node.append(detail);
  return node;
}

// Keeps the rows the viewer has expanded open across refreshes.
export function renderPulls(container,pulls,{onMerge,onCodex,askedCodex=()=>false}={}) {
  const expanded=new Set([...container.querySelectorAll('details[open]')].map(n=>n.dataset.number));
  container.replaceChildren();
  const headings=el('div','','pr-summary list-head');for(const title of ['PR','Merge','CI','Codex','#Reviews','#Commits','#P1','#P2']) headings.append(el('span',title));headings.setAttribute('aria-hidden','true');container.append(headings);
  for(const pr of pulls) container.append(renderPull(pr,{open:expanded.has(String(pr.number)),onMerge,onCodex,askedCodex:kind=>askedCodex(kind,pr)}));
  if(!pulls.length) container.append(el('p','No pull requests found.'));
}

export function renderWorkflows(container,workflows) {
  container.replaceChildren(...workflows.map(r=>{
    const node=el('div','','workflow-row');
    node.dataset.category=/deploy|pages/i.test(r.name)?'deployment':/(?:\bci\b|test|build|lint|continuous integration|check)/i.test(r.name)?'ci':'other';
    const title=el('span','','workflow-title');title.append(link(`${r.runNumber?'#'+r.runNumber+' ':''}${r.title||r.name}`,r.url));
    node.append(title,cell('Workflow',r.name),cell('Status',r.current?'Publishing this data':r.conclusion||r.status),cell('Branch',r.branch),cell('Updated',new Date(r.updatedAt).toLocaleString()));
    return node;
  }));
  const head=el('div','','workflow-row list-head');for(const title of ['Run','Workflow','Status','Branch','Updated']) head.append(el('span',title));head.setAttribute('aria-hidden','true');container.prepend(head);
  if(!workflows.length) container.append(el('p','No workflow runs found.'));
}

export function applyFilters({pullFilter,workflowFilter,pulls,workflows}) {
  const choice=pullFilter.value;
  for(const row of pulls.querySelectorAll('.pr-row')) row.hidden=!(choice==='all'||row.dataset.state===choice||choice==='attention'&&row.dataset.attention==='true');
  const workflow=workflowFilter.value;
  for(const row of workflows.querySelectorAll('.workflow-row:not(.list-head)')) row.hidden=workflow!=='all'&&row.dataset.category!==workflow;
}
