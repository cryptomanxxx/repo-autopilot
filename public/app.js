const $ = id => document.getElementById(id);
function el(tag, text, className) {const node = document.createElement(tag);node.textContent = text;if(className) node.className = className;return node;}
function link(text, url) {const node = el('a',text);if(typeof url === 'string' && url.startsWith('https://github.com/')) {node.href=url;node.target='_blank';node.rel='noopener noreferrer';}return node;}
function card(title, url, lines) {const node = el('article','');node.append(link(title,url));for(const line of lines) node.append(el('p',line));return node;}
$('repository').addEventListener('submit',async event => {
  event.preventDefault();const button = event.target.querySelector('button');button.disabled=true;
  $('status').textContent='Fetching GitHub data…';$('dashboard').hidden=true;
  try {
    const response = await fetch(`/api/dashboard?repo=${encodeURIComponent($('repo').value.trim())}`);
    const data = await response.json();if(!response.ok) throw new Error(data.error || 'Unable to load dashboard.');
    $('summary').replaceChildren(el('strong',data.repository),el('span',`Snapshot: ${new Date(data.fetchedAt).toLocaleString()}`),el('span',`${data.pulls.filter(p=>p.state==='open').length} open in recent PRs`));
    $('pulls').replaceChildren();
    for(const pr of data.pulls) {
      const node = card(`#${pr.number} ${pr.title}`,pr.url,[`${pr.state}${pr.draft ? ' · draft' : ''} · CI: ${pr.ci}`,`Head: ${pr.headSha.slice(0,10)} · Opened: ${new Date(pr.openedAt).toLocaleString()}`,pr.mergedAt ? `Merged: ${new Date(pr.mergedAt).toLocaleString()}` : `Updated: ${new Date(pr.updatedAt).toLocaleString()}`]);
      node.append(el('p',pr.reviews.length ? pr.reviews.map(r=>`${r.author}: ${r.state} (${r.commit?.slice(0,7) || 'no commit'})`).join(' · ') : 'No review submissions in fetched history.'));
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
