const bot = 'chatgpt-codex-connector[bot]';
const shaOf = body => (body || '').match(/\*\*Reviewed commit:\*\*\s*`([a-f0-9]{7,40})`/i)?.[1];
const stamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;

// The finding's headline: Codex writes it in bold after the priority badge.
export function findingTitle(body='') {
  const bold=body.match(/\*\*(?:<sub><sub>)?!\[P[0-3] Badge\]\([^)]*\)(?:<\/sub><\/sub>)?\s*([^*]+?)\s*\*\*/i)?.[1];
  const text=bold || body.replace(/!\[[^\]]*\]\([^)]*\)|<[^>]+>|[*_`#]/g,'').trim().split('\n')[0];
  return text.trim().slice(0,200) || 'Codex finding';
}

// The finding's explanation, without its headline, badge, feedback prompt and markers: what Codex says is
// wrong and how to fix it. A longer one is cut at 2000 characters and ends with FINDING_TEXT_CUT.
export const FINDING_TEXT_CUT='\n[… cut here; the whole finding is on GitHub]';
export function findingText(body='') {
  const text=body.replace(/<!--[\s\S]*?-->/g,'')
    .replace(/^\s*\*\*(?:<sub><sub>)?!\[P[0-3] Badge\]\([^)]*\)(?:<\/sub><\/sub>)?[^*]*\*\*\s*/i,'')
    .replace(/^\s*Useful\? React with .*$/gim,'')
    .replace(/\n{3,}/g,'\n\n').trim();
  return text.length>2000?text.slice(0,2000)+FINDING_TEXT_CUT:text;
}

export function reviewProgress(head, {reviews = [], comments = [], inline = [], commits = [], reactions = [], openedAt, mergedAt, findingsTruncated = false, truncated = false} = {}) {
  const events=[];
  const add=(kind,label,at,commit,url)=>{if(stamp(at)) events.push({kind,label,at:new Date(at).toISOString(),commit,url});};
  add('opened','PR opened',openedAt);
  for(const c of comments) if(c.user?.login !== bot && /@codex\s+(?:security\s+)?review\b/i.test(c.body || '')) add('requested','Codex review requested',c.created_at,undefined,c.html_url);
  // A finding can also sit in a review's own body; it carries the review's time and commit.
  const reviewFindings=reviews.filter(r=>r.user?.login === bot && /(?:badge\/|\[)P[0-3](?:-|\])/i.test(r.body || '')).map(r=>({...r,id:`review:${r.id}`,created_at:r.submitted_at,commit_id:r.commit_id}));
  const findingComments=[...comments,...inline,...reviewFindings].filter(c=>c.user?.login === bot && !c.in_reply_to_id && !(c.body || '').includes('codex-pull-request-review-summary'));
  const seen=new Set();const findings={p1:0,p2:0,incomplete:findingsTruncated,items:[]};const batches=new Map();
  for(const c of findingComments) {
    const priority=(c.body || '').match(/(?:badge\/|\[)(P[0-3])(?:-|\])/i)?.[1]?.toLowerCase();
    if(!priority) continue;
    const identity=c.id ?? c.html_url;
    if(identity && seen.has(identity)) continue;
    if(identity) seen.add(identity);
    // Comments outside a review thread name their place only in a permalink to the code.
    const permalink=(c.body || '').match(/\/blob\/([0-9a-f]{7,40})\/([^#)\s]+)#L(\d+)/i);
    const commit=c.original_commit_id || c.commit_id || permalink?.[1];
    findings.items.push({id:c.id ?? null,priority:priority.toUpperCase(),title:findingTitle(c.body),text:findingText(c.body),path:c.path || permalink?.[2] || null,line:c.line ?? c.original_line ?? (permalink?Number(permalink[3]):null),url:c.html_url,at:c.created_at,commit:commit || null,current:Boolean(commit && head.startsWith(commit)),resolved:null});
    // The counts and the activity flow keep tracking P1 and P2; every priority is listed.
    if(!['p1','p2'].includes(priority)) continue;
    findings[priority]++;
    const key=c.pull_request_review_id ?? identity ?? c.created_at;
    const batch=batches.get(key) || {p1:0,p2:0,at:c.created_at,commit:c.original_commit_id || c.commit_id,url:c.html_url};
    batch[priority]++;batches.set(key,batch);
  }
  for(const b of batches.values()) add('findings',`Codex findings: ${b.p1} P1 · ${b.p2} P2`,b.at,b.commit,b.url);
  const completed = [];
  const summaries = [];
  for(const review of reviews.filter(r=>r.user?.login === bot && ['COMMENTED','APPROVED','CHANGES_REQUESTED'].includes(r.state))) {
    const commit=review.commit_id;
    if(commit) completed.push({commit,at:stamp(review.submitted_at),url:review.html_url});
  }
  for(const comment of comments.filter(c=>c.user?.login === bot)) {
    const commit=shaOf(comment.body);
    if(commit && /Codex Review:|automated review suggestions/i.test(comment.body || '')) completed.push({commit,at:stamp(comment.created_at),url:comment.html_url});
    if(!(comment.body || '').includes('<!-- codex-pull-request-review-summary -->')) continue;
    for(const row of comment.body.split('\n').filter(r=>r.includes('Code Review') && r.includes('|'))) {
      const commit=row.match(/`([a-f0-9]{7,40})`/i)?.[1];
      if(!commit) continue;
      const event={commit,at:stamp(row.match(/datetime="([^"]+)"/)?.[1]),url:comment.html_url};
      if(/Completed/.test(row)) summaries.push(event);
      else if(/Running/.test(row)) add('running','Codex review running',row.match(/datetime="([^"]+)"/)?.[1],commit,comment.html_url);
    }
  }
  // A submitted review and its outcome comment may describe the same run.
  const sameCommit = (a,b) => a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit);
  completed.sort((a,b)=>a.at-b.at);
  const rounds=[];
  for(const event of [...completed,...summaries]) {
    if(!rounds.some(r=>sameCommit(r,event) && Math.abs(r.at-event.at)<=10000)) rounds.push(event);
  }
  for(const r of rounds) if(r.at) add('reviewed','Codex review completed',r.at,r.commit,r.url);
  for(const c of commits) {
    const at=c.commit?.committer?.date;
    if(stamp(at)>stamp(openedAt)) add('changed','Code changed',at,c.sha,c.html_url);
  }
  const currentRounds=summaries.filter(r=>head.startsWith(r.commit));
  const lastCompleted=Math.max(0,...currentRounds.map(r=>r.at));
  if(!truncated && lastCompleted) for(const r of reactions.filter(r=>r.user?.login === bot && r.content === '+1' && stamp(r.created_at)>=lastCompleted)) add('clear','Codex 👍',r.created_at,head);
  add('merged','PR merged',mergedAt);
  events.sort((a,b)=>stamp(a.at)-stamp(b.at));
  const covered=commits.map((c,index)=>rounds.some(r=>c.sha.startsWith(r.commit)) ? index : -1).filter(i=>i>=0);
  const updates=covered.length ? commits.length-1-Math.min(...covered) : null;
  const currentCompleted=rounds.some(r=>head.startsWith(r.commit));
  // GitHub edits its summary in place; older clean rounds may leave no permanent event.
  return {events,findings,reviewCount:rounds.length,reviewCountIsLowerBound:true,updatesAfterReview:truncated ? null : updates,currentCompleted:!truncated && currentCompleted,truncated};
}

export function mergeReadiness(pr, {ci, codex, checksComplete = true, verification} = {}) {
  const result=(state,label,reasons=[])=>({state,label,reasons});
  if(pr.merged_at || pr.merged) return result('merged','Merged');
  if(pr.state === 'closed') return result('closed','Closed without merge');
  const reasons=[];
  if(pr.draft) reasons.push('PR is a draft');
  if(pr.mergeable === false || pr.mergeable_state === 'dirty') reasons.push('Merge conflict');
  if(ci === 'failure') reasons.push('CI failed');
  if(ci === 'pending') reasons.push('CI is running');
  if(codex?.state === 'findings') reasons.push('Codex findings need attention');
  if(['running','requested'].includes(codex?.state)) reasons.push('Waiting for Codex');
  if(verification?.unresolvedThreads > 0) reasons.push('Unresolved review conversations');
  if(verification?.reviewDecision === 'CHANGES_REQUESTED') reasons.push('A reviewer requested changes');
  if(verification?.reviewDecision === 'REVIEW_REQUIRED') reasons.push('Required approval is missing');
  if(['BLOCKED','BEHIND','UNSTABLE','DRAFT','DIRTY'].includes(verification?.mergeStateStatus)) reasons.push(`GitHub merge requirements: ${verification.mergeStateStatus.toLowerCase()}`);
  if(reasons.length) return result('not_ready','Not ready to merge',reasons);
  const missing=[];
  if(ci !== 'success' || !checksComplete) missing.push('Complete CI results are not verified');
  if(codex?.state !== 'clear') missing.push('No verified Codex clearance for current code');
  if(pr.mergeable !== true) missing.push('GitHub has not confirmed conflict-free merging');
  if(!verification?.complete) missing.push('Branch requirements and resolved conversations need authenticated GitHub verification');
  else if(verification.mergeStateStatus !== 'CLEAN') missing.push('GitHub merge eligibility is not confirmed');
  if(missing.length) return result('unknown','Cannot verify merge readiness',missing);
  return result('ready','Ready to merge',['Codex cleared current code; CI passed; GitHub reports CLEAN; all review conversations resolved']);
}
