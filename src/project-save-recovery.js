// Recovery never adopts a server revision or replaces the mounted canvas.
export function createProjectAccessRecovery({ restore, getCurrent, onError }) {
  let sequence = 0;
  return async ({ signal } = {}) => {
    const token = ++sequence;
    const project = getCurrent();
    const ownsAttempt = () => token === sequence && getCurrent() === project;
    const isCurrent = () => ownsAttempt() && !signal?.aborted;
    try {
      await restore(project, { signal, isCurrent });
      if (!isCurrent()) throw new DOMException('Project recovery superseded', 'AbortError');
      onError('');
    } catch (error) {
      const timedOut = signal?.aborted && signal.reason?.name === 'TimeoutError';
      if (ownsAttempt() && (timedOut || (!signal?.aborted && error.name !== 'AbortError'))) onError(`项目连接尚未恢复：${timedOut ? '连接检查超时，请重试。' : error.message} 本页修改已保留，请检查项目文件夹或锁定状态后重试保存。`);
      throw error;
    }
  };
}

export async function retryCurrentProjectSave({ getContext, restore, persist }) {
  const initial = getContext();
  const assertCurrent = () => {
    const live = getContext();
    if (live.projectId !== initial.projectId || live.controller !== initial.controller || live.readOnly || live.switching || !live.controller || live.controller.disposed) throw new Error('当前项目不可重试保存；本页修改已保留。');
    if (live.controller.conflict) throw live.controller.conflict;
  };
  assertCurrent();
  await restore();
  assertCurrent();
  await persist(true);
  assertCurrent();
  return { saved: true, projectId: initial.projectId, revision: getContext().revision };
}
