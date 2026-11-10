# 电子主美：视觉供应商与凭据边界

电子主美共用一个 OpenAI 兼容的 Chat Completions 协议适配器。界面只允许下表中的官方 HTTPS 端点和已核对图像输入能力的模型；不提供任意代理地址、任意模型或自定义主机输入。HTTP 跳转被拒绝，防止凭据随重定向流向其他主机。

| 供应商 | 固定视觉模型 | 官方协议说明 | 本地配置环境变量 |
| --- | --- | --- | --- |
| 千问 | `qwen3-vl-plus` | [图像与 JSON 模式](https://help.aliyun.com/zh/model-studio/json-mode) | `QWEN_API_KEY` / `DASHSCOPE_API_KEY` |
| Kimi | `kimi-k3.1-pro` | [视觉](https://platform.moonshot.cn/docs/guide/use-kimi-vision-model)、[JSON 模式](https://platform.moonshot.cn/docs/guide/use-json-mode-feature-of-kimi-api) | `MOONSHOT_API_KEY` / `KIMI_API_KEY` |
| 豆包 | `doubao-seed-2-1-pro-260915` | [图像输入](https://ark.volcengine.com/region:cn-beijing/docs/image-understanding)、[结构化输出](https://www.volcengine.com/docs/82379/1568221) | `ARK_API_KEY` / `DOUBAO_API_KEY` |
| DeepSeek Flash | `deepseek-flash` | [视觉](https://api-docs.deepseek.com/zh-cn/guides/vision)、[JSON 模式](https://api-docs.deepseek.com/zh-cn/guides/json_mode) | `DEEPSEEK_API_KEY` |

2026-11-10 按官方文档核对协议与能力，并通过模拟请求测试。这里没有宣称真实付费推理、账户权限或模型效果已经测试。DeepSeek `deepseek-v4-pro` 官方能力表不支持图像理解，因此不列入审图选择；旧的纯文本模型也不会被静默当作视觉模型。可用模型发生变化时，应先核对官方文档再更新固定配置。

千问请求显式关闭 thinking；Kimi 使用当前协议的 `reasoning_effort: low`；豆包使用 `thinking.type: disabled`。这些参数按各供应商分别设置，共同要求 JSON 输出并在本机再次验证字段、数量及原图归一化坐标。图片中的文字被视为待分析内容。

## 本机配置

节点的供应商选择、模型和作品目标可以随项目保存。密钥只在密码框短暂存在，提交后清空，不进入节点、浏览器存储、项目 JSON、分享包或状态响应。

支持以下来源，优先级为：后端本次会话 → 对应供应商环境变量 → 本机加密存储。清除会话或删除本机凭据后，如环境变量仍存在，会继续使用环境配置。

“用于本次后端会话”只存后端内存，重启清除。“加密保存在本机”使用 Windows 当前用户 DPAPI 加密并设置仅当前用户的受保护访问控制。默认文件在用户运行目录 `credentials/art-director-credentials.dpapi`；文件、临时文件和目录不含明文凭据。也可把已存在的会话凭据直接保存，本机接口不会把它取回浏览器。

每次读取/保存会检查凭据位置必须在仓库、当前项目根和已打开的外部项目目录之外。运行目录环境配置指到项目内时会拒绝；设置中更换项目根后仍会重新检查。DPAPI、权限、损坏文件或其他用户无法解密等失败不会回退为明文。非 Windows 系统可使用会话/环境配置，当前实现不持久保存凭据。

## 开源、导出与日志

源码仅包含供应商协议和非敏感配置名，没有个人 API Key 或默认真实凭据。本文件的命令/配置说明不包含可用密钥。发布前不能把运行目录或本机凭据复制进仓库。

项目导出只包含 `project.json`、素材和结果。加密凭据位于外部运行目录，既不进入项目，也不由导入操作提供。更新包构建器会拒绝运行目录、凭据文件、`.env` 实际配置及私钥文件，即使它们被强行加入 Git；仅允许无凭据的 `.env.example`。诊断包会对已知供应商的会话、环境及本机凭据进行精确脱敏；无法安全取得脱敏信息时拒绝生成诊断包。

云端分析会发送作品和选定参考；取消会停止接收/应用结果，但已发出的供应商请求可能继续执行和计费。示例、JSON 导入、辅助线编辑和解析 PNG 生成仍由本机完成，不需要付费模型调用。
