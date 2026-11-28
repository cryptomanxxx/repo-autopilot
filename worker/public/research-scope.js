// Browser lifecycle guard, not a server authorization boundary.
// Exact repository identity plus generation prevents A -> B -> A races.
export function createResearchScope(){
 let generation=0,repository=null;
 return Object.freeze({
  select(next){generation++;repository=typeof next==='string'&&next?next:null;},
  clear(){generation++;repository=null;},
  capture(){return Object.freeze({generation,repository});},
  accepts(ticket,current){return repository!==null&&ticket?.generation===generation&&ticket.repository===repository&&current===repository;}
 });
}
