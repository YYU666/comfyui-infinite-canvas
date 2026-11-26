import assert from 'node:assert/strict';
import {boundaryFailure,lodResolution,currentLODTitle,nextDraftNotice} from './src/native3d-lod-resolution.js';
const blocker='Original boundary distance exceeds independent shape budget: 0.13000602875043651 > 0.0813890537313383';
const data={title:'LOD4 · 待生成',operation:'source_lod',status:'completed',nativeJobId:'real',nativeNextStep:{action:'next_lod'},nativeParameters:{retryStage:'lod4'},nativeNextStepNotice:'已创建，点击生成',metadata:{geometry:{status:'blocked',blocker,retry:{retryStage:'lod4'},targetPolicy:{percentageReference:'lod0',percentageBaseTriangles:99999,parentTriangleLimit:2499,requestedKeepPercent:1.25,effectiveTargetTriangles:1249,frozenFaceCap:null}}}};
const r=lodResolution(data);assert.equal(r.confirmed,true);assert.equal(r.suggestedPercent,1.5);assert.equal(r.suggestedFaces,1499);assert.match(r.message,/130\.006 mm.*81\.389 mm.*尚未修复/);assert.doesNotMatch(r.message,/周长|拓扑/);assert.equal(currentLODTitle(data),'LOD4 · 检查未通过');assert.equal(nextDraftNotice(data),'');
const capped=structuredClone(data);capped.metadata.geometry.targetPolicy.frozenFaceCap=1249;assert.equal(lodResolution(capped).available,false);
const missing=structuredClone(data);delete missing.metadata.geometry.targetPolicy;assert.equal(lodResolution(missing).available,false);
assert.equal(boundaryFailure('Boundary distance upper bound could not be certified within budget').confirmed,false);
assert.equal(currentLODTitle({...data,title:'我命名的岩石'}),'我命名的岩石');
assert.equal(nextDraftNotice({status:'idle',operation:'bake',nativeNextStepNotice:'请连接带材质高模'},{high:{}}),'输入已连接；检查设置后手动生成。');
console.log('LOD_RESOLUTION_CAUSE_BUDGET_STATUS_OK');

assert.equal(r.maxFaces,2498);assert.equal(r.maxPercent,2498/99999*100);
const oneFaceLeft=structuredClone(data);oneFaceLeft.metadata.geometry.targetPolicy.parentTriangleLimit=1250;assert.equal(lodResolution(oneFaceLeft).maxFaces,1249);assert.equal(lodResolution(oneFaceLeft).available,false);
console.log('LOD_RESOLUTION_PARENT_MINUS_ONE_OK no unchanged-parent target; suggestion remains1499');
