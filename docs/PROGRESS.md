1. 当前阶段：M3；分支 web；M0/M1/M2 已完成并分别标记 m0-done/m1-done/m2-done；唯一产品依据为本地网页端 PRD v2.0。
2. M0 已完成：旧部署归档、密钥不入库、唯一源码入口、schema v3、无控制台启动与优雅停止。
3. M1 已完成：磁盘项目、HTTP 存储、启动器、六种模板、素材 Range、锁/备份/冲突、回收站、导入导出、外部路径和 CLI；详见 docs/M1-REPORT.md。
4. M1 迁移：真实旧项目实际为 2 个（76/148 节点），均迁移成功；另有 3 个合成迁移测试，不冒称第三个真实项目。
5. M2 已完成：50 步撤销、AUTO-SAVE-1、持久化队列/SSE、超时与精准取消、manifest/联系表、安全反代、素材 GC、稳定 refTag、设置诊断通知。
6. M2 验收：85 项 Python 测试、全部前端/浏览器回归和构建通过；200 节点打开 240 ms、拖动 424 ms；详见 docs/M2-REPORT.md。
7. M2 边界：隔离仿真验证关页续跑和重启恢复；真实 GPU 5 分钟链路及原生 Windows 通知留待 M4 长跑验收，不冒称已测。
8. M3 下一入口：Character/Outfit/Location CRUD、Shot/Take、take 栈、审片对比、评级选用、搜索标签及画布互操作。
9. M4：Agent 协议 v2、短句柄、digest/query/apply/wait、语义工具、MCP resources、token 基准、全链路发布。
10. 每阶段实现→测试→DoD 自检→commit→tag→报告；不进入 M5，最终全量回归后 tag v1.0.0。
