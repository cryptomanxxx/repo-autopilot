import {createHash} from 'node:crypto';
import {validateStatusShape} from './dare-status-shape.js';
export {STATUS_PATH} from './dare-status-shape.js';
export function gitBlobSha(bytes){return createHash('sha1').update('blob '+bytes.byteLength+'\0').update(bytes).digest('hex');}
export function validateDareStatus(bytes,options={}){
  if(!(bytes instanceof Uint8Array)||bytes.byteLength===0||bytes.byteLength>65536)throw new TypeError('Invalid DARE status: byte size');
  return validateStatusShape(bytes,{...options,computedBlobSha:gitBlobSha(bytes)});
}
