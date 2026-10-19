// Checks a graded ratings file strictly and prints the pull request summary:
//   node publish.mjs <new ratings.json> <current ratings.json>
// Exits with an error, before anything is committed, if the file is not exactly a ratings file.
import {readFileSync} from 'node:fs';
import {validate,empty} from './ratings.mjs';

const [nextPath,currentPath]=process.argv.slice(2);
const next=validate(JSON.parse(readFileSync(nextPath,'utf8')));
let current;
try {current=validate(JSON.parse(readFileSync(currentPath,'utf8')));} catch {current=empty();}
const changed=Object.entries(next.models).filter(([id,entry])=>JSON.stringify(current.models[id])!==JSON.stringify(entry));
const cell=text=>String(text).replace(/[|\\`*_<>[\]]/g,'\\$&');
console.log(`Model ratings from the fixed coding tasks (${next.tasks.join(', ')}): stars from the share of tasks passed (all ⭐⭐⭐⭐⭐, 85% ⭐⭐⭐⭐, 65% ⭐⭐⭐, 40% ⭐⭐), one less for a median answer time over 45 s.\n`);
console.log('| Model | Rating | Passed | Median time |\n| --- | --- | --- | --- |');
for(const [id,entry] of changed.sort(([,a],[,b])=>b.stars-a.stars||b.passed-a.passed))
  console.log(`| ${cell(id)} | ${'⭐'.repeat(entry.stars)} | ${entry.passed}/${entry.total} | ${entry.seconds===null?'–':entry.seconds+' s'} |`);
if(!changed.length) console.log('| (no changes) | | | |');
