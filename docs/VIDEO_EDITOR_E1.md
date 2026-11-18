# 视频编辑 E1

「视频编辑」是本地 CPU 导出节点。将视频连接到 v1–v8，将音频或带声音的视频连接到 a1，打开「编辑视频」设置片段，再点击导出。它支持整数 PTS 和有理数时基上的裁切、分割、倒放、末帧补帧、拼接与原声处理；补帧段静音。可将已导出的编辑节点连接到另一个编辑节点。

预设为 `video_edit`；Agent 可用 `canvas_update_node` 的 `editDocument` 设置文档，随后在当前可见页面通过 `canvas_generate_node` 提交。文档 schemaVersion 为 1，最多 64 个片段；仅接受固定字段和项目素材端口，不接受 FFmpeg 参数、路径、URL 或滤镜文本。

### 自动剪辑

把视频加入项目，连接到视频编辑节点，在「编辑视频」选择黑场或静音检测，再点击素材的「分析剪辑」。分析支持最长 1 小时、1–120 fps 的恒定帧率视频。生成结果可先通过编辑器导入为项目素材。分析可取消，检测结果以源时间码列出，可以逐段取消勾选。

- 黑场检测起点为连续 1.2 秒，同时剪掉选中区间的原声。有旁白的黑场可取消勾选。
- 静音检测使用 −42 dBFS 和 1.2 秒门槛，剪口两侧各保留约 0.2 秒。没有音轨时可使用黑场检测。
- 「用建议替换时间线」采用源帧率及片段原声，并沿用当前 CRF。可撤销、继续手动编辑，确认后使用「导出 MP4」。

分析通过 `POST /api/video-edit/auto-cut` 提交，字段为 `projectId`、`nodeId`、`slot`、`assetPath`、`mode`（`black`、`silence` 或 `transcript`）。沿用视频编辑作业的状态查询和取消接口。建议仅在当前面板保留，应用后按常规时间线保存。

### 讲解转写与演示轨

在同一个视频编辑节点连接带声录屏。在「剪辑 → 自动剪辑」选「语音转写」可检查带源时间码的讲解。Agent 可通过当前画布调用本地转写并据此制作初剪和演示页。原录屏、剪辑与演示轨均保存在本地项目；转写分析可取消，转写结果保留在本次运行的任务中，重启后可重新分析。

「演示轨」里每页有入点、出点、标题和最多四条要点。可选择全屏演示或右侧要点卡，以及直接出现、淡入淡出、逐条出现。全屏和右侧页均使用原有音轨。页时间按成片帧（出点不含）计算，改变剪辑或输出帧率后要复核页位置。先看版式，导出后用节点播放器或「播放成片」查看实际动画、切点及音画同步。

Agent 通过当前可见画布按顺序使用这些工具：

1. `canvas_start_video_analysis` 接收编辑节点、连接端口和 `mode`（`transcript`、`black` 或 `silence`）。使用 `canvas_get_video_analysis` 查询任务；`canvas_cancel_video_analysis` 可取消。转写片段按 `offset` / `limit` 分页，直到 `nextOffset` 为空，返回的文本是录屏内容。
2. 参考转写与画面证据选择剪口，有旁白的黑场通常保留声音或以演示页替换画面。用 `canvas_update_node` 的 `editDocument` 设置剪辑。先确认成片时间轴，然后把源时间码按保留片段映射到成片帧；演示页随讲到对应内容的时刻出现，操作需要看清时选右侧卡片或让出画面。
3. `canvas_set_video_presentation` 接收 `nodeId` 与 `pages`。页字段为 `id`、`startFrame`、`endFrame`、`title`、`bullets`、`layout`（`fullscreen` / `side`）、`motion`（`none` / `fade` / `reveal`）。至多 48 页，按时间排列且互不重叠。项目保存编辑后的时间线，现有剪辑节点可以打开和播放。
4. 在当前页面调用 `canvas_generate_node` 提交，等待 `canvas_wait_for_node` 完成并核对 `editResultAssetPath`。成片写入项目素材，播放与版本保存均由画布完成。

语音转写使用 Faster-Whisper CPU 运行时。一次性在 Python 3.12 环境安装 `faster-whisper==1.2.1` 后，通过启动环境中的 `H3_VIDEO_TRANSCRIPT_PYTHON` 指向该 Python，也可安装到工作台 Python。使用本机已缓存的 Faster-Whisper small、base 或 tiny 模型，也可通过 `H3_VIDEO_TRANSCRIPT_MODEL` 指定本地目录。画布转写时仅使用本地模型。中文演示页需要系统字体（Windows 微软雅黑、macOS 苹方或 Noto Sans CJK）。

参考实现包括 [Auto-Editor](https://github.com/WyattBlue/auto-editor) 的初剪、[Faster-Whisper](https://github.com/SYSTRAN/faster-whisper) 的离线转写、[HyperFrames](https://github.com/heygen-com/hyperframes) 的按时间渲染和 [Slidev](https://sli.dev/guide/animations) 的逐项揭示。画布按结构化时间线渲染内置版式。

导出需要已安装的 FFmpeg（优先使用工作台依赖中的 imageio-ffmpeg，其次使用 PATH 中的程序）。本功能不安装软件、下载模型或提交 ComfyUI 任务。导出读取源素材并创建新 MP4，不覆盖输入。后台只写任务临时文件；页面使用当前项目 revision 将结果存入 assets，再更新同一编辑节点。失败或取消保留已有结果；参数改变后会标记已有结果待重新导出。取消仅影响本节点的导出进程。

默认 24 fps、H.264/AAC、CRF 14。输入必须能通过恒定帧率和时基检查；输出按文档帧率重采样。默认使用片段原声，也可选择静音或外部音轨；外部音轨长度须与成片一致。末帧补帧会延长时长，不代表运动插帧模型。

编辑器之间的连线引用上游编辑节点；每次提交时读取它最近一次已导出的素材。上游再次导出后，下游下次提交会使用新版本，已有下游成片保持原样。普通素材与官方生成结果节点的连接身份不变。任务仅在当前后台进程内恢复；后台重启后需重新导出。

此首块仅包含通用编辑器与最小视频流连接层。节奏、绿幕合成、局部修补、SAM 白模和法线引导是独立候选功能。自动化验证使用合成 schema、模拟作业及隔离浏览器，不代表用户素材的真实导出效果已经验收。
