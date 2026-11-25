import assert from 'node:assert/strict';
import { planCanvasConnection } from './src/canvas-connections.js';
import { nativeInputs } from './src/native3d-plan.js';
import { nativeRunIdentity } from './src/native3d.js';

const glb = { id:'glb',type:'media',data:{output:true,kind:'model',name:'pixal.glb',
  type:'output',url:'/api/comfy/view?filename=pixal.glb&type=output'} };
const lod = { id:'lod',type:'native3d',data:{operation:'source_lod',nativeParameters:{lodCount:1}} };
const link = {source:glb.id,target:lod.id,sourceHandle:'model',targetHandle:'model'};
assert.equal(planCanvasConnection(link,[glb,lod],[]).error,undefined);
assert.ok(planCanvasConnection({...link,targetHandle:'high'},[glb,lod],[]).error);
assert.ok(planCanvasConnection(link,[{...glb,data:{...glb.data,url:'https://invalid.example/a.glb'}},lod],[]).error);
glb.data.assetPath = 'assets/'+'a'.repeat(64)+'.glb';
const saved = JSON.parse(JSON.stringify({nodes:[glb,lod],edges:[link]}));
const inputs = nativeInputs(saved.nodes[1],saved.nodes,saved.edges);
assert.equal(inputs.model.data.assetPath,glb.data.assetPath);
const initial = nativeRunIdentity(lod,inputs.model,inputs);
lod.data.nativeParameters.lodCount = 2;
assert.notEqual(nativeRunIdentity(lod,inputs.model,inputs),initial);

const image = { id:'chest-reference', type:'media', data:{ kind:'image', assetPath:'assets/'+'b'.repeat(64)+'.png' } };
const generator = { id:'local-generator', type:'native3d', data:{ operation:'image_to_3d' } };
const imageEdge = { source:image.id, target:generator.id, sourceHandle:'ref', targetHandle:'image' };
assert.deepEqual(planCanvasConnection(imageEdge,[image,generator],[]).connection,imageEdge);
assert.equal(nativeInputs(generator,[image,generator],[imageEdge]).image.data.assetPath,image.data.assetPath);
assert.ok(planCanvasConnection({ ...imageEdge, targetHandle:'model' },[image,generator],[]).error);
assert.ok(planCanvasConnection(imageEdge,[{ ...image, data:{ ...image.data, mediaRole:'mask' } },generator],[]).error);

const baked = { id:'bake-output', type:'native3d', data:{ operation:'analyze', assetPath:glb.data.assetPath,
  metadata:{operation:'bake'}, sourceJobId:'n3d_'+'1'.repeat(32) } };
const wear = { id:'wear', type:'native3d', data:{ operation:'material_wear' } };
const wearEdge = { source:baked.id, target:wear.id, sourceHandle:'model', targetHandle:'model' };
assert.deepEqual(planCanvasConnection(wearEdge,[baked,wear],[]).connection,wearEdge);
assert.ok(planCanvasConnection(wearEdge,[{ ...baked, data:{ ...baked.data, metadata:{operation:'uv'} } },wear],[]).error);
