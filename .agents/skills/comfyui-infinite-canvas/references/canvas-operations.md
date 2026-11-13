# 画布 WebMCP 操作参考

用户要在画布上看到的图片或视频，标准路径是可见节点：**创建 → 连接 → 提交 → 等待终态**。逐步操作只按 `docs/AGENT_MANUAL.md` 第 4 节，生成回路以配方 B、E 为准。本文只说明页桥工具边界，不另写一套步骤。

协议 v2 的 `apply`／`wait`，以及向 `http://127.0.0.1:8188/prompt` 直接提交，都不能代替那条回路。

## 1. 前置条件

工作台地址以 `agent_cli.py start` 返回的 `url` 为准，不要写死 `8790`。画布页面向当前浏览器注册 WebMCP 工具。HTTP 页桥执行的是同一页上的工具；必须连到这个可操作页面。浏览器只打开了地址、或页面不支持通道时，不要假装调用成功，也不要另开第二个页面。

工具返回 JSON 字符串。先检查 `ok`，再读取 `node` 或 `edge`。节点完整 ID 必须来自 `canvas_get_state` 或创建接口返回值。生成提交的回执没有结果地址；终态节点的 `media` 才有 `url`、`filename`、`subfolder`、`type` 或 `assetPath`。

### 当前已打开页面的 HTTP 通道

原生工具无法附着当前页时，使用同一服务的公开通道，沿用 `X-H3-Token`，不要创建第二个浏览器：

1. `GET /api/agent/canvas/current?projectId=<项目ID>` 获取 `epoch/sessionId/projectId`。`projectId` 只在可见页中选定一个。没有可操作页，或指定项目只在隐藏／只读页上，返回 `NO_VISIBLE_CANVAS`。同一项目有多个可见页时返回 `AMBIGUOUS_CANVAS`。只读页面不接收命令。
2. `POST /api/agent/canvas/commands` 发送上述三个字段，以及唯一 `opId`、`tool`、`args`。页面调用现有工具，复用用户当前节点、保存队列和生成队列。
3. `GET /api/agent/canvas/commands/<opId>` 读取 `queued/dispatched/done/expired/unknown`。只有 `done` 且 `result.ok=true` 表示工具成功；修改工具还会等待正常保存屏障。

同一 `opId` 和参数重发只读原回执，不重复执行；不同参数复用 ID 返回冲突。`dispatched/unknown` 时不可换 ID 重新生成，应先核对画布节点和队列任务；断线不能证明任务未提交。服务重启会改变 `epoch`，旧命令拒绝执行。会话心跳有效期为 15 秒，命令记录最多 512 条，达到容量后明确报错，不删除去重记录再重放。

当前页通道只支持下表工具。生成必须 `wait:false`。完成用 `GET /api/agent/canvas/events` 或表中的 `canvas_wait_for_node`，再用一次 `canvas_get_state` 核对可见节点。页面心跳与回执由前端管理，Agent 不得伪造页面心跳。新版本后端启动、现有网页重新载入后才会连接；旧实例不支持时明确报告，不以另开网页降级。

`projectId` 只在 `visible:true` 的页面里选定目标。隐藏或只读页不会被操作。`visible` 表示该页可以写入，不是窗口是否在最前。

## 2. 页桥工具清单

与 `canvas_page_bridge.py` 的 `TOOLS` 一致。表外工具会让 `POST /api/agent/canvas/commands` 返回 400。

| 工具 | 用途 | 关键参数 |
| --- | --- | --- |
| `canvas_get_state` | 读取当前项目、真实节点、连线和状态 | 可选 `nodeId`、`includePrompt`。有结果时含 `media`，默认不含长提示词 |
| `canvas_create_node` | 在当前画布创建可见节点 | 必填 `preset`；可选 `title`、`prompt`、`text`、`x`、`y`、`focus` |
| `canvas_update_node` | 更新标题、提示词、备注或白名单参数 | 必填 `nodeId`；可选 `title`、`prompt`、`text`、`settings` |
| `canvas_connect_nodes` | 连接两个真实节点 | 必填 `sourceId`、`targetId`；通常省略 `targetHandle` 自动判断 |
| `canvas_generate_node` | 提交一次真实生成 | 必填 `nodeId`；`wait` 必须为 `false`。成功只表示已提交 |
| `canvas_wait_for_node` | 只读等待已提交任务 | 必填 `nodeId`。当前页 `timeoutMs` 为 1000–20000，省略则 20000。未结束为 `pending:true`，不重新提交 |
| `canvas_cancel_node` | 取消该节点正在进行的生成 | 必填 `nodeId`。与界面取消按钮相同，不删除节点 |
| `canvas_import_asset` | 复用已保存素材 | 必填 `nodeId`、`assetPath`；路径必须是 `assets/<64位十六进制>.<扩展名>`。可选 `name`、`sourceProjectId` |
| `canvas_focus_node` | 把视口对到节点 | 必填 `nodeId` |
| `canvas_delete_node` | 删除指定节点及连线 | 必填 `nodeId`；运行中删除可能取消任务，这不是取消工具 |
| `canvas_move_nodes` | 移动指定的 1 至 30 个节点 | 必填 `nodes` |
| `canvas_tidy` | 整理全部节点并适应视口 | 无参数；会移动所有节点，须用户明确许可 |
| `canvas_retry_save` | 保存失败后重试 | 无参数；版本冲突时停止，不覆盖 |
| `canvas_inspect_node` | 在当前页内打开节点对应的 ComfyUI 工作流查看器；不提交生成 | 必填 `nodeId`；可选 `stage`（四视图支持单张阶段及 `stitch`） |
| `canvas_open_reference_library` | 在当前画布内打开外部参考库；只打开界面，不下载、不生成 | 必填 `library`：`refmuse`、`costume`（衣装）或 `pose`（姿势） |
| `canvas_create_project` | 在当前页新建项目 | 必填 `name`。启动器页可用 |
| `canvas_open_project` | 在当前页打开已有项目 | 必填 `projectId`。启动器页可用 |
| `canvas_create_extension` | 从已导入的本地工作流包创建一个节点 | 必填 `digest`、`nodeDefinitionId` |

完成通知是 `GET /api/agent/canvas/events?after=<cursor>&timeoutMs=20000`，请求头 `X-H3-Token`。`timeoutMs` 最大 25000。返回的 `events` 只有 `done` / `error` / `cancelled`，含 `nodeId` 和结果文件位置；空列表表示这一轮还没有终态，用返回的 `cursor` 再等。某一次读取还在 `running` 或 `pending:true`，只表示尚未终态，不代表失败，也不要重新提交。

## 3. 节点预设

| 类别 | `preset` |
| --- | --- |
| 素材 | `image_asset`、`video_asset`、`audio_asset`、`local_mask`（局部遮罩修改） |
| 文本 | `note` |
| 视频 | `reference_video`、`text_video`、`frames_video`、`video_download` |
| 图片 | `krea_image`、`moss_image`、`qwen_edit` |
| 修复与增强 | `image_upscale`、`video_upscale` |

母图编辑、角色替换、角色四视图及旧换装预设仅作为本机第三方实验工具，公开构建不提供新建入口或 Agent 注册。已有画布兼容保留；可用预设以当前页工具 schema 为准。下载的自定义工作流使用页桥里的 `canvas_create_extension`，不冒充官方预设。没有 `canvas_create_custom_node`。

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

标准路径见 `docs/AGENT_MANUAL.md` 配方 B 的第 5–6 步，不要改用别的等待接口。

节点处于 `uploading`、`queued`、`running`、`finishing` 时，不要再次调用 `canvas_generate_node`。用 `canvas_wait_for_node` 或 `GET /api/agent/canvas/events` 等待。

- 只提交：`canvas_generate_node`，`wait: false`。确认返回新的 `promptId`，报告「已提交」而非「已完成」。`wait: true` 会被页桥拒绝。
- 命令 `GET /api/agent/canvas/commands/<opId>` 变为 `done` 且 `result.ok` 为真，只表示页面工具已返回。
- 终态以 `canvas_get_state` 为准：`status` 为 `done`、`error` 或 `cancelled`。`done` 时还应能在画布上看到连回本次 `promptId` 的结果节点，并用该节点的 `media` 取结果位置。
- 停止这次生成用 `canvas_cancel_node`。

若返回 `error`、`cancelled` 或 `ok: false`，如实报告错误。先检查输入、连线、模型和当前画布连着的 ComfyUI，不要改向 `127.0.0.1:8188/prompt` 直接提交，也不要盲目再生成。

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
