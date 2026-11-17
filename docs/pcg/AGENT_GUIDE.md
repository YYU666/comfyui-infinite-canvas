# PCG M2：Agent 开发与使用手册

当前切片提供自写标准库几何、保存图求值、受限 worker、真实 GLB/JSON 和只读 SVG。M2 正在集成验收；本手册描述代码接口，不代表 CI、正式画布或发布验收完成。M3–M5 未开始，`game_asset` 是明确不可运行的 M3 占位。旧 `diagnostic` 与 `geometry_stub` 保留 M1 合同，不能替代几何输出。

先调用 `canvas_pcg_describe {}`，以返回的 `pcg/registry.json` 描述、schema、示例和错误恢复为准。namespace=`refmuse.pcg`，descriptorVersion=1、operationVersion=1、pluginVersion=1.0.0。`ready` 表示固定操作已实现；本机 OS 隔离仍须 preflight 通过。未知版本、额外字段、自由表达式、脚本、路径、URL、可执行文件参数全部拒绝。

只使用拥有写锁的当前项目页。创建→设参→连接→保存→预检→运行→等待→读回→核验→导出；项目只读、切换或 revision 冲突时停止修改。开发验证只用合成夹具；本文示例不授权操作正式页面或生成服务。

## 五个任务入口

表中 `?` 表示可选端口。最小参数例使用实际默认值；所需输入从同一保存图中的节点连入，不能把数组或路径直接塞入 run。`Geometry` 是 Mesh/PointSet/InstanceSet 的封闭联合类型，具体操作还会检查实际子类型。

| ID（均加 `refmuse.pcg.`） | 用途与输入约束 | 输入 → 输出端口 | 最小参数例 | 常见错误与处理 |
| --- | --- | --- | --- | --- |
| `shape` | 基础体任务入口；调用同一 primitive 执行器；无输入，参数选择 box/sphere/cylinder/plane | `—` → `geometry:Geometry` | `{"kind":"box","size":[1,1,1],"subdivisions":0}` | 未知 kind 或零尺寸：修正参数 |
| `rock` | 确定性岩石配方：sphere→attribute_read(position)+noise_field(scalar)→field_math(multiply)→set_position→recompute_normals；无输入；seed 改变真实顶点 | `—` → `geometry:Geometry` | `{"seed":0,"subdivisions":2,"size":[1,1,1],"roughness":0.2}` | 细分预算：降低 subdivisions；不是质量认证 |
| `scatter` | 表面采样并共享原型实例化；geometry=Mesh；prototype=Mesh | `geometry:Geometry；prototype:Geometry` → `instances:Geometry` | `{"count":100,"seed":0,"minDistance":0,"maxSlope":90,"minHeight":-1000000.0,"maxHeight":1000000.0,"scale":[1,1,1]}` | INSUFFICIENT_PLACEMENT：减少 count/间距或放宽坡度高度 |
| `compose` | 同类型几何组合入口；a、b 均 Mesh 或均 PointSet | `a:Geometry；b:Geometry` → `geometry:Geometry` | `{}` | 混合类型/实例：显式处理；不隐式 realize |
| `game_asset` | M3 游戏资产桥占位；M2 不执行；没有可用输入来源，参数 {} | `—` → `geometry:Geometry` | `{}` | M3_BRIDGE_UNAVAILABLE：保留可读节点，等待独立桥接批准 |

## 十八个原子操作

任务配方与下列原子操作使用同一求值器；可以建立非固定配方的组合图。

| ID（均加 `refmuse.pcg.`） | 用途与输入约束 | 输入 → 输出端口 | 最小参数例 | 常见错误与处理 |
| --- | --- | --- | --- | --- |
| `primitive` | 创建自写基础几何；无输入；kind 选择基础体 | `—` → `geometry:Geometry` | `{"kind":"box","size":[1,1,1],"subdivisions":0}` | kind/尺寸无效或细分超限：修正参数 |
| `transform` | 平移、欧拉旋转（弧度）、缩放；geometry=任一 Geometry | `geometry:Geometry` → `geometry:Geometry` | `{"translation":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}` | 零缩放拒绝；实例父变换只接受均匀缩放，避免丢失剪切 |
| `join_geometry` | 合并网格或点集；a、b 为相同 Mesh/PointSet | `a:Geometry；b:Geometry` → `geometry:Geometry` | `{}` | 混合类型、InstanceSet 或合并后超预算：显式拆分 |
| `subdivide` | 网格三角形细分；geometry=Mesh | `geometry:Geometry` → `geometry:Geometry` | `{"levels":1}` | 点集/实例拒绝；levels 增大会触发预算 |
| `attribute_read` | 读位置或角法线为已绑定 Field；geometry；position→Point，normal→Corner | `geometry:Geometry` → `field:Field` | `{"name":"position"}` | normal 需要 Mesh 法线；不能把 Corner 当 Point |
| `noise_field` | 确定性标量/向量噪声；geometry；可选同绑定 Point position:Field | `geometry:Geometry；position:Field?` → `field:Field` | `{"seed":0,"amplitude":0.1,"frequency":1,"output":"vector3"}` | 位置 Field 绑定/域/类型不符：从当前几何重新读取 |
| `field_math` | 加乘、取分量、长度、归一化；a:Field；可选同绑定/域的数值 b | `a:Field；b:Field?` → `field:Field` | `{"operation":"multiply","value":1}` | 不同绑定/域或非数值类型拒绝；允许标量/向量逐分量广播；零向量不能归一化 |
| `compare` | 标量比较产生布尔 Selection；field 为 float/integer Field | `field:Field` → `selection:Selection` | `{"operation":"greater","value":0}` | vector3 先经 length/component 提取标量 |
| `selection` | 域内全选/空选/每N项及布尔组合；geometry；and/or 需 a,b，not 需 a | `geometry:Geometry；a:Selection?；b:Selection?` → `selection:Selection` | `{"domain":"Point","mode":"all","every":2}` | 选择域和源必须一致；缺少布尔输入应补连线 |
| `set_position` | 按选区应用 Point 向量位移；geometry=Mesh/PointSet；offset=Point vector3；selection 可选 | `geometry:Geometry；offset:Field；selection:Selection?` → `geometry:Geometry` | `{}` | Corner/标量位移或旧绑定拒绝；变形后重算法线 |
| `recompute_normals` | 显式重建平滑/平面 Corner 法线；geometry=Mesh | `geometry:Geometry` → `geometry:Geometry` | `{"mode":"smooth"}` | 非 Mesh 拒绝；检查 mode 枚举 |
| `sample_texture` | 受管内存图片采样为 Field；geometry；可选 Image；缺图用显式 color 常量纹理 | `geometry:Geometry；image:Image?` → `field:Field` | `{"interpolation":"bilinear","mapping":"uv","channel":"rgb","color":[0.5,0.5,0.5]}` | uv 要有效 Corner UV；投影 xy/xz/yz 为 Point；不接受文件路径 |
| `scatter_points` | 按面积/坡度/高度/间距确定性表面采样；geometry=Mesh | `geometry:Geometry` → `points:Geometry` | `{"count":100,"seed":0,"minDistance":0,"maxSlope":90,"minHeight":-1000000.0,"maxHeight":1000000.0}` | INSUFFICIENT_PLACEMENT 无部分成功；调整约束或数量 |
| `instance_on_points` | 每个点放置共享原型；points=PointSet；prototype=Mesh | `points:Geometry；prototype:Geometry` → `instances:Geometry` | `{"scale":[1,1,1]}` | 类型错误或零 scale 拒绝；输出保持实例 |
| `instance_transform` | 变换实例集，保留共享原型；instances=InstanceSet | `instances:Geometry` → `instances:Geometry` | `{"translation":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}` | 父缩放须均匀；需要实体网格时显式 realize |
| `realize_instances` | 显式展开实例为网格；instances=InstanceSet | `instances:Geometry` → `geometry:Geometry` | `{}` | 展开前检查顶点/三角形预算，过量拒绝 |
| `inspect_geometry` | 有界诊断并透传几何；geometry=任一 Geometry | `geometry:Geometry` → `report:DiagnosticReport；geometry:Geometry` | `{}` | report 不可连到 geometry；实例 bounds 为保守包围盒 |
| `publish_geometry` | 校验并透传，宿主发布真实受管资产；geometry=任一 Geometry | `geometry:Geometry` → `geometry:Geometry` | `{}` | 导出精度丢失/资产哈希变化拒绝；不是 M3 质量门 |

`shape`/`primitive`：kind 默认 box，size=[1,1,1]，subdivisions=0..6；rock 默认 subdivisions=2、roughness=.2、seed=0。旋转为弧度，scatter 的 maxSlope 为相对 +Y 的角度。M2没有文件图片导入或生成Image的节点；保存图中的纹理采样使用显式color常量，Image端口只声明受管内存数据合同。完整参数范围见 [ENGINE_API.md](../../pcg/ENGINE_API.md)，运行前仍须读取实际 descriptor。

## 完整工具回路

下面 `call` 是 Agent 的工具入口，不是 worker 执行脚本功能；`P`、节点 ID、保存 revision 和 handle 必须来自实际返回值。示例建立 primitive→transform→publish_geometry，与任务入口预设无关。

```javascript
await call('canvas_pcg_describe', {});
const page=await call('canvas_get_state',{});
const P=page.projectId;
const create = async descriptorId => call('canvas_pcg_create_node', {
  projectId: P, descriptorId: `refmuse.pcg.${descriptorId}`,
  descriptorVersion: 1, operationVersion: 1
});
const source = await create('primitive');
const moved = await create('transform');
const final = await create('publish_geometry');
const S = source.node.id, M = moved.node.id, N = final.node.id;
await call('canvas_pcg_set_parameters', {
  projectId:P,nodeId:S,descriptorVersion:1,operationVersion:1,
  parameters:{kind:'box',size:[1,1,1],subdivisions:0}
});
await call('canvas_pcg_set_parameters', {
  projectId:P,nodeId:M,descriptorVersion:1,operationVersion:1,
  parameters:{translation:[1,0,0],rotation:[0,0,0],scale:[1,1,1]}
});
await call('canvas_connect_nodes', {
  sourceId:S,targetId:M,sourceHandle:'geometry',targetHandle:'geometry'
});
await call('canvas_connect_nodes', {
  sourceId:M,targetId:N,sourceHandle:'geometry',targetHandle:'geometry'
});
// 连线已保存；读取当前页实际最新 revision。
const saved=await call('canvas_get_state',{});
const R=saved.revision;
const request={projectId:P,nodeId:N,revision:R,
  descriptorVersion:1,operationVersion:1,runId:'geometry-001'};
const checked=await call('canvas_pcg_preflight',request);
if(!checked.ok || !checked.isolation?.available) throw new Error('预检/隔离未通过');
// 核对 executionOrder/dirtyNodes/cacheHits。
const launched=await call('canvas_pcg_run',request);
if (!launched.ok) throw new Error('保留并读取 launched.task/error');
const H=Object.fromEntries([
  'projectId','nodeId','revision','descriptorVersion','operationVersion',
  'runId','jobId','inputHash'
].map(key=>[key,launched.task[key]]));
let waited=await call('canvas_pcg_wait',{...H,timeoutMs:1000});
while (['queued','running'].includes(waited.task.status)) {
  waited=await call('canvas_pcg_wait',{...H,timeoutMs:1000});
}
const read=await call('canvas_pcg_read',H);
if(read.task.status!=='succeeded') throw new Error('检查 read.task.error');
const verified=await call('canvas_pcg_verify',H);
if(verified.verified!==true) throw new Error('结果未通过核验');
const exported=await call('canvas_pcg_export',{...H,format:'glb',port:'geometry'});
// 核对 exported.artifact 的 jobId/runId/inputHash、sha256/bytes/mime/role/url。
// 需要终止正在执行的任务时，在等待循环期间使用：
// await call('canvas_pcg_cancel',H);
// 再等待 cancelled/failed 终态；不会取消其他任务或服务。
```

完整 handle 含八个字段，不能仅传 jobId：

```json
{"projectId":"prj_example","nodeId":"pcg-1","revision":2,"descriptorVersion":1,"operationVersion":1,"runId":"run-001","jobId":"pcg_0123456789abcdef0123456789abcdef","inputHash":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}
```

八项身份字段为：projectId/nodeId/revision/descriptorVersion/operationVersion/runId/jobId/inputHash；以 JSON 和工具 schema 为准，不增加 display label 或 resultHash。`canvas_pcg_list_tasks {projectId:P,nodeId:N}` 用于页面重载恢复。宿主重启后内存任务/缓存不保证保留。相同 runId 只对完全相同身份/输入幂等；参数、连线、revision 或版本改变须新 runId。queued/running 时继续有界 wait（0..20000ms），不重复 run。

## 工具输入、输出与恢复

| 工具 | 输入 | 真实输出及恢复 |
| --- | --- | --- |
| canvas_pcg_describe | `{}` | registry/tools/errors；先发现再建图 |
| canvas_pcg_create_node | projectId/descriptorId/descriptorVersion/operationVersion，可选 x/y/focus | 节点与保存 revision；错误项目/只读立即停 |
| canvas_pcg_set_parameters | projectId/nodeId/两版本/parameters | 同源 schema 校验、保存并返回 revision；替换整个参数对象 |
| canvas_connect_nodes | sourceId/targetId/sourceHandle/targetHandle | 当前页真实边；拒绝未知端口、类型错误、环与重复输入；完成连线后核对保存 revision |
| canvas_pcg_preflight | 六项 request 身份 | 保存 DAG、依赖顺序、dirty/cache 预测、隔离可用性；不运行几何 |
| canvas_pcg_run | 同一 request | 完整 task；几何不可用时保留 failed，不降级执行 |
| canvas_pcg_wait/read | 完整 H；wait 可选 timeoutMs | task 实际状态/有界结果/错误/stale；旧任务可读，不能当当前输出 |
| canvas_pcg_verify | 完整 H | verified/inputHash/resultHash；复核当前图和真实资产哈希 |
| canvas_pcg_cancel | 完整 H | 仅本任务取消标志与受管 OS job；已终态不变；旧 handle 拒绝修改 |
| canvas_pcg_export | 完整 H，MCP 必须 format=glb/json，可选 port | 受管 artifact；只导出成功且当前的几何端口；预览不作模型 |
| canvas_pcg_list_tasks | projectId/nodeId | 当前授权项目同节点保留任务，最新在前 |

## 读回、导出、缓存

`task.result.outputs` 返回真实 counts/bounds、域、content/topology binding 及每值最多64项确定性抽样；完整数组留在受限 IPC 和宿主验证/缓存中，不默认塞入 MCP。`report` 提供实际 computedNodes/cacheHits、节点 elapsedMs/outputBytes 和宿主总 elapsedMs；preflight 只是预测，不能拿预测当计算证据。

`task.result.stagePreviews` 按保存图的执行顺序列出每一步的 nodeId、jobId/runId/inputHash/outputHash、cacheHit/elapsedMs、有界 outputs 和真实 SVG assets。Field/Selection 保留源绑定、域、数量及最多64样本；几何步骤的 SVG 绑定 producerNodeId，可在节点详情只读展开。全部步骤 SVG 合计不得超过16MiB，超限先失败，不静默漏掉步骤。`report.queueWaitMs` 为实际排队时间；4个任务准入仅一个几何任务实际执行，等待者保持 queued，可单独取消。

几何输出成功后宿主发布三种不同角色：GLB `role:model`、原生 JSON `role:data`、固定机位 SVG `role:preview`。每项含 artifactId、SHA256、bytes、format/mime、port、job/run/input/project/revision 与受认证本地 URL。GLB 为真实二进制模型，实例共享原型；JSON 保留域数据；SVG 从实际几何投影，最多抽取1800个三角形/点并标注抽样，只读、无交互，不是完整模型或实时视口。下载和 verify 重验文件身份与哈希。浮点32精度导致退化时 EXPORT_PRECISION_LOSS，不能输出看似成功的坏模型。

缓存键含操作/版本、规范参数、显式输入内容及 Field/Selection 绑定，不含项目 revision；按项目/宿主隔离并返回副本。32MiB/256条 LRU；最多256任务、4个任务准入、1个几何执行、64MiB保留最终值、依赖图最多256节点。局部修改只重算其依赖后代；断开的分支不参与目标求值。旧 revision 或同节点新 run 使旧结果 stale，旧 run 不能覆盖新结果。

## Windows 隔离和未交付范围

几何协议2仅在可验证的 Windows AppContainer 中运行：每任务唯一 SID、零 capabilities、受保护只读代码/运行时 ACL、独占可写低完整性临时区、仅三条 stdio 句柄、禁止子进程，挂入资源 JobObject 后才恢复执行。JobObject 限制1进程、内存、CPU时间并 kill-on-close；超时/取消/输出超量终止本 job。环境仅系统目录/盘符及本任务 profile/temp，Python `-I -S -B` 且无 site-packages。应用容器仍保留 OS 允许的系统文件访问；不声称系统所有文件都不可读。

宿主要求已有匹配标准库 zip 和 windowless 解释器；不安装依赖、不请求管理员权限。几何运行时使用512MiB内存和最大64MiB stdio输出；descriptor 时限通常30秒，CPU上限为墙钟一半。无该能力的平台/解释器返回 ISOLATION_UNAVAILABLE；图仍可读，几何不退化成普通进程。旧协议1固定诊断仍是独立可信诊断，不能称为 OS 沙箱。详见 [ISOLATION_API.md](../../pcg/ISOLATION_API.md)。

M3 游戏资产桥、既有资产导入/质量门、原型碰撞包围体约束、M4完整预览集成和M5正式画布/发布验收均未实现。前置的独立最小只读3D演示页已单独实现，真实加载GLB并按真实任务阶段刷新，使用方法与六个MCP工具见 [DEMO_GUIDE.md](DEMO_GUIDE.md)；它不接正式画布，也不以演示代替后续门禁。

## 常见错误决策

REVISION_CONFLICT/STALE_RUN：读当前保存图，新 runId；IDEMPOTENCY_CONFLICT：旧 runId 不代表新输入。PORT_UNKNOWN/PORT_TYPE_MISMATCH/GRAPH_CYCLE：修真实边。FIELD_BINDING_MISMATCH：从当前几何重建 Field；FIELD_DOMAIN_MISMATCH：保持 Point/Corner/Instance 的实际域，set_position 只能 Point vector3。INSUFFICIENT_PLACEMENT：明确减少数量/间距或放宽高度/坡度，不接受部分结果。BUDGET_EXCEEDED：降低细分/数量/图规模。ISOLATION_UNAVAILABLE：保留失败，修宿主能力；M3_BRIDGE_UNAVAILABLE/EXECUTOR_UNAVAILABLE：保持占位，不能伪造输出。WORKER_TIMEOUT/CRASH/PROTOCOL：保留错误后显式新 run；WORKER_CANCELLED 为取消终态。资产哈希或链接异常直接拒绝。权限/项目/锁冲突停止修改，不开第二页面或直提任务绕过。
