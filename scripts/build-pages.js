import {mkdir, copyFile, rm} from 'node:fs/promises';
const dist = new URL('../dist/',import.meta.url);
await rm(dist,{recursive:true,force:true});
await mkdir(dist,{recursive:true});
for(const name of ['index.html','app.js','style.css']) await copyFile(new URL(`../public/${name}`,import.meta.url),new URL(name,dist));
await copyFile(new URL('../src/github.js',import.meta.url),new URL('github.js',dist));
console.log('Built static dashboard in dist/ (no environment files or credentials).');
