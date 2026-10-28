# M4 Agent 协议 v2 验收

- 阶段：M4
- Commit：`M4: add efficient agent protocol CLI and MCP`（本提交）
- Tag：`m4-done`

## 关键变更

- 新增后端 Agent 协议 v2：`state`、`query`、`apply`、`wait`，支持 digest、增量、错误/生成/拓扑视图、字段投影、游标、`maxChars` 和 `meta.estTokens`。
- 节点短句柄持久化到项目；旧项目打开时先备份再分配，删除后不复用。工具接受句柄、旧 ID 和唯一的 `@标题`。
- `apply` 支持批量建/连/设/生成/删除/取消、`dryRun` 和 `opId` 幂等；Agent 队列使用独立 `clientId` 命名空间去重，不影响旧画布调用。
- 语义操作支持 `shot.create`、`character.create`、`outfit.create`、`take.rate/select` 和 `delivery.export`。角色、服装、场景参考由服务端展开并去重，Agent 无需读取底层节点连线。
- 新增 H3 服务端文生视频/图片参考视频工作流，Agent 等待终态后无需浏览器即可把结果写入 Take，再选片和导出。
- 新增便携版 Python 可直接运行的 `agent_cli.py`、stdio `agent_mcp.py`，MCP 仅暴露 4 个核心工具及 `canvas://context/protocol/schema` 资源。
- 长提示词使用 hash/预览，支持 `prompt.get/diff`；SKILL 改为上下文→批量 apply→回执→wait 的低 token 流程。
- 所有写操作复用项目锁、备份、schema 和 revision/CAS；过期写入返回冲突，不覆盖其他窗口修改。

## 验收命令与结果

- `C:/ComfyUI_windows_portable/python_embeded/python.exe test_agent_protocol.py`：3 项通过，覆盖预算、短句柄、增量、冲突、四操作幂等和无浏览器语义全链路。
- `C:/ComfyUI_windows_portable/python_embeded/python.exe test_agent_api.py`：2 项通过，HTTP 全链路、CLI、MCP initialize/tools/resources/call 均通过，全程未打开浏览器。
- `scripts/agent_benchmark.py`：200 节点/20 镜头/5 角色/50 Take fixture 全部达标：
  - digest 15/100 tokens；query 64/150；写回执 22/30。
  - 四操作 apply 48/200；wait 25/50；工具 schema 336/600。
- 全部 `test_*.py` 使用便携版 Python 逐个执行：96 项通过。
- M2/M3 前端、画布、队列和浏览器回归全部通过；200 节点打开 258 ms、拖动 424 ms。
- `git diff --check`：通过。

## 风险与边界

- 全链路生成使用隔离 FakeAdapter/仿真输出，未冒称真实 GPU 生成；真实模型链路和长跑在最终发布验收中单独记录。
- 服务端语义生成当前覆盖 H3 文生视频和图片参考视频。项目视频/音频素材直接上传及其他专用工作流仍使用现有画布流程，已在 `docs/AGENT.md` 明确说明。
- `estTokens` 是公开的四字符/token 确定性估算，便于 CI 复核，不冒称某个模型的精确 tokenizer 计数。

## 下一阶段

最终发布：全量回归、发布说明、工作区与标签检查，标记 `v1.0.0`；不进入 M5，不制作 exe 或安装包。
