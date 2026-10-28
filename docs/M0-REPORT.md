# M0 清场与基线报告

- 阶段：M0
- Commit：`M0: freeze schema and unify local lifecycle`（本提交）
- Tag：`m0-done`

## 关键变更

- 旧部署 `C:\ComfyUI_windows_portable\video_workbench` 整体移至忽略的 `_archive/video_workbench-20261029/`；`run_video_workbench.bat` 已指向唯一源码的 `启动.vbs`。
- `deepseek.key` 已备份到 `%USERPROFILE%\.h3\deepseek.key`，SHA-256 比对一致后移除旧部署及归档内密钥；密钥未读取、未入库。
- 冻结 `schema/project.schema.json`、最小示例、校验脚本及负例；覆盖项目、画布、角色、服装、场景、镜头、条和资产索引。
- 新增 `启动.vbs`、`启动.bat`、`停止.bat`、`stop.py`；支持 8790–8799 动态端口、启动互斥、`instance.json`、随机令牌、健康检查、后台日志和优雅停止。
- 已运行的 ComfyUI 直接连接；仅停止工作台自己创建的 ComfyUI。密钥读取优先使用环境变量及用户 `.h3` 备份。
- 未移动 D 盘数据、模型或项目；未制作 exe 或安装包。

## 测试命令与结果

- `python test_project_schema.py`：7 项通过。
- `python test_workbench_lifecycle.py`：5 项通过。
- `python test_share_links.py`：4 项通过。
- `python scripts/validate_project.py schema/project.min.json`：schema v3 通过。
- `python scripts/smoke_lifecycle.py`：8790 占用后切到 8791；重复启动复用；无令牌停止 401；停止后端口释放。
- `node test-api.mjs`、`node test-canvas-layout.mjs`、`node test-canvas-clipboard.mjs`：全部通过。
- `npm run build`：通过；执行前 ComfyUI 队列为空。
- 真实 `启动.vbs` 连点 10 次：`pythonw=1`、关联 `cmd=0`；`stop.py` 正常停止，ComfyUI 保持运行。

## 风险

- 旧前端仍直接连接 ComfyUI；8791 已完成服务生命周期验证，但生成调用的跨端口/CORS 解耦在 M2 反代中关闭。
- 项目磁盘 API、启动器与迁移尚未实现，属于 M1 范围。

## 下一阶段

M1：项目落盘、启动器、素材 Range、revision/锁/备份、导入导出、迁移与基础 CLI。
