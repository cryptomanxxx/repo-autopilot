export function taskUrl(repository,text) {
  const url=new URL(`https://github.com/${repository}/issues/new`);
  url.searchParams.set('title',`Autopilot task: ${text.replace(/\s+/g,' ').slice(0,70)}`);
  url.searchParams.set('body',`<!-- repo-autopilot-task -->\n${text.trim()}`);
  if(url.href.length>7000) throw new Error('Please shorten the task so it fits in the GitHub confirmation link.');
  return url.href;
}
export function renderTasks(container,tasks=[]) {
  const expanded=new Set([...container.querySelectorAll('details[open]')].map(row=>row.dataset.number));
  container.replaceChildren();
  if(!tasks.length) {container.textContent='Your latest tasks and agent replies will appear here after GitHub confirms the task.';return;}
  for(const task of tasks) {
    const row=document.createElement('details');row.className='task-row';row.dataset.number=String(task.number);row.open=expanded.has(String(task.number));
    const heading=document.createElement('summary');heading.textContent=`#${task.number} ${task.title} · ${task.status}`;row.append(heading);
    for(const message of task.messages || []) {
      const p=document.createElement('p');p.className='task-message';
      const label=document.createElement('strong');label.textContent=message.role==='you' ? 'You: ' : 'Agent: ';p.append(label,document.createTextNode(message.text));row.append(p);
    }
    for(const [text,url] of [['Open task / close to stop',task.url],['Review changes and create PR',task.compareUrl]]) {
      if(!url || !url.startsWith('https://github.com/')) continue;
      const a=document.createElement('a');a.textContent=text;a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.className='task-link';row.append(a);
    }
    container.append(row);
  }
}
