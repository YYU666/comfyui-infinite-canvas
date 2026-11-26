import Native3DResolution from './Native3DResolution.jsx';
import React,{useEffect,useState} from 'react';
import {nativeRequest} from './native3d.js';
import {validateLodIssueSummary} from './native3d-lod-issues.js';
export default function Native3DIssueViewer({asset,close,onResolve,onRepair,readOnly}) {
  const [report,setReport]=useState(null),[error,setError]=useState(''),[large,setLarge]=useState(false);
  const target=asset.issueTarget;const repair=asset.repairPreview===true;
  useEffect(()=>{
    let cancelled=false;setReport(null);setError('');
    nativeRequest(`/jobs/${target.jobId}/${repair?'repair-preview':'issues'}/${target.stage}`).then(value=>{if(!cancelled)setReport(repair?validateRepair(value,target):validateLodIssueSummary(value,target));}).catch(e=>{if(!cancelled)setError(e.message);});
    return()=>{cancelled=true;};
  },[target.jobId,target.stage,target.diagnosticFileSha256,target.meshHash,target.finalFileSha256,target.afterMeshHash,repair]);
  return <div className="native3d-overlay nodrag nowheel" role="dialog" aria-modal="true" aria-label="LOD问题定位" onPointerDown={e=>e.stopPropagation()}><div className="native3d-plan-dialog" style={{overflow:'auto'}}>
    <header><strong>{target.stage.toUpperCase()} · {repair?'局部修复对照':'当前候选诊断'}</strong><button onClick={close}>关闭</button></header>
    {error?<p className="native3d-error">{error}</p>:!report?<p>正在读取真实候选证据…</p>:<>
      {!repair&&asset.resolution?<Native3DResolution key={target.jobId} resolution={asset.resolution} onRepair={onRepair?settings=>onRepair(asset.nodeId,settings):undefined} disabled={readOnly||!onResolve} onCreate={async percent=>{await onResolve(asset.nodeId,percent);close();}}/>:<p>{report.summary}</p>}{repair?<><p>{report.algorithm}</p><p>修复前 {report.beforeFaceCount} 面 → 修复后 {report.afterFaceCount} 面</p></>:<><p>{report.intersectionComplete?`当前网格已完成相交检查：${report.intersectionCount} 对。`:'相交检查未完成，不能视为零相交。'}</p>
      {['confirmed_issue','certification_incomplete'].map(category=><section key={category}><strong>{category==='confirmed_issue'?'已确认问题':'认证未完成'}</strong>{report.items.filter(item=>item.classification===category).map((item,i)=><p key={i}>{asset.resolution&&/boundary/i.test(item.kind||item.code||'')?asset.resolution.message:item.label}</p>)}</section>)}
      {report.historicalMarkersOmitted&&<p>历史修复前标记不属于当前网格，已忽略。</p>}
      {report.localization==='unlocalized'&&<p>尚未定位具体问题区域；下图只是当前网格概览，不能据此判断具体失败位置。</p>}
      </>}
      <img alt={repair?"真实局部修复前后对照，来自正式任务证据":"当前候选静态诊断图；红色为已确认问题，橙色为待认证位置"} src={`/api/native3d/jobs/${target.jobId}/${repair?'repair-preview':'issues'}/${target.stage}/image`} onDoubleClick={()=>setLarge(v=>!v)} onError={()=>setError('定位图无法生成或证据校验失败；未修改模型。')} style={{width:large?1200:'100%',maxWidth:large?'none':'100%',aspectRatio:'4/3',objectFit:'contain'}}/>
      <small>静态定位图，双击放大；不是交互式3D。仅查看定位图不会启动生成；点击局部修复会提交独立任务。</small>
    </>}
  </div></div>;
}

function validateRepair(value,target) {if(value?.jobId!==target.jobId||value?.stage!==target.stage||(!/^[a-f0-9]{64}$/.test(target.finalFileSha256||'')||value.finalFileSha256!==target.finalFileSha256||value.afterMeshHash!==target.afterMeshHash)||value.afterClassification!=='accepted_repair')throw Error('修复对照与当前结果不匹配。');return value;}
