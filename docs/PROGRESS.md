1. 当前阶段：M1；分支 web；M0 已完成并标记 m0-done；唯一产品依据为本地网页端 PRD v2.0。
2. M0 已完成：旧部署移入 _archive，密钥备份到用户 .h3 且旧文件移除，启动入口指向唯一源码。
3. M0 已完成：schema v3/最小示例/校验器与负例；动态端口、instance.json、健康检查、优雅停止。
4. M0 验收：Python/Node 测试、构建、8791 回退、真实 VBS 连点 10 次（pythonw=1、cmd=0）均通过。
5. M1 后端已完成：20 组存储断言、崩溃恢复、HTTP CRUD/409/Range/导入导出和 h3wb list/new/validate 通过；下一步接启动器、HTTP project-store 与 IndexedDB 迁移。
6. M2：实现撤销重做、AUTO-SAVE-1 修复、持久化队列、导出、安全、素材回收、设置诊断与通知。
7. M3：实现 Character/Outfit/Location、Shot/Take、审片对比、评级选用、搜索标签及画布互操作。
8. M4：实现 Agent 协议 v2、短句柄、digest/query/apply/wait、语义工具、MCP resources 与 token 基准。
9. 已知风险：旧前端仍直连 ComfyUI，8791 只完成生命周期验证；M2 必须以反代移除端口/CORS 耦合。
10. 每阶段实现→测试→DoD 自检→commit→tag→报告；不进入 M5，最终全量回归后 tag v1.0.0。
