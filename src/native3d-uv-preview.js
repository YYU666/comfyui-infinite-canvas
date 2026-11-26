export function nativeUVIdentity(node) {
  const d=node?.data;
  if (node?.type!=='native3d' || d?.status!=='completed' || d.metadata?.operation!=='uv') return null;
  const jobId=d.operation==='uv' ? d.nativeJobId : d.operation==='analyze' ? d.sourceJobId : null;
  const modelAssetPath=d.operation==='uv' ? d.resultAssetPath : d.assetPath;
  if (!/^n3d_[a-f0-9]{32}$/.test(jobId || '') || !/^assets\/[a-f0-9]{64}\.(glb|obj)$/i.test(modelAssetPath || '')) return null;
  return {jobId,modelAssetPath};
}

export function nativeUVHasLayout(job) {
  const expected=`/api/native3d/jobs/${encodeURIComponent(job.id)}/files/uv-layout.png`;
  return (job.result?.files || []).some(file=>file.name==='uv-layout.png' && file.role==='export' && file.mime==='image/png' && file.url===expected);
}

export async function saveNativeUVPreviews(identity,{fetchPreview=fetch,saveFile,assertCurrent,includeAO=false,includeLayout=false}) {
  const paths={};
  for (const mode of ['seams','checker',...(includeLayout ? ['layout'] : []),...(includeAO ? ['ao','ao-seams'] : [])]) {
    assertCurrent();
    const response=await fetchPreview(mode==='layout' ? `/api/native3d/jobs/${encodeURIComponent(identity.jobId)}/files/uv-layout.png` : `/api/native3d/jobs/${encodeURIComponent(identity.jobId)}/uv-preview/${mode}`);
    assertCurrent();
    if (mode.startsWith('ao') && response.status===409) { paths.aoUnavailable=true; delete paths.aoAssetPath; break; }
    if (!response.ok) throw new Error(`UV预览未交付：HTTP ${response.status}`);
    const blob=await response.blob(); assertCurrent();
    if (blob.type!=='image/png' || blob.size<8 || blob.size>8*1024*1024) throw new Error('UV预览不是有效的有界PNG。');
    const signature=new Uint8Array(await blob.slice(0,8).arrayBuffer()); assertCurrent();
    if (signature.join(',')!=='137,80,78,71,13,10,26,10') throw new Error('UV预览PNG签名无效。');
    const path=await saveFile(new File([blob],`uv-${mode}.png`,{type:'image/png'})); assertCurrent();
    if (!/^assets\/[a-f0-9]{64}\.png$/i.test(path || '')) throw new Error('UV预览尚未保存为项目素材。');
    paths[mode==='ao-seams' ? 'aoSeamsAssetPath' : `${mode}AssetPath`]=path;
  }
  return {...identity,...paths};
}

// Reuse delivered files; never trigger rendering or generation for the default card.
export function nativeUVDeliveredPreviews(node) {
  const identity=nativeUVIdentity(node),d=node?.data;
  if(!identity)return null;
  const recorded=d.nativeUVPreviews;
  const current=recorded?.jobId===identity.jobId&&recorded?.modelAssetPath===identity.modelAssetPath?recorded:null;
  const delivered=d.nativeDeliveredJobId===identity.jobId;
  const paths={};
  if(delivered)for(const [name,key] of [['uv-layout.png','layoutAssetPath'],['uv-checker.png','checkerAssetPath']]) {
    const matches=(d.nativeArtifacts||[]).filter(a=>a.name===name&&a.role==='export'&&/^assets\/[a-f0-9]{64}\.png$/i.test(a.assetPath||''));
    if(matches.length===1)paths[key]=matches[0].assetPath;
  }
  const result={...identity,...paths,...current};
  // A persisted successful UV result identifies this immutable job file. No preview endpoint.
  if(delivered&&!result.layoutAssetPath&&d.metadata?.uv)result.layoutJobUrl=`/api/native3d/jobs/${identity.jobId}/files/uv-layout.png`;
  return Object.keys(result).length>2?result:null;
}
export function native3DBusyFeedback(data) {
  if(!['submitting','queued','running','finishing','uploading'].includes(data?.status))return null;
  const verb=({source_lod:'减面',ai_lowpoly:'减面',repair_lod:'修复减面',uv_plan:'生成切缝',uv:'展开UV',bake:'烘焙材质',analyze:'分析模型'})[data.operation]||'处理3D';
  const title=data.status==='submitting'?'待提交确认':data.status==='queued'?`等待${verb}`:data.status==='finishing'?'正在保存结果':data.status==='uploading'?'正在导入模型':`正在${verb}`;
  const progress=data.status==='running'&&Number.isFinite(data.progress)?Math.min(100,Math.max(0,Math.round(data.progress))):null;
  return {title,stage:data.stage||'',progress,historical:Boolean(data.posterAssetPath||data.resultAssetPath||data.nativeUVPlan)};
}
