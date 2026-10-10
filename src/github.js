export function repositoryName(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/')[1] === '..') throw new Error('Enter a repository as owner/name.');
  return value;
}
export function ciState(checks, statuses) {
  const states = [...checks.map(c => c.status === 'completed' ? c.conclusion : 'pending'), ...statuses.map(s => s.state)];
  if (!states.length) return 'unknown';
  if (states.some(s => ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(s))) return 'failure';
  if (states.some(s => !['success', 'neutral', 'skipped'].includes(s))) return 'pending';
  return 'success';
}
export function createGitHub({token, fetchImpl = fetch, pullLimit = 10} = {}) {
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, {headers: {Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? {Authorization: `Bearer ${token}`} : {})}, signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub access denied or rate limit reached. Check token permissions or try later.' : `GitHub request failed (${response.status}).`);
    return response.json();
  }
  return {async snapshot(value) {
    const repo = repositoryName(value), root = `/repos/${repo}`;
    const [metadata, pulls, runs] = await Promise.all([get(root), get(`${root}/pulls?state=all&sort=updated&direction=desc&per_page=${pullLimit}`), get(`${root}/actions/runs?per_page=15`)]);
    const warnings = [];
    const items = [];
    // Limit concurrency and API cost; detail errors are visible, never treated as approval.
    for (const pr of pulls) {
      let details = {ci: 'unknown', reviews: [], codexComments: [], detailError: null};
      try {
        const [reviews, comments, inline, checks, status] = await Promise.all([get(`${root}/pulls/${pr.number}/reviews?per_page=100`), get(`${root}/issues/${pr.number}/comments?per_page=100`), get(`${root}/pulls/${pr.number}/comments?per_page=100`), get(`${root}/commits/${pr.head.sha}/check-runs?per_page=100`), get(`${root}/commits/${pr.head.sha}/status?per_page=100`)]);
        const all = [...reviews, ...comments, ...inline];
        details = {ci: ciState(checks.check_runs, status.statuses), reviews: reviews.map(r => ({author:r.user?.login, state:r.state, commit:r.commit_id, url:r.html_url})), codexComments: all.filter(c => c.user?.login === 'chatgpt-codex-connector[bot]').map(c => ({body:c.body, url:c.html_url, createdAt:c.created_at || c.submitted_at})), detailError:null};
        if ([reviews, comments, inline, checks.check_runs, status.statuses].some(a => a.length >= 100)) warnings.push(`PR #${pr.number}: detail list may be truncated at 100 entries.`);
      } catch (error) {details.detailError = error.message;}
      items.push({number:pr.number, title:pr.title, url:pr.html_url, state:pr.merged_at ? 'merged' : pr.state, draft:pr.draft, headSha:pr.head.sha, openedAt:pr.created_at, updatedAt:pr.updated_at, mergedAt:pr.merged_at, ...details});
    }
    return {repository:metadata.full_name, url:metadata.html_url, fetchedAt:new Date().toISOString(), autonomy:false, scope:`${pullLimit} most recently updated PRs; 15 recent workflow runs. Review lists are limited to 100 entries. CI is informational, not merge eligibility.`, warnings, pulls:items, workflows:runs.workflow_runs.map(r => ({id:r.id, name:r.name, title:r.display_title, status:r.status, conclusion:r.conclusion, branch:r.head_branch, sha:r.head_sha, url:r.html_url, updatedAt:r.updated_at}))};
  }};
}
