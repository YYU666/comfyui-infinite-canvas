# M1 项目落盘、启动器与迁移验收

- 阶段：M1
- 提交：`M1: add launcher and migrate browser projects`（标签 `m1-done`）
- 基线：`e5ddefb` + `m0-done`

## 关键变更

- 项目以 `project.json + assets/ + backups/` 落盘，接入 HTTP CRUD、revision/CAS、锁、20 版备份、回收站、ZIP 导入导出和 CLI。
- 启动器提供最近/全部/模板/回收站、搜索排序、列表网格、新建六种模板、打开路径、重命名、复制、导出及资源管理器定位。
- 画布改用 HTTP 项目存储，素材按内容哈希恢复，支持返回启动器和只读保护。
- IndexedDB 迁移先保存 ZIP 再导入，核对节点、边、素材数量，保留原浏览器记录。
- 默认目录外打开的项目在同一后端会话中可继续读取和保存。
- Windows 禁止多个后端重用同一端口；测试在任何 UI 写入前核验健康 PID 和隔离项目根。

## 验收命令与结果

- `'C:\ComfyUI_windows_portable\python_embeded\python.exe' test_project_store.py`：20 项 OK，含并发、锁、备份、外部项目往返。
- `'C:\ComfyUI_windows_portable\python_embeded\python.exe' scripts/smoke_project_api.py`：CRUD、409、Range、200 MB 视频 seek、导入导出、回收站、CLI 全通过。
- `'C:\ComfyUI_windows_portable\python_embeded\python.exe' scripts/smoke_project_crash.py`：连续 3 次通过，JSON 可读，死亡写入进程临时文件已清理。
- `node test-launcher-ui.mjs`：隔离修复后连续 3 次通过新建重开、素材恢复/Range、删除恢复、3 个合成迁移、100 项目、关闭标签页服务仍运行。
- `node test-canvas-projects.mjs`：旧 IndexedDB 格式 20 项及并发检查通过。
- `node test-canvas-layout.mjs`、`node test-canvas-clipboard.mjs`、`node test-api.mjs`：通过。
- `npm run build`：通过；仅有既有 chunk 大小警告。
- `git diff --check`：通过。

## 真实迁移说明

本机实际发现并成功迁移 **2 个真实项目**，节点数分别为 76、148，素材索引分别为 20、31；148 节点项目已成功重开。PRD 写“3 个真实项目”，但机器上没有第三个真实旧项目，因此另以 **3 个合成旧项目**验证迁移数量、素材、提示词和原记录保留，不将合成数据冒称为真实项目。

## 风险与下一阶段

- 真实 148 节点项目曾出现高频自动保存；M2 必须完成编辑/运行时分离、单飞尾随与运行时快照节流。
- 当前仍有旧 ComfyUI 直连；M2 通过反代、安全校验和持久化后台队列替换。
- 下一阶段：M2 核心体验与可靠性。
