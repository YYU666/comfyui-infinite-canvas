export const UV_ORIENTATION_MESSAGE='当前低模为开放网格。请先检查模型表面朝向 / 法线是否朝外、与高模一致，再勾选“已核对表面朝向 / 法线”，避免凹凸识别反转。';
export function nativeUVOrientationError(node,inputs,parameters=node?.data?.nativeParameters || {}) {
  const data=node?.data;
  if(data?.operation!=='uv_plan' || parameters.orientationConfirmed===true)return null;
  const model=inputs?.model?.data;
  if(!model?.assetPath)return null;
  // metadata.source describes the parent mesh, never the current output.
  const geometry=model.metadata?.geometry;
  const stage=geometry?.stages?.find(s=>s.stage===(model.nativeStage || geometry.selectedStage));
  const stageMatches=stage && (model.nativeArtifacts || []).some(a=>a.assetPath===model.assetPath && a.name===(stage.diagnosticFilename || stage.filename)) && (!geometry.selectedMeshHash || geometry.selectedMeshHash===stage.mesh_hash);
  const metrics=model.quality || geometry?.quality || (stageMatches ? stage.receipt?.geometry : null);
  const boundary=metrics?.boundaryEdges ?? metrics?.boundary_edges;
  const open=Number.isInteger(boundary)&&boundary>0 || metrics?.watertight===false;
  const run=data.nativeRun;
  const knownFailure=['error','failed'].includes(data.status) &&
    /Open structural UV requires reference orientationConfirmed/i.test(typeof data.error==='string'?data.error:data.error?.message || '') &&
    run?.sourceId===inputs.model.id && run?.sourceAssetPath===model.assetPath &&
    run?.highAssetPath===inputs.high?.data?.assetPath;
  return open || knownFailure ? UV_ORIENTATION_MESSAGE : null;
}
export function nativeEmptyPoster(data,inputs={}) {
  if(data.nativeUVPlan)return '真实3D切缝方案 · 双击审阅并保存卡片预览';
  if(data.assetPath)return '模型已保存 · 预览待分析';
  if(inputs.model)return data.operation==='uv_plan' ? '低模已连接 · 等待生成切缝方案（未展开UV）' : '模型已连接 · 等待处理结果';
  return '连接或导入3D模型';
}
