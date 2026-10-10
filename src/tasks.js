import {TASK_PREFIX,TASK_MARKER,AGENT_MARKER,REPLY_MARKER,pendingTaskReply,readTaskComments} from './agent.js';
export async function collectTasks(repository,{token,authorizedUser,fetchImpl=fetch}) {
  const owner=(authorizedUser || repository.split('/')[0]).toLowerCase();
  const get=async path=>{
    const r=await fetchImpl(`https://api.github.com/repos/${repository}/${path}`,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
    if(!r.ok) throw new Error('Task history unavailable.');return r.json();
  };
  const issues=await get('issues?state=all&sort=updated&direction=desc&per_page=30');
  const tasks=[];
  for(const issue of issues.filter(i=>!i.pull_request && i.user?.login?.toLowerCase()===owner && i.title?.startsWith(TASK_PREFIX) && i.body?.startsWith(TASK_MARKER)).slice(0,5)) {
    const comments=await readTaskComments(get,issue.number);
    const replies=comments.filter(c=>c.user?.login==='github-actions[bot]' && c.body?.startsWith(AGENT_MARKER));
    const latest=replies.at(-1);
    const status=pendingTaskReply(comments,owner) ? 'queued' : latest?.body.match(/\*\*Agent: (working|ready for PR|needs input|failed|stopped)\*\*/)?.[1] || 'queued';
    const compare=latest?.body.match(/\[Review changes and create PR\]\((https:\/\/github\.com\/[^\s)]+)\)/)?.[1];
    tasks.push({number:issue.number,title:issue.title.slice(TASK_PREFIX.length),url:issue.html_url,state:issue.state,status:issue.state==='closed' ? 'closed' : status,updatedAt:issue.updated_at,
      messages:[{role:'you',text:issue.body.slice(TASK_MARKER.length).trim().slice(0,6000)},...comments.filter(c=>(c.user?.login==='github-actions[bot]' && c.body?.startsWith(AGENT_MARKER)) || (c.user?.login?.toLowerCase()===owner && c.body?.startsWith(REPLY_MARKER))).slice(-12).map(c=>({role:c.body.startsWith(REPLY_MARKER)?'you':'agent',text:c.body.slice(c.body.startsWith(REPLY_MARKER)?REPLY_MARKER.length:AGENT_MARKER.length).replace(/<!-- repo-autopilot-attempt:\d+ -->/g,'').trim().slice(0,3000)}))],compareUrl:compare?.startsWith(`https://github.com/${repository}/compare/`) ? compare : null});
  }
  return tasks;
}
