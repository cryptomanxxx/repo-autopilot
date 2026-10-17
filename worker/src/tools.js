// The connector's tools. They only read: the same data the dashboard shows, through the same cache, with
// the GitHub sign-in of the connected app.
import {findingStatus,FINDING_STATES} from '../public/dashboard-view.js';
import {PublicError} from './errors.js';
import {CARD_TOOL_META} from './card.js';

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

export function connectorTools({store,fetchImpl,config,readRepos,resolveRepository,dashboardData,pullLimit}) {
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
  }];
}
