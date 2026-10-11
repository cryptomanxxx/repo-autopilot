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
export function ciState(checks, statuses) {
  const substantiveChecks=checks.filter(c=>c.name !== 'repo-autopilot-review-refresh-signal');
  const states = [...substantiveChecks.map(c => c.status === 'completed' ? c.conclusion : 'pending'), ...statuses.map(s => s.state)];
  if (!states.length) return 'unknown';
  if (states.some(s => ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(s))) return 'failure';
  if (states.some(s => !['success', 'neutral', 'skipped'].includes(s))) return 'pending';
  return 'success';
}
export function createGitHub({token, fetchImpl = fetch, pullLimit = 10, userAgent} = {}) {
  // Browsers send their own User-Agent; server runtimes such as Cloudflare Workers must set one for GitHub.
  const agent = userAgent ? {'User-Agent': userAgent} : {};
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, {headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...agent, ...(token ? {Authorization: `Bearer ${token}`} : {})}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw Object.assign(new Error(response.status === 403 || response.status === 429 ? 'GitHub access denied or rate limit reached. Check token permissions or try later.' : `GitHub request failed (${response.status}).`), {status: response.status});
    return response.json();
  }
  async function mergeVerification(repo, number) {
    if (!token) return {complete:false};
    const [owner,name]=repo.split('/');
    const query=`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid mergeStateStatus reviewDecision reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved}}}}}`;
    try {
      const response=await fetchImpl('https://api.github.com/graphql',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...agent},body:JSON.stringify({query,variables:{owner,name,number}}),signal:AbortSignal.timeout(15000)});
      if(!response.ok) return {complete:false};
      const data=await response.json();
      const pr=data.data?.repository?.pullRequest;
      if(data.errors?.length || !pr?.reviewThreads?.nodes || pr.reviewThreads.pageInfo?.hasNextPage !== false) return {complete:false};
      return {complete:true,headSha:pr.headRefOid,mergeStateStatus:pr.mergeStateStatus,reviewDecision:pr.reviewDecision,unresolvedThreads:pr.reviewThreads.nodes.filter(t=>!t.isResolved).length};
    } catch {return {complete:false};}
  }
  // Repository, recent pull requests (as listed) and workflow runs: three requests.
  async function overview(value) {
    const repo = repositoryName(value), root = `/repos/${repo}`;
    // Workflow runs are optional: without access to them the pull requests still load, with a warning.
    const [metadata, pulls, runs] = await Promise.all([get(root), get(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=${pullLimit}`), get(`${root}/actions/runs?per_page=15`).catch(error => ({error}))]);
    const warnings = runs.error ? [`GitHub Actions runs are unavailable: ${runs.error.message}`] : [];
    return {repo, repository:metadata.full_name, url:metadata.html_url, fetchedAt:new Date().toISOString(), autonomy:false, scope:`${pullLimit} most recently updated PRs; 15 recent workflow runs. Review lists are limited to 100 entries. CI is informational, not merge eligibility.`, warnings, pulls, workflows:(runs.workflow_runs || []).map(r => ({id:r.id, runNumber:r.run_number, name:r.name, title:r.display_title, status:r.status, conclusion:r.conclusion, branch:r.head_branch, sha:r.head_sha, url:r.html_url, updatedAt:r.updated_at}))};
  }
  // Reviews, comments, checks, Codex state and merge readiness of one listed pull request: at most nine
  // requests. An open pull request is fetched again afterwards: that catches pushes made while loading and
  // gives GitHub time to compute its mergeability.
  async function pullDetails(repo, listed) {
    const root = `/repos/${repo}`, warnings = [];
    let pr=listed;
    let verification={complete:false};
    let details = {ci: 'unknown', reviews: [], codexComments: [], detailError: null, codex: {state:'unknown',label:'Codex: details unavailable'}, progress:{reviewCount:null,updatesAfterReview:null,currentCompleted:false}, checksComplete:false};
    // Limit concurrency and API cost; detail errors are visible, never treated as approval.
    try {
      const [reviews, comments, inline, checks, status, reactions, commits] = await Promise.all([get(`${root}/pulls/${pr.number}/reviews?per_page=100`), get(`${root}/issues/${pr.number}/comments?per_page=100`), get(`${root}/pulls/${pr.number}/comments?per_page=100`), get(`${root}/commits/${pr.head.sha}/check-runs?per_page=100`), get(`${root}/commits/${pr.head.sha}/status?per_page=100`), get(`${root}/issues/${pr.number}/reactions?per_page=100`), get(`${root}/pulls/${pr.number}/commits?per_page=100`)]);
      const all = [...reviews, ...comments, ...inline];
      details = {ci: ciState(checks.check_runs, status.statuses), reviews: reviews.map(r => ({author:r.user?.login, state:r.state, commit:r.commit_id, url:r.html_url})), codexComments: all.filter(c => !(c.body || '').includes('<!-- codex-pull-request-review-summary -->')).filter(c => c.user?.login === 'chatgpt-codex-connector[bot]').map(c => ({body:c.body, url:c.html_url, createdAt:c.created_at || c.submitted_at})), detailError:null, codex:codexStatus(pr.head.sha,{reviews,comments,inline,reactions,truncated:[reviews,comments,inline,reactions].some(a=>a.length>=100)}), progress:reviewProgress(pr.head.sha,{reviews,comments,inline,commits,reactions,openedAt:pr.created_at,mergedAt:pr.merged_at,findingsTruncated:[comments,inline].some(a=>a.length>=100),truncated:[reviews,comments,commits].some(a=>a.length>=100)}), checksComplete:checks.check_runs.length<100 && status.statuses.length<100 && (checks.total_count ?? checks.check_runs.length)<=checks.check_runs.length};
      if ([reviews, comments, inline, reactions, commits, checks.check_runs, status.statuses].some(a => a.length >= 100)) warnings.push(`PR #${pr.number}: detail list may be truncated at 100 entries.`);
    } catch (error) {if (error.status === 401) throw error;details.detailError = error.message;}
    if(pr.state === 'open') {
      try {
        const current=await get(`${root}/pulls/${pr.number}`);
        if(current.head?.sha !== pr.head.sha) {details.checksComplete=false;details.codex={state:'unknown',label:'Codex: code changed during loading'};details.progress.currentCompleted=false;details.detailError='PR changed during loading; refresh for a consistent snapshot.';}
        pr=current;
        verification=await mergeVerification(repo,pr.number);
        if(verification.headSha !== pr.head.sha) verification={complete:false};
      } catch(error) {if(error.status === 401) throw error;details.detailError=error.message;}
    }
    // The listed state decides, so a pull request merged during loading is not verified twice.
    if(listed.state !== 'open') {verification=await mergeVerification(repo,pr.number);if(verification.headSha !== pr.head.sha) verification={complete:false};}
    details.unresolvedThreads=verification.complete ? verification.unresolvedThreads : null;
    const readiness=mergeReadiness(pr,{ci:details.ci,codex:details.codex,checksComplete:details.checksComplete,verification});
    return {warnings, item:{readiness,number:pr.number, title:pr.title, url:pr.html_url, state:pr.merged_at ? 'merged' : pr.state, draft:pr.draft, headSha:pr.head.sha, openedAt:pr.created_at, updatedAt:pr.updated_at, mergedAt:pr.merged_at, ...details}};
  }
  return {
    overview, pullDetails,
    pull:(value,number)=>get(`/repos/${repositoryName(value)}/pulls/${number}`),
    async snapshot(value) {
      const {repo, pulls, ...rest} = await overview(value);
      const warnings = [...rest.warnings], items = [];
      for (const listed of pulls) {const {item, warnings:found} = await pullDetails(repo, listed);items.push(item);warnings.push(...found);}
      return {repository:rest.repository, url:rest.url, fetchedAt:rest.fetchedAt, autonomy:false, scope:rest.scope, warnings, pulls:items, workflows:rest.workflows};
    }
  };
}
