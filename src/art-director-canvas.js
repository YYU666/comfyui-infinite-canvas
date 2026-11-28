import { useCallback, useEffect, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { artDirectorSnapshot, assertArtWritable, validateAnalysis, invalidateArtOutputs, guideGeometry } from './art-director.js';
import { renderArtBoard, requestArtAnalysis } from './art-director-runtime.js';
import { imageInput, imageRunError, pageImageRun, preparePageImageRun } from './image-visible-run.js';

export function useArtDirector({ project, projectRef, switchingRef, nodes, edges, nodesRef, edgesRef, setNodes, setEdges, updateNode, addNode, chooseMedia, saveCanvasAsset, persistProject, localImageJobsRef, setLocalImageJobsVersion, mediaWritesRef, assetUrl, findFreePosition, uid, onConnect }) {
  const getArtDirectorState=useCallback(id=>{try{const snap=artDirectorSnapshot(id,nodesRef.current,edgesRef.current);snap.projectId=project.id;snap.refs=snap.refs.map(r=>({...r,data:{...r.data,url:r.data.assetPath?assetUrl(project.id,r.data.assetPath):r.data.url}}));snap.artwork=snap.refs.find(r=>r.data.slot==='artwork');snap.boardUrl=snap.node.data.boardAssetPath?assetUrl(project.id,snap.node.data.boardAssetPath):null;return snap;}catch(e){return {error:e.message};}},[project.id]);
  // Source/version changes invalidate both editable geometry and the derived media.
  useEffect(()=>{
    if(project.readOnly)return;
    const next=invalidateArtOutputs(nodes,edges);
    if(next!==nodes)setNodes(next);
  },[nodes,edges,project.readOnly,setNodes]);
  const assertCurrent=useCallback((id,version,signal)=>{let current;try{current=artDirectorSnapshot(id,nodesRef.current,edgesRef.current).signature;}catch{current=null;}assertArtWritable({readOnly:project.readOnly||projectRef.current.readOnly,switching:switchingRef.current||projectRef.current.id!==project.id,signal,currentVersion:current,sourceVersion:version});},[project.id,project.readOnly]);
  const cancelArtDirector=useCallback(id=>{localImageJobsRef.current.get(id)?.abort();},[]);
  const applyArtAnalysis=useCallback(async(id,value,provenance='import',model='',run=null)=>{const snap=getArtDirectorState(id);if(snap.error)throw new Error(snap.error);assertCurrent(id,snap.signature);const analysis=validateAnalysis(guideGeometry(validateAnalysis(value,snap.signature)),snap.signature);flushSync(()=>updateNode(id,{analysis,analysisGeneration:uid('review'),analysisProvenance:provenance,analysisModel:model,analysisRun: run, ...(run ? { imageRun: run } : {}),stale:false,error:null,boardSignature:null,status:'idle'}));await persistProject();return {ok:true};},[getArtDirectorState,assertCurrent,updateNode,persistProject]);
  const canReport = (id, run) => !switchingRef.current && projectRef.current.id === project.id && !projectRef.current.readOnly
    && (!run || nodesRef.current.find(item => item.id === id)?.data.imageRun?.requestId === run.requestId);
  const exportArtBoard=useCallback(async (id, generation = {})=>{
    if(project.readOnly||switchingRef.current||localImageJobsRef.current.has(id))return;
    const controller=new AbortController();localImageJobsRef.current.set(id,controller);setLocalImageJobsVersion(v=>v+1);const timer=setTimeout(()=>controller.abort(new DOMException('图板输出超时。','TimeoutError')),90000);
    let run;
    let dispatched = false;
    try{
      await Promise.all([...mediaWritesRef.current.values()]);const snap=getArtDirectorState(id);if(snap.error)throw new Error(snap.error);assertCurrent(id,snap.signature,controller.signal);const analysis=validateAnalysis(snap.node.data.analysis,snap.signature),boardSignature=JSON.stringify([snap.signature,analysis]);
      const check=()=>{generation.assertActive?.();assertCurrent(id,snap.signature,controller.signal);const n=nodesRef.current.find(n=>n.id===id);if(JSON.stringify([snap.signature,n?.data.analysis])!==boardSignature)throw new Error('辅助线已改变，请重新输出。');};
      run = pageImageRun('art-board', snap.refs.map(imageInput), { analysisProvenance: snap.node.data.analysisProvenance || null,
        parentRequestId: snap.node.data.analysisRun?.requestId || null, analysisGeneration: snap.node.data.analysisGeneration || null }, generation.requestId);
      await preparePageImageRun({
        stage: () => flushSync(() => updateNode(id, { imageRun: run, status: 'uploading', stage: '保存解析板输入', error: null })),
        persist: persistProject, assertCurrent: check,
      });
      dispatched = true;
      updateNode(id,{imageRun:{...run,phase:'running'},status:'running',stage:'本机生成图解分析板',error:null});const result=await renderArtBoard(snap.artwork.data.url,analysis,{signal:controller.signal,provenance:snap.node.data.analysisProvenance,brief:snap.node.data.brief,preserve:snap.node.data.preserve,references:snap.refs.filter(r=>r.data.slot!=='artwork'),model:snap.node.data.analysisModel || ''});check();
      updateNode(id,{imageRun:{...run,phase:'saving'},status:'finishing',stage:'保存解析 PNG'});const uploaded=await saveCanvasAsset(new File([result.blob],'电子主美-图解分析板.png',{type:'image/png'}),(saved,mediaStorageId)=>{check();return {ok:true,assetPath:saved.asset.path,mediaStorageId};});if(!uploaded?.ok)throw new Error(uploaded?.error?.message||'解析图保存失败。');check();
      let outputId=snap.node.data.boardResultId;const old=nodesRef.current.find(n=>n.id===outputId&&n.type==='media'&&n.data.sourceArtDirectorId===id);if(!old)outputId=uid('art-board');
      const output={id:outputId,type:'media',position:old?.position||findFreePosition(nodesRef.current,{x:snap.node.position.x+650,y:snap.node.position.y},'media'),data:{...old?.data,kind:'image',title:'电子主美 · 图解分析板',name:'电子主美-图解分析板.png',sourceArtDirectorId:id,sourceImageRequestId:run.requestId,output:true,assetPath:uploaded.assetPath,mediaStorageId:uploaded.mediaStorageId,url:assetUrl(project.id,uploaded.assetPath),metadata:{width:result.width,height:result.height},stale:false,artDirectorStale:false,artDirectorStaleReason:null,sourceArtVersion:snap.signature,analysisProvenance:snap.node.data.analysisProvenance}};
      flushSync(()=>{const next=old?nodesRef.current.map(n=>n.id===outputId?output:n):[...nodesRef.current,output];nodesRef.current=next;setNodes(next);if(!edgesRef.current.some(e=>e.source===id&&e.target===outputId)){const e=[...edgesRef.current,{id:`edge-${id}-${outputId}`,source:id,target:outputId,sourceHandle:'ref',targetHandle:'preview'}];edgesRef.current=e;setEdges(e);}updateNode(id,{imageRun:{...run,phase:'done',resultNodeId:outputId,resultAssetPath:uploaded.assetPath},boardResultId:outputId,boardAssetPath:uploaded.assetPath,boardSignature,status:'done',stage:'解析板已输出',error:null});});await persistProject();return {ok:true,resultId:outputId};
    } catch (error) {
      if (canReport(id, run)) {
        flushSync(() => updateNode(id, { ...(run ? { imageRun: imageRunError(run, error, dispatched) } : {}),
          status: error.name === 'AbortError' ? 'cancelled' : 'error', stage: '图板未交付', error: error.message }));
        await persistProject().catch(() => {});
      }
      return { ok: false, error: error.message };
    }
    finally{clearTimeout(timer);if(localImageJobsRef.current.get(id)===controller){localImageJobsRef.current.delete(id);setLocalImageJobsVersion(v=>v+1);}}
  },[project.id,project.readOnly,getArtDirectorState,assertCurrent,updateNode,saveCanvasAsset,setNodes,setEdges,persistProject]);
  const runArtAnalysis = useCallback(async (id, generation = {}) => {
    if (project.readOnly || switchingRef.current || localImageJobsRef.current.has(id)) return;
    const controller = new AbortController();
    localImageJobsRef.current.set(id, controller);
    setLocalImageJobsVersion(value => value + 1);
    const timer = setTimeout(() => controller.abort(new DOMException('视觉分析超时。', 'TimeoutError')), 65000);
    let run;
    let dispatched = false;
    try {
      await Promise.all([...mediaWritesRef.current.values()]);
      const snapshot = getArtDirectorState(id);
      if (snapshot.error) throw new Error(snapshot.error);
      const option = node => [node?.data.artProvider || 'qwen', node?.data.artModel || ''];
      const [provider, model] = option(snapshot.node);
      const check = () => {
        generation.assertActive?.();
        assertCurrent(id, snapshot.signature, controller.signal);
        const current = nodesRef.current.find(item => item.id === id);
        if (JSON.stringify(option(current)) !== JSON.stringify([provider, model])) throw new Error('视觉提供商或模型已改变。');
      };
      run = pageImageRun('art-analysis', snapshot.refs.map(ref => ({ ...imageInput(ref), purpose: ref.data.purpose || '' })),
        { provider, model: model || null, brief: snapshot.node.data.brief || '', preserve: snapshot.node.data.preserve || '' }, generation.requestId);
      await preparePageImageRun({
        stage: () => flushSync(() => updateNode(id, { imageRun: run, status: 'uploading', stage: '保存分析输入', error: null })),
        persist: persistProject, assertCurrent: check,
      });
      dispatched = true;
      updateNode(id, { imageRun: { ...run, phase: 'running' }, status: 'running', stage: '云端视觉分析中' });
      const result = await requestArtAnalysis(snapshot, controller.signal);
      check();
      if (!canReport(id, run)) throw new Error('本次视觉分析已被替换。');
      await applyArtAnalysis(id, result.analysis, result.provider, result.model, { ...run, phase: 'done', provider: result.provider, model: result.model });
      controller.signal.throwIfAborted();
      if (localImageJobsRef.current.get(id) === controller) {
        localImageJobsRef.current.delete(id);
        setLocalImageJobsVersion(value => value + 1);
      }
      return await exportArtBoard(id, { assertActive: generation.assertActive });
    } catch (error) {
      if (canReport(id, run)) {
        const interrupted = error.name === 'AbortError' || error.name === 'TimeoutError';
        flushSync(() => updateNode(id, { ...(run ? { imageRun: imageRunError(run, error, dispatched) } : {}),
          status: interrupted ? 'cancelled' : 'error', stage: '分析未应用',
          error: interrupted && dispatched ? '已停止接收结果，无法确认提供商是否仍在执行。' : error.message }));
        await persistProject().catch(() => {});
      }
      return { ok: false, error: error.message };
    } finally {
      clearTimeout(timer);
      if (localImageJobsRef.current.get(id) === controller) {
        localImageJobsRef.current.delete(id);
        setLocalImageJobsVersion(value => value + 1);
      }
    }
  }, [project.id, project.readOnly, getArtDirectorState, assertCurrent, updateNode, persistProject, applyArtAnalysis, exportArtBoard]);
  const attachArtInput=useCallback(async(id,slot,file)=>{
    if(project.readOnly||switchingRef.current||localImageJobsRef.current.has(id))throw new Error('当前节点不可编辑。');const target=nodesRef.current.find(n=>n.id===id);if(!target)throw new Error('节点已删除。');let sourceId;flushSync(()=>{sourceId=addNode('image',{title:slot==='artwork'?'电子主美 · 作品':'电子主美 · 参考'},{x:target.position.x-430,y:target.position.y+350},false);});const saved=await chooseMedia(sourceId,file);if(!saved?.ok)throw new Error('图片导入失败。');onConnect({source:sourceId,sourceHandle:'ref',target:id,targetHandle:slot});await persistProject();
  },[project.readOnly,addNode,chooseMedia,onConnect,persistProject]);
  const disconnectArtInput=useCallback((id,slot)=>{if(project.readOnly||switchingRef.current||localImageJobsRef.current.has(id))return;setEdges(items=>items.filter(e=>!(e.target===id&&e.targetHandle===slot)));},[project.readOnly,setEdges]);
  const createArtDirector=useCallback(sourceId=>{if(project.readOnly||switchingRef.current)return;const source=nodesRef.current.find(n=>n.id===sourceId);if(source?.type!=='media'||source.data.kind!=='image')return;const existing=edgesRef.current.find(e=>e.source===sourceId&&e.targetHandle==='artwork'&&nodesRef.current.some(n=>n.id===e.target&&n.type==='artDirector'));if(existing)return existing.target;let id;flushSync(()=>{id=addNode('artDirector',{}, {x:source.position.x+440,y:source.position.y},true);});onConnect({source:sourceId,sourceHandle:'ref',target:id,targetHandle:'artwork'});return id;},[project.readOnly,addNode,onConnect]);
  return useMemo(() => ({getArtDirectorState,applyArtAnalysis,runArtAnalysis,exportArtBoard,cancelArtDirector,attachArtInput,disconnectArtInput,createArtDirector,persistProject}), [getArtDirectorState,applyArtAnalysis,runArtAnalysis,exportArtBoard,cancelArtDirector,attachArtInput,disconnectArtInput,createArtDirector,persistProject]);
}
