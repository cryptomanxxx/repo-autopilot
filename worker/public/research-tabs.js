// Navigation only: no network requests or agent actions.
export const RESEARCH_SECTIONS=Object.freeze(['overview','symphony','dare','codex','evidence','safety']);
export function researchSection(value){return RESEARCH_SECTIONS.includes(value)?value:'overview';}
export function nextResearchSection(current,key){
  const i=RESEARCH_SECTIONS.indexOf(researchSection(current)),n=RESEARCH_SECTIONS.length;
  if(key==='Home')return RESEARCH_SECTIONS[0];
  if(key==='End')return RESEARCH_SECTIONS[n-1];
  if(key==='ArrowRight')return RESEARCH_SECTIONS[(i+1)%n];
  if(key==='ArrowLeft')return RESEARCH_SECTIONS[(i+n-1)%n];
  return null;
}
export function initResearchTabs({onChange=()=>{}}={}){
  const $=id=>document.getElementById(id);
  let current='overview';
  function select(value,{focus=false}={}){
    const next=researchSection(value),previous=current;
    current=next;
    for(const name of RESEARCH_SECTIONS){
      const selected=name===next,button=$('research-tab-'+name);
      button.setAttribute('aria-selected',String(selected));
      button.tabIndex=selected?0:-1;
      $('research-panel-'+name).hidden=!selected;
    }
    if(focus)$('research-tab-'+next).focus();
    if(previous!==next)onChange(next,previous);
  }
  for(const name of RESEARCH_SECTIONS){
    const button=$('research-tab-'+name);
    button.addEventListener('click',()=>select(name));
    button.addEventListener('keydown',event=>{
      const next=nextResearchSection(name,event.key);
      if(next!==null){event.preventDefault();select(next,{focus:true});}
    });
  }
  select('overview');
  return {select,current:()=>current};
}
