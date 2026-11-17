# 节点库更新与发布记录候选

此候选从公开 v1.0.17 基线独立提取通用发布链路，属于功能候选，需审查后决定是否发布。

## 行为

- `canvas_publish_extension` 接收已安装包的精确 `digest`、`packageId`、`version` 与 `requestId`。默认更新模式；首次发布须显式选择 `mode: publish`。
- 发布前检查本地包身份、实际归档的隐私边界，以及固定 `https://refmuse.cn` 站点的公开版本记录。已有相同版本和摘要则返回已发布；摘要冲突、版本未递增、身份不一致或无法可靠查询时停止。
- 后端 `/api/extensions/{digest}/publication` 仅执行受限公开 GET，不认证、不上传、不访问 ComfyUI。远端禁止重定向，单次响应最多 1 MiB、超时 10 秒。分页、不一致和未知响应均视为未能核验。
- 前端用浏览器 Web Locks 与 localStorage 序列化记录。先持久化提交意图再发送 iframe 消息；同一请求或同一精确包不重复上传。记录最多 200 条，满额时停止，不自动清除。
- `canvas_get_extension_publish_status` 只查询记录与公开状态。等待超时表示结果未知；状态查询和页面重载不重传。明确发生在准备阶段、尚未发送的失败可使用原 requestId 显式重试。
- 节点库结果必须同时匹配固定 origin、iframe window 与协议版本。登录、审核中、明确拒绝及最终发布状态分别记录；收到提交确认不代表已公开发布。
- 发布不修改当前画布固定的节点包版本，也不触发项目保存。只读画布可查询发布状态，禁止调用发布动作。

## 范围与限制

提取内容仅包括发布 ledger、公开预检、现有节点库组件的消息接线，以及 Canvas/MCP 动作。未迁移任何 3D、人物专属配方、媒体、权重、凭据或其他运行时功能。此功能依赖站点已有的公开版本端点及 iframe 分享协议；本候选只做离线 mock/契约验证，尚无登录、审核、真实发布或界面端到端验收。当前普通分享面板仍沿用已有行为；精确包的持久去重由上述发布工具入口建立记录。

localStorage 不可用、记录无法写入或浏览器缺少 Web Locks 时停止发送。清除浏览器站点数据会丢失本地记录，公开版本摘要预检仍会执行；未知结果应先查原请求或公开版本，避免人为重传。

## 离线验证

- `node test-node-library-publish.mjs`：注入内存存储、模拟 Web Locks/公开状态与 iframe，阻止实际 fetch。
- `python -m unittest test_extension_publication test_extension_api test_extension_sharing test_workflow_extensions`：全部外部公开读取被 mock，核对归档隐私、版本、网络约束与路由。
- `node test-canvas-mcp-queue.mjs`、`node test-canvas-current-page.mjs` 与 `npm run build`：检查现有桥接和构建兼容。

没有运行真实发布、画布生成、模型下载、运行服务或线上修改。本地测试通过不能视为生产发布验收。
