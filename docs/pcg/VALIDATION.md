# PCG M2 验证状态与证据入口

日期：2026-11-17。M2基线`3962fbf3dfa1759755b487525c536d8e92c36048`；只覆盖自写几何、受限保存图执行和真实受管输出。当前为集成验收记录，最终接收、完整测试命令/日志、独立审查和PR/CI身份由主线程在外部`RECEIPT_M2.md`归档。本文件不将测试存在、接口说明或历史M1结果冒充本轮通过。

## 本文作者实际执行的本地检查

Windows隔离lane使用本机已有匹配标准库解释器运行`test_pcg_isolation`，6项全部通过（2026-11-17）。测试仅唯一自有AppContainer、临时运行时、合成私有文件和固定测试worker，不访问正式服务或用户素材。实际证据为：

| 门 | 观测 |
| --- | --- |
| OS身份 | TokenIsAppContainer=1，TokenCapabilities.count=0 |
| 文件 | 独立合成私有文件read/append/create均EACCES；代码write EACCES；自有temp可写 |
| 网络 | 文档保留地址socket connect被WinError10013拒绝 |
| 子进程 | 固定子进程创建被WinError367拒绝 |
| 环境 | 合成父进程sentinel不存在；仅9项allowlist键 |
| 内存 | 128MiB job下512MiB分配触发MemoryError |
| CPU | 原生job CPU配额在host墙钟到期前杀死busy fixture，退出0xC0000044 |
| 生命周期 | wall timeout、output overflow、取消仅终止自有job；后续独立job可成功 |

另实际调用固定生产worker `execute(b'{}')` 返回有界`INVALID_CONTRACT` JSON，证明受限解释器能加载当前白名单代码；这不是几何成功或完整图验收。隔离详细API/复现见`pcg/ISOLATION_API.md`。不支持平台的capability skip不是本机隔离通过证据；本机上述6项实际运行。

本次文档静态检查已通过：23个任务/原子表格行与registry顺序逐项一致；SBOM含41个唯一且实际存在的源/测试/文档路径；文内相对链接存在；外部DEV_STEPS与仓库副本逐字节一致；限定文档diff空白检查通过。这些检查不运行几何或正式服务。

## 主线程报告的本轮集成快照

主线程在本轮文档交接时报告：73项PCG测试通过；60个Node测试文件通过；本机8个真实受限run完成（4个seed、同seed重复、100实例、非预设组合图、局部修改）。实际样例及EVIDENCE.json留在本机，不上传样例资产。主线程还报告全量Python为603项，2项既有official-launch子进程导入因解释器 `_pth` 路径环境失败、5项跳过；该全量结果不是全绿，需保留原错误/基线对照。

上述为主线程报告的当前快照；最终重测和接收以其日志/回执为准。本文作者未独立重跑这些集成套件，不将汇总数字冒充独立审查。

## M2集成接收矩阵

| 测试入口 | 应覆盖内容 | 本文状态 |
| --- | --- | --- |
| test_pcg_geometry.py / test_pcg_fields.py | 四seed差异且重复一致、几何有效性、非固定原子组合、域/绑定失效、采样约束、预算 | 已报告PCG汇总通过；最终日志/重测见回执 |
| test_pcg_export.py | GLB独立二进制解码、Corner接缝/法线、实例共享原型、float32精度退化拒绝 | 已报告PCG汇总通过；最终日志/重测见回执 |
| test_pcg_graph.py | 保存依赖顺序、环/端口/缺输入、规范内容键、项目/宿主隔离、LRU | 已报告PCG汇总通过；最终日志/重测见回执 |
| test_pcg_m2_runtime.py | 真实受限DAG、下游dirty/缓存、真实导出/verify、取消/失败/过期/幂等、failclosed | 已报告PCG汇总通过；最终日志/重测见回执 |
| test_pcg_assets.py / test_pcg_preview.py | 原子发布/链接/哈希/任务归属、真实有界SVG | 已报告PCG汇总通过；最终日志/重测见回执 |
| test_pcg_contracts.py / test_pcg_runtime.py | M1描述/诊断兼容、严格schema、宿主权限与旧任务 | 已报告PCG汇总通过；最终日志/重测见回执 |
| test-pcg-frontend.mjs / test-pcg-preview.mjs | 25描述发现、工具完整回路、cancel/export、只读结果/旧响应/跨项目 | 已报告Node汇总通过；最终日志/重测见回执 |
| 项目Node全套/构建、相关Python旧功能回归、diff检查 | 无旧功能回归、构建完整、无空白错误 | Node已报告通过；Python保留上述2项环境失败；构建/最终diff见回执 |
| 独立review / PR CI / 包证据 | 安全与正确性独立检查、标准环境测试、打包文件闭包 | 由主线程按实际独立审查/PR/CI回执登记；本文不判定CI状态 |

本次文档更新只做文件/机器注册表一致性检查；上表集成数据注明主线程报告来源。CI状态以PR实际结果为准，本地通过不外推CI通过。M1旧快照曾有聚焦合同/任务/前端/预览与构建证据；完整Python当时存在既有解释器环境失败。历史结果不自动适用于M2，环境差异需主线程在本轮日志具体说明，不能修改旧测试掩盖。

## 安全及范围限制

- Windows AppContainer零能力提供实际文件/网络边界；资源job、进程分离、Python标志单独都不是沙箱。系统允许AppContainer访问的公共OS文件仍可读，不能声称外部所有文件不可读。
- 几何平台不可用时preflight拒绝、run保留failed；无普通进程fallback。协议1可信固定诊断与协议2几何严格区分。
- worker只收批准有界值、不读项目路径。宿主独占输出；完整handle、当前revision/run、输入/结果/文件hash共同核验。
- MCP只读counts/bounds/域/绑定/至多64抽样；GLB/JSON为真实资产，SVG只是最多1800图元的固定机位预览。
- M3game_asset桥/原资产质量门、原型碰撞约束、M4实时展示、M5正式画布/发布未开始；没有正式实例/UI验收声明。
- 本轮不安装、下载、启停服务、上传样例、合并、tag、Release或部署。只在本地临时夹具验证，主线程验收后才开叠加PR。

## 主线程最终本地接收（推送前）

默认编码与 UTF-8 各自完整运行 `test_pcg_*.py`：79项，78通过，1项符号链接权限夹具跳过。原生隔离7项实际执行，包括异常退出37后新任务成功；几何真实并发上限1、排队取消/关闭均通过。`npm run test:node` 60个文件通过，前端构建与未签名包证据校验通过；没有部署测试包。

8个真实合成run产生不同且确定性的四seed网格、100个共享原型实例与非预设图的末端局部重算。静态图检查记录在本机样例目录，未将样例提交Git。独立审查见 [M2_REVIEW.md](M2_REVIEW.md)：圆柱UV问题及新增测试断言位置错误均已修正复验，无未关闭P0/P1/P2。较早全量Python快照603项仅2个已记录的基线解释器路径失败、5跳过；未篡改旧断言。最终CI须在新PR推送后另行核验，此处不预先宣称CI通过。
