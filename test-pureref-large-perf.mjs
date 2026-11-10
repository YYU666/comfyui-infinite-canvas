// Opt-in real-file performance/atomicity probe. Never creates source-sized JS buffers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, samePath } from './test-browser.mjs';

const source = process.env.PUREREF_LARGE_FIXTURE;
if (!source) { console.log('PUREREF_LARGE_PERF_SKIP set PUREREF_LARGE_FIXTURE to an owned real file'); process.exit(0); }
const python = process.env.H3_TEST_PYTHON || 'python';
const root = path.dirname(fileURLToPath(import.meta.url));
const evidence = path.resolve(process.env.PUREREF_EVIDENCE || '.cache/qa/pureref-large');
await mkdir(evidence,{recursive:true});
const temporary = await mkdtemp(path.join(os.tmpdir(),'h3-pureref-large-'));
const runtime = path.join(temporary,'runtime'),projects = path.join(temporary,'projects');
const backend = spawn(python,['-X','utf8','video_workbench_launcher.py'],{cwd:root,env:{...process.env,
  QWEN_API_KEY:'',DASHSCOPE_API_KEY:'',MOONSHOT_API_KEY:'',KIMI_API_KEY:'',ARK_API_KEY:'',DOUBAO_API_KEY:'',DEEPSEEK_API_KEY:'',
  H3_WORKBENCH_RUNTIME_DIR:runtime,H3_PROJECTS_ROOT:projects,H3_WORKBENCH_DATA_DIR:path.join(temporary,'data'),H3_COMFY_ROOT:path.join(temporary,'comfy'),H3_COMFY_URL:'http://127.0.0.1:1',H3_WORKBENCH_NO_BROWSER:'1',H3_WORKBENCH_TEST_MODE:'1',H3_WORKBENCH_DIST_DIR:path.join(root,'dist'),PYTHONUTF8:'1',
},stdio:['ignore','pipe','pipe']});
let logs='',base,token,browser,monitor;
for(const stream of [backend.stdout,backend.stderr]) stream.on('data',chunk=>{logs=(logs+chunk).slice(-6000);});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,timeout=1800000){const end=Date.now()+timeout;while(Date.now()<end){const result=await read();if(result)return result;await pause(100);}throw new Error('large import timed out');}
async function api(route,body,method=body?'POST':'GET'){
 const response=await fetch(base+route,{method,headers:{'X-H3-Token':token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;
}
const failures=[];
const driverGc=setInterval(()=>globalThis.gc?.(),500);
const receipt={fixture:source,sourceBytes:(await stat(source)).size,temporary,started:new Date().toISOString(),paidCalls:0};
try{
 const instance=await until(async()=>{try{return JSON.parse(await readFile(path.join(runtime,'instance.json'),'utf8'));}catch{if(backend.exitCode!==null)throw new Error(logs);return null;}},30000);
 base=`http://127.0.0.1:${instance.port}`;token=instance.token;
 const health=await api('/api/health');assert.equal(health.pid,backend.pid);assert.ok(samePath(health.projectsRoot,projects));
 const project=await api('/api/projects',{name:'Owned large PureRef probe',canvas:{nodes:[],edges:[],viewport:{x:0,y:0,zoom:1}}});
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1800,height:1200}});
 const cdp=await browser.newBrowserCDPSession();const info=await cdp.send('SystemInfo.getProcessInfo');const browserPid=info.processInfo.find(p=>p.type==='browser').id;
 const metricsPath=path.join(evidence,'memory.json');
 const watcher=`import sys,json,time,psutil,pathlib\nroots=[int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3])]\npeaks={}; samples=0\nwhile pathlib.Path(sys.argv[4]).exists():\n for label,pid in zip(['backend','browser','driver'],roots):\n  try:\n   proc=psutil.Process(pid); own=proc.memory_info().rss; children=proc.children(recursive=True); total=own+sum(p.memory_info().rss for p in children if p.is_running()); peaks[label+'Own']=max(peaks.get(label+'Own',0),own); peaks[label+'Tree']=max(peaks.get(label+'Tree',0),total)\n   if label=='backend':\n    for child in children:\n     if any('pureref_worker.py' in a for a in child.cmdline()): peaks['parserWorker']=max(peaks.get('parserWorker',0),child.memory_info().rss)\n  except psutil.Error: pass\n samples+=1\n pathlib.Path(sys.argv[5]).write_text(json.dumps(dict(peaks=peaks,samples=samples)))\n time.sleep(.1)\n`;
 const marker=path.join(evidence,'monitor-active');await writeFile(marker,'owned perf monitor');
 monitor=spawn(python,['-X','utf8','-c',watcher,String(backend.pid),String(browserPid),String(process.pid),marker,metricsPath],{stdio:'ignore'});
 const errors=[],publicationCounts=[],progressPhases=new Set();let previews=0,originalBrowserDownloads=0,chunks=0,copies=0,upstream=0; const originalRequests=[];
 page.on('requestfailed',request=>failures.push({path:new URL(request.url()).pathname,error:request.failure()?.errorText}));
 page.on('pageerror',e=>errors.push(e.message));await page.route('https://**',r=>{upstream++;return r.abort();});
 page.on('request',request=>{
  const url=new URL(request.url());
  assert.ok(!url.searchParams.has('capability'),'capability must never occur in a URL');
  if(url.pathname.endsWith('/upload')&&url.pathname.startsWith('/api/pureref/'))chunks++;
  if(url.pathname.endsWith('/copy'))copies++;
  if(url.pathname.endsWith('/preview')&&url.pathname.startsWith('/api/pureref/'))previews++;
  if(/^\/api\/projects\/prj_[A-Za-z0-9_-]+\/assets\//.test(url.pathname)&&request.method()==='GET'){originalBrowserDownloads++;originalRequests.push({path:url.pathname,type:request.resourceType()});}
  if(request.method()==='PUT'&&url.pathname===`/api/projects/${project.id}`)publicationCounts.push(request.postDataJSON().canvas.nodes.length);
 });
 page.on('response',async response=>{if(response.url().includes('/api/pureref/')&&response.status()>=400)failures.push({path:new URL(response.url()).pathname,status:response.status(),error:await response.text()});if(response.url().includes('/api/pureref/')&&response.url().endsWith('/status'))try{progressPhases.add((await response.json()).phase);}catch{}});
 await page.goto(base);await page.locator('.project-open').click();await page.locator('.neo-canvas-wrap').waitFor();
 await page.evaluate(()=>{window.__purPerf={longTasks:0,maxLongTask:0,ticks:0};new PerformanceObserver(list=>{for(const entry of list.getEntries()){window.__purPerf.longTasks++;window.__purPerf.maxLongTask=Math.max(window.__purPerf.maxLongTask,entry.duration);}}).observe({type:'longtask',buffered:true});window.__purTimer=setInterval(()=>window.__purPerf.ticks++,100);});
 const dialog=page.getByRole('dialog',{name:'导入 PureRef 图片',exact:true});
 const started=Date.now();await page.getByLabel('选择 PureRef 文件').setInputFiles(source);
 await until(async()=>{if(await dialog.getByRole('alert').count())throw new Error(await dialog.getByRole('alert').textContent());return await dialog.getByRole('button',{name:/^导入 \d+ 张图片$/}).count();});
 receipt.inspectMs=Date.now()-started;
 const label=await dialog.getByRole('button',{name:/^导入 \d+ 张图片$/}).textContent();const count=Number(label.match(/\d+/)[0]);receipt.uniqueImages=count;
 await until(async()=>await dialog.locator('.pureref-previews img').count()===Math.min(12,count));
 assert.equal(originalBrowserDownloads,0,JSON.stringify(originalRequests)); receipt.originalDownloadsBeforePublication=0;
 assert.equal((await api(`/api/projects/${project.id}`)).canvas.nodes.length,0);assert.equal(previews,Math.min(12,count));
 await page.screenshot({path:path.join(evidence,'large-preview.png')});
 const copyStart=Date.now();await dialog.getByRole('button',{name:label,exact:true}).click();
 await until(async()=>{if(await dialog.getByRole('alert').count())throw new Error(await dialog.getByRole('alert').textContent());return /已导入并保存/.test(await dialog.textContent());});
 receipt.copyPublishSaveMs=Date.now()-copyStart;
 const saved=await api(`/api/projects/${project.id}`);assert.equal(saved.canvas.nodes.length,count);assert.equal(saved.assets.length,count);assert.ok(publicationCounts.every(n=>n===0||n===count));
 assert.ok(originalBrowserDownloads <= 2,JSON.stringify(originalRequests));assert.equal(upstream,0);assert.deepEqual(errors,[]);assert.equal((await api('/api/queue')).jobs.length,0);
 const expectedPath=process.env.PUREREF_EXPECTED || source.replace(/\.pur$/i,'.json');
 const expected=JSON.parse(await readFile(expectedPath,'utf8'));
 assert.deepEqual(saved.assets.map(a=>[a.sha256,a.bytes]).sort(),expected.expected.map(a=>[a.sha256,a.bytes]).sort());
 receipt.originalAssetDigestsVerified=saved.assets.length;
 receipt.encodedImageBytes=saved.assets.reduce((n,a)=>n+a.bytes,0);receipt.revision=saved.revision;receipt.chunks=chunks;receipt.previews=previews;receipt.copies=copies;receipt.publicationCounts=publicationCounts;receipt.progressPhases=[...progressPhases];receipt.browserMainThread=await page.evaluate(()=>window.__purPerf);
 receipt.renderedNodes=await page.locator('.react-flow__node').count();await page.screenshot({path:path.join(evidence,'large-complete.png')});
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.reload();await page.locator('.neo-canvas-wrap').waitFor();assert.equal((await api(`/api/projects/${project.id}`)).canvas.nodes.length,count);receipt.reload=true;
 // Cancel a second parse before publication, leaving the accepted first batch intact.
 progressPhases.clear(); const cancelStart=Date.now();await page.getByLabel('选择 PureRef 文件').setInputFiles(source);
 await until(async()=>['verifying','extracting'].some(phase=>progressPhases.has(phase))&&dialog.getByRole('button',{name:'取消导入',exact:true}).count());
 receipt.secondUploadUntilCancelMs=Date.now()-cancelStart; const cancelClick=Date.now(); await dialog.getByRole('button',{name:'取消导入',exact:true}).click();await until(async()=>/已取消/.test(await dialog.textContent()));receipt.cancelUiMs=Date.now()-cancelClick;assert.equal((await api(`/api/projects/${project.id}`)).canvas.nodes.length,count);receipt.cancelNoNodes=true;
 receipt.totalMs=Date.now()-started;receipt.finished=new Date().toISOString();receipt.originalBrowserDownloads=originalBrowserDownloads;receipt.originalRequests=originalRequests;
 await writeFile(marker,'stop');const {unlink}=await import('node:fs/promises');await unlink(marker);await pause(250);receipt.memory=JSON.parse(await readFile(metricsPath,'utf8'));
 await writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log('PUREREF_LARGE_PERF_OK '+JSON.stringify(receipt));
}catch(error){await writeFile(path.join(evidence,'failure.txt'),logs+'\n'+JSON.stringify(failures)+'\n'+error.stack);throw error;}
finally{
 clearInterval(driverGc);monitor?.kill();if(browser)await browser.close();if(base)try{await api('/api/shutdown',{});}catch{}
 if(backend.exitCode===null){await Promise.race([new Promise(r=>backend.on('exit',r)),pause(5000)]);if(backend.exitCode===null)backend.kill();}
}
