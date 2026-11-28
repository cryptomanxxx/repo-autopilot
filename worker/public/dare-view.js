import {renderEvidence} from './evidence-view.js?v=evidence-106';
import {validateStatusShape,STATUS_PATH} from './dare-status-shape.js';

// Offline inspection only. Local file bytes and user-entered revision are not
// authenticated retrieval metadata; no source links or live status are implied.
export async function inspectLocalStatus(bytes,repository,now=Date.now()){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength<1||bytes.byteLength>65536)throw new TypeError('Invalid file size');
  const header=new TextEncoder().encode('blob '+bytes.byteLength+'\0');
  const input=new Uint8Array(header.length+bytes.length);
  input.set(header);input.set(bytes,header.length);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',input)),v=>v.toString(16).padStart(2,'0')).join('');
  // Placeholder solely for shared schema validation. Never expose as a revision
  // or claim independent blob verification from a self-computed digest.
  const validated=validateStatusShape(bytes,{selectedRepository:repository,source:{repository,path:STATUS_PATH,containingRevision:'0'.repeat(40),blobSha:digest,retrievedAt:new Date(now).toISOString()},computedBlobSha:digest});
  return {status:validated.status,localBlobSha:digest,inspectedAt:new Date(now).toISOString(),sourceVerified:false,dispatchAuthorized:false,budgetViolationReported:validated.budgetViolationReported};
}
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
export function renderDare(container,model){
  container.replaceChildren();
  if(!model)return;
  const s=model.status;
  container.append(el('p','LOCAL FILE — unverified source, not live status.','dare-warning'),
    el('p',s.repository+' · documentary date '+s.asOf+' · inspected '+model.inspectedAt,'small'),
    el('p','Claimed documentary basis: '+s.basisRevision+' · locally computed blob: '+model.localBlobSha,'muted small'),
    el('p','Execution not authorized. Additional budget: 0 SEK. Reported actual cost: '+(s.incrementalBudget.actual===null?'unknown':s.incrementalBudget.actual+' SEK')+(model.budgetViolationReported?' — reported budget violation.':'')));
  const list=el('div',undefined,'dare-phases');
  for(const p of s.phases){
    const card=el('article',undefined,'dare-phase');
    card.append(el('h4',p.id+' · '+p.title),el('p','Development: '+p.development+' · Gate claim: '+p.gate),el('p','Scientific acceptance claim: '+p.scientificAcceptance,'small'),el('p','Depends on: '+(p.dependsOn.join(', ')||'None declared'),'small'));
    if(p.blockers.length){const ul=el('ul');for(const text of p.blockers)ul.append(el('li',text));card.append(el('strong','Reported blockers'),ul);}
    if(p.evidence.length){const d=el('details');d.append(el('summary','Evidence references ('+p.evidence.length+')'));const ul=el('ul');for(const e of p.evidence)ul.append(el('li',e.path+' · '+e.kind+' · '+e.status));d.append(ul,el('p','References and status claims only; contents not verified.','muted small'));card.append(d);}
    list.append(card);
  }
  container.append(list);
}
let generation=0,selected=()=>'',active=()=>false;
const $=id=>document.getElementById(id);
export function clearDare(){
  generation++;
  $('dare-file').value='';
  $('dare-result').replaceChildren();
  renderEvidence($('evidence-result'),null);
  $('dare-message').textContent='No local status file loaded. Live connection is disabled.';
}
export function initDare({repository,isActive}){
  selected=repository;active=isActive;
  $('dare-clear').onclick=clearDare;
  $('dare-file').onchange=async()=>{
    const version=++generation,repo=selected(),file=$('dare-file').files?.[0];
    $('dare-result').replaceChildren();
  renderEvidence($('evidence-result'),null);
    $('dare-message').textContent='No local status file loaded.';
    if(!file||!active())return;
    if(file.size<1||file.size>65536){$('dare-message').textContent='Invalid file size (maximum 64 KiB).';return;}
    try{
      const model=await inspectLocalStatus(new Uint8Array(await file.arrayBuffer()),repo);
      if(version!==generation||repo!==selected()||!active())return;
      renderDare($('dare-result'),model);
      renderEvidence($('evidence-result'),model);
      $('dare-message').textContent='Local document inspected. No network request or execution authorization.';
    }catch{
      if(version===generation&&repo===selected()&&active())$('dare-message').textContent='Invalid status file or repository mismatch.';
    }
  };
  clearDare();
}
