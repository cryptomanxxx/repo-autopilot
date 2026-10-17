import {codexStatus} from './codex.js';
import {reviewProgress, mergeReadiness} from './progress.js';
export function repositoryName(value) {
  const message = 'Enter owner/repository or a GitHub repository URL (https://github.com/owner/repository).';
  if (typeof value !== 'string') throw new Error(message);
  let name = value.trim();
  // Match the original path, before URL parsing could normalize dot segments.
  if (/^https:\/\//i.test(name)) {
    const match = name.match(/^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/i);
    if (!match) throw new Error(message);
    name = `${match[1]}/${match[2].replace(/\.git$/, '')}`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(name) || ['.', '..'].includes(name.split('/')[1])) throw new Error(message);
  return name;
}
const FAILED_CHECKS = ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'];
export function ciState(checks, statuses) {
  const substantiveChecks=checks.filter(c=>c.name !== 'repo-autopilot-review-refresh-signal');
  const states = [...substantiveChecks.map(c => c.status === 'completed' ? c.conclusion : 'pending'), ...statuses.map(s => s.state)];
  if (!states.length) return 'unknown';
  if (states.some(s => ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(s))) return 'failure';
  if (states.some(s => !['success', 'neutral', 'skipped'].includes(s))) return 'pending';
  return 'success';
}
export function createGitHub({token, fetchImpl = fetch, pullLimit = 10, runLimit = 15, userAgent} = {}) {
  // Browsers send their own User-Agent; server runtimes such as Cloudflare Workers must set one for GitHub.
  const agent = userAgent ? {'User-Agent': userAgent} : {};
  async function get(path) {
    let response;
    // A request that never got an answer (a timeout or a network failure) is reported like a GitHub server
    // error, with a status, so callers handle it as GitHub's failure rather than as an internal one.
    try {response = await fetchImpl(`https://api.github.com${path}`, {headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...agent, ...(token ? {Authorization: `Bearer ${token}`} : {})}, signal: AbortSignal.timeout(15000)});}
    catch (error) {throw Object.assign(new Error(error?.name === 'TimeoutError' ? 'GitHub did not answer in time. Try again.' : 'GitHub could not be reached. Try again.'), {status: 502});}
    if (!response.ok) throw Object.assign(new Error(response.status === 403 || response.status === 429 ? 'GitHub access denied or rate limit reached. Check token permissions or try later.' : `GitHub request failed (${response.status}).`), {status: response.status});
    return response.json();
  }
  async function mergeVerification(repo, number) {
    if (!token) return {complete:false};
    const [owner,name]=repo.split('/');
    const query=`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid mergeStateStatus reviewDecision reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved isOutdated comments(first:1){nodes{fullDatabaseId}}}}}}}`;
    try {
      const response=await fetchImpl('https://api.github.com/graphql',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...agent},body:JSON.stringify({query,variables:{owner,name,number}}),signal:AbortSignal.timeout(15000)});
      if(!response.ok) return {complete:false};
      const data=await response.json();
      const pr=data.data?.repository?.pullRequest;
      if(data.errors?.length || !pr?.reviewThreads?.nodes || pr.reviewThreads.pageInfo?.hasNextPage !== false) return {complete:false};
      // Each thread's first comment identifies it, so a Codex finding can show whether it was resolved and
      // whether the code it points at has changed since (GitHub then marks the thread outdated).
      // fullDatabaseId holds the 64-bit REST id as a string; ids are compared as strings.
      const threadsById=new Map(pr.reviewThreads.nodes.filter(t=>t.comments?.nodes?.[0]?.fullDatabaseId!=null).map(t=>[String(t.comments.nodes[0].fullDatabaseId),{resolved:t.isResolved,outdated:t.isOutdated}]));
      return {complete:true,headSha:pr.headRefOid,mergeStateStatus:pr.mergeStateStatus,reviewDecision:pr.reviewDecision,unresolvedThreads:pr.reviewThreads.nodes.filter(t=>!t.isResolved).length,threadsById};
    } catch {return {complete:false};}
  }
  // Repository, recent pull requests (as listed) and workflow runs: three requests.
  async function overview(value) {
    const repo = repositoryName(value), root = `/repos/${repo}`;
    // Workflow runs are optional: without access to them the pull requests still load, with a warning.
    const [metadata, pulls, runs] = await Promise.all([get(root), get(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=${pullLimit}`), get(`${root}/actions/runs?per_page=${runLimit}`).catch(error => ({error}))]);
    const warnings = runs.error ? [`GitHub Actions runs are unavailable: ${runs.error.message}`] : [];
    return {repo, repository:metadata.full_name, url:metadata.html_url, fetchedAt:new Date().toISOString(), autonomy:false, scope:`${pullLimit} most recently updated PRs; ${runLimit} recent workflow runs. Review lists are limited to 100 entries. CI is informational, not merge eligibility.`, warnings, pulls, workflows:(runs.workflow_runs || []).map(r => ({id:r.id, runNumber:r.run_number, name:r.name, title:r.display_title, status:r.status, conclusion:r.conclusion, branch:r.head_branch, sha:r.head_sha, url:r.html_url, updatedAt:r.updated_at}))};
  }
  // Reviews, comments, checks, Codex state and merge readiness of one listed pull request: at most nine
  // requests. An open pull request is fetched again afterwards: that catches pushes made while loading and
  // gives GitHub time to compute its mergeability.
  async function pullDetails(repo, listed) {
    const root = `/repos/${repo}`, warnings = [];
    let pr=listed;
    let verification={complete:false}, changed=false;
    let details = {ci: 'unknown', reviews: [], codexComments: [], detailError: null, codex: {state:'unknown',label:'Codex: details unavailable'}, progress:{reviewCount:null,updatesAfterReview:null,currentCompleted:false}, checksComplete:false};
    // Limit concurrency and API cost; detail errors are visible, never treated as approval.
    try {
      const [reviews, comments, inline, checks, status, reactions, commits] = await Promise.all([get(`${root}/pulls/${pr.number}/reviews?per_page=100`), get(`${root}/issues/${pr.number}/comments?per_page=100`), get(`${root}/pulls/${pr.number}/comments?per_page=100`), get(`${root}/commits/${pr.head.sha}/check-runs?per_page=100`), get(`${root}/commits/${pr.head.sha}/status?per_page=100`), get(`${root}/issues/${pr.number}/reactions?per_page=100`), get(`${root}/pulls/${pr.number}/commits?per_page=100`)]);
      const all = [...reviews, ...comments, ...inline];
      details = {ci: ciState(checks.check_runs, status.statuses), reviews: reviews.map(r => ({author:r.user?.login, state:r.state, commit:r.commit_id, url:r.html_url})), codexComments: all.filter(c => !(c.body || '').includes('<!-- codex-pull-request-review-summary -->')).filter(c => c.user?.login === 'chatgpt-codex-connector[bot]').map(c => ({body:c.body, url:c.html_url, createdAt:c.created_at || c.submitted_at})), detailError:null, codex:codexStatus(pr.head.sha,{reviews,comments,inline,reactions,headAt:commits.find(c=>c.sha===pr.head.sha)?.commit?.committer?.date,truncated:[reviews,comments,inline,reactions].some(a=>a.length>=100)||commits.length>=100&&!commits.some(c=>c.sha===pr.head.sha)}), progress:reviewProgress(pr.head.sha,{reviews,comments,inline,commits,reactions,openedAt:pr.created_at,mergedAt:pr.merged_at,findingsTruncated:[comments,inline,reviews].some(a=>a.length>=100),truncated:[reviews,comments,commits].some(a=>a.length>=100)}), checksComplete:checks.check_runs.length<100 && status.statuses.length<100 && (checks.total_count ?? checks.check_runs.length)<=checks.check_runs.length};
      if ([reviews, comments, inline, reactions, commits, checks.check_runs, status.statuses].some(a => a.length >= 100)) warnings.push(`PR #${pr.number}: detail list may be truncated at 100 entries.`);
    } catch (error) {if (error.status === 401) throw error;details.detailError = error.message;}
    if(pr.state === 'open') {
      try {
        const current=await get(`${root}/pulls/${pr.number}`);
        if(current.head?.sha !== pr.head.sha) {changed=true;details.checksComplete=false;details.codex={state:'unknown',label:'Codex: code changed during loading'};details.progress.currentCompleted=false;for(const item of details.progress.findings?.items||[]) item.current=Boolean(item.commit&&current.head?.sha?.startsWith(item.commit));details.detailError='PR changed during loading; refresh for a consistent snapshot.';}
        pr=current;
        verification=await mergeVerification(repo,pr.number);
        if(verification.headSha !== pr.head.sha) verification={complete:false};
      } catch(error) {if(error.status === 401) throw error;details.detailError=error.message;}
    }
    // The listed state decides, so a pull request merged during loading is not verified twice.
    if(listed.state !== 'open') {verification=await mergeVerification(repo,pr.number);if(verification.headSha !== pr.head.sha) verification={complete:false};}
    details.unresolvedThreads=verification.complete ? verification.unresolvedThreads : null;
    for(const item of details.progress.findings?.items||[]) {
      const thread=verification.complete?verification.threadsById.get(String(item.id)):undefined;
      item.resolved=thread?thread.resolved:null;item.outdated=thread?thread.outdated===true:null;
    }
    const readiness=mergeReadiness(pr,{ci:details.ci,codex:details.codex,checksComplete:details.checksComplete,verification});
    return {warnings, changed, item:{readiness,number:pr.number, title:pr.title, url:pr.html_url, state:pr.merged_at ? 'merged' : pr.state, draft:pr.draft, headSha:pr.head.sha, baseRef:pr.base?.ref, openedAt:pr.created_at, updatedAt:pr.updated_at, mergedAt:pr.merged_at, ...details}};
  }
  // The end of a GitHub Actions job's log. GitHub answers with a redirect to a signed download address,
  // which is read without the token and, where the store allows it, only from its last bytes.
  async function jobLog(repo, id) {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/jobs/${id}/logs`, {redirect: 'manual', headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...agent, ...(token ? {Authorization: `Bearer ${token}`} : {})}, signal: AbortSignal.timeout(15000)});
    const location = response.headers.get('Location');
    if (!location || !/^https:\/\//.test(location)) return null;
    // Blob storage takes only start-end ranges: the first byte gives the length, then the last 16 KiB are
    // read. A store that ignores ranges sends the whole log, which is read only when it is not too large.
    const part = range => fetchImpl(location, {headers: {Range: range, ...agent}, signal: AbortSignal.timeout(15000)});
    let log = await part('bytes=0-0');
    if (log.status === 206) {
      const total = Number(/\/(\d+)$/.exec(log.headers.get('Content-Range') || '')?.[1]);
      await log.body?.cancel();
      if (!Number.isFinite(total)) return null;
      log = total > 1 ? await part(`bytes=${Math.max(0, total - 16384)}-${total - 1}`) : log;
    }
    if (!log.ok || log.status === 200 && Number(log.headers.get('Content-Length') || Infinity) > 5000000) return null;
    const text = (await log.text()).slice(-16384);
    const lines = text.split(/\r?\n/).map(line => line.replace(/\u001b\[[0-9;]*m/g, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '')).filter(line => line.trim());
    return lines.slice(-40).join('\n').slice(-4000);
  }
  // The checks and statuses on a commit, and for the checks that failed what they say: GitHub's summary,
  // their annotations and, for GitHub Actions jobs, the end of the log. At most four failures are opened.
  async function checks(value, ref) {
    const repo = repositoryName(value), root = `/repos/${repo}`;
    const cut = (text, max) => typeof text === 'string' && text ? text.slice(0, max) : null;
    const [runs, combined] = await Promise.all([get(`${root}/commits/${ref}/check-runs?per_page=100`), get(`${root}/commits/${ref}/status?per_page=100`)]);
    const list = (runs.check_runs || []).filter(c => c.name !== 'repo-autopilot-review-refresh-signal').map(c => ({id:c.id, name:c.name, app:c.app?.slug || null, status:c.status, conclusion:c.conclusion || null, url:c.html_url || c.details_url || null, title:cut(c.output?.title, 200), summary:cut(c.output?.summary, 1500), annotationCount:Number.isInteger(c.output?.annotations_count) ? c.output.annotations_count : null}));
    const failed = list.filter(c => c.status === 'completed' && FAILED_CHECKS.includes(c.conclusion)).slice(0, 4);
    await Promise.all(failed.map(async c => {
      c.annotations = (await get(`${root}/check-runs/${c.id}/annotations?per_page=20`).catch(() => [])).map(a => ({path:a.path || null, line:a.start_line ?? null, level:a.annotation_level || null, message:cut(a.message, 500)}));
      c.log = c.app === 'github-actions' ? await jobLog(repo, c.id).catch(() => null) : null;
    }));
    const statuses = (combined.statuses || []).map(s => ({context:s.context, state:s.state, description:cut(s.description, 300), url:s.target_url || null}));
    return {checks:list, statuses, complete:(runs.check_runs || []).length < 100 && (runs.total_count ?? 0) <= (runs.check_runs || []).length && statuses.length < 100, opened:failed.length};
  }
  // The open pull requests of a repository, most recently updated first; more may exist beyond the limit.
  async function openPulls(value, limit = 30) {
    const repo = repositoryName(value);
    const pulls = await get(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`);
    return {pulls:pulls.map(p => ({number:p.number, title:p.title, url:p.html_url, draft:Boolean(p.draft), updatedAt:p.updated_at})), mayHaveMore:pulls.length >= limit};
  }
  return {
    overview, pullDetails, checks, openPulls,
    pull:(value,number)=>get(`/repos/${repositoryName(value)}/pulls/${number}`),
    async snapshot(value) {
      const {repo, pulls, ...rest} = await overview(value);
      const warnings = [...rest.warnings], items = [];
      for (const listed of pulls) {const {item, warnings:found} = await pullDetails(repo, listed);items.push(item);warnings.push(...found);}
      return {repository:rest.repository, url:rest.url, fetchedAt:rest.fetchedAt, autonomy:false, scope:rest.scope, warnings, pulls:items, workflows:rest.workflows};
    }
  };
}
