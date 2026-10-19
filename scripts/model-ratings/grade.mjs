// Grades the collected answers and merges the results into the ratings file:
//   node grade.mjs <answers.json> <current ratings.json> <output ratings.json>
// A model that could not answer most tasks (provider errors) keeps its previous rating.
import {readFileSync,writeFileSync} from 'node:fs';
import {TASKS,sandbox} from './tasks.mjs';
import {validate,validId,stars,median,empty} from './ratings.mjs';

const [answersPath,currentPath,outPath]=process.argv.slice(2);
// A sandbox that cannot start would fail every answer and rate every model one star.
if(!sandbox('const one=1;',[['one',1]])) throw new Error('The model code sandbox does not run; nothing was graded.');
const collected=JSON.parse(readFileSync(answersPath,'utf8'));
let ratings;
try {ratings=validate(JSON.parse(readFileSync(currentPath,'utf8')));} catch {ratings=empty();}
const testedAt=new Date().toISOString().slice(0,10);
for(const model of Array.isArray(collected?.models)?collected.models:[]) {
  if(!validId(model?.id)||!Array.isArray(model.answers)) continue;
  const answers=new Map(model.answers.map(a=>[a?.task,a]));
  const ok=TASKS.map(task=>answers.get(task.id)).filter(a=>a?.status==='ok'&&typeof a.text==='string');
  if(ok.length<3) {console.log(`${model.id}: not rated (${TASKS.length-ok.length} provider errors)`);continue;}
  const passed=TASKS.filter(task=>{const a=answers.get(task.id);return a?.status==='ok'&&typeof a.text==='string'&&task.grade(a.text);});
  const seconds=median(ok.map(a=>a.seconds).filter(s=>typeof s==='number'&&Number.isFinite(s)&&s>=0&&s<=600));
  ratings.models[model.id]={stars:stars(passed.length,seconds),passed:passed.length,total:TASKS.length,seconds,testedAt};
  console.log(`${model.id}: ${'⭐'.repeat(ratings.models[model.id].stars)} passed ${passed.map(t=>t.id).join(', ')||'none'}; median ${seconds}s`);
}
ratings.models=Object.fromEntries(Object.entries(ratings.models).sort(([a],[b])=>a.localeCompare(b)));
writeFileSync(outPath,JSON.stringify(validate(ratings),null,2)+'\n');
