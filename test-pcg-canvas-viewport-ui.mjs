// Actual CanvasWorkbench + native PCG runtime; synthetic projects and local-only media evidence.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,samePath} from './test-browser.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const python=process.env.H3_TEST_PYTHON||process.env.PCG_TEST_PYTHON||'python';
if(!process.env.CHROME_PATH){const found=['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(existsSync);if(found)process.env.CHROME_PATH=found;}
const temporary=await mkdtemp(path.join(tmpdir(),'pcg-canvas-ui-'));
const runtime=path.join(temporary,'runtime'),projects=path.join(temporary,'projects');
const evidenceDir=process.env.PCG_M4_EVIDENCE_DIR||'D:\\RefmuseReviews\\pcg-plugin-plan-20261117\\m4-evidence';
await mkdir(evidenceDir,{recursive:true});const stamp=`canvas-${process.pid}-${Date.now()}`;
const evidencePath=path.join(evidenceDir,stamp+'.json');
const evidence={kind:'actual CanvasWorkbench PCG viewport acceptance',checks:[],stages:[],screenshots:[],commands:[],port:null};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let backend,browser,page,base,token,logs='',sequence=0,selected,project;
const pageErrors=[],externalRequests=[];
const pageSessions=new Map();
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
const bootstrap='import runpy,sys,json;sys.path.extend(json.loads(sys.argv[2]));sys.path.insert(0,sys.argv[1]);sys.argv=sys.argv[3:];runpy.run_path(sys.argv[0],run_name="__main__")';
const env={...process.env,H3_WORKBENCH_RUNTIME_DIR:runtime,H3_PROJECTS_ROOT:projects,H3_WORKBENCH_DATA_DIR:path.join(temporary,'data'),H3_WORKBENCH_PORT:'0',H3_WORKBENCH_NO_BROWSER:'1',H3_WORKBENCH_TEST_MODE:'1',H3_COMFY_AUTOSTART:'0',H3_WORKBENCH_DIST_DIR:process.env.H3_TEST_DIST_DIR||path.join(root,'dist'),PYTHONIOENCODING:'utf-8'};
async function until(read,label='condition',timeout=30000){const end=Date.now()+timeout;for(;;){const value=await read();if(value)return value;assert.ok(Date.now()<end,`Timed out: ${label}`);await sleep(100);}}
async function request(route,payload,method=payload?'POST':'GET'){
 const response=await fetch(base+route,{method,headers:{'X-H3-Token':token,...(payload?{'Content-Type':'application/json'}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
 const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.message||value.error||`HTTP ${response.status}`),{code:value.code});return value;
}
async function current(projectId=project.id){return request('/api/agent/canvas/current?projectId='+encodeURIComponent(projectId));}
async function call(tool,args={},allowError=false){
 const active=await current(),opId=`pcg_c4_${process.pid}_${++sequence}`;
 const trace={opId,tool,sessionId:active.sessionId,startedAt:Date.now()};evidence.commands.push(trace);
 try{await request('/api/agent/canvas/commands',{...active,opId,tool,args});}catch(error){error.message=`${tool}: ${error.message}`;throw error;}
 const done=await until(async()=>{const s=await request('/api/agent/canvas/commands/'+opId);trace.lastStatus=s.status;if(['error','failed','expired','unknown'].includes(s.status))throw Error(JSON.stringify(s));return s.status==='done'?s:null;},tool,45000);trace.finishedAt=Date.now();
 if(!allowError)assert.equal(done.result.ok,true,`${tool}: ${JSON.stringify(done.result)}`);return done.result;
}
const state=()=>call('canvas_get_state');
const panel=async()=> (await call('canvas_pcg_preview_state',{projectId:project.id})).panel;
const identity=value=>value?.artifactId||value?.assetId||value?.sha256||null;
async function drawn(nodeId,{afterGeneration=-1,triangles=null,instances=null}={}){
 return until(async()=>{const p=await panel();
  if(p.error||p.run?.status!=='succeeded'||p.nodeId!==nodeId||!p.open||p.generation<=afterGeneration||!identity(p.desired)||identity(p.displayed)!==identity(p.desired)||p.desired.generation!==p.generation||p.displayed.generation!==p.generation)return null;
  if(triangles!==null&&p.metrics?.triangleCount!==triangles)return null;if(instances!==null&&p.metrics?.instanceCount!==instances)return null;
  return p;
 },'current target actually drawn',120000);
}
async function screenshot(label){const file=path.join(evidenceDir,stamp+'-'+label+'.png');await page.screenshot({path:file,fullPage:true});evidence.screenshots.push({label,path:file});}
async function pixels(){const proof=await page.locator('[data-pcg-viewport-canvas]').evaluate(canvas=>{const gl=canvas.getContext('webgl2');if(!gl)throw Error('No actual WebGL2 context.');gl.finish();const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,bytes=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,bytes);let changed=0;for(let i=4;i<bytes.length;i+=4)if(Math.max(Math.abs(bytes[i]-bytes[0]),Math.abs(bytes[i+1]-bytes[1]),Math.abs(bytes[i+2]-bytes[2]))>12)changed++;return {width:w,height:h,changed,error:gl.getError()};});assert.equal(proof.error,0);assert.ok(proof.width>200&&proof.height>100&&proof.changed>200,'Real viewport framebuffer must contain geometry pixels.');return proof;}
async function create(operation,parameters,x,y){
 const description=await call('canvas_pcg_describe');const descriptor=description.registry.nodes.find(n=>n.id==='refmuse.pcg.'+operation);assert.ok(descriptor);
 const result=await call('canvas_pcg_create_node',{projectId:project.id,descriptorId:descriptor.id,descriptorVersion:descriptor.descriptorVersion,operationVersion:descriptor.operationVersion,x,y,focus:false});
 const nodeId=result.node.id;await call('canvas_pcg_set_parameters',{projectId:project.id,nodeId,descriptorVersion:1,operationVersion:1,parameters});return nodeId;
}
const parameters=(nodeId,values)=>call('canvas_pcg_set_parameters',{projectId:project.id,nodeId,descriptorVersion:1,operationVersion:1,parameters:values});
async function connect(sourceId,targetId,sourceHandle,targetHandle){const result=await call('canvas_connect_nodes',{sourceId,targetId,sourceHandle,targetHandle});await call('canvas_tidy');const edge=page.locator(`.react-flow__edge[data-id="${result.edge.id}"] .react-flow__edge-path`);await edge.waitFor({state:'attached'});assert.ok(await edge.evaluate(path=>path.getTotalLength()>10),'Real SVG edge path must connect the visible node ports.');return result.edge.id;}
async function bind(nodeId,autoRun=true){return call('canvas_pcg_preview_bind',{projectId:project.id,nodeId,autoRun});}
try{
 const fixture=spawnSync(python,['-c',stagePython,path.join(temporary,'python')],{cwd:root,encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:1024*1024});assert.equal(fixture.status,0,fixture.stderr);selected=JSON.parse(fixture.stdout);evidence.interpreter={version:selected.version,mode:selected.mode};
 backend=spawn(selected.executable,['-c',bootstrap,root,JSON.stringify(selected.hostPackages),'video_workbench_launcher.py'],{cwd:root,env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 backend.stderr.on('data',b=>{logs=(logs+b.toString()).slice(-8000);});backend.stdout.on('data',b=>{logs=(logs+b.toString()).slice(-8000);});backend.on('error',e=>{logs+=e.message;});
 const instance=await until(async()=>{try{return JSON.parse(await readFile(path.join(runtime,'instance.json'),'utf8'));}catch{assert.equal(backend.exitCode,null,logs);return null;}},'isolated native backend',45000);
 token=instance.token;base=`http://127.0.0.1:${instance.port}`;evidence.port=instance.port;assert.ok(![8188,8189,8790].includes(instance.port));
 const health=await request('/api/health');assert.equal(health.pid,backend.pid);assert.ok(samePath(health.projectsRoot,projects),'Verify isolated root before any write.');
 project=await request('/api/projects',{name:'PCG native canvas fixture',canvas:{nodes:[],edges:[],viewport:{x:40,y:75,zoom:.75}}});
 browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1800,height:1250}});await context.route('**/*',async route=>{if(new URL(route.request().url()).origin!==base){externalRequests.push(route.request().url());await route.abort();}else await route.continue();});
 page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname==='/api/agent/canvas/heartbeat')try{const value=r.postDataJSON();if(value.visible)pageSessions.set(value.projectId,value.sessionId);}catch{}});await page.goto(base);await page.locator('.project-open').click();await until(async()=>{try{const value=await current();return value.projectId===project.id&&value.sessionId===pageSessions.get(project.id);}catch(e){if(['NO_VISIBLE_CANVAS','AMBIGUOUS_CANVAS'].includes(e.code))return false;throw e;}},'visible current canvas');
 await page.locator('.react-flow').waitFor();const description=await call('canvas_pcg_preview_describe');evidence.previewContract=description;
 const primitiveParams={kind:'sphere',size:[1,1,1],subdivisions:2};
 const sphere=await create('primitive',primitiveParams,20,30),edges=[];let graph=await state();assert.equal(graph.nodes.length,1);assert.equal(graph.edges.length,0);
 await call('canvas_pcg_preview_open',{projectId:project.id});await call('canvas_pcg_preview_layout',{projectId:project.id,x:1250,y:80,width:500,height:420});await page.locator('[data-pcg-viewport-panel]').waitFor();assert.equal(await page.locator('iframe').count(),0);
 await bind(sphere,false);await call('canvas_generate_node',{nodeId:sphere,wait:false});let waited;
 do{waited=await call('canvas_wait_for_node',{nodeId:sphere,timeoutMs:20000});}while(waited.pending);
 assert.equal(waited.task.status,'succeeded');let p=await drawn(sphere,{triangles:128});evidence.stages.push({label:'primitive',panel:p,nodeCount:1,edgeCount:0,pixels:await pixels()});assert.ok(evidence.stages.at(-1).pixels.changed>200);await screenshot('primitive');
 const transform=await create('transform',{translation:[1.5,0,0],rotation:[0,0,0],scale:[1,1,1]},450,30),compose=await create('compose',{},880,30);
 edges.push(await connect(sphere,transform,'geometry','geometry'));edges.push(await connect(sphere,compose,'geometry','a'));await call('canvas_tidy');await bind(compose);
 await until(async()=>{const value=await panel();return value.error?value:null;},'compose missing visible b input');
 edges.push(await connect(transform,compose,'geometry','b'));p=await drawn(compose,{triangles:256});graph=await state();assert.equal(graph.nodes.length,3);assert.equal(graph.edges.length,3);evidence.stages.push({label:'compose-after-b-connect',panel:p,nodeCount:3,edgeCount:3,pixels:await pixels()});await screenshot('compose');
 const ground=await create('primitive',{kind:'plane',size:[8,1,8],subdivisions:0},20,490),scatterParams={count:30,seed:31,minDistance:0,maxSlope:90,minHeight:-1e6,maxHeight:1e6},scatter=await create('scatter_points',scatterParams,450,490),instances=await create('instance_on_points',{scale:[.25,.25,.25]},880,490);
 edges.push(await connect(ground,scatter,'geometry','geometry'));edges.push(await connect(scatter,instances,'points','points'));await call('canvas_tidy');await bind(instances);
 await until(async()=>{const value=await panel();return value.error?value:null;},'instances missing visible prototype input');
 edges.push(await connect(compose,instances,'geometry','prototype'));p=await drawn(instances,{instances:30});assert.equal(p.metrics.triangleCount,7680);graph=await state();assert.equal(graph.nodes.length,6);assert.equal(graph.edges.length,6);assert.ok(await page.locator('.react-flow__node').count()>0);evidence.stages.push({label:'instances30-after-prototype-connect',panel:p,nodeCount:6,edgeCount:6,renderedNodeCount:await page.locator('.react-flow__node').count(),pixels:await pixels()});await screenshot('instances');evidence.checks.push('progressive visible graph construction 1/0 to 3/3 to 6/6 nodes/edges; final real edges trigger composed mesh and shared instances');
 const beforeLayout=p.layout;const header=await page.locator('[data-pcg-viewport-drag]').boundingBox();assert.ok(header);await page.mouse.move(header.x+Math.min(100,header.width/3),header.y+header.height/2);await page.mouse.down();await page.mouse.move(header.x+Math.min(100,header.width/3)-100,header.y+header.height/2+65,{steps:12});await page.mouse.up();
 p=await until(async()=>{const value=await panel();return Math.abs(value.layout.x-beforeLayout.x)>10||Math.abs(value.layout.y-beforeLayout.y)>10?value:null;},'panel header drag');
 const preResize=p.layout,handle=await page.locator('[data-pcg-resize="se"]').boundingBox();assert.ok(handle);await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2-70,handle.y+handle.height/2-55,{steps:10});await page.mouse.up();
 p=await until(async()=>{const value=await panel();return Math.abs(value.layout.width-preResize.width)>10&&Math.abs(value.layout.height-preResize.height)>10?value:null;},'panel corner resize');const restoredLayout=p.layout;await screenshot('drag-resize');evidence.checks.push('pointer drag and corner resize update actual panel layout');
 await call('canvas_focus_node',{nodeId:sphere});const selectedNode=page.locator(`.react-flow__node[data-id="${sphere}"]`);await selectedNode.locator('.pcg-node > header').click();assert.match(await selectedNode.getAttribute('class'),/selected/);
 await page.locator('[data-pcg-viewport-drag]').click({position:{x:70,y:20}});await page.keyboard.press('Delete');await sleep(200);assert.equal((await state()).nodes.length,6,'Focused panel Delete must not delete the selected graph node.');
 await sleep(350);const beforeWheel=await page.locator('.react-flow__viewport').getAttribute('style'),surface=await page.locator('[data-pcg-viewport-canvas]').boundingBox();await page.mouse.move(surface.x+surface.width/2,surface.y+surface.height/2);await page.mouse.wheel(0,450);await sleep(250);assert.equal(await page.locator('.react-flow__viewport').getAttribute('style'),beforeWheel,'Panel wheel must not zoom the canvas graph.');
 await page.mouse.dblclick(surface.x+surface.width/2,surface.y+surface.height/2);await page.mouse.click(surface.x+surface.width/2,surface.y+surface.height/2,{button:'right'});assert.equal(await page.locator('.add-node-menu').count(),0,'Panel double click/context menu must not open graph mutation menus.');evidence.checks.push('panel Delete/wheel/double-click/context-menu stay isolated from graph selection, zoom and add menus');await call('canvas_tidy');
 const priorGeneration=p.generation;await parameters(scatter,{...scatterParams,count:50});p=await drawn(instances,{afterGeneration:priorGeneration,instances:50});assert.equal(p.metrics.triangleCount,12800);evidence.stages.push({label:'automatic-count50',panel:p});evidence.checks.push('saved upstream parameter change automatically reevaluates bound target');
 const retained=identity(p.displayed);await call('canvas_pcg_disconnect',{projectId:project.id,edgeId:edges[4]});await page.locator(`.react-flow__edge[data-id="${edges[4]}"]`).waitFor({state:'detached'});
 await until(async()=>{const value=await panel();return value.error?value:null;},'missing visible edge failure');assert.equal(identity((await panel()).displayed),retained);edges[4]=await connect(scatter,instances,'points','points');p=await drawn(instances,{instances:50});evidence.checks.push('real visible disconnect fails and retains model; reconnect restores actual DAG evaluation');
 const retainedBeforeFailure=identity(p.displayed);await parameters(scatter,{...scatterParams,count:50,minDistance:1000});const failed=await until(async()=>{const value=await panel();return value.error?value:null;},'real scatter placement failure',120000);assert.equal(identity(failed.displayed),retainedBeforeFailure);assert.match(JSON.stringify(failed.error),/INSUFFICIENT_PLACEMENT|placement|距离|放置/i);assert.ok(failed.error.message.includes(scatter),'Visible task error must identify the actual failing upstream scatter node.');await screenshot('failure-retained');
 await parameters(scatter,{...scatterParams,count:40});p=await drawn(instances,{instances:40});evidence.checks.push('native worker failure keeps last rendered model; saved correction recovers');
 let entered,release;const enteredGate=new Promise(resolve=>{entered=resolve;}),releaseGate=new Promise(resolve=>{release=resolve;});let delayed=false;
 const late=async route=>{if(!delayed&&route.request().headers().accept==='model/gltf-binary'){delayed=true;evidence.delayedModelRequest={accept:route.request().headers().accept,path:new URL(route.request().url()).pathname};entered();await releaseGate;}await route.continue();};await page.route('**/api/pcg/artifacts/**',late);
 try{await parameters(scatter,{...scatterParams,count:41});await Promise.race([enteredGate,sleep(30000).then(()=>{throw Error('Actual artifact request did not enter late-result gate.');})]);await parameters(scatter,{...scatterParams,count:42});p=await drawn(instances,{instances:42});const latest=identity(p.displayed);release();await sleep(500);assert.equal(identity((await panel()).displayed),latest);assert.equal((await panel()).metrics.instanceCount,42);}finally{release();await page.unroute('**/api/pcg/artifacts/**',late);}
 evidence.checks.push('rapid visible edits discard a deliberately late old artifact without replacing latest model');
 const contextExtension=await page.locator('[data-pcg-viewport-canvas]').evaluateHandle(canvas=>canvas.getContext('webgl2').getExtension('WEBGL_lose_context'));
 if(await contextExtension.evaluate(value=>Boolean(value))){await contextExtension.evaluate(value=>value.loseContext());const lost=await until(async()=>{const value=await panel();return value.displayed===null&&value.error?value:null;},'actual GPU context loss invalidates display');assert.equal(lost.resources.liveBuffers,0);await contextExtension.evaluate(value=>value.restoreContext());p=await drawn(instances,{instances:42});assert.ok((await pixels()).changed>200);evidence.checks.push('actual WebGL context loss invalidates display and releases GPU buffers; restore reloads verified current artifact');}
 else evidence.contextLoss={verified:false,reason:'WEBGL_lose_context extension unavailable'};await contextExtension.dispose();
 const beforeRefresh=await current();await page.reload();await page.locator('.react-flow').waitFor();const afterRefresh=await until(async()=>{try{const value=await current();return value.projectId===project.id&&value.sessionId!==beforeRefresh.sessionId&&value.sessionId===pageSessions.get(project.id)?value:null;}catch(e){if(['NO_VISIBLE_CANVAS','AMBIGUOUS_CANVAS'].includes(e.code))return false;throw e;}},'new actual page heartbeat identity after reload');evidence.reload={before:beforeRefresh,after:afterRefresh};p=await drawn(instances,{instances:42});for(const key of ['x','y','width','height'])assert.ok(Math.abs(p.layout[key]-restoredLayout[key])<=2,`Restored ${key}`);await screenshot('reload-restored');evidence.checks.push('refresh restores bound target/layout and commands bind the actual new page heartbeat identity');
 await call('canvas_pcg_preview_close',{projectId:project.id});await page.locator('[data-pcg-viewport-panel]').waitFor({state:'detached'});const closed=await panel();assert.equal(closed.open,false);assert.equal(closed.resources.liveBuffers,0);assert.equal(closed.resources.liveBytes,0);assert.equal(closed.resources.liveVaos,0);evidence.closed=closed;
 await call('canvas_pcg_preview_open',{projectId:project.id});p=await drawn(instances,{instances:42});assert.ok(p.resources.liveBuffers>0);await screenshot('reopened');evidence.checks.push('close releases owned GPU resources; reopen reconstructs current verified model');
 const other=await request('/api/projects',{name:'PCG isolated second canvas',canvas:{nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}}});await call('canvas_open_project',{projectId:other.id});const original=project;project=other;await until(async()=>{try{return (await current()).projectId===other.id;}catch{return false;}},'same-page project switch');
 const isolated=await panel();assert.equal(isolated.projectId,other.id);assert.equal(isolated.nodeId,null);assert.equal(isolated.desired,null);assert.equal(isolated.displayed,null);assert.equal((await state()).nodes.length,0);await screenshot('project-isolation');
 await call('canvas_open_project',{projectId:original.id});project=original;await until(async()=>{try{return (await current()).projectId===original.id;}catch{return false;}},'return to original project');p=await drawn(instances,{instances:42});assert.equal(p.projectId,original.id);evidence.checks.push('single-page project switching isolates target, geometry and restores original project state');
 assert.equal(context.pages().length,1);assert.deepEqual((await request('/api/queue')).jobs,[]);assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);const finalGraph=await state();assert.equal(finalGraph.edges.length,6);const persisted=await request('/api/projects/'+project.id);evidence.finalGraph={projectId:project.id,nodes:persisted.canvas.nodes.map(({id,position,data})=>({id,position,descriptorId:data.descriptorId,parameters:data.parameters})),edges:persisted.canvas.edges.map(({id,source,target,sourceHandle,targetHandle})=>({id,source,target,sourceHandle,targetHandle})),targetNodeId:instances,layout:p.layout};evidence.ok=true;evidence.externalRequests=0;evidence.pageErrors=0;
 await writeFile(evidencePath,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({ok:true,evidenceFile:evidencePath,screenshots:evidence.screenshots}));
}catch(error){let diagnostic={};try{diagnostic.canvas=await state();}catch{}try{diagnostic.panel=await panel();}catch{}try{await screenshot('failed');}catch{}
 await writeFile(evidencePath,JSON.stringify({ok:false,error:error.message,evidence,diagnostic,pageErrors,externalRequests,serverLog:logs},null,2)+'\n',{flag:'wx'});console.error(JSON.stringify({ok:false,error:error.message,evidenceFile:evidencePath,screenshots:evidence.screenshots}));throw error;
}finally{
 await browser?.close();if(base&&selected)spawnSync(selected.executable,['-c',bootstrap,root,JSON.stringify(selected.hostPackages),'stop.py'],{cwd:root,env,timeout:15000,windowsHide:true});if(backend&&backend.exitCode===null)backend.kill();for(let i=0;backend&&i<50&&backend.exitCode===null;i++)await sleep(100);
 assert.ok(path.resolve(temporary).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(temporary).startsWith('pcg-canvas-ui-'));await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
