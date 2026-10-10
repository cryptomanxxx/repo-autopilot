import {mkdir, copyFile, rm, readFile, writeFile} from 'node:fs/promises';
const dist = new URL('../dist/',import.meta.url);
await rm(dist,{recursive:true,force:true});
await mkdir(dist,{recursive:true});
for(const name of ['index.html','app.js','saved-data.js','task-ui.js','style.css']) await copyFile(new URL(`../public/${name}`,import.meta.url),new URL(name,dist));
await copyFile(new URL('../src/github.js',import.meta.url),new URL('github.js',dist));
await copyFile(new URL('../src/codex.js',import.meta.url),new URL('codex.js',dist));
await copyFile(new URL('../src/progress.js',import.meta.url),new URL('progress.js',dist));
console.log('Built static dashboard in dist/ (no environment files or credentials).');

// Only the public chat URL enters the static build; credentials stay on the backend.
if(process.env.AUTOPILOT_CHAT_URL) {
  const url=new URL(process.env.AUTOPILOT_CHAT_URL);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw new Error('AUTOPILOT_CHAT_URL must be an HTTPS URL without credentials, query or fragment.');
  const html=await readFile(new URL('index.html',dist),'utf8');
  await writeFile(new URL('index.html',dist),html.replace('id="chat-link" class="task-link" hidden',`id="chat-link" class="task-link" href="${url.href.replaceAll('&','&amp;').replaceAll('"','&quot;')}"`));
}
