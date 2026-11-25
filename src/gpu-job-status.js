export function gpuJobText(gpu) {
  if (!gpu?.owner || !['waiting', 'held', 'reconciling'].includes(gpu.state)) return '';
  const { kind, jobId, attempt } = gpu.owner;
  const owner = (kind === 'native3d' ? '图生 3D' : 'Comfy') + ' · ' + jobId + (attempt ? ' · 第 ' + attempt + ' 次' : '');
  if (gpu.state === 'waiting') return '等待 GPU，当前占用 ' + owner;
  if (gpu.state === 'reconciling') return '核对 GPU 释放 · ' + owner;
  return '占用 GPU · ' + owner;
}
