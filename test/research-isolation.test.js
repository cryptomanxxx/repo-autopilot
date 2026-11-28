import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchScope} from '../worker/public/research-scope.js';
import {clearCapacityScenario,renderCapacity} from '../worker/public/capacity-view.js';
import {createControlModel,transitionControl} from '../worker/src/symphony-control-model.js';
import {evaluateSafety} from '../worker/src/research-safety.js';
import {readPrivateSymphony} from '../worker/src/symphony-private-read.js';
import {SYMPHONY_REVISION} from '../worker/public/symphony-state.js';
const a='owner/alpha',b='owner/beta';
test('A to B to A rejects outstanding A ticket even on return',()=>{
 const scope=createResearchScope();scope.select(a);const old=scope.capture();assert.equal(scope.accepts(old,a),true);
 scope.select(b);assert.equal(scope.accepts(old,b),false);scope.select(a);assert.equal(scope.accepts(old,a),false);assert.equal(scope.accepts(scope.capture(),a),true);
});
test('clear and reselect invalidate all outstanding tickets',()=>{
 const scope=createResearchScope();scope.select(a);const old=scope.capture();scope.clear();assert.equal(scope.accepts(old,a),false);assert.equal(scope.accepts(scope.capture(),null),false);
 scope.select(a);assert.equal(scope.accepts(old,a),false);assert.equal(scope.accepts(scope.capture(),b),false);
});
test('manual repository scenario resets without modifying descriptive plan',()=>{
 const values={'capacity-plan':'Plus','capacity-days':'30','capacity-rounds':'100','capacity-reserve':'10','capacity-expected':'2','capacity-implementation':'20','capacity-output':''};
 const nodes=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,textContent:''}]));
 const original=globalThis.document;globalThis.document={getElementById:id=>nodes[id]};
 try{renderCapacity();assert.match(nodes['capacity-output'].textContent,/Scenario:/);clearCapacityScenario();assert.equal(nodes['capacity-plan'].value,'Plus');assert.equal(nodes['capacity-days'].value,'7');assert.equal(nodes['capacity-reserve'].value,'20');for(const k of ['capacity-rounds','capacity-expected','capacity-implementation'])assert.equal(nodes[k].value,'');assert.match(nodes['capacity-output'].textContent,/Actual account quota: unknown/);}
 finally{if(original===undefined)delete globalThis.document;else globalThis.document=original;}
});
test('same command identifiers cannot transfer authority between repositories',()=>{
 const base={epoch:'epoch1',now:1,hostReconciled:true,noOutstandingCommands:true,dispatchDisabled:true,workersStopped:true,evidencePreserved:true};
 const sa=transitionControl(createControlModel(a),{...base,type:'reconcile',repository:a}).state;
 const sb=transitionControl(createControlModel(b),{...base,type:'reconcile',repository:b}).state;
 const permit={repository:a,epoch:'epoch1',ownerAuthorized:true,scopeVerified:true,expiresAt:100,operatorConfirmed:true,dareGatePassed:true,hostVerified:true,controlVerified:true,includedCapacityVerified:true,noPaidFallback:true,incrementalBudget:0,maxAgents:1,maxRuntimeSeconds:60,maxRetries:1};
 const request={type:'request',repository:a,epoch:'epoch1',now:2,action:'start',id:'cmd1',expectedSequence:0,permit};
 const started=transitionControl(sa,request);assert.equal(started.accepted,true);
 assert.equal(transitionControl(sb,request).accepted,false);assert.equal(transitionControl(sb,{...request,repository:b}).accepted,false);
 assert.equal(transitionControl(started.state,{type:'ack',repository:b,epoch:'epoch1',now:3,id:'cmd1',sequence:1,hostConfirmed:true,outcome:'confirmed',runningConfirmed:true}).accepted,false);
});
test('private read refuses another repository permit without transport',async()=>{
 let calls=0;const permit={repository:a,revision:SYMPHONY_REVISION,ownerAuthorized:true,repositoryAccessVerified:true,privateHostVerified:true,scopeVerified:true,includedCapacityVerified:true,noPaidFallback:true,readApproved:true,expiresAt:100};
 const result=await readPrivateSymphony({repository:b,permit,now:()=>1,transport:async()=>{calls++;throw Error('must not run');}});
 assert.equal(result.state,'blocked');assert.equal(calls,0);
});
test('safety evidence cannot cross repository or run boundaries',()=>{
 const now=1000,runId='run1',policy={repository:a,runId,approved:true,incrementalBudgetSEK:0,maxAgents:1,maxRuntimeSeconds:60,maxRetries:1,expiresAt:2000};
 const cap={includedVerified:true,overagePrevented:true,remaining:2,required:1,unit:'requests',expiresAt:2000};
 const observation={repository:a,runId,trustedHostClaim:true,observedAt:now,actualAdditionalCostSEK:0,paidFallbackDisabled:true,durableEvidenceReady:true,controlVerified:true,services:Object.fromEntries(['codex','github','cloudflare','host'].map(k=>[k,{...cap}])),runningAgents:0,runtimeSeconds:0,retries:0};
 assert.equal(evaluateSafety({repository:a,runId,now,policy,observation}).decision,'eligible_in_simulation');
 for(const context of [{repository:b,runId},{repository:a,runId:'run2'}]){
  const result=evaluateSafety({...context,now,policy,observation});assert.equal(result.decision,'block_dispatch');assert.ok(result.blockers.includes('policy_missing_or_expired'));assert.ok(result.blockers.includes('observation_missing_or_stale'));assert.equal(result.dispatchAuthorized,false);
 }
});
