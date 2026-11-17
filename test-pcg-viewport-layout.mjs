import assert from 'node:assert/strict';
import {test} from 'node:test';
import {clampPcgViewportLayout,movePcgViewportLayout,resizePcgViewportLayout,pcgArtifactRequest,PCG_PANEL_MIN,PCG_HANDLE_KEYS} from './src/pcg-viewport-layout.js';
const host={width:1000,height:700},start={x:100,y:80,width:480,height:360};
function inside(layout,area){assert.ok(layout.x>=0&&layout.y>=0&&layout.width<=area.width&&layout.height<=area.height);assert.ok(layout.x+layout.width<=area.width&&layout.y+layout.height<=area.height);assert.ok(layout.width>=Math.min(PCG_PANEL_MIN.width,area.width)&&layout.height>=Math.min(PCG_PANEL_MIN.height,area.height));}
test('restored layout clamps invalid dimensions and position within its current host',()=>{
  assert.deepEqual(clampPcgViewportLayout(start,host),start);
  assert.deepEqual(clampPcgViewportLayout({x:-20,y:900,width:5,height:900},host),{x:0,y:0,width:300,height:700});
  assert.deepEqual(clampPcgViewportLayout({x:NaN,y:Infinity,width:NaN,height:-1},host),{x:16,y:16,width:480,height:240});
  const restored=clampPcgViewportLayout({x:900,y:600,width:480,height:360},host);assert.deepEqual(restored,{x:520,y:340,width:480,height:360});
  assert.deepEqual(clampPcgViewportLayout(restored,host),restored);
});
test('dragging in every direction stays inside host without changing panel size',()=>{
  for(const [dx,dy] of [[-10000,0],[10000,0],[0,-10000],[0,10000],[45,60]]){const moved=movePcgViewportLayout(start,dx,dy,host);inside(moved,host);assert.equal(moved.width,start.width);assert.equal(moved.height,start.height);}
  assert.deepEqual(movePcgViewportLayout(start,45,60,host),{...start,x:145,y:140});
});
test('eight resize handles preserve opposite edges and enforce minimums and host edges',()=>{
  for(const direction of ['n','ne','e','se','s','sw','w','nw'])for(const [dx,dy] of [[-10000,-10000],[10000,10000],[25,15]]){
    const resized=resizePcgViewportLayout(start,direction,dx,dy,host);inside(resized,host);
    if(!direction.includes('w'))assert.equal(resized.x,start.x);
    if(!direction.includes('e'))assert.equal(resized.x+resized.width,start.x+start.width);
    if(!direction.includes('n'))assert.equal(resized.y,start.y);
    if(!direction.includes('s'))assert.equal(resized.y+resized.height,start.y+start.height);
  }
});
test('small and shrinking hosts adapt minimums without creating offscreen controls',()=>{
  for(const area of [{width:220,height:170},{width:1,height:1},{width:320,height:250}]){
    const layout=clampPcgViewportLayout(start,area);inside(layout,area);
    for(const direction of ['n','ne','e','se','s','sw','w','nw'])inside(resizePcgViewportLayout(layout,direction,1000,-1000,area),area);
    inside(movePcgViewportLayout(layout,1000,1000,area),area);
  }
  assert.deepEqual(clampPcgViewportLayout(start,{width:220,height:170}),{x:0,y:0,width:220,height:170});
});
function artifact(){
  const handle={projectId:'project-one',nodeId:'node-one',revision:3,descriptorVersion:1,operationVersion:1,runId:'run-one',jobId:'pcg_'+'a'.repeat(32),inputHash:'b'.repeat(64)};
  return {artifactId:'pcga_'+'c'.repeat(64),sha256:'d'.repeat(64),bytes:512,format:'glb',role:'model',graphRevision:3,handle,url:`/api/pcg/artifacts/pcga_${'c'.repeat(64)}?${new URLSearchParams(handle)}`};
}
const authorize=desired=>pcgArtifactRequest(desired,'project-one','http://127.0.0.1:18790',9);
test('native artifact authorization captures the complete immutable task handle',()=>{
  const desired=artifact(),result=authorize(desired);assert.equal(result.identity.generation,9);assert.equal(result.bytes,512);assert.equal(result.sha256,desired.sha256);assert.ok(result.url.startsWith('http://127.0.0.1:18790/api/pcg/artifacts/'));
  assert.deepEqual(Object.keys(desired.handle),PCG_HANDLE_KEYS);assert.equal(result.identity.projectId,'project-one');desired.handle.projectId='changed';assert.equal(result.identity.projectId,'project-one');
});
test('artifact URLs cannot fetch off-origin, traversal, alternate paths or mismatched handles',()=>{
  for(const edit of [
    d=>d.url='https://elsewhere.invalid'+d.url,d=>d.url='http://user@127.0.0.1:18790'+d.url,d=>d.url+='#fragment',
    d=>d.url=d.url.replace('/api/pcg/artifacts/','/api/assets/'),d=>d.url=d.url.replace('revision=3','revision=4'),d=>d.url+='&revision=3',d=>d.url+='&extra=1',
    d=>d.url=d.url.replace('projectId=project-one','projectId=another'),d=>d.handle.extra=true,d=>delete d.handle.jobId,
    d=>d.graphRevision=4,d=>d.handle.projectId='another',d=>d.bytes=64*1024*1024+1,d=>d.sha256='not-sha',d=>d.artifactId='pcga_wrong',d=>d.format='png',d=>d.role='thumbnail',
  ]){const desired=artifact();edit(desired);assert.throws(()=>authorize(desired),error=>error.code==='INVALID_ARTIFACT_IDENTITY');}
});
