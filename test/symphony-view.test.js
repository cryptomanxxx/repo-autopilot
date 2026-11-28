import test from 'node:test';
import assert from 'node:assert/strict';
import {symphonyMetrics,initSymphony,clearSymphony} from '../worker/public/symphony-view.js';
import {readFileSync} from 'node:fs';
test('unconnected and unavailable metrics remain unknown',()=>{for(const m of [null,{state:'unavailable'}])assert.ok(symphonyMetrics(m).every(([,v])=>v==='Unknown'));});
test('historical zero and numeric usage distinct from unknown',()=>{const v=Object.fromEntries(symphonyMetrics({running:0,retrying:1,blocked:2,totals:{inputTokens:10,outputTokens:4,totalTokens:14,aggregateRuntimeSeconds:2.5}}));assert.equal(v['Running sessions'],'0');assert.equal(v['Total tokens'],'14');assert.equal(v['Aggregate session runtime (seconds)'],'2.5');assert.equal(v['Remaining account quota'],'Unknown');assert.equal(v['Total queued tasks'],'Unknown');});
test('markup preserves disabled agent controls and local-only input',()=>{const html=readFileSync(new URL('../worker/public/index.html',import.meta.url),'utf8');for(const id of ['symphony-ack','symphony-file','symphony-clear','symphony-result','symphony-message'])assert.equal(html.split('id="'+id+'"').length,2);for(const label of ['START','PAUSE','STOP ALL AGENTS'])assert.ok(html.includes('<button type="button" disabled>'+label+'</button>'));});
function mockDOM(){
 const nodes=new Map();
 function node(){return {children:[],textContent:'',value:'',checked:false,files:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}};}
 for(const id of ['symphony-ack','symphony-file','symphony-clear','symphony-result','symphony-message'])nodes.set(id,node());
 return {nodes,document:{getElementById:id=>nodes.get(id),createElement:()=>node()}};
}
const bytes=()=>new TextEncoder().encode(JSON.stringify({generated_at:'2026-01-01T00:00:00Z',counts:{running:0,retrying:0,blocked:0},running:[],retrying:[],blocked:[],codex_totals:{input_tokens:0,output_tokens:0,total_tokens:0,seconds_running:0},rate_limits:null}));
test('local inspection requires acknowledgement and clears on request',async()=>{
 const original=globalThis.document,{nodes,document}=mockDOM();globalThis.document=document;
 try{initSymphony({repository:()=> 'owner/repo',isActive:()=>true});let reads=0;nodes.get('symphony-file').files=[{size:bytes().length,arrayBuffer:async()=>{reads++;return bytes().buffer;}}];await nodes.get('symphony-file').onchange();assert.equal(reads,0);nodes.get('symphony-ack').checked=true;await nodes.get('symphony-file').onchange();assert.equal(reads,1);assert.match(nodes.get('symphony-message').textContent,/inspected/);clearSymphony();assert.equal(nodes.get('symphony-ack').checked,false);assert.equal(nodes.get('symphony-message').textContent,'No local snapshot loaded.');}finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
test('late read after clear cannot repopulate status',async()=>{
 const original=globalThis.document,{nodes,document}=mockDOM();globalThis.document=document;
 try{initSymphony({repository:()=> 'owner/repo',isActive:()=>true});nodes.get('symphony-ack').checked=true;let release;nodes.get('symphony-file').files=[{size:bytes().length,arrayBuffer:()=>new Promise(resolve=>{release=resolve;})}];const pending=nodes.get('symphony-file').onchange();clearSymphony();release(bytes().buffer);await pending;assert.equal(nodes.get('symphony-message').textContent,'No local snapshot loaded.');}finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
