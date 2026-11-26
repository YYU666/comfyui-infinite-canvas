export function gpuJobText(gpu) {
  if (!gpu?.owner || !['waiting', 'held', 'reconciling'].includes(gpu.state)) return '';
  const { kind, jobId, attempt } = gpu.owner;
  const label = kind === 'native3d' ? '原生 3D' : gpu.owner.origin === 'legacy-manual' ? '简易模式' : 'Comfy';
  const owner = label + ' · ' + jobId + (attempt ? ' · 第 ' + attempt + ' 次' : '');
  if (gpu.state === 'waiting') return '等待 GPU，当前占用 ' + owner;
  if (gpu.state === 'reconciling') return '核对 GPU 释放 · ' + owner;
  return '占用 GPU · ' + owner;
}
