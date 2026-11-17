import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { reconstructPreview, MAX_PREVIEW_BYTES, PREVIEW_CONTRACT } from './pcg_demo_viewer/preview-stream.js';
import { parseGlb } from './pcg_demo_viewer/glb.js';

const hash=value=>createHash('sha256').update(new Uint8Array(value)).digest('hex');
const encode=value=>new TextEncoder().encode(JSON.stringify(value)).buffer;
function fixture(){
  const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{name:'point:0',mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},mode:0}]}],buffers:[{byteLength:4096}],bufferViews:[{buffer:0,byteOffset:0,byteLength:12}],accessors:[{bufferView:0,componentType:5126,count:1,type:'VEC3'}]};
  const text=new TextEncoder().encode(JSON.stringify(json)),size=Math.ceil(text.length/4)*4,buffer=new ArrayBuffer(28+size+4096),header=new DataView(buffer),bytes=new Uint8Array(buffer);
  header.setUint32(0,0x46546c67,true);header.setUint32(4,2,true);header.setUint32(8,buffer.byteLength,true);header.setUint32(12,size,true);header.setUint32(16,0x4e4f534a,true);bytes.fill(32,20,20+size);bytes.set(text,20);header.setUint32(20+size,4096,true);header.setUint32(24+size,0x004e4942,true);
  return {buffer,offset:28+size};
}
function patchFixture(kind='mesh-delta'){
  const {buffer:base,offset}=fixture(),target=base.slice(0);new DataView(target).setFloat32(offset,1.5,true);
  const patch={contractVersion:1,kind,baseSha256:hash(base),targetSha256:hash(target),targetBytes:target.byteLength,changes:[{offset,base64:Buffer.from(target,offset,4).toString('base64')}]};
  const transport=encode(patch),descriptor={contractVersion:1,kind,baseAssetId:'base',targetAssetId:'target',baseSha256:patch.baseSha256,targetSha256:patch.targetSha256,targetBytes:target.byteLength,bytes:transport.byteLength,sha256:hash(transport),url:`/api/previews/${hash(transport)}.json`};
  return {base,target,patch,transport,descriptor};
}
function payload(f,edit){const patch=structuredClone(f.patch);edit(patch);const transport=encode(patch);return {transport,descriptor:{...f.descriptor,bytes:transport.byteLength,sha256:hash(transport)}};}
const rejects=(f,code)=>assert.rejects(reconstructPreview(f.base,f.descriptor,f.transport),e=>e.code===code);

test('bounded mesh and instance transport reconstruct exact independently owned GLB bytes',async()=>{
  for(const kind of ['mesh-delta','instance-delta']){
    const f=patchFixture(kind),before=f.base.slice(0),result=await reconstructPreview(f.base,f.descriptor,f.transport);
    assert.deepEqual(result,f.target);assert.deepEqual(f.base,before);assert.notEqual(result,f.base);
    assert.equal(parseGlb(result).meshes[0].primitives[0].positions[0],1.5);assert.ok(f.transport.byteLength<f.target.byteLength);
  }
});
test('full snapshot verifies byte count and hash without requiring a base',async()=>{
  const {buffer}=fixture(),descriptor={contractVersion:1,kind:'snapshot',baseAssetId:null,targetAssetId:'a',baseSha256:null,targetSha256:hash(buffer),targetBytes:buffer.byteLength,bytes:buffer.byteLength,sha256:hash(buffer),url:'/api/assets/a.glb',reason:'no_base'};
  const result=await reconstructPreview(null,descriptor,buffer);assert.deepEqual(result,buffer);assert.notEqual(result,buffer);assert.equal(parseGlb(result).metrics.pointCount,1);
  await rejects({base:null,descriptor:{...descriptor,bytes:descriptor.bytes-1},transport:buffer},'INVALID_PREVIEW');
});
test('wrong base, corrupt transport and wrong reconstructed target fail closed',async()=>{
  const f=patchFixture();const wrong=f.base.slice(0);new Uint8Array(wrong)[40]^=1;
  await rejects({...f,base:wrong},'PREVIEW_BASE_MISMATCH');await rejects({...f,base:f.base.slice(4)},'PREVIEW_BASE_MISMATCH');
  const corrupted=f.transport.slice(0);new Uint8Array(corrupted)[10]^=1;await rejects({...f,transport:corrupted},'PREVIEW_HASH_MISMATCH');
  const mismatch=payload(f,p=>p.changes[0].base64='AAAAAA==');await rejects({...f,...mismatch},'PREVIEW_HASH_MISMATCH');
  assert.equal(parseGlb(f.base).meshes[0].primitives[0].positions[0],0);
});
test('strict contracts reject unknown versions, fields, disagreeing identities and malformed UTF-8 JSON',async()=>{
  const f=patchFixture();
  for(const descriptor of [{...f.descriptor,contractVersion:2},{...f.descriptor,extra:true},{...f.descriptor,kind:'unbounded'},{...f.descriptor,sha256:'bad'},{...f.descriptor,baseSha256:null},{...f.descriptor,reason:'delta reason'}])await rejects({...f,descriptor},'INVALID_PREVIEW');
  for(const edit of [p=>p.extra=true,p=>p.contractVersion=2,p=>p.targetBytes++,p=>p.kind='instance-delta',p=>delete p.baseSha256])await rejects({...f,...payload(f,edit)},'INVALID_PREVIEW');
  const transport=Uint8Array.from([255,255,0]).buffer;await rejects({...f,transport,descriptor:{...f.descriptor,bytes:3,sha256:hash(transport)}},'INVALID_PREVIEW');
});
test('patch ranges are sorted, nonoverlapping, canonical and bounded before target write',async()=>{
  const f=patchFixture();
  for(const changes of [
    [{offset:-1,base64:'AAAAAA=='}],[{offset:1.5,base64:'AAAAAA=='}],[{offset:f.base.byteLength,base64:'AAAAAA=='}],
    [{offset:f.base.byteLength-1,base64:'AAAAAA=='}],[f.patch.changes[0],f.patch.changes[0]],
    [{offset:100,base64:'AAAAAA=='},{offset:1,base64:'AAAAAA=='}],
    [{offset:0,base64:''}],[{offset:0,base64:'AAAA$==='}],[{offset:0,base64:'AB=='}],[{offset:0,base64:'AA'}],
  ])await assert.rejects(reconstructPreview(f.base,payload(f,p=>p.changes=changes).descriptor,payload(f,p=>p.changes=changes).transport));
  await rejects({...f,...payload(f,p=>p.changes=[])},'BUDGET_EXCEEDED');
  await rejects({...f,descriptor:{...f.descriptor,bytes:MAX_PREVIEW_BYTES+1}},'BUDGET_EXCEEDED');
  await rejects({...f,descriptor:{...f.descriptor,targetBytes:64*1024*1024+1}},'BUDGET_EXCEEDED');
  await rejects({...f,descriptor:{...f.descriptor,bytes:f.base.byteLength}},'INVALID_PREVIEW');
});
test('caller mutation across async digest cannot change verified input or descriptor',async()=>{
  const f=patchFixture(),promise=reconstructPreview(f.base,f.descriptor,f.transport);new Uint8Array(f.base).fill(0);new Uint8Array(f.transport).fill(0);f.descriptor.targetSha256='0'.repeat(64);
  assert.deepEqual(await promise,f.target);
});


test('machine preview contract fields, kinds, bounds and version match runtime validators',()=>{
  const contract=JSON.parse(readFileSync(new URL('./pcg/preview-stream-v1.json',import.meta.url),'utf8'));
  for(const key of ['contractVersion','maximumPatchBytes','maximumChanges','descriptorFields','patchFields','changeFields','kinds'])assert.deepEqual(PREVIEW_CONTRACT[key],contract[key],key);
  const descriptor=contract.descriptorSchema,patch=contract.patchSchema,properties=descriptor.properties;
  assert.deepEqual(Object.keys(properties),PREVIEW_CONTRACT.descriptorFields);
  assert.deepEqual(descriptor.required,PREVIEW_CONTRACT.descriptorFields.filter(k=>k!=='reason'));assert.equal(descriptor.additionalProperties,false);
  assert.deepEqual(Object.keys(patch.properties),PREVIEW_CONTRACT.patchFields);assert.deepEqual(patch.required,PREVIEW_CONTRACT.patchFields);assert.equal(patch.additionalProperties,false);
  assert.deepEqual(Object.keys(patch.properties.changes.items.properties),PREVIEW_CONTRACT.changeFields);assert.deepEqual(patch.properties.changes.items.required,PREVIEW_CONTRACT.changeFields);assert.equal(patch.properties.changes.items.additionalProperties,false);
  assert.equal(properties.contractVersion.const,PREVIEW_CONTRACT.contractVersion);assert.equal(patch.properties.contractVersion.const,PREVIEW_CONTRACT.contractVersion);
  assert.deepEqual(properties.kind.enum,PREVIEW_CONTRACT.kinds);assert.deepEqual(patch.properties.kind.enum,PREVIEW_CONTRACT.kinds.filter(k=>k!=='snapshot'));
  assert.equal(properties.targetAssetId.maxLength,PREVIEW_CONTRACT.maximumAssetIdLength);assert.equal(properties.baseAssetId.anyOf[0].maxLength,PREVIEW_CONTRACT.maximumAssetIdLength);
  assert.equal(properties.url.maxLength,PREVIEW_CONTRACT.maximumUrlLength);assert.equal(properties.reason.maxLength,PREVIEW_CONTRACT.maximumReasonLength);assert.equal(properties.url.pattern,PREVIEW_CONTRACT.urlPattern);
  for(const property of [properties.targetSha256,properties.sha256,properties.baseSha256.anyOf[0],patch.properties.baseSha256,patch.properties.targetSha256])assert.equal(property.pattern,PREVIEW_CONTRACT.hashPattern);
  for(const property of [properties.targetBytes,properties.bytes,patch.properties.targetBytes])assert.equal(property.maximum,PREVIEW_CONTRACT.maximumTargetBytes);
  assert.equal(patch.properties.changes.maxItems,PREVIEW_CONTRACT.maximumChanges);assert.equal(patch.properties.changes.items.properties.offset.maximum,PREVIEW_CONTRACT.maximumTargetBytes-1);
  assert.equal(patch.properties.changes.items.properties.base64.maxLength,Math.ceil(PREVIEW_CONTRACT.maximumPatchBytes/3)*4);
  assert.deepEqual(descriptor.allOf[0].then.required,['reason']);assert.deepEqual(descriptor.allOf[0].else.not.required,['reason']);assert.equal(descriptor.allOf[0].else.properties.bytes.maximum,PREVIEW_CONTRACT.maximumPatchBytes);
});
test('managed URL and identity bounds enforce descriptor schema with required snapshot reason',async()=>{
  const f=patchFixture();
  for(const descriptor of [
    {...f.descriptor,targetAssetId:'x'.repeat(129)},{...f.descriptor,baseAssetId:'x'.repeat(129)},
    {...f.descriptor,url:'https://outside.invalid/model.glb'},{...f.descriptor,url:'/api/previews/test.json'},
    {...f.descriptor,url:'/api/assets/../../secret.glb'},{...f.descriptor,url:'/api/assets/'+ 'x'.repeat(256)+'.glb'},
  ])await rejects({...f,descriptor},'INVALID_PREVIEW');
  const longIds={...f.descriptor,targetAssetId:'x'.repeat(128),baseAssetId:'y'.repeat(128)};assert.deepEqual(await reconstructPreview(f.base,longIds,f.transport),f.target);
  const snapshot={contractVersion:1,kind:'snapshot',baseAssetId:null,targetAssetId:'a',baseSha256:null,targetSha256:hash(f.base),targetBytes:f.base.byteLength,bytes:f.base.byteLength,sha256:hash(f.base),url:'/api/assets/a.glb'};
  await rejects({base:null,descriptor:snapshot,transport:f.base},'INVALID_PREVIEW');
  assert.deepEqual(await reconstructPreview(null,{...snapshot,reason:''},f.base),f.base);
});
