import { nativeAdapterSchema, nativeParameterValue } from './native3d.js';
import { nativeOutputNode } from './native3d-output.js';
import { nativeInputs } from './native3d-plan.js';

const busy = new Set(['uploading', 'submitting', 'queued', 'running', 'finishing']);
const modelPath = /^assets\/[a-f0-9]{64}\.(glb|obj)$/i;
const jobPattern = /^n3d_[a-f0-9]{32}$/;
const labels = { analyze: '模型分析', source_lod: '减面与 LOD', repair_lod: '修复减面', ai_lowpoly: 'AI 低模',
  image_to_3d: '图生模型 · TripoSR', uv_plan: 'UV 切缝方案', uv: 'UV 展开', bake: '材质烘焙', material_wear: '曲率磨损' };

const inputLabels = {model:'模型输入', high:'高模参考', plan:'切缝方案'};
const taskLabels = {uploading:'上传中', submitting:'待提交确认', queued:'排队中', running:'运行中', finishing:'正在交付',
  completed:'结果已保存', succeeded:'任务成功', success:'任务成功', failed:'任务失败', error:'任务失败',
  cancelled:'任务取消', stale:'节点标记为过期', idle:'未运行', interrupted:'任务中断'};
const text = value => typeof value === 'string' ? value.trim() : '';

export function nativeReceiptError(value) {
  if (!value || typeof value === 'string') return text(value) || null;
  if (typeof value !== 'object' || Array.isArray(value)) return '任务返回了无法读取的错误。';
  const code = text(value.code);
  const message = text(value.message) || text(value.details?.message);
  return [code, message].filter(Boolean).join(' · ') || '任务返回了无法读取的错误。';
}

function downstreamSteps(selected, processor, nodes, edges, changed) {
  const byId = new Map(nodes.filter(node => node.type === 'native3d').map(node => [node.id, node]));
  const outgoing = new Map();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target) || edge.data?.nonExecuting || edge.data?.diagnostic) continue;
    const target = byId.get(edge.target);
    const delivery = edge.targetHandle === 'provenance' && target.data.sourceNodeId === edge.source;
    const input = Object.hasOwn(inputLabels, edge.targetHandle) && edge.sourceHandle === (edge.targetHandle === 'plan' ? 'plan' : 'model');
    if (delivery || input) {
      const next = outgoing.get(edge.source) || [];
      next.push({edge, target, delivery});
      outgoing.set(edge.source, next);
    }
  }
  // Output cards still belong to the selected step. Seed those before walking
  // dependency edges, so a shorter route through another step cannot hide a direct input.
  const visited = new Set([processor.id, selected.id]);
  const queue = [...visited].map(id => ({id, depth:0}));
  for (let i = 0; i < queue.length; i++) {
    for (const {target, delivery} of outgoing.get(queue[i].id) || []) {
      if (!delivery || visited.has(target.id)) continue;
      visited.add(target.id);
      queue.push({id:target.id, depth:0});
    }
  }
  const labelFor = status => Object.hasOwn(taskLabels, status) ? taskLabels[status] : null;
  const steps = [];
  for (let i = 0; i < queue.length; i++) {
    const {id, depth} = queue[i];
    for (const {edge, target, delivery} of outgoing.get(id) || []) {
      if (visited.has(target.id)) continue;
      visited.add(target.id);
      queue.push({id:target.id, depth:depth + Number(!delivery)});
      if (delivery) continue;
      const data = target.data;
      const jobId = jobPattern.test(data.nativeJobId || '') ? data.nativeJobId : null;
      const lastSavedJobId = jobPattern.test(data.nativeDeliveredJobId || '') ? data.nativeDeliveredJobId : null;
      const taskStatus = data.status === 'completed' && !lastSavedJobId
        ? '节点标记为完成，缺少交付回执'
        : labelFor(data.status) || labelFor(data.nativeBackendStatus) || '暂无状态记录';
      steps.push({
        nodeId:target.id, title:data.title || labels[data.operation] || target.id,
        input:inputLabels[edge.targetHandle], direct:depth === 0, pinned:Boolean(edge.data?.outputRecordId),
        needsReview: changed || data.status === 'stale',
        taskStatus, jobId, lastSavedJobId,
      });
    }
  }
  return steps;
}

function baselineValue(value, rule) {
  if (rule.enum && !rule.enum.includes(value)) return undefined;
  if (rule.type === 'number' && Number.isFinite(value) || rule.type === 'integer' && Number.isInteger(value)
      || rule.type === 'boolean' && typeof value === 'boolean' || rule.type === 'string' && typeof value === 'string') return value;
  return undefined;
}

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
  const names = { resolution:'贴图分辨率', padding:'岛间距（像素）', chartMergeCost:'合岛倾向', packingMode:'排布方式',
    alignDirection:'岛方向', aoRaySamples:'AO 采样数', aoRadiusFraction:'AO 半径比例', seamPlanningMode:'切缝顺序',
    partitionCount:'高模分区数', regionMinAreaFraction:'最小分区面积', regionMergeAngleDegrees:'分区合并角（度）' };
  const fields = Object.entries(nativeAdapterSchema(adapter).properties || {}).flatMap(([key, rule]) => {
    if (!['number','integer','boolean'].includes(rule.type) && !rule.enum) return [];
    if (key === 'orientationConfirmed' || key === 'externalGeometryReviewed' || key.startsWith('localRepair')) return [];
    if (data.operation === 'uv' && sources.plan?.data.nativeUVPlan && Object.hasOwn(sources.plan.data.nativeUVPlan.settings || {}, key)) return [];
    const value = nativeParameterValue(adapter, data.nativeParameters || {}, key, rule);
    return value === undefined ? [] : [{ key, rule, label: rule.title || names[key] || key, value, baseline: baselineValue(submitted?.[key], rule) }];
  });
  const changed = fields.filter(field => field.baseline !== undefined && field.value !== field.baseline);
  const pending = changed.length > 0 || data.status === 'stale';
  const basis = !completed ? 'none' : !adapter ? 'missing' : !fields.length ? 'no-parameters'
    : fields.every(field => field.baseline !== undefined) ? 'verified' : 'missing';
  return {
    nodeId: selected.id, processorId: processor.id, title: selected.data.title || '模型',
    operation: data.operation, step: labels[data.operation] || data.operation, status: data.status,
    preview: preview && { path: preview[0], title: preview[1], sourceLabel: preview[2], materialPreview: preview[3] === 'bake' || preview[3] === 'material_wear' },
    sources: [['低模', sources.model], ['高模', sources.high], ['切缝方案', sources.plan]].flatMap(([label, node]) =>
      node ? [{label, title:node.data.title || node.id}] : []),
    fields, changed, busy: busy.has(data.status), ready: adapter?.ready === true && !data.nativeSubmissionUncertain,
    runBlock: data.nativeSubmissionUncertain ? '上次提交状态待确认，请先同步任务。'
      : adapter?.ready !== true ? adapter?.reason || '当前步骤的原生执行器未就绪。' : null,
    pending, basis, downstream: downstreamSteps(selected, processor, nodes, edges, pending), receipt: {
      jobId: text(data.nativeJobId) || null, stage: text(data.stage) || null, backendStatus: text(data.nativeBackendStatus) || null,
      progress: Number.isFinite(data.progress) ? data.progress : null, error: nativeReceiptError(data.error),
    },
    lastSuccess: completed ? {jobId:data.nativeDeliveredJobId, stage:text(result.stage), triangleCount:result.quality?.triangles ?? result.quality?.faces} : null,
  };
}
