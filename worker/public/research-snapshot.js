// Adapt only the already retrieved, authorized dashboard sample. No provider requests.
// This is an offline data contract, not an authorization or freshness gate.
import {aggregatePulls} from './research-analytics.js';

const isSha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/i.test(v);
const number=v=>Number.isSafeInteger(v)&&v>=0&&v<=1000000?v:null;
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
const validRepo=v=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(v)&&!['.','..'].includes(v.split('/')[1]);
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
const state=v=>['success','failure','pending','skipped','unknown'].includes(v)?v:'unknown';
const belongs=(p,repo)=>typeof p.url==='string'&&same(p.url,'https://github.com/'+repo+'/pull/'+p.number);
const blank=(repository,n)=>({repository,number:n,openedAt:null,mergedAt:null,merged:null,prCI:'unknown',prCIComplete:null,mainCI:'unknown',mainCIComplete:null,reviewRounds:null,p1:null,p2:null,commitsAfterReview:null,reviewComplete:null,findingsComplete:null,commitsComplete:null});

export function normalizeDashboardSample(overview,details,{repository}={}) {
  if(!validRepo(repository)||!overview||!same(overview.repository,repository)||
      !Array.isArray(overview.pulls)||overview.pulls.length>30||
      !Array.isArray(details)||details.length>31||!timestamp(overview.fetchedAt)) throw new RangeError('Invalid dashboard sample');
  // Canonical repository is the authenticated overview's identity.
  const repo=overview.repository;
  const listed=new Set();
  const byNumber=new Map();
  for(const p of details) {
    if(!p||!Number.isSafeInteger(p.number)||p.number<1) continue;
    if(byNumber.has(p.number)) byNumber.set(p.number,null);
    else byNumber.set(p.number,p);
  }
  let invalidListed=0,unavailable=0,stale=0,unbound=0,duplicateListed=0;
  const rows=[];
  for(const p of overview.pulls) {
    if(!p||!Number.isSafeInteger(p.number)||p.number<1||!belongs(p,repo)) {invalidListed++;continue;}
    if(listed.has(p.number)) {duplicateListed++;continue;}
    listed.add(p.number);
    const out=blank(repo,p.number);
    // The authenticated overview still establishes the listed merge state
    // when detail evidence is missing, stale or unbound. Retain the PR in
    // the Main CI denominator without trusting rejected detail fields.
    if(p.state==='merged') out.merged=true;
    else if(['open','closed'].includes(p.state)) out.merged=false;
    const detail=byNumber.get(p.number);
    // Fallback details may have openedAt synthesized from updatedAt.
    // The overview itself carries only a listed state, not event timestamps.
    if(!detail||detail.detailError) {
      unavailable++;
      rows.push(out);continue;
    }
    if(!belongs(detail,repo)||!isSha(detail.headSha)) {
      unbound++;rows.push(out);continue;
    }
    if(!timestamp(p.updatedAt)||p.updatedAt!==detail.updatedAt||p.state!==detail.state) {
      stale++;rows.push(out);continue;
    }
    if(detail.state==='merged') out.merged=true;
    else if(['open','closed'].includes(detail.state)) out.merged=false;
    out.openedAt=timestamp(detail.openedAt);
    out.mergedAt=out.merged===true?timestamp(detail.mergedAt):null;
    // Provider code reads checks using this PR head; it marks changed-head or
    // failed details unavailable. This is snapshot evidence, not merge clearance.
    out.prCI=state(detail.ci);
    out.prCIComplete=typeof detail.checksComplete==='boolean'?detail.checksComplete:null;
    const main=detail.postMergeCi;
    if(out.merged===true&&main?.available===true&&isSha(main.sha)) {
      out.mainCI=state(main.state);
      out.mainCIComplete=typeof main.complete==='boolean'?main.complete:null;
    }
    const progress=detail.progress;
    if(progress&&typeof progress==='object') {
      out.reviewRounds=number(progress.reviewCount);
      out.reviewComplete=false; // edited summaries can omit historical rounds
      out.p1=number(progress.findings?.p1);
      out.p2=number(progress.findings?.p2);
      out.findingsComplete=progress.findings?.incomplete===false?true:progress.findings?.incomplete===true?false:null;
      out.commitsAfterReview=progress.truncated===false?number(progress.updatesAfterReview):null;
      out.commitsComplete=progress.truncated===false?true:progress.truncated===true?false:null;
    }
    rows.push(out);
  }
  return {repository:repo,fetchedAt:overview.fetchedAt,rows,coverage:{listed:overview.pulls.length,
    usable:rows.length,invalidListed,duplicateListed,unavailable,stale,unbound,
    ignoredExtra:details.filter(p=>p&&!listed.has(p.number)).length,
    population:'recently_updated_sample',completeHistory:false}};
}

export function dashboardAnalytics(overview,details,{repository,start,end}={}) {
  const sample=normalizeDashboardSample(overview,details,{repository});
  return {...aggregatePulls(sample.rows,{repository:sample.repository,start,end,fetchedAt:sample.fetchedAt}),
    dashboardCoverage:sample.coverage};
}
