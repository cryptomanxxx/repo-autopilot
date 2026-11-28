// Offline reference model only. No effects, transport, permission issuer or
// production state persistence. All inputs are synthetic trusted-host claims.
const repo=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(v)&&!['.','..'].includes(v.split('/')[1]);
const ident=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const immutable=s=>Object.freeze({...s,pending:s.pending?Object.freeze({...s.pending}):null});
export function createControlModel(repository){
  if(!repo(repository))throw new TypeError('Invalid repository');
  return immutable({repository,phase:'unknown',epoch:null,sequence:0,pending:null,connected:false,stopVerified:false,evidencePreserved:null,dispatchAuthorized:false});
}
const reject=(state,reason)=>({accepted:false,reason,state,command:null});
const accept=(state,command=null)=>({accepted:true,state:immutable(state),command:command&&Object.freeze(command)});
const scoped=(s,e)=>e.repository===s.repository&&ident(e.epoch)&&e.epoch===s.epoch;
const permitOK=(s,p,now)=>p?.repository===s.repository&&p.epoch===s.epoch&&p.ownerAuthorized===true&&p.scopeVerified===true&&integer(p.expiresAt)&&p.expiresAt>now;
const startOK=(p)=>p.operatorConfirmed===true&&p.dareGatePassed===true&&p.hostVerified===true&&p.controlVerified===true&&p.includedCapacityVerified===true&&p.noPaidFallback===true&&p.incrementalBudget===0&&p.maxAgents===1&&integer(p.maxRuntimeSeconds)&&p.maxRuntimeSeconds>0&&integer(p.maxRetries);
export function transitionControl(s,e){
  if(!e||!integer(e.now)||e.repository!==s.repository)return reject(s,'invalid event or scope');
  if(e.type==='disconnect'){
    return accept({...s,phase:'unknown',connected:false,stopVerified:false,evidencePreserved:null});
  }
  // An independently qualified host must reconcile durable outstanding
  // commands and verify worker/dispatch state before supplying this event.
  if(e.type==='reconcile'){
    if(s.connected||!ident(e.epoch)||e.hostReconciled!==true||e.noOutstandingCommands!==true||e.dispatchDisabled!==true||e.workersStopped!==true||e.evidencePreserved!==true)return reject(s,'reconciliation required');
    if(s.epoch===e.epoch)return reject(s,'new fencing epoch required');
    return accept({...s,epoch:e.epoch,connected:true,phase:'stopped',pending:null,stopVerified:true,evidencePreserved:true});
  }
  if(!s.connected||!scoped(s,e))return reject(s,'connection or epoch unknown');
  if(e.type==='request'){
    const p=e.permit,action=e.action;
    if(!permitOK(s,p,e.now)||!ident(e.id)||!integer(e.expectedSequence)||e.expectedSequence!==s.sequence||s.sequence>=Number.MAX_SAFE_INTEGER)return reject(s,'authorization or sequence mismatch');
    if(action==='start'){
      if(s.pending||!['stopped','paused'].includes(s.phase)||!s.stopVerified||!startOK(p))return reject(s,'start prerequisites missing');
    }else if(action==='pause'){
      if(s.pending||s.phase!=='running')return reject(s,'not running');
    }else if(action==='stop'){
      // Stop must remain available when budget/dispatch authorization lapses.
      if(s.phase==='stop_requested'||(s.phase==='stopped'&&s.stopVerified))return reject(s,'already requested or stopped');
      if(!['starting','running','pause_requested','paused','unknown','failed'].includes(s.phase))return reject(s,'invalid stop state');
    }else return reject(s,'unknown action');
    const sequence=s.sequence+1;
    const pending={id:e.id,sequence,action};
    const phase={start:'starting',pause:'pause_requested',stop:'stop_requested'}[action];
    // This is a hypothetical command record, never an executable effect.
    return accept({...s,sequence,pending,phase,stopVerified:false,evidencePreserved:null},{...pending,repository:s.repository,epoch:s.epoch,simulationOnly:true});
  }
  if(e.type==='ack'){
    const p=s.pending;
    if(!p||e.id!==p.id||e.sequence!==p.sequence||e.hostConfirmed!==true)return reject(s,'unmatched acknowledgement');
    if(e.outcome==='failed')return accept({...s,phase:'failed',pending:null,stopVerified:false,evidencePreserved:null});
    if(e.outcome!=='confirmed')return reject(s,'unknown acknowledgement');
    if(p.action==='start'){
      if(e.runningConfirmed!==true)return reject(s,'running not confirmed');
      return accept({...s,phase:'running',pending:null});
    }
    if(e.dispatchDisabled!==true||e.workersStopped!==true||e.evidencePreserved!==true)return reject(s,'quiescence or preservation not confirmed');
    return accept({...s,phase:p.action==='pause'?'paused':'stopped',pending:null,stopVerified:true,evidencePreserved:true});
  }
  if(e.type==='uncertain'){
    return accept({...s,phase:'unknown',connected:false,stopVerified:false,evidencePreserved:null});
  }
  return reject(s,'unknown event');
}
