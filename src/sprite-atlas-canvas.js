import { useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { SPRITE_ACTIVE, spriteSnapshot, spriteFiles, spriteRequest, spritePost, waitForSpriteJob } from './sprite-atlas.js';

export function useSpriteAtlas({ project, projectRef, revisionRef, switchingRef, nodes, nodesRef, updateNode, persistProject, localImageJobsRef, setLocalImageJobsVersion }) {
  const current = useCallback(id => {
    if (projectRef.current.readOnly || switchingRef.current || projectRef.current.id !== project.id) throw new Error('当前项目不可编辑。');
    const node = nodesRef.current.find(node => node.id === id && node.type === 'spriteAtlas');
    if (!node) throw new Error('精灵图节点已不存在。');
    return node;
  }, [project.id]);

  const track = useCallback((id, jobId, signature, controller) => {
    let cancelPromise;
    const cancel = () => {
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
        if (node.data.spriteJobId !== jobId || spriteSnapshot(node.data).signature !== signature) throw new Error('角色或参数已改变，未覆盖上次结果，请重新渲染。');
        flushSync(() => updateNode(id, { status: 'done', stage: '2 张图集与 JSON 已导出', spriteFiles: spriteFiles(result), spriteResultSignature: signature, error: null }));
        await persistProject();
      } catch (error) {
        let message = error.message;
        if (controller.signal.aborted) {
          try { await cancelPromise; message = '精灵图渲染已取消。'; }
          catch (cancelError) { message = `停止等待；后台取消失败：${cancelError.message}。任务 ID：${jobId}`; }
        }
        try {
          const node = current(id);
          if (node.data.spriteJobId === jobId) updateNode(id, { status: controller.signal.aborted || error.code === 'SPRITE_CANCELLED' ? 'cancelled' : 'error', stage: '精灵图未交付', error: message });
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

  const runSpriteAtlas = useCallback(async id => {
    if (localImageJobsRef.current.has(id)) return { ok: false, error: '此节点正在渲染。' };
    let controller;
    try {
      const node = current(id), snapshot = spriteSnapshot(node.data);
      if (SPRITE_ACTIVE.includes(node.data.status)) throw new Error('请先等待或取消当前任务。');
      controller = new AbortController();
      localImageJobsRef.current.set(id, controller);
      setLocalImageJobsVersion(value => value + 1);
      flushSync(() => updateNode(id, { status: 'uploading', stage: '保存节点并提交 Blender', error: null }));
      await persistProject();
      controller.signal.throwIfAborted();
      current(id);
      // Do not abort the create request mid-flight: receive its ID first so a
      // delete/unmount during submission can cancel the actual backend job.
      const job = await spriteRequest('/jobs', spritePost({ projectId: project.id, revision: revisionRef.current, nodeId: id, inputPath: snapshot.inputPath, options: snapshot.options }));
      if (!/^spa_[a-f0-9]{32}$/.test(job.id || '')) throw new Error('服务返回了无效的精灵图任务 ID。');
      if (controller.signal.aborted) {
        await spriteRequest(`/jobs/${job.id}/cancel`, spritePost({}));
        controller.signal.throwIfAborted();
      }
      try { current(id); } catch (error) { await spriteRequest(`/jobs/${job.id}/cancel`, spritePost({})); throw error; }
      flushSync(() => updateNode(id, { spriteJobId: job.id, spriteJobSignature: snapshot.signature, status: 'queued', stage: '等待 Blender CPU 渲染' }));
      track(id, job.id, snapshot.signature, controller);
      return { ok: true, jobId: job.id };
    } catch (error) {
      if (controller && localImageJobsRef.current.get(id) === controller) { localImageJobsRef.current.delete(id); setLocalImageJobsVersion(value => value + 1); }
      try { current(id); updateNode(id, { status: 'error', stage: '精灵图提交失败', error: error.message }); } catch { /* Project departed. */ }
      return { ok: false, error: error.message };
    }
  }, [current, project.id, updateNode, persistProject, track]);

  const cancelSpriteAtlas = useCallback(id => {
    current(id);
    const controller = localImageJobsRef.current.get(id);
    if (!controller) throw new Error('任务状态正在恢复，请稍后取消。');
    controller.abort();
  }, [current]);

  // Reopening the same project reconnects to its existing job, never resubmits.
  useEffect(() => {
    if (project.readOnly || switchingRef.current) return;
    for (const node of nodes) {
      if (node.type !== 'spriteAtlas' || !SPRITE_ACTIVE.includes(node.data.status) || !/^spa_[a-f0-9]{32}$/.test(node.data.spriteJobId || '') || localImageJobsRef.current.has(node.id)) continue;
      const controller = new AbortController();
      localImageJobsRef.current.set(node.id, controller);
      setLocalImageJobsVersion(value => value + 1);
      track(node.id, node.data.spriteJobId, node.data.spriteJobSignature, controller);
    }
  }, [nodes, project.id, project.readOnly, track]);

  return { runSpriteAtlas, cancelSpriteAtlas };
}
