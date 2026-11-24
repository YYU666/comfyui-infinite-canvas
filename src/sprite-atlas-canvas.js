import { useCallback, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { SPRITE_ACTIVE, spriteSnapshot, spriteFiles, spriteRequest, spritePost, recoverSpriteRequest, waitForSpriteJob } from './sprite-atlas.js';

const CANCEL_EXPLICIT = 'SPRITE_EXPLICIT_CANCEL';
const stopped = (controller) => controller.signal.aborted && controller.signal.reason?.code !== CANCEL_EXPLICIT;

export function useSpriteAtlas({ project, projectRef, revisionRef, switchingRef, nodes, nodesRef, updateNode, persistProject, localImageJobsRef, setLocalImageJobsVersion }) {
  const reconnected = useRef(new Set());
  const current = useCallback(id => {
    if (projectRef.current.readOnly || switchingRef.current || projectRef.current.id !== project.id) throw new Error('当前项目不可编辑。');
    const node = nodesRef.current.find(node => node.id === id && node.type === 'spriteAtlas');
    if (!node) throw new Error('精灵图节点已不存在。');
    return node;
  }, [project.id]);

  const track = useCallback((id, jobId, signature, controller) => {
    let cancelPromise;
    const cancel = () => {
      if (stopped(controller)) return;
      cancelPromise = spriteRequest(`/jobs/${jobId}/cancel`, spritePost({}));
      // Preserve a rejected cancellation for the terminal error instead of
      // allowing an unhandled rejection on delete/unmount.
      cancelPromise.catch(() => {});
    };
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) cancel();
    const monitor = async () => {
      try {
        const result = await waitForSpriteJob(jobId, {
          signal: controller.signal,
          onProgress: job => {
            const node = current(id);
            if (node.data.spriteJobId !== jobId) throw new Error('精灵图任务已更换。');
            if (['running', 'queued'].includes(job.status)) updateNode(id, { status: job.status, stage: job.status === 'queued' ? '等待 Blender CPU 渲染' : 'Blender CPU 正在渲染颜色与法线' });
          },
        });
        const node = current(id);
        if (node.data.spriteJobId !== jobId || spriteSnapshot(node.data).signature !== signature) throw Object.assign(new Error('角色或参数已改变，未覆盖上次结果，请重新渲染。'), { code: 'SPRITE_INPUT_CHANGED' });
        flushSync(() => updateNode(id, { status: 'done', stage: '2 张图集与 JSON 已导出', spriteFiles: spriteFiles(result),
          spriteResultSignature: signature, ...(node.data.spriteRun ? { spriteRun: { ...node.data.spriteRun, phase: 'done', jobId } } : {}), error: null }));
        await persistProject();
      } catch (error) {
        if (stopped(controller)) return;
        let message = error.message;
        if (controller.signal.aborted) {
          try { await cancelPromise; message = '精灵图渲染已取消。'; }
          catch (cancelError) { message = `停止等待；后台取消失败：${cancelError.message}。任务 ID：${jobId}`; }
        }
        try {
          const node = current(id);
          if (node.data.spriteJobId === jobId) {
            const cancelled = controller.signal.aborted || error.code === 'SPRITE_CANCELLED';
            const phase = cancelled ? (cancelPromise && message.startsWith('停止等待') ? 'unconfirmed' : 'cancelled')
              : ['SPRITE_FAILED', 'SPRITE_INPUT_CHANGED'].includes(error.code) ? 'error' : 'unconfirmed';
            flushSync(() => updateNode(id, { status: cancelled ? 'cancelled' : 'error', stage: '精灵图未交付', error: message,
              ...(node.data.spriteRun ? { spriteRun: { ...node.data.spriteRun, phase } } : {}) }));
            await persistProject().catch(() => {});
          }
        } catch { /* A removed node or a departed project cannot receive updates. */ }
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        if (localImageJobsRef.current.get(id) === controller) {
          localImageJobsRef.current.delete(id);
          setLocalImageJobsVersion(value => value + 1);
        }
      }
    };
    void monitor();
  }, [current, updateNode, persistProject]);

  const accept = useCallback(async (id, run, job, controller) => {
    if (job.projectId !== project.id || job.nodeId !== id || job.requestId !== run.requestId || !/^spa_[a-f0-9]{32}$/.test(job.id || '')) {
      throw new Error('精灵图任务回执不匹配。');
    }
    if (controller.signal.aborted) {
      if (!stopped(controller)) await spriteRequest('/jobs/' + job.id + '/cancel', spritePost({}));
      controller.signal.throwIfAborted();
    }
    const node = current(id);
    if (node.data.spriteRun?.requestId !== run.requestId) throw new Error('精灵图请求已经替换。');
    flushSync(() => updateNode(id, { spriteJobId: job.id, spriteJobSignature: run.signature,
      spriteRun: { ...run, phase: 'accepted', jobId: job.id }, status: 'queued', stage: '等待 Blender CPU 渲染' }));
    // Preserve the backend identity even if the project save conflicts.
    try { await persistProject(); } catch { /* Reopen can query the prepared request. */ }
    track(id, job.id, run.signature, controller);
    return { ok: true, jobId: job.id, requestId: run.requestId, execution: 'accepted', status: job.status };
  }, [project.id, current, updateNode, persistProject, track]);

  const runSpriteAtlas = useCallback(async (id, generation = {}) => {
    if (localImageJobsRef.current.has(id)) return { ok: false, error: '此节点正在渲染或查收。' };
    const controller = new AbortController();
    let run;
    let sent = false;
    let query = false;
    try {
      const node = current(id);
      const previous = node.data.spriteRun;
      query = generation.recover === true || ['unconfirmed', 'prepared'].includes(previous?.phase);
      if (!query && SPRITE_ACTIVE.includes(node.data.status)) throw new Error('请先等待或取消当前任务。');
      if (query && !previous?.requestId) throw new Error('没有可对账的精灵图请求。');
      localImageJobsRef.current.set(id, controller);
      setLocalImageJobsVersion(value => value + 1);
      if (query) {
        run = previous;
        const recovered = await recoverSpriteRequest({ projectId: project.id, nodeId: id, requestId: run.requestId }, { signal: controller.signal });
        return await accept(id, run, recovered, controller);
      }
      const snapshot = spriteSnapshot(node.data);
      const restart = previous?.phase === 'lookup-missing';
      if (restart && previous.signature !== snapshot.signature) {
        throw new Error('原精灵图请求尚无回执，请先按该请求保存的参数核对。');
      }
      run = { requestId: restart ? previous.requestId : generation.requestId || globalThis.crypto.randomUUID(), phase: 'prepared',
        recovery: 'backend-job', inputPath: snapshot.inputPath, options: snapshot.options, signature: snapshot.signature };
      flushSync(() => updateNode(id, { spriteRun: run, status: 'uploading', stage: '保存节点并提交 Blender', error: null }));
      await persistProject();
      generation.assertActive?.();
      controller.signal.throwIfAborted();
      const saved = current(id);
      if (saved.data.spriteRun?.requestId !== run.requestId || spriteSnapshot(saved.data).signature !== run.signature) {
        throw new Error('精灵图输入或参数已改变。');
      }
      sent = true;
      const job = await spriteRequest('/jobs', spritePost({ projectId: project.id, revision: revisionRef.current, nodeId: id,
        requestId: run.requestId, inputPath: run.inputPath, options: run.options }));
      return await accept(id, run, job, controller);
    } catch (error) {
      if (localImageJobsRef.current.get(id) === controller) {
        localImageJobsRef.current.delete(id);
        setLocalImageJobsVersion(value => value + 1);
      }
      if (stopped(controller)) return { ok: false, error: error.message };
      try {
        if (run && current(id).data.spriteRun?.requestId === run.requestId) {
          const missing = query && error.status === 404;
          const ambiguous = query || (sent && (!error.status || error.status >= 500));
          const phase = missing ? 'lookup-missing' : ambiguous ? 'unconfirmed' : 'rejected';
          flushSync(() => updateNode(id, { spriteRun: { ...run, phase }, status: 'error',
            stage: missing ? '未找到任务 · 可显式提交同一请求' : ambiguous ? '精灵图接收未确认 · 可核对原请求' : '精灵图未交付',
            error: error.message }));
          await persistProject().catch(() => {});
        }
      } catch { /* Project departed. */ }
      return { ok: false, error: error.message };
    }
  }, [current, project.id, updateNode, persistProject, accept]);

  const cancelSpriteAtlas = useCallback(id => {
    current(id);
    const controller = localImageJobsRef.current.get(id);
    if (!controller) throw new Error('任务状态正在恢复，请稍后取消。');
    controller.abort(Object.assign(new Error('已请求取消精灵图。'), { code: CANCEL_EXPLICIT }));
  }, [current]);

  // Reopening the same project reconnects to its existing job, never resubmits.
  useEffect(() => {
    if (project.readOnly || switchingRef.current) return;
    for (const node of nodes) {
      if (node.type !== 'spriteAtlas' || localImageJobsRef.current.has(node.id)) continue;
      const run = node.data.spriteRun;
      if (['prepared', 'unconfirmed'].includes(run?.phase) && run.requestId) {
        const key = JSON.stringify([project.id, node.id, run.requestId]);
        if (!reconnected.current.has(key)) {
          reconnected.current.add(key);
          void runSpriteAtlas(node.id, { recover: true });
        }
        continue;
      }
      if (!SPRITE_ACTIVE.includes(node.data.status) || !/^spa_[a-f0-9]{32}$/.test(node.data.spriteJobId || '')) continue;
      const controller = new AbortController();
      localImageJobsRef.current.set(node.id, controller);
      setLocalImageJobsVersion(value => value + 1);
      track(node.id, node.data.spriteJobId, node.data.spriteJobSignature, controller);
    }
  }, [nodes, project.id, project.readOnly, track, runSpriteAtlas]);

  return { runSpriteAtlas, cancelSpriteAtlas };
}
