/** Strict bounded preview reconstruction. Inputs are bytes, never URLs or active content. */
import { fail, LIMITS } from './glb.js';

export const MAX_PREVIEW_BYTES=8*1024*1024;
export const PREVIEW_CONTRACT=Object.freeze({
  contractVersion:1,maximumPatchBytes:MAX_PREVIEW_BYTES,maximumChanges:65536,maximumTargetBytes:LIMITS.glbBytes,
  maximumAssetIdLength:128,maximumUrlLength:256,maximumReasonLength:256,
  hashPattern:'^[a-f0-9]{64}$',urlPattern:'^/api/(assets/[A-Za-z0-9_-]+\\.glb|previews/[a-f0-9]{64}\\.json)$',
  descriptorFields:Object.freeze(['contractVersion','kind','baseAssetId','targetAssetId','baseSha256','targetSha256','targetBytes','bytes','sha256','url','reason']),
  patchFields:Object.freeze(['contractVersion','kind','baseSha256','targetSha256','targetBytes','changes']),
  changeFields:Object.freeze(['offset','base64']),kinds:Object.freeze(['snapshot','mesh-delta','instance-delta']),
});
const HASH=new RegExp(PREVIEW_CONTRACT.hashPattern),URL=new RegExp(PREVIEW_CONTRACT.urlPattern);
const isHash=value=>typeof value==='string'&&HASH.test(value);
function check(value,message,code='INVALID_PREVIEW'){if(!value)fail(code,message);}
function object(value,allowed,required=allowed){
  check(value!==null&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null),'Expected plain preview object.');
  check(Object.keys(value).every(k=>allowed.includes(k))&&required.every(k=>Object.hasOwn(value,k)),'Unknown or missing preview fields.');
}
function bytes(value,maximum){check(value instanceof ArrayBuffer&&value.byteLength>0&&value.byteLength<=maximum,'Preview byte budget exceeded.','BUDGET_EXCEEDED');return new Uint8Array(value);}
async function digest(value){check(globalThis.crypto?.subtle,'SHA-256 is unavailable.');return [...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function descriptor(value){
  object(value,PREVIEW_CONTRACT.descriptorFields,PREVIEW_CONTRACT.descriptorFields.filter(k=>k!=='reason'));
  check(value.contractVersion===PREVIEW_CONTRACT.contractVersion&&PREVIEW_CONTRACT.kinds.includes(value.kind),'Unsupported preview contract.');
  check(isHash(value.sha256)&&isHash(value.targetSha256)&&(value.baseSha256===null||isHash(value.baseSha256)),'Invalid preview digest.');
  check(typeof value.targetAssetId==='string'&&value.targetAssetId.length>0&&value.targetAssetId.length<=PREVIEW_CONTRACT.maximumAssetIdLength&&(value.baseAssetId===null||typeof value.baseAssetId==='string'&&value.baseAssetId.length>0&&value.baseAssetId.length<=PREVIEW_CONTRACT.maximumAssetIdLength),'Invalid preview asset identity.');
  check(Number.isSafeInteger(value.targetBytes)&&value.targetBytes>=20&&value.targetBytes<=LIMITS.glbBytes,'Target byte budget exceeded.','BUDGET_EXCEEDED');
  check(Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=(value.kind==='snapshot'?LIMITS.glbBytes:MAX_PREVIEW_BYTES),'Transport byte budget exceeded.','BUDGET_EXCEEDED');
  check(typeof value.url==='string'&&value.url.length<=PREVIEW_CONTRACT.maximumUrlLength&&URL.test(value.url),'Invalid preview URL.');
  check(value.kind==='snapshot'?Object.hasOwn(value,'reason')&&typeof value.reason==='string'&&value.reason.length<=PREVIEW_CONTRACT.maximumReasonLength:!Object.hasOwn(value,'reason'),'Invalid snapshot reason.');
  if(value.kind==='snapshot')check(value.bytes===value.targetBytes&&value.sha256===value.targetSha256,'Snapshot identity mismatch.');
  else check(value.baseAssetId!==null&&value.baseSha256!==null&&value.bytes<value.targetBytes,'Delta requires a base and must reduce transport.');
}
/** Returns an independent verified target ArrayBuffer; a failed patch never mutates base. */
export async function reconstructPreview(base,description,transport){
  descriptor(description);description={...description};
  const input=bytes(transport,description.kind==='snapshot'?LIMITS.glbBytes:MAX_PREVIEW_BYTES).slice();
  const original=description.kind==='snapshot'?null:bytes(base,LIMITS.glbBytes).slice();
  check(input.byteLength===description.bytes,'Preview transport length mismatch.');
  check(await digest(input)===description.sha256,'Preview transport digest mismatch.','PREVIEW_HASH_MISMATCH');
  if(description.kind==='snapshot')return input.buffer;
  check(original.byteLength===description.targetBytes,'Preview base size mismatch.','PREVIEW_BASE_MISMATCH');
  check(await digest(original)===description.baseSha256,'Preview base digest mismatch.','PREVIEW_BASE_MISMATCH');
  let patch;
  try{patch=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input));}catch{fail('INVALID_PREVIEW','Invalid preview UTF-8 JSON.');}
  object(patch,PREVIEW_CONTRACT.patchFields);
  for(const key of ['contractVersion','kind','baseSha256','targetSha256','targetBytes'])check(patch[key]===description[key],'Patch and descriptor disagree.');
  check(Array.isArray(patch.changes)&&patch.changes.length>0&&patch.changes.length<=PREVIEW_CONTRACT.maximumChanges,'Patch range budget exceeded.','BUDGET_EXCEEDED');
  const target=original;let end=0,total=0;
  for(const change of patch.changes){
    object(change,PREVIEW_CONTRACT.changeFields);
    check(Number.isSafeInteger(change.offset)&&change.offset>=end&&change.offset<target.length,'Patch ranges overlap or exceed target.');
    const encoded=change.base64;
    check(typeof encoded==='string'&&encoded.length>0&&encoded.length<=Math.ceil(MAX_PREVIEW_BYTES/3)*4&&encoded.length%4===0&&!/[^A-Za-z0-9+/=]/.test(encoded),'Invalid patch base64.');
    let decoded;try{decoded=atob(encoded);}catch{fail('INVALID_PREVIEW','Invalid patch base64.');}
    check(btoa(decoded)===encoded,'Noncanonical patch base64.');
    total+=decoded.length;check(total<=MAX_PREVIEW_BYTES&&change.offset+decoded.length<=target.length,'Patch decoded byte budget exceeded.','BUDGET_EXCEEDED');
    for(let i=0;i<decoded.length;i++)target[change.offset+i]=decoded.charCodeAt(i);
    end=change.offset+decoded.length;
  }
  check(await digest(target)===description.targetSha256,'Preview target digest mismatch.','PREVIEW_HASH_MISMATCH');
  return target.buffer;
}
