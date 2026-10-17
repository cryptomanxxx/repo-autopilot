// The connector's tools. They only read: the same data the dashboard shows, through the same cache, with
// the GitHub sign-in of the connected app.
import {findingStatus,FINDING_STATES} from '../public/dashboard-view.js';
import {PublicError} from './errors.js';
import {CARD_TOOL_META} from './card.js';
import {createGitHub} from '../../src/github.js';
import {FINDING_TEXT_CUT} from '../../src/progress.js';

// At most this many pull requests are loaded from GitHub in one list call; the rest come from the cache
// or are marked as not loaded, so a call stays within the Workers subrequest limit.
export const FRESH_DETAILS=2;
const READ_ONLY={readOnlyHint:true,openWorldHint:false};
// Asking again with fresh reads GitHub instead of the cache, as the card's Refresh does. CI changes, for
// example, do not change a pull request's update time, which keys the cache.
const FRESH={type:'boolean',description:'Read GitHub again instead of the cached data. Only when the user asks for an update.'};
// Some chat apps send the flag as text ("true"), for example when they hold an older copy of the tool list;
// that is read the same as the boolean.
const freshOf=args=>{
  const text=typeof args.fresh==='string'?args.fresh.trim().toLowerCase():null;
  const value=text==='true'?true:text==='false'?false:args.fresh;
  if(value!==undefined&&typeof value!=='boolean') throw Object.assign(new Error('fresh must be true or false.'),{expose:true});
  return value===true;
};
const REPOSITORY={type:'string',description:'Repository as owner/name, for example "octocat/hello-world". Defaults to the Repo Autopilot repository itself.'};

// "unknown" CI after a failed read of the checks means they could not be read, not that there are none.
const ciText=(ci,failed)=>ci==='unknown'&&failed?'unavailable (could not be read)':({success:'passed',failure:'failed',pending:'running',unknown:'no checks reported'})[ci]||ci;
// A CI state read from a capped list of checks may miss a failing or pending one; it is not reported as final.
const ciLabel=(ci,{available,complete})=>`${ciText(ci,!available)}${available&&!complete?' (not verified as complete)':''}`;
const short=sha=>sha?String(sha).slice(0,7):'';
const exposed=message=>Object.assign(new Error(message),{expose:true});
const indent=(text,prefix='    ')=>String(text).split('\n').map(line=>prefix+line).join('\n');
// What a pull request waits on, from its merge readiness: something to fix, a merge, or others (CI, Codex,
// a reviewer). The dashboard's own reasons decide it.
const FIX_REASONS=['Merge conflict','CI failed','Codex findings need attention','Unresolved review conversations','A reviewer requested changes'];
const nextStep=pr=>pr.draft?'draft':pr.readiness?.state==='ready'?'merge':(pr.readiness?.reasons||[]).some(r=>FIX_REASONS.includes(r))?'fix':'wait';
// How many repositories the attention list reads in one call, so one call stays within the Workers
// subrequest limit; they are the most recently pushed ones.
export const ATTENTION_REPOS=6;
function findingLines(item) {
  const clearedAt=item.codex?.state==='clear'?item.codex.clearedAt:null;
  const findings=(item.progress?.findings?.items||[]).map(f=>({...f,status:findingStatus(f,{clearedAt})}));
  findings.sort((a,b)=>FINDING_STATES[a.status.state].order-FINDING_STATES[b.status.state].order||Date.parse(b.at)-Date.parse(a.at));
  return findings;
}
function findingCounts(findings) {
  const count=state=>findings.filter(f=>f.status.state===state).length;
  return {open:count('open'),waiting:count('changed'),unverified:count('unverified'),fixed:count('fixed')};
}
const countsText=c=>[`${c.open} open`,c.waiting&&`${c.waiting} waiting for Codex`,c.unverified&&`${c.unverified} unverified`,c.fixed&&`${c.fixed} fixed`].filter(Boolean).join(' · ');

// One pull request as the tools report it: what the dashboard row and its details show.
export function pullSummary(item) {
  // Without loaded findings (a GitHub request failed), the findings are unknown, not absent.
  const available=Boolean(item.progress?.findings);
  const findings=available?findingLines(item):[];
  return {
    number:item.number,title:item.title,url:item.url,state:item.state,draft:Boolean(item.draft),headSha:item.headSha,updatedAt:item.updatedAt,mergedAt:item.mergedAt||null,
    readiness:{state:item.readiness?.state,label:item.readiness?.label,reasons:item.readiness?.reasons||[]},
    // Checks and findings are read in the same GitHub batch, so loaded findings mean the checks were read too;
    // a later failure (such as the merge verification) leaves a read CI state as it is.
    ci:item.ci,ciAvailable:available,ciComplete:available&&item.checksComplete!==false,codex:{state:item.codex?.state,label:item.codex?.label},
    findings:findings.map(f=>({priority:f.priority,title:f.title,path:f.path,line:f.line,url:f.url,commit:f.commit||null,current:f.current,state:f.status.state,why:f.status.why||null})),
    findingsAvailable:available,findingCounts:available?findingCounts(findings):null,findingsIncomplete:Boolean(item.progress?.findings?.incomplete),
    activity:(item.progress?.events||[]).slice(-10).map(e=>({kind:e.kind,label:e.label,at:e.at,commit:e.commit||null})),
    // A history cut off at GitHub's page size may miss the newest events; that is said, not hidden.
    activityIncomplete:Boolean(item.progress?.truncated||item.progress?.findings?.incomplete),warnings:item.warnings||[],
    detailError:item.detailError||null,
  };
}
function statusText(repository,s) {
  const lines=[`${repository} #${s.number} ${s.title} (${s.state}${s.draft?', draft':''})`,`GitHub: ${s.url}`,`Dashboard: ${s.dashboardUrl}`,'',`Merge: ${s.readiness.label}`];
  for(const reason of s.readiness.reasons) lines.push(`  - ${reason}`);
  lines.push(`CI: ${ciLabel(s.ci,{available:s.ciAvailable,complete:s.ciComplete})}`,`Codex: ${s.codex.label}`);
  const version=f=>f.current?'current code':f.commit?`older commit ${short(f.commit)}`:'commit unknown';
  if(!s.findingsAvailable) lines.push('Codex findings: unknown, the details could not be read from GitHub');
  else if(s.findings.length) {
    lines.push(`Codex findings: ${countsText(s.findingCounts)}${s.findingsIncomplete?' (list may be incomplete)':''}`);
    for(const f of s.findings) lines.push(`  ${FINDING_STATES[f.state].icon} ${f.priority} ${f.title} (${f.path?`${f.path}${f.line?`:${f.line}`:''}`:'location unknown'}; ${version(f)}; ${FINDING_STATES[f.state].label}${f.why?`: ${f.why}`:''}) ${f.url||''}`.trimEnd());
  } else lines.push(s.findingsIncomplete?'Codex findings: none found, but the list may be incomplete (the history is longer than one GitHub page)':'Codex findings: none');
  if(s.activity.length) {
    lines.push(`Recent activity${s.activityIncomplete?' (may be incomplete: the history is longer than one GitHub page)':''}:`);
    for(const e of s.activity) lines.push(`  ${e.at.slice(0,16).replace('T',' ')} ${e.label}${e.commit?` (${short(e.commit)})`:''}`);
  }
  for(const warning of s.warnings) lines.push('',`Note: ${warning}`);
  if(s.detailError) lines.push('',`Some details could not be read: ${s.detailError}`);
  lines.push('',`Merging happens in the Repo Autopilot dashboard: ${s.dashboardUrl}`);
  return lines.join('\n');
}

export function connectorTools({store,fetchImpl,config,readRepos,resolveRepository,dashboardData,pullLimit,runStep=15,runMax=60}) {
  const access=(token,grantId)=>({store,session:{token},hash:`grant:${grantId}`,config,fetchImpl});
  // The pull request in this Worker's dashboard, where it can be merged: the dashboard opens the repository
  // and the pull request named in the link.
  const dashboardUrl=(repository,number)=>`${config.origin}/?repo=${encodeURIComponent(repository)}#pr-${number}`;
  const repositoryOf=async(args,token,grantId)=>{
    if(args.repository!==undefined&&typeof args.repository!=='string') throw Object.assign(new Error('repository must be a string like "owner/name".'),{expose:true});
    return resolveRepository(args.repository,access(token,grantId));
  };
  return [{
    name:'list_repositories',title:'List repositories',
    description:'Lists the repositories Repo Autopilot can read: those where its GitHub App is installed, most recently pushed first.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},
    annotations:READ_ONLY,
    run:async(args,{token,grantId})=>{
      const {list:repositories,truncated}=await readRepos(access(token,grantId));
      // A list cut off at the limits says so, so a missing repository is not taken to be absent.
      const note=truncated?'\n\nThis list may be incomplete: Repo Autopilot reads up to 5 GitHub App installations and 200 repositories each.':'';
      const text=(repositories.length?repositories.map(r=>`${r.fullName}${r.private?' (private)':''}`).join('\n'):'No repositories yet: install the Repo Autopilot GitHub App on the ones you want to see.')+note;
      return {content:[{type:'text',text}],structuredContent:{repositories,truncated}};
    },
  },{
    name:'list_pull_requests',title:'List pull requests',
    description:`Lists the ${pullLimit} most recently updated pull requests of a repository, as the Repo Autopilot dashboard shows them: merge readiness, CI, Codex review status and Codex findings. Older pull requests are not listed; use pull_request_status with a number for any pull request, and for the full details of one.`,
    inputSchema:{type:'object',properties:{repository:REPOSITORY,fresh:FRESH},additionalProperties:false},
    annotations:READ_ONLY,_meta:CARD_TOOL_META,
    run:async(args,{token,grantId})=>{
      const reload=freshOf(args);
      const repository=await repositoryOf(args,token,grantId);
      const overview=await dashboardData({store,token,fetchImpl,repository,fresh:reload});
      let fresh=0;
      const pulls=[];
      for(const pr of overview.pulls) {
        // One pull request that cannot be read does not take the whole list down; it is listed as not loaded.
        let item=null,error=null;
        try {
          // Open pull requests matter most, so they are loaded from GitHub first, within the budget; a fresh
          // list reloads them, within the same budget, and takes the rest from the cache.
          const again=reload&&pr.state==='open'&&fresh<FRESH_DETAILS;
          item=again?null:await dashboardData({store,token,fetchImpl,repository,number:pr.number,updated:pr.updatedAt,cachedOnly:true});
          if(!item&&pr.state==='open'&&fresh<FRESH_DETAILS) {fresh++;item=await dashboardData({store,token,fetchImpl,repository,number:pr.number,updated:pr.updatedAt,fresh:again});}
        } catch(failure) {
          // Only owner-facing GitHub failures are isolated; a 401 or an internal error reaches the handler.
          if(failure?.status===401||!(failure instanceof PublicError||failure?.expose)) throw failure;
          error=failure.message;
        }
        pulls.push({...(item?pullSummary(item):{number:pr.number,title:pr.title,url:pr.url,state:pr.state,updatedAt:pr.updatedAt,detailsLoaded:false,error}),dashboardUrl:dashboardUrl(repository,pr.number)});
      }
      // The overview reads a fixed number of the most recently updated pull requests; older ones are not in it.
      const mayHaveMore=overview.pulls.length>=pullLimit;
      const lines=[`${repository}: the ${pulls.length} most recently updated pull requests`,`Dashboard, where pull requests are merged: ${config.origin}/?repo=${encodeURIComponent(repository)}#dashboard`];
      if(mayHaveMore) lines.push('Older pull requests are not listed and may include open ones; use pull_request_status with a number to see one.');
      for(const p of pulls) {
        if(p.detailsLoaded===false) {lines.push(`#${p.number} ${p.title} (${p.state}): ${p.error?`details could not be read (${p.error})`:'details not loaded'}; ask for pull_request_status · dashboard ${p.dashboardUrl}`);continue;}
        const parts=[p.state,p.readiness.label,`CI ${ciLabel(p.ci,{available:p.ciAvailable,complete:p.ciComplete})}`,p.codex.label];
        if(!p.findingsAvailable) parts.push('findings unknown');
        else if(p.findings.length) parts.push(`findings ${countsText(p.findingCounts)}${p.findingsIncomplete?' (may be incomplete)':''}`);
        else if(p.findingsIncomplete) parts.push('no findings seen (list may be incomplete)');
        lines.push(`#${p.number} ${p.title}: ${parts.join(' · ')} · dashboard ${p.dashboardUrl}`);
      }
      if(!pulls.length) lines.push('No pull requests found.');
      return {content:[{type:'text',text:lines.join('\n')}],structuredContent:{repository,dashboardUrl:`${config.origin}/?repo=${encodeURIComponent(repository)}#dashboard`,pulls,limit:pullLimit,mayHaveMore}};
    },
  },{
    name:'pull_request_status',title:'Pull request status',
    description:'Shows one pull request as the Repo Autopilot dashboard does: whether it is ready to merge and why not, CI, Codex review status, every Codex finding with its state (open, waiting for Codex, fixed) and recent activity.',
    inputSchema:{type:'object',properties:{repository:REPOSITORY,number:{type:'integer',minimum:1,description:'Pull request number.'},fresh:FRESH},required:['number'],additionalProperties:false},
    annotations:READ_ONLY,_meta:CARD_TOOL_META,
    run:async(args,{token,grantId})=>{
      if(!Number.isSafeInteger(args.number)||args.number<1) throw Object.assign(new Error('number must be a pull request number.'),{expose:true});
      const reload=freshOf(args);
      const repository=await repositoryOf(args,token,grantId);
      // The overview gives the pull request's last update, which keys the dashboard's cache.
      const overview=await dashboardData({store,token,fetchImpl,repository,fresh:reload});
      const listed=overview.pulls.find(p=>p.number===args.number);
      let item;
      try {item=await dashboardData({store,token,fetchImpl,repository,number:args.number,updated:listed?.updatedAt||'',fresh:reload});}
      catch(error) {if(error?.status===404) throw Object.assign(new Error(`${repository} has no pull request #${args.number}.`),{expose:true});throw error;}
      const summary={...pullSummary(item),dashboardUrl:dashboardUrl(repository,args.number)};
      return {content:[{type:'text',text:statusText(repository,summary)}],structuredContent:{repository,...summary}};
    },
  },{
    name:'list_workflow_runs',title:'List workflow runs',
    description:`Lists the most recent GitHub Actions workflow runs of a repository, newest first, as the Repo Autopilot dashboard shows them: workflow, run number, title, status and conclusion, branch, commit, time and link. It reads up to ${runMax} runs; failed_only and branch narrow those, not the whole history.`,
    inputSchema:{type:'object',properties:{repository:REPOSITORY,limit:{type:'integer',minimum:1,maximum:runMax,description:`How many of the most recent runs to read (default ${runStep}, at most ${runMax}).`},failed_only:{type:'boolean',description:'Only runs that failed, timed out or were cancelled.'},branch:{type:'string',description:'Only runs on this branch.'},fresh:FRESH},additionalProperties:false},
    annotations:READ_ONLY,
    run:async(args,{token,grantId})=>{
      const limit=args.limit??runStep;
      if(!Number.isSafeInteger(limit)||limit<1||limit>runMax) throw Object.assign(new Error(`limit must be a number from 1 to ${runMax}.`),{expose:true});
      if(args.failed_only!==undefined&&typeof args.failed_only!=='boolean') throw Object.assign(new Error('failed_only must be true or false.'),{expose:true});
      if(args.branch!==undefined&&(typeof args.branch!=='string'||!args.branch.trim())) throw Object.assign(new Error('branch must be a branch name.'),{expose:true});
      const reload=freshOf(args);
      const repository=await repositoryOf(args,token,grantId);
      // The dashboard reads runs in steps of its page size; the list is cut to the limit asked for.
      const runLimit=Math.ceil(limit/runStep)*runStep;
      const overview=await dashboardData({store,token,fetchImpl,repository,runLimit,fresh:reload});
      const read=overview.workflows.slice(0,limit);
      // A failed read of the runs leaves the list empty with a warning; that is said, not reported as no runs.
      const unavailable=(overview.warnings||[]).find(w=>/^GitHub Actions runs are unavailable/.test(w))||null;
      const failed=r=>['failure','timed_out','cancelled','startup_failure'].includes(r.conclusion);
      const runs=read.filter(r=>(!args.failed_only||failed(r))&&(args.branch===undefined||r.branch===args.branch.trim()))
        .map(r=>({id:r.id,runNumber:r.runNumber,workflow:r.name,title:r.title,status:r.status,conclusion:r.conclusion||null,branch:r.branch,commit:r.sha,url:r.url,updatedAt:r.updatedAt}));
      const mayHaveMore=overview.workflows.length>=limit;
      const narrowed=[args.failed_only&&'failed',args.branch!==undefined&&`on ${args.branch.trim()}`].filter(Boolean).join(', ');
      const lines=[`${repository}: ${narrowed?`${runs.length} ${narrowed} of `:''}the ${read.length} most recent workflow runs`];
      if(mayHaveMore) lines.push('Older runs are not included; ask with a larger limit to read more.');
      for(const r of runs) lines.push(`${r.runNumber?`#${r.runNumber} `:''}${r.workflow} · ${r.title||''}: ${r.status==='completed'?r.conclusion||'completed':r.status.replace(/_/g,' ')} · branch ${r.branch||'unknown'} · ${short(r.commit)} · ${String(r.updatedAt).slice(0,16).replace('T',' ')} · ${r.url}`);
      if(unavailable) lines.splice(0,lines.length,`${repository}: workflow runs could not be read. ${unavailable}`);
      else if(!runs.length) lines.push(read.length?'No runs match.':'No workflow runs found.');
      return {content:[{type:'text',text:lines.join('\n')}],structuredContent:{repository,available:!unavailable,error:unavailable,runs,limit,mayHaveMore}};
    },
  },{
    name:'pull_request_checks',title:'Pull request checks',
    description:'Shows the CI of one pull request in detail: every check and commit status on its head commit, and for the checks that failed (up to four) what GitHub reports about them, their annotations and, for GitHub Actions jobs, the last lines of the job log. Read live from GitHub.',
    inputSchema:{type:'object',properties:{repository:REPOSITORY,number:{type:'integer',minimum:1,description:'Pull request number.'}},required:['number'],additionalProperties:false},
    annotations:READ_ONLY,
    run:async(args,{token,grantId})=>{
      if(!Number.isSafeInteger(args.number)||args.number<1) throw exposed('number must be a pull request number.');
      const repository=await repositoryOf(args,token,grantId);
      const client=createGitHub({token,fetchImpl,userAgent:'repo-autopilot-chat'});
      let pr;
      try {pr=await client.pull(repository,args.number);}
      catch(error) {if(error?.status===404) throw exposed(`${repository} has no pull request #${args.number}.`);throw error;}
      const head=pr.head?.sha;
      const {checks,statuses,complete,opened}=await client.checks(repository,head);
      const failedChecks=checks.filter(c=>c.status==='completed'&&['failure','cancelled','timed_out','action_required','startup_failure','stale'].includes(c.conclusion));
      const failedStatuses=statuses.filter(st=>['failure','error'].includes(st.state));
      const running=checks.filter(c=>c.status!=='completed').length+statuses.filter(st=>st.state==='pending').length;
      const lines=[`${repository} #${args.number} ${pr.title}: checks on ${short(head)}`,`${failedChecks.length+failedStatuses.length} failed · ${running} running · ${checks.length+statuses.length-failedChecks.length-failedStatuses.length-running} passed or skipped${complete?'':' (the list may be incomplete)'}`];
      for(const c of failedChecks) {
        lines.push('',`✗ ${c.name}: ${c.conclusion}${c.url?` · ${c.url}`:''}`);
        if(c.title) lines.push(indent(c.title));
        if(c.summary) lines.push(indent(c.summary.slice(0,600)));
        for(const a of c.annotations||[]) lines.push(`    ${a.path||''}${a.line?`:${a.line}`:''} ${a.level||''}: ${a.message||''}`.trimEnd());
        if(c.annotationCount>(c.annotations||[]).length) lines.push(`    ${c.annotationCount-(c.annotations||[]).length} more annotations are not shown; see the check on GitHub.`);
        if(c.log) lines.push('    Last lines of the log:',indent(c.log,'      '));
        else if(c.annotations) lines.push(c.app==='github-actions'?'    The job log could not be read.':'    No log: this check does not come from GitHub Actions.');
      }
      if(failedChecks.length>opened) lines.push('',`${failedChecks.length-opened} more failed checks are listed without details.`);
      for(const st of failedStatuses) lines.push('',`✗ ${st.context}: ${st.state}${st.description?` · ${st.description}`:''}${st.url?` · ${st.url}`:''}`);
      const others=[...checks.filter(c=>!failedChecks.includes(c)).map(c=>`${c.name}: ${c.status==='completed'?c.conclusion:c.status.replace(/_/g,' ')}`),...statuses.filter(st=>!failedStatuses.includes(st)).map(st=>`${st.context}: ${st.state}`)];
      if(others.length) lines.push('','Other checks:',...others.map(o=>`  ${o}`));
      if(!checks.length&&!statuses.length) lines.push('No checks reported on this commit.');
      return {content:[{type:'text',text:lines.join('\n')}],structuredContent:{repository,number:args.number,headSha:head,checks,statuses,complete,dashboardUrl:dashboardUrl(repository,args.number)}};
    },
  },{
    name:'codex_findings',title:'Codex findings in full',
    description:'Shows the Codex findings of one pull request with their full text: what Codex says is wrong and how to fix it, with priority, place in the code, whether they concern the current code and their state (open, waiting for Codex, unverified, fixed).',
    inputSchema:{type:'object',properties:{repository:REPOSITORY,number:{type:'integer',minimum:1,description:'Pull request number.'},state:{type:'string',enum:['all','open','waiting','unverified','fixed'],description:'Only findings in this state (default all).'},fresh:FRESH},required:['number'],additionalProperties:false},
    annotations:READ_ONLY,
    run:async(args,{token,grantId})=>{
      if(!Number.isSafeInteger(args.number)||args.number<1) throw exposed('number must be a pull request number.');
      const wanted=args.state??'all';
      if(!['all','open','waiting','unverified','fixed'].includes(wanted)) throw exposed('state must be all, open, waiting, unverified or fixed.');
      const reload=freshOf(args);
      const repository=await repositoryOf(args,token,grantId);
      const overview=await dashboardData({store,token,fetchImpl,repository,fresh:reload});
      const listed=overview.pulls.find(p=>p.number===args.number);
      let item;
      try {item=await dashboardData({store,token,fetchImpl,repository,number:args.number,updated:listed?.updatedAt||'',fresh:reload});}
      catch(error) {if(error?.status===404) throw exposed(`${repository} has no pull request #${args.number}.`);throw error;}
      if(!item.progress?.findings) return {content:[{type:'text',text:`${repository} #${args.number}: the Codex findings could not be read from GitHub.`}],structuredContent:{repository,number:args.number,findingsAvailable:false,findings:[]}};
      const state={waiting:'changed'}[wanted]||wanted;
      const all=findingLines(item);
      // This tool names the state waiting for Codex "waiting", as its state argument does.
      const findings=all.filter(f=>wanted==='all'||f.status.state===state).map(f=>({priority:f.priority,title:f.title,text:typeof f.text==='string'?f.text:null,textCut:typeof f.text==='string'&&f.text.endsWith(FINDING_TEXT_CUT),path:f.path,line:f.line,url:f.url,commit:f.commit||null,current:f.current,state:f.status.state,why:f.status.why||null}));
      const named=s=>s==='changed'?'waiting':s;
      const lines=[`${repository} #${item.number} ${item.title}: ${findings.length} Codex finding${findings.length===1?'':'s'}${wanted==='all'?'':` (${wanted})`} of ${all.length}${item.progress.findings.incomplete?' (the list may be incomplete)':''}`];
      for(const f of findings) {
        lines.push('',`${FINDING_STATES[f.state].icon} ${f.priority} ${f.title} (${f.path?`${f.path}${f.line?`:${f.line}`:''}`:'location unknown'}; ${f.current?'current code':f.commit?`older commit ${short(f.commit)}`:'commit unknown'}; ${FINDING_STATES[f.state].label}${f.why?`: ${f.why}`:''})`,`    ${f.url||''}`.trimEnd());
        lines.push(f.text?indent(f.text):'    The full text is not in the cached data; ask again with fresh: true.');
      }
      return {content:[{type:'text',text:lines.join('\n')}],structuredContent:{repository,number:item.number,findingsAvailable:true,findingsIncomplete:Boolean(item.progress.findings.incomplete),findings:findings.map(f=>({...f,state:named(f.state)})),dashboardUrl:dashboardUrl(repository,item.number)}};
    },
  },{
    name:'waiting_on_me',title:'What needs me',
    description:`Lists the open pull requests across the repositories Repo Autopilot reads (the ${ATTENTION_REPOS} most recently pushed) and what each needs: something to fix (Codex findings, failed CI, a merge conflict, review comments), a merge, or waiting (CI, Codex or a reviewer). Pull requests to fix come first.`,
    inputSchema:{type:'object',properties:{fresh:FRESH},additionalProperties:false},
    annotations:READ_ONLY,
    run:async(args,{token,grantId})=>{
      const reload=freshOf(args);
      const {list,truncated:reposCut}=await readRepos(access(token,grantId));
      const checked=list.slice(0,ATTENTION_REPOS).map(r=>r.fullName);
      const pulls=[],problems=[],truncated=[];
      const client=createGitHub({token,fetchImpl,userAgent:'repo-autopilot-chat'});
      const isolated=error=>{if(error?.status===401||!(error instanceof PublicError||error?.expose||error?.status)) throw error;};
      let budget=FRESH_DETAILS;
      for(const repository of checked) {
        // The open pull requests themselves, not the dashboard's overview, which mixes in closed ones.
        let open;
        try {open=await client.openPulls(repository);}
        catch(error) {isolated(error);problems.push(`${repository}: ${error.message}`);continue;}
        if(open.mayHaveMore) truncated.push(repository);
        for(const pr of open.pulls) {
          let item=null;
          try {
            // Fresh reads GitHub again, within the budget; the rest come from the cache.
            const again=reload&&budget>0;
            if(!again) item=await dashboardData({store,token,fetchImpl,repository,number:pr.number,updated:pr.updatedAt,cachedOnly:true});
            if(!item&&budget>0) {budget--;item=await dashboardData({store,token,fetchImpl,repository,number:pr.number,updated:pr.updatedAt,fresh:again});}
          } catch(error) {isolated(error);}
          const summary=item?pullSummary(item):null;
          pulls.push({repository,number:pr.number,title:pr.title,url:pr.url,dashboardUrl:dashboardUrl(repository,pr.number),
            next:pr.draft?'draft':summary?nextStep(summary):'check',reasons:summary?summary.readiness.reasons:[],ci:summary?.ci??null,codex:summary?.codex?.label??null,openFindings:summary?.findingCounts?.open??null});
        }
      }
      const order={fix:0,merge:1,wait:2,check:3,draft:4};
      pulls.sort((a,b)=>order[a.next]-order[b.next]);
      const label={fix:'Fix',merge:'Ready to merge',wait:'Waiting',check:'Details not loaded; ask for pull_request_status',draft:'Draft'};
      const lines=[`Open pull requests in ${checked.length} repositor${checked.length===1?'y':'ies'}: ${checked.join(', ')||'none'}`];
      if(list.length>checked.length) lines.push(`${list.length-checked.length} less recently pushed repositories were not read.`);
      if(reposCut) lines.push('The list of repositories may itself be incomplete: Repo Autopilot reads up to 5 GitHub App installations and 200 repositories each.');
      for(const p of pulls) lines.push(`${label[p.next]}: ${p.repository} #${p.number} ${p.title}${p.reasons.length?` (${p.reasons.join('; ')})`:''} · ${p.dashboardUrl}`);
      for(const repository of truncated) lines.push(`${repository} has more open pull requests than the 30 read here.`);
      // With a repository unread, no open pull requests is not known.
      if(!pulls.length) lines.push(problems.length?'No open pull requests were found in the repositories that could be read.':'No open pull requests.');
      for(const problem of problems) lines.push(`Could not read ${problem}`);
      return {content:[{type:'text',text:lines.join('\n')}],structuredContent:{repositories:checked,notRead:Math.max(0,list.length-checked.length),pulls,truncated,problems,complete:!problems.length&&!truncated.length&&!reposCut&&list.length<=checked.length}};
    },
  }];
}
