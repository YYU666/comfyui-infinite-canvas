# 画布 WebMCP 操作参考

## 1. 前置条件

工作台地址为 `http://127.0.0.1:8790/`。画布页面向当前浏览器注册 WebMCP 工具，Agent 必须连接到这个实际页面；浏览器仅打开页面但不支持 WebMCP 时，不要假装调用成功。

工具返回 JSON 字符串。先检查 `ok`，再读取 `node`、`edge` 或 `resultNode`。节点完整 ID 必须来自 `canvas_get_state` 或创建接口返回值。

### 当前已打开页面的 HTTP 通道

原生工具无法附着当前页时，使用同一服务的公开通道，沿用 `X-H3-Token`，不要创建第二个浏览器：

1. `GET /api/agent/canvas/current?projectId=<项目ID>` 获取 `epoch/sessionId/projectId`。没有可见页返回 `NO_VISIBLE_CANVAS`；多个可见候选返回 `AMBIGUOUS_CANVAS`。只读页面不接收命令。
2. `POST /api/agent/canvas/commands` 发送上述三个字段，以及唯一 `opId`、`tool`、`args`。页面调用现有工具，复用用户当前节点、保存队列和生成队列。
3. `GET /api/agent/canvas/commands/<opId>` 读取 `queued/dispatched/done/expired/unknown`。只有 `done` 且 `result.ok=true` 表示工具成功；修改工具还会等待正常保存屏障。

同一 `opId` 和参数重发只读原回执，不重复执行；不同参数复用 ID 返回冲突。`dispatched/unknown` 时不可换 ID 重新生成，应先核对画布节点和队列任务；断线不能证明任务未提交。服务重启会改变 `epoch`，旧命令拒绝执行。会话心跳有效期为 15 秒，命令记录最多 512 条，达到容量后明确报错，不删除去重记录再重放。

当前页通道支持下表工具，但长等待使用 `canvas_get_state` 查询，生成必须 `wait:false`。页面心跳与回执由前端管理，Agent 不得伪造页面心跳。新版本后端启动、现有网页重新载入后才会连接；旧实例不支持时明确报告，不以另开网页降级。

## 2. 工具清单

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `canvas_get_state` | 读取当前项目、真实节点、连线和状态 | 可选 `nodeId`、`includePrompt` |
| `canvas_inspect_node` | 在当前页内打开节点对应的 ComfyUI 工作流查看器；不提交生成 | 必填 `nodeId`；可选 `stage`（四视图支持单张阶段及 `stitch`） |
| `canvas_open_reference_library` | 在当前画布内打开外部参考库；只打开界面，不下载、不生成 | 可选 `library`：`refmuse`（默认）、`costume`（衣装）或 `pose`（姿势） |
| `canvas_import_asset` | 在当前页复用本项目已保存素材 | 必填 `nodeId`、`assetPath`；可选 `name` |
| `canvas_download_video` | 在当前页把分享链接下载为视频节点 | 必填 `url`；可选 `nodeId`、`x`、`y`、`wait`（默认 false） |
| `canvas_create_node` | 在当前画布创建节点 | 必填 `preset`；可选 `title`、`prompt`、`text`、`x`、`y`、`focus` |
| `canvas_update_node` | 更新标题、提示词、备注或白名单参数 | 必填 `nodeId`；可选 `title`、`prompt`、`text`、`settings` |
| `canvas_connect_nodes` | 连接两个真实节点 | 必填 `sourceId`、`targetId`；通常省略 `targetHandle` 自动判断 |
| `canvas_generate_node` | 提交一次真实生成 | 必填 `nodeId`；可选 `wait`、`timeoutMs` |
| `canvas_wait_for_node` | 等待已提交任务，不重复提交 | 必填 `nodeId`；可选 `timeoutMs` |
| `canvas_delete_node` | 删除指定节点及连线 | 必填 `nodeId`；运行中节点可能被取消 |
| `canvas_tidy` | 整理全部节点并适应视口 | 无参数；会移动所有节点，须谨慎 |

`timeoutMs` 范围为 1000 至 1500000。长任务可分段只读等待；超时本身不代表生成失败，应再读取节点状态。

## 3. 节点预设

| 类别 | `preset` |
| --- | --- |
| 素材 | `image_asset`、`video_asset`、`audio_asset`、`local_mask`（局部遮罩修改） |
| 文本 | `note` |
| 视频 | `reference_video`、`text_video`、`frames_video`、`video_download` |
| 图片 | `krea_image`、`moss_image`、`qwen_edit` |
| 修复与增强 | `image_upscale`、`video_upscale` |

母图编辑、角色替换、角色四视图及旧换装预设仅作为本机第三方实验工具，公开构建不提供新建入口或 Agent 注册。已有画布兼容保留；可用预设以当前页工具 schema 为准。下载的自定义工作流使用 `canvas_create_custom_node`，不冒充官方预设。

素材上传、遮罩编辑等没有独立 WebMCP 工具时，使用工作台现有用户界面完成，不要构造绕过前端校验的私有调用。

## 4. 创建、连接和更新

1. 先读取当前状态，确认没有可复用的同用途节点。
2. 创建节点，保存接口返回的完整 ID。未指定坐标时由画布逻辑放置；指定坐标时也要检查碰撞。
3. 更新提示词或设置后读取节点核验。只传需要修改的字段。
4. 连接后核对实际 `edge` 的 `source`、`target` 和 `targetHandle`。
5. 再读取目标节点，确认提示词、素材引用、生成参数均符合用户意图。

自动目标端口规则：

- 提示词节点 → 生成节点：`prompt`
- 素材 → 全能参考：`references`
- 素材 → 首尾帧：依据素材槽位选择 `first` 或 `last`，需要明确指定槽位时不能用自动判断代替
- 图片 → 母图编辑、换装、局部写实或图片高清：`guide`
- Qwen「图生图」使用统一 `references` 图片接口，最多 10 张，标准版与 Turbo 在节点内切换。旧 `guide`／`identity` 连线兼容为图1／图2；新调用省略 `targetHandle` 自动选择。母图编辑、换装、局部写实和图片高清仍遵循原来的独立接口。
- 图片 → 角色替换：`identity`；视频 → 角色替换或视频高清：`guide`

不要靠连线外观判断是否接好，必须读取边数据。

Qwen 多图的编号以节点内参考图列表为准，不以素材在画布上的位置为准。图1决定输出画幅；提示词可用“图1、图2”说明结构、氛围、画风等用途。引用须与当前连接对应，断开已引用图片后需重新连接或删除该引用，不能把编号悄悄转给另一张图。旧 `qwen_edit` 和 `qwen_turbo_edit` 预设继续可用，右键菜单统一为「图生图」。

## 5. 提交、等待和结果核验

节点处于 `uploading`、`queued`、`running`、`finishing` 时，禁止调用 `canvas_generate_node`，改用 `canvas_wait_for_node`。

- 只提交：`canvas_generate_node`，`wait: false`。确认返回新的 `promptId`，报告“已提交”而非“已完成”。
- 提交并等待：`wait: true`，按任务设置合理超时。成功后必须存在终态 `done` 和真实 `resultNode`。
- 等待已有任务：使用当前 `promptId` 对应的节点，等待后核对结果节点与本次任务相符。

若返回 `error`、`cancelled` 或 `ok: false`，如实报告错误。先检查输入、连线、模型和 ComfyUI 状态，不盲目重复生成。

## 6. 布局规则

按“素材 → 处理 → 结果”从左到右排列，相关任务成组，标题能识别母图、参考、处理和结果。

- 不覆盖现有节点，不在重叠时继续随意放置。
- 当前自动避让最小间距为 70，位置按 22 的网格对齐；显式坐标也须验证不重叠。
- 新结果节点由现有画布流程自动生成，不得另外复制一个无法追踪来源的“结果”。
- `canvas_tidy` 会重排所有节点，只在用户要求整理或获得明确许可时使用。
- 删除仅用于清理已确认无用的临时测试节点；不得用删除来代替整理。

## 7. 完成报告

简洁列出：创建／修改的节点、实际连线、最终状态、结果节点、生成文件目录，以及仍存在的错误。不要罗列内部调用过程。

## 8. 查看内部 ComfyUI 工作流

右键生成节点或生成结果节点，选择「进入 ComfyUI」，可在当前画布内打开 ComfyUI 查看器。双击图片仍用于预览大图。`canvas_inspect_node` 使用同一入口；只有实际导入完成且节点与连线校验通过才返回 `opened: true`。它不会创建 H3 结果节点或提交生成，也不改变项目 revision。

生成结果按自身的任务／prompt 记录定位，不能用生成节点的最新任务替代历史结果。分阶段四视图可选 `front_portrait`、`three_quarter_portrait`、`back_body`、`front_body`、`stitch`；旧单图工作流通常为 `workflow`。界面区分实际执行图、持久化计划还原和尚未执行；无记录的节点不能预览草稿。

查看器载入 ComfyUI 临时工作流副本，修改不自动写回 H3。用户仍可手动操作 ComfyUI，包括运行；打开与切换本身不生成。关闭查看器回到同一画布。ComfyUI 临时标签可能保存在其本地工作区。

## 9. 外部参考库

顶部「Refmuse参考库」提供 Refmuse、衣装库和姿势库的原站浏览。Refmuse 图片通过网页的「导入当前画布」保存；衣装库和姿势库的图片下载后，关闭参考库并使用画布本身的图片上传入口添加。参考库底部不再提供单独文件导入行。成功仍需素材上传与画布保存都完成。

`canvas_open_reference_library` 仅确认当前页弹层已打开，`remoteContentVerified: false` 表示不能据此声称跨域网站内容已加载。网站空白或无法下载时可由用户点击「打开原站」。不得批量抓取目录、镜像素材或自动提交姿势/换装生成。

Refmuse 页签使用官网专用嵌入模式：登录搜索后点击「导入当前画布」，经当前页保存素材和节点成功才反馈已导入。最多32 MiB PNG/JPEG/WebP，记录来源与作者；不触发生成。导入期间UI和Agent均不得切换参考库。只有握手后显示已连接；工具打开回执仍不代表外站内容已确认。

2026-11-01 修复：入口名「Refmuse参考库」，Refmuse 第一项和首次默认项。同项目关闭重开保持iframe和搜索；切换项目会销毁旧iframe。隐藏页不能导入。多张图片在网站侧串行下载/发送/等待保存，上限20张排队；仅明确未写入允许用户重试。手动「重新加载」会清空搜索并重置会话，仅用于异常恢复或100次请求额度用尽。

2026-11-01 外观统一：参考库外框与按钮使用直角，Refmuse内页通过受来源、frame及channel校验的`refmuse.canvas.theme`消息同步明暗主题；加载前按网站7:00–19:00日间规则显示。嵌入页隐藏节点库、打开工作台及积分入口，官网独立访问保持原样。登录、搜索、一键导入和搜索状态保留机制不变。

### 图生图的独立局部遮罩（2026-11-02）

右键「局部遮罩修改」创建 `local_mask`；原图连接其 `guide` 输入，遮罩的 `mask` 输出连接 `qwen_edit` 的 `mask` 输入。也可点击图生图节点的「+ 添加遮罩」，自动以图1连接底图并创建遮罩节点。遮罩不计入最多10张参考、不参与图号。绘制/导入遮罩后才可生成；白色修改、黑色保留。底图必须与当前图1相同，替换底图素材后必须重新绘制或导入。生成期间遮罩及底图连线不可更改。

当前支持标准版与Turbo：原图编码、遮罩限制采样、最终按原图尺寸合成。普通无遮罩流程保持原样；不与单格 `qwenSourceCrop` 同用。旧 `local_realism` 节点保留兼容，新增入口使用通用遮罩节点。画布验收不默认提交真实生成。


### 断开连线

单击连线可选中；悬停或选中时显示「断开」按钮，点击后只删除连线。`Alt + 单击连线` 同样断开。操作通过画布正常历史和保存流程，支持撤销；选中本身不产生撤销记录。只读项目禁止断开，生成中的 Qwen 参考/遮罩连线及单格裁切保护仍生效。不要为验证功能断开用户正在使用的连接，优先隔离测试。
图片及生成结果节点不接受遮罩输入。遮罩仅接图生图的专用 `mask` 口，底图同时连接遮罩的 `guide` 和图生图的图1。

图生图接入遮罩后可勾选「局部放大重绘」（`qwenMaskCrop: true`）：裁切遮罩周围1.3倍上下文、放大到参考精度采样，再回贴原尺寸。图1此时代表局部裁切，其他参考图不裁切；提示词应描述该局部。默认关闭。此设置不能与 `qwenSourceCrop` 同用。

### 连接手感与视频下载

端口支持拖动和依次点击连接，缩放时扩大命中范围；类型不匹配、目标忙或无成品时显示明确提示。生成器输出口只引用当前已保存的唯一成品，连线落到该成品素材上，不随之后的新生成悄悄换图。首尾帧模式在「视频生成」节点内选择。右键「视频链接下载」可独立下载为素材，不自动提交生成。

`canvas_download_video` 走同一条页面下载：已有下载节点时写入 `nodeId` 并让输入框显示链接；否则在 `x`/`y` 新建。完成后在右侧生成视频节点并经页面保存。`wait:false` 立即返回 `nodeId`、`jobId` 和 `status:"queued"`；`wait:true` 返回 `videoNodeId`。用 `canvas_get_state` 看该节点的 `downloadStatus`（`queued`/`downloading`/`done`/`failed`）和 `message`。只接受 http/https，拒绝带账号密码的链接，不把凭据写入错误或日志。
