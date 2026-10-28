# M2 核心体验与可靠性验收

- 阶段：M2
- Commit：`M2: verify canvas performance and resilient queue lifecycle`（本提交）
- Tag：`m2-done`

## 关键变更

- 画布撤销/重做覆盖增删改和连线，限制 50 步并合并拖动；运行时不进入编辑历史。
- AUTO-SAVE-1 已修复：编辑/运行时分离、单飞+尾随、5 秒运行时快照、提示去抖，自动保存不重排项目列表。
- 后端持久化队列支持优先级、并发 1–2、暂停/继续、取消、同配方重试、SSE 和跨重启恢复；60 分钟无结果会超时，取消只针对目标任务。
- 生成结果支持稳定命名的文件、`manifest.json`、JPG/PDF 联系表；20 条选中项导出测试低于 60 秒。
- 本地 API 已启用 Host/Origin/Token/Content-Type 校验和 CSP；ComfyUI 统一经同源反代访问。
- 素材写入成功后才切换引用，支持孤儿素材预检/确认清理、缩略图 LRU/revoke 和稳定 `refTag`。
- 设置、脱敏诊断、日志包、页内 toast 与浏览器 Notification 已接入；标签页关闭后重开可汇总终态。

## 验收命令与结果

- 全部 `test_*.py` 使用便携版 Python 逐个执行：85 项通过，包含安全探针、20 条导出、素材 GC、队列超时/取消/重试和诊断。
- `node test-canvas-history.mjs`：增删改连线、拖动合并、50 步和运行时保护全部通过。
- `node test-auto-save.mjs`：60 个进度事件写 2 次、状态切换 0 次、提示 0 次；单飞、尾随和失败保留 dirty 均通过。
- `node test-m2-ui.mjs`：素材写满保留旧引用、1 秒内完成通知、系统通知调用、队列清空和离线汇总通过。
- `node test-launcher-ui.mjs`：项目重开、Range、回收站、迁移、100 项目和关闭页面后服务存续通过。
- `node test-m2-acceptance.mjs`：200 节点打开 240 ms、拖动 424 ms；页面关闭后后台任务完成，重开生成结果，服务重启不重复提交。
- `node test-queue-notifications.mjs`、`node test-generation-queue.mjs`：通过。
- `npm run build`：通过；执行前真实 ComfyUI 队列 `running=0, pending=0`，仅有既有 chunk 大小警告。
- `git diff --check`：通过。

## 风险与边界

- 后台续跑验收使用隔离后端和可控 ComfyUI 仿真上游，未触碰真实项目或提交 GPU 任务；5 分钟等待和真实模型链路纳入 M4 长跑验收。
- 系统 Notification 通过浏览器模拟接口验证调用，未把该结果冒称为真实 Windows 原生弹窗测试。
- 单 chunk 大小警告仍存在，属于 M4 性能与发布卫生工作，不影响本次 DoD。

## 下一阶段

M3：Character/Outfit/Location、Shot/Take、take 栈、审片对比、评级选用、搜索标签及画布互操作。
