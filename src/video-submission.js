const recovering = new Set(['prepared', 'unconfirmed']);

export function hasUnconfirmedVideoSubmission(node) {
  const record = node?.data.videoSubmission;
  return record?.intent?.nodeId === node?.id && recovering.has(record?.phase);
}

export function videoSubmissionPhase(node, jobId, phase) {
  const record = node?.data.videoSubmission;
  return record && record.id === jobId && record.phase !== phase ? { videoSubmission: { ...record, phase } } : {};
}

export function videoSubmissionError(node, jobId, error) {
  return node?.data.videoSubmission?.id === jobId && (error.status === 404 || !error.status || error.status >= 500)
    ? { ...videoSubmissionPhase(node, jobId, 'unconfirmed'), stage: '原作业未确认', error: '未能核对原视频作业。可重新打开项目或再次点导出核对同一作业。' } : {};
}

const cancelRequests = new WeakMap();

export function observeVideoCancellation(controller, { cancel, isCurrent, update }) {
  let pending;
  const request = () => {
    if (pending) return pending;
    if (isCurrent()) update({ stage: '正在请求取消', error: null });
    pending = cancel().catch(() => {
      if (isCurrent()) update({ stage: '取消未确认 · 正在查询原作业' });
    }).finally(() => { pending = null; });
    return pending;
  };
  cancelRequests.set(controller, request);
}

export function cancelVideoRun(controller) {
  if (!controller) return;
  const request = cancelRequests.get(controller);
  if (request) return request();
  controller.abort();
}

export async function readVideoJob(lookup, identity, signal, onReconnect) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return verifyVideoReceipt(await lookup(identity.id, { signal }), identity);
    } catch (error) {
      if (signal.aborted || (error.status >= 400 && error.status < 500) || attempt >= 2) throw error;
      onReconnect();
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 350));
      signal.throwIfAborted();
    }
  }
}

export function makeVideoSubmission(prefix, intent, page) {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const requestId = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const proof = page && { epoch: page.epoch, sessionId: page.sessionId, ...(page.opId && { opId: page.opId }) };
  return { id: `${prefix}_${requestId}`, phase: 'prepared', intent, requestId, ...(proof && { page: proof }) };
}

export function verifyVideoReceipt(job, record) {
  if (job?.id !== record.id || job.projectId !== record.intent.projectId || job.nodeId !== record.intent.nodeId) {
    throw new Error('视频作业回执与已保存的提交记录不符。');
  }
  return job;
}

// A transport error may have happened after admission. Query the saved ID only.
export async function postVideoSubmission(record, { persistProject, current, signal, submit, lookup }) {
  if (!persistProject) throw new Error('项目保存通道不可用。');
  await persistProject();
  signal.throwIfAborted();
  if (!current()) throw new Error('当前画布已改变。');
  try {
    return verifyVideoReceipt(await submit({ ...record.intent, requestId: record.requestId, ...(record.page && { page: record.page }) }), record);
  } catch (error) {
    if (error.status >= 400 && error.status < 500) throw error;
    for (const delay of [0, 150, 450]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try { return verifyVideoReceipt(await lookup(record.id), record); }
      catch { /* The request may still be arriving. Never POST a second time. */ }
    }
    throw Object.assign(new Error('提交结果未确认。再次点导出只会核对原作业。'), { code: 'VIDEO_SUBMISSION_UNKNOWN' });
  }
}
