# Refmuse 本地工作台开源版本整改清单

- 日期：2026-10-29
- 基线：`web` / `909be8b7b773d64aa7f004a4117188167938c260` / 本地 `v1.0.0`
- 依据：[深度审计](audits/2026-10-29-deep-audit.md)与第二份外部审计《H3工作台 v1.0.0 审计报告（2026-10-29）》；外部原件路径不进入公开文档
- 目标：不仅“源码可见”，还要达到可合法使用、可独立安装、可复现验收、可持续维护的开源发布水平。
- 当前状态：公开候选版的必修代码项已完成，并在由 `git archive HEAD` 加当前修复组成的干净源码快照中通过两种编码各 160 项 Python 测试、17 个 Node 文件、6 个隔离浏览器／后端文件及生产构建。8 小时长跑、远程 CI 实跑和远程公开发布仍未完成，边界保留下列勾选状态。

## 1. 发布门禁

### G0：公开源码前必须关闭

数据覆盖、目录逃逸、活动任务中断、跨项目写入、核心 Agent 入口必现故障，以及代码／模型授权不清。任一项未关闭，不公开仓库。

### G1：标记稳定开源版本前必须完成

安装可复现、CI、干净环境安装、真实 Agent 队列链路、发布文档、社区文件和规模验证。可以建立公开预览版，但不得把未完成项写成稳定版已验收。

### G2：不阻断首次开源的改进

包体积、额外性能优化、英文文档、进一步 UI 打磨等。必须进入 backlog，不得与 G0/G1 混在一起拖延安全修复。

## 2. 数据安全与运行生命周期

### [x] SAFE-01｜G0｜修复 ZIP 导入目录逃逸（A01）

- 位置：`project_store.py`、`project_api.py`。
- 修改：同时识别 POSIX、Windows 盘符绝对／相对路径、UNC、特殊路径和 `..`；对每个最终落点 `resolve` 后验证仍位于解压根内；校验失败不写任何成员。
- 验收：正常相对路径可导入；盘符绝对、盘符相对、UNC、混合分隔符和目录逃逸全部拒绝；目录外哨兵字节完全不变；合法项目迁移不回归。

### [x] SAFE-02｜G0｜模型安装不得覆盖或先删旧文件（A02）

- 位置：`scripts/install_models.py`。
- 修改：目标已存在但校验不一致时返回明确冲突；新文件先写同目录临时文件，完整校验后以不覆盖方式发布；硬链接失败不得删除旧文件。
- 验收：复制冲突、跨盘失败、权限不足、磁盘不足和中断注入后，旧文件内容及路径保持不变；真实模型目录不参与故障测试。

### [x] SAFE-03｜G0｜停止工作台不得中断活动 ComfyUI（A03）

- 位置：`video_workbench_launcher.py`、`workbench_queue.py`、`stop.py`。
- 修改：区分工作台服务与自有 ComfyUI 生命周期；停止前读取真实队列；有活动任务或队列状态未知时保留 ComfyUI，并给出明确结果；不得把查询失败当作空队列。
- 验收：自有 ComfyUI 运行／排队、其他客户端任务、查询失败和空闲四种状态分别验证；非目标任务不被 terminate/kill。

### [x] LIFE-01｜G0｜统一上传、提交和取消的 attempt 语义（A04、A05）

- 位置：`src/CanvasWorkbench.jsx`、`src/workbench-api.js`、`workbench_queue.py`。
- 修改：每次运行生成独立 attempt/cancellation token；上传 await 后检查取消；无目标 ID 时禁止全局 interrupt；提交返回后始终登记 prompt ID，并补偿执行已请求的取消；旧 attempt 不得污染重试。
- 验收：上传前、上传中、提交中、提交后、取消后立即重试均有测试；取消后无失联 prompt、无重复提交、无继续入队，其他任务不受影响。

### [x] LIFE-02｜G0｜撤销／重做恢复一致的素材身份（A06）

- 位置：`src/CanvasWorkbench.jsx`、`src/canvas-history.js`。
- 修改：以不可变 `assetPath/mediaStorageId` 作为文件缓存身份；历史恢复时同步恢复或失效缓存；提交前断言节点显示资产与实际上传资产一致。
- 验收：“替换 A→B→撤销→生成”上传 A；“撤销→重做→生成”上传 B；以实际上传字节和资产哈希断言，不只看节点标题。

### [x] LIFE-03｜G0｜离开页面前建立完整保存屏障（A07）

- 位置：`src/CanvasWorkbench.jsx`、`src/auto-save.js`。
- 修改：切换项目／返回启动器／卸载前冻结新写入，等待全部媒体 Promise 和节点引用更新，再重新采样画布并 flush；失败保留当前页面和 dirty 状态。
- 验收：慢上传、连续替换、上传失败、无 dirty snapshot、切换项目和返回启动器场景均覆盖；重开磁盘项目后资产引用一致。

### [x] LIFE-04｜G0｜Agent 写操作改为可恢复事务／outbox（A08）

- 位置：`agent_protocol.py`、`project_store.py`、`workbench_queue.py`。
- 修改：先持久化 pending intent，逐步记录业务变更和队列副作用，全部完成后才写成功回执；相同 `opId` 重放 pending 时恢复执行，不得直接返回假成功。
- 验收：在每个持久化边界注入进程退出；恢复后任务恰好提交一次，业务变更、job ID 和回执一致；普通异常与 SystemExit 都覆盖。

### [x] LOCK-01｜G0｜补齐项目关闭、锁释放和服务端只读（B2、P2-9）

- 位置：`project_store.py`、`project_api.py`、`video_workbench_launcher.py`、前端项目切换。
- 修改：新增关闭项目和释放自有锁入口；返回启动器／切换项目时关闭旧项目；写接口在服务端强制只读；设置切换项目根前显式关闭项目；仅清理确认过期或不属于活进程的锁。
- 验收：打开并保存项目后无需重启即可切换项目根；只读页面、CLI 和 Agent 写请求都被拒绝；第二个会话不会因已关闭项目的残留锁被阻塞；不得误删其他活实例锁。
- 边界：OS 级跨进程排他锁可在正式支持多实例前单列改进，不把当前单实例入口夸大为必然双写。

## 3. Agent、队列与 Take 一致性

### [x] AGENT-01｜G0｜CLI／MCP 全流程固定 UTF-8（A11、B1、P2-1、P2-7）

- 位置：`agent_mcp.py`、`agent_cli.py`、`h3wb.py`、相关测试。
- 修改：入口显式重配 stdin/stdout/stderr 为 UTF-8，或使用 buffer 按 UTF-8 读写；MCP stdout 只输出协议消息；诊断输出走 stderr。
- 验收：Windows 默认 GBK 环境下，中文、emoji、非 ASCII 入参的 CLI/MCP initialize/list/call 全部通过；不再依赖 `PYTHONUTF8` 或 `PYTHONIOENCODING`；修复后发布测试数与实际结果一致。

### [x] AGENT-02｜G1｜WebMCP 以 queueJobId 判断提交成功（A12）

- 位置：`src/canvas-mcp.js`、`src/CanvasWorkbench.jsx`、`workbench_queue.py`。
- 修改：入队成功即返回 queueJobId；无 promptId 的正常排队不报错；`wait=false` 不等待 GPU 分配 promptId；`wait=true` 在同一用户超时预算内跟踪终态。
- 验收：队列暂停、GPU 忙、排队超过 30 秒、任务失败和正常完成分别测试；不得出现“接口报失败但后台仍执行”的状态分裂。

### [x] AGENT-03｜G0｜wait 和归档强制验证项目／镜头归属（A13）

- 位置：`agent_protocol.py`、`agent_api.py`。
- 修改：等待、写 Take、更新节点前同时验证 `projectId/shotId/nodeId/jobId` 关联；不匹配时零写入并返回明确冲突。
- 验收：两个项目存在相同局部镜头 ID 时，对 B 调用 wait(A-job) 被拒绝；A/B 的 Take、节点、revision 均不被错误修改。

### [x] TAKE-01｜G0｜按 attempt＋输出身份幂等归档（A09、A10、P1-2）

- 位置：`agent_protocol.py`、`project_domain.py`、`src/generation-queue.js`、`src/CanvasWorkbench.jsx`、`delivery_export.py`。
- 修改：后端按 `project/shot/job/attempt/output` 建立唯一身份；多输出支持逐输出补齐或事务提交；前端刷新后用持久化状态去重。
- 修改：删除不存在的 `assets/agent-...` 假路径。遵循“默认引用 ComfyUI 输出、导出时复制”的既定决策，Take 应显式保存 external 引用；若改为项目资产，必须真实写入并登记哈希。
- 验收：连续刷新／SSE 重连 10 次 Take 数不变；第 1/N 条写入后逐点中断可补齐且每条恰好一次；节点状态最终一致；ComfyUI 原输出被清理时的预览／导出行为与文档一致。

### [x] TAKE-02｜G1｜dryRun 覆盖 generate 预检（P2-8）

- 位置：`agent_protocol.py`、`agent_workflow.py`。
- 修改：dryRun 校验模型、参考资产、参数、工作流构建和项目／镜头关联，但不提交队列、不写成功回执、不创建 Take。
- 验收：真实 apply 会暴露的输入错误在 dryRun 阶段返回；合法 dryRun 无副作用；revision 和队列内容保持不变。

### [x] WF-01｜G1｜前后端工作流增加共享合同测试

- 位置：`src/workbench-api.js`、`agent_workflow.py`。
- 修改：对共享的 H3 文生视频和图片参考视频模式固定输入／输出合同；校验节点类型、模型文件名、参数映射、参考顺序和输出身份；各自特有模式明确列入支持矩阵。
- 验收：同一配方前后端生成的语义参数一致；变更任一端时合同测试能发现偏差；不要求一次性把所有专用画布工作流迁移到 Agent。

## 4. 本机安全与长期运行

### [x] SEC-01｜G0｜收紧 instance.json 令牌权限（P1-3）

- 位置：`workbench_lifecycle.py` 或实际 instance 写入处，复用现有 key ACL 逻辑。
- 修改：创建／更新 instance 后移除无关继承读取权限，仅保留当前用户及必要系统账户；不得影响同机当前用户的 CLI/MCP 读取。
- 验收：ACL 中无 `CodexSandboxUsers` 等无关组读取权限；当前用户 CLI/MCP 正常；服务重启后权限仍正确；令牌值不进入日志和测试报告。

### [x] OPS-01｜G1｜日志轮转与脱敏保留策略（P1-4）

- 位置：`video_workbench_launcher.py` 及自有 ComfyUI 日志配置。
- 修改：应用日志采用大小轮转（建议 10 MB×5），明确保留上限；请求日志不得记录 token、密钥和个人素材内容；自有 ComfyUI 日志采用同等策略。
- 验收：持续写入超过上限后文件数量和总大小受限；旧日志按策略清理；诊断包仍可用且不泄露凭据。
- 证据：新增统一轮转与脱敏格式器；应用和自有 ComfyUI 均为 10 MB＋5 备份，旧时间戳日志只保留最新五份，请求日志不再包含 URL。自有 ComfyUI stdout 改由独立日志进程持续读取；保留 ComfyUI 时工作台父进程退出不会关闭读取端，停止自有 ComfyUI 后日志进程按 EOF 或超时退出。真实合成子进程测试覆盖父进程退出后的继续写入，另有容量、轮出、管道排空和密钥脱敏回归。

## 5. 安装、路径与供应链

### [x] INST-01｜G1｜禁止系统 Python 回退并锁定依赖（P1-1）

- 位置：`install.bat`、`install.py`、`requirements.txt`、第三方节点安装配置。
- 修改：找不到 ComfyUI 便携版 Python 时直接报错，不回退 `py -3` 或系统 Python；`install.py` 同样遵守；第三方节点固定 repo＋commit；Python 依赖生成锁定／哈希约束。
- 验收：错误路径下安装零修改、零系统 pip 写入；全新安装得到经过验证的节点 commit 和 Python 依赖组合；锁文件更新有单独审查记录。
- 证据：从 `git archive HEAD` 生成干净源码，在独立便携布局 shim 和隔离虚拟环境中完成真实在线安装；`requirements.lock` 的 10 个锁定包全部安装，`pip check` 无损坏依赖。六个第三方节点均从 GitHub 拉取并逐一匹配安装器锁定 commit，KJNodes 依赖安装成功；`npm ci` 和前端构建通过。未修改真实便携版 Python、节点或模型。

### [x] INST-02｜G1｜去除本机路径假设并修正版本说明（P2-2、P2-3）

- 位置：`启动.vbs`、`启动.bat`、`start.bat`、`停止.bat`、`h3wb.bat`、`video_workbench_launcher.py`、`workbench_settings.py`、README／AGENTS。
- 修改：优先相对定位便携版；找不到时通过明确配置或错误提示解决；数据目录不得依赖必然存在的 D 盘，首次启动可选择大容量且可写的位置；不自动迁移旧数据。
- 修改：Node.js 要求改为与 Vite 7 匹配的 20.19+；ComfyUI 最低版本按实际工作流节点重新验证，不能只引用 H3 Relay 的 0.37+；安装完成提示统一为 `启动.vbs`。
- 验收：无 D 盘、非 C 盘 ComfyUI、仓库路径含空格／中文三类环境可安装启动；旧项目路径配置保持不变；README、AGENTS、脚本提示一致。
- 证据：中文空格路径使用同一干净安装启动成功，健康接口 PID 与隔离项目根均核对；模拟仅一个固定盘且不存在 `D:/H3_Workbench` 时启动成功，并实际在模拟固定盘创建 `H3_Workbench`；通过 `subst` 映射 Q: 后从 `Q:/video-workbench` 启动成功，结束后移除映射。两次路径模拟均不等同于物理磁盘移除或第二块物理盘验证；默认路径、旧数据保留和磁盘选择另有隔离单元测试。所有临时实例均优雅停止，未重启用户自有 ComfyUI。

### [x] INST-03｜G1｜模型来源、哈希和最小安装配置

- 位置：`models/manifest.json`、`models/SOURCES.md`、`models/README.md`、`scripts/verify_workbench.py`。
- 修改：优先官方来源，逐项补充可用来源与 SHA256；Muse V3.0 FP8 未解决前不得列入“完整可下载保证”；拆分核心运行模型与完整 33 文件可选配置。
- 验收：新用户不持有作者本机权重时，可按文档得到明确可用的核心配置；完整配置逐项显示已核实／待核实；错误版本和损坏文件能被哈希校验拒绝。
- 证据：`core-h3` 七项、71.164 GiB 已全部核对 Comfy-Org 官方路径、字节数与 LFS SHA256；完整清单共登记 15 项官方 SHA256，其余 18 项明确为待核实。安装器与校验器均支持 profile，临时小文件测试覆盖同尺寸损坏拒绝和核心配置不依赖可选文件；当前干净源码全量后端 160 项测试通过。未读取或哈希用户真实模型。

## 6. 开源合规与社区工程

### [x] OSS-01｜G0｜确定代码许可证和第三方声明

- 位置：新增 `LICENSE`、`NOTICE` 或等价文件；更新 `package.json`、README。
- 修改：由项目负责人确认许可证（可评估 Apache-2.0），填写真实版权主体／年份；`package.json` 增加 license 并处理 `private:true`；列出直接捆绑的第三方代码／资产。
- 验收：GitHub 能识别许可证；代码许可证明确不覆盖 ComfyUI、第三方节点、模型、LoRA 和用户素材；没有未经授权复制的参考网站图片、商标或私有素材。
- 证据：根目录采用 Apache-2.0 标准全文，版权主体为 `Refmuse Local Workbench contributors`；`package.json` 与锁文件均声明 Apache-2.0 且移除 `private`。直接 import H3 Relay GPL toolkit 的 `comfy-nodes/h3_workbench_refine` 作为目录级例外单独采用 GPL-3.0-only，附完整 LICENSE 与 NOTICE；根 NOTICE、README 和贡献指南均明确该边界。其他第三方节点另列 `THIRD_PARTY_NOTICES.md`，模型、素材与输出不被重新许可。

### [x] OSS-02｜G0｜补齐模型／LoRA／节点许可证矩阵

- 位置：新增 `models/LICENSES.md` 或等价文档，链接 `models/SOURCES.md` 与安装文档。
- 修改：逐项记录作者、官方页面、许可证、商用条件、再分发条件、未知项；第三方 ComfyUI 节点同样记录来源和许可证。
- 验收：不再用一句“许可证各自独立”代替实际清单；未知许可证明确禁止据此推定可再分发；仓库仍不包含模型权重。
- 证据：`models/licenses.json` 与 33 项 manifest 精确一一对应，记录作者、官方页、许可文本入口、商用／再分发状态、限制和核查日期；`models/LICENSES.md` 展开 H3、Krea 2、Qwen Research、Identity Edit V2 与 Civitai 单项条件。`third_party/nodes.json` 与安装器六个仓库＋commit 一致。`test_license_inventory.py` 强制无遗漏、无重复、字段完整、未知项不得暗中放宽；本批 16 项许可证／清单／安装回归通过。

### [x] OSS-03｜G1｜建立可重复的 CI 与统一测试入口

- 位置：新增 `.github/workflows/`；更新 `package.json`、浏览器测试启动方式。
- 修改：提供统一 Python／Node 测试命令；CI 至少覆盖 Windows 默认编码、UTF-8、Python 后端、前端构建和隔离浏览器回归；浏览器路径统一用 Playwright 托管浏览器或 `CHROME_PATH`，删除对单机 Chrome 路径的依赖。
- 验收：新 clone 无需作者本机目录即可运行 CI 同等命令；默认编码测试也全部通过；G0 故障注入测试进入 CI；构建产物写入 CI 临时目录。
- 证据：新增 `npm run test:all`、独立 `test:python`／`test:node`／`test:browser` 和 GitHub Actions Windows 工作流。全部浏览器测试改用 `test-browser.mjs` 的托管 Chromium／`CHROME_PATH`，隔离后端默认使用 PATH Python 或 `H3_TEST_PYTHON`，不再依赖作者本机固定路径；`H3_WORKBENCH_DIST_DIR` 支持 CI 临时构建目录。在由 `git archive HEAD` 加当前修复 diff 组成的干净源码快照中，默认编码与 UTF-8 各 160 项、17 个 Node 文件、6 个隔离浏览器／后端文件均通过；200 节点打开 228 ms、拖拽 415 ms，队列关闭浏览器后完成且重启未重复提交。远程 GitHub Actions 未实跑，不记为 CI 通过。

### [x] OSS-04｜G1｜补齐贡献、安全和项目说明文件

- 位置：新增 `CONTRIBUTING.md`、`SECURITY.md`、Issue／PR 模板；按需添加 `CODE_OF_CONDUCT.md`。
- 修改：写清开发环境、测试要求、提交范围、数据／模型禁止入库、漏洞私下报告渠道、功能支持矩阵和已知限制；README 添加自有截图或演示素材。
- 验收：外部贡献者能判断如何安装、测试、报告问题和提交 PR；安全报告不需要公开粘贴令牌或私人素材；英文说明可作为后续增强，不阻断首次开源。
- 证据：贡献指南包含环境、统一测试、故障注入、提交范围、禁止入库内容与许可证要求；安全政策使用 GitHub Private Vulnerability Reporting，不伪造维护者邮箱；缺陷／功能 Issue 表单、联系链接和 PR 模板要求脱敏、实测与未执行项。README 增加候选版状态、七项功能支持矩阵及已知限制。`scripts/capture_docs_screenshot.mjs` 在临时后端与项目中仅创建合成节点，生成并人工查看 `docs/images/workbench-overview.png`（1600×1000，105695 字节）；没有读取真实画布、用户素材或参考网站资产。

## 7. 验收与发布

### [x] QA-01｜G1｜全量回归必须包含新增故障注入

- 内容：全部 Python、Node、浏览器、Agent 预算、安全探针和构建；新增 SAFE/LIFE/LOCK/AGENT/TAKE 测试必须进入统一命令。
- 验收：默认 Windows 编码与 UTF-8 均通过；无 `95/96` 被环境变量掩盖；构建前真实 ComfyUI 队列为空；测试不读写真实用户项目和权重。
- 证据：构建前真实 `/queue` 返回运行 0、排队 0。在不含本地项目、模型、日志或审计附件的干净源码快照中，默认编码与 UTF-8 各 160 项后端测试通过，17 个 Node 文件、6 个浏览器／后端文件及前端构建通过。`workbench_lifecycle.py` 与 `workbench_settings.py` 的 `icacls` 输出固定按 Windows `mbcs` 解码，两个 PYTHONUTF8=1 回归测试防止本地化输出再次触发后台 `UnicodeDecodeError`；重跑未再出现该异常。遗留 `test-canvas-clipboard-ui.mjs` 已从旧 IndexedDB 启动方式迁移到临时后端与 HTTP 项目存储，并加入统一浏览器套件；复制、粘贴、图片字节持久化及刷新恢复均通过。

### [x] QA-02｜G1｜补真实 Agent 队列全链路和运行版本检查（B3）

- 已完成边界：另一审计仅证明直接提交 H3 工作流的 480P/5s GPU 冒烟成功，不等于 app 队列链路通过。
- 修改／验收：在临时项目中执行 `shot.create → generate → app queue → wait → Take → take.select → delivery.export`；记录真实耗时、输出规格和 Take／导出身份。
- 修改／验收：发布前确认真实队列为空，再重启工作台；检查健康 PID、startedAt／版本和 Agent API，确保新进程加载当前代码；不得重启有任务的 ComfyUI。
- 文档：分别写“直接 GPU 工作流”“仿真 Agent 全链路”“真实 Agent 队列全链路”，不得混称。
- 证据：真实队列空闲后仅重启工作台，健康信息由 PID 83028／`2026-10-29T00:29:44Z` 更新为 PID 49704／`2026-10-29T05:25:30.143420+00:00`，ComfyUI 保持用户自有进程且未重启。临时项目 `prj_d4a4b99371eb48d7844e63a935cb8fe0` 依次完成 `shot.create(s1/g1)`、`generate(job_2013a61e7e55445592bc88c551fb1c62)`、app queue、`wait(done)`、自动 `Take(t1)`、`take.select` 与 `delivery.export`。提交时间 `05:26:34Z`，Take 完成 `05:32:06.988017Z`，约 5 分 33 秒归档（从提交到首次完成观测约 5 分 46 秒）。真实输出 prompt ID `7f977be8-4e5d-47b6-9822-a4512c80b60d`，attempt 1，832×480、124 帧、5.165 秒、约 24.0077 fps；导出 `S01/S01_T01.mp4` 为 945474 字节，SHA256 `310b8039124fadd70d18ede5e184760bde7a1b252209f8f13ea13bbf5b6e767a`，与 manifest 完全一致。最终 app 与 ComfyUI 队列均为 0。该结果属于真实 Agent 队列全链路，不与此前直接 GPU 冒烟或仿真 Agent 测试混称。

### [ ] QA-03｜G1（稳定版）｜规模、性能和长跑

- 内容：100 项目、50 GB 合成素材、8 小时运行；记录项目列表 p95、保存 p95、内存／句柄峰值、queue.json 增长、revision 增长、恢复时间和孤儿素材行为。
- 验收：无泄漏、崩溃、重复提交和重复 Take；服务重启后恢复一致；真实用户数据不参与压力清理；200 节点短测不能替代此项。
- 发布策略：若暂未完成，只能明确标为预览／候选版，不得宣称稳定性矩阵已通过。
- 当前证据：新增 `scripts/qa_soak.py`，短测覆盖上传、保存、孤儿清理和重启恢复。正式第一次在第 64 个项目建立 TCP 连接时超时，保留失败报告并从头重跑；第二次完成 100 项目、53,687,091,200 字节合成素材后，运行 37 轮、2205.532 秒由用户要求暂停。列表 p95 705.896 ms、保存 p95 85.922 ms；RSS 峰值 43,606,016 字节，结束 42,364,928 字节；句柄始终 353；queue.json 始终 55 字节；revision 从 300 到 486，与一次孤儿清理加 185 次保存一致。引用素材未被误删。未达到 4 小时重启点，也没有完整 8 小时结果，故保留未勾选；暂停数据保留在隔离 `.qa-soak/`。

### [x] REL-01｜G1｜更新发布证据并使用新版本号

- 位置：`RELEASE.md`、`docs/PROGRESS.md`、M 系列报告、必要的变更记录。
- 修改：修复默认编码后更新测试结论；记录真实与仿真边界、干净安装、CI 和长跑结果；保留旧 `v1.0.0` 标签，不移动或改写历史；修复完成后使用新 tag（如 `v1.0.1` 或候选版）。
- 验收：报告中的每个数字均可由当前命令复现；未执行项明确写未执行；没有“测试通过”但条件被隐藏的表述。
- 证据：`RELEASE.md` 和 `docs/PROGRESS.md` 已更新全量回归、真实 Agent、干净安装及暂停长跑数字；应用、npm 与锁文件版本统一为 `1.0.1-rc.1`。版本一致性复核及默认编码／UTF-8 各 160 项、17 个 Node 文件和构建重新通过；本地候选 tag 为 `v1.0.1-rc.1`，旧 `v1.0.0` 未移动。

### [ ] REL-02｜G1｜最后同步远程并公开

- 当前远程：Private；只有旧 `main`（`be769ac`），无远程 tag；旧 main 是本地 HEAD 祖先，可正常快进，无需强推。
- 顺序：G0 全部关闭 → G1 验收 → 推送 main → 推送新 tag → 创建 GitHub Release → 核对源码包 → 最后改为 Public。
- 验收：远程默认分支、Release、tag 和 README 指向同一版本；使用 Git 发布，不上传包含本机忽略图片／日志的整个工作目录 ZIP。

## 8. 不阻断开源的后续项（G2）

- [ ] 拆分单 chunk，消除构建体积警告；当前不是功能故障。
- [ ] 继续观察高 revision 项目的全量 runtime snapshot 成本，纳入 QA-03 数据后再决定是否改存储格式。
- [ ] 正式支持多后端实例前，将跨进程锁升级为 OS 级排他机制。
- [ ] 英文 README、更多截图／演示和 UI 细节优化。
- [ ] 111 GB 重复模型属于本机磁盘整理，不是开源代码缺陷；不得为发布擅自删除、移动用户模型，本清单不安排清理。

## 9. 审计项合并索引

- `A11 = B1`，并同时关闭 `P2-1/P2-7`：UTF-8 与发布测试数。
- `B2 + P2-9`：项目关闭、锁释放、只读和死锁清理。
- `A09 + A10 + P1-2`：Take 去重、多输出恢复和真实资产／external 引用一起设计。
- `B3`：运行版本检查与真实 app 队列验收，不是单一代码 bug。
- `P1-1`：系统 Python、节点 commit 和 Python 依赖统一归入 INST-01。
- `P2-2/P2-3`：脚本提示和版本前提统一归入 INST-02。
- `P2-4`：chunk 警告归入 G2。
- `P2-5`：重复模型只记录，不执行用户磁盘清理。
- `P2-6`：高 revision 成本纳入 QA-03。
- `P2-8`：dryRun 单列 TAKE-02。

## 10. 推荐实施批次

1. **安全批次**：SAFE-01～03、SEC-01。
2. **生命周期批次**：LIFE-01～04、LOCK-01。
3. **Agent／Take 批次**：AGENT-01～03、TAKE-01～02、WF-01。
4. **开源与安装批次**：INST-01～03、OSS-01～04、OPS-01。
5. **发布批次**：QA-01～03、REL-01～02。

每批均应“实现 → 故障注入／回归 → 更新证据 → 独立提交”，不得为了赶发布把多个未验证状态合并成一次“全部修复”。
