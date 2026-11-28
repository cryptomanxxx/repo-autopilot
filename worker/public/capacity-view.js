import {capacityScenario,observedReviews,parseScenarioNumber,PLANS} from './capacity-planner.js';

const $=id=>document.getElementById(id);
let observation=null;
export function updateCapacityObservation(model) {
  observation=observedReviews(model);
  const target=$('capacity-observation');
  if(!target) return;
  target.textContent=observation
    ? 'Observed lower-bound mean: '+observation.mean.toFixed(2)+' review rounds per PR with known counts ('+observation.known+' known, '+observation.unknown+' unknown). '+observation.repository+' · '+observation.fetchedAt+(observation.stale?' · earlier snapshot':'')+'. Includes unfinished PRs; not a prediction or quota.'
    : 'Observed review rounds per PR: unknown. Load dashboard data to see the sample.';
}
export function renderCapacity() {
  const val=id=>$(id).value;
  const parse=(id,options)=>parseScenarioNumber(val(id),options);
  const implementation=parse('capacity-implementation',{optional:true});
  // A nonempty malformed optional field is invalid, not an unknown constraint.
  const result=capacityScenario({plan:val('capacity-plan'),days:parse('capacity-days'),rounds:parse('capacity-rounds'),
    reserve:parse('capacity-reserve'),expectedTenths:parse('capacity-expected',{tenths:true}),implementation});
  $('capacity-output').textContent=result
    ? 'Scenario: '+result.capacity+' PRs over '+result.days+' days ('+result.perDay.toFixed(2)+' per day). Review-only capacity: '+result.reviewCapacity+'. Usable rounds: '+result.usable+'; reserved: '+result.reserved+'. Limiting factor: '+result.limiting+'.'
    : 'Enter a valid manual scenario to estimate capacity. Actual account quota: unknown.';
}
export function initCapacity() {
  const select=$('capacity-plan');
  select.replaceChildren(...PLANS.map(plan=>new Option(plan==='unknown'?'Not selected':plan,plan)));
  select.value='unknown';
  try {const saved=localStorage.getItem('autopilot-capacity-plan');if(PLANS.includes(saved))select.value=saved;} catch {}
  select.addEventListener('change',()=>{try{localStorage.setItem('autopilot-capacity-plan',select.value);}catch{}renderCapacity();});
  for(const id of ['capacity-days','capacity-rounds','capacity-reserve','capacity-expected','capacity-implementation']) $(id).addEventListener('input',renderCapacity);
  renderCapacity();
}

// Manual repository scenario is ephemeral. Only the descriptive plan persists.
export function clearCapacityScenario(){
 for(const [id,value] of [['capacity-days','7'],['capacity-rounds',''],['capacity-reserve','20'],['capacity-expected',''],['capacity-implementation','']]){const field=$(id);if(field)field.value=value;}
 if($('capacity-output'))renderCapacity();
}
