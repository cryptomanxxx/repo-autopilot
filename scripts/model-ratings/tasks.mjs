// The fixed coding tasks of the model rating run. Each task asks for an answer in a set format and
// grades it automatically against known results; no model judges another. Code a model writes runs
// only in sandbox() below, in the grading job, which holds no lease and no write token.
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';

// With MODEL_SANDBOX=isolated (the workflow sets it) each run is also put behind an OS boundary: its
// own network namespace with no network, as the unprivileged user nobody, so it can neither reach
// anything nor write the checkout or the ratings being graded.
const ISOLATED=['/usr/bin/unshare','--net','--','/usr/bin/setpriv','--reuid=65534','--regid=65534','--clear-groups','--no-new-privs'];
const isolation=()=>process.env.MODEL_SANDBOX!=='isolated'?[]:process.getuid?.()===0?ISOLATED:['/usr/bin/sudo','-n',...ISOLATED];

// Runs a model's code in a separate Node process (no environment variables, no file or child-process
// access, a time limit) and inside it in a fresh JavaScript realm that has no process, require or
// stdout. Each check is an expression evaluated in that realm, and only a primitive result equal to
// the expected value passes, so model code cannot reach or rewrite the harness that reports.
export function sandbox(code,checks) {
  const nonce=randomBytes(12).toString('hex');
  const script=`const vm=require('node:vm'),{writeSync}=require('node:fs');
const ctx=vm.createContext(Object.create(null)),run=source=>vm.runInContext(source,ctx,{timeout:3000});
let ok=false;
try {run(${JSON.stringify(code)});ok=${JSON.stringify(checks)}.every(([check,expected])=>run(check)===expected);} catch {}
writeSync(1,${JSON.stringify(nonce)}+':'+ok+'\\n');
process.exit(0);
`;
  const [command,...args]=[...isolation(),process.execPath,'--permission','-'];
  const result=spawnSync(command,args,{input:script,env:{},timeout:15000,maxBuffer:1<<20,encoding:'utf8'});
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
// The last non-empty line of the answer, without code fences or backticks.
const lastLine=answer=>codeBlock(answer).split('\n').map(line=>line.trim().replace(/^`|`$/g,'')).filter(Boolean).at(-1);
// Model code is run as a plain script, so ES module exports become plain declarations.
const script=code=>code.replace(/^\s*export\s+(default\s+)?/gm,'');

// Applies SEARCH/REPLACE edits to a file: every SEARCH text must occur exactly once at that point.
// Null if the answer has no edit, or one does not apply.
export function applyEdits(file,answer) {
  const blocks=[...visible(answer).replace(/\r\n/g,'\n').matchAll(/<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g)];
  if(!blocks.length) return null;
  let text=file;
  for(const [,search,replace] of blocks) {
    if(!search||text.split(search).length!==2) return null;
    text=text.replace(search,()=>replace);
  }
  return {text,count:blocks.length};
}
// Code compared as text: whitespace outside string literals, trailing commas and digit separators
// are ignored, and '…' and "…" count alike, but the contents of every string and template literal
// must match exactly.
function normal(text) {
  let out='';
  for(let i=0;i<text.length;) {
    const quote=text[i];
    if(quote==="'"||quote==='"'||quote==='`') {
      let j=i+1;
      while(j<text.length&&text[j]!==quote) j+=text[j]==='\\'?2:1;
      const body=text.slice(i+1,j);
      out+=quote!=='`'&&!/['"\\]/.test(body)?`'${body}'`:quote+body+quote;
      i=j+1;
    } else {
      if(!/\s/.test(quote)) out+=quote;
      i++;
    }
  }
  return out.replace(/,([}\]])/g,'$1').replace(/(\d)_(?=\d)/g,'$1');
}

const PLANS=`export const limits = {
  maxUsers: 10,
  maxProjects: 5,
};

export function describe(plan) {
  return \`\${plan.name}: \${plan.users} users\`;
}
`;
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
    grade:answer=>sandbox(script(codeBlock(answer)),[['median([3,1,2])',2],['median([10,2,1,4])',3],['median([-5,10,1])',1],
      ['median([1.5])',1.5],['median([100,20,3,4])',12],
      ['(()=>{const a=[10,2,1,4];median(a);return a.length===4&&a[0]===10&&a[1]===2&&a[2]===1&&a[3]===4;})()',true]])
  },
  {
    id:'implement',
    prompt:`Write a JavaScript function parseDuration(text) that converts a duration such as "1h30m", "45s" or "2h5m10s" to a number of seconds. The units h, m and s may each appear at most once, in that order, each with a whole number; at least one must be present. For anything else (for example "", "90", "1x", "1m1h", "1h 30m" or a non-string) it returns null.

Reply with only the function in one \`\`\`js code block.`,
    grade:answer=>sandbox(script(codeBlock(answer)),[['1h30m',5400],['45s',45],['2h5m10s',7510],['0m',0],['10m5s',605],
      ['',null],['90',null],['1x',null],['1m1h',null],['1h 30m',null],['h',null],['1h1h',null],[null,null],[42,null]]
      .map(([input,expected])=>[`parseDuration(${JSON.stringify(input)})`,expected]))
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
      const edited=applyEdits(CONFIG,answer);
      return edited?.count===1&&normal(edited.text)===normal(`export const config = {retries: 3, timeoutMs: 10000, region: 'eu-west-1', verbose: false};`);
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
    grade:answer=>lastLine(answer)==='333|1,10,3'
  },
  // The harder tasks: several bugs at once, a parser full of edge cases, the event loop and an edit
  // in two places.
  {
    id:'bugfix-deep',
    prompt:`This JavaScript function should compare two values deeply: primitives, plain objects and arrays. NaN equals NaN, null equals only null, an array never equals a non-array, and two objects are equal only with exactly the same keys and deeply equal values. It has several bugs:

\`\`\`js
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  for (const key of keys) if (!deepEqual(a[key], b[key])) return false;
  return true;
}
\`\`\`

Fix every bug. Reply with only the corrected function, named deepEqual, in one \`\`\`js code block.`,
    grade:answer=>sandbox(script(codeBlock(answer)),[
      ['deepEqual({a:[1,{b:NaN}],c:"x"},{c:"x",a:[1,{b:NaN}]})',true],['deepEqual(NaN,NaN)',true],['deepEqual(null,null)',true],
      ['deepEqual([1,[2,3]],[1,[2,3]])',true],['deepEqual(null,{})',false],['deepEqual({},null)',false],['deepEqual({a:1},{a:1,b:2})',false],
      ['deepEqual([],{})',false],['deepEqual({0:1,length:1},[1])',false],['deepEqual({a:undefined},{b:undefined})',false],
      ['deepEqual(0,"0")',false],['deepEqual([1,2],[2,1])',false],['deepEqual({x:{y:null}},{x:{y:{}}})',false]])
  },
  {
    id:'implement-csv',
    prompt:`Write a JavaScript function parseCsvLine(line) that splits one CSV line into an array of strings. Fields are separated by commas. A field may be wrapped in double quotes; inside quotes a comma is part of the field and two double quotes ("") stand for one double quote. A closing quote must be followed by a comma or the end of the line. Unquoted fields are taken as they are, spaces included. An empty line is one empty field. Return null for an unterminated quote, for anything other than a comma or the end after a closing quote, or if the input is not a string.

Examples: 'a,b' gives ["a","b"]; '"x, y",z' gives ["x, y","z"]; 'a,,' gives ["a","",""].

Reply with only the function in one \`\`\`js code block.`,
    grade:answer=>sandbox(script(codeBlock(answer)),[
      ['a,b',['a','b']],['"x, y",z',['x, y','z']],['a,,',['a','','']],['',['']],['"he said ""hi""",2',['he said "hi"','2']],
      ['""',['']],[' a , b ',[' a ',' b ']],['"a,b","c"',['a,b','c']],['x,"",y',['x','','y']],
      ['"open',null],['"a"b',null],['a,"b',null],[42,null]]
      .map(([input,expected])=>[`JSON.stringify(parseCsvLine(${JSON.stringify(input)}))`,JSON.stringify(expected)]))
  },
  {
    id:'reading-async',
    prompt:`What does this JavaScript print when run with Node.js?

\`\`\`js
const log = [];
setTimeout(() => log.push('t'), 0);
Promise.resolve().then(() => log.push('p1')).then(() => log.push('p2'));
queueMicrotask(() => log.push('m'));
(async () => { log.push('a'); await null; log.push('b'); })();
log.push('s');
setTimeout(() => console.log(log.join(',')), 1);
\`\`\`

Reply with only the exact output.`,
    grade:answer=>lastLine(answer)==='a,s,p1,m,b,p2,t'
  },
  {
    id:'edit-multi',
    prompt:`The file plans.js contains:

\`\`\`js
${PLANS}\`\`\`

Make two changes: raise maxUsers to 25, and make describe() also mention the projects, so that it returns for example "Team: 4 users, 2 projects". Reply with only SEARCH/REPLACE edits in this format, one block per change, copying the SEARCH lines exactly from the file:

<<<<<<< SEARCH
(lines copied exactly from the file)
=======
(the new lines)
>>>>>>> REPLACE`,
    grade:answer=>{
      // Two blocks, each making exactly one of the changes on its own.
      const blocks=[...visible(answer).replace(/\r\n/g,'\n').matchAll(/<<<<<<< SEARCH\n[\s\S]*?\n>>>>>>> REPLACE/g)].map(m=>m[0]);
      const users=PLANS.replace('maxUsers: 10','maxUsers: 25'),projects=PLANS.replace('${plan.users} users`','${plan.users} users, ${plan.projects} projects`');
      const one=(block,expected)=>{const edited=applyEdits(PLANS,block);return !!edited&&normal(edited.text)===normal(expected);};
      const edited=applyEdits(PLANS,answer);
      return blocks.length===2&&!!edited&&normal(edited.text)===normal(users.replace('${plan.users} users`','${plan.users} users, ${plan.projects} projects`'))&&
        (one(blocks[0],users)&&one(blocks[1],projects)||one(blocks[0],projects)&&one(blocks[1],users));
    }
  }
]);
export const SYSTEM='You are a careful senior software engineer. Answer in exactly the format the task asks for.';
