# 3D节点重开丢失修复 · 2026-11-04

Decision: accept。本地修复与当前侧栏交付已完成，未推送或发布。执行方式：现有CEO负责运行环境/恢复，gpt-6.1-sol限定实现迁移与中立恢复复查。Visual transport: zero-payload-local-analysis / modelVisibleImagesUsed 0；通过当前页可访问状态确认真实模型预览与已保存状态。

## 原因

桌面Refmuse画布快捷方式与refmuse-canvas启动协议仍指向旧安装副本。重新启动后的8790进程来自旧副本，实际提供index-CelH5Y28.js，开发目录当时为index-o6ByBEwE.js。旧客户端迁移函数删除不认识的节点类型并过滤悬空连线，自动保存使项目从revision575的71节点/27个native3d变为revision576的44节点/0个native3d；用户报告时为revision578。模型素材文件未删除。

## 修复与恢复

- 提取真实加载迁移到canvas-migration.js，保留native3d及未来未知类型、数据和端口。增加实际持久化→重开→再重开的回归。
- 增加只读同项目/同版本备份片段接口。canvas_recover_native3d只接收projectId与backupRevision，当前页读取片段、复核写入状态，仅添加缺失3D节点及相关连线；现有节点与编辑优先，不进行整项目回滚或重新生成。
- 独立保留恢复前revision578、完整revision575备份与旧快捷方式于.cache/native3d/reopen-recovery。
- 确认画布与Comfy队列空闲后关闭旧后端，从开发目录启动新版。桌面快捷方式与既有本用户启动协议改为当前开发目录，保留图标与正常启动浏览器行为；没有另开可写画布。
- 当前页恢复27个3D节点和30条连线；revision580为71节点、61条连线。核对全部原44节点data不变，27个恢复节点data与备份一致。
- 再次刷新当前侧栏，项目保持71节点、27个3D节点、61条连线；LOD0/LOD1真实缩略图、来源线和“已保存”可见。

## 验证与范围

迁移/恢复针对性测试、自动保存、画布历史、MCP队列、当前页传输测试通过；41项project_store/page_bridge Python测试通过；local-tools构建通过。worker复核恢复路径未发现阻断问题。验证回执在.cache/native3d/reopen-recovery/verification.json。

尚未发布到其他电脑，其他旧安装副本不会因此自动获得新类型保护。当前桌面入口已经修正。未来正式发布仍需统一部署与新旧版本兼容门；不要手动使用不认识3D的旧程序写入该实验项目。
