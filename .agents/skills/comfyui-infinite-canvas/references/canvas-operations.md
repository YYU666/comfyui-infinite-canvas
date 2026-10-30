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
| `canvas_import_asset` | 在当前页复用本项目已保存素材 | 必填 `nodeId`、`assetPath`；可选 `name` |
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
| 素材 | `image_asset`、`video_asset`、`audio_asset` |
| 文本 | `note`、`prompt_optimizer` |
| 视频 | `reference_video`、`character_swap`、`text_video`、`frames_video` |
| 图片 | `krea_image`、`moss_image`、`identity_edit`、`qwen_edit` |
| 修复与增强 | `local_realism`、`outfit_edit`、`image_upscale`、`video_upscale` |

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
- 图片 → 图生图、母图编辑、换装、局部写实或图片高清：`guide`
- 图片 → 角色替换：`identity`；视频 → 角色替换或视频高清：`guide`

不要靠连线外观判断是否接好，必须读取边数据。

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
