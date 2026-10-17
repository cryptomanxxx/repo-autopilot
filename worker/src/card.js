// The Repo Autopilot card: an MCP App (https://modelcontextprotocol.io/extensions/apps) that chat apps such as
// Claude and ChatGPT render next to the answer when a pull request tool is used. It draws the tool result
// the host passes in, the same structured data the model reads, and talks to the host through the official
// MCP Apps SDK client, inlined from worker/src/vendor. It can open links and reload the same tool; it cannot
// change anything.
import {EXT_APPS_SCRIPT} from './vendor/ext-apps.js';
export const CARD_URI='ui://repo-autopilot/pull-requests.html';
export const CARD_MIME='text/html;profile=mcp-app';

// Runs first in the card, before the SDK, and reports how far the card gets to the server's /card-log, which
// writes each report to the Worker's log: the page starting and where it runs, the messages the host sends,
// each handshake attempt and its outcome, the tool input and result, and script errors. Reports carry no
// tool data, only what happened. Each goes out twice, as a beacon (connect-src) and as an image request
// (img-src), so the log also shows which of the two a host's sandbox lets through; via says which one it was.
// It is serialized like cardView, with the report address and the page's load id as its arguments.
function cardReport(url,load) {
  let sent=0,seen=0;
  const images=new Set();
  const report=(event,fields={})=>{
    if(++sent>40) return;
    const body=via=>JSON.stringify({event,load,via,...fields});
    try {if(!navigator.sendBeacon?.(url,body('beacon'))) fetch(url,{method:'POST',body:body('beacon'),keepalive:true,mode:'no-cors'}).catch(()=>{});} catch {}
    try {
      const image=new Image();images.add(image);
      image.onload=image.onerror=()=>images.delete(image);
      image.src=`${url}?r=${encodeURIComponent(body('image'))}`;
    } catch {}
  };
  globalThis.RepoAutopilotReport=report;
  const originOf=value=>{try {return new URL(value).origin;} catch {return '';}};
  report('start',{frame:window.parent===window?'top':'frame',origin:location.origin,parentOrigin:location.ancestorOrigins?.[0]||'',referrer:originOf(document.referrer),ready:document.readyState});
  window.addEventListener('error',event=>report('error',{error:String(event.message||event.error||'error')}));
  window.addEventListener('unhandledrejection',event=>report('error',{error:String(event.reason?.message||event.reason||'rejection')}));
  // The first messages that reach the page, from whichever source, before the card's own filter.
  window.addEventListener('message',event=>{
    if(++seen>10) return;
    const message=event.data&&typeof event.data==='object'?event.data:{};
    report('message',{from:event.source===window.parent?'parent':event.source===null?'none':'other',method:typeof message.method==='string'?message.method:'',reply:'result' in message||'error' in message});
  });
}

// Runs inside the card's sandboxed frame. It is serialized with Function.prototype.toString, so it must not
// use anything from this module's scope.
function cardView() {
  const ICONS={fixed:'✅',changed:'🔄',open:'⚠',unverified:'❔'};
  const LABELS={fixed:'fixed',changed:'waiting for Codex',open:'open',unverified:'unverified'};
  const ORDER={open:0,changed:1,unverified:2,fixed:3};
  const CI={success:'CI passed',failure:'CI failed',pending:'CI running',unknown:'No checks'};
  let context={},caps={},args=null,data=null,failure=null,waiting=true,tool=null,filter='all',busy=false,loadedAt=null,connected=false,app=null;
  const expanded=new Set(),showFixed=new Set();
  const report=globalThis.RepoAutopilotReport||(()=>{});
  const height=()=>document.documentElement.scrollHeight;
  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls) node.className=cls;if(text!==undefined) node.textContent=text;return node;};

  // The official MCP Apps client, the SDK's App (inlined before this script as McpApps), speaks the protocol
  // with the host: the handshake, tool input and results, links, display modes, tool calls and sizing.
  // Its handlers are set before it connects, so the first tool input and result are not missed.
  // The transport is the SDK's PostMessageTransport with two additions for native web views: a message
  // without a source is accepted, and where the card is the top page (window.parent is the card itself)
  // its own messages coming back are dropped. In a frame they never come back, so nothing is filtered.
  const makeTransport=()=>{
    const loops=window.parent===window,mine=new Set();
    const key=m=>m.method!==undefined?`${m.method}#${m.id??''}`:`reply#${m.id}#${JSON.stringify(m.result??m.error??null)}`;
    const transport={
      onmessage:undefined,onerror:undefined,onclose:undefined,
      listener:event=>{
        if(event.source!==window.parent&&event.source!==null) return;
        const message=event.data;
        if(!message||typeof message!=='object'||message.jsonrpc!=='2.0') return;
        if(loops&&mine.delete(key(message))) return;
        transport.onmessage?.(message);
      },
      async start() {window.addEventListener('message',transport.listener);},
      async send(message) {if(loops) mine.add(key(message));window.parent.postMessage(message,'*');},
      async close() {window.removeEventListener('message',transport.listener);transport.onclose?.();},
    };
    return transport;
  };
  const makeApp=()=>{
    const client=new McpApps.App({name:'Repo Autopilot',version:'1.0.0'},{availableDisplayModes:['inline','fullscreen']},{autoResize:true});
    client.ontoolinput=params=>{args=params?.arguments||{};report('tool-input');};
    client.ontoolresult=result=>{take(result);render();report('tool-result',{isError:Boolean(result?.isError),structured:Boolean(result?.structuredContent),height:height()});};
    client.ontoolcancelled=()=>{waiting=false;failure='The request was cancelled.';render();report('cancelled');};
    client.onhostcontextchanged=change=>{applyContext(change||{});render();};
    client.onteardown=async()=>{report('teardown');return {};};
    return client;
  };

  function applyContext(change) {
    context={...context,...change,styles:change.styles||context.styles};
    const root=document.documentElement;
    if(context.theme) {root.dataset.theme=context.theme;root.style.colorScheme=context.theme;}
    for(const [name,value] of Object.entries(context.styles?.variables||{})) if(typeof value==='string') root.style.setProperty(name,value);
    const fonts=context.styles?.css?.fonts;
    if(typeof fonts==='string'&&!$('host-fonts')) {const style=el('style');style.id='host-fonts';style.textContent=fonts;document.head.append(style);}
    const inset=context.safeAreaInsets||{};
    for(const side of ['top','right','bottom','left']) root.style.setProperty(`--inset-${side}`,`${Number(inset[side])||0}px`);
    root.dataset.mode=context.displayMode||'inline';
  }

  // A tool result replaces what is shown; a failed one keeps the last good data and says what went wrong.
  function take(value) {
    waiting=false;
    if(value?.structuredContent&&!value.isError) {data=value.structuredContent;failure=null;loadedAt=new Date();return;}
    failure=value?.content?.find(c=>c.type==='text')?.text||'Repo Autopilot could not answer.';
  }
  // Links open through the host when it offers that; otherwise they are ordinary links in a new tab.
  const linkTo=(node,url)=>{
    if(!/^https:\/\//.test(url||'')) return node;
    node.href=url;node.target='_blank';node.rel='noopener noreferrer';
    // Until the host has answered, a click does nothing: navigating would replace the card itself.
    node.onclick=event=>{if(connected&&!caps.openLinks) return;event.preventDefault();if(connected) app.openLink({url}).catch(()=>{});};
    return node;
  };
  // The same tool again, with the arguments the host passed, or worked out from the data shown.
  const refreshCall=()=>{
    if(!caps.serverTools) return null;
    const name=tool||(data?(data.pulls?'list_pull_requests':'pull_request_status'):null);
    const call=args||(data?(data.pulls?{repository:data.repository}:{repository:data.repository,number:data.number}):null);
    // Refresh reads GitHub again rather than the cache the first answer came from.
    return name&&call?{name,arguments:{...call,fresh:true}}:null;
  };
  const time=at=>{
    const date=new Date(at);
    if(Number.isNaN(date.getTime())) return '';
    // The host's locale and time zone; one the browser does not know falls back to its own.
    try {return date.toLocaleString(context.locale||undefined,{dateStyle:'short',timeStyle:'short',timeZone:context.timeZone||undefined});}
    catch {return date.toLocaleString(undefined,{dateStyle:'short',timeStyle:'short'});}
  };
  const short=sha=>sha?String(sha).slice(0,7):'';
  const isReady=pr=>pr.readiness?.state==='ready';
  const needsAttention=pr=>pr.state==='open'&&!isReady(pr);
  const ciText=pr=>{
    if(!pr.ciAvailable) return 'CI unavailable';
    return `${CI[pr.ci]||pr.ci}${pr.ciComplete===false?' (not verified)':''}`;
  };
  const countsText=pr=>{
    if(!pr.findingsAvailable) return 'findings unknown';
    const c=pr.findingCounts||{};
    const parts=[c.open&&`${c.open} open`,c.waiting&&`${c.waiting} waiting`,c.unverified&&`${c.unverified} unverified`,c.fixed&&`${c.fixed} fixed`].filter(Boolean);
    return parts.length?`${parts.join(' · ')}${pr.findingsIncomplete?' (may be incomplete)':''}`:pr.findingsIncomplete?'no findings seen (may be incomplete)':'no findings';
  };
  const tone=pr=>pr.state==='merged'?'done':isReady(pr)?'ok':pr.state!=='open'?'muted':pr.findingCounts?.open||pr.ci==='failure'?'bad':'wait';

  // Fixed findings are folded away when there are many, so the card stays short in the conversation.
  function findingList(pr) {
    const list=el('ul','findings');
    const sorted=[...pr.findings].sort((a,b)=>ORDER[a.state]-ORDER[b.state]);
    const fixed=sorted.filter(f=>f.state==='fixed').length;
    const fold=fixed>3&&!showFixed.has(pr.number);
    for(const f of fold?sorted.filter(f=>f.state!=='fixed'):sorted) {
      const item=el('li',`finding ${f.state}`);
      item.append(el('span','icon',ICONS[f.state]||'•'),el('span','priority',f.priority||''));
      const text=el('span','f-text');
      const title=f.url?linkTo(el('a','f-title',f.title),f.url):el('span','f-title',f.title);
      const where=f.path?`${f.path}${f.line?`:${f.line}`:''}`:'location unknown';
      const version=f.current?'current code':f.commit?`older commit ${short(f.commit)}`:'commit unknown';
      text.append(title,el('span','f-where',`${where} · ${version} · ${LABELS[f.state]||f.state}`));
      item.append(text);
      list.append(item);
    }
    if(fixed>3) {
      const toggle=el('button','more',fold?`Show ${fixed} fixed findings`:'Hide fixed findings');
      toggle.type='button';
      toggle.onclick=()=>{if(showFixed.has(pr.number)) showFixed.delete(pr.number);else showFixed.add(pr.number);render();};
      const item=el('li','more-row');
      item.append(toggle);
      list.append(item);
    }
    return list;
  }

  function details(pr,single) {
    const box=el('div','details');
    if(!single&&pr.url) box.append(linkTo(el('a','gh',`Open #${pr.number} on GitHub`),pr.url));
    if(pr.codex?.label) box.append(el('p','codex',pr.codex.label));
    if(pr.readiness?.reasons?.length&&!isReady(pr)) {
      const reasons=el('ul','reasons');
      for(const reason of pr.readiness.reasons) reasons.append(el('li','',reason));
      box.append(reasons);
    }
    if(!pr.findingsAvailable) box.append(el('p','note','Codex findings could not be read from GitHub.'));
    else if(pr.findings?.length) box.append(findingList(pr));
    if(pr.activity?.length) {
      const flow=el('ol','activity');
      for(const event of pr.activity.slice(-5)) flow.append(el('li','',`${time(event.at)} ${event.label}${event.commit?` (${short(event.commit)})`:''}`));
      box.append(el('p','label',`Recent activity${pr.activityIncomplete?' (may be incomplete)':''}`),flow);
    }
    for(const warning of pr.warnings||[]) box.append(el('p','note',warning));
    if(pr.detailError) box.append(el('p','note',`Some details could not be read: ${pr.detailError}`));
    return box;
  }

  function row(pr,open,single) {
    const item=el('li',`pr ${tone(pr)}`);
    if(pr.detailsLoaded===false) {
      const head=el('div','pr-head');
      head.append(el('span','number',`#${pr.number}`),pr.url?linkTo(el('a','title',pr.title),pr.url):el('span','title',pr.title));
      item.append(head,el('p','status',pr.error?`Details could not be read: ${pr.error}`:'Details not loaded yet. Ask about this pull request to load it.'));
      return item;
    }
    // One pull request is always shown in full; in a list, each row opens and closes.
    const head=el(single?'div':'button','pr-head');
    head.append(el('span','number',`#${pr.number}`));
    if(single&&pr.url) head.append(linkTo(el('a','title',pr.title),pr.url));
    else head.append(el('span','title',pr.title));
    if(!single) {
      head.type='button';
      head.setAttribute('aria-expanded',String(open));
      head.append(el('span','chevron',open?'▾':'▸'));
      head.onclick=()=>{if(expanded.has(pr.number)) expanded.delete(pr.number);else expanded.add(pr.number);render();};
    }
    const status=el(single?'p':'span','status');
    status.append(el('span','badge',pr.readiness?.label||pr.state),el('span','',` · ${ciText(pr)} · ${countsText(pr)}`));
    if(single) item.append(head,status);
    else {head.append(status);item.append(head);}
    if(open) item.append(details(pr,single));
    return item;
  }

  function render() {
    const body=$('body');
    const call=refreshCall();
    $('refresh').hidden=!call;
    $('refresh').disabled=busy;
    $('refresh').textContent=busy?'Refreshing…':failure?'Try again':'Refresh';
    const modes=context.availableDisplayModes||[];
    $('expand').hidden=!modes.includes('fullscreen');
    $('expand').textContent=context.displayMode==='fullscreen'?'Exit full screen':'Full screen';
    const problem=failure&&el('p','note problem',failure);
    if(!data) {
      body.replaceChildren(problem||el('p','note',waiting?'Loading from Repo Autopilot…':'Nothing to show.'));
      return;
    }
    $('repo').textContent=data.repository||'';
    $('updated').textContent=loadedAt?`updated ${time(loadedAt)}`:'';
    const pulls=data.pulls||[data];
    const single=!data.pulls;
    const filters=$('filters');
    filters.hidden=single;
    const counts={all:pulls.length,attention:pulls.filter(needsAttention).length,ready:pulls.filter(isReady).length};
    for(const button of filters.querySelectorAll('button')) {
      const name=button.dataset.filter;
      button.setAttribute('aria-pressed',String(name===filter));
      button.querySelector('.count').textContent=String(counts[name]);
    }
    const shown=single?pulls:pulls.filter(pr=>filter==='all'||(filter==='ready'?isReady(pr):needsAttention(pr)));
    const list=el('ul','pulls');
    for(const pr of shown) list.append(row(pr,single||expanded.has(pr.number),single));
    const nodes=[...(problem?[problem]:[]),shown.length?list:el('p','note',filter==='ready'?'No pull request is ready to merge.':'Nothing needs attention.')];
    if(data.mayHaveMore) nodes.push(el('p','note',`Only the ${data.limit} most recently updated pull requests are shown.`));
    body.replaceChildren(...nodes);
  }

  for(const button of $('filters').querySelectorAll('button')) button.onclick=()=>{filter=button.dataset.filter;render();};
  $('expand').onclick=async()=>{
    const mode=context.displayMode==='fullscreen'?'inline':'fullscreen';
    try {const applied=await app.requestDisplayMode({mode});applyContext({displayMode:applied?.mode||context.displayMode});} catch {}
    render();
  };
  // Loading the same tool again through the host gives fresh data; the server still checks the sign-in.
  $('refresh').onclick=async()=>{
    const call=refreshCall();
    if(busy||!call) return;
    busy=true;render();
    try {take(await app.callServerTool(call));}
    catch(error) {take({isError:true,content:[{type:'text',text:error.message}]});}
    busy=false;render();
  };

  // The handshake starts once the page has loaded, as it does when the SDK is loaded as a module. A host
  // that has not answered within a few seconds is asked again with a fresh client, for about a minute;
  // until the card is connected, links cannot navigate it away.
  linkTo($('dashboard'),$('dashboard').getAttribute('href'));
  const ATTEMPTS=12,ATTEMPT_MS=5000;
  const connect=async attempt=>{
    app=makeApp();
    const started=Date.now();
    report('attempt',{attempt});
    try {await app.connect(makeTransport(),{timeout:ATTEMPT_MS});}
    catch(error) {
      report('failed',{attempt,error:String(error?.message||error)});
      try {await app.close();} catch {}
      // A host that refuses at once may still be starting, so every attempt takes its full time.
      if(attempt+1<ATTEMPTS) {setTimeout(()=>connect(attempt+1),Math.max(0,ATTEMPT_MS-(Date.now()-started)));return;}
      if(!data) {waiting=false;failure='The chat app did not connect to the card. Try again later.';}
      render();
      report('gave-up');
      return;
    }
    caps=app.getHostCapabilities()||{};
    applyContext(app.getHostContext()||{});
    tool=app.getHostContext()?.toolInfo?.tool?.name||null;
    connected=true;
    render();
    const host=app.getHostVersion?.();
    report('connected',{attempt,host:host?`${host.name||''} ${host.version||''}`.trim():'',caps:Object.keys(caps),height:height()});
  };
  if(document.readyState==='complete') connect(0);
  else window.addEventListener('load',()=>connect(0),{once:true});
}

const STYLE=`
:root{color-scheme:light dark;--bg:var(--color-background-primary,Canvas);--bg2:var(--color-background-secondary,color-mix(in srgb,CanvasText 5%,Canvas));--fg:var(--color-text-primary,CanvasText);--fg2:var(--color-text-secondary,color-mix(in srgb,CanvasText 75%,Canvas));--fg3:var(--color-text-tertiary,color-mix(in srgb,CanvasText 55%,Canvas));--line:var(--color-border-tertiary,color-mix(in srgb,CanvasText 15%,Canvas));--ok:var(--color-text-success,#2e7d32);--bad:var(--color-text-danger,#b3261e);--wait:var(--color-text-warning,#8a6d1d);--info:var(--color-text-info,#3266ad);--radius:var(--border-radius-lg,10px);--inset-top:0px;--inset-right:0px;--inset-bottom:0px;--inset-left:0px}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--fg);font-family:var(--font-sans,system-ui,sans-serif);font-size:var(--font-text-sm-size,14px);line-height:var(--font-text-sm-line-height,1.4)}
.card{padding:calc(12px + var(--inset-top)) calc(12px + var(--inset-right)) calc(12px + var(--inset-bottom)) calc(12px + var(--inset-left));display:flex;flex-direction:column;gap:10px}
.head{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.eyebrow{display:block;font-size:var(--font-text-xs-size,12px);font-weight:var(--font-weight-semibold,600);letter-spacing:.06em;color:var(--fg3)}
.repo{display:block;font-weight:var(--font-weight-semibold,600);overflow-wrap:anywhere}
.updated{display:block;font-size:var(--font-text-xs-size,12px);color:var(--fg3)}
button{font:inherit;color:inherit;cursor:pointer}
button:focus-visible,a:focus-visible{outline:2px solid var(--color-ring-info,var(--info));outline-offset:2px}
.filters{display:flex;gap:6px;flex-wrap:wrap}
.filters[hidden]{display:none}
.filters button{min-height:44px;padding:4px 12px;border:var(--border-width-regular,1px) solid var(--line);border-radius:var(--border-radius-full,999px);background:transparent;font-weight:var(--font-weight-medium,500)}
.filters button[aria-pressed="true"]{background:var(--color-background-inverse,CanvasText);color:var(--color-text-inverse,Canvas);border-color:transparent}
.count{margin-left:6px;opacity:.75}
.pulls,.findings,.reasons,.activity{list-style:none;margin:0;padding:0}
.pulls{display:flex;flex-direction:column;border-top:var(--border-width-regular,1px) solid var(--line)}
.pr{padding:8px 0;border-bottom:var(--border-width-regular,1px) solid var(--line);border-left:3px solid transparent;padding-left:8px}
.pr.ok{border-left-color:var(--ok)}.pr.bad{border-left-color:var(--bad)}.pr.wait{border-left-color:var(--wait)}.pr.done{border-left-color:var(--info)}
.pr-head{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:baseline;width:100%;min-height:44px;padding:0;border:0;background:none;text-align:left}
.pr-head .status{flex-basis:100%}
.number{color:var(--fg3);font-variant-numeric:tabular-nums}
.title{flex:1;font-weight:var(--font-weight-medium,500);overflow-wrap:anywhere}
.chevron{color:var(--fg3)}
div.pr-head{min-height:0;margin-bottom:4px}
a.title{color:var(--fg);text-decoration:none}a.title:hover{text-decoration:underline}
.more{align-self:flex-start;min-height:44px;padding:4px 12px;border:var(--border-width-regular,1px) solid var(--line);border-radius:var(--border-radius-full,999px);background:transparent;font-size:var(--font-text-xs-size,12px)}
.status{margin:0;color:var(--fg2);font-size:var(--font-text-xs-size,12px)}
.badge{font-weight:var(--font-weight-semibold,600)}
.pr.ok .badge{color:var(--ok)}.pr.bad .badge{color:var(--bad)}.pr.wait .badge{color:var(--wait)}
.details{display:flex;flex-direction:column;gap:6px;margin-top:8px}
.reasons li{color:var(--fg2);font-size:var(--font-text-xs-size,12px)}.reasons li::before{content:"– "}
.findings{display:flex;flex-direction:column;gap:6px}
.finding{display:grid;grid-template-columns:1.4em auto minmax(0,1fr);gap:2px 6px;align-items:baseline}
.priority{font-size:var(--font-text-xs-size,12px);font-weight:var(--font-weight-semibold,600);color:var(--fg3)}
.f-text{display:flex;flex-direction:column;min-width:0}
.f-title{color:var(--fg);text-decoration:none;overflow-wrap:anywhere}
a.f-title:hover{text-decoration:underline}
.finding.fixed .f-title{color:var(--ok)}
.f-where{font-size:var(--font-text-xs-size,12px);color:var(--fg3);overflow-wrap:anywhere}
.label{margin:4px 0 0;font-size:var(--font-text-xs-size,12px);font-weight:var(--font-weight-semibold,600);color:var(--fg3)}
.activity li{font-size:var(--font-text-xs-size,12px);color:var(--fg2)}
.note{margin:0;color:var(--fg3);font-size:var(--font-text-xs-size,12px)}
.head button{min-height:44px;padding:4px 12px;border:var(--border-width-regular,1px) solid var(--line);border-radius:var(--border-radius-md,8px);background:transparent;white-space:nowrap}
.head button[hidden]{display:none}
.actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.actions button,.actions a{min-height:44px;padding:8px 14px;border-radius:var(--border-radius-md,8px);border:var(--border-width-regular,1px) solid var(--line);background:var(--bg2);text-decoration:none;color:var(--fg);display:inline-flex;align-items:center}
.actions button[hidden]{display:none}
.gh{align-self:flex-start;display:inline-flex;align-items:center;min-height:44px;color:var(--info);font-size:var(--font-text-xs-size,12px)}
.problem{color:var(--bad)}
.codex{margin:0;color:var(--fg2);font-size:var(--font-text-xs-size,12px);font-weight:var(--font-weight-medium,500)}
.actions button:disabled{opacity:.5;cursor:default}
`;

const BODY=`
<main class="card" aria-label="Repo Autopilot">
  <div class="head">
    <div><span class="eyebrow">REPO AUTOPILOT</span><span class="repo" id="repo"></span><span class="updated" id="updated"></span></div>
    <button type="button" id="expand" hidden>Full screen</button>
  </div>
  <div class="filters" id="filters" role="group" aria-label="Filter pull requests" hidden>
    <button type="button" data-filter="all" aria-pressed="true">All<span class="count"></span></button>
    <button type="button" data-filter="attention" aria-pressed="false">Needs attention<span class="count"></span></button>
    <button type="button" data-filter="ready" aria-pressed="false">Ready<span class="count"></span></button>
  </div>
  <div id="body"><p class="note">Loading from Repo Autopilot…</p></div>
  <div class="actions">
    <a id="dashboard" href="__DASHBOARD__">Open dashboard</a>
    <button type="button" id="refresh" disabled>Refresh</button>
  </div>
</main>`;

// The card's HTML. The dashboard link and the report address are the only server values in it; merging
// happens in the dashboard.
export const CARD_LOG_PATH='/card-log';
// The page's load id is made with the HTML, so a host that keeps the HTML shows the same id each time.
export function cardHtml(origin) {
  const attribute=value=>value.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  const dashboard=attribute(`${origin}/`);
  const load=[...crypto.getRandomValues(new Uint8Array(8))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const reportUrl=JSON.stringify(`${origin}${CARD_LOG_PATH}`).replace(/</g,'\\u003c');
  // Requested by the HTML itself, before any script: it arrives when the host shows the card at all.
  const ping=attribute(`${origin}${CARD_LOG_PATH}?r=${encodeURIComponent(JSON.stringify({event:'html',load,via:'html'}))}`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Repo Autopilot</title><style>${STYLE}</style></head><body><img src="${ping}" alt="" width="1" height="1" style="position:absolute;width:1px;height:1px;opacity:0;pointer-events:none">${BODY.replace('__DASHBOARD__',dashboard)}<script>(${cardReport.toString()})(${reportUrl},"${load}");</script><script>${EXT_APPS_SCRIPT}</script><script>(${cardView.toString()})();</script></body></html>`;
}

// What resources/list and resources/read return for the card.
export const cardResource={uri:CARD_URI,name:'Repo Autopilot pull requests',description:'Pull requests with merge readiness, CI, Codex status and Codex findings, as the Repo Autopilot dashboard shows them.',mimeType:CARD_MIME};
// Claude serves an app from its own sandbox origin, named after the connector's address: the first 32 hex
// characters of the SHA-256 of that address, under claudemcpcontent.com
// (https://claude.com/docs/connectors/building/mcp-apps/getting-started#set-ui-domain-for-claude).
export async function claudeDomain(serverUrl) {
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serverUrl)));
  return `${[...digest].map(b=>b.toString(16).padStart(2,'0')).join('').slice(0,32)}.claudemcpcontent.com`;
}
// Whether a connected app is Claude, from the address it returns to after signing in.
export const isClaude=client=>(client?.redirectUris||[]).some(uri=>{try {return /(^|\.)claude\.(ai|com)$/.test(new URL(uri).hostname);} catch {return false;}});

// domain is the sandbox origin the host expects, when it has a format for one (Claude does); other hosts
// choose their own.
export function cardContents(origin,{domain=null}={}) {
  // The card loads nothing from elsewhere; everything comes from the host. It reaches only this server, to
  // report how far it got, by beacon and by image request.
  return {contents:[{uri:CARD_URI,mimeType:CARD_MIME,text:cardHtml(origin),_meta:{ui:{csp:{connectDomains:[origin],resourceDomains:[origin]},prefersBorder:true,...(domain?{domain}:{})}}}]};
}
export const CARD_TOOL_META={ui:{resourceUri:CARD_URI},'ui/resourceUri':CARD_URI};
