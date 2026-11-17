import { createViewer } from './renderer.js';

const $ = id => document.getElementById(id);
const clientId = crypto.randomUUID();
let state = null, viewer, activeEpoch = -1, loadSerial = 0, ackKey = '', loading = false, disposed = false;
let pollTimer, pollBusy = false, lastGraph = '', lastCatalog = '', localError = '';
let reportSequence=0, ackPending='';
const statusNames = {running:'运行中',cancelling:'正在取消',succeeded:'已完成',failed:'失败',cancelled:'已取消'};
const identityText = value => value ? `${value.label || value.producerNodeId || value.assetId} · ${value.assetId} · run ${value.runId || '—'}` : '—';
function warning(message='') { localError = message; $('warning').textContent = message; $('warning').hidden = !message; }
async function request(url, body) {
  const result = await fetch(url, {cache:'no-store', ...(body ? {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)} : {})});
  const data = await result.json();
  if (!result.ok) throw Object.assign(new Error(data.error?.message || data.message || `HTTP ${result.status}`), {code:data.error?.code || data.code});
  return data;
}
function tool(name,args={}) { return request('/api/tool', {name,arguments:args}).then(value => { applyState(value.result); return value.result; }); }
function readyFrame(value) {
  if(value.contextLost) {
    if(state?.desired && ackKey!=='context-lost' && ackPending!=='context-lost') {
      sendAck({selectionEpoch:state.selectionEpoch,assetId:state.desired.assetId},'context-lost',value);
    }
    $('displayed').textContent='WebGL 上下文丢失；尚未恢复实际绘制';
    $('empty').hidden=false;warning('WebGL 上下文丢失；恢复后将重新加载受管产物。');
    activeEpoch=-1;
    return;
  }
  const id = value.loadedIdentity;
  if (!state || !id || id.selectionEpoch !== state.selectionEpoch || id.assetId !== state.desired?.assetId) return;
  const key = `${id.selectionEpoch}:${id.assetId}`;
  if (!value.cameraFramed || value.sceneFrameCount < 1 || ackKey === key || ackPending === key) return;
  sendAck(id,'loaded',value);
  $('empty').hidden = true;
  $('displayed').textContent = identityText(state.catalog.find(asset => asset.assetId===id.assetId));
  $('model-title').textContent = state.desired.label || state.desired.producerNodeId || '几何产物';
  const m = value.metrics;
  $('geometry').textContent=`${m.triangleCount.toLocaleString()} 三角形 / ${m.pointCount.toLocaleString()} 点 / ${m.instanceCount.toLocaleString()} 实例`;
}
async function sendAck(id,status,value,error) {
  const sequence=++reportSequence, key=status==='context-lost'?'context-lost':`${id.selectionEpoch}:${id.assetId}`;
  ackPending=key;
  const keys=['frameCount','yaw','angle','cameraFramed','rotating','visible','meshCount','instanceCount','triangleCount','pointCount','vertexCount','drawCalls','gpuBytes','width','height'];
  const metrics={};
  for(const key of keys) if(['number','boolean'].includes(typeof value[key])) metrics[key]=value[key];
  const body={clientId,reportSequence:sequence,selectionEpoch:id.selectionEpoch,assetId:id.assetId,status,metrics,...(error?{error}: {})};
  try {
    for(let attempt=0;attempt<3;attempt++) {
      if(sequence!==reportSequence || disposed)return;
      try {
        await request('/api/viewer',body);
        if(sequence===reportSequence)ackKey=key;
        return;
      } catch(exc) {
        if(['STALE_SELECTION','STALE_REPORT'].includes(exc.code))return;
        if(attempt===2){warning(`显示回执失败，将重试：${exc.message}`);return;}
        await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
      }
    }
  } finally { if(sequence===reportSequence)ackPending=''; }
}
async function loadDesired(next) {
  const epoch=next.selectionEpoch, asset=next.desired, serial=++loadSerial;
  if (!asset || !viewer) return;
  activeEpoch=epoch; loading=true;
  $('desired').textContent=identityText(asset);
  try {
    if (!/^\/api\/assets\/[A-Za-z0-9_-]+\.glb$/.test(asset.url)) throw new Error('产物 URL 不在本实例受管目录');
    if (!Number.isSafeInteger(asset.bytes) || asset.bytes>64*1024*1024 || asset.bytes<20) throw new Error('产物超出展示预算');
    const response=await fetch(asset.url,{cache:'no-store'});
    if (!response.ok) throw new Error(`GLB HTTP ${response.status}`);
    const chunks=[]; let size=0;
    const reader=response.body.getReader();
    try { for(;;) { const {done,value}=await reader.read(); if(done)break; size+=value.byteLength; if(size>asset.bytes)throw new Error('GLB 大小与资产合同不符'); chunks.push(value); } }
    finally { await reader.cancel(); }
    if(size!==asset.bytes)throw new Error('GLB 大小与资产合同不符');
    const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==asset.sha256)throw new Error('GLB 内容校验失败');
    if(serial!==loadSerial || state.selectionEpoch!==epoch)return;
    const identity={instanceId:state.instanceId,selectionEpoch:epoch,assetId:asset.assetId,runId:asset.runId};
    const result=await viewer.load(bytes.buffer,identity);
    if(serial!==loadSerial || state.selectionEpoch!==epoch)return;
    warning('');readyFrame(result);
  } catch(exc) {
    if(serial!==loadSerial || state.selectionEpoch!==epoch)return;
    warning(`加载失败，保留上次成功模型：${exc.message}`);
    sendAck({selectionEpoch:epoch,assetId:asset.assetId},'error',viewer.getState(),String(exc.message).slice(0,300));
  } finally { if(serial===loadSerial)loading=false; }
}
function renderGraph(next) {
  const graph=next.graph, run=next.run;
  const signature=JSON.stringify([graph,run?.currentNodeId,run?.completedStages]); if(signature===lastGraph)return; lastGraph=signature;
  $('graph').replaceChildren();
  const completed=new Set((run?.completedStages||[]).map(stage=>stage.nodeId));
  for(const node of graph.nodes) {
    const div=document.createElement('div');div.className=`node ${completed.has(node.id)?'done':run?.currentNodeId===node.id?'active':''}`;
    div.textContent=`${completed.has(node.id)?'✓':run?.currentNodeId===node.id?'●':'○'} ${node.id} · ${node.data?.descriptorId?.split('.').at(-1) || node.type || ''}`;$('graph').append(div);
    const stage=run?.completedStages.find(stage=>stage.nodeId===node.id);
    for(const [port,output] of Object.entries(stage?.outputs || {})) {
      if(!['Field','Selection'].includes(output.type))continue;
      const details=document.createElement('details');details.className='field-readback';details.dataset.nodeId=node.id;
      const title=document.createElement('summary');title.textContent=`${port} · ${output.type} · ${output.domain || '—'} · ${output.count ?? output.elementCount ?? '—'} 项`;
      const associated=document.createElement('p');associated.className='mono';associated.textContent=`关联模型：${stage.associatedAssetId || '无'}`;
      const pre=document.createElement('pre');pre.textContent=JSON.stringify({...output,sample:output.sample?.slice(0,3)},null,2);
      details.append(title,associated,pre);div.append(details);
    }
    for(const edge of graph.edges.filter(edge=>(edge.source?.nodeId || edge.source)===node.id)) {
      const line=document.createElement('div');line.className='edge';line.textContent=`↳ ${edge.source}.${edge.sourceHandle} → ${edge.target}.${edge.targetHandle}`;$('graph').append(line);
    }
  }
}
function applyState(next) {
  if(!next || disposed)return;
  if(state && (next.instanceId!==state.instanceId || next.revision<state.revision))return;
  state=next;
  $('connection').textContent=`本地连接 · ${next.autoFollow?'自动跟随阶段':'手动展示'}`;
  $('instance').textContent=next.instanceId;
  const run=next.run, busy=['running','cancelling'].includes(run?.status);
  $('run-status').textContent=statusNames[run?.status] || '未运行';
  $('progress').textContent=run?`${run.stageIndex} / ${run.stageCount} 阶段 · ${run.currentNodeId || '—'}`:'可查看已有 M2 样例，或启动隔离测试。';
  $('run-id').textContent=run?`run ${run.runId}\n${run.currentTask?.runId || ''}`:'未启动测试任务';
  $('run').disabled=busy;$('cancel').disabled=!busy || run.status==='cancelling';
  if(run?.error)warning(`任务${statusNames[run.status]||run.status}，保留上次成功模型：${JSON.stringify(run.error)}`);
  renderGraph(next);
  const signature=JSON.stringify(next.catalog.map(a=>a.assetId));
  if(signature!==lastCatalog){lastCatalog=signature;$('asset').replaceChildren();for(const asset of next.catalog){const option=document.createElement('option');option.value=asset.assetId;option.textContent=asset.label || `${asset.producerNodeId} · ${asset.assetId}`;$('asset').append(option);}}
  if(next.desired){$('asset').value=next.desired.assetId;$('desired').textContent=identityText(next.desired);$('asset-detail').textContent=`${next.desired.bytes.toLocaleString()} bytes · SHA256 ${next.desired.sha256}`;}
  if(next.selectionEpoch!==activeEpoch && next.desired && !viewer?.getState().contextLost)loadDesired(next);
}
async function poll() {
  if(disposed || document.hidden || pollBusy)return;
  pollBusy=true;try{applyState(await request('/api/state'));}catch(exc){warning(`本地连接失败：${exc.message}`);}finally{pollBusy=false;}
}
try { viewer=createViewer($('model'),{onFrame:readyFrame}); }
catch(exc){warning(`无法创建真实 3D 视图：${exc.message}`);}
$('rotate').addEventListener('click',()=>{if(!viewer)return;const rotating=!viewer.getState().rotating;viewer.setRotating(rotating);$('rotate').textContent=rotating?'暂停转台':'继续转台';const value=viewer.getState();if(value.cameraFramed && value.loadedIdentity?.selectionEpoch===state?.selectionEpoch)sendAck(value.loadedIdentity,'loaded',value);});
$('asset').addEventListener('change',()=>tool('pcg_demo_select',{assetId:$('asset').value}).catch(exc=>warning(exc.message)));
$('run-form').addEventListener('submit',event=>{event.preventDefault();warning('');tool('pcg_demo_run',{recipe:$('recipe').value,seed:Number($('seed').value)}).catch(exc=>warning(exc.message));});
$('cancel').addEventListener('click',()=>{if(state?.run)tool('pcg_demo_cancel',{runId:state.run.runId}).catch(exc=>warning(exc.message));});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
window.addEventListener('pagehide',()=>{disposed=true;clearInterval(pollTimer);viewer?.dispose();});
window.pcgDemo=Object.freeze({getState:()=>structuredClone(state),getViewerState:()=>viewer?.getState(),getDiagnostics:()=>({loading,activeEpoch,localError,clientId})});
await poll();pollTimer=setInterval(poll,350);
