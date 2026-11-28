import {dashboardAnalytics} from './research-snapshot.js';

const DAY=86400000;
export function completedWindow(fetchedAt,days) {
  const stamp=Date.parse(fetchedAt);
  if(!Number.isFinite(stamp)||![7,30,90].includes(days)) throw new RangeError('Invalid analytics period');
  const end=Math.floor(stamp/DAY)*DAY;
  return {start:new Date(end-days*DAY).toISOString(),end:new Date(end).toISOString()};
}
export function researchModel(snapshot,repository,days,now) {
  if(!snapshot||typeof repository!=='string'||snapshot.repository.toLowerCase()!==repository.toLowerCase()) return null;
  const interval=completedWindow(snapshot.overview.fetchedAt,days);
  const stats=dashboardAnalytics(snapshot.overview,snapshot.details,{repository,...interval});
  const age=now-Date.parse(stats.fetchedAt);
  return {stats,stale:snapshot.failed===true||snapshot.invalidated===true||!Number.isFinite(age)||age<0||age>=180000};
}
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const duration=ms=>ms===null?'Unknown':(ms/60000).toFixed(1)+' min';
const metricText=m=>m.known===0?'Unknown':(m.lowerBound?'≥ ':'')+m.observedTotal+' (known '+m.known+', unknown '+m.unknown+')';
function tile(label,value) {const n=el('div',undefined,'research-tile');n.append(el('span',label,'muted small'),el('strong',String(value)));return n;}
function table(headers,rows) {
  const t=el('table',undefined,'research-table'),head=el('thead'),hr=el('tr'),body=el('tbody');
  for(const name of headers){const th=el('th',name);th.scope='col';hr.append(th);}
  head.append(hr);
  for(const values of rows){const row=el('tr');for(const v of values)row.append(el('td',String(v)));body.append(row);}
  t.append(head,body);return t;
}
function plot(days) {
  const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
  const width=720,height=160,step=width/days.length,max=Math.max(1,...days.flatMap(d=>[d.opened,d.merged]));
  svg.setAttribute('viewBox','0 0 720 160');svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Observed opened and merged PRs per completed UTC day; exact counts in table below');
  for(const [i,d] of days.entries()) for(const [j,key] of ['opened','merged'].entries()){
    const bar=document.createElementNS(ns,'rect'),h=d[key]/max*(height-8);
    bar.setAttribute('x',String(i*step+j*step*.45));bar.setAttribute('y',String(height-h));
    bar.setAttribute('width',String(step*.42));bar.setAttribute('height',String(h));
    bar.setAttribute('class','research-'+key);
    const title=document.createElementNS(ns,'title');title.textContent=d.date+' '+key+': '+d[key];bar.append(title);svg.append(bar);
  }
  return svg;
}
export function renderResearch({snapshot,repository,days,now,container,status,loading=false}) {
  container.replaceChildren();
  let model;
  try {model=researchModel(snapshot,repository,days,now);} catch {status.textContent='Analytics unavailable: invalid dashboard sample.';return;}
  if(!model){status.textContent=loading?'Loading dashboard sample…':'No dashboard sample for this repository. Load dashboard data to begin.';return;}
  const {stats:s,stale}=model,c=s.dashboardCoverage;
  status.textContent=(loading?'Refreshing. ':stale?'Earlier snapshot — refresh recommended. ':'')+
    s.repository+' · overview fetched '+s.fetchedAt+' · '+s.population+' PRs in retrieved sample (not full history).';
  const cards=el('div',undefined,'research-grid');
  for(const [label,value] of [['Observed opened',s.openedInWindow],['Observed merged',s.mergedInWindow],['Median time to merge',duration(s.duration.medianMs)],['Mean time to merge',duration(s.duration.meanMs)],['Duration sample',s.duration.n],['Autonomous PRs','Unknown']])cards.append(tile(label,value));
  container.append(cards,el('h3','Observed PR events — completed UTC days'),
    el('p',s.start.slice(0,10)+' to '+s.end.slice(0,10)+' (end exclusive). Today is excluded. Zero means no observed events, not no activity.','muted small'),
    el('p','Blue: opened · Green: merged','small'),plot(s.days));
  const exact=el('details');exact.append(el('summary','Daily counts (table)'),table(['UTC day','Opened','Merged'],s.days.map(d=>[d.date,d.opened,d.merged])));container.append(exact);
  container.append(el('h3','CI — retrieved sample, not historical CI runs'),table(['Outcome','PR CI (n='+s.prCI.denominator+')','Main CI (n='+s.mainCI.denominator+')'],Object.keys(s.prCI.counts).map(k=>[k,s.prCI.counts[k],s.mainCI.counts[k]])),
    el('p','Main CI includes listed merged PRs only. CI classification inherits dashboard semantics; unknown and incomplete are not successes.','muted small'),
    el('h3','Codex and review history — retrieved sample'),
    table(['Metric','Observed count and coverage'],[['Review rounds (lower bound)',metricText(s.reviewRounds)],['P1 findings',metricText(s.p1)],['P2 findings',metricText(s.p2)],['Commits after review (not confirmed fixes)',metricText(s.commitsAfterReview)]]),
    el('h3','Data coverage'),
    el('p','Listed: '+c.listed+' · unavailable: '+c.unavailable+' · inconsistent: '+c.stale+' · unbound: '+c.unbound+' · invalid: '+c.invalidListed+' · duplicate: '+c.duplicateListed+' · extra ignored: '+c.ignoredExtra,'small'),
    el('p','Opening timestamps unknown: '+s.openedUnknown+' · merge timestamps unknown: '+s.mergedUnknown+' · duration missing among observed merges: '+s.invalidDuration,'small'),
    el('p','Human interventions, actual quota, agent runtime, costs and scientific acceptance: unknown.','muted small'));
}
