// The Repo Autopilot card: an MCP App (https://modelcontextprotocol.io/extensions/apps) that chat apps such as
// Claude and ChatGPT render next to the answer when a pull request tool is used. It draws the tool result
// the host passes in, the same structured data the model reads, and talks to the host only through the
// MCP Apps postMessage protocol. It can open links and reload the same tool; it cannot change anything.
export const CARD_URI='ui://repo-autopilot/pull-requests.html';
export const CARD_MIME='text/html;profile=mcp-app';
export const CARD_PROTOCOL='2026-01-26';

// Runs inside the card's sandboxed frame. It is serialized with Function.prototype.toString, so it must not
// use anything from this module's scope.
function cardView(protocol) {
  const ICONS={fixed:'✅',changed:'🔄',open:'⚠',unverified:'❔'};
  const LABELS={fixed:'fixed',changed:'waiting for Codex',open:'open',unverified:'unverified'};
  const ORDER={open:0,changed:1,unverified:2,fixed:3};
  const CI={success:'CI passed',failure:'CI failed',pending:'CI running',unknown:'No checks'};
  const pending=new Map();
  let nextId=1,context={},args=null,result=null,tool=null,filter='all',busy=false,loadedAt=null;
  const expanded=new Set(),showFixed=new Set();
  const $=id=>document.getElementById(id);
  const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls) node.className=cls;if(text!==undefined) node.textContent=text;return node;};

  // JSON-RPC over postMessage with the host, which is always the parent window.
  const post=message=>window.parent.postMessage({jsonrpc:'2.0',...message},'*');
  const request=(method,params)=>new Promise((resolve,reject)=>{const id=nextId++;pending.set(id,{resolve,reject});post({id,method,params});});
  const notify=(method,params)=>post({method,params});
  window.addEventListener('message',event=>{
    if(event.source!==window.parent) return;
    const message=event.data;
    if(!message||message.jsonrpc!=='2.0') return;
    if(message.method===undefined) {
      const waiting=pending.get(message.id);
      if(!waiting) return;
      pending.delete(message.id);
      if(message.error) waiting.reject(new Error(message.error.message||'The chat app refused the request.'));
      else waiting.resolve(message.result);
      return;
    }
    const reply=value=>{if(message.id!==undefined) post({id:message.id,result:value});};
    if(message.method==='ui/notifications/tool-input') args=message.params?.arguments||{};
    else if(message.method==='ui/notifications/tool-result') {result=message.params;loadedAt=new Date();render();}
    else if(message.method==='ui/notifications/tool-cancelled') {result=null;$('body').replaceChildren(el('p','note','The request was cancelled.'));}
    else if(message.method==='ui/notifications/host-context-changed') {applyContext(message.params||{});render();}
    else if(message.method==='ui/resource-teardown'||message.method==='ping') reply({});
    else if(message.id!==undefined) post({id:message.id,error:{code:-32601,message:`Method not found: ${message.method}`}});
  });

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

  // The host sizes the inline frame to the content, so every change of height is reported.
  // Nothing but the handshake is sent before it completes: strict hosts keep the frame hidden otherwise.
  let lastHeight=0,lastWidth=0,queued=false,connected=false;
  const measure=()=>{
    if(queued||!connected) return;
    queued=true;
    requestAnimationFrame(()=>{
      queued=false;
      const root=document.documentElement,before=root.style.height;
      root.style.height='max-content';
      const height=Math.ceil(root.getBoundingClientRect().height);
      root.style.height=before;
      const width=Math.ceil(window.innerWidth);
      if(height!==lastHeight||width!==lastWidth) {lastHeight=height;lastWidth=width;notify('ui/notifications/size-changed',{width,height});}
    });
  };

  const openLink=url=>{if(/^https:\/\//.test(url||'')) request('ui/open-link',{url}).catch(()=>{});};
  const time=at=>{
    const date=new Date(at);
    if(Number.isNaN(date.getTime())) return '';
    // A locale the browser does not know falls back to its own.
    try {return date.toLocaleString(context.locale||undefined,{dateStyle:'short',timeStyle:'short'});}
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
      const title=f.url?el('a','f-title',f.title):el('span','f-title',f.title);
      if(f.url) {title.href=f.url;title.onclick=event=>{event.preventDefault();openLink(f.url);};}
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

  function details(pr) {
    const box=el('div','details');
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
      head.append(el('span','number',`#${pr.number}`),el('span','title',pr.title));
      item.append(head,el('p','status',pr.error?`Details could not be read: ${pr.error}`:'Details not loaded yet. Ask about this pull request to load it.'));
      return item;
    }
    // One pull request is always shown in full; in a list, each row opens and closes.
    const head=el(single?'div':'button','pr-head');
    head.append(el('span','number',`#${pr.number}`));
    if(single&&pr.url) {const link=el('a','title',pr.title);link.href=pr.url;link.onclick=event=>{event.preventDefault();openLink(pr.url);};head.append(link);}
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
    if(open) item.append(details(pr));
    return item;
  }

  function render() {
    const data=result?.structuredContent;
    const body=$('body');
    if(!data) {
      const text=result?.content?.find(c=>c.type==='text')?.text;
      body.replaceChildren(el('p','note',result?.isError?text||'Repo Autopilot could not answer.':'Loading from Repo Autopilot…'));
      measure();
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
    const nodes=[shown.length?list:el('p','note',filter==='ready'?'No pull request is ready to merge.':'Nothing needs attention.')];
    if(data.mayHaveMore) nodes.push(el('p','note',`Only the ${data.limit} most recently updated pull requests are shown.`));
    body.replaceChildren(...nodes);
    const modes=context.availableDisplayModes||[];
    $('expand').hidden=!modes.includes('fullscreen');
    $('expand').textContent=context.displayMode==='fullscreen'?'Exit full screen':'Full screen';
    $('refresh').disabled=busy;
    $('refresh').textContent=busy?'Refreshing…':'Refresh';
    measure();
  }

  for(const button of $('filters').querySelectorAll('button')) button.onclick=()=>{filter=button.dataset.filter;render();};
  $('expand').onclick=async()=>{
    const mode=context.displayMode==='fullscreen'?'inline':'fullscreen';
    try {const applied=await request('ui/request-display-mode',{mode});applyContext({displayMode:applied?.mode||context.displayMode});} catch {}
    render();
  };
  // Loading the same tool again through the host gives fresh data; the server still checks the sign-in.
  $('refresh').onclick=async()=>{
    const data=result?.structuredContent;
    if(busy||!data) return;
    // Hosts that do not name the tool or pass its arguments get them from the data shown.
    const name=tool||(data.pulls?'list_pull_requests':'pull_request_status');
    const call=args||(data.pulls?{repository:data.repository}:{repository:data.repository,number:data.number});
    busy=true;render();
    try {result=await request('tools/call',{name,arguments:call});loadedAt=new Date();}
    catch(error) {result={isError:true,content:[{type:'text',text:error.message}]};}
    busy=false;render();
  };
  $('dashboard').onclick=event=>{event.preventDefault();openLink($('dashboard').href);};

  new ResizeObserver(measure).observe(document.body);
  (async()=>{
    try {
      const init=await request('ui/initialize',{protocolVersion:protocol,appInfo:{name:'Repo Autopilot',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline','fullscreen']}});
      applyContext(init?.hostContext||{});
      tool=init?.hostContext?.toolInfo?.tool?.name||null;
    } catch {}
    notify('ui/notifications/initialized',{});
    connected=true;
    render();
  })();
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
.filters button{min-height:36px;padding:4px 12px;border:var(--border-width-regular,1px) solid var(--line);border-radius:var(--border-radius-full,999px);background:transparent;font-weight:var(--font-weight-medium,500)}
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
.more{align-self:flex-start;min-height:36px;padding:4px 12px;border:var(--border-width-regular,1px) solid var(--line);border-radius:var(--border-radius-full,999px);background:transparent;font-size:var(--font-text-xs-size,12px)}
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
.head button{min-height:36px;padding:4px 12px;border:var(--border-width-regular,1px) solid var(--line);border-radius:var(--border-radius-md,8px);background:transparent;white-space:nowrap}
.head button[hidden]{display:none}
.actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.actions button,.actions a{min-height:44px;padding:8px 14px;border-radius:var(--border-radius-md,8px);border:var(--border-width-regular,1px) solid var(--line);background:var(--bg2);text-decoration:none;color:var(--fg);display:inline-flex;align-items:center}
.actions button[hidden]{display:none}
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

// The card's HTML. The dashboard link is the only server value in it; merging happens there.
export function cardHtml(origin) {
  const dashboard=`${origin}/`.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Repo Autopilot</title><style>${STYLE}</style></head><body>${BODY.replace('__DASHBOARD__',dashboard)}<script>(${cardView.toString()})(${JSON.stringify(CARD_PROTOCOL)});</script></body></html>`;
}

// What resources/list and resources/read return for the card.
export const cardResource={uri:CARD_URI,name:'Repo Autopilot pull requests',description:'Pull requests with merge readiness, CI, Codex status and Codex findings, as the Repo Autopilot dashboard shows them.',mimeType:CARD_MIME};
export function cardContents(origin) {
  // No external origins: the card loads nothing and connects nowhere; everything comes from the host.
  return {contents:[{uri:CARD_URI,mimeType:CARD_MIME,text:cardHtml(origin),_meta:{ui:{csp:{connectDomains:[],resourceDomains:[]},prefersBorder:true}}}]};
}
export const CARD_TOOL_META={ui:{resourceUri:CARD_URI},'ui/resourceUri':CARD_URI};
