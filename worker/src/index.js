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
  isChatPullRequest(url) {return this.logic.isChatPullRequest(url);}
  claimCodexRequest(kind,repository,number,sha) {return this.logic.claimCodexRequest(kind,repository,number,sha);}
  hasCodexRequest(kind,repository,number,sha) {return this.logic.hasCodexRequest(kind,repository,number,sha);}
  releaseCodexRequest(kind,repository,number,sha) {return this.logic.releaseCodexRequest(kind,repository,number,sha);}
  getCache(key) {return this.logic.getCache(key);}
  invalidate(repository,targets) {return this.logic.invalidate(repository,targets);}
  getVersion(repository) {return this.logic.getVersion(repository);}
  setCache(key,value,ms) {return this.logic.setCache(key,value,ms);}
  startDashboardLoad(repository) {return this.logic.startDashboardLoad(repository);}
  setDashboardCache(key,value,ms,options) {return this.logic.setDashboardCache(key,value,ms,options);}
  registerClient(client) {return this.logic.registerClient(client);}
  getClient(id) {return this.logic.getClient(id);}
  putPending(id,data,ms) {return this.logic.putPending(id,data,ms);}
  takePending(id) {return this.logic.takePending(id);}
  createGrant(grant) {return this.logic.createGrant(grant);}
  getGrant(id) {return this.logic.getGrant(id);}
  replaceGrantGithub(id,previous,github,expires) {return this.logic.replaceGrantGithub(id,previous,github,expires);}
  tryRenewal(id,owner,ms) {return this.logic.tryRenewal(id,owner,ms);}
  touchGrant(id) {return this.logic.touchGrant(id);}
  deleteGrant(id) {return this.logic.deleteGrant(id);}
  listGrants() {return this.logic.listGrants();}
  putToken(token) {return this.logic.putToken(token);}
  getToken(hash,kind) {return this.logic.getToken(hash,kind);}
  takeToken(hash,kind) {return this.logic.takeToken(hash,kind);}
}

export default {fetch:(request,env)=>handle(request,env)};
