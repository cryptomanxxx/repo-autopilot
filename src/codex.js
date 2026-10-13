const bot = 'chatgpt-codex-connector[bot]';
const isBot = item => item.user?.login === bot;
const matchesHead = (sha, head) => typeof sha === 'string' && /^[a-f0-9]{7,40}$/i.test(sha) && head.toLowerCase().startsWith(sha.toLowerCase());
const time = value => Date.parse(value) || 0;

// Reactions belong to a PR, not a commit. Require separate current-head evidence.
export function codexStatus(head, {reviews = [], comments = [], inline = [], reactions = [], truncated = false, headAt = null} = {}) {
  const result = (state, label, evidence = {}) => ({state, label, ...evidence});
  if (truncated) return result('unknown', 'Codex: incomplete history');
  const events = [];
  for (const r of reviews.filter(isBot)) {
    if (matchesHead(r.commit_id,head) && ['CHANGES_REQUESTED','COMMENTED'].includes(r.state) && /automated review suggestions|CHANGES_REQUESTED/i.test(`${r.body} ${r.state}`)) events.push({state:'findings',label:'Codex: findings',at:time(r.submitted_at),commit:r.commit_id,url:r.html_url});
  }
  for (const c of inline.filter(isBot)) {
    if(matchesHead(c.original_commit_id || c.commit_id,head)) events.push({state:'findings',label:'Codex: findings',at:time(c.created_at),commit:c.original_commit_id || c.commit_id,url:c.html_url});
  }
  for (const c of comments.filter(isBot)) {
    const body = c.body || '';
    const reviewed = body.match(/\*\*Reviewed commit:\*\*\s*`([a-f0-9]{7,40})`/i)?.[1];
    if(matchesHead(reviewed,head) && /Codex Review:\s*Didn't find any major issues/i.test(body)) events.push({state:'clear',label:'Codex: no findings reported',at:time(c.created_at),commit:reviewed,url:c.html_url});
    if(!body.includes('<!-- codex-pull-request-review-summary -->')) continue;
    for(const row of body.split('\n').filter(line=>line.includes('Code Review') && line.includes('|'))) {
      const sha=row.match(/`([a-f0-9]{7,40})`/i)?.[1];
      if(!matchesHead(sha,head)) continue;
      const at=time(row.match(/datetime="([^"]+)"/)?.[1]);
      if(/in progress|running|queued/i.test(row)) events.push({state:'running',label:'Codex: reviewing',at:Math.max(at,time(c.updated_at)),commit:sha,url:c.html_url});
      if(/Completed/.test(row) && at) {
        const thumbs=reactions.filter(r=>isBot(r) && r.content === '+1' && time(r.created_at)>=at).sort((a,b)=>time(b.created_at)-time(a.created_at))[0];
        if(thumbs) events.push({state:'clear',label:'Codex: 👍 no findings reported',at:time(thumbs.created_at),commit:sha,url:c.html_url});
      }
    }
  }
  events.sort((a,b)=>b.at-a.at || (a.state === 'findings' ? -1 : 1));
  const latest=events[0];
  // Review requests are PR-wide comments; one made before the current head was committed asked about
  // earlier code, so it does not count as a request for this commit.
  const since=time(headAt);
  const request=comments.filter(c=>!isBot(c) && /@codex\s+(?:security\s+)?review\b/i.test(c.body || '') && time(c.created_at)>=since).reduce((at,c)=>Math.max(at,time(c.created_at)),0);
  if(latest && request>latest.at) return result('requested','Codex: review requested (commit unverified)');
  if(latest) {const {at,...event}=latest;return event;}
  if(request) return result('requested','Codex: review requested (commit unverified)');
  if(reactions.some(r=>isBot(r) && ['+1','eyes'].includes(r.content)) || [...reviews,...comments,...inline].some(isBot)) return result('unverified','Codex: activity found; current commit unverified');
  return result('unknown','Codex: no review evidence found');
}
