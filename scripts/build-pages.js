import {mkdir, copyFile, rm, readFile, writeFile} from 'node:fs/promises';
const dist = new URL('../dist/',import.meta.url);
await rm(dist,{recursive:true,force:true});
await mkdir(dist,{recursive:true});
for(const name of ['index.html','app.js','saved-data.js','style.css']) await copyFile(new URL(`../public/${name}`,import.meta.url),new URL(name,dist));
// Dashboard rendering is shared with the Worker app, which owns these files.
for(const name of ['dashboard-view.js','dashboard.css']) await copyFile(new URL(`../worker/public/${name}`,import.meta.url),new URL(name,dist));
for(const name of ['github.js','codex.js','progress.js']) await copyFile(new URL(`../src/${name}`,import.meta.url),new URL(name,dist));
console.log('Built static dashboard in dist/ (no environment files or credentials).');

// Only the public app URL enters the static build; credentials stay in the Worker.
if(process.env.AUTOPILOT_CHAT_URL) {
  const url=new URL(process.env.AUTOPILOT_CHAT_URL);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash) throw new Error('AUTOPILOT_CHAT_URL must be an HTTPS URL without credentials, query or fragment.');
  const html=await readFile(new URL('index.html',dist),'utf8');
  await writeFile(new URL('index.html',dist),html.replace('id="app-link" class="app-link" hidden',`id="app-link" class="app-link" href="${url.href.replaceAll('&','&amp;').replaceAll('"','&quot;')}"`));
}
