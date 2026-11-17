// Real local browser/GPU integration. Only numeric pixel evidence leaves the browser.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './test-browser.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const python=process.env.H3_TEST_PYTHON||process.env.PCG_TEST_PYTHON||'python';
if(!process.env.CHROME_PATH) {
  const installed=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);
  if(installed)process.env.CHROME_PATH=installed;
}
const temporary=await mkdtemp(path.join(tmpdir(),'pcg-demo-ui-'));
const runtime=path.join(temporary,'runtime');
const evidencePath=path.join(tmpdir(),`pcg-demo-ui-evidence-${process.pid}-${Date.now()}.json`);
// Build a fixture from the selected installed interpreter; never download a runtime.
// The application and its AppContainer policy remain unchanged.
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

// Host dependencies use only the selected installation's existing package paths.
// The unchanged restricted worker creates its own zip-only path independently.
const bootstrap='import runpy,sys,json;sys.path.extend(json.loads(sys.argv[2]));sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[3:];runpy.run_path(sys.argv[0],run_name="__main__")';
let server,logs='',browser,page,context,instance;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evidence={browser:'local Chromium WebGL2',pixels:{},stages:[],checks:[]};
const pageErrors=[],externalRequests=[];
const terminal=new Set(['succeeded','failed','cancelled']);
async function api(name,args={}) {
  const answer=await page.evaluate(async({name,args})=>{
    const response=await fetch('/api/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});
    return {status:response.status,value:await response.json()};
  },{name,args});
  assert.equal(answer.status,200,JSON.stringify(answer.value));return answer.value.result;
}
async function read() {return api('pcg_demo_read_state');}
async function waitDisplayed(assetId,timeout=30000) {
  await page.waitForFunction(asset=>{
    const state=window.pcgDemo?.getState(),view=window.pcgDemo?.getViewerState();
    return state?.desired?.assetId===asset && view?.loadedIdentity?.assetId===asset && view.loadedIdentity.selectionEpoch===state.selectionEpoch && view.cameraFramed && view.sceneFrameCount>=1;
  },assetId,{timeout});
  const deadline=Date.now()+10000;
  for(;;) {
    const state=await read();
    if(state.viewer.loaded && state.viewer.displayed?.assetId===assetId)return state;
    assert.ok(Date.now()<deadline,'GPU frame did not produce a server display acknowledgement.');await sleep(100);
  }
}
async function pixels(label) {
  const result=await page.evaluate(()=>{
    const canvas=document.getElementById('model'),gl=canvas.getContext('webgl2');
    if(!gl||gl.isContextLost())throw new Error('No active WebGL2 context.');
    const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,data=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    const background=[...data.subarray(0,3)],bounds={minX:width,minY:height,maxX:-1,maxY:-1};
    let nonBackground=0,hash=2166136261;
    for(let pixel=0;pixel<width*height;pixel++) {
      const offset=pixel*4;
      for(let c=0;c<3;c++)hash=Math.imul(hash^data[offset+c],16777619)>>>0;
      if(Math.max(...background.map((v,c)=>Math.abs(v-data[offset+c])))>12) {
        nonBackground++;const x=pixel%width,y=Math.floor(pixel/width);
        bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);bounds.minY=Math.min(bounds.minY,y);bounds.maxY=Math.max(bounds.maxY,y);
      }
    }
    return {width,height,nonBackground,hash,bounds,glError:gl.getError()};
  });
  assert.equal(result.glError,0,'GPU readPixels error.');assert.ok(result.width>200&&result.height>200,'Canvas must have a real viewport.');
  assert.ok(result.nonBackground>200,`${label} must draw real geometry pixels.`);
  assert.ok(result.nonBackground<result.width*result.height*.9,`${label} must leave camera framing margin.`);
  assert.ok(result.bounds.minX>1&&result.bounds.minY>1&&result.bounds.maxX<result.width-2&&result.bounds.maxY<result.height-2,`${label} must fit the viewport.`);
  evidence.pixels[label]=result;return result;
}
async function runAndObserve(parameters) {
  const initial=await api('pcg_demo_run',parameters),id=initial.run.runId;
  const activeAssets=new Set(),stageRecords=new Map();let state=initial;
  const deadline=Date.now()+180000;
  while(!terminal.has(state.run?.status)) {
    const view=await page.evaluate(()=>window.pcgDemo?.getViewerState());
    if(state.run.status==='running' && state.run.completedStages.length>0) {
      stageRecords.set(state.run.stageIndex,{recipe:parameters.recipe,nodeId:state.run.currentNodeId,completed:state.run.completedStages.length,stageCount:state.run.stageCount,assetCount:state.catalog.filter(a=>a.runId===id).length,status:state.run.status});
      if(view?.cameraFramed&&view.sceneFrameCount>=1&&state.catalog.some(a=>a.assetId===view.loadedIdentity?.assetId&&a.runId===id))activeAssets.add(view.loadedIdentity.assetId);
    }
    assert.ok(Date.now()<deadline,`Real ${parameters.recipe} demo run timed out.`);
    await sleep(100);state=await read();
  }
  assert.equal(state.run.runId,id,'The run identity cannot change during observation.');
  evidence.stages.push({recipe:parameters.recipe,status:state.run.status,completed:state.run.completedStages.length,stageCount:state.run.stageCount,activeFramedAssets:activeAssets.size,active:[...stageRecords.values()]});
  return {state,id,activeAssets};
}
async function select(asset) {const state=await api('pcg_demo_select',{assetId:asset.assetId});await waitDisplayed(asset.assetId);return state;}

try {
  const staged=spawnSync(python,['-c',stagePython,path.join(temporary,'python-fixture')],{cwd:root,env:{...process.env,PYTHONIOENCODING:'utf-8'},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});
  assert.equal(staged.status,0,`Existing Python fixture could not be staged: ${staged.stderr||staged.error?.message||''}`);
  const selected=JSON.parse(staged.stdout);
  evidence.interpreter={mode:selected.mode,version:selected.version,stdlibFiles:selected.stdlibFiles,stdlibBytes:selected.stdlibBytes,binaries:selected.binaries??null};
  const probe=spawnSync(selected.executable,['-c','import ctypes,hashlib,json,threading,zipfile,_socket,select; print(json.dumps({"ready":True}))'],{cwd:root,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(probe.status,0,`Staged interpreter startup failed: ${probe.stderr||probe.error?.message||''}`);
  assert.equal(JSON.parse(probe.stdout).ready,true);
  server=spawn(selected.executable,['-c',bootstrap,root,JSON.stringify(selected.hostPackages),'pcg_demo_server.py','--runtime-dir',runtime,'--port','0','--exit-on-stdin-close'],{cwd:root,env:{...process.env,PYTHONIOENCODING:'utf-8'},stdio:['pipe','pipe','pipe'],windowsHide:true});
  server.stdout.on('data',b=>{logs=(logs+b.toString()).slice(-5000);});
  server.stderr.on('data',b=>{logs=(logs+b.toString()).slice(-5000);});
  server.on('error',error=>{logs+=error.message;});
  const deadline=Date.now()+30000;
  while(!instance) {
    try {instance=JSON.parse(await readFile(path.join(runtime,'instance.json'),'utf8'));}
    catch {assert.equal(server.exitCode,null,`Demo server exited. ${logs}`);assert.ok(Date.now()<deadline,`Demo server did not start. ${logs}`);await sleep(100);}
  }
  assert.equal(instance.pid,server.pid);assert.ok(instance.port>0&&![8188,8189,8790].includes(instance.port));
  assert.match(instance.url,new RegExp(`^http://127\\.0\\.0\\.1:${instance.port}/$`));
  browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  context=await browser.newContext({viewport:{width:1360,height:960}});
  await context.route('**/*',async route=>{
    if(!route.request().url().startsWith(instance.url)){externalRequests.push(route.request().url());await route.abort();}
    else await route.continue();
  });
  page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(instance.url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>Boolean(window.pcgDemo?.getState()));
  const initial=await read();assert.equal(initial.catalog.length,0);assert.equal(initial.desired,null);assert.equal(initial.viewer.loaded,false);
  assert.equal(await page.locator('#empty').isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>Object.keys(window.pcgDemo).sort()),['getDiagnostics','getState','getViewerState']);
  assert.equal(await page.evaluate(()=>Object.isFrozen(window.pcgDemo)),true);

  let retrySequence=null,refusedAck=0;
  const ackAttempts=[];
  const ackRoute=async route=>{
    const body=route.request().postDataJSON();
    if(body.status==='loaded') {
      ackAttempts.push(body.reportSequence);
      if(retrySequence===null) {retrySequence=body.reportSequence;refusedAck++;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'TEST_TRANSIENT',message:'One owned test response is unavailable.'})});return;}
    }
    await route.continue();
  };
  await page.route(new URL('/api/viewer',instance.url).href,ackRoute);
  const rock=await runAndObserve({recipe:'rock',seed:17,roughness:.3});
  assert.equal(rock.state.run.status,'succeeded',JSON.stringify(rock.state.run.error));
  assert.ok(rock.activeAssets.size>=2,'At least two real rock stages must be framed while the run is still active.');
  await waitDisplayed(rock.state.desired.assetId);
  assert.equal(refusedAck,1);assert.ok(ackAttempts.filter(seq=>seq===retrySequence).length>=2,'A transient ACK must retry the same report sequence.');
  await page.unroute(new URL('/api/viewer',instance.url).href,ackRoute);
  await page.waitForFunction(()=>document.querySelectorAll('details.field-readback').length===3);
  for(const node of ['position','noise','multiply']) {
    const detail=page.locator(`details.field-readback[data-node-id="${node}"]`);
    const output=JSON.parse(await detail.locator('pre').textContent());
    assert.equal(output.type,'Field');assert.equal(output.domain,'Point');assert.equal(output.count,66);assert.ok(output.sample.length>0&&output.sample.length<=3);
    assert.match(await detail.locator('p').textContent(),/demoasset_/);
  }
  evidence.checks.push('transient ACK retry / three typed Field read-backs');
  const rockView=await page.evaluate(()=>window.pcgDemo.getViewerState());assert.equal(rockView.triangleCount,128);assert.equal(rockView.cameraFramed,true);
  const before=await pixels('rock');
  await page.waitForFunction(yaw=>{const v=window.pcgDemo.getViewerState();return Math.abs(v.yaw-yaw)>.08;},rockView.yaw,{timeout:5000});
  const after=await pixels('turntable');assert.notEqual(after.hash,before.hash,'Actual framebuffer pixels must change with turntable yaw.');
  await page.locator('#rotate').click();const paused=await page.evaluate(()=>window.pcgDemo.getViewerState());await sleep(200);
  const pausedAfter=await page.evaluate(()=>window.pcgDemo.getViewerState());assert.equal(pausedAfter.yaw,paused.yaw);assert.equal(pausedAfter.frameCount,paused.frameCount);
  await page.locator('#rotate').click();evidence.checks.push('real rock / incremental active stages / framing / moving pixels / pause');

  const scatter=await runAndObserve({recipe:'scatter',seed:31,count:100,minDistance:.3});
  assert.equal(scatter.state.run.status,'succeeded',JSON.stringify(scatter.state.run.error));assert.ok(scatter.activeAssets.size>=2,'Scatter must show actual stages while running.');
  await waitDisplayed(scatter.state.desired.assetId);
  const instanceView=await page.evaluate(()=>window.pcgDemo.getViewerState());assert.equal(instanceView.meshCount,1);assert.equal(instanceView.instanceCount,100);assert.equal(instanceView.drawCalls,1);assert.equal(instanceView.triangleCount,12800);
  await pixels('instances100');
  const pointAsset=scatter.state.catalog.find(a=>a.runId===scatter.id&&a.geometryType==='PointSet');assert.ok(pointAsset,'Scatter must publish a real PointSet stage.');
  await select(pointAsset);const pointView=await page.evaluate(()=>window.pcgDemo.getViewerState());assert.equal(pointView.pointCount,100);assert.equal(pointView.triangleCount,0);await pixels('points100');
  evidence.checks.push('real PointSet / all 100 shared instances / single prototype draw');

  const firstAsset=rock.state.catalog.find(a=>a.runId===rock.id&&a.producerNodeId==='sphere');const latestAsset=scatter.state.desired;assert.ok(firstAsset);
  let releaseOld,enteredOld;
  const oldGate=new Promise(resolve=>{releaseOld=resolve;}),oldEntered=new Promise(resolve=>{enteredOld=resolve;});
  const oldUrl=new URL(firstAsset.url,instance.url).href;
  const delayed=async route=>{enteredOld();await oldGate;await route.continue();};
  await page.route(oldUrl,delayed);
  const firstSelection=await api('pcg_demo_select',{assetId:firstAsset.assetId});
  await Promise.race([oldEntered,sleep(10000).then(()=>{throw new Error('The selected GLB request did not enter the race gate.');})]);
  await api('pcg_demo_select',{assetId:latestAsset.assetId});await waitDisplayed(latestAsset.assetId);
  const finished=page.waitForResponse(response=>response.url()===oldUrl);releaseOld();const oldResponse=await finished;await oldResponse.finished();await sleep(200);
  assert.equal((await page.evaluate(()=>window.pcgDemo.getViewerState())).loadedIdentity.assetId,latestAsset.assetId,'Late old GLB must not replace current scene.');
  const stale=await page.evaluate(async({epoch,id})=>{
    const response=await fetch('/api/viewer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:'qa-stale',reportSequence:1,selectionEpoch:epoch,assetId:id,status:'loaded',metrics:{cameraFramed:true,frameCount:1}})});
    return {status:response.status,body:await response.json()};
  },{epoch:firstSelection.selectionEpoch,id:firstAsset.assetId});
  assert.equal(stale.status,409);assert.equal(stale.body.code,'STALE_SELECTION');assert.equal((await read()).viewer.displayed.assetId,latestAsset.assetId);
  await page.unroute(oldUrl,delayed);evidence.checks.push('late GLB discarded / stale ACK rejected');
  const corrupt=route=>route.fulfill({status:200,contentType:'model/gltf-binary',body:Buffer.from('invalid owned test response')});
  await page.route(oldUrl,corrupt);await api('pcg_demo_select',{assetId:firstAsset.assetId});
  await page.waitForFunction(()=>window.pcgDemo.getDiagnostics().localError.includes('GLB'));
  assert.equal((await page.evaluate(()=>window.pcgDemo.getViewerState())).loadedIdentity.assetId,latestAsset.assetId);
  const loadFailure=await read();assert.equal(loadFailure.viewer.displayed.assetId,latestAsset.assetId);await pixels('retainedAfterLoadFailure');
  await page.unroute(oldUrl,corrupt);await select(latestAsset);evidence.checks.push('damaged response rejected / previous displayed GPU scene retained');

  const failed=await runAndObserve({recipe:'scatter',seed:43,count:100,minDistance:1000});
  assert.equal(failed.state.run.status,'failed');assert.equal(failed.state.run.error.code,'INSUFFICIENT_PLACEMENT');assert.equal(failed.state.run.currentNodeId,'points');
  const successfulStages=failed.state.run.completedStages.flatMap(stage=>stage.assetIds);assert.equal(failed.state.desired.assetId,successfulStages.at(-1));
  await waitDisplayed(failed.state.desired.assetId);const retained=await read();assert.equal(retained.viewer.displayed.assetId,failed.state.desired.assetId);assert.equal(retained.viewer.displayed.producerNodeId,'publish');
  await page.waitForFunction(()=>window.pcgDemo.getState()?.run?.status==='failed'&&!document.getElementById('warning').hidden);
  assert.equal(await page.locator('#warning').isVisible(),true);await pixels('retainedAfterFailure');evidence.checks.push('impossible spacing fails / last real stage retained');

  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>innerWidth===390&&matchMedia('(max-width:900px)').matches);
  const layout=await page.evaluate(()=>{const c=document.getElementById('model').getBoundingClientRect();return {innerWidth,scrollWidth:document.documentElement.scrollWidth,canvasWidth:c.width,canvasHeight:c.height};});
  assert.ok(layout.scrollWidth<=layout.innerWidth+1,`Mobile layout overflow: ${JSON.stringify(layout)}`);assert.ok(layout.canvasWidth>250&&layout.canvasWidth<=390);await pixels('mobile');
  evidence.mobile=layout;evidence.checks.push('390px responsive layout / framed pixels');
  await page.setViewportSize({width:1360,height:960});

  const extension=await page.evaluateHandle(()=>document.getElementById('model').getContext('webgl2').getExtension('WEBGL_lose_context'));
  if(await extension.evaluate(value=>Boolean(value))) {
    await extension.evaluate(value=>value.loseContext());
    await page.waitForFunction(()=>window.pcgDemo.getViewerState().contextLost);
    const lost=await page.evaluate(()=>window.pcgDemo.getViewerState());assert.equal(lost.loadedIdentity,null);assert.equal(lost.cameraFramed,false);
    const lossDeadline=Date.now()+10000;while((await read()).viewer.loaded){assert.ok(Date.now()<lossDeadline,'Context loss must invalidate server display state.');await sleep(100);}
    await extension.evaluate(value=>value.restoreContext());await waitDisplayed(failed.state.desired.assetId);await pixels('contextRestored');evidence.checks.push('actual WebGL context loss / identity invalidation / managed reload');
  } else evidence.checks.push('WEBGL_lose_context unavailable (explicit capability limit)');
  await extension.dispose();

  const cancelRun=await api('pcg_demo_run',{recipe:'rock',seed:59});
  await api('pcg_demo_cancel',{runId:cancelRun.run.runId});
  const cancelDeadline=Date.now()+30000;let cancelled=await read();
  while(!terminal.has(cancelled.run.status)){assert.ok(Date.now()<cancelDeadline,'Cancellation must terminate its own demo run.');await sleep(100);cancelled=await read();}
  assert.equal(cancelled.run.runId,cancelRun.run.runId);assert.equal(cancelled.run.status,'cancelled');evidence.checks.push('own-run cancellation');
  assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);
  evidence.portProtected=false;evidence.externalRequests=externalRequests.length;evidence.pageErrors=pageErrors.length;
  const report={ok:true,...evidence};await writeFile(evidencePath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...report,evidenceFile:evidencePath},null,2));
} catch(error) {
  let diagnostics=null;try{diagnostics=await page?.evaluate(()=>{const s=window.pcgDemo?.getState(),c=document.getElementById('model')?.getBoundingClientRect();return {run:s?.run?{recipe:s.run.recipe,status:s.run.status,node:s.run.currentNodeId,completed:s.run.completedStages.length,stageCount:s.run.stageCount,error:s.run.error}:null,selectionEpoch:s?.selectionEpoch,desired:s?.desired?{assetId:s.desired.assetId,node:s.desired.producerNodeId,type:s.desired.geometryType}:null,catalogCount:s?.catalog?.length,viewer:window.pcgDemo?.getViewerState(),diagnostics:window.pcgDemo?.getDiagnostics(),layout:{innerWidth,scrollWidth:document.documentElement.scrollWidth,canvasWidth:c?.width,canvasHeight:c?.height}};});}catch{}
  const report={ok:false,message:error.message,evidence,diagnostics,pageErrors,externalRequestCount:externalRequests.length,serverLog:logs};
  await writeFile(evidencePath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.error(JSON.stringify({...report,evidenceFile:evidencePath},null,2));throw error;
} finally {
  await browser?.close();
  if(server&&server.exitCode===null){server.stdin.end();await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(10000)]);if(server.exitCode===null){server.kill('SIGTERM');await new Promise(resolve=>server.once('exit',resolve));}}
  assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(temporary).startsWith('pcg-demo-ui-'),'Cleanup must remain in the owned temporary directory.');
  await rm(temporary,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
