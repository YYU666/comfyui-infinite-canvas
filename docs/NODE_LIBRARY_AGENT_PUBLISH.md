# Agent 发布与更新节点库

日期：2026-11-08。本功能更新 Refmuse 节点库，不提交 Git，也不替换画布中已经固定版本的节点。

## 使用流程

1. 通过现有分享流程准备 `.h3pack`，核对提示词、依赖、许可和允许公开的内容。更新已有节点时保留 `packageId`，提高语义版本号。
2. 导入本地工作流库，取得真实 `digest`、`packageId`、`version`。不能把任意磁盘路径交给发布工具。
3. 在当前已打开画布调用 `canvas_publish_extension`。它打开同页节点库，沿用网站登录，通过现有 iframe 分享协议提交精确的节点包。
4. 调用 `canvas_get_extension_publish_status`，使用相同 `requestId` 查询。只有 `published` 表示已发布；`submitted` 不能当作完成。

首次需要在网站正常登录。登录由网站处理；Agent 不读取或传递浏览器账号凭据。当前画布需加载包含新工具的前端版本。

## 工具参数

```json
{
  "tool": "canvas_publish_extension",
  "args": {
    "requestId": "example-package-update-v020",
    "digest": "<已安装包的64位SHA256>",
    "packageId": "<原发布者命名空间>/<原节点身份>",
    "version": "0.2.0",
    "mode": "update"
  }
}
```

`mode` 默认 `update`。首次发布使用 `publish`；已存在的包应使用 `update`。服务端检查版本递增；同版本且公开摘要完全一致直接返回已发布，同版本但内容不同拒绝覆盖。

```json
{
  "tool": "canvas_get_extension_publish_status",
  "args": { "requestId": "example-package-update-v020" }
}
```

这两个工具通过标准 `canvas_call`/当前页通道调用。外层 `opId` 是画布命令身份，内层 `requestId` 是上传身份，不要混淆。查询可使用新的外层命令 ID，但上传身份保持不变。

## 状态和重试

| 状态 | 含义与下一步 |
| --- | --- |
| `submitted` | 请求已准备/发送或已进入审核；检查 `sent`、`phase`、`remoteStatus`，继续查询 |
| `awaiting-login` | 仅在网站明确返回该状态时使用；用户正常登录 |
| `published` | 网站可信回执确认，或公开版本的身份与摘要已核对一致 |
| `failed` | 确认的预检/准备失败或明确拒绝；查看错误码 |
| `unknown` | 回执超时、页面中断或上传结果不确定；查询公开记录，不重复上传 |

网站当前协议未提供完整的登录进度，因此没有回执时不能凭猜测报告“等待登录”。审核状态通过 `remoteStatus` 保留，不因等待超过两分钟而变成上传失败。

同一 `requestId` 绑定同一身份和摘要。重复调用、刷新、重新打开节点库和状态查询不会自动重发。只有明确未进入发送队列的准备失败，才允许用同一 `requestId` 显式重试；发送后结果不确定时先核对记录。不要删除浏览器发布记录来绕过去重。

## 边界与验证

- 本地 `POST /api/extensions/{digest}/publication` 只读核对公开目录，不执行上传，不带网站鉴权。
- 发布前核对实际归档内容，拒绝未清理的本地素材路径、凭据和额外附件；保留经检查的分享封面。不重写包或偷偷改变摘要。
- 外站消息必须匹配固定网站来源、当前 iframe 窗口与请求 ID。
- 发送前持久化去重标记；持久化失败则不发送。
- 多个画布共用浏览器 Web Locks 锁，每次持锁后重新读取发布记录，防止两个页面重复发送或覆盖回执。浏览器不支持该锁时停止上传。
- 本地记录仅保存身份与状态，不保存归档字节、图片或登录令牌。
- 网络异常、无效公开响应、版本冲突都不能当成“尚未发布”。查询不会上传，也不会重新生成角色图片。

测试入口：`test-node-library-publish.mjs`、`test-node-library-publish-ui.mjs`、`test_extension_publication.py`、`test_canvas_page_bridge.py`。页面测试使用隔离的模拟 iframe，不操作用户项目或提交真实投稿。实际公开发布以当前页回执及公开目录摘要为准，测试通过本身不代表已上线。
