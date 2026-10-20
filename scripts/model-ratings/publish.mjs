// Checks the graded ratings strictly and prints the run summary:
//   node publish.mjs <ratings.json>
// Exits with an error, before anything is sent to the gateway, if the file is not exactly a ratings file.
import {readFileSync} from 'node:fs';
import {validate} from './ratings.mjs';

const [path]=process.argv.slice(2);
const next=validate(JSON.parse(readFileSync(path,'utf8')));
const cell=text=>String(text).replace(/[|\\`*_<>[\]]/g,'\\$&');
console.log(`Model ratings from the fixed coding tasks (${next.tasks.join(', ')}): stars from the share of tasks passed (all ⭐⭐⭐⭐⭐, 85% ⭐⭐⭐⭐, 65% ⭐⭐⭐, 40% ⭐⭐), one less for a median answer time over 45 s.\n`);
console.log('| Model | Rating | Passed | Median time |\n| --- | --- | --- | --- |');
for(const [id,entry] of Object.entries(next.models).sort(([,a],[,b])=>b.stars-a.stars||b.passed-a.passed))
  console.log(`| ${cell(id)} | ${'⭐'.repeat(entry.stars)} | ${entry.passed}/${entry.total} | ${entry.seconds===null?'–':entry.seconds+' s'} |`);
if(!Object.keys(next.models).length) console.log('| (no model rated in this run) | | | |');
