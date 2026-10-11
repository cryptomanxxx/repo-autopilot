import {DurableObject} from 'cloudflare:workers';
import {ChatStoreLogic} from './store.js';
import {handle} from './app.js';

// One SQLite-backed Durable Object holds sessions, conversations and locks for the single owner.
export class ChatStore extends DurableObject {
  constructor(ctx,env) {super(ctx,env);this.logic=new ChatStoreLogic(ctx.storage.sql);}
  createSession(session) {return this.logic.createSession(session);}
  getSession(hash) {return this.logic.getSession(hash);}
  deleteSession(hash) {return this.logic.deleteSession(hash);}
  acquireLock(name,owner,ms) {return this.logic.acquireLock(name,owner,ms);}
  releaseLock(name,owner) {return this.logic.releaseLock(name,owner);}
  listConversations(repository,options) {return this.logic.listConversations(repository,options);}
  getConversation(id) {return this.logic.getConversation(id);}
  getMessage(conversation,id) {return this.logic.getMessage(conversation,id);}
  getConversationInfo(id) {return this.logic.getConversationInfo(id);}
  saveExchange(exchange) {return this.logic.saveExchange(exchange);}
  setPullRequest(conversation,id,url) {return this.logic.setPullRequest(conversation,id,url);}
  getCache(key) {return this.logic.getCache(key);}
  invalidate(repository,targets) {return this.logic.invalidate(repository,targets);}
  getVersion(repository) {return this.logic.getVersion(repository);}
  setCache(key,value,ms) {return this.logic.setCache(key,value,ms);}
}

export default {fetch:(request,env)=>handle(request,env)};
