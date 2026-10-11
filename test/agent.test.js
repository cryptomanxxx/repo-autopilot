import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedAgentPath} from '../src/agent.js';

test('agent edits are limited to source, page, test and README files',()=>{
  for(const p of ['.github/workflows/ci.yml','scripts/build-pages.js','src/agent.js','worker/src/app.js','public/../.env','public/.env','package.json','public/a\\b.js','src/.hidden/x.js','public/logo.png',42]) assert.equal(allowedAgentPath(p),false,String(p));
  for(const p of ['public/app.js','src/github.js','test/github.test.js','README.md','public/style.css']) assert.equal(allowedAgentPath(p),true,p);
});
