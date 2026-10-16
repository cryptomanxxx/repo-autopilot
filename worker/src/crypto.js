// Small crypto helpers shared by sign-in and the Claude/ChatGPT connector.
const encoder=new TextEncoder();
export const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export const randomHex=(bytes=32)=>hex(crypto.getRandomValues(new Uint8Array(bytes)));
export const base64url=bytes=>{let s='';for(const b of bytes) s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};
export const fromBase64url=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export const sha256=async text=>new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text)));

// Keys are derived from the GitHub client secret, one per purpose, so a value sealed for one purpose
// cannot be opened as another.
const keys=new Map();
async function key(secret,purpose) {
  const id=`${purpose}\n${secret}`;
  if(keys.has(id)) return keys.get(id);
  const base=await crypto.subtle.importKey('raw',encoder.encode(secret),'HKDF',false,['deriveKey']);
  const derived=await crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('repo-autopilot-chat'),info:encoder.encode(purpose)},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  keys.set(id,derived);return derived;
}
export async function seal(secret,purpose,value) {
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const sealed=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(secret,purpose),encoder.encode(JSON.stringify(value))));
  const out=new Uint8Array(12+sealed.length);out.set(iv);out.set(sealed,12);
  return base64url(out);
}
export async function unseal(secret,purpose,value,maxLength=4096) {
  try {
    if(typeof value!=='string'||value.length>maxLength) return null;
    const bytes=fromBase64url(value);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12)},await key(secret,purpose),bytes.subarray(12))));
  } catch {return null;}
}
// Sealed values that expire, such as the OAuth state of a sign-in in progress.
export const sealState=(secret,value)=>seal(secret,'oauth-state',value);
export async function openState(secret,value,now) {
  const data=await unseal(secret,'oauth-state',value,1024);
  return data&&data.expires>now?data:null;
}
