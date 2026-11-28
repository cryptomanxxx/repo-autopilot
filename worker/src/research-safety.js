// Offline reference policy: no entitlement issuer, billing API, timer or effects.
const validInt=v=>Number.isSafeInteger(v)&&v>=0;
const repo=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(v)&&!['.','..'].includes(v.split('/')[1]);
const ident=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
export const SAFETY_SERVICES=Object.freeze(['codex','github','cloudflare','host']);
export function evaluateSafety({repository,runId,now,policy,observation,active=false}={}){
  const blockers=[];
  const block=(code)=>{if(!blockers.includes(code))blockers.push(code);};
  if(!repo(repository)||!ident(runId)||!validInt(now)||typeof active!=='boolean')block('invalid_context');
  const bound=x=>x?.repository===repository&&x?.runId===runId;
  if(!bound(policy)||policy?.approved!==true||policy?.incrementalBudgetSEK!==0||policy?.maxAgents!==1||
    !validInt(policy?.maxRuntimeSeconds)||policy.maxRuntimeSeconds===0||!validInt(policy?.maxRetries)||
    !validInt(policy?.expiresAt)||policy.expiresAt<=now)block('policy_missing_or_expired');
  if(!bound(observation)||observation?.trustedHostClaim!==true||!validInt(observation?.observedAt)||
    observation.observedAt>now||now-observation.observedAt>=60000)block('observation_missing_or_stale');
  if(observation?.actualAdditionalCostSEK!==0)block(typeof observation?.actualAdditionalCostSEK==='number'&&Number.isFinite(observation.actualAdditionalCostSEK)&&observation.actualAdditionalCostSEK>0?'cost_violation':'cost_unknown');
  if(observation?.paidFallbackDisabled!==true)block('paid_fallback_unverified');
  if(observation?.durableEvidenceReady!==true)block('evidence_preservation_unverified');
  if(observation?.controlVerified!==true)block('control_unverified');
  for(const service of SAFETY_SERVICES){
    const c=observation?.services?.[service];
    // Service-specific units stay distinct; do not convert tokens, PRs or money.
    if(!c||c.includedVerified!==true||c.overagePrevented!==true||!validInt(c.expiresAt)||c.expiresAt<=now||!validInt(c.remaining)||!validInt(c.required)||c.required===0||typeof c.unit!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(c.unit))block(service+'_capacity_unknown');
    else if(c.remaining<c.required)block(service+'_capacity_exhausted');
  }
  if(!validInt(observation?.runningAgents)||observation.runningAgents>1||(!active&&observation.runningAgents!==0))block('agent_limit_or_unknown');
  if(!validInt(observation?.runtimeSeconds)||!validInt(policy?.maxRuntimeSeconds)||observation.runtimeSeconds>=policy.maxRuntimeSeconds)block('runtime_limit_or_unknown');
  if(!validInt(observation?.retries)||!validInt(policy?.maxRetries)||observation.retries>policy.maxRetries)block('retry_limit_or_unknown');
  return Object.freeze({repository,runId,decision:blockers.length?(active===true?'request_safe_stop':'block_dispatch'):'eligible_in_simulation',blockers:Object.freeze(blockers),simulationOnly:true,dispatchAuthorized:false,stopVerified:false,requiresHostEnforcement:true});
}
