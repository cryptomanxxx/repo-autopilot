import {evaluateSafety,SAFETY_SERVICES} from './research-safety.js';
const $=id=>document.getElementById(id);
const el=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;if(cls)n.className=cls;return n;};
const labels={codex:'OpenAI Codex',github:'GitHub',cloudflare:'Cloudflare',host:'Execution host (Oracle Cloud candidate)'};
const explanations={
 invalid_context:'No valid repository/run context.',
 policy_missing_or_expired:'No independently approved current run policy.',
 observation_missing_or_stale:'No current independently qualified host observation.',
 cost_violation:'Reported additional cost exceeds the zero-cost policy.',
 cost_unknown:'Actual additional spending is unknown.',
 paid_fallback_unverified:'Prevention of paid fallback is unverified.',
 evidence_preservation_unverified:'Durable evidence preservation is unverified.',
 control_unverified:'Actual host control is unverified.',
 agent_limit_or_unknown:'Agent count and concurrency limit enforcement are unknown.',
 runtime_limit_or_unknown:'Runtime and runtime-limit enforcement are unknown.',
 retry_limit_or_unknown:'Retry count and retry-limit enforcement are unknown.'
};
for(const service of SAFETY_SERVICES){
 explanations[service+'_capacity_unknown']=labels[service]+': included capacity or overage prevention is unverified.';
 explanations[service+'_capacity_exhausted']=labels[service]+': reported remaining capacity is insufficient.';
}
export function safetyDashboardModel(repository,now=Date.now()){
 // Deliberately no policy, run identity or observation input from browser.
 // Neither manual capacity scenarios nor local DARE/Symphony files are permits.
 const result=evaluateSafety({repository,now});
 return {repository:typeof repository==='string'&&repository?repository:null,budgetSEK:0,actualCost:null,dispatchAuthorized:false,stopVerified:false,
  decision:result.decision,blockers:result.blockers.map(code=>({code,text:explanations[code]||'Unverified prerequisite.'})),
  services:SAFETY_SERVICES.map(id=>({id,label:labels[id],status:'Unverified',remaining:null})),
  source:'no_live_observation',simulationOnly:true};
}
export function renderSafety(container,repository){
 container.replaceChildren();
 const m=safetyDashboardModel(repository);
 container.append(el('p','AUTONOMOUS DISPATCH BLOCKED — no live safety authority.','dare-warning'),
 el('p','Selected repository: '+(m.repository||'None')+'. No authorized run or verified host observation.','small'));
 const grid=el('div',undefined,'research-grid');
 for(const [label,value] of [['Additional budget policy','0 SEK'],['Actual additional spending','Unknown'],['Execution authorization','Not established'],['Verified agent stop','Unknown']]){
  const tile=el('div',undefined,'research-tile');tile.append(el('span',label),el('strong',value));grid.append(tile);
 }
 container.append(grid,el('h4','Resource capacity'));
 const services=el('div',undefined,'research-grid');
 for(const service of m.services){
  const tile=el('div',undefined,'research-tile');tile.append(el('span',service.label),el('strong',service.status),el('p','Remaining capacity: unknown. Overage prevention: unverified.','small muted'));services.append(tile);
 }
 container.append(services,el('h4','Why dispatch is blocked'));
 const list=el('ul',undefined,'safety-blockers');
 for(const item of m.blockers)list.append(el('li',item.text));
 container.append(list,el('p','These are offline evaluator findings for missing trusted inputs, not live incidents or verified costs. No agent has been started or stopped by this view.','muted small'),
 el('p','Oracle Cloud is a proposed host. Account, free capacity, architecture compatibility and private connection are not qualified.','muted small'));
}
let selected=()=>null;
export function clearSafety(){renderSafety($('safety-result'),null);}
export function refreshSafety(){renderSafety($('safety-result'),selected());}
export function initSafety({repository}){selected=repository;refreshSafety();}
