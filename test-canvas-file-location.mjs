import assert from 'node:assert/strict';
import {nodeFileLocation, revealProjectAsset} from './src/canvas-file-location.js';

const assetPath = `assets/${'a'.repeat(64)}.png`;
const replacement = {data:{assetPath,output:true,filename:'old-output.png',subfolder:'old',remoteName:'old-input.png'}};
assert.deepEqual(nodeFileLocation(replacement,'prj_current'),{kind:'project',projectId:'prj_current',assetPath});
assert.equal(nodeFileLocation(replacement),null,'an asset must never fall back to stale Comfy metadata');
assert.deepEqual(nodeFileLocation({data:{output:true,filename:'saved.mp4',subfolder:'video'}}),{kind:'output',name:'video/saved.mp4'});
assert.deepEqual(nodeFileLocation({data:{remoteName:'workbench/upload.png'}}),{kind:'input',name:'workbench/upload.png'});
assert.deepEqual(nodeFileLocation({data:{resultUrl:'/api/comfy/view?filename=frame.png&subfolder=images&type=temp'}},null,'http://localhost'),{kind:'temp',name:'images/frame.png'});
assert.equal(nodeFileLocation({data:{resultUrl:'http://['}}),null);
assert.equal(nodeFileLocation({data:{}}),null);
let requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({url,options});
  return {ok:true,json:async()=>({ok:true})};
};
assert.deepEqual(await revealProjectAsset({kind:'project',projectId:'prj_current',assetPath}),{ok:true});
assert.equal(requests[0].url,'/api/projects/prj_current/assets/reveal');
assert.equal(requests[0].options.method,'POST');
assert.deepEqual(JSON.parse(requests[0].options.body),{assetPath});
globalThis.fetch = async () => ({ok:false,json:async()=>({message:'素材不存在。'})});
await assert.rejects(revealProjectAsset({projectId:'prj_current',assetPath}),/素材不存在/);
console.log('CANVAS_FILE_LOCATION_OK asset-priority/comfy-fallbacks/project-scoped-request/no-real-fetch');
