import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from '../test-browser.mjs';

// Fully intercepted test origin, no workbench page, project or service.
const bundle=await build({stdin:{contents:`
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {installViewerTextureLoader,assertViewerMaterialTextures} from './src/native3d-viewer-textures.js';
window.verify=async(bytes,fixed)=>{
 const manager=new THREE.LoadingManager();
 manager.setURLModifier(url=>{if(/^(blob:|data:)/.test(url))return url;throw Error('external');});
 const loader=new GLTFLoader(manager);
 if(fixed)installViewerTextureLoader(loader,THREE.TextureLoader,manager);
 const gltf=await loader.parseAsync(new Uint8Array(bytes).buffer,'');
 const materials=await gltf.parser.getDependencies('material');
 try{return {channels:assertViewerMaterialTextures(gltf.parser.json.materials,materials),normal:Boolean(materials[0].normalMap),ao:Boolean(materials[0].aoMap)};}
 catch(error){return {error:error.message};}
};`,resolveDir:process.cwd()},bundle:true,write:false,format:'iife'});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const views=[];const parts=[];let offset=0;
for (const part of [Buffer.from(new Float32Array([0,0,0,1,0,0,0,1,0]).buffer),Buffer.from(new Float32Array([0,0,1,0,0,1]).buffer),png,png,png,png]) {
 views.push({buffer:0,byteOffset:offset,byteLength:part.length});const padded=Buffer.alloc(Math.ceil(part.length/4)*4);part.copy(padded);parts.push(padded);offset+=padded.length;
}
const json={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},material:0}]}],
 buffers:[{byteLength:offset}],bufferViews:views,accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[0,0,0],max:[1,1,0]},{bufferView:1,componentType:5126,count:3,type:'VEC2'}],
 images:[2,3,4,5].map(bufferView=>({bufferView,mimeType:'image/png'})),textures:[0,1,2,3].map(source=>({source})),materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0},metallicRoughnessTexture:{index:3}},normalTexture:{index:1},occlusionTexture:{index:2}}]};
const text=Buffer.from(JSON.stringify(json));const jsonChunk=Buffer.alloc(Math.ceil(text.length/4)*4,32);text.copy(jsonChunk);
const binary=Buffer.concat(parts);const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+jsonChunk.length+binary.length,8);
const chunkHeader=(length,type)=>{const result=Buffer.alloc(8);result.writeUInt32LE(length);result.writeUInt32LE(type,4);return result;};
const bytes=[...Buffer.concat([header,chunkHeader(jsonChunk.length,0x4e4f534a),jsonChunk,chunkHeader(binary.length,0x004e4942),binary])];
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage();
 await page.route('**/*',route=>route.fulfill({status:200,contentType:route.request().url().endsWith('/app.js')?'application/javascript':'text/html',body:route.request().url().endsWith('/app.js')?bundle.outputFiles[0].text:`<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; img-src 'self' data: blob:; connect-src 'self'"><script src="/app.js"></script>`}));
 await page.goto('http://viewer-test.invalid/');await page.waitForFunction(()=>Boolean(window.verify));
 const baseline=await page.evaluate(bytes=>window.verify(bytes,false),bytes);
 assert.match(baseline.error,/贴图未完整加载/);
 const fixed=await page.evaluate(bytes=>window.verify(bytes,true),bytes);
 assert.deepEqual(fixed,{channels:5,normal:true,ao:true});
 console.log('Same CSP: default ImageBitmapLoader rejected blob textures; scoped HTML TextureLoader loaded all four images / five material channels including normal and AO.');
} finally {await browser.close();}
