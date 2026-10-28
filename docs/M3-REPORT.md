# M3 创作层验收

- 阶段：M3
- Commit：`M3: add project creative libraries shots and take review`（本提交）
- Tag：`m3-done`

## 关键变更

- 项目内角色、服装、场景支持 CRUD；角色卡包含身份参考、四视图、默认服装、声音和备注，删除时检查镜头及默认服装引用。
- 镜头支持编号、提示词、角色/服装/场景关联、生成参数、状态与标签；生成节点可提升为镜头，镜头可定位回画布节点。
- Take 支持 0–5 星评级、单条选用、淘汰、备注和标签；审片页支持 2–4 条对比、键盘切换、筛选及重开持久化。
- 项目支持标签、收藏和角色/服装/场景/镜头/Take 全局搜索。
- 绑定镜头的生成结果进入 Take 栈，默认不新增媒体节点；ComfyUI 输出先按引用保存，导出时才写入项目 `outputs/` 和交付副本。
- 所有创作写操作复用项目锁、备份、schema 校验和 revision/CAS；统一前端项目版本同步，创作保存及生成入栈前会先落盘画布，避免旧版本写入。

## 验收命令与结果

- 全部 `test_*.py` 使用便携版 Python 逐个执行：91 项通过，覆盖领域 CRUD、引用保护、ID 不复用、CAS、schema 和外部输出导出。
- `node test-m3-ui.mjs`：三类素材库、关联角色/服装/场景的镜头、6 条 Take、4 条对比、评级/选用/淘汰、搜索、提升为镜头及重开持久化通过。
- 同一浏览器验收中，隔离仿真输出 `H3_Image_M3_simulated.png` 正确进入绑定镜头的 Take；未增加媒体节点，项目素材仍只有测试上传的 1 项。
- `node test-canvas-history.mjs`、`node test-auto-save.mjs`、`node test-m2-ui.mjs`、`node test-launcher-ui.mjs`、`node test-m2-acceptance.mjs`、`node test-queue-notifications.mjs`、`node test-generation-queue.mjs`：全部通过。
- `npm run build`：通过；执行前真实 ComfyUI 队列为空，仅有既有 chunk 大小警告。
- `git diff --check`：通过。

## 风险与边界

- 镜头生成链路使用随机端口的隔离仿真 ComfyUI，未提交真实 GPU 任务，不冒称真实模型生成已验收；真实模型链路纳入 M4 全链路验收。
- 单 chunk 大小警告仍存在，留待 M4 发布性能检查，不影响本阶段 DoD。

## 下一阶段

M4：Agent 协议 v2、短句柄、digest/query/apply/wait、语义工具、MCP resources、token 基准和全链路发布验收。
