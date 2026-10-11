let csrf='',number='',image=null,previewUrl=null,loading=false,sending=false,imageSelection=0,taskList=[];
const el=id=>document.getElementById(id);
const status=text=>{el('chat-status').textContent=text;};
async function api(path,body) {
  const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(90000)});
  const value=await r.json();if(!r.ok) throw new Error(value.error||'Request failed.');return value;
}
function clearImage() {imageSelection++;image=null;el('screenshot').value='';el('preview').hidden=true;el('remove-image').hidden=true;if(previewUrl) URL.revokeObjectURL(previewUrl);previewUrl=null;}
el('remove-image').onclick=clearImage;
el('screenshot').onchange=async()=>{
  const selection=++imageSelection;clearSelectedPreview();image=null;
  const file=el('screenshot').files[0];if(!file) return;
  if(!['image/png','image/jpeg'].includes(file.type)||file.size>2000000) {clearImage();status('Choose a PNG or JPEG smaller than 2 MB.');return;}
  try {const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});if(selection!==imageSelection) return;image=data;previewUrl=URL.createObjectURL(file);el('preview').src=previewUrl;el('preview').hidden=false;el('remove-image').hidden=false;status('Screenshot selected. It will be interpreted when you send the message.');} catch {clearImage();status('Could not read the screenshot.');}
};
function clearSelectedPreview() {if(previewUrl) URL.revokeObjectURL(previewUrl);previewUrl=null;el('preview').hidden=true;el('remove-image').hidden=true;}
function link(id,url) {const node=el(id);node.hidden=true;if(typeof url==='string'&&url.startsWith('https://github.com/')) {node.href=url;node.hidden=false;}}
async function refresh() {
  if(loading||sending||document.hidden||!csrf) return;
  loading=true;const selected=number;
  try {
    taskList=await api('/api/tasks');if(selected!==number) return;
    const select=el('conversation');select.replaceChildren(new Option('New task',''));
    for(const task of taskList) select.add(new Option(`#${task.number} ${task.title} · ${task.status}`,String(task.number)));
    if(number&&!taskList.some(t=>String(t.number)===number)) select.add(new Option(`Task #${number}`,number));select.value=number;
    if(number) {
      const data=await api('/api/messages?number='+number);if(selected!==number) return;const container=el('messages');
      const messages=[{user:data.issue.user?.login,body:data.issue.body.replace('<!-- repo-autopilot-task -->','').trim()},...data.comments.filter(c=>(c.user?.login==='github-actions[bot]' && c.body?.startsWith('<!-- repo-autopilot-agent -->')) || (c.user?.login?.toLowerCase()===data.issue.user?.login?.toLowerCase() && c.body?.startsWith('<!-- repo-autopilot-reply -->'))).map(c=>({user:c.user?.login,body:c.body.replace(/<!-- repo-autopilot-(?:agent|reply|attempt:\d+) -->/g,'').trim()}))];
      const fingerprint=JSON.stringify(messages);if(container.dataset.fingerprint!==fingerprint) {container.replaceChildren();for(const message of messages) {const p=document.createElement('p'),label=document.createElement('strong');label.textContent=message.user==='github-actions[bot]'?'Agent: ':'You: ';p.className='task-message';p.append(label,document.createTextNode(message.body));container.append(p);}container.dataset.fingerprint=fingerprint;}
      const task=taskList.find(t=>String(t.number)===number);link('review-link',task?.pullUrl||task?.compareUrl);el('review-link').textContent=task?.pullUrl?'Open pull request':'Review changes and create PR';link('issue-link',data.issue.html_url);
      const canReply=['needs input','failed'].includes(task?.status)&&data.issue.state==='open';el('send').disabled=!canReply;
      status(canReply?'You can reply here to continue the same task.':task?.status==='ready for PR'?'Changes are ready for CI and Codex review.':data.issue.state==='closed'?'This task is closed. Choose New task to start another.':'Waiting for the agent. Replies update automatically every 20 seconds.');
    } else {el('messages').replaceChildren();delete el('messages').dataset.fingerprint;el('send').disabled=false;link('review-link',null);link('issue-link',null);}
  } catch(error) {status(error.message);} finally {loading=false;}
}
el('conversation').onchange=()=>{number=el('conversation').value;refresh();};
el('chat-form').onsubmit=async event=>{
  event.preventDefault();if(sending) return;sending=true;el('send').disabled=true;el('message').disabled=true;el('conversation').disabled=true;el('screenshot').disabled=true;status(image?'Interpreting screenshot and sending…':'Sending…');
  try {const result=await api('/api/send',{text:el('message').value,image,number:number?Number(number):undefined});number=String(result.number);el('message').value='';clearImage();status('Message sent. The agent will reply in this conversation.');}
  catch(error) {status(error.message);el('send').disabled=false;}
  finally {sending=false;el('message').disabled=false;el('conversation').disabled=false;el('screenshot').disabled=false;}
  if(!el('message').value) await refresh();
};
el('logout').onclick=async()=>{try {await api('/api/logout',{});location.reload();} catch(error) {status(error.message);}};
try {const session=await api('/api/session');if(session.login) {csrf=session.csrf;el('account').textContent=`${session.repository} · Signed in as ${session.login}`;el('login').hidden=true;el('logout').hidden=false;el('chat').hidden=false;await refresh();setInterval(refresh,20000);document.addEventListener('visibilitychange',refresh);}} catch {el('account').textContent='Chat is unavailable. Try again later.';}
