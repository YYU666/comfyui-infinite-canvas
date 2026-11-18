import { createViewer } from './renderer.js';
import { reconstructPreview } from './preview-stream.js';

const $ = id => document.getElementById(id);
const clientId = crypto.randomUUID();
let state = null, viewer, activeEpoch = -1, loadSerial = 0, ackKey = '', loading = false, disposed = false;
let pollTimer, pollAbort, pollBusy = false, lastGraph = '', lastCatalog = '', localError = '';
let previewTimer, lastDenseLoad=0;
let reportSequence=0, ackPending='', retainedBytes=null, retainedAsset=null, eventCursor=0;
const transport={snapshots:0,meshDeltas:0,instanceDeltas:0,fallbacks:0,bytes:0,last:null};
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
    const started=performance.now(), baseAsset=retainedAsset, baseBytes=retainedBytes;
    const fetchPreview=async baseAssetId=>{
      const response=await request('/api/tool',{name:'pcg_demo_preview',arguments:{targetAssetId:asset.assetId,...(baseAssetId?{baseAssetId}:{})}});
      const descriptor=response.result;
      if(descriptor.targetAssetId!==asset.assetId||descriptor.targetSha256!==asset.sha256||descriptor.targetBytes!==asset.bytes)throw new Error('预览描述与所选产物身份不符');
      if(descriptor.kind!=='snapshot'&&(!baseAsset||descriptor.baseAssetId!==baseAsset.assetId||descriptor.baseSha256!==baseAsset.sha256))throw new Error('预览基模型身份不符');
      if(!/^\/api\/(assets\/[A-Za-z0-9_-]+\.glb|previews\/[a-f0-9]{64}\.json)$/.test(descriptor.url))throw new Error('预览URL不在本实例受管目录');
      if(!Number.isSafeInteger(descriptor.bytes)||descriptor.bytes<1||descriptor.bytes>64*1024*1024)throw new Error('预览传输超出预算');
      const answer=await fetch(descriptor.url,{cache:'no-store'});if(!answer.ok)throw new Error(`预览 HTTP ${answer.status}`);
      const chunks=[];let size=0;const reader=answer.body.getReader();
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>descriptor.bytes)throw new Error('预览大小不符');chunks.push(value);}}finally{await reader.cancel();}
      if(size!==descriptor.bytes)throw new Error('预览大小不符');
      const payload=new Uint8Array(size);let offset=0;for(const chunk of chunks){payload.set(chunk,offset);offset+=chunk.length;}
      transport.bytes+=size;
      return {descriptor,bytes:await reconstructPreview(baseBytes,descriptor,payload.buffer)};
    };
    let preview;
    const identity={instanceId:next.instanceId,selectionEpoch:epoch,assetId:asset.assetId,runId:asset.runId};
    let result;
    try{
      preview=await fetchPreview(baseAsset?.assetId);
      if(serial!==loadSerial||state.selectionEpoch!==epoch)return;
      result=preview.descriptor.kind==='snapshot'?await viewer.load(preview.bytes,identity):await viewer.update(preview.bytes,identity,preview.descriptor.kind);
    }catch(error){
      if(serial!==loadSerial||state.selectionEpoch!==epoch)return;
      if(!retainedAsset)throw error;
      transport.fallbacks++;preview=await fetchPreview(null);
      if(serial!==loadSerial||state.selectionEpoch!==epoch)return;
      result=await viewer.load(preview.bytes,identity);
    }
    if(serial!==loadSerial||state.selectionEpoch!==epoch)return;
    retainedBytes=preview.bytes;retainedAsset=asset;
    if(preview.descriptor.kind==='snapshot')transport.snapshots++;
    else if(preview.descriptor.kind==='mesh-delta')transport.meshDeltas++;
    else transport.instanceDeltas++;
    transport.last={kind:preview.descriptor.kind,bytes:preview.descriptor.bytes,targetBytes:asset.bytes,elapsedMs:performance.now()-started,assetId:asset.assetId};
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
  const completed=new Set((run?.completedStages||[]).flatMap(stage=>[stage.nodeId,...(stage.computedNodes||[]),...(stage.cacheHits||[])]));
  const cacheHits=new Set((run?.completedStages||[]).flatMap(stage=>stage.cacheHits||[]));
  for(const node of graph.nodes) {
    const div=document.createElement('div');div.className=`node ${completed.has(node.id)?'done':run?.currentNodeId===node.id?'active':''}`;
    div.textContent=`${completed.has(node.id)?'✓':run?.currentNodeId===node.id?'●':'○'} ${node.id}${cacheHits.has(node.id)?' [缓存]':''} · ${node.data?.descriptorId?.split('.').at(-1) || node.type || ''}`;$('graph').append(div);
    const definition=document.createElement('details');const label=document.createElement('summary');label.textContent='参数 / 端口 / 求值记录';
    const value=document.createElement('pre');const actual=run?.completedStages.find(stage=>stage.nodeId===node.id);
    value.textContent=JSON.stringify({parameters:node.data?.parameters,inputs:graph.edges.filter(e=>e.target===node.id).map(e=>({node:e.source,port:e.sourceHandle,to:e.targetHandle})),outputs:actual?.outputs,computedNodes:actual?.computedNodes,cacheHits:actual?.cacheHits},null,2);definition.append(label,value);div.append(definition);
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
  $('graph-identity').textContent=`graphRevision ${next.graphRevision ?? next.run?.projectRevision ?? '—'} · ${next.graphHash ?? next.run?.graphHash ?? '—'}`;
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
  if(next.selectionEpoch!==activeEpoch && next.desired && !viewer?.getState().contextLost){
    clearTimeout(previewTimer);
    const dense=(next.desired.summary?.counts?.Face||next.desired.counts?.Face||0)>50000;
    const delay=dense?Math.max(0,500-(performance.now()-lastDenseLoad)):0;
    if(delay)previewTimer=setTimeout(()=>{lastDenseLoad=performance.now();loadDesired(state);},delay);
    else{if(dense)lastDenseLoad=performance.now();loadDesired(next);}
  }
}
async function poll() {
  if(disposed || document.hidden || pollBusy)return;
  pollBusy=true;pollAbort=new AbortController();
  let retry=0;
  try{
    const response=await fetch('/api/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'pcg_demo_wait',arguments:{afterSequence:eventCursor,timeoutMs:1000}}),signal:pollAbort.signal,cache:'no-store'});
    const value=await response.json();if(!response.ok)throw new Error(value.message||'本地等待失败');
    eventCursor=value.result.cursor;applyState(value.result.state);
  }catch(exc){if(exc.name!=='AbortError'){warning(`本地连接失败：${exc.message}`);retry=500;}}
  finally{pollBusy=false;if(!disposed&&!document.hidden)pollTimer=setTimeout(poll,retry);}
}
try { viewer=createViewer($('model'),{onFrame:readyFrame}); }
catch(exc){warning(`无法创建真实 3D 视图：${exc.message}`);}
$('rotate').addEventListener('click',()=>{if(!viewer)return;const rotating=!viewer.getState().rotating;viewer.setRotating(rotating);$('rotate').textContent=rotating?'暂停转台':'继续转台';const value=viewer.getState();if(value.cameraFramed && value.loadedIdentity?.selectionEpoch===state?.selectionEpoch)sendAck(value.loadedIdentity,'loaded',value);});
$('asset').addEventListener('change',()=>tool('pcg_demo_select',{assetId:$('asset').value}).catch(exc=>warning(exc.message)));
$('run-form').addEventListener('submit',event=>{event.preventDefault();warning('');tool('pcg_demo_run',{recipe:$('recipe').value,seed:Number($('seed').value)}).catch(exc=>warning(exc.message));});
$('cancel').addEventListener('click',()=>{if(state?.run)tool('pcg_demo_cancel',{runId:state.run.runId}).catch(exc=>warning(exc.message));});
document.addEventListener('visibilitychange',()=>{clearTimeout(pollTimer);clearTimeout(previewTimer);if(document.hidden)pollAbort?.abort();else poll();});
window.addEventListener('pagehide',()=>{disposed=true;clearTimeout(pollTimer);clearTimeout(previewTimer);pollAbort?.abort();retainedBytes=null;retainedAsset=null;viewer?.dispose();});
window.pcgDemo=Object.freeze({getState:()=>structuredClone(state),getViewerState:()=>viewer?.getState(),getDiagnostics:()=>({loading,activeEpoch,localError,clientId,eventCursor,transport:structuredClone(transport),retainedBytes:retainedBytes?.byteLength??0,disposed})});
await poll();
