import {readFile} from 'node:fs/promises';
import {runAgent} from '../src/agent.js';
const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
await runAgent({repository:process.env.GITHUB_REPOSITORY,issueNumber:event.issue?.number,expectedTask:event.issue,authorizedUser:process.env.AUTOPILOT_TASK_USER,token:process.env.GITHUB_TOKEN,groqKey:process.env.GROQ_API_KEY});
