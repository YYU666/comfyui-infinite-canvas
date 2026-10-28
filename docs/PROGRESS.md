1. 当前阶段：M4；分支 web；M0/M1/M2/M3 已完成并分别标记 m0-done/m1-done/m2-done/m3-done；唯一产品依据为本地网页端 PRD v2.0。
2. M0 已完成：旧部署归档、密钥不入库、唯一源码入口、schema v3、无控制台启动与优雅停止。
3. M1 已完成：磁盘项目、HTTP 存储、启动器、六种模板、素材 Range、锁/备份/冲突、回收站、导入导出、外部路径和 CLI；详见 docs/M1-REPORT.md。
4. M1 迁移：真实旧项目实际为 2 个（76/148 节点），均迁移成功；另有 3 个合成迁移测试，不冒称第三个真实项目。
5. M2 已完成：50 步撤销、AUTO-SAVE-1、持久化队列/SSE、超时与精准取消、manifest/联系表、安全反代、素材 GC、稳定 refTag、设置诊断通知。
6. M2 验收：85 项 Python 测试、全部前端/浏览器回归和构建通过；200 节点打开 240 ms、拖动 424 ms；详见 docs/M2-REPORT.md。
7. M3 已完成：三类创作库、Shot/Take、4 条审片对比、评级/选用/淘汰、搜索标签、画布互操作和输出延迟复制；详见 docs/M3-REPORT.md。
8. M3 验收：91 项 Python 测试及 M2/M3 前端回归通过；生成入 Take 使用隔离仿真 ComfyUI，未冒称真实 GPU 生成。
9. M4 下一入口：Agent 协议 v2、短句柄、digest/query/apply/wait、语义工具、MCP resources、token 基准、全链路发布。
10. 每阶段实现→测试→DoD 自检→commit→tag→报告；不进入 M5，最终全量回归后 tag v1.0.0。
