# PCG M2 合同速查

机器权威为 `pcg/registry.json`，严格校验在 `pcg_contracts.py`、`pcg_fields.py`、`pcg_geometry.py`。宿主 API 见 [API.md](../../pcg/API.md)，参数/原子操作见 [ENGINE_API.md](../../pcg/ENGINE_API.md)，Agent 闭环见 [AGENT_GUIDE.md](AGENT_GUIDE.md)。几何实现与 M1 元数据合同分别保留；通过元数据检查不等于生成真实几何或通过 M3 质量门。

## 描述与保存图

NodeDescriptor v1 保持 namespace=`refmuse.pcg`、descriptorVersion=1、operationVersion=1、pluginVersion=1.0.0。25项描述包括2项旧合同、5个任务入口、18个原子操作。四个可运行任务入口为 shape/rock/scatter/compose；game_asset 为 M3_BRIDGE_UNAVAILABLE，旧 geometry_stub 为 EXECUTOR_UNAVAILABLE。可发现与可运行分开；geometry ready 仍须本机隔离通过。

每项字段为 id、descriptorVersion、pluginVersion、operationVersion、label、category、parameters、inputs、outputs、budget、permissions、readiness、examples、errors，可选 description。未知字段拒绝。permissions 只能空数组，不授予网络、路径、脚本或动态加载能力。参数 schema 支持有界 finite number/integer、boolean、string、enum、封闭 object、有界 typed array 和默认值；不接受未知参数/关键词。端口类型可为已知类型字符串或已知类型列表；Geometry=Mesh|PointSet|InstanceSet。

M2 descriptor budget 上限为 timeoutMs=30000、maxInputBytes=32MiB、maxOutputBytes=64MiB、maxItems=100000；当前几何描述输出预算为32MiB，运行时为包含中间记录的协议2信封允许64MiB。底层单值 canonical JSON 最多32MiB。旧诊断仍为5秒/1MiB输入/64KiB输出/1024项。HTTP POST JSON最大64KiB，API只收身份/导出选项，不收完整图或几何数组。

节点保存为 type=pcg，data 含 descriptorId/descriptorVersion/operationVersion/parameters。边 sourceHandle/targetHandle 使用真实输出/输入端口名；可选 data.pcgType 必须相容。预检/运行读取准确 projectId/revision 的保存图，从目标遍历依赖，拒绝环、缺少/重复输入、未知端口、类型不兼容、不可用执行器。依赖子图最多256节点/32MiB。执行不改 project.json/revision；页面仍是唯一保存者。

## 协议2：受限内存几何

所有值 contractVersion=1、有限数值、米制/右手/Y-up；没有路径、外部引用或执行字符串。

| type | 闭合数据结构与约束 |
| --- | --- |
| Mesh | positions:vector3[]；triangles:integer3[] 合法索引、非零面积；normals:vector3[]、uvs:vector2[] 为空或精确 Corner 数（每三角形3项）；60000顶点、100000三角形上限 |
| PointSet | positions:vector3[]，最多10000点 |
| InstanceSet | prototype:Mesh；instances=[{id,translation:vector3,rotation:quaternionXYZW,scale:vector3}]，最多10000项、ID唯一、单位四元数、非零scale；保留共享原型 |
| Field | binding:{contentHash,topologyHash}、domain、valueType、values；精确对应实际源域计数 |
| Selection | 同 Field，但 type=Selection、valueType=boolean |
| Image | width/height=1..1024；pixels:RGB vector3[]，精确像素数、各通道[0,1]，最多1048576像素；仅受管内存数据 |
| DiagnosticReport | 固定有界统计，不接受任意结构充当几何 |

Field/Selection 的 binding 是规范完整内容与拓扑的 SHA256，域为 Point/Face/Corner/Instance/Detail；值类型 float/integer/boolean/vector3。绑定/域须完全匹配；valueType按操作显式检查，field_math允许数值标量与vector3逐分量广播，内容或拓扑变化使旧绑定失效，不能按同名属性猜测继承。位置位移是 Point vector3；角法线和 UV 采样保持 Corner，导出时拆分索引保留接缝。实例变换限制均匀父缩放以避免丢失剪切；实体化必须显式调用 realize_instances，预先核对展开预算。

shape/rock/scatter/compose 配方使用与18原子相同的 evaluate(operation,parameters,inputs)，不引入第二套实现。rock 为 sphere→noise_field→set_position→recompute_normals。scatter_points 按三角形面积采样，以+Y坡度、Y高度、欧氏 minDistance 过滤，尝试次数有界；无法放满返回 INSUFFICIENT_PLACEMENT，不返回伪成功。sample_texture 默认显式1×1常量色，不读取图片路径。原型碰撞包围体约束后移。

## 协议1：保留的 M1 合同

GeometryArtifact/InstanceSet 元数据仍带 project/artifact/sha256/topology、米制右手Y-up、bounds、producer、provenance、metadata，以及 Point/Face/Corner 计数或稳定实例ID和row-major4×4矩阵。旧资产路径为受管 `assets/<sha256>.pcg.json`，artifactId=`pcg_<sha256>`；封闭容器 `{contractVersion:1,format,payload}`。broker 仅允许同项目注册普通单链接文件并校验哈希；拒绝绝对路径/URL/UNC、穿越、reparse/链接、硬链接和跨项目。旧 quality.state 保持 diagnostic-only，不能伪造 accepted。

旧 Attribute/Selection 使用 geometry:{artifactId,sha256,topologyId} 与域/类型/values，最多1024项；旧 Field 为1..64节点的类型 DAG（constant/attribute/add/multiply），按拓扑顺序引用更早节点，无自由表达式。协议1描述与协议2求值值不能混用；旧诊断进程不是几何隔离边界。

## 任务身份、缓存与取消

请求精确六字段 `{projectId,nodeId,revision,descriptorVersion,operationVersion,runId}`；handle 再含 `{jobId,inputHash}`，合计八字段。相同 projectId/runId 只对完全相同身份/输入幂等；变化报 IDEMPOTENCY_CONFLICT。任务状态 queued/running/succeeded/failed/cancelled。wait 每次0..20000ms。不同revision或同节点更新run令旧handle stale：可读，不能verify/export/cancel或覆盖新输出。错误/节点保留，宿主生命周期内最多256任务、4个任务准入、1个几何执行、最终完整值64MiB；页面可 list_tasks 恢复，宿主重启后无持久任务承诺。

纯计算缓存键含操作/版本、规范参数、显式完整输入、Field绑定；不含项目revision。缓存按项目和宿主隔离，32MiB/256条LRU，读写复制。preflight 返回 executionOrder/dirtyNodes/cacheHits 预测，实际 report 返回 computedNodes/cacheHits、节点elapsedMs/outputBytes和总elapsedMs。断开分支不求值，修改下游不会使无关内容键失效。

取消只设置本任务标志并终止其拥有的OS JobObject。关闭宿主清理自身任务；不按进程名/端口终止其他程序。失败、取消、过期任务不发布为新结果。

## 受管输出与核验

仅宿主写 `outputs/pcg/<jobId>/<sha256>.<format>`，临时文件独占创建、flush/fsync后原子替换。artifactId绑定完整handle/port/format/sha256。公开记录含 artifactId/sha256/bytes/format/mime/role/port/jobId/runId/inputHash/projectId/revision/summary/url；下载完整handle随URL鉴权，禁止任意文件路径查询。文件普通单链接、打开前后身份、大小、哈希均复核。

每个几何端口可发布真实 GLB(model)、原生JSON(data)、静态SVG(preview)。GLB版本2，米制/Y-up，实例复用mesh；float32造成退化拒绝EXPORT_PRECISION_LOSS。SVG固定512×384投影、最多1800三角形/点并标明抽样；没有交互视口承诺，不能充当模型文件。单个资产最大64MiB。

公开read/wait/list仅有界摘要：真实counts/bounds/域/绑定及最多64项抽样，不回传完整几何数组。InstanceSet boundsKind=conservative，为变换后原型AABB，检查不展开实例。verify要求成功且当前、保存图inputHash一致、结果hash一致、所有受管资产hash一致。图、worker和文件身份不能靠展示文本替代。

## Windows安全前置与后续门

协议2需要真正Windows AppContainer：零capabilities、唯一SID、只读受保护代码/运行时、可写低完整性自有temp、stdio句柄白名单、child-process禁止；挂入1进程/内存/CPU/kill-on-close资源job后启动。环境清理且不加载site-packages。OS允许的系统文件访问仍存在，不声称“所有外部文件不可读”。本地合成私有夹具证明读/写/网络/子进程拒绝；资源job或Python隔离标志单独均不是文件网络沙箱。

运行时配置512MiB内存、最高64MiB stdio输出、几何descriptor墙钟30秒与其一半CPU预算。缺少支持/解释器则preflight返回ISOLATION_UNAVAILABLE，run保留failed，绝不普通进程fallback。详细边界见 [ISOLATION_API.md](../../pcg/ISOLATION_API.md)。

M3game_asset桥、既有资产质量门，M4实时增量展示，M5正式画布与发布未开始。实际模型文件导出不代表这些后续门已通过。
