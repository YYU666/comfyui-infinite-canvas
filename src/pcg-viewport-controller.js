import { pcgNodeDescriptor, isPcgNode, pcgError } from './pcg-registry.js';
import { pcgTaskHandle } from './pcg-runtime.js';

const active=task=>['queued','running'].includes(task?.status);
const clone=value=>structuredClone(value);
export function pcgGraphSignature(graph) {
  return JSON.stringify({nodes:graph.nodes.filter(isPcgNode).map(n=>({id:n.id,data:{descriptorId:n.data.descriptorId,descriptorVersion:n.data.descriptorVersion,operationVersion:n.data.operationVersion,parameters:n.data.parameters}})).sort((a,b)=>a.id.localeCompare(b.id)),edges:graph.edges.filter(e=>graph.nodes.some(n=>n.id===e.source&&isPcgNode(n))||graph.nodes.some(n=>n.id===e.target&&isPcgNode(n))).map(({id,source,target,sourceHandle,targetHandle})=>({id,source,target,sourceHandle,targetHandle})).sort((a,b)=>a.id.localeCompare(b.id))});
}
export function createPcgViewportController({getContext,getNode,getGraph,runtime,persistProject,onChange=()=>{},storage=globalThis.localStorage,debounceMs=180}) {
  const projectId=getContext().projectId,key=`refmuse.pcg.viewport.v1:${projectId}`;
  let saved={};try{const value=JSON.parse(storage?.getItem(key)||'{}');if(value&&typeof value==='object'&&!Array.isArray(value))saved=value;}catch{}
  let disposed=false,timer=null,signature=pcgGraphSignature(getGraph()),epoch=0,monitorKey=null,cancelling=null,expectedRunId=null;
  let state={contractVersion:1,projectId,open:saved.open===true,nodeId:typeof saved.nodeId==='string'?saved.nodeId:null,autoRun:saved.autoRun!==false,layout:{x:32,y:60,width:440,height:360,...saved.layout},generation:0,run:null,desired:null,displayed:null,error:null,stage:null,metrics:null,resources:null,graphRevision:getContext().revision};
  function current(){const context=getContext();if(disposed||context.projectId!==projectId)throw pcgError('PROJECT_MISMATCH','Preview belongs to a different or closed project.');if(context.readOnly||context.switching)throw pcgError('READ_ONLY','Current project is not writable.');return context;}
  function publish(patch,persist=false){if(disposed)return;state={...state,...patch};if(persist)try{storage?.setItem(key,JSON.stringify({open:state.open,nodeId:state.nodeId,autoRun:state.autoRun,layout:state.layout}));}catch{}onChange();}
  function cancelOwned(){
    const task=state.run;
    if(!active(task))return cancelling||Promise.resolve();
    if(cancelling)return cancelling;
    cancelling=runtime.cancelObsolete(task).catch(error=>{if(!disposed)publish({error:{code:error.code||'CANCEL_FAILED',message:error.message,phase:'cancel',nodeId:task.nodeId}});throw error;}).finally(()=>{cancelling=null;});
    return cancelling;
  }
  function desired(task){
    if(task.status!=='succeeded'||task.stale||task.revision!==getContext().revision)return null;
    const asset=task.result?.assets?.find(a=>a.format==='glb'&&a.role==='model');if(!asset)return null;
    const handle=pcgTaskHandle(task);
    if(['projectId','revision','jobId','runId','inputHash'].some(k=>asset[k]!==handle[k])||asset.producerNodeId!==task.nodeId)throw pcgError('ASSET_IDENTITY_MISMATCH','Preview artifact differs from the actual task.');
    return {...clone(asset),handle,graphRevision:task.revision,generation:epoch};
  }
  function accept(task,ownEpoch){
    if(disposed||ownEpoch!==epoch||getContext().projectId!==projectId||task.nodeId!==state.nodeId||task.projectId!==projectId)return;
    const value=desired(task);
    publish({run:clone(task),graphRevision:getContext().revision,stage:{phase:task.status,nodeId:task.nodeId,revision:task.revision,computedNodes:task.result?.report?.computedNodes||[],cacheHits:task.result?.report?.cacheHits||[]},...(value?{desired:value}:{}),error:task.error?{...task.error,phase:task.status,nodeId:task.nodeId}:null});
  }
  async function monitor(task,ownEpoch){
    const ownKey=task.jobId+':'+ownEpoch;if(monitorKey===ownKey)return;monitorKey=ownKey;
    try{
      while(active(task)&&!disposed&&ownEpoch===epoch&&state.open){
        const result=await runtime.invoke('wait',{...pcgTaskHandle(task),timeoutMs:1000});task=result.task;accept(task,ownEpoch);
      }
    }catch(error){if(!disposed&&ownEpoch===epoch)publish({error:{code:error.code||'WAIT_FAILED',message:error.message,phase:'wait',nodeId:task.nodeId}});}
    finally{if(monitorKey===ownKey)monitorKey=null;}
  }
  function sync(){
    if(disposed||!state.open||!state.nodeId)return;
    let task;try{task=runtime.getState(state.nodeId).task;}catch{return;}
    if(!task||task.projectId!==projectId)return;
    if(state.run?.jobId!==task.jobId&&task.runId!==expectedRunId&&task.revision===getContext().revision){epoch++;publish({generation:epoch});}
    if(task.revision!==getContext().revision)return;
    accept(task,epoch);if(active(task))void monitor(task,epoch);
  }
  async function evaluate(ownEpoch){
    if(disposed||ownEpoch!==epoch||!state.open||!state.nodeId)return;
    const target=state.nodeId;
    try{
      await cancelOwned();if(disposed||ownEpoch!==epoch)return;
      current();const descriptor=pcgNodeDescriptor(getNode(target));
      await persistProject();if(disposed||ownEpoch!==epoch)return;const context=current();
      const identity={projectId,nodeId:target,revision:context.revision,descriptorVersion:descriptor.descriptorVersion,operationVersion:descriptor.operationVersion,runId:crypto.randomUUID()};
      publish({graphRevision:context.revision,error:null,stage:{phase:'preflight',nodeId:target,revision:context.revision}});
      const preflight=await runtime.invoke('preflight',identity);
      if(disposed||ownEpoch!==epoch)return;
      publish({stage:{phase:'running',nodeId:target,revision:context.revision,preflight}});
      expectedRunId=identity.runId;
      const result=await runtime.runNode(target,{runId:identity.runId,wait:false});
      if(disposed||ownEpoch!==epoch){if(active(result.task))await runtime.cancelObsolete(result.task);return;}
      accept(result.task,ownEpoch);await monitor(result.task,ownEpoch);
    }catch(error){if(!disposed&&ownEpoch===epoch)publish({error:{code:error.code||'PREFLIGHT_FAILED',message:error.message,phase:'preflight/run',nodeId:target},stage:{phase:'failed',nodeId:target,revision:getContext().revision}});}
  }
  function schedule(){expectedRunId=null;clearTimeout(timer);const ownEpoch=++epoch;publish({generation:ownEpoch,stage:{phase:'pending',nodeId:state.nodeId,revision:getContext().revision}});void cancelOwned().catch(()=>{});timer=setTimeout(()=>void evaluate(ownEpoch),debounceMs);}
  const controller={
    snapshot:()=>clone(state),
    open(){current();publish({open:true},true);void controller.restore();return controller.snapshot();},
    close(){current();clearTimeout(timer);epoch++;publish({open:false,generation:epoch,displayed:null},true);void cancelOwned().catch(()=>{});return controller.snapshot();},
    bind(nodeId,autoRun=true){current();pcgNodeDescriptor(getNode(nodeId));clearTimeout(timer);expectedRunId=null;epoch++;void cancelOwned().catch(()=>{});publish({nodeId,autoRun,error:null,generation:epoch},true);if(autoRun)schedule();else sync();return controller.snapshot();},
    layout(layout){current();for(const [k,v] of Object.entries(layout))if(!['x','y','width','height'].includes(k)||!Number.isFinite(v)||Math.abs(v)>100000)throw pcgError('INVALID_CONTRACT','Invalid viewport layout.');publish({layout:{...state.layout,...layout}},true);return controller.snapshot();},
    observeGraph(){if(disposed)return;const next=pcgGraphSignature(getGraph());if(next===signature)return;signature=next;if(state.open&&state.nodeId){if(state.autoRun)schedule();else{clearTimeout(timer);epoch++;publish({generation:epoch,stage:{phase:'stale',nodeId:state.nodeId,revision:getContext().revision}});void cancelOwned().catch(()=>{});}}},
    sync,
    async restore(){if(!state.open||!state.nodeId||disposed)return;try{await runtime.listTasks({projectId,nodeId:state.nodeId});sync();}catch(error){if(!disposed)publish({error:{code:error.code||'RESTORE_FAILED',message:error.message,phase:'restore',nodeId:state.nodeId}});}},
    rendered(report){
      if(disposed)return;
      if(report.status==='disposed'){publish({displayed:null,metrics:report.metrics,resources:report.resources});return;}
      if(report.status==='context-lost' && report.identity?.projectId===projectId){publish({displayed:null,error:{code:'CONTEXT_LOST',message:'3D context lost; restoring the selected managed model.',phase:'render',nodeId:state.nodeId},metrics:report.metrics,resources:report.resources});return;}
      if(!state.open||!report.identity||report.identity.projectId!==projectId||report.identity.generation!==epoch||report.identity.artifactId!==state.desired?.artifactId)return;
      if(report.error){publish({error:{...report.error,phase:'render',nodeId:state.nodeId},metrics:report.metrics,resources:report.resources});return;}
      if(report.rendered===false)return;
      if(state.displayed?.artifactId===state.desired.artifactId&&state.displayed?.generation===state.desired.generation&&JSON.stringify(state.resources)===JSON.stringify(report.resources))return;
      publish({displayed:clone(state.desired),metrics:report.metrics,resources:report.resources,...(state.error?.code==='CONTEXT_LOST'?{error:null}:{})});
    },
    dispose(){if(disposed)return;clearTimeout(timer);void cancelOwned().catch(()=>{});disposed=true;epoch++;},
  };
  return controller;
}
