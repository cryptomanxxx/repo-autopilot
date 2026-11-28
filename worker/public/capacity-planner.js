// Manual scenario only. Review rounds are an estimate, never an account quota.
export const PLANS=['unknown','Free','Go','Plus','Pro','Business','Enterprise','Edu','Other'];
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export function capacityScenario({plan='unknown',days,rounds,reserve,expectedTenths,implementation}={}) {
  if(!PLANS.includes(plan)||!integer(days,1,365)||!integer(rounds,0,1000000)||
    !integer(reserve,0,100)||!integer(expectedTenths,10,10000)||
    (implementation!==null&&!integer(implementation,0,1000000))) return null;
  const usable=Math.floor(rounds*(100-reserve)/100);
  const reviewCapacity=Math.floor(usable*10/expectedTenths);
  const capacity=implementation===null?reviewCapacity:Math.min(reviewCapacity,implementation);
  return {plan,days,usable,reserved:rounds-usable,reviewCapacity,capacity,perDay:capacity/days,
    limiting:implementation===null?'review only; implementation unknown':implementation<reviewCapacity?'implementation':implementation===reviewCapacity?'both':'review',
    actualQuota:null,dispatchAuthorized:false};
}
export function observedReviews(model) {
  const s=model?.stats,m=s?.reviewRounds;
  if(!m||!integer(m.known,1,30)||!integer(m.unknown,0,30)||!integer(m.observedTotal,0,30000000)||m.known+m.unknown!==s.population) return null;
  return {mean:m.observedTotal/m.known,known:m.known,unknown:m.unknown,repository:s.repository,fetchedAt:s.fetchedAt,stale:model.stale===true};
}
export function parseScenarioNumber(value,{optional=false,tenths=false}={}) {
  if(typeof value!=='string'||value.trim()==='') return optional?null:undefined;
  const pattern=tenths?/^\d+(?:\.\d)?$/:/^\d+$/;
  if(!pattern.test(value)) return undefined;
  const n=Number(value);
  return tenths?Math.round(n*10):n;
}
