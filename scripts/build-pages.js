import {mkdir, copyFile, rm} from 'node:fs/promises';
const dist = new URL('../dist/',import.meta.url);
await rm(dist,{recursive:true,force:true});
await mkdir(dist,{recursive:true});
for(const name of ['index.html','app.js','saved-data.js','style.css']) await copyFile(new URL(`../public/${name}`,import.meta.url),new URL(name,dist));
await copyFile(new URL('../src/github.js',import.meta.url),new URL('github.js',dist));
await copyFile(new URL('../src/codex.js',import.meta.url),new URL('codex.js',dist));
await copyFile(new URL('../src/progress.js',import.meta.url),new URL('progress.js',dist));
console.log('Built static dashboard in dist/ (no environment files or credentials).');
