import test from 'node:test';
import assert from 'node:assert/strict';
import {safetyDashboardModel,renderSafety,initSafety,clearSafety,refreshSafety} from '../worker/public/safety-view.js';
import {evaluateSafety} from '../worker/src/research-safety.js';
import {readFileSync} from 'node:fs';
test('dashboard maps canonical default-deny evaluation without independent authority',()=>{
 const repository='owner/repo',now=100000,m=safetyDashboardModel(repository,now);
 assert.deepEqual(m.blockers.map(b=>b.code),evaluateSafety({repository,now}).blockers);
 assert.equal(m.decision,'block_dispatch');assert.equal(m.actualCost,null);assert.equal(m.budgetSEK,0);
 assert.equal(m.dispatchAuthorized,false);assert.equal(m.stopVerified,false);
 assert.equal(m.simulationOnly,true);assert.equal(m.source,'no_live_observation');
});
test('all four services are unverified and no quota is fabricated',()=>{
 const m=safetyDashboardModel('owner/repo');
 assert.deepEqual(m.services.map(s=>s.id),['codex','github','cloudflare','host']);
 assert.ok(m.services.every(s=>s.status==='Unverified'&&s.remaining===null));
 assert.ok(m.blockers.every(b=>b.text!=='Unverified prerequisite.'));
});
test('missing selection remains missing; no old repository retained',()=>{
 assert.equal(safetyDashboardModel(null).repository,null);
 assert.equal(safetyDashboardModel('').repository,null);
 assert.equal(safetyDashboardModel('other/repo').repository,'other/repo');
});
function mockDOM(){
 function node(){return {textContent:'',children:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}};}
 const root=node();
 const flatten=n=>[n.textContent,...n.children.flatMap(flatten)].join(' ');
 return {root,flatten,document:{getElementById:id=>{assert.equal(id,'safety-result');return root;},createElement:()=>node()}};
}
test('render uses text content and distinguishes policy zero from unknown spending',()=>{
 const original=globalThis.document,m=mockDOM();globalThis.document=m.document;
 try{renderSafety(m.root,'<img src=x>');const text=m.flatten(m.root);assert.match(text,/AUTONOMOUS DISPATCH BLOCKED/);assert.match(text,/0 SEK/);assert.match(text,/Actual additional spending Unknown/);assert.match(text,/<img src=x>/);assert.match(text,/Oracle Cloud is a proposed host/);}finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
test('repository lifecycle clears and refreshes the selected context',()=>{
 const original=globalThis.document,m=mockDOM();globalThis.document=m.document;
 try{let repo='owner/first';initSafety({repository:()=>repo});assert.match(m.flatten(m.root),/owner\/first/);clearSafety();assert.doesNotMatch(m.flatten(m.root),/owner\/first/);repo='owner/second';refreshSafety();assert.match(m.flatten(m.root),/owner\/second/);assert.doesNotMatch(m.flatten(m.root),/owner\/first/);}finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
test('Safety markup is read only and controls remain disabled',()=>{
 const html=readFileSync(new URL('../worker/public/index.html',import.meta.url),'utf8');
 const panel=html.split('<section id="research-panel-safety"')[1].split('</section>')[0];
 assert.ok(panel.includes('id="safety-result"'));assert.doesNotMatch(panel,/<(?:button|input|form|select)\b/);
 for(const label of ['START','PAUSE','STOP ALL AGENTS'])assert.ok(html.includes('<button type="button" disabled>'+label+'</button>'));
});
