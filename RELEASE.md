# H3 视频工作台 v1.0.0

本地网页端 PRD v2.0 的 M0–M4 功能发布。形态保持为 Python 后端 + 浏览器 UI，不包含 exe、安装包、桌面壳、托盘、自动更新或 M5 模型中心。

## 本版功能

- **M0 清场与基线**：唯一源码入口、旧部署归档、schema v3、启动互斥、动态端口、健康检查、随机访问令牌与优雅停止。
- **M1 项目与启动器**：磁盘项目、六种模板、HTTP CRUD、素材 Range、原子写、revision/CAS、锁、20 版备份、回收站、ZIP 导入导出、外部项目与基础 CLI。
- **M2 核心可靠性**：50 步撤销/重做、AUTO-SAVE-1 修复、持久化后台队列、跨重启恢复、精准取消/重试、SSE、manifest/联系表、安全反代、素材 GC、设置诊断与通知。
- **M3 创作层**：项目内角色/服装/场景库、Shot/Take、2–4 条审片对比、评级/选用/淘汰、搜索标签、画布互操作及导出时复制交付文件。
- **M4 Agent 协议 v2**：稳定短句柄、digest/增量/query/apply/wait、字段与 token 预算、幂等回执、语义操作、HTTP/CLI/stdio MCP、resources、长提示词 hash/diff 和无浏览器全链路。

详细阶段证据见 `docs/M0-REPORT.md` 至 `docs/M4-REPORT.md`。

## 启动与停止

1. 按 `README.md` 和 `AGENTS.md` 完成 ComfyUI、节点、模型及前端安装校验。
2. 双击 `启动.vbs`，浏览器打开启动器；通常为 `http://127.0.0.1:8790/`，端口占用时会使用 8791–8799。
3. 双击 `停止.bat` 优雅停止工作台。`start.bat` 只用于调试。
4. 默认项目根为 `%USERPROFILE%\Documents\H3 Workbench`；生成结果默认引用 ComfyUI 输出，导出时复制到项目 `outputs/`。

关闭浏览器标签页不会停止后台服务或取消队列。不要在 ComfyUI 有生成任务时停止或重启 ComfyUI。

## Agent 使用入口

- 完整协议、凭据、HTTP/CLI/MCP 配置和示例：`docs/AGENT.md`。
- 日常操作规范：`.agents/skills/comfyui-infinite-canvas/SKILL.md`。
- 本地 CLI 默认从 `instance.json` 读取地址和令牌，例如：

```bat
C:\ComfyUI_windows_portable\python_embeded\python.exe agent_cli.py state --project prj_xxx
C:\ComfyUI_windows_portable\python_embeded\python.exe agent_cli.py protocol
C:\ComfyUI_windows_portable\python_embeded\python.exe agent_mcp.py
```

推荐流程为 `context/digest → query → 批量 apply → wait → take.select → delivery.export`。写操作使用唯一 `opId`；遇到 revision 冲突时停止并重新读取，不覆盖其他窗口修改。

## 发布验收

在仓库根目录执行：

```bat
for %f in (test_*.py) do C:\ComfyUI_windows_portable\python_embeded\python.exe "%f"
for %f in (test-canvas-history.mjs test-auto-save.mjs test-m2-ui.mjs test-launcher-ui.mjs test-m2-acceptance.mjs test-queue-notifications.mjs test-generation-queue.mjs test-m3-ui.mjs) do node "%f"
C:\ComfyUI_windows_portable\python_embeded\python.exe scripts\agent_benchmark.py
npm run build
```

本次发布实际结果：

- 18 个 Python 测试文件、共 **96 项测试全部通过**。
- 上述 **8 组前端/浏览器回归全部通过**；200 节点打开 235 ms、拖动 385 ms。
- 200 节点/20 镜头/5 角色/50 Take 基准达标：digest 15/100、query 64/150、回执 22/30、四操作 apply 48/200、wait 25/50、工具 schema 336/600 tokens。
- 构建前真实 ComfyUI 队列为 `running=0, pending=0`；`npm run build` 通过，仅有单 chunk 超过 500 kB 的体积警告。

## 真实边界与已知限制

- Agent 建镜头→生成→选片→导出以及 M3 生成入 Take 使用隔离 FakeAdapter/仿真上游验收；**本次未提交真实 GPU 生成任务**，不冒称真实模型质量或性能已验收。
- **未执行 8 小时／100 项目／50 GB 长跑**，因此不宣称该项稳定性矩阵已通过。
- 本机只发现并迁移 2 个真实旧项目（76/148 节点）；另用 3 个合成旧项目验证迁移，未虚构第三个真实项目。
- 服务端语义生成当前覆盖 H3 文生视频和图片参考视频；项目视频/音频素材直接 Agent 上传及其他专用工作流仍走画布流程。
- `estTokens` 是确定性的四字符/token 估算，用于预算与 CI，不是特定模型的精确 tokenizer 计数。
