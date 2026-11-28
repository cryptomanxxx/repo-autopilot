import {normalizeSymphonyState,SYMPHONY_REVISION} from './symphony-state.js';
const $=id=>document.getElementById(id);
const el=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;if(cls)n.className=cls;return n;};
export function symphonyMetrics(model){
  const value=v=>v===null||v===undefined?'Unknown':String(v);
  return [['Running sessions',value(model?.running)],['Retrying tasks',value(model?.retrying)],['Blocked tasks',value(model?.blocked)],['Total queued tasks','Unknown'],['Failed tasks','Unknown'],['Aggregate session runtime (seconds)',value(model?.totals?.aggregateRuntimeSeconds)],['Input tokens',value(model?.totals?.inputTokens)],['Output tokens',value(model?.totals?.outputTokens)],['Total tokens',value(model?.totals?.totalTokens)],['Remaining account quota','Unknown'],['Actual additional monetary cost','Unknown']];
}
export function renderSymphony(container,model,repository,now=Date.now()){
  container.replaceChildren();
  container.append(el('p','NOT CONNECTED — no live agent status or control.','dare-warning'));
  if(model){
    container.append(el('p','LOCAL SNAPSHOT — source, revision and repository scope unverified. Selected repository: '+repository+'. The file does not establish a connection to this repository.','dare-warning'),
      el('p','Reported generation: '+model.generatedAt+' · Local inspection: '+model.inspectedAt,'small'));
    const age=now-Date.parse(model.generatedAt);
    container.append(el('p',age<0?'Clock mismatch — snapshot age unknown.':age>=180000?'Historical snapshot (at least 3 minutes old).':'Historical snapshot (less than 3 minutes old at this display).','muted small'));
    if(model.state==='unavailable')container.append(el('p','Reported snapshot unavailable: '+model.reason,'dare-warning'));
    else container.append(el('p','Reported rate-limit payload: '+(model.rateLimitPayloadPresent?'present, not interpreted':'absent')+'. This does not verify quota or cost.','small'));
  }
  const grid=el('div',undefined,'research-grid');
  for(const [label,value] of symphonyMetrics(model)){
    const card=el('div',undefined,'research-tile');card.append(el('span',label),el('strong',value));grid.append(card);
  }
  container.append(grid,el('p','Retries include normal continuations. Session runtime is cumulative, not wall-clock elapsed time. Zero running sessions does not confirm a stop.','muted small'));
}
let generation=0,selected=()=>'',active=()=>false,model=null;
export function clearSymphony(){
  generation++;model=null;
  $('symphony-file').value='';
  $('symphony-ack').checked=false;
  $('symphony-message').textContent='No local snapshot loaded.';
  renderSymphony($('symphony-result'),null,'');
}
export function refreshSymphony(){renderSymphony($('symphony-result'),model,selected());}
export function initSymphony({repository,isActive}){
  selected=repository;active=isActive;
  $('symphony-clear').onclick=clearSymphony;
  $('symphony-file').onchange=async()=>{
    const version=++generation,repo=selected(),file=$('symphony-file').files?.[0];
    model=null;refreshSymphony();$('symphony-message').textContent='No local snapshot loaded.';
    if(!file||!active())return;
    if(!$('symphony-ack').checked){$('symphony-file').value='';$('symphony-message').textContent='Confirm local inspection first.';return;}
    if(file.size<1||file.size>262144){$('symphony-message').textContent='Invalid file size (maximum 256 KiB).';return;}
    try{
      const normalized=normalizeSymphonyState(new Uint8Array(await file.arrayBuffer()),{upstreamRevision:SYMPHONY_REVISION});
      if(version!==generation||repo!==selected()||!active())return;
      model=normalized;refreshSymphony();$('symphony-message').textContent='Local snapshot inspected. No network request or agent action.';
    }catch{
      if(version===generation&&repo===selected()&&active())$('symphony-message').textContent='Invalid or unsupported Symphony snapshot.';
    }
  };
  $('symphony-ack').onchange=()=>{if(!$('symphony-ack').checked)clearSymphony();};
  clearSymphony();
}
