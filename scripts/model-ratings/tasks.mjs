// The fixed coding tasks of the model rating run. Each task asks for an answer in a set format and
// grades it automatically against known results; no model judges another. Code a model writes runs
// only in sandbox() below, in the grading job, which holds no lease and no write token.
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';

// Runs a model's code with the tests in a separate Node process: no environment variables, no file
// or child-process access (Node's permission model) and a time limit. True only if the tests ran to
// the end and passed.
export function sandbox(code,tests) {
  const nonce=randomBytes(12).toString('hex');
  const script=`${code}\n;(async()=>{const ok=await (async()=>{${tests}})();console.log(${JSON.stringify(nonce)}+':'+(ok===true));})().catch(()=>{});\n`;
  const result=spawnSync(process.execPath,['--permission','-'],{input:script,env:{},timeout:10000,maxBuffer:1<<20,encoding:'utf8'});
  if(result.status!==0||typeof result.stdout!=='string') return false;
  return result.stdout.trim().split('\n').at(-1)===nonce+':true';
}

// The answer text without a reasoning model's <think> section.
export const visible=text=>String(text??'').replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/^[\s\S]*<\/think>/i,'').trim();
// The first fenced code block, or the whole answer if it has none.
export function codeBlock(text) {
  const match=/```[a-zA-Z]*[^\S\n]*\n([\s\S]*?)```/.exec(visible(text));
  return (match?match[1]:visible(text)).trim();
}
// Model code is run as a plain script, so ES module exports become plain declarations.
const script=code=>code.replace(/^\s*export\s+(default\s+)?/gm,'');

const CONFIG=`export const config = {
  retries: 3,
  timeoutMs: 5000,
  verbose: false,
};
`;
const DIFF=`diff --git a/src/app.js b/src/app.js
--- a/src/app.js
+++ b/src/app.js
@@ -1,4 +1,5 @@
 import {start} from './server.js';
-start(8080);
+const port = Number(process.env.PORT) || 8080;
+start(port);
 console.log('ready');
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -3,3 +3,2 @@
 Run \`npm start\`.
-The port is fixed.
-Edit src/app.js to change it.
+Set PORT to change the port.
diff --git a/test/app.test.js b/test/app.test.js
--- a/test/app.test.js
+++ b/test/app.test.js
@@ -10,2 +10,3 @@
 test('starts', () => {});
+test('reads PORT', () => {});
`;

export const TASKS=Object.freeze([
  {
    id:'bugfix',
    prompt:`This JavaScript function should return the median of an array of numbers without changing the array, but it has bugs:

\`\`\`js
function median(values) {
  const sorted = values.sort();
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid] + sorted[mid + 1]) / 2;
}
\`\`\`

Fix every bug. Reply with only the corrected function, named median, in one \`\`\`js code block.`,
    grade:answer=>sandbox(script(codeBlock(answer)),`
      const input=[10,2,1,4];
      return median([3,1,2])===2 && median(input)===3 && input.join()==='10,2,1,4' &&
        median([-5,10,1])===1 && median([1.5])===1.5 && median([100,20,3,4])===12;`)
  },
  {
    id:'implement',
    prompt:`Write a JavaScript function parseDuration(text) that converts a duration such as "1h30m", "45s" or "2h5m10s" to a number of seconds. The units h, m and s may each appear at most once, in that order, each with a whole number; at least one must be present. For anything else (for example "", "90", "1x", "1m1h", "1h 30m" or a non-string) it returns null.

Reply with only the function in one \`\`\`js code block.`,
    grade:answer=>sandbox(script(codeBlock(answer)),`
      const cases=[['1h30m',5400],['45s',45],['2h5m10s',7510],['0m',0],['10m5s',605],
        ['',null],['90',null],['1x',null],['1m1h',null],['1h 30m',null],['h',null],['1h1h',null],[null,null],[42,null]];
      return cases.every(([input,expected])=>parseDuration(input)===expected);`)
  },
  {
    id:'edit',
    prompt:`The file config.js contains:

\`\`\`js
${CONFIG}\`\`\`

Change the timeout to 10000 ms and add the entry region: 'eu-west-1' directly after it. Reply with exactly one edit in this format and nothing else:

<<<<<<< SEARCH
(lines copied exactly from the file)
=======
(the new lines)
>>>>>>> REPLACE`,
    grade:answer=>{
      const match=/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/.exec(visible(answer).replace(/\r\n/g,'\n'));
      if(!match||!match[1]||CONFIG.split(match[1]).length!==2) return false;
      const edited=CONFIG.replace(match[1],()=>match[2]);
      return sandbox(script(edited),`return JSON.stringify(config)===JSON.stringify({retries:3,timeoutMs:10000,region:'eu-west-1',verbose:false});`);
    }
  },
  {
    id:'json',
    prompt:`Read this diff:

\`\`\`diff
${DIFF}\`\`\`

Reply with only a JSON object, no other text: {"files": [the changed file paths, sorted alphabetically], "added": the number of added lines, "removed": the number of removed lines}.`,
    grade:answer=>{
      try {
        const value=JSON.parse(codeBlock(answer));
        return JSON.stringify(value)===JSON.stringify({files:['README.md','src/app.js','test/app.test.js'],added:4,removed:3});
      } catch {return false;}
    }
  },
  {
    id:'reading',
    prompt:`What does this JavaScript print?

\`\`\`js
const out = [];
for (var i = 0; i < 3; i++) out.push(() => i);
const xs = [10, 1, 3].sort();
console.log(out.map(g => g()).join('') + '|' + xs.join(','));
\`\`\`

Reply with only the exact output.`,
    grade:answer=>codeBlock(answer).split('\n').map(line=>line.trim().replace(/^`|`$/g,'')).filter(Boolean).at(-1)==='333|1,10,3'
  }
]);
export const SYSTEM='You are a careful senior software engineer. Answer in exactly the format the task asks for.';
