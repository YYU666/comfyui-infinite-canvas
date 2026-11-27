// Artifact bodies are transient: upload each file before fetching the next one.
const artifactExtensions = {
  model: ['glb', 'obj'], proxy: ['glb', 'obj'], poster: ['png', 'jpg', 'jpeg', 'webp'],
  report: ['json'], texture: ['png', 'jpg', 'jpeg', 'webp'], export: ['glb', 'obj', 'fbx', 'png'], plan:['json','bin'],evidence:['npz'],
};
const deliveryPhaseLabels = { download: '下载文件', read: '读取下载内容', wait_save: '等待已有保存或上传', upload: '上传素材', final_save: '最终保存画布' };
export function nativeDeliveryError(error, phase, { name, jobId } = {}) {
  const deliveryPhase = error?.deliveryPhase || phase;
  const artifactName = error?.artifactName || name;
  const originalMessage = error?.deliveryOriginalMessage || error?.message || String(error);
  const wrapped = new Error(`${deliveryPhaseLabels[deliveryPhase] || deliveryPhase}${artifactName ? ` [${artifactName}]` : ''}失败：${originalMessage}`, { cause: error });
  for (const key of ['code', 'status', 'details']) if (error?.[key] !== undefined) wrapped[key] = error[key];
  return Object.assign(wrapped, { deliveryPhase, artifactName, jobId: error?.jobId || jobId, deliveryOriginalMessage: originalMessage });
}
export async function transferNativeArtifacts(files, jobId, { fetchFile = fetch, saveFile, assertCurrent, makeFile = (blob, artifact) => new File([blob], artifact.name, { type: ['report', 'plan', 'evidence'].includes(artifact.role) || /\.fbx$/i.test(artifact.name) ? 'application/octet-stream' : artifact.mime || 'application/octet-stream' }) }) {
  const saved = {};
  for (const artifact of files) {
    if (!artifactExtensions[artifact.role]) continue;
    assertCurrent();
    const extension = artifact.name?.split('.').at(-1)?.toLowerCase();
    if (artifact.role==='plan' && !['uv-plan.json','uv-plan-overlay.bin'].includes(artifact.name) || artifact.role==='evidence' && artifact.name!=='uv-plan-evidence.npz') throw new Error('方案附件名称无效。');
    if ((artifact.role === 'report' && artifact.name !== 'report.json') || !/^[a-zA-Z0-9_.-]+$/.test(artifact.name || '') || !artifactExtensions[artifact.role].includes(extension)) throw new Error('3D输出格式不受支持。');
    const expected = `/api/native3d/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(artifact.name)}`;
    if (artifact.url !== expected) throw new Error('3D输出地址不属于当前任务。');
    let response;
    try {
      response = await fetchFile(artifact.url);
      if (!response.ok) throw Object.assign(new Error(`3D结果下载失败（${response.status}）`), { status: response.status });
    } catch (error) { throw nativeDeliveryError(error, 'download', { name: artifact.name, jobId }); }
    assertCurrent();
    let blob;
    try { blob = await response.blob(); }
    catch (error) { throw nativeDeliveryError(error, 'read', { name: artifact.name, jobId }); }
    if (['plan','evidence'].includes(artifact.role) && (!blob.size || blob.size>64*1024*1024)) throw Error('方案附件超出64 MiB限制。');
    assertCurrent();
    let path;
    try { path = await saveFile(makeFile(blob, artifact)); }
    catch (error) { throw nativeDeliveryError(error, 'upload', { name: artifact.name, jobId }); }
    assertCurrent();
    const key = ['texture', 'export','plan','evidence'].includes(artifact.role) ? `${artifact.role}:${artifact.name}` : artifact.role;
    saved[key] = { role: artifact.role, name: artifact.name, path };
  }
  return saved;
}

export function nativeRunIsCurrent(node, source, { opId, identity, jobId }, identityOf) {
  return Boolean(node && node.data.nativeRun?.opId === opId
    && node.data.nativeRun?.identity === identity
    && (!jobId || node.data.nativeJobId === jobId)
    && identityOf(node, source) === identity);
}

export async function commitNativeDelivery({ apply, persist, rollback, assertCurrent }) {
  assertCurrent();
  apply();
  try {
    try { await persist(); }
    catch (error) { throw nativeDeliveryError(error, 'final_save'); }
    assertCurrent();
  } catch (error) {
    // Rollback only the same frozen run. A replaced run owns its own state.
    try { assertCurrent(); rollback(error); } catch { /* superseded run */ }
    throw error;
  }
}
