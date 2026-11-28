import test from 'node:test';
import assert from 'node:assert/strict';
import {repositoryUrl,updateRepositoryLink} from '../worker/public/repository-link.js';

test('canonical repository URL',()=>{
  assert.equal(repositoryUrl('Owner/repo.name-1'),'https://github.com/Owner/repo.name-1');
});
test('rejects invalid and external URLs',()=>{
  for(const name of [null,'','https://evil.example/x','owner/..','owner/.','owner/repo?x','owner/repo#x','owner/repo/extra','owner/%2e%2e','owner/repo\n','owner\\repo']) {
    assert.equal(repositoryUrl(name),null);
  }
});
test('updates selected repository and opens separate tab',()=>{
  const link={hidden:true,removeAttribute(k){delete this[k];}};
  updateRepositoryLink(link,'owner/first');
  assert.equal(link.href,'https://github.com/owner/first');
  assert.equal(link.hidden,false);
  assert.equal(link.target,'_blank');
  assert.equal(link.rel,'noopener noreferrer');
  updateRepositoryLink(link,'owner/second');
  assert.equal(link.href,'https://github.com/owner/second');
  assert.equal(link.textContent,'owner/second ↗');
  updateRepositoryLink(link,'invalid');
  assert.equal(link.hidden,true);
  assert.equal(link.href,undefined);
  assert.equal(link.textContent,'');
});
