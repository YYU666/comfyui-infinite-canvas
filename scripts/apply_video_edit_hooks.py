"""Apply the minimal video-edit E1 hooks to existing files (idempotent, all-or-nothing).

Usage: python scripts/apply_video_edit_hooks.py [--check]
Every anchor must match exactly once; line endings of each file are preserved.
Never touches native3d* files.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARK = "video-edit"

HOOKS = {
    "video_workbench_launcher.py": [
        ("from native3d_api import Native3DAPI\n", "from native3d_api import Native3DAPI\nfrom video_edit_api import VideoEditAPI\nfrom video_edit_jobs import VideoEditJobs\n"),
        ("            server.native3d_api = Native3DAPI(server.native3d_jobs)\n",
         "            server.native3d_api = Native3DAPI(server.native3d_jobs)\n            server.video_edit_api = VideoEditAPI(VideoEditJobs(runtime_dir() / \"video-edit-jobs\", server.project_store))\n"),
        *[(f"        native3d_api = getattr(self.server, \"native3d_api\", None)\n        if native3d_api and native3d_api.handle_{m}(self, path):\n            return\n",
           f"        native3d_api = getattr(self.server, \"native3d_api\", None)\n        if native3d_api and native3d_api.handle_{m}(self, path):\n            return\n"
           f"        video_edit_api = getattr(self.server, \"video_edit_api\", None)\n        if video_edit_api and video_edit_api.handle_{m}(self, path):\n            return\n") for m in ("get", "post")],
    ],
    "src/canvas-connections.js": [
        ("import { isImageProcess, acceptsImageProcessConnection } from './image-process-graph.js';\n",
         "import { isImageProcess, acceptsImageProcessConnection } from './image-process-graph.js';\nimport { isVideoEdit, planVideoEditConnection } from './video-edit-document.js';\n"),
        ("  let targetHandle = connection.targetHandle;\n",
         "  if (isVideoEdit(target)) { const plan = planVideoEditConnection(connection, source, target, nodes, edges); return plan.error ? plan : { ...plan, resolvedFrom: resolved.resolvedFrom }; }\n  let targetHandle = connection.targetHandle;\n"),
    ],
    "src/canvas-layout.js": [
        ("  imageProcess: { width: 370, height: 1000 },\n", "  imageProcess: { width: 370, height: 1000 },\n  videoEdit: { width: 400, height: 420 }, // video-edit\n"),
    ],
    "src/canvas-mcp.js": [
        ("import {nativeOutputNode} from './native3d-output.js';\n",
         "import {nativeOutputNode} from './native3d-output.js';\nimport { isVideoEdit, normalizeVideoEditDocument, nextVideoEditPort, videoEditSummary } from './video-edit-document.js';\n"),
        ("  video_asset: ['video', {}],\n", "  video_asset: ['video', {}],\n  video_edit: ['videoEdit', { title: '视频编辑' }],\n"),
        ("  'workflowParameters', 'ratio',", "  'editDocument', 'workflowParameters', 'ratio',"),
        ("    ...(isImageProcess(node) ? { processingSettings:", "    ...(isVideoEdit(node) ? videoEditSummary(node.data) : {}),\n    ...(isImageProcess(node) ? { processingSettings:"),
        ("hasMedia: Boolean(node.data.url || node.data.resultUrl || node.data.processedAssetPath ||", "hasMedia: Boolean(node.data.url || node.data.resultUrl || node.data.processedAssetPath || node.data.editResultAssetPath ||"),
        ("export async function generateNodeForMcp(latest, { nodeId, wait = false, timeoutMs = 300000 }, waitImpl = waitFor) {\n",
         "async function waitForVideoEdit(latest, nodeId, jobId, timeoutMs, waitImpl) {\n  if (!jobId) throw new Error('这个视频编辑节点还没有提交导出。');\n"
         "  const node = await waitImpl(() => { const current = mcpNode(latest, nodeId); return current.data.videoEditJobId === jobId && ['done', 'error', 'cancelled'].includes(current.data.status) ? current : null; }, timeoutMs, 500);\n"
         "  return { node: nodeSummary(node), resultNode: null };\n}\n\n"
         "export async function generateNodeForMcp(latest, { nodeId, wait = false, timeoutMs = 300000 }, waitImpl = waitFor) {\n"),
        ("  if (isImageProcess(initial)) {\n    const result = await latest.current.actions.generateNode(nodeId);\n",
         "  if (isVideoEdit(initial)) {\n    const result = await latest.current.actions.generateNode(nodeId);\n    if (!result?.ok) throw new Error(result?.error || '视频导出提交失败。');\n"
         "    if (!wait) return { node: nodeSummary(mcpNode(latest, nodeId)), jobId: result.jobId };\n    return waitForVideoEdit(latest, nodeId, result.jobId, timeoutMs, waitImpl);\n  }\n"
         "  if (isImageProcess(initial)) {\n    const result = await latest.current.actions.generateNode(nodeId);\n"),
        ("  if (initial.type === 'native3d') return waitForNative3D(latest, nodeId, timeoutMs, waitImpl);\n  const promptId",
         "  if (initial.type === 'native3d') return waitForNative3D(latest, nodeId, timeoutMs, waitImpl);\n  if (isVideoEdit(initial)) return waitForVideoEdit(latest, nodeId, initial.data.videoEditJobId, timeoutMs, waitImpl);\n  const promptId"),
        ("坐标使用 0–1 比例。' },", "坐标使用 0–1 比例。视频编辑节点（video_edit）用 editDocument 结构体（schemaVersion 1，整数 PTS + 有理数时基），见 docs/VIDEO_EDITOR_E1_IMPLEMENTATION_2026_11_12.md。' },"),
        ("          validateModelSettings(settings, current.data.mode ?? '');\n          const patch = { ...settings };\n",
         "          if ('editDocument' in settings && !isVideoEdit(current)) throw new Error('editDocument 仅适用于视频编辑节点。');\n"
         "          validateModelSettings(settings, current.data.mode ?? '');\n          const patch = { ...settings };\n"
         "          if ('editDocument' in settings) patch.editDocument = normalizeVideoEditDocument(settings.editDocument);\n"),
        ("targetHandle || defaultTargetHandle(target, source);", "targetHandle || (isVideoEdit(target) ? nextVideoEditPort(target, source, latest.current.edgesRef.current) : defaultTargetHandle(target, source));"),
    ],
    "src/CanvasWorkbench.jsx": [
        ("import { renderImageProcess } from './image-process-runtime';\n",
         "import { renderImageProcess } from './image-process-runtime';\nimport VideoEditorNode from './VideoEditorNode';\nimport { defaultVideoEditDocument, videoEditInputView } from './video-edit-document';\nimport { createVideoEditRunner } from './video-edit-runtime';\n"),
        ("function ArtDirectorCanvasNode(props) {\n",
         "function VideoEditCanvasNode(props) {\n  const actions = useContext(NodeContext);\n  return <VideoEditorNode {...props} actions={actions} title={<NodeTitle id={props.id} data={props.data} kind=\"generator\" />} toolbar={<NodeActions id={props.id} data={props.data} selected={props.selected} />} />;\n}\nfunction ArtDirectorCanvasNode(props) {\n"),
        ("imageProcess: React.memo(ImageProcessCanvasNode) };", "imageProcess: React.memo(ImageProcessCanvasNode), videoEdit: React.memo(VideoEditCanvasNode) };"),
        ("  }, [project.id, project.readOnly, getImageProcessState, chooseMedia, saveCanvasAsset, updateNode, setNodes, setEdges, persistProject]);\n",
         "  }, [project.id, project.readOnly, getImageProcessState, chooseMedia, saveCanvasAsset, updateNode, setNodes, setEdges, persistProject]);\n"
         "  // video-edit: backend FFmpeg export; jobs share localImageJobsRef so project switches wait and node deletion cancels.\n"
         "  const videoEditDepsRef = useRef({});\n"
         "  videoEditDepsRef.current = { updateNode, saveCanvasMedia, persistProject, saveProjectFile: (storageId, file, revision) => saveProjectFile(project.id, storageId, file, revision) };\n"
         "  const videoEditRunnerRef = useRef(null);\n"
         "  if (!videoEditRunnerRef.current) videoEditRunnerRef.current = createVideoEditRunner({ getProjectId: () => projectRef.current.id, getNodes: () => nodesRef.current, getEdges: () => edgesRef.current,\n"
         "    jobs: localImageJobsRef.current, onJobsChange: () => setLocalImageJobsVersion((version) => version + 1),\n"
         "    updateNode: (...args) => videoEditDepsRef.current.updateNode(...args), saveCanvasMedia: (...args) => videoEditDepsRef.current.saveCanvasMedia(...args),\n"
         "    persistProject: () => videoEditDepsRef.current.persistProject(), saveProjectFile: (...args) => videoEditDepsRef.current.saveProjectFile(...args) });\n"
         "  const getVideoEditState = useCallback((id) => {\n"
         "    const node = nodesRef.current.find((item) => item.id === id);\n"
         "    return { inputs: videoEditInputView(id, nodesRef.current, edgesRef.current, (path) => assetUrl(project.id, path)), busy: localImageJobsRef.current.has(id),\n"
         "      resultUrl: node?.data.editResultAssetPath ? assetUrl(project.id, node.data.editResultAssetPath) : null };\n"
         "  }, [project.id]);\n"),
        ("    if (nodesRef.current.find(n => n.id === id)?.type === 'native3d') return nativeRunRef.current.run(id);\n",
         "    if (nodesRef.current.find(n => n.id === id)?.type === 'native3d') return nativeRunRef.current.run(id);\n"
         "    if (nodesRef.current.find(n => n.id === id)?.type === 'videoEdit') return switchingRef.current || project.readOnly ? { ok: false, error: '当前画布不可编辑。' } : videoEditRunnerRef.current.run(id);\n"),
        ("    else if (type === 'prompt') data = {", "    else if (type === 'videoEdit') data = { title: '视频编辑', status: 'idle', editDocument: defaultVideoEditDocument(), ...extra };\n    else if (type === 'prompt') data = {"),
        ("runImageProcess, isImageProcessBusy, getImageProcessState, getImageProcessMask,",
         "runImageProcess, isImageProcessBusy, getImageProcessState, getVideoEditState, resumeVideoEdit: (id) => videoEditRunnerRef.current.resume(id), cancelVideoEdit: (id) => videoEditRunnerRef.current.cancel(id), prepareVideoEdit: (id) => videoEditRunnerRef.current.prepare(id), projectId: project.id, getImageProcessMask,"),
        ("readOnly: project.readOnly }), [", "readOnly: project.readOnly }), [getVideoEditState, project.id, "),
        ("<span>RGBA 通道合并<small>四张灰度贴图 → RGBA · 32 位 TGA 导出</small></span><Plus size={13} /></button>\n",
         "<span>RGBA 通道合并<small>四张灰度贴图 → RGBA · 32 位 TGA 导出</small></span><Plus size={13} /></button>\n"
         "          <button onClick={() => addNode('videoEdit', { title: '视频编辑' }, addMenu.flow)}><i><Film size={17} /></i><span>视频编辑<small>帧精确裁切 · 分割 · 倒放 · 补帧 · 拼接 · 原声</small></span><Plus size={13} /></button>\n"),
    ],
}


def patched(relative, edits):
    path = ROOT / relative
    raw = path.read_bytes()
    newline = b"\r\n" if b"\r\n" in raw else b"\n"
    text = raw.decode("utf-8")
    if newline == b"\r\n":
        text = text.replace("\r\n", "\n")
    if "video_edit_api" in text or "videoEdit" in text or "video-edit" in text:
        return path, None  # already hooked
    for old, new in edits:
        count = text.count(old)
        if count != 1:
            raise SystemExit(f"{relative}: anchor found {count} times: {old[:80]!r}")
        text = text.replace(old, new)
    data = text.encode("utf-8")
    if newline == b"\r\n":
        data = data.replace(b"\n", b"\r\n")
    return path, data


def main():
    check = "--check" in sys.argv
    results = [patched(relative, edits) for relative, edits in HOOKS.items()]
    for path, data in results:
        state = "already hooked" if data is None else "would patch" if check else "patched"
        if data is not None and not check:
            path.write_bytes(data)
        print(f"{state}: {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
