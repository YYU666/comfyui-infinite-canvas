import assert from 'node:assert/strict';
import {installViewerTextureLoader,assertViewerMaterialTextures} from '../src/native3d-viewer-textures.js';
let plugin;
const manager={};
const parser={json:{images:[{bufferView:0,mimeType:'image/png'}]}};
class ImageTextureLoader {constructor(value){assert.equal(value,manager);this.htmlImagePath=true;}}
const loader={register(callback){plugin=callback(parser);}};
assert.equal(installViewerTextureLoader(loader,ImageTextureLoader,manager),loader);
assert.equal(parser.textureLoader.htmlImagePath,true);plugin.beforeRoot();
parser.json.images=[{uri:'https://example.com/texture.png'}];assert.throws(()=>plugin.beforeRoot(),/外部资源/);
parser.json.images=[{uri:'blob:http://localhost/unrelated'}];assert.throws(()=>plugin.beforeRoot(),/外部资源/);
parser.json.images=[{uri:'data:image/png;base64,aA=='}];plugin.beforeRoot();
const definitions=[{pbrMetallicRoughness:{baseColorTexture:{index:0},metallicRoughnessTexture:{index:3}},normalTexture:{index:1},occlusionTexture:{index:2}}];
const texture={isTexture:true,image:{naturalWidth:1024,naturalHeight:1024}};
const material={map:texture,normalMap:texture,aoMap:texture,metalnessMap:texture,roughnessMap:texture};
assert.equal(assertViewerMaterialTextures(definitions,[material]),5);
for (const slot of Object.keys(material)) assert.throws(()=>assertViewerMaterialTextures(definitions,[{...material,[slot]:null}]),new RegExp(slot));
assert.throws(()=>assertViewerMaterialTextures(definitions,[{...material,normalMap:{isTexture:true,image:{width:0}}}]),/normalMap/);
console.log('Viewer embedded HTML image loader, external resource guard, all bake texture channels and partial failure rejection passed');
