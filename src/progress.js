const bot = 'chatgpt-codex-connector[bot]';
const shaOf = body => (body || '').match(/\*\*Reviewed commit:\*\*\s*`([a-f0-9]{7,40})`/i)?.[1];
const stamp = value => typeof value === 'number' ? value : Date.parse(value) || 0;

export function reviewProgress(head, {reviews = [], comments = [], commits = [], reactions = [], openedAt, mergedAt, truncated = false} = {}) {
  const events=[];
  const add=(kind,label,at,commit,url)=>{if(stamp(at)) events.push({kind,label,at:new Date(at).toISOString(),commit,url});};
  add('opened','PR opened',openedAt);
  for(const c of comments) if(c.user?.login !== bot && /@codex\s+(?:security\s+)?review\b/i.test(c.body || '')) add('requested','Codex review requested',c.created_at,undefined,c.html_url);
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
  return {events,reviewCount:rounds.length,reviewCountIsLowerBound:true,updatesAfterReview:truncated ? null : updates,currentCompleted:!truncated && currentCompleted,truncated};
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
