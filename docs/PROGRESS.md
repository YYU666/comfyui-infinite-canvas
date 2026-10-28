1. 当前阶段：M2；分支 web；M0/M1 已完成并分别标记 m0-done/m1-done；唯一产品依据为本地网页端 PRD v2.0。
2. M0 已完成：旧部署归档、密钥不入库、唯一源码入口、schema v3、无控制台启动与优雅停止。
3. M1 已完成：磁盘项目、HTTP 存储、启动器、六种模板、素材 Range、锁/备份/冲突、回收站、导入导出、外部路径和 CLI。
4. M1 迁移：真实旧项目实际为 2 个（76/148 节点），均迁移成功；另有 3 个合成迁移测试，不冒称第三个真实项目。
5. M1 验收：20 项存储、API/200 MB Range、三轮崩溃恢复、三次隔离 UI/100 项目、旧格式与构建全部通过；详见 docs/M1-REPORT.md。
6. M1 额外修复：Windows 端口复用会让测试写入正式服务；现禁止共享端口，并在 UI 写入前核验健康 PID 与隔离项目根。
7. M2：撤销重做 50 步、AUTO-SAVE-1、持久化后台队列/SSE、manifest/联系表、安全反代、素材 GC、稳定 refTag、设置诊断通知。
8. M3：Character/Outfit/Location、Shot/Take、审片对比、评级选用、搜索标签及画布互操作。
9. M4：Agent 协议 v2、短句柄、digest/query/apply/wait、语义工具、MCP resources、token 基准、全链路发布。
10. 每阶段实现→测试→DoD 自检→commit→tag→报告；不进入 M5，最终全量回归后 tag v1.0.0。
