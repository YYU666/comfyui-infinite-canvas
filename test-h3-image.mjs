import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { buildImageWorkflow, buildQwen21EditWorkflow, extractImages } from './src/workbench-api.js';
import { H3_IMAGE_MODEL, resolveH3ImageDimensions, getH3ImageDependencyStatus } from './src/h3-image.js';
import { bindQwenPrompt } from './src/qwen-references.js';
const base = { prompt: 'A red ceramic cup on a table', seed: 0, imageLora: 'none' };
const text = buildImageWorkflow({ ...base, mode: 'image', imageModel: 'h3_image', ratio: '1:1' });
assert.equal(text.sample.inputs.seed, 0);
assert.equal(text.sample.inputs.steps, 6); assert.equal(text.sample.inputs.cfg, 1);
assert.equal(text.positive.inputs.prompt, base.prompt); assert.equal(text.text.inputs.type, 'minimax');
assert.deepEqual([text.positive.inputs.width, text.positive.inputs.height], [2048,2048]);
assert.equal(text.vae.inputs.vae_name, H3_IMAGE_MODEL.vae);
assert.deepEqual(text.sample.inputs.latent_image, ['positive',1]);
assert.ok(!Object.values(text).some(n=>['CLIPTextEncode','TextGenerate'].includes(n.class_type)));
for (const resolution of ['4MP','16MP']) for (const ratio of ['1:1','16:9','9:16','4:3','3:4','21:9']) {
 const [w,h] = resolveH3ImageDimensions(ratio,resolution); const area = (resolution==='4MP'?4:16)*1024**2;
 assert.equal(w%32,0);assert.equal(h%32,0);assert.ok(w*h>=area && w*h<area*1.04);
}
const refs = [{id:'a',kind:'image',name:'a.png'},{id:'b',kind:'image',name:'b.png'}];
const prompt = bindQwenPrompt('Keep 图1 and borrow colors from 图2.',refs);
const edit = buildQwen21EditWorkflow({...base,qwenModel:'h3_image',prompt,references:refs,qwenReferenceOrder:['b','a']});
assert.equal(edit.reference_1.inputs.image,'b.png');assert.equal(edit.reference_2.inputs.image,'a.png');
assert.equal(edit.positive.inputs.prompt,'Keep <Picture 2> and borrow colors from <Picture 1>.');
assert.deepEqual(edit.positive.inputs['images.image_1'],['reference_1',0]);
assert.equal(edit.output_size.inputs.megapixels,4);assert.equal(edit.output_size.inputs.resolution_steps,32);
assert.deepEqual(edit.positive.inputs.width,['size',0]);
const edit16=buildQwen21EditWorkflow({...base,qwenModel:'h3_image',references:refs,h3ImageResolution:'16MP'});
assert.equal(edit16.output_size.inputs.megapixels,16);
for (const bad of [{references:[]},{imageLora:'realism'},{qwenMaskCrop:true},{qwenSourceCrop:{}},{seed:-1},{seed:0.1},{h3ImageResolution:'1MP'},{references:[{...refs[0],name:''}]},{references:[{...refs[0],slot:'mask'}]}]) {
 assert.throws(()=>buildQwen21EditWorkflow({...base,qwenModel:'h3_image',references:refs,...bad}));
}
assert.throws(()=>buildQwen21EditWorkflow({...base,qwenModel:'h3_image',prompt:'Use 图3',references:refs}),/未连接/);
assert.throws(()=>buildQwen21EditWorkflow({...base,qwenModel:'h3_image',references:[refs[0],refs[0]]}),/重复/);
const files=extractImages({outputs:{save:{images:[{filename:'H3_Image_Edit_00001_.png',subfolder:'image',type:'output'}]}}});
assert.equal(files.length,1);assert.match(files[0].url,/^\/api\/comfy\/view/);
const originalFetch=globalThis.fetch;
try {
 let absent;
 globalThis.fetch=async url=>({ok:true,json:async()=>{
  const name=url.split('/').at(-1); if(name===absent)return {};
  return {[name]:{input:{required:name==='UNETLoader'?{unet_name:[[H3_IMAGE_MODEL.unet]]}:name==='CLIPLoader'?{clip_name:[[H3_IMAGE_MODEL.clip]],type:[['minimax']]}:name==='VAELoader'?{vae_name:[[H3_IMAGE_MODEL.vae]]}:{}}}};
 }});
 for (const graph of [text,edit]) {
  assert.equal((await getH3ImageDependencyStatus(graph)).ready,true);
  for (const name of new Set(Object.values(graph).map(n=>n.class_type))) {absent=name;assert.ok((await getH3ImageDependencyStatus(graph)).missing.includes(`ComfyUI 节点 ${name}`));}
  absent=undefined;
 }
 globalThis.fetch=async()=>({ok:true,json:async()=>({})});assert.equal((await getH3ImageDependencyStatus(text)).ready,false);
 globalThis.fetch=async()=>({ok:false,status:503});await assert.rejects(getH3ImageDependencyStatus(text),/ComfyUI 在线/);
} finally {globalThis.fetch=originalFetch;}
await mkdir('.cache/h3-image',{recursive:true});await writeFile('.cache/h3-image/graphs.json',JSON.stringify({text,edit,edit16},null,2));
console.log('H3_IMAGE_OK native T2I/edit graphs, ordered refs, 4/16MP, incompatible settings, dependency errors, output paths');
