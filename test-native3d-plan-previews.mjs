import assert from 'node:assert/strict';
import {savePlanPreviews,validPlanPreviews,supportsPlanPreviews,PLAN_PREVIEW_MODES} from './src/native3d-runtime.js';
import {nodeSummary,registerCanvasMcp} from './src/canvas-mcp.js';
const hash='a'.repeat(64),plan={planSha256:hash,settings:{seamPlanningMode:'ai_structure_ao_v2'},edgeReasons:['convex_structural','concave_structural'],overlay:{sha256:'b'.repeat(64),arrays:{edgeReason:{}}}};
const png=new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0])],{type:'image/png'});
const blobs=Object.fromEntries(PLAN_PREVIEW_MODES.map(mode=>[mode,png]));
let saves=0,persists=0,applied=null;
const result=await savePlanPreviews(plan,blobs,{assertCurrent(){},saveFile:async()=>`assets/${(++saves).toString(16).padStart(64,'0')}.png`,apply:r=>{applied=r;},persist:async()=>persists++});
assert.equal(saves,4);assert.equal(persists,1);assert.equal(applied,result);assert.equal(validPlanPreviews(result,plan),true);
assert.equal(supportsPlanPreviews({...plan,settings:{}}),false,'historical plan cannot claim new structural layers');
assert.equal(validPlanPreviews(result,{...plan,edgeReasons:undefined}),false,'old no-reason plan cannot expose four cached layers');
assert.equal(validPlanPreviews({...result,schemaVersion:undefined},plan),false,'unversioned cache is not migrated into structural preview');
assert.equal(validPlanPreviews(result,{...plan,planSha256:'c'.repeat(64)}),false);
assert.equal(validPlanPreviews(result,{...plan,overlay:{sha256:'c'.repeat(64)}}),false);
assert.equal(validPlanPreviews({...result,ao:'https://external/image.png'},plan),false);
assert.equal(nodeSummary({id:'plan',type:'native3d',data:{nativeUVPlan:plan,nativeUVPlanPreviews:result}}).hasPlan,true);
assert.equal(nodeSummary({id:'plan',type:'native3d',data:{nativeUVPlan:plan,nativeUVPlanPreviews:result}}).hasPreview,true);
assert.equal(nodeSummary({id:'plan',type:'native3d',data:{nativeUVPlan:{...plan,planSha256:'c'.repeat(64)},nativeUVPlanPreviews:result}}).hasPreview,false);
for(const stale of ['project','permission','source','settings']){
 let active=true,writes=0;
 await assert.rejects(savePlanPreviews(plan,blobs,{assertCurrent(){if(!active)throw Error(stale);},saveFile:async()=>{active=false;return `assets/${hash}.png`;},apply(){writes++;},persist:async()=>{writes++;}}),new RegExp(stale));
 assert.equal(writes,0,'stale async upload cannot publish previews');
}
let rolledBack=false;
await assert.rejects(savePlanPreviews(plan,blobs,{assertCurrent(){},saveFile:async()=>`assets/${hash}.png`,apply(){},persist:async()=>{throw Error('revision failed');},rollback(){rolledBack=true;}}),/revision failed/);
assert.equal(rolledBack,true);
await assert.rejects(savePlanPreviews(plan,{...blobs,ao:new Blob(['bad'],{type:'image/png'})},{assertCurrent(){},saveFile:async()=>`assets/${hash}.png`,apply(){throw Error('unexpected apply');},persist:async()=>{}}),/有效PNG/);
const tools=new Map();let closed=0,saveCount=0;
const dispose=registerCanvasMcp({current:{projectId:'prj_fixture',readOnly:true,nodesRef:{current:[]},edgesRef:{current:[]},actions:{native3dViewerClose:()=>{closed++;return{closed:true};},persistProject:async()=>saveCount++}}},{context:{registerTool:t=>tools.set(t.name,t)},startPage:()=>()=>{}});
try{const reply=JSON.parse(await tools.get('canvas_native3d_viewer_close').execute({}));assert.equal(reply.ok,true);assert.equal(reply.closed,true);assert.equal(closed,1);assert.equal(saveCount,0);}finally{dispose();}
console.log('NATIVE3D_PLAN_PREVIEWS_OK four sequential PNG saves, exact plan/overlay cache, stale upload guards, revision rollback, summaries and nonmutating viewer close');
