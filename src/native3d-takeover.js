import { nativeAdapterSchema, nativeParameterValue } from './native3d.js';
import { nativeOutputNode } from './native3d-output.js';
import { nativeInputs } from './native3d-plan.js';

const busy = new Set(['uploading', 'queued', 'running', 'finishing']);
const modelPath = /^assets\/[a-f0-9]{64}\.(glb|obj)$/i;
const jobPattern = /^n3d_[a-f0-9]{32}$/;
const labels = { analyze: '模型分析', source_lod: '减面与 LOD', repair_lod: '修复减面', ai_lowpoly: 'AI 低模',
  uv_plan: 'UV 切缝方案', uv: 'UV 展开', bake: '材质烘焙', material_wear: '曲率磨损' };

export function nativeTakeover(nodeId, nodes, edges, capabilities) {
  const selected = nodes.find(node => node.id === nodeId);
  if (selected?.type !== 'native3d') return null;
  const processor = nodes.find(node => node.id === selected.data.sourceNodeId && node.type === 'native3d') || selected;
  const data = processor.data;
  const sources = nativeInputs(processor, nodes, edges);
  // A chosen output card pins that object. A processor follows its delivered output.
  const output = nativeOutputNode(selected);
  const records = data.nativeOutputRecords || [];
  const delivered = records.find(record => record.jobId === data.nativeDeliveredJobId);
  const result = delivered?.data || (data.nativeDeliveredJobId ? data : null);
  const selectedModel = output.data;
  const candidates = [
    [selectedModel.proxyAssetPath, selectedModel.title, '已保存模型', selectedModel.metadata?.operation],
    [selectedModel.assetPath, selectedModel.title, '已保存模型', selectedModel.metadata?.operation],
    [selectedModel.resultAssetPath, selectedModel.title, '已保存模型', selectedModel.metadata?.operation],
    [sources.model?.data.proxyAssetPath, sources.model?.data.title, '输入低模', sources.model?.data.metadata?.operation],
    [sources.model?.data.assetPath, sources.model?.data.title, '输入低模', sources.model?.data.metadata?.operation],
  ];
  const preview = candidates.find(([path]) => modelPath.test(path || ''));
  const adapter = (capabilities?.adapters || []).find(item => (item.id || item.adapterId) === data.adapterId && data.adapterId)
    || capabilities?.operations?.[data.operation];
  const completed = Boolean(result && jobPattern.test(data.nativeDeliveredJobId || ''));
  const submitted = completed && (delivered?.producerRun?.parameters
    || (data.nativeJobId === data.nativeDeliveredJobId ? data.nativeRun?.parameters : null));
  const names = { padding:'岛间距（像素）', chartMergeCost:'合岛倾向', packingMode:'排布方式',
    alignDirection:'岛方向', aoRaySamples:'AO 采样数', aoRadiusFraction:'AO 半径比例', seamPlanningMode:'切缝顺序',
    partitionCount:'高模分区数', regionMinAreaFraction:'最小分区面积', regionMergeAngleDegrees:'分区合并角（度）' };
  const fields = Object.entries(nativeAdapterSchema(adapter).properties || {}).flatMap(([key, rule]) => {
    if (!['number','integer','boolean'].includes(rule.type) && !rule.enum) return [];
    if (key === 'orientationConfirmed' || key === 'externalGeometryReviewed' || key.startsWith('localRepair')) return [];
    if (data.operation === 'uv' && sources.plan?.data.nativeUVPlan && Object.hasOwn(sources.plan.data.nativeUVPlan.settings || {}, key)) return [];
    const value = nativeParameterValue(adapter, data.nativeParameters || {}, key, rule);
    return value === undefined ? [] : [{ key, rule, label: rule.title || names[key] || key, value, baseline: submitted?.[key] }];
  });
  const changed = fields.filter(field => field.baseline !== undefined && field.value !== field.baseline);
  return {
    nodeId: selected.id, processorId: processor.id, title: selected.data.title || '模型',
    operation: data.operation, step: labels[data.operation] || data.operation, status: data.status,
    preview: preview && { path: preview[0], title: preview[1], sourceLabel: preview[2], materialPreview: preview[3] === 'bake' || preview[3] === 'material_wear' },
    sources: [['低模', sources.model], ['高模', sources.high], ['切缝方案', sources.plan]].flatMap(([label, node]) =>
      node ? [{label, title:node.data.title || node.id}] : []),
    fields, changed, busy: busy.has(data.status), ready: adapter?.ready === true && !data.nativeSubmissionUncertain,
    pending: changed.length > 0 || data.status === 'stale', receipt: {
      jobId: data.nativeJobId || null, stage: data.stage || null, backendStatus: data.nativeBackendStatus || null,
      progress: Number.isFinite(data.progress) ? data.progress : null, error: data.error || null,
    },
    lastSuccess: completed ? {jobId:data.nativeDeliveredJobId, stage:result.stage, triangleCount:result.quality?.triangles ?? result.quality?.faces} : null,
  };
}
