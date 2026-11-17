// Real isolated MCP + browser/GPU M4 acceptance. No image/model leaves the local host.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir,cpus,totalmem,platform,release} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {chromium} from './test-browser.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const python=process.env.H3_TEST_PYTHON||process.env.PCG_TEST_PYTHON||'python';
if(!process.env.CHROME_PATH){const installed=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);if(installed)process.env.CHROME_PATH=installed;}
const temporary=await mkdtemp(path.join(tmpdir(),'pcg-m4-ui-'));
const evidenceDir=process.env.PCG_M4_EVIDENCE_DIR||path.join(tmpdir(),'pcg-m4-evidence');
await mkdir(evidenceDir,{recursive:true});
const evidencePath=path.join(evidenceDir,`m4-${process.pid}-${Date.now()}.json`);
const runtime=path.join(temporary,'runtime'),samples=path.join(temporary,'samples');
const iterations=Number(process.env.PCG_M4_SAMPLES||5);
assert.ok(Number.isInteger(iterations)&&iterations>=3&&iterations<=20);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const terminal=new Set(['succeeded','failed','cancelled']);
const evidence={contract:'M4 real MCP/browser acceptance',startedAt:new Date().toISOString(),hardware:{platform:platform(),release:release(),cpu:cpus()[0]?.model,cpuLogical:cpus().length,ramBytes:totalmem()},checks:[],activeFramedStages:[],samples:{instance:[],mesh:[],mesh100k:[]},performanceGates:{},limitations:['Headless Chromium uses SwiftShader; logical GPU counters are not physical VRAM measurements.','100k fixture is self-authored test geometry, not an M2 recipe performance claim.']};
let browser,page,server,instance,logs='',requestId=0;
const pageErrors=[],externalRequests=[];
const stagePython=String.raw`
import json,os,pathlib,shutil,sys,sysconfig,zipfile
assert os.name == 'nt', 'Real AppContainer browser acceptance requires Windows.'
version='python%d%d' % sys.version_info[:2]
source=pathlib.Path(sys.executable).resolve().parent
base=pathlib.Path(sys.base_prefix).resolve()
host_packages=list(dict.fromkeys(str(pathlib.Path(entry).resolve()) for entry in sys.path if entry and pathlib.Path(entry).is_dir() and 'site-packages' in [part.casefold() for part in pathlib.Path(entry).parts]))
required=['python.exe','pythonw.exe','python3.dll',version+'.dll','vcruntime140.dll','vcruntime140_1.dll']
if (source/(version+'.zip')).is_file() and all((source/name).is_file() for name in required):
    print(json.dumps({'executable':str(source/'python.exe'),'mode':'existing-self-contained','hostPackages':host_packages,'version':sys.version.split()[0],'stdlibFiles':None,'stdlibBytes':(source/(version+'.zip')).stat().st_size}))
else:
    target=pathlib.Path(sys.argv[1]).absolute()
    target.mkdir(exist_ok=False)
    binaries={}
    for directory in dict.fromkeys([base,source,base/'DLLs',source/'DLLs']):
        if not directory.is_dir(): continue
        for candidate in sorted(directory.iterdir()):
            if candidate.is_file() and not candidate.is_symlink() and candidate.suffix.lower() in ('.dll','.pyd') and '_test' not in candidate.name.lower():
                binaries.setdefault(candidate.name,candidate)
    for name in ('python.exe','pythonw.exe'):
        candidate=next((directory/name for directory in (base,source) if (directory/name).is_file()),None)
        assert candidate is not None, 'Installed Python executable is missing: '+name
        binaries[name]=candidate
    assert all(name in binaries for name in required), 'Installed Python is missing required runtime DLLs.'
    for name,candidate in binaries.items(): shutil.copy2(candidate,target/name)
    original_zip=next((directory/(version+'.zip') for directory in (source,base) if (directory/(version+'.zip')).is_file()),None)
    count=0;size=0
    if original_zip is not None:
        shutil.copy2(original_zip,target/(version+'.zip'))
        with zipfile.ZipFile(original_zip) as archive: count=len(archive.infolist());size=sum(item.file_size for item in archive.infolist())
    else:
        stdlib=pathlib.Path(sysconfig.get_path('stdlib')).resolve()
        assert stdlib.is_dir(), 'The selected installed interpreter has no standard library.'
        excluded={'site-packages','test','tests','ensurepip','__pycache__'}
        entries=[]
        for directory,folders,files in os.walk(stdlib,followlinks=False):
            folders[:]=sorted(name for name in folders if name.casefold() not in excluded and not (pathlib.Path(directory)/name).is_symlink())
            for name in sorted(files):
                candidate=pathlib.Path(directory)/name
                if candidate.is_symlink() or candidate.suffix.lower() in ('.pyc','.pyo','.exe','.dll','.pyd'): continue
                relative=candidate.relative_to(stdlib)
                assert not any(part.casefold() in excluded for part in relative.parts)
                size+=candidate.stat().st_size;count+=1
                assert count<=20000 and size<=512*1024*1024, 'Installed standard library exceeds fixture budget.'
                entries.append((candidate,relative.as_posix()))
        assert any(name=='encodings/__init__.py' for _,name in entries), 'Standard library encodings are missing.'
        # Stored entries avoid adding a decompressor dependency to the restricted worker.
        with zipfile.ZipFile(target/(version+'.zip'),'x',compression=zipfile.ZIP_STORED) as archive:
            for candidate,name in entries: archive.write(candidate,name)
    (target/(version+'._pth')).write_text(version+'.zip\n.\n',encoding='ascii')
    print(json.dumps({'executable':str(target/'python.exe'),'mode':'staged-existing-install','hostPackages':host_packages,'version':sys.version.split()[0],'stdlibFiles':count,'stdlibBytes':size,'binaries':len(binaries)}))
`;
const fixturePython=String.raw`
import hashlib,json,pathlib,sys
sys.path.insert(0,sys.argv[2])
from pcg_export import export_glb
from pcg_geometry import mesh,summarize
from pcg_contracts import canonical
target=pathlib.Path(sys.argv[1]);target.mkdir()
nx,nz=200,250
triangles=[]
for z in range(nz):
 for x in range(nx):
  a=z*(nx+1)+x;b=a+1;c=a+nx+1;d=c+1
  triangles.extend([[a,c,b],[b,c,d]])
runs=[]
for variant,y in enumerate([.125,.375]):
 value=mesh([[x/nx*8-4,y,z/nz*8-4] for z in range(nz+1) for x in range(nx+1)],triangles,[[0,1,0]]*(len(triangles)*3))
 body=export_glb(value);sha=hashlib.sha256(body).hexdigest();name='grid100k-'+str(variant);asset=target/(name+'.glb');asset.write_bytes(body)
 handle={'projectId':'prj_fixture','nodeId':'grid','revision':1,'descriptorVersion':1,'operationVersion':1,'runId':name,'jobId':'pcg_'+name,'inputHash':str(variant+1)*64}
 artifact={'artifactId':'pcga_'+name,'sha256':sha,'format':'glb','producerNodeId':'grid','summary':summarize(value),**{k:handle[k] for k in ('jobId','runId','inputHash','projectId','revision')}}
 runs.append({'name':name,'handle':handle,'result':{'assets':[artifact]},'assetsLocal':[{'path':str(asset),'format':'glb','sha256':sha,'bytes':len(body)}]})
(target/'EVIDENCE.json').write_bytes(canonical({'runs':runs}))
print(json.dumps({'triangles':len(triangles),'vertices':(nx+1)*(nz+1),'assets':[{'label':r['name'],'bytes':r['assetsLocal'][0]['bytes'],'sha256':r['assetsLocal'][0]['sha256']} for r in runs]}))
`;
const bootstrap='import runpy,sys,json;sys.path.extend(json.loads(sys.argv[2]));sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[3:];runpy.run_path(sys.argv[0],run_name="__main__")';
async function rpc(method,params={}) {
 const id=++requestId;
 const answer=await page.evaluate(async({id,method,params})=>{
  const response=await fetch('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  return {status:response.status,value:await response.json()};
 },{id,method,params});
 assert.equal(answer.status,200,JSON.stringify(answer.value));assert.equal(answer.value.id,id);assert.equal(answer.value.error,undefined);
 return answer.value.result;
}
async function call(name,args={},errorCode=null) {
 const response=await rpc('tools/call',{name,arguments:args});
 const value=JSON.parse(response.content.find(item=>item.type==='text').text);
 if(errorCode){assert.equal(response.isError,true);assert.equal(value.code,errorCode);return value;}
 assert.equal(response.isError,false,JSON.stringify(value));return value;
}
const read=()=>call('pcg_demo_read_state');
async function done(initial,expected='succeeded') {
 let state=initial;const deadline=performance.now()+180000;
 while(!terminal.has(state.run?.status)){
  if(state.run.stageCount>1){const v=await viewer();if(v.loadedIdentity?.runId===state.run.runId&&v.cameraFramed&&v.sceneFrameCount>=1&&!evidence.activeFramedStages.some(s=>s.assetId===v.loadedIdentity.assetId))evidence.activeFramedStages.push({runId:state.run.runId,assetId:v.loadedIdentity.assetId,status:state.run.status,stage:state.run.stageIndex});}
  assert.ok(performance.now()<deadline,'M4 real worker timed out.');
  const waited=await call('pcg_demo_wait',{afterSequence:state.eventCursor,timeoutMs:1000});
  state=waited.state;
 }
 assert.equal(state.run.runId,initial.run.runId);assert.equal(state.run.status,expected,JSON.stringify({error:state.run.error,currentNodeId:state.run.currentNodeId,stageIndex:state.run.stageIndex,stageCount:state.run.stageCount,currentTask:state.run.currentTask,completedNodeIds:state.run.completedStages.map(stage=>stage.nodeId)}));return state;
}
async function displayed(assetId) {
 await page.waitForFunction(asset=>{
  const s=window.pcgDemo?.getState(),v=window.pcgDemo?.getViewerState();
  return s?.desired?.assetId===asset&&v?.loadedIdentity?.assetId===asset&&v.loadedIdentity.selectionEpoch===s.selectionEpoch&&v.cameraFramed&&v.sceneFrameCount>=1;
 },assetId,{timeout:30000});
 const deadline=performance.now()+10000;
 for(;;){const s=await read();if(s.viewer.loaded&&s.viewer.displayed?.assetId===assetId)return s;assert.ok(performance.now()<deadline,'Missing real browser frame ACK.');await sleep(30);}
}
const viewer=()=>page.evaluate(()=>window.pcgDemo.getViewerState());
const diagnostics=()=>page.evaluate(()=>window.pcgDemo.getDiagnostics());
async function select(asset){await call('pcg_demo_select',{assetId:asset.assetId});return displayed(asset.assetId);}
function bindings(s){
 assert.ok(Number.isInteger(s.graphRevision)&&s.graphRevision>0);assert.match(s.graphHash,/^[a-f0-9]{64}$/);
 for(const v of [s.run,...s.run.completedStages,...s.catalog.filter(a=>a.runId===s.run.runId)])for(const key of ['projectId','graphRevision','graphHash'])assert.equal(v[key],s[key],`${key} binds graph/run/stage/asset.`);
 const saved=s.events.find(e=>e.kind==='graph-saved'&&e.graphRevision===s.graphRevision),started=s.events.find(e=>e.kind==='run-started'&&e.runId===s.run.runId);
 assert.ok(saved&&started&&saved.sequence<started.sequence,'Save must precede execution.');
 for(const edge of s.graph.edges){assert.ok(s.graph.nodes.some(n=>n.id===edge.source));assert.ok(s.graph.nodes.some(n=>n.id===edge.target));assert.ok(edge.sourceHandle&&edge.targetHandle);}
 for(let i=1;i<s.events.length;i++)assert.ok(s.events[i].sequence>s.events[i-1].sequence);
 assert.ok(!JSON.stringify(s).includes('positions"'),'Agent state must not embed raw geometry arrays.');
}
function quantiles(values){const sorted=[...values].sort((a,b)=>a-b);return {n:sorted.length,p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],min:sorted[0],max:sorted.at(-1)};}
async function tuned(state,parameters,kind,bucket){
 const before=await viewer(),start=performance.now(),accepted=await call('pcg_demo_tune',{runId:state.run.runId,parameters}),acceptedAt=performance.now();
 const final=await done(accepted),evaluatedAt=performance.now();await displayed(final.desired.assetId);const paintedAt=performance.now(),after=await viewer();
 const preview=await call('pcg_demo_preview',{targetAssetId:final.desired.assetId,baseAssetId:state.desired.assetId});
 assert.ok([kind,'snapshot'].includes(preview.kind),JSON.stringify(preview));
 if(preview.kind===kind){assert.ok(preview.bytes<final.desired.bytes,'Delta must actually reduce transfer bytes.');assert.ok(after.resources.reusedBuffers>before.resources.reusedBuffers,'GPU buffers must actually be reused.');}
 else assert.ok(preview.reason,'Snapshot fallback must explain its reason.');
 assert.equal(after.updateKind,preview.kind);
 const sample={parameters,kind:preview.kind,fallbackReason:preview.reason,acceptMs:acceptedAt-start,evaluateWaitMs:evaluatedAt-acceptedAt,terminalObservedToFrameAckMs:paintedAt-evaluatedAt,hostToFrameAckMs:paintedAt-start,previewBytes:preview.bytes,fullBytes:final.desired.bytes,resourcesBefore:before.resources,resourcesAfter:after.resources,diagnostics:await diagnostics(),computed:final.run.completedStages.flatMap(s=>s.computedNodes),cacheHits:final.run.completedStages.flatMap(s=>s.cacheHits),dirty:final.run.completedStages.flatMap(s=>s.dirtyNodes||[])};
 evidence.samples[bucket].push(sample);bindings(final);return final;
}
async function pixelProof(){return page.evaluate(()=>{
 const gl=document.getElementById('model').getContext('webgl2');gl.finish();const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,data=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
 let changed=0;for(let i=4;i<data.length;i+=4)if(Math.max(Math.abs(data[i]-data[0]),Math.abs(data[i+1]-data[1]),Math.abs(data[i+2]-data[2]))>12)changed++;
 return {changed,width,height,error:gl.getError()};
});}
try {
 const staged=spawnSync(python,['-c',stagePython,path.join(temporary,'python-fixture')],{cwd:root,env:{...process.env,PYTHONIOENCODING:'utf-8'},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
 assert.equal(staged.status,0,staged.stderr||staged.error?.message);const selected=JSON.parse(staged.stdout);
 evidence.interpreter={mode:selected.mode,version:selected.version};
 const fixture=spawnSync(python,['-c',fixturePython,samples,root],{cwd:root,env:{...process.env,PYTHONIOENCODING:'utf-8'},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
 assert.equal(fixture.status,0,fixture.stderr||fixture.error?.message);evidence.fixture=JSON.parse(fixture.stdout);
 server=spawn(selected.executable,['-c',bootstrap,root,JSON.stringify(selected.hostPackages),'pcg_demo_server.py','--runtime-dir',runtime,'--samples-root',samples,'--port','0','--exit-on-stdin-close'],{cwd:root,env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe'],windowsHide:true});
 server.stdout.on('data',b=>{logs=(logs+b.toString()).slice(-5000);});server.stderr.on('data',b=>{logs=(logs+b.toString()).slice(-5000);});server.on('error',e=>{logs+=e.message;});
 const deadline=performance.now()+30000;
 while(!instance){try{instance=JSON.parse(await readFile(path.join(runtime,'instance.json'),'utf8'));}catch{assert.equal(server.exitCode,null,logs);assert.ok(performance.now()<deadline,logs);await sleep(100);}}
 assert.equal(instance.pid,server.pid);assert.ok(instance.port>0&&![8188,8189,8790].includes(instance.port));evidence.port=instance.port;
 browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage','--enable-precise-memory-info']});
 const context=await browser.newContext({viewport:{width:1360,height:960}});
 await context.route('**/*',async route=>{if(!route.request().url().startsWith(instance.url)){externalRequests.push(route.request().url());await route.abort();}else await route.continue();});
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));await page.addInitScript(()=>performance.setResourceTimingBufferSize(3000));await page.goto(instance.url,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.pcgDemo?.getState());
 evidence.hardware.browser=await browser.version();evidence.hardware.webgl=await page.evaluate(()=>{const gl=document.getElementById('model').getContext('webgl2'),e=gl.getExtension('WEBGL_debug_renderer_info');return {vendor:gl.getParameter(e?.UNMASKED_VENDOR_WEBGL||gl.VENDOR),renderer:gl.getParameter(e?.UNMASKED_RENDERER_WEBGL||gl.RENDERER)};});
 assert.equal((await rpc('initialize')).protocolVersion,'2025-03-26');const tools=(await rpc('tools/list')).tools;
 for(const name of ['describe','open','read_state','select','run','wait','tune','cancel','preview'])assert.ok(tools.some(t=>t.name==='pcg_demo_'+name),`Missing MCP ${name}.`);
 assert.equal((await call('pcg_demo_open')).url,instance.url);assert.ok((await call('pcg_demo_describe')).schema.tools.length>=9);evidence.checks.push('real MCP initialize/discovery/open/read');
 let state=await read();const grids=state.catalog.filter(a=>a.label.startsWith('grid100k-'));assert.equal(grids.length,2);
 await select(grids[0]);assert.equal((await viewer()).triangleCount,100000);
 for(let i=0;i<iterations;i++){
  const target=grids[(i+1)%2],base=grids[i%2],before=await viewer(),start=performance.now();
  const descriptor=await call('pcg_demo_preview',{targetAssetId:target.assetId,baseAssetId:base.assetId});assert.equal(descriptor.kind,'mesh-delta');assert.ok(descriptor.bytes<target.bytes);const selectedAt=performance.now();
  await select(target);const finish=performance.now(),after=await viewer();assert.equal(after.updateKind,'mesh-delta');assert.ok(after.resources.reusedBuffers>before.resources.reusedBuffers);
  evidence.samples.mesh100k.push({descriptorRequestMs:selectedAt-start,selectToFrameAckMs:finish-selectedAt,descriptorAndSelectToFrameAckMs:finish-start,descriptorBytes:descriptor.bytes,fullBytes:target.bytes,resources:after.resources,diagnostics:await diagnostics()});
 }
 evidence.pixels100k=await pixelProof();assert.equal(evidence.pixels100k.error,0);assert.ok(evidence.pixels100k.changed>200);evidence.checks.push('100000 unique triangles / managed preview delta / real GPU reuse');
 const currentGrid=grids[iterations%2],otherGrid=grids[(iterations+1)%2];
 const damaged=await call('pcg_demo_preview',{targetAssetId:otherGrid.assetId,baseAssetId:currentGrid.assetId}),fallbacksBefore=(await diagnostics()).transport.fallbacks;
 assert.equal(damaged.kind,'mesh-delta');const damagedUrl=new URL(damaged.url,instance.url).href;
 const corrupt=route=>route.fulfill({status:200,contentType:'application/json',body:'{"invalid":"owned QA response"}'});
 await page.route(damagedUrl,corrupt);await select(otherGrid);await page.unroute(damagedUrl,corrupt);
 assert.ok((await diagnostics()).transport.fallbacks>fallbacksBefore);assert.equal((await viewer()).updateKind,'snapshot');evidence.checks.push('damaged delta is rejected and authenticated full snapshot recovers');
 let releaseLate,enteredLate;const lateGate=new Promise(resolve=>{releaseLate=resolve;}),lateEntered=new Promise(resolve=>{enteredLate=resolve;});
 const lateDescriptor=await call('pcg_demo_preview',{targetAssetId:currentGrid.assetId,baseAssetId:otherGrid.assetId}),lateUrl=new URL(lateDescriptor.url,instance.url).href;
 const delayed=async route=>{enteredLate();await lateGate;await route.continue();};await page.route(lateUrl,delayed);
 try{
  const stale=await call('pcg_demo_select',{assetId:currentGrid.assetId});await Promise.race([lateEntered,sleep(10000).then(()=>{throw Error('Delta race gate was not entered.');})]);
  await select(otherGrid);releaseLate();await sleep(300);assert.equal((await viewer()).loadedIdentity.assetId,otherGrid.assetId);
  const refused=await page.evaluate(async({epoch,assetId})=>{const r=await fetch('/api/viewer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:'m4-qa-old',reportSequence:1,selectionEpoch:epoch,assetId,status:'loaded',metrics:{cameraFramed:true,frameCount:1}})});return {status:r.status,body:await r.json()};},{epoch:stale.selectionEpoch,assetId:currentGrid.assetId});
  assert.equal(refused.status,409);assert.equal(refused.body.code,'STALE_SELECTION');
 }finally{releaseLate();await page.unroute(lateUrl,delayed);}
 evidence.checks.push('late delta response cannot replace newer selection / stale ACK rejected');
 const wrongDescriptor=await call('pcg_demo_preview',{targetAssetId:otherGrid.assetId});let replayed=0;
 const replay=async route=>{const body=route.request().postDataJSON();if(body.name==='pcg_demo_preview'&&body.arguments.targetAssetId===currentGrid.assetId){replayed++;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:wrongDescriptor})});}else await route.continue();};
 await page.route(new URL('/api/tool',instance.url).href,replay);await call('pcg_demo_select',{assetId:currentGrid.assetId});
 await page.waitForFunction(()=>window.pcgDemo.getDiagnostics().localError.includes('加载失败'));
 assert.ok(replayed>=1);assert.equal((await viewer()).loadedIdentity.assetId,otherGrid.assetId);assert.equal((await read()).viewer.displayed.assetId,otherGrid.assetId);await page.unroute(new URL('/api/tool',instance.url).href,replay);await select(currentGrid);evidence.checks.push('valid wrong-target descriptor replay rejected atomically without false frame ACK');
 state=await done(await call('pcg_demo_run',{recipe:'scatter',seed:31,count:1000,minDistance:0}));bindings(state);await displayed(state.desired.assetId);
 assert.ok(evidence.activeFramedStages.filter(s=>s.runId===state.run.runId).length>=2,'At least two real current-run stages must be drawn while the run is active.');
 await page.waitForFunction(count=>document.querySelectorAll('#graph > .node').length===count,state.graph.nodes.length);
 const renderedGraph=await page.locator('#graph > .node > details:first-of-type > pre').allTextContents();assert.equal(renderedGraph.length,state.graph.nodes.length);
 for(let i=0;i<renderedGraph.length;i++){const detail=JSON.parse(renderedGraph[i]),node=state.graph.nodes[i];assert.deepEqual(detail.parameters,node.data.parameters);assert.deepEqual(detail.inputs,state.graph.edges.filter(e=>e.target===node.id).map(e=>({node:e.source,port:e.sourceHandle,to:e.targetHandle})));}
 assert.ok((await page.locator('#graph-identity').textContent()).includes(String(state.graphRevision)));evidence.checks.push('expanded real DAG shows exact node parameters and named ports');
 assert.equal((await viewer()).instanceCount,1000);assert.equal((await viewer()).triangleCount,128000);assert.equal((await viewer()).drawCalls,1);
 for(let i=0;i<iterations;i++){state=await tuned(state,{translateY:Number((.4+i*.1).toFixed(1))},'instance-delta','instance');const sample=evidence.samples.instance.at(-1);assert.deepEqual(sample.computed,['instance-transform']);assert.ok(sample.cacheHits.includes('publish'));}
 assert.ok(evidence.samples.instance.some(s=>s.kind==='instance-delta'),'At least one actual stable-instance delta required.');
 evidence.checks.push('1000 stable instances / end-node dirty/cache / actual instance delta and prototype reuse');
 state=await done(await call('pcg_demo_run',{recipe:'rock',seed:17,roughness:.2}));await displayed(state.desired.assetId);bindings(state);
 for(let i=0;i<iterations;i++){state=await tuned(state,{roughness:Number((.21+i*.01).toFixed(2))},'mesh-delta','mesh');assert.ok(evidence.samples.mesh.at(-1).computed.includes('noise'));}
 const fallback=await call('pcg_demo_preview',{targetAssetId:state.desired.assetId,baseAssetId:grids[0].assetId});assert.equal(fallback.kind,'snapshot');evidence.checks.push('noise dependency recompute / same topology delta / mismatched topology snapshot fallback');
 let interrupted=0;const waitRoute=async route=>{const body=route.request().postDataJSON();if(body.name==='pcg_demo_wait'&&interrupted===0){interrupted++;await route.fulfill({status:503,contentType:'application/json',body:'{"code":"OWNED_TEST_DISCONNECT","message":"one QA wait response interrupted"}'});}else await route.continue();};
 await page.route(new URL('/api/tool',instance.url).href,waitRoute);const interruptDeadline=performance.now()+5000;while(!interrupted){assert.ok(performance.now()<interruptDeadline,'No browser event wait to interrupt.');await sleep(20);}await select(state.desired);assert.equal(interrupted,1);await page.unroute(new URL('/api/tool',instance.url).href,waitRoute);assert.equal((await read()).run.runId,state.run.runId);evidence.checks.push('interrupted event wait reconnects from cursor without rerun');
 const cursor=state.eventCursor,waiting=call('pcg_demo_wait',{afterSequence:cursor,timeoutMs:2000});await call('pcg_demo_select',{assetId:state.desired.assetId});const wake=await waiting;assert.ok(wake.cursor>cursor);assert.ok(wake.events.length);
 const recover=await call('pcg_demo_wait',{afterSequence:1e12,timeoutMs:0});assert.equal(recover.reset,true);assert.equal(recover.state.run.runId,state.run.runId);
 for(let i=0;i<260;i++)await call('pcg_demo_select',{assetId:state.desired.assetId});
 const truncated=await call('pcg_demo_wait',{afterSequence:0,timeoutMs:0});assert.equal(truncated.reset,true);assert.ok(truncated.events.length<=256);assert.equal(truncated.state.run.runId,state.run.runId);evidence.checks.push('cursor wait wake / future and truncated cursor recovery without rerun');
 const active=await call('pcg_demo_run',{recipe:'rock',seed:59});await call('pcg_demo_run',{recipe:'rock'},'SESSION_BUSY');await call('pcg_demo_cancel',{runId:active.run.runId});await done(await read(),'cancelled');
 const failed=await done(await call('pcg_demo_run',{recipe:'scatter',seed:43,count:100,minDistance:1000}),'failed');assert.equal(failed.run.error.code,'INSUFFICIENT_PLACEMENT');await displayed(failed.desired.assetId);assert.equal(failed.desired.producerNodeId,'publish');
 state=await done(await call('pcg_demo_run',{recipe:'rock',seed:60}));await displayed(state.desired.assetId);await call('pcg_demo_cancel',{runId:active.run.runId},'STALE_RUN');evidence.checks.push('busy rejection / owned cancel / real failure retention / rerun / stale run rejection');
 const foreground=await context.newPage();await foreground.bringToFront();const actuallyHidden=await page.evaluate(()=>document.hidden);
 if(actuallyHidden){await sleep(100);const hidden=await viewer();await sleep(200);assert.equal((await viewer()).frameCount,hidden.frameCount);evidence.visibility={hidden:true,framesStopped:true};}
 else{evidence.visibility={hidden:false,verified:false};evidence.limitations.push('This headless browser keeps background tabs visible; hidden-page behavior requires an interactive browser check.');}
 await foreground.close();await page.bringToFront();
 evidence.heapBeforeClose=await page.evaluate(()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize,jsHeapSizeLimit:performance.memory.jsHeapSizeLimit}:null);
 evidence.resourceTransfers=await page.evaluate(()=>performance.getEntriesByType('resource').filter(e=>/\/api\/(assets|previews)\//.test(e.name)).map(e=>({path:new URL(e.name).pathname,durationMs:e.duration,encodedBodyBytes:e.encodedBodySize,decodedBodyBytes:e.decodedBodySize,transferBytes:e.transferSize,startMs:e.startTime,responseEndMs:e.responseEnd})));
 evidence.transferLatency=quantiles(evidence.resourceTransfers.map(e=>e.durationMs));evidence.transferBytes=evidence.resourceTransfers.reduce((sum,e)=>sum+e.encodedBodyBytes,0);
 const hostMemory=spawnSync('powershell.exe',['-NoProfile','-Command',`$taskProcess=Get-Process -Id ${server.pid}; [pscustomobject]@{workingSetBytes=$taskProcess.WorkingSet64;privateBytes=$taskProcess.PrivateMemorySize64;cpuSeconds=$taskProcess.CPU;handles=$taskProcess.HandleCount} | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true,timeout:10000});
 if(hostMemory.status===0)evidence.serverProcess=JSON.parse(hostMemory.stdout);else evidence.limitations.push('Server process CPU/memory sample unavailable.');
 evidence.harnessMemory=process.memoryUsage();
 const live=await viewer();assert.ok(live.resources.liveBuffers>0);await page.evaluate(()=>dispatchEvent(new Event('pagehide')));const closed=await viewer();await sleep(150);const settled=await viewer();
 assert.equal(closed.resources.liveBuffers,0);assert.equal(closed.resources.liveVaos,0);assert.equal(closed.resources.liveBytes,0);assert.equal(closed.resources.bufferAllocations,closed.resources.bufferDeletions);assert.equal(settled.frameCount,closed.frameCount);const closedApp=await diagnostics();assert.equal(closedApp.retainedBytes,0);assert.equal(closedApp.disposed,true);evidence.close={before:live.resources,after:closed.resources,framesStopped:true,retainedBytes:closedApp.retainedBytes};evidence.heapAfterClose=await page.evaluate(()=>performance.memory?{usedJSHeapSize:performance.memory.usedJSHeapSize,totalJSHeapSize:performance.memory.totalJSHeapSize}:null);evidence.checks.push('page close lifecycle releases all owned GPU buffers/VAOs, retained GLB and animation frames');
 assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);
 for(const [bucket,target] of [['instance',300],['mesh',1000]]){const latency=quantiles(evidence.samples[bucket].map(s=>s.hostToFrameAckMs));evidence.performanceGates[bucket]={targetP95Ms:target,...latency,passed:latency.p95<=target};evidence.samples[bucket+'Summary']={acceptMs:quantiles(evidence.samples[bucket].map(s=>s.acceptMs)),evaluationWaitMs:quantiles(evidence.samples[bucket].map(s=>s.evaluateWaitMs)),terminalObservedToFrameAckMs:quantiles(evidence.samples[bucket].map(s=>s.terminalObservedToFrameAckMs)),fetchValidateUploadMs:quantiles(evidence.samples[bucket].map(s=>s.diagnostics.transport.last.elapsedMs))};}
 evidence.mesh100kLatency=quantiles(evidence.samples.mesh100k.map(s=>s.selectToFrameAckMs));
 for(const gate of Object.values(evidence.performanceGates))assert.ok(gate.n>=3&&Number.isFinite(gate.p50)&&Number.isFinite(gate.p95),'No empty or nonfinite performance evidence.');
 evidence.integrationOk=true;evidence.performanceOk=Object.values(evidence.performanceGates).every(g=>g.passed);evidence.ok=evidence.integrationOk&&evidence.performanceOk;evidence.strictLatency=process.env.PCG_M4_STRICT_LATENCY==='1';
 await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({ok:evidence.ok,integrationOk:true,performanceGates:evidence.performanceGates,evidenceFile:evidencePath}));
 if(evidence.strictLatency&&!evidence.performanceOk)process.exitCode=1;
}catch(error){
 let diagnostic=null;try{diagnostic={state:await read(),viewer:await viewer(),app:await diagnostics()};}catch{}
 await writeFile(evidencePath,JSON.stringify({ok:false,error:error.message,evidence,diagnostic,pageErrors,externalRequests,serverLog:logs},null,2)+'\n',{flag:'wx'});console.error(JSON.stringify({ok:false,error:error.message,evidenceFile:evidencePath}));throw error;
}finally{
 await browser?.close();if(server&&server.exitCode===null){server.stdin.end();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(10000)]);if(server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}}
 assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(temporary).startsWith('pcg-m4-ui-'),'Owned temporary cleanup only.');await rm(temporary,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
