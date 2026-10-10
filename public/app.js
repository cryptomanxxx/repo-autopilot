import {createGitHub, repositoryName} from './github.js';
const $ = id => document.getElementById(id);
function el(tag, text, className) {const node = document.createElement(tag);node.textContent = text;if(className) node.className = className;return node;}
function link(text, url) {const node = el('a',text);if(typeof url === 'string' && url.startsWith('https://github.com/')) {node.href=url;node.target='_blank';node.rel='noopener noreferrer';}return node;}
function card(title, url, lines) {const node = el('article','');node.append(link(title,url));for(const line of lines) node.append(el('p',line));return node;}
const staticMode = document.documentElement.dataset.mode === 'static';
const github = createGitHub({pullLimit:5});
const snapshots = new Map();
$('mode-note').textContent = staticMode ? 'Public repositories only · No login or token required · GitHub anonymous API limits apply. Fetches 5 recent PRs to reduce API usage.' : 'Local server mode · Credentials stay on the server.';
const selected = new URLSearchParams(location.search).get('repo');
if(selected) $('repo').value = selected;
$('repository').addEventListener('submit',async event => {
  event.preventDefault();const button = event.target.querySelector('button');button.disabled=true;
  $('status').textContent='Fetching GitHub data…';$('dashboard').hidden=true;
  try {
    const repo = repositoryName($('repo').value);
    $('repo').value = repo;
    let data;
    if(staticMode) {
      const cached = snapshots.get(repo);
      if(cached && Date.now()-cached.at < 60000) data = cached.data;
      else {data = await github.snapshot(repo);if(snapshots.size >= 20) snapshots.delete(snapshots.keys().next().value);snapshots.set(repo,{at:Date.now(),data});}
    } else {
      const response = await fetch(`./api/dashboard?repo=${encodeURIComponent(repo)}`);
      data = await response.json();if(!response.ok) throw new Error(data.error || 'Unable to load dashboard.');
    }
    $('summary').replaceChildren(el('strong',data.repository),el('span',`Snapshot: ${new Date(data.fetchedAt).toLocaleString()}`),el('span',`${data.pulls.filter(p=>p.state==='open').length} open in recent PRs`));
    $('pulls').replaceChildren();
    for(const pr of data.pulls) {
      const node = card(`#${pr.number} ${pr.title}`,pr.url,[`${pr.state}${pr.draft ? ' · draft' : ''} · CI: ${pr.ci}`,`Head: ${pr.headSha.slice(0,10)} · Opened: ${new Date(pr.openedAt).toLocaleString()}`,pr.mergedAt ? `Merged: ${new Date(pr.mergedAt).toLocaleString()}` : `Updated: ${new Date(pr.updatedAt).toLocaleString()}`]);
      node.append(el('p',pr.codex.label,`codex-status codex-${pr.codex.state}`));
      if(pr.codex.commit) node.append(el('p',`Codex reviewed: ${pr.codex.commit}`));
      node.append(el('p',pr.reviews.length ? pr.reviews.map(r=>`${r.author}: ${r.state} (${r.commit?.slice(0,7) || 'no commit'})`).join(' · ') : 'No formal GitHub review submissions; see Codex status above.'));
      if(pr.detailError) node.append(el('p',`Details unavailable: ${pr.detailError}`,'error'));
      const details = el('details','');details.append(el('summary',`Codex feedback (${pr.codexComments.length})`));
      for(const c of pr.codexComments) {details.append(link('View on GitHub',c.url),el('pre',c.body || '(No comment text)'));}node.append(details);$('pulls').append(node);
    }
    if(!data.pulls.length) $('pulls').append(el('p','No pull requests found.'));
    $('workflows').replaceChildren(...data.workflows.map(r=>card(r.title || r.name,r.url,[`${r.name} · ${r.conclusion || r.status}`,`${r.branch} · ${r.sha.slice(0,10)} · ${new Date(r.updatedAt).toLocaleString()}`])));
    if(!data.workflows.length) $('workflows').append(el('p','No workflow runs found.'));
    $('scope').textContent=[data.scope,...data.warnings].join(' ');$('dashboard').hidden=false;
    $('status').textContent='Loaded. Submit again to refresh (snapshots cached for 60 seconds).';
  } catch(error) {$('status').textContent=error.message;} finally {button.disabled=false;}
});
