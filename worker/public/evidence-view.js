// Documentary inventory only; input is the validated local DARE view model.
export function evidenceInventory(model){
  if(!model)return null;
  const paths=new Map(),missing=[],acceptance={not_assessed:0,accepted:0,rejected:0,unknown:0};
  let references=0;
  for(const phase of model.status.phases){
    acceptance[phase.scientificAcceptance]++;
    if(!phase.evidence.length)missing.push(phase.id);
    for(const entry of phase.evidence){
      references++;
      if(!paths.has(entry.path))paths.set(entry.path,{path:entry.path,phases:new Set(),kinds:new Set(),statuses:new Set(),references:0});
      const row=paths.get(entry.path);
      row.phases.add(phase.id);row.kinds.add(entry.kind);row.statuses.add(entry.status);row.references++;
    }
  }
  const counts={documented:0,reported:0,superseded:0,unverified:0,independently_verified:0,conflicting:0};
  const rows=[...paths.values()].map(row=>{
    const statuses=[...row.statuses].sort(),kinds=[...row.kinds].sort();
    const conflict=statuses.length>1||kinds.length>1;
    const classification=conflict?'conflicting':statuses[0];
    counts[classification]++;
    return {path:row.path,phases:[...row.phases].sort(),statuses,kinds,references:row.references,classification};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {repository:model.status.repository,asOf:model.status.asOf,inspectedAt:model.inspectedAt,localBlobSha:model.localBlobSha,
    references,uniquePaths:rows.length,phaseCount:model.status.phases.length,missing,acceptance,counts,rows,
    sourceVerified:false,contentVerified:false,experimentSuccess:null,experimentFailure:null,archiveCompleteness:null,reproducibility:null};
}
const el=(tag,value,cls)=>{const n=document.createElement(tag);if(value!==undefined)n.textContent=value;if(cls)n.className=cls;return n;};
export function renderEvidence(container,model){
  container.replaceChildren();
  const data=evidenceInventory(model);
  if(!data){container.append(el('p','No local DARE document loaded. Import the status file in DARE to inspect its evidence references.','muted'));return;}
  container.append(el('p','LOCAL DOCUMENT — unverified source and file contents; not an archive audit.','dare-warning'),
    el('p',data.repository+' · Documentary date: '+data.asOf+' · Inspected: '+data.inspectedAt,'small'),
    el('p','Locally computed status blob: '+data.localBlobSha,'muted small'));
  const tiles=el('div',undefined,'research-grid');
  for(const [label,value] of [['Unique referenced paths',data.uniquePaths],['Reference occurrences',data.references],['Phases without references',data.missing.length+' / '+data.phaseCount],['Conflicting reference claims',data.counts.conflicting]]){
    const tile=el('div',undefined,'research-tile');tile.append(el('span',label),el('strong',String(value)));tiles.append(tile);
  }
  container.append(tiles,el('h4','Documentary status claims (unique paths)'));
  const counts=el('ul');
  for(const [status,count] of Object.entries(data.counts))counts.append(el('li',status.replaceAll('_',' ')+': '+count));
  container.append(counts,el('p','Independent verification is only a claim in this document, not a check performed by Repo Autopilot.','muted small'),
    el('p','Phases without declared references: '+(data.missing.join(', ')||'None in this document')+'. This does not establish missing archive files.'),
    el('h4','Scientific acceptance claims (phases)'));
  const acceptance=el('ul');for(const [state,count] of Object.entries(data.acceptance))acceptance.append(el('li',state.replaceAll('_',' ')+': '+count));
  container.append(acceptance,el('h4','Actual research and archive outcomes'),el('p','Successful experiments: unknown · Failed experiments: unknown · Archive completeness: unknown · Reproducibility: unknown.'));
  const label=el('label','Filter evidence claims');const select=el('select');for(const value of ['all',...Object.keys(data.counts)]){const option=el('option',value.replaceAll('_',' '));option.value=value;select.append(option);}label.append(select);
  const list=el('div',undefined,'dare-phases');
  function refresh(){
    list.replaceChildren();
    for(const row of data.rows.filter(row=>select.value==='all'||row.classification===select.value)){
      const card=el('article',undefined,'dare-phase');card.append(el('h4',row.path),el('p','Claim classification: '+row.classification),el('p','Reported statuses: '+row.statuses.join(', ')),el('p','Kinds: '+row.kinds.join(', ')),el('p','Phases: '+row.phases.join(', ')+' · References: '+row.references,'small'));list.append(card);
    }
    if(!list.childElementCount)list.append(el('p','No matching references in this document.','muted'));
  }
  select.addEventListener('change',refresh);container.append(el('h4','Evidence reference inventory'),label,list);refresh();
}
