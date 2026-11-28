// Build only canonical GitHub repository links from the selected option.
export function repositoryUrl(name) {
  if(typeof name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(name)) return null;
  const [owner,repo]=name.split('/');
  if(repo==='.'||repo==='..') return null;
  return 'https://github.com/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo);
}

export function updateRepositoryLink(link,name) {
  const url=repositoryUrl(name);
  if(!url) {
    link.hidden=true;
    link.removeAttribute('href');
    link.textContent='';
    return;
  }
  link.href=url;
  link.target='_blank';
  link.rel='noopener noreferrer';
  link.textContent=name+' ↗';
  link.hidden=false;
}
