import { gpuJobText } from './gpu-job-status.js';
import Native3DTakeover from './Native3DTakeover.jsx';
import CanvasImage from './CanvasImage.jsx';
import {nativeBakePreview,nativeSharedLodVariants} from './native3d-bake-preview.js';
import {nativeOutputNode} from './native3d-output.js';
import {reviewedDownstreamWarning,reviewedDisplayTitle} from './native3d-reviewed-warning.js';
import {nativeUVOrientationError,nativeEmptyPoster} from './native3d-uv-prerequisite.js';
import Native3DResolution from './Native3DResolution.jsx';
import {lodResolution,currentLODTitle,nextDraftNotice} from './native3d-lod-resolution.js';
import {needsCanonicalLODStage} from './native3d-next-step.js';
import Native3DIssueViewer from './Native3DIssueViewer.jsx';
import {lodIssueTargets,lodBlockerLabel} from './native3d-lod-issues.js';
import {nativeProcessorRunLabel} from './native3d-rerun.js';
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { publishNative3DDrawer } from './native3d-drawer.js';
import { createPortal } from 'react-dom';
import { Handle, Position } from '@xyflow/react';
import { thumbnailUrl } from './canvas-thumbnails.js';
import { analyzePrimaryButton, nativeAdapterSchema, nativeAssetUrl, nativeLowpolyPresetLabel, nativeParameterValue } from './native3d.js';
import { WHITE_MESH_STEP_LABEL } from './white-mesh-step.js';
import './Native3D.css';
import { nativeUVIdentity,nativeUVDeliveredPreviews,native3DBusyFeedback } from './native3d-uv-preview.js';
import { fitImageView, zoomImageAt } from './native3d-image-zoom.js';
import { installViewerTextureLoader, assertViewerMaterialTextures } from './native3d-viewer-textures.js';
import Native3DPlanViewer from './Native3DPlanViewer.jsx';
import {createDemandRender} from './native3d-demand-render.js';
import {nativeVisibleStages} from './native3d-stage.js';
import {validPlanPreviews,PLAN_PREVIEW_MODES} from './native3d-runtime.js';
import {planConfirmationKey} from './native3d-plan.js';

function nativeSettingLabel(key,fallback) {
  const match=key.match(/^lod([0-4])(KeepPercent|FaceCap)$/);
  if(match){const names=['High（高模）','Medium（中模）','Low（低模）','LOD3','LOD4'];return `${names[Number(match[1])]}${match[2]==='KeepPercent'?(match[1]==='0'?'保留原高模百分比':'保留 High 百分比'):'面数上限（0不限）'}`;}
  return ({convexAngleDegrees:'凸转折角（度）',concaveAngleDegrees:'凹槽角（度）',structureScaleFraction:'结构识别尺度（对角线比例）',structureMinChainLengthFraction:'最小结构链长（对角线比例）',seamPlanningMode:'切缝顺序',regionMergeAngleDegrees:'分区合并角（度）',orientationConfirmed:'已核对表面朝向 / 法线',partitionCount:'高模分区数',aoRaySamples:'AO采样数',aoRadiusFraction:'AO半径比例',aoConcaveAngleDegrees:'凹部角度',aoDarknessThreshold:'AO暗度阈值',regionMinAreaFraction:'最小分区面积',resolution:'贴图分辨率',padding:'岛间距（像素）',chartMergeCost:'合岛倾向',packingMode:'排布方式',alignDirection:'岛方向',selectedLodLevel:'选用LOD级别'}[key]) || fallback || key;
}
export function nativeFailureSummary(error,operation) {
  const text=typeof error==='string'?error:JSON.stringify(error);
  if(operation==='uv_plan'&&/Open structural UV requires reference orientationConfirmed/i.test(text))return '请先核对表面朝向 / 法线，再预览切缝';
  if(operation==='uv'&&/overlap|重叠/i.test(text))return 'UV存在重叠，未生成可用结果';
  if(operation==='uv'&&/distortion|stretch|拉伸/i.test(text))return '局部拉伸超过限制，未生成可用结果';
  return '本步骤未完成，查看详情';
}

export const Native3DContext = createContext(null);
function Native3DImagePreview({src,alt,close}) {
  const viewport=useRef(null); const image=useRef(null); const drag=useRef(null);
  const [view,setView]=useState({scale:1,x:0,y:0}); const [panning,setPanning]=useState(false);
  const reset=scale=>{
    const host=viewport.current,content=image.current;
    if (host && content?.naturalWidth) setView(fitImageView({width:content.naturalWidth,height:content.naturalHeight},{width:host.clientWidth,height:host.clientHeight},scale));
    drag.current=null;setPanning(false);
  };
  useEffect(()=>{
    const host=viewport.current;
    const overlay=host.closest('.native3d-overlay');
    const wheel=event=>{
      event.preventDefault();event.stopPropagation();
      if (!host.contains(event.target)) return;
      const rect=host.getBoundingClientRect();
      const delta=event.deltaY*(event.deltaMode===1 ? 16 : event.deltaMode===2 ? host.clientHeight : 1);
      setView(previous=>zoomImageAt(previous,{x:event.clientX-rect.left,y:event.clientY-rect.top},Math.exp(-Math.max(-200,Math.min(200,delta))*0.002)));
    };
    overlay.addEventListener('wheel',wheel,{passive:false});
    const resize=new ResizeObserver(()=>reset());resize.observe(host);
    return ()=>{overlay.removeEventListener('wheel',wheel);resize.disconnect();drag.current=null;};
  },[src]);
  const endDrag=event=>{
    if (drag.current?.pointerId!==event.pointerId) return;
    drag.current=null;setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div role="dialog" aria-modal="true" aria-label={alt} className="native3d-overlay nodrag nowheel" onPointerDown={event=>event.stopPropagation()} onClick={event=>{event.stopPropagation();close();}}>
    <div className="native3d-image-dialog" onClick={event=>event.stopPropagation()}>
      <header><strong>{alt}</strong><button autoFocus onClick={close}>关闭</button></header>
      <div className="native3d-image-toolbar"><button onClick={()=>reset()}>适应窗口</button><button onClick={()=>reset(1)}>100%</button><output aria-label="图像缩放">{Math.round(view.scale*100)}%</output><small>滚轮缩放 · 拖动平移</small></div>
      <div ref={viewport} className={`native3d-image-viewport${panning ? ' panning' : ''}`} onPointerDown={event=>{
        if (event.button!==0) return;event.preventDefault();event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);drag.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY};setPanning(true);
      }} onPointerMove={event=>{
        const previous=drag.current;if (!previous || previous.pointerId!==event.pointerId) return;
        const dx=event.clientX-previous.x,dy=event.clientY-previous.y;
        drag.current={pointerId:event.pointerId,x:event.clientX,y:event.clientY};setView(value=>({...value,x:value.x+dx,y:value.y+dy}));
      }} onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={()=>{drag.current=null;setPanning(false);}}>
        <img ref={image} src={src} alt={alt} draggable={false} onLoad={()=>reset()} style={{transform:`translate(${view.x}px,${view.y}px) scale(${view.scale})`}} />
      </div>
    </div>
  </div>;
}
export function Native3DNode({ id, data, selected }) {
  const api = useContext(Native3DContext); const input = useRef(null);
  if(data.nativeCurrentOutputId&&data.status==='completed'){const output=nativeOutputNode({id,type:'native3d',data}).data;const fields=['nativeUVPlanConfirmation','nativeUVPlanViewed','nativeUVPlanPreviews','nativePlanPreviewMode','nativeUVPreviews','nativeUVPreviewMode','nativeBakePreviewMode','nativeStage','nativeStageDiagnostic','sourceJobId','sourceNodeId'];data={...data,...Object.fromEntries(fields.filter(key=>Object.hasOwn(output,key)).map(key=>[key,output[key]]))};}
  const [failedPoster,setFailedPoster]=useState(null);
  const [rerunBusy,setRerunBusy]=useState(false);
  const [nextBusy,setNextBusy]=useState(false);
  const nextActions=api.nextActions?.(id)||[];
  const repairStage=(data.metadata?.geometry?.stages||[]).find(stage=>stage.status==='accepted'&&stage.receipt?.childFallback?.receipt?.boundaryRetopology?.status==='complete'&&stage.stage===(data.nativeStage||data.metadata?.geometry?.selectedStage||`lod${data.metadata?.geometry?.selectedLodLevel}`));
  const acceptedLOD=data.operation==='analyze'&&data.metadata?.operation==='source_lod'&&data.metadata?.geometry?.status==='accepted'&&!data.nativeStageDiagnostic;
  const [uvBusy,setUVBusy]=useState(false); const [uvError,setUVError]=useState(''); const [enlarged,setEnlarged]=useState(false);
  const adapters = (api.capabilities?.adapters || []).filter(a => a.operation === data.operation || a.operations?.includes(data.operation));
  const adapter = adapters.find(a => (a.id || a.adapterId) === data.adapterId) || adapters[0] || api.capabilities?.operations?.[data.operation];
  const busy = ['uploading','submitting','queued','running','finishing'].includes(data.status);
  const locked = api.readOnly || busy;
  const busyFeedback=native3DBusyFeedback(data);
  const reviewedWarning=reviewedDownstreamWarning(data);
  const displayedTitle=data.operation==='image_to_3d' ? WHITE_MESH_STEP_LABEL : currentLODTitle({...data,title:reviewedDisplayTitle(data)});
  const failedLOD=data.metadata?.geometry?.status==='blocked'&&(data.operation==='source_lod'||data.metadata?.operation==='source_lod');
  const failedStage=data.nativeParameters?.localRepairStage||data.nativeParameters?.retryStage||data.metadata?.geometry?.returnedDiagnosticStage||data.metadata?.geometry?.selectedStage;
  useEffect(()=>setUVError(''),[data.nativeJobId,data.sourceJobId,data.status,data.nativeBackendStatus]);
  const retry = Boolean(data.nativeJobId && data.nativeDeliveryErrorJobId === data.nativeJobId);
  const planOutput=Boolean(data.nativeUVPlan)&&data.operation==='analyze';
  let planConfirmed=false;try{planConfirmed=Boolean(data.nativeUVPlanConfirmation&&data.nativeUVPlanConfirmation===planConfirmationKey(data.nativeUVPlan));}catch{}
  const source = data.operation === 'analyze';
  const imageToModel = data.operation === 'image_to_3d';
  const inlineOutput=api.output?.(id);
  const outputData=inlineOutput?.nativeOutputRecordId?inlineOutput.data:data;
  const rerunnableResult=source&&Boolean(outputData.sourceJobId)&&['source_lod','uv'].includes(outputData.metadata?.operation);
  const rerunStatus=rerunnableResult?api.rerunStatus?.(id):null;
  const inputs=api.inputs?.(id) || {};
  const analyzeAction=analyzePrimaryButton(data, inputs);
  const textureQc=(data.warnings||[]).some(item=>String(item?.message||item).includes('质检'));
  const orientationError=nativeUVOrientationError({data},inputs);
  const inputLowPreview=inputs.model?.data.proxyAssetPath || (/\.(glb|obj)$/i.test(inputs.model?.data.assetPath || '') ? inputs.model.data.assetPath : null);
  const planStatus=data.operation==='uv' ? api.planStatus?.(id) : null;
  const displayedParameters=data.operation==='uv' ? {...inputs.plan?.data.nativeUVPlan?.settings,...data.nativeParameters} : data.nativeParameters;
  const inputSummary=[inputs.image && `参考图：${inputs.image.data.title}`,inputs.model && `低模：${inputs.model.data.title}`,inputs.high && `高模：${inputs.high.data.title}`,inputs.plan && `方案：${inputs.plan.data.title}`].filter(Boolean).join(' · ');
  const fbxReady = api.capabilities?.sourceFormats?.includes('.fbx');
  const metadata = data.quality || data.metadata?.source || data.metadata || {};
  const displayTriangles=[metadata.triangles,metadata.faces,data.metadata?.geometry?.selectedLod,data.metadata?.source?.triangles].find(value=>Number.isInteger(value)&&value>0);
  const provenance=data.nativeStageProvenance;
  const qualityStatus=typeof data.quality==='string' ? data.quality : data.quality?.status;
  const needsReview=Boolean(qualityStatus && qualityStatus!=='accepted');
  const uvReport=data.metadata?.uv;
  const uvSummary=[Number.isFinite(uvReport?.islands) ? `${uvReport.islands}岛` : null,Number.isFinite(uvReport?.interiorCoverageRatio) ? `图集占用${(uvReport.interiorCoverageRatio*100).toFixed(1)}%` : null].filter(Boolean).join(' · ');
  const bakePreview=nativeBakePreview({id,type:'native3d',data});
  const uvIdentity=nativeUVIdentity({type:'native3d',data});
  const uvPreviews=nativeUVDeliveredPreviews({type:'native3d',data});
  const uvModes=uvPreviews ? [...(uvPreviews.layoutAssetPath||uvPreviews.layoutJobUrl?['layout']:[]),...(uvPreviews.seamsAssetPath?['seams']:[]),...(uvPreviews.checkerAssetPath?['checker']:[]),...(uvPreviews.aoAssetPath?['ao']:[]),...(uvPreviews.aoSeamsAssetPath?['ao-seams']:[]),'grey'] : ['grey'];
  const uvMode=uvModes.includes(data.nativeUVPreviewMode) ? data.nativeUVPreviewMode : uvModes[0];
  const uvPath=mode=>mode==='ao-seams' ? uvPreviews?.aoSeamsAssetPath : uvPreviews?.[`${mode}AssetPath`];
  const planPreviews=validPlanPreviews(data.nativeUVPlanPreviews,data.nativeUVPlan)?data.nativeUVPlanPreviews:null;
  const planMode=PLAN_PREVIEW_MODES.includes(data.nativePlanPreviewMode)?data.nativePlanPreviewMode:'regions';
  const planLabels={regions:'分区',convex:'加凸角',details:'加凹角/AO',ao:'AO依据'};
  const diagnostic=api.diagnosticPreview?.(id);
  const diagnosticMode=data.nativeUVDiagnosticMode==='checker'&&diagnostic?.checker?'checker':'layout';
  const poster = (bakePreview?nativeAssetUrl(api.projectId,bakePreview.selected.assetPath):null) || (uvMode==='layout'&&!uvPreviews?.layoutAssetPath?uvPreviews?.layoutJobUrl:null) || nativeAssetUrl(api.projectId, diagnostic?diagnostic[diagnosticMode]:planPreviews?planPreviews[planMode]:uvMode==='grey' ? data.posterAssetPath : uvPath(uvMode)) || (imageToModel ? nativeAssetUrl(api.projectId, inputs.image?.data.assetPath) : null);
  const posterThumbnail = typeof poster === 'string' && poster.startsWith('/api/projects/') && thumbnailUrl(poster);
  const PosterImage = posterThumbnail ? CanvasImage : 'img';
  const posterAlt=bakePreview?(bakePreview.mode==='grey'?'灰模外形（不显示烘焙材质）':`烘焙${bakePreview.selected.label}贴图（二维图集）`):diagnostic?'UV试展开 · 待检查（非合格结果）':planPreviews?`真实切缝候选 · ${planLabels[planMode]}（未展开UV）`:uvIdentity ? ({seams:'真实UV切缝预览：橙色切缝、青色边界',checker:'真实UV棋盘拉伸预览',layout:'真实UV图集',ao:'真实来源AO预览','ao-seams':'AO候选切缝预览（不代表最终切缝）',grey:'灰模外形预览（不显示UV切缝）'}[uvMode]) : data.nativeStage ? `${data.title}真实阶段预览` : '模型分析预览';
  const refreshUV=async()=>{setUVBusy(true);setUVError('');try{await api.refreshUVPreview(id);}catch(error){setUVError(error.message);}finally{setUVBusy(false);}};
  const uvLegend=uvMode==='layout' ? '真实UV图集 · 双击放大' : uvMode==='ao' ? 'AO明暗 · 双击放大' : uvMode==='ao-seams' ? '候选：橙红 AO支持 · 紫 粗分块 · 黄 辅助切割' : uvMode==='grey' ? '灰模外形 · 双击放大' : uvMode==='checker' ? 'UV棋盘 · 双击放大' : '橙：最终UV切缝 · 青：网格边界';
  useEffect(()=>{setEnlarged(false);setUVError('');},[api.projectId,data.posterAssetPath,data.assetPath,uvIdentity?.jobId,uvIdentity?.modelAssetPath]);
  useEffect(()=>{if (!enlarged) return; const close=e=>{if(e.key==='Escape'){e.stopPropagation();setEnlarged(false);}}; window.addEventListener('keydown',close,true); return ()=>window.removeEventListener('keydown',close,true);},[enlarged]);
  const faceText = Number.isInteger(displayTriangles) && displayTriangles > 0 ? (displayTriangles >= 1000 ? `${(displayTriangles / 1000).toFixed(1)}K` : String(displayTriangles)) : '';
  const badge = bakePreview ? `BAKE · ${bakePreview.selected?.label || '4K'}` : Number.isFinite(uvReport?.islands) ? `UV · ${uvReport.islands}岛` : Number.isInteger(data.metadata?.geometry?.selectedLodLevel) ? `LOD${data.metadata.geometry.selectedLodLevel}${faceText ? ` · ${faceText}` : ''}` : faceText || '3D';
  const summary = [gpuJobText(data.gpu), acceptedLOD ? `几何检查通过${faceText ? ` · ${faceText}` : ''}` : data.nativeUVPlan ? `切缝已生成 · ${planConfirmed ? '已确认' : '待确认'}` : `${displayTriangles ? `${displayTriangles} 面 · ` : ''}${({idle:'待开始',completed:'已完成',failed:'失败',error:'失败',submitting:'待提交确认',queued:'排队中',running:'处理中',finishing:'保存中',stale:'输入已改变',cancelled:'已取消',uploading:'导入中'}[data.status]||'待开始')}${needsReview?' · 待复核':''}${textureQc?' · 贴图质检告警':''}`].filter(Boolean).join(' · ');
  const alertLine = uvError || (data.error ? nativeFailureSummary(data.error, data.operation) : '') || orientationError || (!reviewedWarning && !lodResolution(data) && data.metadata?.geometry?.status === 'blocked' ? `几何未通过 · ${lodBlockerLabel(data.metadata.geometry.blocker)}` : '');
  const runLabel = retry ? '重新交付' : analyzeAction ? analyzeAction.label : (data.nativeNextStep?.action==='next_lod'||data.nativeResolution)&&!data.nativeJobId?`生成${data.nativeParameters?.retryStage?.toUpperCase()}`:nativeProcessorRunLabel(data,retry);
  const showRun = !planOutput && !failedLOD && !(data.nativeLocalRepair&&data.nativeJobId);
  const runDisabled = locked || (data.operation==='uv' && !planStatus?.ready && !retry) || (!source && adapter?.ready === false && !retry);
  const openTakeover = (focusDrawer) => {
    if (api.takeover?.(id)?.preview || focusDrawer) api.view({ takeoverNodeId: id, focusDrawer: Boolean(focusDrawer) });
    else setUVError('当前步骤没有已保存的可预览模型。');
  };
  const primary = busy
    ? { label: '取消', disabled: api.readOnly, onClick: () => api.cancel(id) }
    : data.nativeUVPlan && data.status === 'completed' && !planConfirmed
      ? { label: '审阅切缝', disabled: locked, onClick: () => { try { api.openPlan(id); } catch (e) { setUVError(e.message); } } }
      : showRun
        ? { label: runLabel, disabled: runDisabled, onClick: () => { if (analyzeAction?.action === 'import') input.current?.click(); else (retry ? api.retryDelivery(id) : api.run(id)).catch(e => setUVError(e.message)); } }
        : failedLOD && /^lod[1-4]$/.test(failedStage || '')
          ? { label: rerunBusy ? '提交中…' : `重新生成${failedStage.toUpperCase()}（新种子）`, disabled: api.readOnly || rerunBusy, onClick: async () => { setRerunBusy(true); setUVError(''); try { await api.retryLOD(id); } catch (e) { setUVError(e.message); } finally { setRerunBusy(false); } } }
          : nextActions[0]
            ? { label: nextActions[0].label, disabled: locked || nextBusy || nextActions[0].disabled, onClick: async () => { setNextBusy(true); setUVError(''); try { await api.nextStep(id, nextActions[0].action); } catch (e) { setUVError(e.message); } finally { setNextBusy(false); } } }
            : null;
  const drawer = <div className="native3d-drawer nodrag nowheel">
    {api.setNotificationSoundEnabled&&<button className="native3d-sound-toggle nodrag" aria-pressed={api.notificationSoundEnabled} onClick={()=>api.setNotificationSoundEnabled(!api.notificationSoundEnabled)}>完成提示音：{api.notificationSoundEnabled?'开':'关'}</button>}

      <nav className="native3d-stepbar" aria-label="3D制作阶段">{['LOD','局部修复','切缝方案','UV展开','材质烘焙'].map((label,i)=><span key={label} aria-current={(data.nativeLocalRepair||data.metadata?.geometry?.localRepair?1:data.nativeUVPlan||data.operation==='uv_plan'?2:data.operation==='uv'||data.metadata?.operation==='uv'?3:data.operation==='bake'||data.metadata?.operation==='bake'?4:0)===i?'step':undefined}>{label}</span>)}</nav>
      {data.nativeUVPlan&&data.status==='completed'&&!planConfirmed&&<section className="native3d-next-step"><strong>下一步：审阅并确认切缝</strong><button disabled={locked} onClick={()=>{try{api.openPlan(id);}catch(e){setUVError(e.message);}}}>先审阅并确认切缝</button><small>方案尚未确认，因此“展开UV”暂不可用。请在3D审阅面板检查切缝后手动确认。</small></section>}
      {reviewedWarning&&<section className="native3d-reviewed-warning" role="status"><strong>{reviewedWarning.message}</strong><details><summary>查看来源警告与复核凭据</summary><p>{reviewedWarning.blocker}</p><small>来源任务：{reviewedWarning.jobId}。轮廓质量仍未通过；本次结果仅供目视检查。</small></details></section>}
      {nextActions.length>0&&<div className="native3d-next-step"><strong>下一步</strong><div className="native3d-actions">{nextActions.map(item=><button key={item.action} disabled={locked||nextBusy||item.disabled} onClick={async()=>{setNextBusy(true);setUVError('');try{await api.nextStep(id,item.action);}catch(e){setUVError(e.message);}finally{setNextBusy(false);}}}>{item.label}</button>)}</div><small>仅创建并连接节点；检查后手动生成。</small></div>}
      {data.operation==='source_lod'&&data.nativeParameters?.retryStage&&!data.nativeLocalRepair&&<div className="native3d-key-settings"><label>本档保留LOD0比例（%）<input aria-label="本档保留比例" type="number" min="0" max="100" step="any" disabled={locked} value={data.nativeParameters.retryKeepPercent??''} onChange={e=>api.parameter(id,'retryKeepPercent',Number(e.target.value))}/></label><small>当前种子 {data.nativeParameters.seed} · 重新生成只重试本档</small></div>}
      {data.operation==='uv_plan'&&<section className="native3d-orientation"><label><input type="checkbox" disabled={locked} checked={data.nativeParameters?.orientationConfirmed===true} onChange={e=>{setUVError('');api.parameter(id,'orientationConfirmed',e.target.checked);}}/><span>已核对表面朝向 / 法线</span></label><button disabled={!inputLowPreview} onClick={()=>api.view({path:inputLowPreview,title:inputs.model?.data.title || '输入低模'})}>查看输入低模</button><small>检查表面朝外、与高模一致，避免凹凸识别反转。开放网格需先确认。</small>{orientationError&&<p className="native3d-error" role="status">{orientationError}</p>}<small>“预览切缝”只生成切缝方案；审阅并确认后，再执行UV展开。</small></section>}
      {['uv_plan','uv','bake'].includes(data.operation)&&<div className="native3d-key-settings"><label>贴图分辨率<select disabled={locked||data.operation==='uv'} value={data.nativeParameters?.resolution||inputs.plan?.data.nativeUVPlan?.settings?.resolution||(data.operation==='bake'?2048:4096)} onChange={e=>api.parameter(id,'resolution',Number(e.target.value))}>{[1024,2048,4096].map(n=><option key={n} value={n}>{n}</option>)}</select></label><label>岛间距（像素）<input type="number" min="1" max="64" disabled={locked||data.operation==='uv'} value={data.nativeParameters?.padding??inputs.plan?.data.nativeUVPlan?.settings?.padding??16} onChange={e=>api.parameter(id,'padding',Number(e.target.value))}/></label></div>}

      {inputSummary && <details><summary style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:145}} title={inputSummary}>已连接输入 · {inputs.model?'低模 ':''}{inputs.high?'高模 ':''}{inputs.plan?'方案':''}</summary><small>{inputSummary}</small></details>}
      {diagnostic&&<><strong>UV试展开 · 待检查</strong><div className="native3d-actions">{['layout','checker'].filter(mode=>diagnostic[mode]).map(mode=><button key={mode} disabled={locked} aria-pressed={diagnosticMode===mode} onClick={()=>api.patch(id,{nativeUVDiagnosticMode:mode})}>{mode==='layout'?'临时图集':'表面棋盘'}</button>)}</div><small>尚未最终排布，格子大小不能代表最终密度。通过检查后再烘焙。双击放大。</small></>}
      {data.operation==='uv'&&['failed','error'].includes(data.status)&&!diagnostic&&<button disabled={locked||uvBusy} onClick={async()=>{setUVBusy(true);setUVError('');try{await api.refreshDiagnosticPreview(id);}catch(e){setUVError(e.message);}finally{setUVBusy(false);}}}>{uvBusy?'保存诊断…':'显示待审UV诊断'}</button>}
      {data.nativeNaniteCandidate && <small>LOD0 · Nanite候选（未构建UE Nanite）</small>}
      {data.nativeLocalRepair&&<p>当前候选局部修复 · {data.nativeParameters.localRepairStage?.toUpperCase()} · {data.stage||data.status}</p>}
      {imageToModel && <small>{WHITE_MESH_STEP_LABEL} · 只接上一张参考图 · 只输出未展 UV、无材质的高模 GLB</small>}
      {data.operation==='source_lod' && !data.nativeLocalRepair && <small>{data.nativeParameters?.retryStage?`LOD${Number(data.nativeParameters.retryStage.slice(3))-1} → ${data.nativeParameters.retryStage.toUpperCase()} · 仅重试本档 · 种子 ${data.nativeParameters.seed}`:data.nativeParameters?.deferChildLods===false?'原高模 → High（高模）→ Medium（中模）→ Low（低模） · 本步连算后续档':'白模 → 修拓扑并只输出 High（LOD0）。中模/低模在分 UV 之后按岛继承。'}</small>}
      {data.metadata?.geometry?.highRepair?.before && data.metadata.geometry.highRepair.after && <small>拓扑体检 · 修前 {data.metadata.geometry.highRepair.before.faces ?? '—'} 面 / 非流形边 {data.metadata.geometry.highRepair.before.nonManifoldEdges ?? '—'} · 修后 {data.metadata.geometry.highRepair.after.faces ?? '—'} 面 / 非流形边 {data.metadata.geometry.highRepair.after.nonManifoldEdges ?? '—'}</small>}
      {data.operation==='uv_plan' && <small>候选缝 / 分区 / AO · 此步骤不展开UV</small>}
      {data.operation==='uv' && <small>{planStatus?.mode==='coherent'?'CPU 连续展 UV':planStatus?.mode==='structural'?'CPU 结构展 UV':planStatus?.ready?'已绑定当前确认方案':planStatus?.message || '连接低模、高模和已确认方案'}</small>}
      {data.nativeUVPlan && <button disabled={locked} onClick={()=>{try{api.openPlan(id);}catch(e){setUVError(e.message);}}}>3D审阅 / 确认方案</button>}
      {planPreviews&&<><div className="native3d-actions">{PLAN_PREVIEW_MODES.map(mode=><button key={mode} aria-pressed={planMode===mode} disabled={locked} onClick={()=>api.patch(id,{nativePlanPreviewMode:mode})}>{planLabels[mode]}</button>)}</div><small>真实候选：蓝分区 · 黄凸角 · 橙凹角 · 粉AO；尚未展开UV。</small></>}
      {planOutput && <small>确认后从方案端口连接UV展开</small>}
      {bakePreview&&<section className="native3d-next-step"><strong>{bakePreview.mode==='grey'?'灰模外形':`烘焙贴图 · ${bakePreview.selected.label}`}</strong><div className="native3d-actions">{bakePreview.channels.map(channel=><button key={channel.key} disabled={api.readOnly} aria-pressed={bakePreview.mode===channel.key} onClick={()=>api.patch(id,{nativeBakePreviewMode:channel.key})}>{channel.label}</button>)}</div><small>贴图默认只在本节点预览和附件列表里，不会自动铺到画布。双击放大。查看模型上的材质请打开3D效果。</small>{bakePreview.selected.key!=='grey'&&<button type="button" disabled={api.readOnly} onClick={()=>{try{api.extractBakeTexture(id,bakePreview.selected.key);}catch(e){setUVError(e.message);}}}>提取这张贴图到画布</button>}{bakePreview.lodVariants.length>1&&<div className="native3d-actions">{bakePreview.lodVariants.map(v=><button key={v.key} type="button" onClick={()=>api.view({path:v.path,title:data.title,materialPreview:true,lodVariants:bakePreview.lodVariants,initialLodKey:v.key})}>{v.label}{Number.isInteger(v.triangles)?` (${v.triangles.toLocaleString('zh-CN')})`:''}</button>)}</div>}<button onClick={()=>api.view({path:bakePreview.materialPath,title:data.title,materialPreview:true,lodVariants:bakePreview.lodVariants})}>查看材质效果</button></section>}
      {uvIdentity && <><div className="native3d-actions">{uvPreviews ? uvModes.map(mode=><button key={mode} aria-pressed={uvMode===mode} disabled={api.readOnly} onClick={()=>api.patch(id,{nativeUVPreviewMode:mode})}>{({seams:'最终缝',checker:'棋盘',layout:'UV图集',ao:'AO依据','ao-seams':'候选缝',grey:'灰模'})[mode]}</button>) : <button disabled={locked || uvBusy} onClick={refreshUV}>{uvBusy ? '读取UV预览…' : '显示UV切缝'}</button>}{uvPreviews && <button disabled={locked || uvBusy} title="更新UV预览" onClick={refreshUV}>{uvBusy ? '读取UV预览…' : uvPreviews.seamsAssetPath?'更新UV预览':'显示表面切缝 / 棋盘'}</button>}</div><small>{uvPreviews ? uvLegend : '当前为灰模外形；点击显示真实UV切缝与棋盘预览。'}</small>{uvPreviews?.aoUnavailable && <small>AO来源证据不足，诊断不可用。</small>}{uvError && <p className="native3d-error">{uvError}</p>}</>}
      <small>{acceptedLOD?'几何检查通过 · 可继续LOD或制作UV':data.nativeUVPlan?`切缝已生成 · ${planConfirmed?'已确认':'待确认'}`:`${displayTriangles?`${displayTriangles} 面 · `:''}${({idle:'待开始',completed:'已完成',failed:'失败',error:'失败',submitting:'待提交确认',queued:'排队中',running:'处理中',finishing:'保存中',stale:'输入已改变',cancelled:'已取消',uploading:'导入中'}[data.status]||'待开始')}${needsReview?' · 待复核':''}${textureQc?' · 贴图质检告警':''}${busy?` · ${data.progress!=null?`${Math.round(data.progress)}%`:''}`:''}`}</small>
      {uvSummary && <small>{uvSummary}</small>}
      <details className="native3d-settings"><summary>模型与设置</summary>
      <div className="native3d-settings-content"><div>{data.name || `${fbxReady ? 'FBX / ' : ''}GLB / OBJ 静态资产`}</div><small>顶点 {metadata.vertices ?? '—'}</small>
      {provenance && <div className="native3d-lineage"><small>修复与逐级减面 · 阶段输出</small><small>实际前序：{provenance.parentStage || '修复后的工作网格'}{provenance.parentTriangles ? ` · ${provenance.parentTriangles}面` : ''}</small>{provenance.referenceNodeId && <small>虚线：高模参考</small>}</div>}
      {planOutput ? <small>当前方案在3D面板审阅；调整设置请返回方案处理节点。</small> : source ? <><button disabled={locked} onClick={() => input.current?.click()}>导入{fbxReady ? 'FBX / ' : ''}GLB / OBJ</button><small>{fbxReady ? 'FBX限静态单网格、单材质、单UV；支持内嵌底色和法线贴图，变换烘焙为米。外部贴图、多材质和动画暂不支持。' : 'FBX转换器未就绪，暂不支持FBX导入导出。'}</small></> : <>
        {adapters.length === 0 && adapter ? <label>执行器<output>{adapter.label || adapter.name || ({uv:'本机UV展开',bake:'本机材质烘焙',repair_lod:'本机修复与逐级减面',image_to_3d:'TripoSR · 独立 CUDA',material_wear:'高模凸棱曲率'}[data.operation]) || data.operation}{adapter.ready === false ? ' · 未就绪' : ''}</output></label> : <label>执行器<select disabled={locked||Boolean(data.nativeParameters?.retryStage)||Boolean(data.nativeLocalRepair)} value={data.adapterId || adapter?.id || adapter?.adapterId || ''} onChange={e => api.patch(id,{ adapterId:e.target.value,nativeParameters:data.nativeAdapterParameters?.[e.target.value] || {},nativeAdapterParameters:{...data.nativeAdapterParameters,[data.adapterId || adapter?.id || '']:data.nativeParameters || {}} })}><option value="">选择执行器</option>{adapters.map(a => <option key={a.id || a.adapterId} value={a.id || a.adapterId}>{a.label || a.name || a.id}{a.ready === false ? ' · 未就绪' : ''}</option>)}</select></label>}
        {data.operation === 'ai_lowpoly' && <small>{nativeLowpolyPresetLabel(data)}</small>}
        {data.nativeLocalRepair?<small>固定绑定当前候选与原高模；修复完成后请检查新结果。失败时可保留更多面。</small>:data.operation==='source_lod'&&data.nativeParameters?.retryStage?<><label>保留LOD0百分比<input type="number" min={nativeAdapterSchema(adapter).properties?.retryKeepPercent?.minimum??0} max={data.nativeResolution?.maxPercent??100} step="any" disabled={locked} value={data.nativeParameters.retryKeepPercent??''} onChange={e=>api.parameter(id,'retryKeepPercent',e.target.value===''?undefined:Number(e.target.value))}/></label><small>目标：{data.nativeParameters.retryStage.toUpperCase()} · 当前种子：{data.nativeParameters.seed}。沿用原任务设置；每次重新生成仅重试本档并自动更换种子，不重跑其他LOD。</small></>:<details><summary>{data.operation==='source_lod'?'LOD保留比例 / 面数上限':data.operation==='uv_plan'?'切缝与展开设置':'高级参数'}</summary>{Object.entries(nativeAdapterSchema(adapter).properties || {}).filter(([key])=>!(data.operation==='uv_plan'&&key==='orientationConfirmed') && !/(Evidence|Plan|Hash|planJobId|planSha256|reviewedBoundary|localRepair|bakeJobId)/.test(key) && !(data.operation==='source_lod'&&['retryJobId','retryStage','localRepairJobId','localRepairStage','seed'].includes(key)) && (data.operation!=='uv' || !inputs.plan || Object.hasOwn(inputs.plan.data.nativeUVPlan?.settings || {},key) || key==='externalGeometryReviewed')).map(([key,rule]) => <label key={key} title={rule.description}>{nativeSettingLabel(key,rule.title)}{rule.enum ? <select disabled={locked} value={nativeParameterValue(adapter,displayedParameters,key,rule) ?? ''} onChange={e => api.parameter(id,key,rule.type === 'number' || rule.type === 'integer' ? Number(e.target.value) : e.target.value)}>{rule.enum.map(v=><option key={String(v)} value={v}>{key==='seamPlanningMode'?({'ai_structure_ao_v2':'AI分区 → 凸角 → 凹槽/AO','ai_coarse_harmonic_v3':'保留AI大块 → 必要补缝 → 固定边界展开'}[v]||String(v)):String(v)}</option>)}</select> : <input disabled={locked} type={rule.type === 'boolean' ? 'checkbox' : ['integer','number'].includes(rule.type) ? 'number' : 'text'} min={rule.minimum} max={rule.maximum} step={rule.type === 'integer' ? 1 : 'any'} checked={rule.type === 'boolean' ? (nativeParameterValue(adapter,displayedParameters,key,rule) ?? false) : undefined} value={rule.type === 'boolean' ? undefined : nativeParameterValue(adapter,displayedParameters,key,rule) ?? ''} onChange={e => api.parameter(id,key,rule.type === 'boolean' ? e.target.checked : ['integer','number'].includes(rule.type) ? Number(e.target.value) : e.target.value)} />}</label>)}</details>}
      </>}
      {data.warnings?.length > 0 && <details><summary>注意事项 · {data.warnings.length}</summary>{data.warnings.map((w,i)=><p key={i}>{typeof w === 'string' ? w : w.message}</p>)}</details>}
      {(data.nativeArtifacts || []).some(a=>['texture','export','report'].includes(a.role)) && <details><summary>贴图、报告与导出文件</summary>{data.nativeArtifacts.filter(a=>['texture','export','report'].includes(a.role)).map(a=><a key={a.assetPath} href={nativeAssetUrl(api.projectId,a.assetPath)} download>{a.name}</a>)}</details>}
      {data.resultAssetPath && <a href={nativeAssetUrl(api.projectId,data.resultAssetPath)} download>下载模型</a>}
      </div></details>
      {(adapter?.ready === false || api.capabilityError) && <p className="native3d-error">{adapter?.reason || api.capabilityError || '执行器未就绪'}</p>}
      {repairStage&&data.sourceJobId&&<button disabled={locked} onClick={()=>api.openRepair({jobId:data.sourceJobId,stage:repairStage.stage,afterMeshHash:repairStage.mesh_hash,finalFileSha256:repairStage.file_sha256||data.assetPath?.match(/^assets\/([a-f0-9]{64})\.glb$/)?.[1]})}>查看局部修复对照</button>}
      {nextDraftNotice(data,inputs)&&<small>{nextDraftNotice(data,inputs)}</small>}
      {data.nativeResolutionSaveFailed&&<p className="native3d-error">调整草稿保留在本页，保存未完成；回到来源重复创建可重试保存。</p>}
      {data.nativeNextStepSaveFailed&&<p className="native3d-error">节点保留在本页，保存未完成；回到来源重复点击下一步可重试保存。</p>}
      {!planOutput&&<div className="native3d-actions">{!failedLOD&&!(data.nativeLocalRepair&&data.nativeJobId)&&<button disabled={locked || (data.operation==='uv' && !planStatus?.ready && !retry) || (!source && adapter?.ready === false && !retry)} onClick={() => analyzeAction?.action==='import' ? input.current.click() : (retry ? api.retryDelivery(id) : api.run(id)).catch(e => setUVError(e.message))}>{retry ? '重新交付' : analyzeAction ? analyzeAction.label : (data.nativeNextStep?.action==='next_lod'||data.nativeResolution)&&!data.nativeJobId?`生成${data.nativeParameters?.retryStage?.toUpperCase()}`:nativeProcessorRunLabel(data,retry)}</button>}{busy && <button disabled={api.readOnly} onClick={() => api.cancel(id)}>取消</button>}{!bakePreview&&<button disabled={!data.proxyAssetPath} onClick={() => api.view({path:data.proxyAssetPath,title:data.title,materialPreview:['bake','material_wear','image_to_3d'].includes(data.metadata?.operation),lodVariants:nativeSharedLodVariants(outputData)})}>{data.metadata?.operation==='bake'?'查看材质效果':'查看3D代理'}</button>}</div>}
      {failedLOD&&/^lod[1-4]$/.test(failedStage||'')&&<button disabled={api.readOnly||rerunBusy||busy} onClick={async()=>{setRerunBusy(true);setUVError('');try{await api.retryLOD(id);}catch(e){setUVError(e.message);}finally{setRerunBusy(false);}}}>{rerunBusy?'提交中…':`重新生成${failedStage.toUpperCase()}（新种子）`}</button>}
      {(data.nativeRun?.opId||data.sourceJobId)&&<button disabled={api.readOnly||rerunBusy} onClick={async()=>{setRerunBusy(true);setUVError('');try{await api.syncTask(id);}catch(e){setUVError(e.message);}finally{setRerunBusy(false);}}}>同步任务状态</button>}
      {rerunnableResult && !failedLOD && <section className="native3d-rerun"><strong>同档重试 / 调整</strong><button disabled={locked||rerunBusy||!rerunStatus?.ready} onClick={async()=>{setRerunBusy(true);setUVError('');try{await api.rerunResult(id);}catch(error){setUVError(error.message);}finally{setRerunBusy(false);}}}>{rerunBusy?'提交中…':data.metadata.operation==='source_lod'?(rerunStatus?.label||'重试本档LOD（新种子）'):'重新分UV'}</button>{rerunStatus?.ready?<small>原处理节点：{rerunStatus.processorTitle}。{rerunStatus.scope}{data.metadata.operation==='uv'?'已有结果保留；修改设置请到原处理节点。':''}</small>:<p className="native3d-error">{rerunStatus?.message||'原处理任务暂不可用。'}</p>}</section>}
      {uvError && <p className="native3d-error">{uvError}</p>}
      {needsCanonicalLODStage(data)&&<small>请先打开下方的实际LOD阶段，再继续制作。</small>}
      {(source||data.nativeCurrentOutputId) && !planOutput && ['source_lod','repair_lod'].includes(data.metadata?.operation) && data.metadata?.geometry?.status==='accepted' && <details><summary>创建实际LOD阶段</summary>{nativeVisibleStages(data).filter(s=>s.stage!==(data.nativeStage||data.metadata?.geometry?.selectedStage)||(data.nativeArtifacts||[]).find(a=>a.name===s.filename&&a.role==='export')?.assetPath!==data.assetPath).map(s=><button key={s.stage} disabled={locked} onClick={()=>api.createStage({sourceId:id,stage:s.stage}).then(()=>api.persist?.()).catch(e=>setUVError(e.message))}>{s.stage.toUpperCase()}{s.lodLevel===0?' / Nanite候选':''}</button>)}</details>}
      {['source_lod','repair_lod'].includes(data.operation) && data.metadata?.geometry?.chainStatus === 'blocked' && data.metadata.geometry.chainComplete===false && data.metadata.geometry.status === 'accepted' && <p className="native3d-error">部分LOD未完成：当前选用档已通过，其余档位请查看报告。</p>}
      {lodResolution(data)&&<Native3DResolution compact key={data.nativeJobId||data.sourceJobId} resolution={{...lodResolution(data),repairAttempt:Boolean(data.nativeLocalRepair||data.metadata?.geometry?.localRepair)}} onRepair={settings=>api.repairLOD(id,settings)} disabled={locked} onCreate={percent=>api.createResolution(id,percent)}/>}
      {!reviewedWarning&&!lodResolution(data)&&data.metadata?.geometry?.status === 'blocked' && <p className="native3d-error">几何未通过 · 仅诊断：{lodBlockerLabel(data.metadata.geometry.blocker)}</p>}
      {(!reviewedWarning?lodIssueTargets(data):[]).map(target=><button key={target.stage} disabled={locked} onClick={()=>api.openIssues(target,id)}>{target.stage.toUpperCase()} · 查看问题位置 / 诊断概览</button>)}
      {data.error && <div><p className="native3d-error">{nativeFailureSummary(data.error,data.operation)}</p><details><summary>失败详情</summary><small style={{overflowWrap:'anywhere'}}>{typeof data.error==='string'?data.error:JSON.stringify(data.error)}</small></details></div>}

  </div>;
  useLayoutEffect(() => { publishNative3DDrawer(id, drawer); });
  useLayoutEffect(() => () => publishNative3DDrawer(id, null), [id]);
  return <div className={`native3d-node ${selected ? 'selected' : ''} ${busy?'native3d-busy':''}`} onPointerDownCapture={()=>api.unlockNotificationSound?.()}>
    <header><i className="native3d-mark" aria-hidden="true" /><strong title={displayedTitle}>{displayedTitle}</strong><span className="native3d-badge">{badge}</span></header>
    <input hidden ref={input} type="file" accept={fbxReady ? '.fbx,.glb,.obj' : '.glb,.obj'} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) api.importModel(id,file).catch(() => {}); }} />
    {source && !data.sourceJobId && <Handle type="target" position={Position.Left} id="model" title="模型输入" />}
    {source && data.sourceJobId && <Handle type="target" position={Position.Left} id="provenance" />}
    {source && provenance?.referenceNodeId && <Handle type="target" position={Position.Left} id="reference" style={{top:'72%',background:'#8a8263'}} />}
    {!source && <Handle type="target" position={Position.Left} id={imageToModel ? 'image' : 'model'}
      title={imageToModel ? '参考图' : data.operation === 'material_wear' ? '已烘焙模型' : '处理模型 / UV低模'} />}
    {(['uv_plan','uv','bake'].includes(data.operation)||(data.operation==='source_lod'&&/^lod[1-4]$/.test(data.nativeParameters?.localRepairStage||data.nativeParameters?.retryStage||''))) && <><Handle type="target" position={Position.Left} id="high" style={{top:'72%',background:'#ad9368'}} title="高模参考（必接）"/><span className="native3d-port-high">高模</span></>}
    {data.operation==='uv' && <><Handle type="target" position={Position.Left} id="plan" style={{top:'88%',background:'#a18bd2'}} title="已确认切缝方案"/><span className="native3d-port-plan">方案</span></>}
    {data.operation==='uv' && data.status==='completed' && data.nativeProcessEvidenceUV?.jobId===data.nativeJobId && data.nativeProcessEvidenceUV?.assetPath===data.resultAssetPath && <Handle type="target" position={Position.Left} id="diagnostic" style={{top:'82%',background:'#8a8263'}} title="流程证据 · 非执行输入" />}
    <Handle type="source" position={Position.Right} id={planOutput||data.operation==='uv_plan'?'plan':'model'} title={planOutput||data.operation==='uv_plan'?'切缝方案':'模型输出'} />
    <div className="native3d-poster" onDoubleClick={e=>{if(data.nativeUVPlan){e.stopPropagation();try{api.openPlan(id);}catch(error){setUVError(error.message);}}}}>{poster&&failedPoster!==poster ? <PosterImage {...(posterThumbnail?{source:poster}:{src:poster,onError:()=>setFailedPoster(poster)})} loading="lazy" decoding="async" draggable={false} alt={posterAlt} title={data.nativeUVPlan?'双击3D审阅':'双击放大预览'} onDoubleClick={e=>{if(data.nativeUVPlan)return;e.stopPropagation();setEnlarged(true);}} /> : <span>{failedPoster===poster&&poster?(bakePreview?'贴图文件暂不可用，请切换通道或查看材质效果':'预览文件暂不可用；可手动更新UV预览'):nativeEmptyPoster(data,inputs)}</span>}
      {busyFeedback&&<div className="generation-overlay" role="status" aria-live="polite"><div><i style={{width:`${busyFeedback.progress??0}%`}} /></div><span>{busyFeedback.title}{busyFeedback.progress!==null?` ${busyFeedback.progress}%`:''}{busyFeedback.stage?` · ${busyFeedback.stage}`:''}</span></div>}
    </div>
    {enlarged && poster && createPortal(<Native3DImagePreview key={`${api.projectId}:${poster}`} src={poster} alt={posterAlt} close={()=>setEnlarged(false)} />,document.body)}
    <p className="native3d-summary" title={summary}>{summary}</p>
    {alertLine && <p className="native3d-alert" role="status" title={alertLine}>{alertLine}</p>}
    {bakePreview&&<div className="native3d-actions">{bakePreview.channels.map(channel=><button key={channel.key} type="button" disabled={api.readOnly} aria-pressed={bakePreview.mode===channel.key} onClick={()=>api.patch(id,{nativeBakePreviewMode:channel.key})}>{channel.label}</button>)}{bakePreview.lodVariants.length>1&&bakePreview.lodVariants.map(v=><button key={v.key} type="button" onClick={()=>api.view({path:v.path,title:data.title,materialPreview:true,lodVariants:bakePreview.lodVariants,initialLodKey:v.key})}>{v.label}{Number.isInteger(v.triangles)?` (${v.triangles.toLocaleString('zh-CN')})`:''}</button>)}</div>}
    <div className="native3d-card-actions">
      {primary&&<button type="button" className="nodrag" disabled={primary.disabled} onClick={primary.onClick}>{primary.label}</button>}
      {api.takeover&&<button className="native3d-takeover-button nodrag" type="button" onClick={()=>openTakeover(false)}>接手模型</button>}
      <button type="button" className="nodrag" onClick={()=>openTakeover(true)}>参数 / 更多</button>
    </div>
  </div>;
}
function Native3DAssetViewer({ asset, projectId, close, takeover }) {
  const host = useRef(null);
  const [error, setError] = useState('');
  const [objects, setObjects] = useState([]);
  const [previewMode, setPreviewMode] = useState(asset.materialPreview ? 'material' : 'structure');
  const lodVariants = Array.isArray(asset.lodVariants) ? asset.lodVariants : [];
  const [activeLodKey, setActiveLodKey] = useState(() => asset.initialLodKey || lodVariants.find(v => v.path === asset.path)?.key || lodVariants[0]?.key || '');
  const activeVariant = lodVariants.find(v => v.key === activeLodKey) || null;
  const activePath = activeVariant?.path || asset.path;
  const previewModeRef = useRef(previewMode); previewModeRef.current = previewMode;
  const materialControl = useRef(null);
  useEffect(() => { setPreviewMode(asset.materialPreview ? 'material' : 'structure'); }, [asset.path, asset.materialPreview]);
  useEffect(() => {
    const list = Array.isArray(asset.lodVariants) ? asset.lodVariants : [];
    setActiveLodKey(asset.initialLodKey || list.find(v => v.path === asset.path)?.key || list[0]?.key || '');
  }, [asset.path, asset.initialLodKey, lodVariants.length]);
  useEffect(() => { materialControl.current?.(previewMode); }, [previewMode]);
  useEffect(() => {
    let disposed = false, renderer, controls, model, applyMode,invalidate,resize,demand;
    const abort = new AbortController();
    const originals = new Map(), overrides = new Map();
    const ownedMaterials = new Set();
    setError('');
    setObjects([]);
    const release = () => {
      demand?.dispose();resize?.disconnect(); controls?.dispose();
      if (materialControl.current === applyMode) materialControl.current = null;
      const materials = new Set(ownedMaterials), geometries = new Set(), textures = new Set();
      model?.traverse(object => {
        if (object.geometry) geometries.add(object.geometry);
        const original = originals.get(object) || object.material;
        for (const material of Array.isArray(original) ? original : original ? [original] : []) materials.add(material);
      });
      for (const material of materials) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        material.dispose();
      }
      for (const texture of textures) texture.dispose();
      for (const geometry of geometries) geometry.dispose();
      renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
    if (!activePath) { setError(''); setObjects([]); return () => { disposed = true; abort.abort(); }; }
    (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
      const response = await fetch(nativeAssetUrl(projectId, activePath), { signal: abort.signal });
      if (!response.ok) throw new Error('代理模型读取失败');
      const buffer = await response.arrayBuffer(); if (disposed) return;
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(url => { if (/^(blob:|data:)/.test(url)) return url; throw new Error('代理包含外部资源，已拒绝加载'); });
      if (activePath.toLowerCase().endsWith('.obj')) {
        const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
        model = new OBJLoader(manager).parse(new TextDecoder().decode(buffer));
      } else {
        const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
        const loader=installViewerTextureLoader(new GLTFLoader(manager),THREE.TextureLoader,manager);
        const gltf=await loader.parseAsync(buffer, '');
        model=gltf.scene;
        const materials=await gltf.parser.getDependencies('material');
        assertViewerMaterialTextures(gltf.parser.json.materials || [],materials);
      }
      if (disposed) { release(); return; }
      // Overrides belong only to this viewer. Imported source materials remain
      // untouched and can be restored without reparsing or exporting the model.
      const loadedObjects = [];
      model.traverse(object => {
        if (!object.isMesh || !object.material) return;
        const triangles = Math.floor((object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3);
        loadedObjects.push({ name: object.name || '网格 ' + (loadedObjects.length + 1), triangles });
        originals.set(object, object.material);
        const makeMatte = () => {
          const material = new THREE.MeshStandardMaterial({ color: '#b7bec9', roughness: 0.82, metalness: 0, side: THREE.DoubleSide });
          ownedMaterials.add(material); return material;
        };
        overrides.set(object, Array.isArray(object.material) ? object.material.map(makeMatte) : makeMatte());
      });
      applyMode = mode => {
        for (const [object, original] of originals) {
          const matte = overrides.get(object);
          for (const material of Array.isArray(matte) ? matte : [matte]) material.wireframe = mode === 'wireframe';
          object.material = mode === 'material' ? original : matte;
        }
        invalidate?.();
      };
      materialControl.current = applyMode;
      applyMode(previewModeRef.current);
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#161b24');
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.01);
      model.position.sub(center);
      const key = new THREE.DirectionalLight(0xfff2df, 4);
      key.position.set(size * 1.5, size * 2, size * 1.5);
      const fill = new THREE.DirectionalLight(0xc6dcff, 2);
      fill.position.set(-size * 1.5, size * 0.6, -size);
      scene.add(model, new THREE.HemisphereLight(0xffffff, 0x687080, 1.8), key, fill);
      const camera = new THREE.PerspectiveCamera(45, 760 / 520, 0.001, size * 100);
      camera.position.set(size, size * 0.6, size);
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(760, 520);
      host.current.appendChild(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
      demand=createDemandRender({update:()=>controls.update(),render:()=>renderer.render(scene,camera)});invalidate=demand.invalidate;
      controls.addEventListener('change',invalidate);
      resize=new ResizeObserver(()=>{if(disposed)return;const width=Math.min(host.current.clientWidth || 760,1066),height=Math.round(width*.75);renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();invalidate();});resize.observe(host.current);
      invalidate();
      setObjects(loadedObjects);
    })().catch(error => { if (!disposed) setError(error.message); });
    return () => { disposed = true; abort.abort(); release(); };
  }, [activePath, projectId]);
  useEffect(() => {
    if (!takeover) return;
    const escape = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [Boolean(takeover), close]);
  const totalTriangles = objects.reduce((sum, item) => sum + (item.triangles || 0), 0);
  const lodButtons = lodVariants.length > 1 ? lodVariants.map(v => <button key={v.key} type="button" aria-pressed={activeLodKey === v.key} onClick={() => setActiveLodKey(v.key)}>{v.label}{Number.isInteger(v.triangles) ? ` (${v.triangles.toLocaleString('zh-CN')})` : ''}</button>) : null;
  if (takeover) return <div className="native3d-overlay nodrag" role="dialog" aria-modal="true" aria-label="模型接手">
    <div className="native3d-takeover">
      <header><strong><small>模型接手</small>{takeover.state.title}{totalTriangles > 0 ? ` · ${totalTriangles.toLocaleString('zh-CN')} 面` : ''}</strong><div>
        {lodButtons}
        {['material','structure','wireframe'].map(mode => <button key={mode} type="button" aria-pressed={previewMode===mode} onClick={()=>setPreviewMode(mode)}>
          {({material:'材质',structure:'结构',wireframe:'线框'})[mode]}
        </button>)}
        <button type="button" onClick={close}>关闭</button>
      </div></header>
      <div className="native3d-takeover-body">
        <div className="native3d-takeover-model">
          <div ref={host} className="native3d-takeover-viewport" aria-label="实时 3D 视口" data-model-ready={objects.length > 0} />
          {error ? <p role="alert">{error}</p> : !objects.length ? <p role="status">正在加载已保存模型</p> : null}
        </div>
        <Native3DTakeover {...takeover} objects={objects} focusDrawer={takeover.focusDrawer} />
      </div>
    </div>
  </div>;
  return <div className="native3d-overlay nodrag" role="dialog" aria-label="3D代理查看器"><div>
    <header>{asset.title} · {activeVariant ? activeVariant.label : '分析代理'}{totalTriangles > 0 ? ` · ${totalTriangles.toLocaleString('zh-CN')} 面` : ''}<div>
      {lodButtons}
      {['material','structure','wireframe'].map(mode => <button key={mode} type="button" aria-pressed={previewMode===mode} onClick={()=>setPreviewMode(mode)}>
        {({material:'材质',structure:'结构',wireframe:'线框'})[mode]}
      </button>)}
      <button onClick={close}>关闭</button>
    </div></header>
    <div ref={host} />{error && <p>{error}</p>}
  </div></div>;
}

export function Native3DViewer(props) {
  const api = useContext(Native3DContext);
  if (props.asset.takeoverNodeId) {
    const state = api.takeover?.(props.asset.takeoverNodeId);
    if (!state || (!state.preview && !props.asset.focusDrawer)) return null;
    return <Native3DAssetViewer {...props} asset={state.preview || { path: '', title: state.title, materialPreview: false, lodVariants: [] }} takeover={{api, state, focusDrawer: Boolean(props.asset.focusDrawer)}} />;
  }
  return props.asset.issueTarget ? <Native3DIssueViewer {...props}/> : props.asset.plan ? <Native3DPlanViewer {...props}/> : <Native3DAssetViewer {...props}/>;}
