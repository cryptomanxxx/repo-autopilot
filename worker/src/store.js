// Storage logic for the single chat Durable Object. It only uses the synchronous SQL API
// (`sql.exec(query, ...bindings)` returning a cursor with `toArray()`), so every method runs
// atomically inside the Durable Object and can be tested with any SQLite adapter.
const HOUR=3600000;
const MESSAGE_COLUMNS='id, role, content, has_image, proposal, pr_url, created';
const toMessage=m=>({id:m.id,role:m.role,content:m.content,hasImage:Boolean(m.has_image),proposal:m.proposal?JSON.parse(m.proposal):null,prUrl:m.pr_url||null,created:m.created});

export class ChatStoreLogic {
  constructor(sql,now=Date.now) {
    this.sql=sql;this.now=now;
    sql.exec(`CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, token TEXT NOT NULL, csrf TEXT NOT NULL, login TEXT NOT NULL, expires INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, has_image INTEGER NOT NULL DEFAULT 0, proposal TEXT, pr_url TEXT, created INTEGER NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation, id)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS locks (name TEXT PRIMARY KEY, owner TEXT NOT NULL, until INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)`);
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

  createConversation(id,title) {
    const now=this.now();
    this.sql.exec('INSERT INTO conversations (id, title, created, updated) VALUES (?, ?, ?, ?)',id,title,now,now);
  }
  listConversations(limit=30) {
    return this.rows('SELECT id, title, updated FROM conversations ORDER BY updated DESC LIMIT ?',limit);
  }
  getConversation(id) {
    const [conversation]=this.rows('SELECT id, title, updated FROM conversations WHERE id = ?',id);
    if(!conversation) return null;
    const messages=this.rows(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation = ? ORDER BY id`,id).map(toMessage);
    return {...conversation,messages};
  }
  addMessage(conversation,{role,content,hasImage=false,proposal=null}) {
    const now=this.now();
    const [row]=this.rows('INSERT INTO messages (conversation, role, content, has_image, proposal, created) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',conversation,role,content,hasImage?1:0,proposal?JSON.stringify(proposal):null,now);
    this.sql.exec('UPDATE conversations SET updated = ? WHERE id = ?',now,conversation);
    return row.id;
  }
  // Saves the owner's message and the agent's answer together, so a failed model call never
  // leaves an unanswered message behind. Creates the conversation on its first exchange.
  saveExchange({conversation,title,user,assistant}) {
    if(title!==undefined&&title!==null) this.createConversation(conversation,title);
    else if(!this.rows('SELECT id FROM conversations WHERE id = ?',conversation).length) throw new Error('Conversation not found.');
    return {user:this.addMessage(conversation,{...user,role:'user'}),assistant:this.addMessage(conversation,{...assistant,role:'assistant'})};
  }
  getMessage(conversation,id) {
    const [m]=this.rows(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation = ? AND id = ?`,conversation,id);
    return m?toMessage(m):null;
  }
  getTitle(id) {return this.rows('SELECT title FROM conversations WHERE id = ?',id)[0]?.title||null;}
  setPullRequest(conversation,id,url) {
    this.sql.exec('UPDATE messages SET pr_url = ? WHERE conversation = ? AND id = ? AND pr_url IS NULL',url,conversation,id);
  }
}
