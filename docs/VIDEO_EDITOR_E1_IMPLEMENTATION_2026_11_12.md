# 画布视频编辑节点 E1 实现说明（2026-11-12）

本期实现了调研文档 `VIDEO_EDITOR_MVP_RESEARCH_2026_11_10.md` 中的 E1：后端 FFmpeg 帧精确剪辑引擎 + 画布可见节点 + agent 控制路径。E2/E3（区间 AI、长片多角色）不在本期。
代码为独立实现，未复制 Songssx/ComfyUI-MiniMaxH3-TimelineDirector（GPL-3.0）的任何源码。

## 1. 文件

新增（全部独立文件）：

| 文件 | 作用 |
| --- | --- |
| `video_edit_document.py` | editDocument 严格校验、整数 PTS / 有理时基运算、全局重采样网格与导出计划 |
| `video_edit_ffmpeg.py` | 只用参数数组调用 ffmpeg：探测（framecrc，不依赖 ffprobe）、逐帧解码 → 倒放 / 补帧 → libx264 编码，音频 48 kHz 样本级拼装 |
| `video_edit_jobs.py` | 单 CPU 工作线程的作业队列、临时目录、取消（只杀本作业的 ffmpeg 进程）、产物以版本化资产登记到项目 |
| `video_edit_api.py` | `/api/video-edit/*` 路由 |
| `video_edit_testmedia.py` | 测试用合成视频：帧号二进制亮块 + 烧录帧号/时间码 + 每 10 帧 1 kHz 音频标记；支持 29.97 与 VFR |
| `test_video_edit_document.py`、`test_video_edit_ffmpeg.py` | Python 测试（23 项） |
| `src/video-edit-document.js` | 与 Python 一致的 JS schema、连线规划、输入解析、节点摘要 |
| `src/video-edit-runtime.js` | 前端作业客户端：提交 / 轮询 / 取消 / 经页面保存通道提交结果 |
| `src/VideoEditorNode.jsx`、`src/VideoEditorPanel.jsx`、`src/video-edit.css` | 节点与同页编辑面板 |
| `test-video-edit.mjs` | Node 测试：JS/Python schema 一致性、连线、agent 工具注册路径、32 KB 预算、runner |
| `test-video-edit-ui.mjs` | 浏览器端到端：临时后端 + 临时项目 + 合成视频，用页面桥 agent 工具跑完整「剪 15 秒 → 倒放补帧 → 还原裁帧 → 拼回贴原声」并逐帧核对 |
| `scripts/apply_video_edit_hooks.py` | 幂等地把最小 hook 打到现有大文件上（全有或全无；保留 CRLF/LF；每个锚点必须唯一匹配） |

最小 hook（由 `scripts/apply_video_edit_hooks.py` 写入，`--check` 可只检查不写）：

- `video_workbench_launcher.py`：导入、创建 `VideoEditAPI`、在 native3d 之后分发 GET/POST。
- `src/canvas-connections.js`：videoEdit 目标端口规划分支。
- `src/canvas-layout.js`：节点尺寸。
- `src/canvas-mcp.js`：预设 `video_edit`、`EDITABLE_SETTINGS` 加 `editDocument`（仅 videoEdit 节点，且先经 schema 规范化）、节点摘要、generate / wait 分支、自动选端口、工具说明一句。
- `src/CanvasWorkbench.jsx`：nodeTypes、runner、generateNode 分支、addNode 默认数据、上下文、菜单按钮「视频编辑」。

未改：任何 `native3d*` 文件、`canvas_page_bridge.py`（不需要新工具名）、任何 project.json。

## 2. editDocument schema（schemaVersion 1）

```jsonc
{
  "schemaVersion": 1,
  "timelineTimebase": { "num": 1, "den": 24 },   // 可省；缺省 = 1/fps，必须让每帧是整数 tick
  "outputProfile": {
    "fps": { "num": 24, "den": 1 },              // 1–120；29.97 写 {30000,1001}
    "width": 1280, "height": 720,                // 可省；必须成对、偶数、16–7680；省略时所有输入须同尺寸，否则报错
    "audio": "clips",                            // "clips" | "mute" | "external"
    "audioFrom": { "inputSlot": "v1", "sourceInPts": 0, "sourceOutPts": 360, "timebase": { "num": 1, "den": 24 } },  // 仅 external
    "videoCodec": "h264", "audioCodec": "aac", "crf": 14   // 只允许 h264/aac；crf 0–51
  },
  "clips": [{                                    // 1–64 段，时间线顺序 = 数组顺序，无缝拼接
    "id": "shot_1",                              // [A-Za-z0-9_-]{1,64}，唯一
    "inputSlot": "v1",                           // v1..v8（连线端口）
    "sourceInPts": 48, "sourceOutPts": 408,      // 半开区间 [in,out)，整数
    "timebase": { "num": 1, "den": 24 },         // 可省；缺省 = 源视频流时基（例如 1/12288）
    "reverse": false,                            // 倒放（音频同步倒放）
    "pad": { "mode": "last_frame", "count": 12 },// 裁切/倒放之后追加末帧复制，补帧段静音；none 时 count 必须为 0；≤2000
    "muted": false,
    "gain": 1                                    // 线性 0–1
  }]
}
```

语义：

- PTS 相对该输入解码出的第一帧（第一帧 = 0）。给 `timebase: {1, fps}` 即可直接用帧号。
- 重采样：每个输入建一张以首帧为锚点的全局输出 fps 网格，网格点取最近源帧（并列取较早帧）。多段裁切共享同一网格，29.97 与 VFR 不会逐段取整漂移；只改 fps 标签而不重采样不会发生。
- 每段：取 [in,out) → 可选倒放 → 可选末帧补帧。音频样本边界按累计 `round(frame × 48000 / fps)`，因此音画偏移 < 1 个输出帧（测试为 0 偏移）。
- 外挂原声 `external`：用 `audioFrom` 区间整段覆盖；区间长度与成片相差超过一帧即报错「相差一帧以上」；源无音轨也报错。
- 默认帧精确重编码（libx264 + aac 192k，`+faststart`），从不用关键帧 stream-copy 冒充任意切点。
- 不受 H3 `5+17n` 限制；只有显式写 pad 才补帧。
- 拒绝：未知字段、非整数/越界 PTS、出点超出源时长、任意路径/URL、filter 文本、非白名单编码器、重复 id、NaN。

## 3. 后端 API（同源 cookie 鉴权，沿用 launcher 的 host/origin/token/JSON 校验）

| 方法 | 路径 | 体 |
| --- | --- | --- |
| POST | `/api/video-edit/probe` | `{projectId, assetPath}` → 时基、帧数、fps、尺寸、是否有音轨 |
| POST | `/api/video-edit/jobs` | `{projectId, nodeId, inputs:{v1:"assets/<sha256>.mp4",…}, document}` → `ved_<32hex>` |
| GET | `/api/video-edit/jobs/{id}` | 状态 / 进度 / 结果（每段 `timelineStartFrame`） |
| POST | `/api/video-edit/jobs/{id}/cancel` | `{projectId}`：只取消本作业 |
| POST | `/api/video-edit/jobs/{id}/commit` | `{projectId, revision}`：把成片以版本化资产写入项目 assets（与浏览器上传同一 `put_asset(expected_revision)` 通道） |

输入只接受项目内 `assets/<64位sha>.(mp4|mov|webm|m4a|mp3|wav|aac)`。源素材从不覆盖。节点数据（结果路径等）由当前页面经 `saveCanvasMedia` / `persistProject` 写回，后端不直接改 project.json。CPU 单线程执行，不进 ComfyUI 队列，不调 `/interrupt`。每节点同时只允许一个作业；剩余磁盘 < 1 GB 拒绝；导出后重新探测核对帧数。

上游是 ComfyUI 生成结果（只有 `/comfy/view` URL）时，页面先经现有 `saveProjectFile` 通道导入为项目资产，缓存在编辑节点 `editInputCache`，源结果节点不被修改。

## 4. 节点与面板

- 预设 `video_edit` / 类型 `videoEdit` / 标题「视频编辑」。左侧端口 v1–v8（视频）与 a1（音频或视频，仅供外挂原声）；右侧 `ref` 输出可再连下一个视频编辑节点。
- 成片播放器在同一节点内，不另建结果节点。
- 双击节点或「编辑视频」打开同页面板（portal 到 body）：素材列表（探测信息、「添加整段」）、预览、基础时间线（pointer capture 拖动入/出点）、镜头设置（输入、入/出点帧号+时间码、倒放、补帧、静音、音量、分割、前移/后移、删除）、输出设置（fps、声音模式含外挂原声、CRF）、撤销/重做。键盘事件（Esc、Delete、Ctrl+Z）只作用于面板，不冒泡到画布。
- 文档改动后节点显示「待重新导出」（`editStale`）。

## 5. Agent 调用

页面桥（`POST /api/agent/canvas/commands`）只接受 `canvas_generate_node` 的 `wait:false`，也不转发 `canvas_wait_for_node`；经页面桥时用 `canvas_get_state` 轮询节点 `status`。页面内 WebMCP 直连时可用 `canvas_wait_for_node`。

单节点最小序列：

```jsonc
canvas_create_node   { "preset": "video_edit", "title": "剪 15 秒" }                 // → node.id = E1
canvas_connect_nodes { "sourceId": "<原片节点>", "targetId": "E1" }                  // 自动选第一个空端口 v1
canvas_update_node   { "nodeId": "E1", "settings": { "editDocument": { … } } }       // 先经 schema 校验，错误会原样返回
canvas_generate_node { "nodeId": "E1", "wait": false }                              // → jobId ved_…
canvas_get_state     { "nodeId": "E1" }                                              // 轮询：status running/done/error/cancelled；done 时 editResultAssetPath、editResult.frames
```

`canvas_get_state` 中 videoEdit 节点摘要含：`editDocument`、`clipCount`、`editStale`、`videoEditJobId`、`editResultAssetPath`、`editResult`（frames / width / height / audio / clips[].timelineStartFrame）、`error`。

### 完整示例：从原片剪 15 秒 → 按镜头切 → 倒放+补帧 → 还原+裁掉补帧 → 拼回并贴上原声

（以下只作说明，没有在用户项目里跑；同样的序列在 `test-video-edit-ui.mjs` 中以临时项目和合成视频完整跑通并逐帧核对。数字以 24 fps、帧号时基为例，按实际素材改。）

1. 剪 15 秒：建节点 A，连原片 → v1，取 2 s–17 s：
   ```json
   {"schemaVersion":1,"outputProfile":{"fps":{"num":24,"den":1}},
    "clips":[{"id":"cut","inputSlot":"v1","sourceInPts":48,"sourceOutPts":408,"timebase":{"num":1,"den":24}}]}
   ```
   导出后 A 为 360 帧，A 自己的帧号从 0 开始。
2. 按镜头切 + 倒放 + 补帧：每个要送去生成的镜头建一个节点（例如 B 取 A 的第 2 镜 120–240 帧），连 A → v1：
   ```json
   {"schemaVersion":1,"outputProfile":{"fps":{"num":24,"den":1}},
    "clips":[{"id":"shot2","inputSlot":"v1","sourceInPts":120,"sourceOutPts":240,"timebase":{"num":1,"den":24},
              "reverse":true,"pad":{"mode":"last_frame","count":12}}]}
   ```
   B = 132 帧（120 倒放 + 12 补帧，补帧静音）。补帧数按下游模型要求显式填写。
3. B 的成片送去 SAM3 等生成节点（目前需人工把 B 的成片导入为媒体节点再连，见「已知缺口」）。
4. 还原 + 裁掉补帧：建节点 C，连「生成结果」→ v1（ComfyUI 结果会自动导入为项目资产），取前 120 帧并再倒放：
   ```json
   {"schemaVersion":1,"outputProfile":{"fps":{"num":24,"den":1}},
    "clips":[{"id":"restore","inputSlot":"v1","sourceInPts":0,"sourceOutPts":120,"timebase":{"num":1,"den":24},"reverse":true}]}
   ```
5. 拼回并贴原声：建节点 D，连 A → v1、C → v2，镜头按顺序拼接，声音用 A 的整段原声：
   ```json
   {"schemaVersion":1,
    "outputProfile":{"fps":{"num":24,"den":1},"audio":"external",
                     "audioFrom":{"inputSlot":"v1","sourceInPts":0,"sourceOutPts":360,"timebase":{"num":1,"den":24}}},
    "clips":[{"id":"s1","inputSlot":"v1","sourceInPts":0,"sourceOutPts":120,"timebase":{"num":1,"den":24}},
             {"id":"s2","inputSlot":"v2","sourceInPts":0,"sourceOutPts":120,"timebase":{"num":1,"den":24}},
             {"id":"s3","inputSlot":"v1","sourceInPts":240,"sourceOutPts":360,"timebase":{"num":1,"den":24}}]}
   ```
   D = 360 帧，外挂原声与成片等长；若生成结果分辨率与原片不同，在 outputProfile 写 width/height 统一（等比 letterbox），否则导出明确报错。

## 6. 测试

Box（Linux）：

```bash
python -m unittest test_video_edit_document test_video_edit_ffmpeg -v      # 23 项
node test-video-edit.mjs                                                  # H3_TEST_PYTHON 指向工作台 Python
npx vite build --outDir /tmp/vbuild
CHROME_PATH=/usr/bin/google-chrome H3_TEST_PYTHON=python H3_WORKBENCH_DIST_DIR=/tmp/vbuild node test-video-edit-ui.mjs
```

Windows（用户 PC，工作树内）：

```powershell
C:\ComfyUI_windows_portable\python_embeded\python.exe -m unittest test_video_edit_document test_video_edit_ffmpeg -v
$env:H3_TEST_PYTHON='C:\ComfyUI_windows_portable\python_embeded\python.exe'; node test-video-edit.mjs
```

浏览器端到端测试会启动一个使用临时目录与随机端口的测试后端（`H3_WORKBENCH_TEST_MODE=1`，不启动 ComfyUI），不连 8790；需要指向一份已构建的 dist（`H3_WORKBENCH_DIST_DIR`）。

覆盖：非关键帧裁切帧数严格、倒放/还原逐帧一致、补帧数严格且静音、三段拼接总帧与音画同步（偏移 0 帧；变异测试移位音频会失败）、有声/无声、24 / 29.97 原生 / 29.97→24 无漂移、VFR 全局映射、不同分辨率（拒绝 / 统一）、外挂原声长度、恶意输入（路径、filter 文本、越界 PTS、NaN、非法作业 id、跨项目取消）、commit 修订号、API 路由、JS/Python schema 一致、agent 工具路径、64 镜文档 < 32 KB。

## 7. 距部署还差什么（均需用户同意）

1. 在工作树运行 `scripts/apply_video_edit_hooks.py`（本次已在工作树执行，`--check` 显示 already hooked）。
2. 重启 8790 工作台后端，新 `/api/video-edit/*` 才生效（会断开当前页面的连接；须等生成结束、画布已保存）。不需要重启 ComfyUI（8188/8189）。
3. `npm run build -- --mode local-tools` 构建到独立候选目录（本次已构建并核对 `video_edit` 存在），备份运行首页后部署候选静态资源，保留旧资源。
4. 画布保存后刷新当前 8790 页面。
5. 若要提交 Git：只提交本表新文件与 hook 改动，不含任何 native3d* / 3D 文件。本次未 commit。

## 8. 本次没有做的敏感操作

- 没有停止/重启/杀掉 8790、8188、8189 上的进程，没有开第二个 Edge 窗口，没有刷新 8790 页面。
- 没有部署到运行 dist，没有 git commit / push / PR。
- 没有读取或修改「四角色 · 舞台视频制作」项目，没有 PUT /api/projects，没有改任何 project.json。
- 没有改 native3d* 文件，没有下载权重、升级 Blender 或安装软件到用户 PC。
- 日志与文档中没有写出任何 token。

## 9. 已知缺口 / 有意偏离

- 视频编辑成片连到生成节点（如 SAM3）尚不支持：生成节点的参考解析只认媒体节点。处理节点之间可以串联：视频编辑、恒定速度、时间重映射的成片可以互相作为输入（见 `docs/VIDEO_RHYTHM_NODES_2026_11_12.md`）。连到 SAM3 时仍需先把成片导入为视频素材节点。
- `audioFrom` 只支持 `inputSlot`（含 a1），不支持 `assetRef`。
- 音量用线性 0–1，不支持 dB / 增益 > 1。
- 每段导出都从文件开头解码到入点（O(位置)），长素材后段会慢；倒放段把原始帧暂存到磁盘（1080p 约 3 MB/帧）。
- 面板没有拖拽排序（用前移/后移按钮）、吸附、代理文件；时间线是基础版。
- 复制粘贴一个正在导出的 videoEdit 节点时会带上作业状态。
- 8790 重启后，进行中的作业会丢失，节点显示「后台导出任务已不存在」，需重新导出。
- VFR 合成测试视频不带音频（音频不随 VFR 时间戳移动），因此 VFR 只验证画面映射。
