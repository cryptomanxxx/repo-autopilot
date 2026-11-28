import test from 'node:test';
import assert from 'node:assert/strict';
import {capacityScenario,observedReviews,parseScenarioNumber,PLANS} from '../worker/public/capacity-planner.js';
const base={plan:'Plus',days:7,rounds:100,reserve:20,expectedTenths:20,implementation:null};
test('manual scenario reserves capacity and rounds down',()=>{
 const x=capacityScenario(base);assert.equal(x.usable,80);assert.equal(x.reserved,20);assert.equal(x.capacity,40);assert.equal(x.perDay,40/7);
});
test('implementation constraint is independent',()=>{const x=capacityScenario({...base,implementation:12});assert.equal(x.capacity,12);assert.equal(x.reviewCapacity,40);assert.equal(x.limiting,'implementation');});
test('review constraint and tie',()=>{assert.equal(capacityScenario({...base,implementation:50}).limiting,'review');assert.equal(capacityScenario({...base,implementation:40}).limiting,'both');});
test('plan never implies quota or authorization',()=>{for(const plan of PLANS){const x=capacityScenario({...base,plan});assert.equal(x.capacity,40);assert.equal(x.actualQuota,null);assert.equal(x.dispatchAuthorized,false);}});
test('zero capacity is distinct from unknown',()=>{assert.equal(capacityScenario({...base,rounds:0}).capacity,0);assert.equal(capacityScenario({...base,rounds:null}),null);assert.equal(capacityScenario({...base,implementation:0}).capacity,0);});
test('invalid inputs rejected',()=>{for(const changes of [{days:0},{reserve:101},{rounds:-1},{rounds:1.5},{expectedTenths:0},{expectedTenths:15.5},{implementation:undefined},{implementation:-1},{plan:'invalid'}])assert.equal(capacityScenario({...base,...changes}),null);});
test('fractional expected rounds use integer tenths',()=>{assert.equal(capacityScenario({...base,rounds:11,reserve:10,expectedTenths:15}).capacity,6);});
test('full reserve means no planned work',()=>assert.equal(capacityScenario({...base,reserve:100}).capacity,0));
test('manual numeric parser does not coerce missing to zero',()=>{assert.equal(parseScenarioNumber(''),undefined);assert.equal(parseScenarioNumber('',{optional:true}),null);assert.equal(parseScenarioNumber('0'),0);assert.equal(parseScenarioNumber('2.3',{tenths:true}),23);assert.equal(parseScenarioNumber('2.35',{tenths:true}),undefined);assert.equal(parseScenarioNumber('1e3'),undefined);assert.equal(parseScenarioNumber('bad',{optional:true}),undefined);});
test('observed reference includes coverage and stale flag',()=>{const x=observedReviews({stale:true,stats:{repository:'owner/repo',fetchedAt:'2026-11-28T07:00:00Z',population:5,reviewRounds:{known:3,unknown:2,observedTotal:7}}});assert.equal(x.mean,7/3);assert.equal(x.known,3);assert.equal(x.unknown,2);assert.equal(x.stale,true);});
test('missing or inconsistent observation remains unknown',()=>{assert.equal(observedReviews(null),null);assert.equal(observedReviews({stats:{population:2,reviewRounds:{known:0,unknown:2,observedTotal:0}}}),null);assert.equal(observedReviews({stats:{population:4,reviewRounds:{known:1,unknown:1,observedTotal:1}}}),null);});
