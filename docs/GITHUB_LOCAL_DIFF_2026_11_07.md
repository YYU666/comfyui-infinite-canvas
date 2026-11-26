# GitHub与当前本地版本差异 · 2026-11-07

本次为只读核对，未提交、推送或发布。已fetch最新远端并查询GitHub PR及release。GitHub主分支为307eee07f5fb0c12d6d01b186cebb6bcbc772bfe；最新稳定版本v1.0.6；PR #13已于2026-11-06合并，当前没有打开的PR。没有只存在本地、未被远端引用的提交；下面内容属于本地工作区改动。

## 已在GitHub，不是漏传

图片调整、图像混合、RGBA通道合并、TGA导出以及相关图片处理保存保护，均已进入PR #13和v1.0.6。当前对应新增组件、处理模块和测试与远端内容一致（忽略Windows换行）。不能因为当前3D开发分支较旧、这些文件显示untracked，就误认为它们未上传。此前画布缩略图优化也已发布于v1.0.5。

## 排除3D后仍只有本地的改动

| 类别 | 差异及主要文件 |
|---|---|
| 新黑白R图标 | public/favicon.svg、public/favicon.ico、index.html、CanvasProjectMenu.jsx、ProjectLauncher.jsx、canvas.css、launcher.css。GitHub仍为原绿色图标和文本R。 |
| 保存恢复与并发写保护 | src/project-save-recovery.js；CanvasWorkbench.jsx和use-local-connection.js中的恢复接线；project-store-http.js取消检查；workbench_lifecycle.py的每次写入唯一临时文件及失败清理；project_store.py兼容清理旧/新临时命名。GitHub已有Windows短暂锁定重试，此处是额外差异，不应把已有修复重复申报。 |
| 当前页连接稳定性 | src/canvas-current-page.js请求/响应体超时、回执提交与心跳续租解耦、单回执在途保护；相应heartbeat测试。 |
| 通用画布工具修正 | 数组参数及元素/数量/去重校验；canvas_move_nodes批量移动和canvas_retry_save保存重试的前后端桥接。实现与3D工具在同文件中，需要按代码块拆分。 |
| 加载兼容保护 | src/canvas-migration.js的外置迁移逻辑，保留未识别扩展节点和对应连线，避免打开再保存时丢失；支持图片处理状态恢复。3D专用恢复接口不计入此项。 |
| 独立硬件监控 | hardware_metrics.py及test_hardware_metrics.py，CPU/RAM和NVIDIA整卡GPU利用率/显存采样缓存；local-connection和服务端指标接口接线。可拆出通用能力，3D专用服务状态单独保留。 |

上述各项的配套测试也尚未全部进入GitHub。精确原始差异在.cache/github-audit-20261107/；inventory.json为实际文件内容比对，已避免git diff把本地存在但未跟踪的远端新增文件误报为删除。

## 不应当作公开更新直接推送的内容

- 3D模块、模型运行环境、模型/贴图/项目素材，继续按用户要求留本地。
- 本地版本号1.0.6-local.20261107、机器路径、恢复备份和桌面.lnk/注册表设置。
- 本地RELEASE.md仍保留旧发行说明；这是旧分支文档差异，不是新功能，不能覆盖远端v1.0.6发行说明。

若后续上传，应从远端main整理“新图标与通用稳定性修复”的独立补丁，按代码块排除同文件中的3D实现；不能直接把当前整个目录提交。
