import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {RESEARCH_SECTIONS,researchSection,nextResearchSection,initResearchTabs} from '../worker/public/research-tabs.js';
test('exact six navigation sections and safe fallback',()=>{
 assert.deepEqual(RESEARCH_SECTIONS,['overview','symphony','dare','codex','evidence','safety']);
 assert.equal(researchSection('unknown'),'overview');assert.equal(researchSection(null),'overview');
});
test('keyboard navigation wraps and supports Home and End',()=>{
 assert.equal(nextResearchSection('overview','ArrowLeft'),'safety');
 assert.equal(nextResearchSection('safety','ArrowRight'),'overview');
 assert.equal(nextResearchSection('dare','Home'),'overview');
 assert.equal(nextResearchSection('dare','End'),'safety');
 assert.equal(nextResearchSection('codex','Enter'),null);
});
test('subtab selection updates visibility, accessibility and focus without actions',()=>{
 const nodes=new Map();
 for(const n of RESEARCH_SECTIONS){
  const button={attrs:{},events:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.events[k]=v;},focus(){this.focused=true;}};
  nodes.set('research-tab-'+n,button);nodes.set('research-panel-'+n,{hidden:true});
 }
 const original=globalThis.document;globalThis.document={getElementById:id=>nodes.get(id)};
 try{
  const changes=[],tabs=initResearchTabs({onChange:(...a)=>changes.push(a)});
  assert.equal(tabs.current(),'overview');
  nodes.get('research-tab-codex').events.click();
  assert.equal(tabs.current(),'codex');assert.equal(nodes.get('research-panel-overview').hidden,true);
  assert.equal(nodes.get('research-panel-codex').hidden,false);assert.equal(nodes.get('research-tab-codex').attrs['aria-selected'],'true');
  let prevented=false;nodes.get('research-tab-codex').events.keydown({key:'ArrowRight',preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(tabs.current(),'evidence');assert.equal(nodes.get('research-tab-evidence').focused,true);
  assert.equal([...nodes.values()].filter(n=>n.tabIndex===0).length,1);assert.equal(changes.length,2);
 }finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
test('markup has unique ids, correct panel ownership and disabled Symphony controls',()=>{
 const html=readFileSync(new URL('../worker/public/index.html',import.meta.url),'utf8');
 const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
 for(const n of RESEARCH_SECTIONS){assert.ok(html.includes('aria-controls="research-panel-'+n+'"'));assert.ok(html.includes('aria-labelledby="research-tab-'+n+'"'));}
 const symphony=html.split('<section id="research-panel-symphony"')[1].split('</section>')[0];
 for(const label of ['START','PAUSE','STOP ALL AGENTS'])assert.ok(symphony.includes('<button type="button" disabled>'+label+'</button>'));
 for(const [panel,id] of [['overview','research-results'],['dare','dare-file'],['codex','capacity-plan']]){
  const body=html.split('<section id="research-panel-'+panel+'"')[1].split('<section id="research-panel-')[0];assert.ok(body.includes('id="'+id+'"'));
 }
});
