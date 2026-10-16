// Storage logic for the single chat Durable Object. It only uses the synchronous SQL API
// (`sql.exec(query, ...bindings)` returning a cursor with `toArray()`), so every method runs
// atomically inside the Durable Object and can be tested with any SQLite adapter.
const HOUR=3600000;
const MESSAGE_COLUMNS='id, role, content, has_image, proposal, pr_url, meta, created';
const toMessage=m=>({id:m.id,role:m.role,content:m.content,hasImage:Boolean(m.has_image),proposal:m.proposal?JSON.parse(m.proposal):null,prUrl:m.pr_url||null,meta:m.meta?JSON.parse(m.meta):null,created:m.created});

const CODEX_REQUESTS={review:'codex_reviews'};
export class ChatStoreLogic {
  constructor(sql,now=Date.now) {
    this.sql=sql;this.now=now;
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, token TEXT NOT NULL, csrf TEXT NOT NULL, login TEXT NOT NULL, expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, has_image INTEGER NOT NULL DEFAULT 0, proposal TEXT, pr_url TEXT, created INTEGER NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation, id)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS versions (repository TEXT PRIMARY KEY, version INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS heads (repository TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (repository, number))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS commit_events (repository TEXT NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL)`);
    // Codex review requests, one per pull request head commit; kept for good so none is ever posted twice.
    // Asking Codex to fix its findings is no longer offered; its table goes.
    sql.exec('DROP TABLE IF EXISTS codex_fixes');
    sql.exec(`CREATE TABLE IF NOT EXISTS codex_reviews (repository TEXT NOT NULL, number INTEGER NOT NULL, sha TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (repository, number, sha))`);
    // The Claude/ChatGPT connector: registered OAuth clients, sign-ins in progress, connected apps
    // (grants, each holding its GitHub tokens sealed with the client secret) and their tokens.
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, login TEXT NOT NULL, github TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL, expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT, expires INTEGER NOT NULL)`);
    // Conversations from before repository selection have no repository; they belong to the app's own one.
    try {sql.exec('SELECT repository FROM conversations LIMIT 0');}
    catch {sql.exec('ALTER TABLE conversations ADD COLUMN repository TEXT');}
    // Answers record the repository, branch and commit they were based on; older ones have none.
    try {sql.exec('SELECT meta FROM messages LIMIT 0');}
    catch {sql.exec('ALTER TABLE messages ADD COLUMN meta TEXT');}
  }
  rows(query,...bindings) {return this.sql.exec(query,...bindings).toArray();}

  createSession({hash,token,csrf,login,expires}) {
    this.sql.exec('DELETE FROM sessions WHERE expires <= ?',this.now());
    // At most 20 sessions; a new sign-in replaces the oldest instead of locking the owner out.
    this.sql.exec('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 19)');
    this.sql.exec('INSERT INTO sessions (hash, token, csrf, login, expires) VALUES (?, ?, ?, ?, ?)',hash,token,csrf,login,Math.min(expires,this.now()+8*HOUR));
  }
  getSession(hash) {
    const [session]=this.rows('SELECT token, csrf, login, expires FROM sessions WHERE hash = ? AND expires > ?',hash,this.now());
    return session || null;
  }
  deleteSession(hash) {this.sql.exec('DELETE FROM sessions WHERE hash = ?',hash);}

  // Anyone may register an OAuth client, so their number is capped: the oldest ones without a connected
  // app make room. A client is only a name and its redirect addresses; connecting still needs the owner.
  registerClient({id,name,redirectUris}) {
    this.sql.exec('INSERT INTO oauth_clients (id, name, redirect_uris, created) VALUES (?, ?, ?, ?)',id,name,JSON.stringify(redirectUris),this.now());
    this.sql.exec('DELETE FROM oauth_clients WHERE id IN (SELECT id FROM oauth_clients WHERE id NOT IN (SELECT client_id FROM oauth_grants) ORDER BY created DESC LIMIT -1 OFFSET 100)');
  }
  getClient(id) {
    const [row]=this.rows('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?',id);
    return row?{id:row.id,name:row.name,redirectUris:JSON.parse(row.redirect_uris)}:null;
  }
  putPending(id,data,ms) {
    this.sql.exec('DELETE FROM oauth_pending WHERE expires <= ?',this.now());
    this.sql.exec('INSERT INTO oauth_pending (id, data, expires) VALUES (?, ?, ?)',id,JSON.stringify(data),this.now()+ms);
  }
  // A pending connection can be completed once.
  takePending(id) {
    const [row]=this.rows('DELETE FROM oauth_pending WHERE id = ? RETURNING data, expires',id);
    return row&&row.expires>this.now()?JSON.parse(row.data):null;
  }
  // At most 10 connected apps; a new one replaces the least recently used.
  createGrant({id,clientId,login,github,expires}) {
    const now=this.now();
    this.sql.exec('DELETE FROM oauth_grants WHERE expires <= ?',now);
    for(const {id:old} of this.rows('SELECT id FROM oauth_grants ORDER BY used DESC LIMIT -1 OFFSET 9')) this.deleteGrant(old);
    this.sql.exec('INSERT INTO oauth_grants (id, client_id, login, github, created, used, expires) VALUES (?, ?, ?, ?, ?, ?, ?)',id,clientId,login,github,now,now,expires);
    this.sql.exec('DELETE FROM oauth_tokens WHERE grant_id NOT IN (SELECT id FROM oauth_grants)');
  }
  getGrant(id) {
    const [row]=this.rows('SELECT id, client_id, login, github, expires FROM oauth_grants WHERE id = ? AND expires > ?',id,this.now());
    return row?{id:row.id,clientId:row.client_id,login:row.login,github:row.github,expires:row.expires}:null;
  }
  // Replaces the sealed GitHub tokens only if they are still the ones the caller read, so two requests
  // refreshing at once cannot overwrite each other's newer tokens. Returns whether it replaced them.
  replaceGrantGithub(id,previous,github,expires) {
    return this.rows('UPDATE oauth_grants SET github = ?, expires = ? WHERE id = ? AND github = ? RETURNING id',github,expires,id,previous).length>0;
  }
  touchGrant(id) {this.sql.exec('UPDATE oauth_grants SET used = ? WHERE id = ?',this.now(),id);}
  deleteGrant(id) {
    this.sql.exec('DELETE FROM oauth_tokens WHERE grant_id = ?',id);
    this.sql.exec('DELETE FROM oauth_grants WHERE id = ?',id);
  }
  listGrants() {
    return this.rows('SELECT g.id, g.created, g.used, g.expires, c.name, c.redirect_uris FROM oauth_grants g LEFT JOIN oauth_clients c ON c.id = g.client_id WHERE g.expires > ? ORDER BY g.used DESC',this.now())
      .map(r=>({id:r.id,name:r.name||'Unknown app',redirectHost:(()=>{try {return new URL(JSON.parse(r.redirect_uris||'[]')[0]).host;} catch {return null;}})(),created:r.created,used:r.used,expires:r.expires}));
  }
  putToken({hash,grantId,kind,data=null,expires}) {
    this.sql.exec('DELETE FROM oauth_tokens WHERE expires <= ?',this.now());
    this.sql.exec('INSERT INTO oauth_tokens (hash, grant_id, kind, data, expires) VALUES (?, ?, ?, ?, ?)',hash,grantId,kind,data===null?null:JSON.stringify(data),expires);
  }
  getToken(hash,kind) {
    const [row]=this.rows('SELECT grant_id, data FROM oauth_tokens WHERE hash = ? AND kind = ? AND expires > ?',hash,kind,this.now());
    return row?{grantId:row.grant_id,data:row.data?JSON.parse(row.data):null}:null;
  }
  // Codes and refresh tokens are used once: reading one removes it.
  takeToken(hash,kind) {
    const [row]=this.rows('DELETE FROM oauth_tokens WHERE hash = ? AND kind = ? RETURNING grant_id, data, expires',hash,kind);
    return row&&row.expires>this.now()?{grantId:row.grant_id,data:row.data?JSON.parse(row.data):null}:null;
  }

  // Locks expire on their own so a crashed request can never block the chat permanently. Only the
  // holder can release a lock, so a request that outlived its lock cannot free a newer holder's lock.
  acquireLock(name,owner,ms) {
    const now=this.now();
    const [lock]=this.rows('SELECT until FROM locks WHERE name = ?',name);
    if(lock && lock.until>now) return false;
    this.sql.exec('INSERT OR REPLACE INTO locks (name, owner, until) VALUES (?, ?, ?)',name,owner,now+ms);
    return true;
  }
  releaseLock(name,owner) {this.sql.exec('DELETE FROM locks WHERE name = ? AND owner = ?',name,owner);}

  // Short-lived cache of GitHub data shared by all open tabs, which keeps dashboard refreshes cheap.
  getCache(key) {
    const [row]=this.rows('SELECT value FROM cache WHERE key = ? AND expires > ?',key,this.now());
    return row?JSON.parse(row.value):null;
  }
  setCache(key,value,ms) {
    this.sql.exec('DELETE FROM cache WHERE expires <= ?',this.now());
    this.sql.exec('INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)',key,JSON.stringify(value),this.now()+ms);
  }

  // Called before dashboard data is read from GitHub; its result is passed to setDashboardCache.
  startDashboardLoad(repository) {return {version:this.getVersion(repository),started:this.now()};}
  // Dashboard data from GitHub. It is not cached when a webhook moved the repository's version on while it
  // was loading, because it may predate that event. The head commit of each pull request is remembered so
  // check and status events, which name a commit, find their pull request.
  setDashboardCache(key,value,ms,{repository,version,started=this.now(),pull=null}) {
    const repo=repository.toLowerCase();
    // Stale data must not replace a newer head commit either, or later events for it would be missed.
    if(this.getVersion(repo)!==version) return;
    if(pull&&/^[0-9a-f]{40}$/.test(pull.sha||'')) {
      this.sql.exec('INSERT OR REPLACE INTO heads (repository, number, sha) VALUES (?, ?, ?)',repo,pull.number,pull.sha);
      // A check or status event for this commit arrived while it was loaded for the first time: the data
      // may predate it, so it is not cached and open dashboards reload once.
      if(this.rows('DELETE FROM commit_events WHERE repository = ? AND sha = ? AND at >= ? RETURNING sha',repo,pull.sha,started).length) {this.bump(repo);return;}
    }
    this.setCache(key,value,ms);
  }
  bump(repo) {this.sql.exec('INSERT INTO versions (repository, version) VALUES (?, 1) ON CONFLICT (repository) DO UPDATE SET version = version + 1',repo);}

  // GitHub data is cached under keys that start with the repository (`overview:owner/repo`, or with
  // larger limits `overview:owner/repo:<pulls>:<runs>`,
  // `pull:owner/repo:<number>:<updatedAt>`). A webhook event drops the affected entries and moves the
  // repository's version on, which tells open dashboards to reload. Returns null when nothing shown changed.
  invalidate(repository,{overview=false,pulls=[],sha=null,head=false}={}) {
    const repo=repository.toLowerCase(),like=value=>value.replace(/[\\%_]/g,'\\$&');
    const numbers=new Set(pulls);
    if(sha) for(const {number} of this.rows('SELECT number FROM heads WHERE repository = ? AND sha = ?',repo,sha)) numbers.add(number);
    if(!overview&&!head&&!numbers.size) {
      // No loaded pull request has this commit yet; one being loaded right now may, see setDashboardCache.
      if(sha) {
        this.sql.exec('DELETE FROM commit_events WHERE at < ?',this.now()-600000);
        this.sql.exec('INSERT INTO commit_events (repository, sha, at) VALUES (?, ?, ?)',repo,sha,this.now());
      }
      return null;
    }
    if(overview||head) this.sql.exec('DELETE FROM cache WHERE key = ?',`head:${repo}`);
    if(overview) this.sql.exec("DELETE FROM cache WHERE key = ? OR key LIKE ? ESCAPE '\\'",`overview:${repo}`,`overview:${like(repo)}:%`);
    for(const number of numbers) this.sql.exec("DELETE FROM cache WHERE key LIKE ? ESCAPE '\\'",`pull:${like(repo)}:${number}:%`);
    this.bump(repo);
    return this.getVersion(repo);
  }
  getVersion(repository) {return this.rows('SELECT version FROM versions WHERE repository = ?',repository.toLowerCase())[0]?.version||0;}

  createConversation(id,title,repository) {
    const now=this.now();
    this.sql.exec('INSERT INTO conversations (id, title, created, updated, repository) VALUES (?, ?, ?, ?, ?)',id,title,now,now,repository);
  }
  // Conversations of one repository; with home=true also those saved before repositories were recorded.
  listConversations(repository,{home=false,limit=30}={}) {
    return this.rows('SELECT id, title, updated FROM conversations WHERE lower(repository) = lower(?) OR (repository IS NULL AND ?) ORDER BY updated DESC LIMIT ?',repository,home?1:0,limit);
  }
  getConversation(id) {
    const [conversation]=this.rows('SELECT id, title, updated, repository FROM conversations WHERE id = ?',id);
    if(!conversation) return null;
    const messages=this.rows(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation = ? ORDER BY id`,id).map(toMessage);
    return {...conversation,messages};
  }
  addMessage(conversation,{role,content,hasImage=false,proposal=null,meta=null}) {
    const now=this.now();
    const [row]=this.rows('INSERT INTO messages (conversation, role, content, has_image, proposal, meta, created) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',conversation,role,content,hasImage?1:0,proposal?JSON.stringify(proposal):null,meta?JSON.stringify(meta):null,now);
    this.sql.exec('UPDATE conversations SET updated = ? WHERE id = ?',now,conversation);
    return row.id;
  }
  // Saves the owner's message and the agent's answer together, so a failed model call never
  // leaves an unanswered message behind. Creates the conversation on its first exchange.
  saveExchange({conversation,title,repository=null,user,assistant}) {
    if(title!==undefined&&title!==null) this.createConversation(conversation,title,repository);
    else if(!this.rows('SELECT id FROM conversations WHERE id = ?',conversation).length) throw new Error('Conversation not found.');
    return {user:this.addMessage(conversation,{...user,role:'user'}),assistant:this.addMessage(conversation,{...assistant,role:'assistant'})};
  }
  getMessage(conversation,id) {
    const [m]=this.rows(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation = ? AND id = ?`,conversation,id);
    return m?toMessage(m):null;
  }
  getConversationInfo(id) {return this.rows('SELECT title, repository FROM conversations WHERE id = ?',id)[0]||null;}
  setPullRequest(conversation,id,url) {
    this.sql.exec('UPDATE messages SET pr_url = ? WHERE conversation = ? AND id = ? AND pr_url IS NULL',url,conversation,id);
  }
  // Records a Codex review request for this head commit; false when one was already recorded.
  claimCodexRequest(kind,repository,number,sha) {
    const table=CODEX_REQUESTS[kind],repo=repository.toLowerCase();
    if(this.rows(`SELECT 1 FROM ${table} WHERE repository = ? AND number = ? AND sha = ?`,repo,number,sha).length) return false;
    this.sql.exec(`INSERT INTO ${table} (repository, number, sha, at) VALUES (?, ?, ?, ?)`,repo,number,sha,this.now());
    return true;
  }
  hasCodexRequest(kind,repository,number,sha) {return this.rows(`SELECT 1 FROM ${CODEX_REQUESTS[kind]} WHERE repository = ? AND number = ? AND sha = ?`,repository.toLowerCase(),number,sha).length>0;}
  releaseCodexRequest(kind,repository,number,sha) {this.sql.exec(`DELETE FROM ${CODEX_REQUESTS[kind]} WHERE repository = ? AND number = ? AND sha = ?`,repository.toLowerCase(),number,sha);}
  // Whether a pull request was opened from a chat answer, so only its own branch is cleaned up.
  isChatPullRequest(url) {return this.rows('SELECT 1 FROM messages WHERE lower(pr_url) = lower(?) LIMIT 1',url).length>0;}
}
