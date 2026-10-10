import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createGitHub, repositoryName} from './github.js';
const github = createGitHub({token:process.env.GITHUB_TOKEN});
const assets = {'/':['index.html','text/html'], '/app.js':['app.js','text/javascript'], '/style.css':['style.css','text/css'], '/github.js':['../src/github.js','text/javascript'], '/codex.js':['../src/codex.js','text/javascript']};
const cache = new Map();
const host = '127.0.0.1', port = Number(process.env.PORT || 3000);
http.createServer(async (req,res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Cache-Control','no-store');
  try {
    const url = new URL(req.url, `http://${host}:${port}`);
    if (req.method !== 'GET') {res.writeHead(405);return res.end('Read-only dashboard');}
    if (url.pathname === '/api/dashboard') {
      const repo = repositoryName(url.searchParams.get('repo') || '');
      const entry = cache.get(repo);
      let data;
      if (entry && Date.now() - entry.at < 60000) data = await entry.promise;
      else {
        if(cache.size >= 20) cache.delete(cache.keys().next().value);
        const next = {at:Date.now(), promise:github.snapshot(repo)};
        cache.set(repo,next);
        try {data = await next.promise;} catch(error) {if(cache.get(repo) === next) cache.delete(repo);throw error;}
      }
      res.writeHead(200, {'Content-Type':'application/json'});return res.end(JSON.stringify(data));
    }
    const asset = assets[url.pathname];
    if (!asset) {res.writeHead(404);return res.end('Not found');}
    let body = await readFile(fileURLToPath(new URL(`../public/${asset[0]}`, import.meta.url)));
    if(url.pathname === '/') body = body.toString().replace('data-mode="static"','data-mode="server"');
    res.writeHead(200, {'Content-Type':asset[1]});res.end(body);
  } catch(error) {res.writeHead(400, {'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
}).listen(port,host,() => console.log(`Repo Autopilot: http://${host}:${port}`));
