import React, { useEffect, useRef, useState } from 'react';
import { createViewer } from '../pcg_demo_viewer/renderer.js';
import { clampPcgViewportLayout, movePcgViewportLayout, resizePcgViewportLayout, pcgArtifactRequest } from './pcg-viewport-layout.js';
import './pcg-viewport.css';

const stop=event=>event.stopPropagation();
const errorValue=error=>({code:error?.code||'VIEWPORT_ERROR',message:String(error?.message||error).slice(0,240)});
const equalLayout=(a,b)=>a&&b&&['x','y','width','height'].every(key=>a[key]===b[key]);
const sameIdentity=(a,b)=>a&&b&&JSON.stringify(a)===JSON.stringify(b);
async function readArtifact(response,request,signal){
  if(!response.ok)throw new Error(`PCG artifact request failed (${response.status}).`);
  const declared=response.headers.get('content-length');
  if(declared!==null&&Number(declared)!==request.bytes)throw new Error('PCG artifact length header mismatch.');
  const reader=response.body?.getReader();
  if(!reader)throw new Error('Bounded PCG artifact streaming is unavailable.');
  const bytes=new Uint8Array(request.bytes);let offset=0;
  try{
    while(true){
      if(signal.aborted)throw new DOMException('Aborted','AbortError');
      const {done,value}=await reader.read();if(done)break;
      if(offset+value.byteLength>bytes.length)throw new Error('PCG artifact exceeds declared byte count.');
      bytes.set(value,offset);offset+=value.byteLength;
    }
    if(offset!==bytes.length)throw new Error('PCG artifact byte count mismatch.');
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  if(digest!==request.sha256)throw new Error('PCG artifact SHA-256 mismatch.');
  return bytes.buffer;
}

/** Read-only, canvas-local PCG viewer. The parent owns graph, jobs and saved layout. */
export default function PcgViewportPanel({state,onLayout,onClose,onRendered}){
  const panelRef=useRef(null),canvasRef=useRef(null),viewerRef=useRef(null),dragRef=useRef(null),sequence=useRef(0),callbacks=useRef({onLayout,onClose,onRendered});
  callbacks.current={onLayout,onClose,onRendered};
  const [layout,setLayout]=useState(state?.layout||{x:16,y:16,width:480,height:360});
  const [display,setDisplay]=useState({status:'ready',error:null,identity:null,metrics:null});
  const [rotating,setRotating]=useState(true);
  const [reloadNonce,setReloadNonce]=useState(0);
  const currentLayout=useRef(layout);currentLayout.current=layout;
  const hostBounds=()=>({width:panelRef.current?.parentElement?.clientWidth||1,height:panelRef.current?.parentElement?.clientHeight||1});
  const commitLayout=next=>{
    if(equalLayout(currentLayout.current,next))return;
    currentLayout.current=next;setLayout(next);callbacks.current.onLayout?.(next);
  };
  const open=Boolean(state?.open),projectId=state?.projectId;
  const layoutKey=JSON.stringify(state?.layout??null);
  useEffect(()=>{
    if(!open)return;
    commitLayout(clampPcgViewportLayout(state?.layout,hostBounds()));
    const host=panelRef.current?.parentElement;
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>commitLayout(clampPcgViewportLayout(currentLayout.current,hostBounds()))):null;
    if(host)observer?.observe(host);
    return ()=>observer?.disconnect();
  },[open,projectId,layoutKey]);
  useEffect(()=>{
    if(!open||!canvasRef.current)return;
    let record;
    try{
      const viewer=createViewer(canvasRef.current,{onFrame:frame=>{
        if(viewerRef.current!==record)return;
        // Loss clears the renderer identity, so handle it before the rendered-frame identity gate.
        if(frame.contextLost||frame.error?.code==='CONTEXT_LOST'){
          if(!record.contextLost){
            record.contextLost=true;record.hasBase=false;record.acknowledged=null;record.abort?.abort();
          }
          // A draw can detect loss before the DOM loss event releases GPU ownership.
          // Publish the later notification too so the parent sees the released counters.
          const error=frame.error||{code:'CONTEXT_LOST',message:'WebGL context lost.'};
          setDisplay({status:'context-lost',error,identity:null,metrics:null});
          callbacks.current.onRendered?.({identity:record.request?.identity??null,metrics:frame.metrics,resources:frame.resources,error,rendered:false,status:'context-lost'});
          return;
        }
        if(record.contextLost){
          // Restore creates an empty GPU context. Re-fetch the unchanged desired artifact.
          record.contextLost=false;record.hasBase=false;record.acknowledged=null;
          setDisplay({status:'ready',error:null,identity:null,metrics:null});setReloadNonce(value=>value+1);
          return;
        }
        if(!record.request||!sameIdentity(frame.loadedIdentity,record.request.identity)||frame.sceneFrameCount<1||!frame.cameraFramed)return;
        const key=JSON.stringify(frame.loadedIdentity);
        if(record.acknowledged===key)return;
        record.acknowledged=key;
        const result={identity:frame.loadedIdentity,metrics:frame.metrics,resources:frame.resources,error:frame.error,rendered:true,status:frame.status,frameCount:frame.frameCount,sceneFrameCount:frame.sceneFrameCount,cameraFramed:frame.cameraFramed,updateKind:frame.updateKind};
        setDisplay({status:frame.status,error:frame.error,identity:frame.loadedIdentity,metrics:frame.metrics});callbacks.current.onRendered?.(result);
      }});
      record={viewer,request:null,acknowledged:null,projectId,hasBase:false,contextLost:false,abort:null};viewerRef.current=record;setRotating(true);setDisplay({status:'ready',error:null,identity:null,metrics:null});
    }catch(error){const value=errorValue(error);setDisplay(previous=>({...previous,status:'error',error:value}));callbacks.current.onRendered?.({identity:null,error:value,rendered:false,status:'error'});}
    return ()=>{
      sequence.current++;dragRef.current=null;
      if(record){
        if(viewerRef.current===record)viewerRef.current=null;
        record.viewer.dispose();const released=record.viewer.getState();
        callbacks.current.onRendered?.({identity:null,metrics:released.metrics,resources:released.resources,error:null,rendered:false,status:'disposed',projectId:record.projectId});
      }
    };
  },[open,projectId]);
  const desiredKey=JSON.stringify(state?.desired??null),generation=state?.generation??state?.desired?.generation;
  useEffect(()=>{
    const record=viewerRef.current;if(!open||!record||record.contextLost||!state?.desired||state.desired.generation!==generation)return;
    const own=++sequence.current,controller=new AbortController();let request;record.abort=controller;
    const active=()=>!controller.signal.aborted&&own===sequence.current&&viewerRef.current===record;
    (async()=>{
      try{
        request=pcgArtifactRequest(state.desired,projectId,window.location.origin,generation??own);
        if(state.nodeId&&request.identity.nodeId!==state.nodeId)throw new Error('PCG viewport target node mismatch.');
        record.request=request;setDisplay(previous=>({...previous,status:'loading',error:null}));
        const response=await fetch(request.url,{credentials:'same-origin',signal:controller.signal,headers:{Accept:'model/gltf-binary'}});
        const buffer=await readArtifact(response,request,controller.signal);if(!active())return;
        if(record.hasBase){
          let accepted=false;
          for(const kind of ['instance-delta','mesh-delta']){
            try{await record.viewer.update(buffer,request.identity,kind);accepted=true;break;}
            catch(error){if(!active())return;if(error.code!=='DELTA_MISMATCH')throw error;}
          }
          if(!accepted&&active())await record.viewer.load(buffer,request.identity);
        }else await record.viewer.load(buffer,request.identity);
        if(active())record.hasBase=true;
      }catch(error){
        if(!active()||error.name==='AbortError')return;
        const value=errorValue(error),frame=record.viewer.getState();setDisplay(previous=>({...previous,status:'error',error:value}));
        callbacks.current.onRendered?.({identity:request?.identity??null,metrics:frame.metrics,resources:frame.resources,error:value,rendered:false,status:'error'});
      }
    })();
    return ()=>{controller.abort();if(record.abort===controller)record.abort=null;if(sequence.current===own)sequence.current++;};
  },[open,projectId,desiredKey,generation,state?.nodeId,reloadNonce]);
  if(!open)return null;
  function begin(event,direction){
    if(event.button!==0||event.target.closest('button'))return;
    event.preventDefault();event.stopPropagation();panelRef.current?.focus({preventScroll:true});
    dragRef.current={pointerId:event.pointerId,target:event.currentTarget,direction,x:event.clientX,y:event.clientY,layout:{...currentLayout.current}};
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function move(event){
    const drag=dragRef.current;if(!drag||event.pointerId!==drag.pointerId)return;
    event.preventDefault();event.stopPropagation();
    const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
    commitLayout(drag.direction?resizePcgViewportLayout(drag.layout,drag.direction,dx,dy,hostBounds()):movePcgViewportLayout(drag.layout,dx,dy,hostBounds()));
  }
  function finish(event){const drag=dragRef.current;if(!drag||event.pointerId!==drag.pointerId)return;event.stopPropagation();dragRef.current=null;if(drag.target.hasPointerCapture?.(event.pointerId))drag.target.releasePointerCapture(event.pointerId);}
  const stage=typeof state.stage==='string'?state.stage:state.stage?.phase||state.stage?.status||state.run?.status||'idle';
  const error=state.error||display.error,artifactId=display.identity?.artifactId||'';
  return <section ref={panelRef} className="pcg-viewport-panel" data-pcg-viewport-panel="true" data-project-id={projectId} data-node-id={state.nodeId||''} data-stage={stage} data-status={display.status} data-artifact-id={artifactId} tabIndex={0} role="dialog" aria-label="PCG 模型预览" style={{left:layout.x,top:layout.y,width:layout.width,height:layout.height}} onClick={stop} onMouseDown={stop} onMouseUp={stop} onTouchStart={stop} onPointerDown={stop} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} onKeyDown={stop} onKeyUp={stop} onPaste={stop} onCopy={stop} onCut={stop} onWheel={stop} onDoubleClick={stop} onContextMenu={stop}>
    <header className="pcg-viewport-title" data-pcg-viewport-drag="true" onPointerDown={event=>begin(event,null)}>
      <span>PCG 模型预览</span><span className="pcg-viewport-controls">
        <button type="button" data-pcg-viewport-turntable="true" aria-label={rotating?'暂停转台':'开启转台'} aria-pressed={rotating} onClick={()=>{const next=!rotating;setRotating(next);viewerRef.current?.viewer.setRotating(next);}}>{rotating?'暂停转台':'开启转台'}</button>
        <button type="button" data-pcg-viewport-close="true" aria-label="关闭 PCG 预览" onClick={()=>callbacks.current.onClose?.()}>×</button>
      </span>
    </header>
    <div className="pcg-viewport-surface"><canvas ref={canvasRef} data-pcg-viewport-canvas="true" aria-label="PCG 只读三维模型" />{!artifactId&&<span className="pcg-viewport-empty">{display.status==='loading'?'正在校验模型…':'等待实际模型产物'}</span>}</div>
    <footer className="pcg-viewport-status" role="status"><span>{error?String(error.message||error).slice(0,240):`${stage}${display.status==='loading'?' · 正在更新模型':''}`}</span>{display.metrics&&<span>{display.metrics.triangleCount.toLocaleString()} 面 · {display.metrics.instanceCount.toLocaleString()} 实例</span>}</footer>
    {['n','ne','e','se','s','sw','w','nw'].map(direction=><span key={direction} className={`pcg-viewport-resize pcg-viewport-resize-${direction}`} data-pcg-resize={direction} aria-hidden="true" onPointerDown={event=>begin(event,direction)} />)}
  </section>;
}
