# 项目开启要求与当前侧栏画布模式

## 1. 默认操作模式（强制）

- 中间 Agent 对话，侧面 Browser 保持当前画布；不另开第二个可写画布、第二标签页或外部浏览器窗口。
- 后台计算、ComfyUI、API、脚本允许执行；但所有后台结果必须交付到当前画布并让用户看到。
- 交付完成 = 真实素材 + 结果节点 + 与来源节点/镜头连线 + 已保存 revision；只有后台文件/状态不算完成。
- 同一项目只允许当前页面作为最终写入者；出现只读、锁冲突、第二写客户端时停止并报告，不强行保存。
- 外部网页打开画布需要用户明确要求；默认不这样做。

## 2. 启动前置条件

| 类别 | 要求 | 检查点 |
|---|---|---|
| 操作系统 | Windows 10/11；当前支持矩阵只验证 Windows | `platform.system()` |
| ComfyUI | 便携版根目录含 `ComfyUI/main.py`、`python_embeded/python.exe`、`pythonw.exe` | 路径存在 |
| ComfyUI 版本 | 0.42.5（唯一完成在线节点验证的版本） | `/system_stats` |
| Python | 使用 `python_embeded`；不回退系统 Python | `install.py` / 启动器 |
| 依赖 | `requirements.lock` 10 个包带 SHA256；`psutil`、`imageio_ffmpeg` 等可用 | `pip check` / import |
| 前端 | `dist/index.html` 存在；Node 20.19+ 只在安装/构建时需要 | `dist` |
| 端口 | 8790–8799 选一个空闲；ComfyUI 8188 | 监听检查 |
| 网络 | 仅回环 `127.0.0.1`；不对外监听 | Host/Origin/token |
| 项目根 | 默认 `%USERPROFILE%\Documents\H3 Workbench`；可设 `H3_PROJECTS_ROOT` | 目录可写 |
| 数据根 | 默认旧 `D:\H3_Workbench`（如存在），否则固定盘最大剩余空间下的 `H3_Workbench`；可设 `H3_WORKBENCH_DATA_DIR` | `data-directory.json` |
| 素材/输出 | `DATA_DIR/references`、`DATA_DIR/generated`；ComfyUI 以 `--input-directory`/`--output-directory` 启动 | 目录/启动参数 |
| 节点 | 6 个第三方节点 + `h3_workbench_refine`；版本固定 commit | `/object_info` |
| 模型 | 至少 `core-h3` 7 项（71.164 GiB）；完整 33 项 164.803 GiB | `models/manifest.json` |
| 浏览器 | 当前侧栏 Browser 或浏览器；地址 `http://127.0.0.1:8790/` | 页面可加载 |

## 3. 启动顺序

1. 检查 `dist/index.html`，否则提示先 `install.bat` / `npm run build`。
2. 创建 `DATA_DIR/references/workbench`、`DATA_DIR/generated`。
3. 在 8790–8799 启动仅回环的 HTTP 服务，生成随机 token。
4. 加载设置：`comfyRoot`、`projectsRoot`、`modelRoots`、队列并发、默认画幅。
5. 初始化 `ProjectStore`、`ProjectAPI`、`AgentAPI`、`QueueManager`。
6. 探测 ComfyUI：
   - 已运行：直接连接，不拥有其进程；
   - 未运行：隐藏启动 ComfyUI，带 `--input-directory`、`--output-directory`、`--listen 127.0.0.1`、`--port 8188`、`--enable-cors-header`。
7. 写入 `instance.json`（port/token/pid/startedAt/comfyOwned）。
8. 打开浏览器或返回当前侧栏画布地址。
9. 检查 `/api/health`、ComfyUI `/system_stats`、`/object_info`。

## 4. 打开一个项目时要求

| 项 | 要求 |
|---|---|
| 项目目录 | `<projectsRoot>/<项目名>` |
| 项目文件 | `project.json`，`schemaVersion: 3` |
| 项目 ID | `prj_...`，必须与路径/请求一致 |
| revision | 整数；保存必须匹配当前 revision，否则 409 + 冲突副本 |
| 素材 | `assets/`；节点 `assetPath` 指向存在的文件 |
| 目录 | `assets/`、`backups/`、`outputs/`、`exports/`、`.cache/` |
| 锁 | `.lock` 记录 owner/pid/heartbeat；活锁时第二客户端只读 |
| 备份 | `backups/project-r*.json`，最多 20 个 |
| 恢复 | 冲突副本 `.conflict-*.json`；损坏 JSON 可恢复 |
| 只读 | 服务端强制；不能只靠前端隐藏按钮 |
| 项目根 | 设置切换项目根前必须关闭当前项目/释放锁 |

## 5. 可选但不阻塞启动

- `deepseek.key`：只用于提示词优化；没有不影响画布打开。
- `H3_COMFY_ROOT`：仓库不在便携版根目录时需要。
- `H3_WORKBENCH_NO_BROWSER=1`：不自动打开浏览器。
- 外置模型目录：`ComfyUI/extra_model_paths.yaml`；需要时配置 `modelRoots`。
- 更新检查：启动检查/用户确认；活动任务、打开项目、Git 本地修改会阻止升级。

## 6. 当前侧栏模式的硬约束缺口

| 层 | 现状 | 需要补 |
|---|---|---|
| 侧栏 Browser | 插件存在，Web profile 默认可能关闭 | 默认打开当前画布 |
| Agent 工具 | 有 HTTP/CLI/MCP，但可后台操作 | 只暴露当前画布工具 |
| 画布 | 项目锁 | active tab 单写租约 |
| 外部打开 | 无统一禁止 | 工具白名单/策略 |
| 提示词 | 口头约定 | `AGENTS.md` 已写强制规则 |

> 纯提示词不能阻止后台 API/headless；要默认生效，必须补“当前页 WebMCP + 单写租约 + Agent 工具白名单”。
