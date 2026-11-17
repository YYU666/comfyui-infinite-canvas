# PCG M1：Agent 开发与使用手册

## 当前能力与发现

本切片交付宿主合同及固定诊断操作。它没有几何生成算法，也没有接入冻结的 3D 资产处理链。不要把诊断报告当成模型，不要把占位节点运行失败说成建模成功。

先调用 `canvas_pcg_describe {}`，读取注册表、工具 schema、示例、错误恢复说明。UI、页面工具、宿主和 worker 使用同一份 `pcg/registry.json`。固定身份为 namespace `refmuse.pcg`、descriptorVersion `1`、pluginVersion `1.0.0`、operationVersion `1`。未知版本必须停止，不猜测兼容。

菜单在「3D与游戏资产 / 程序化建模〔PCG插件〕」。注册的是本切片的合同诊断和执行器占位，不提前铺开未实现的算法菜单。预览仅展示状态、身份和结果；用户不需要操作 3D 视口。

Agent 沿用创建→设参→连接→预检→运行→等待→读回→核验。所有修改必须在拥有写锁的当前项目页执行；只读、切换中或项目不匹配时停止。不要用另一个页面或直接改项目文件来绕过冲突。本手册的工具例子说明未来获准项目页中的用法，本线程开发测试只使用隔离夹具。

## 节点说明

| ID | 用途与输入 | 输出 | 最小用法 | 常见错误与处理 |
| --- | --- | --- | --- | --- |
| `refmuse.pcg.diagnostic` | 核对合同和进程边界；可选 `geometry:GeometryArtifact`、`instances:InstanceSet`、`field:Field`、`attribute:Attribute`；`label` 最长 80 字符 | `report:DiagnosticReport`，包含实际 workerPid、输入数量/类型、inputHash；没有模型 | 创建、设置 `{"label":"M1 check"}`，不接输入，保存后预检/运行/等待/读回/verify | `INPUT_UNAVAILABLE`：连接源未产生真实结果，断开或等待正确源；`WORKER_*`：保留失败并明确新建 run，不偷偷自动替代 |
| `refmuse.pcg.geometry_stub` | 为几何端口与版本校验保留身份，可选 `geometry:GeometryArtifact`；参数必须 `{}` | 声明 `geometry:GeometryArtifact`，M1 没有实际输出 | 创建→读回 descriptor→preflight；预期 `EXECUTOR_UNAVAILABLE` | 这是明确未就绪，不能靠改 readiness、伪造 report 或重命名输入来通过；等待后续批准执行器 |

可用通用 preset：`pcg_diagnostic`、`pcg_geometry_stub`。首选专用创建工具，它明确传版本和参数。诊断没有可连到几何输入的输出；`DiagnosticReport` 与 `GeometryArtifact` 不兼容。几何占位的 geometry→诊断 geometry 是合法可见边，但上游没有执行器时整链不可运行。

## 最小可运行诊断回路

下例 `P` 为当前项目 ID，`N`、`R`、`H` 全部取自真实工具返回值。不要把示例字符串直接当成实际身份。

```javascript
const catalog = await call('canvas_pcg_describe', {});
const created = await call('canvas_pcg_create_node', {
  projectId: P, descriptorId: 'refmuse.pcg.diagnostic',
  descriptorVersion: 1, operationVersion: 1, x: 0, y: 0
});
// 从 created 返回的 node 身份取 N。
const updated = await call('canvas_pcg_set_parameters', {
  projectId: P, nodeId: N, descriptorVersion: 1, operationVersion: 1,
  parameters: { label: 'M1 check' }
});
// 从 updated 取保存后的 revision R；图改变后必须重新读取 R。
const request = {
  projectId: P, nodeId: N, revision: R, descriptorVersion: 1,
  operationVersion: 1, runId: 'm1-check-001'
};
await call('canvas_pcg_preflight', request);
const {task} = await call('canvas_pcg_run', request);
const H = Object.fromEntries([
  'projectId','nodeId','revision','descriptorVersion','operationVersion',
  'runId','jobId','inputHash'
].map(key => [key, task[key]]));
let answer = await call('canvas_pcg_wait', {...H, timeoutMs: 1000});
// queued/running 时继续相同 handle 的有界等待，不重复提交 run。
while (['queued','running'].includes(answer.task.status)) {
  answer = await call('canvas_pcg_wait', {...H, timeoutMs: 1000});
}
const result = await call('canvas_pcg_read', H);
if (result.task.status !== 'succeeded') throw new Error('检查保留的 task.error');
const verified = await call('canvas_pcg_verify', H);
// 核对 verified.verified === true，inputHash/resultHash 与本任务一致。
```

此代码中的 `call` 是当前 Agent 提供的工具调用入口，不是插件执行代码功能。worker 不接受这段脚本，也不执行用户字符串。

## 每个工具的输入、输出与恢复

每个工具的机器可读 schema 和直接调用示例由 `canvas_pcg_describe` 返回。额外参数、未知版本和非有限数值不合法；不要向 run 塞入参数或一份并行的图，参数和连接取自已保存项目。

| 工具 | 输入 / 最小示例 | 输出与用途 | 错误处理 |
| --- | --- | --- | --- |
| `canvas_pcg_describe` | `{}` | 共享节点描述、工具 schema、示例与错误；先发现再操作 | 未发现插件时保持旧项目可读，不装依赖 |
| `canvas_pcg_create_node` | `{projectId:P,descriptorId:"refmuse.pcg.diagnostic",descriptorVersion:1,operationVersion:1}` | 创建并保存节点，返回节点与 revision | 未知描述/版本或只读：停止；不要转成 note 绕过 |
| `canvas_pcg_set_parameters` | `{projectId:P,nodeId:N,descriptorVersion:1,operationVersion:1,parameters:{label:"M1 check"}}` | 校验后设置参数并保存，返回 revision | 未知参数/超长 label：按 descriptor 修正；占位仅接受 `{}` |
| `canvas_connect_nodes` | `{sourceId:S,targetId:N,sourceHandle:"geometry",targetHandle:"geometry"}` | 产生真实类型化可见连线；M1 可连占位，但不能产出几何 | 端口/类型不符、循环、重复输入：修正图；report 不能冒充 geometry |
| `canvas_pcg_preflight` | 上节 `request` | 检查保存版本、依赖、端口、输入及就绪状态，不执行 worker | 缺件即停止；revision 冲突先保存/读取最新图，不改旧 handle |
| `canvas_pcg_run` | 同一 `request` | 返回任务及完整身份；固定诊断在独立本地进程执行 | 相同 run 与输入幂等；换参数/身份要新 runId。失败节点和任务保留 |
| `canvas_pcg_wait` | `{...H,timeoutMs:1000}`，0–20000 毫秒 | 有界等待后返回当前任务；未终态继续 wait | 不因 pending 重跑，不无限阻塞单次调用 |
| `canvas_pcg_read` | `H` | 读回真实报告/错误与身份；旧任务明确标过期 | 跨项目或伪造身份拒绝；过期任务可查看但不当作当前输出 |
| `canvas_pcg_verify` | `H` | 校验成功报告、inputHash、resultHash、版本和归属 | failed/pending/stale 或被改结果不能 verified；检查原因再新 run |
| `canvas_pcg_list_tasks` | `{projectId:P,nodeId:N}` | 查询同节点保留任务，用于页面重载恢复 | 仅当前授权项目；宿主重启后不能假定旧内存任务仍存在 |

通用 `canvas_create_node`、`canvas_update_node`、`canvas_generate_node`、`canvas_wait_for_node`、`canvas_get_state` 提供薄适配，保持现有操作习惯。专用工具提供更明确的版本/任务身份；不得同时从多个页面写同一项目。

## 开发合同与边界

`pcg/API.md` 说明 HTTP 路由、身份和 stdio 报告；`pcg_contracts.py` 为严格值验证权威实现；UI 对参数做同源提前校验，后端仍完整重验。新增操作须先更新共享 descriptor，再补 worker 白名单、合同测试和手册；不能只加菜单或 preset。

- `GeometryArtifact v1`：不可变项目/资产/hash/topology 身份，米制、右手、Y-up；bounds 和 Point/Face/Corner 统计分开。M1 是元数据合同，不能声称已验证实际网格拓扑。
- `InstanceSet v1`：绑定原型资产、稳定实例 ID 和有界 row-major 4×4 仿射矩阵；不隐式实体化。
- `Field v1`：有限 DAG、固定算子白名单与值类型；在明确几何和属性域求值。禁止自由表达式、脚本、动态导入和可执行路径。
- `Attribute/Selection v1`：绑定具体几何/hash/topology 和 Point/Face/Corner/Instance/Detail；角属性不能按共享点数组混合，未知域转换拒绝。
- 资产经纪仅访问同项目资产清单注册的受管内容寻址文件；拒绝绝对路径、URL、UNC、穿越、链接/reparse、硬链接及哈希变化。输出模型解析不属于 M1。
- 任务身份包含项目、节点、保存 revision、descriptor/operation 版本、runId、jobId、inputHash。展示文字不构成结果身份；旧任务不会改写项目或覆盖新任务结果。
- worker 仅固定 stdio 诊断操作，限制输入、输出、时长与继承环境，无监听端口。这是进程分离，**不是完整 OS 沙箱**；引入实际模型解析前必须另过隔离门。

## 错误决策

`REVISION_CONFLICT`：读当前图、保存、重新预检并使用新 runId。`IDEMPOTENCY_CONFLICT`：不要复用已代表另一输入的 runId。`VERSION_UNSUPPORTED`：读取已安装 descriptor，禁止自行改版本字段。`INVALID_CONTRACT`：查看 details，按声明修正字段/域/类型。`EXECUTOR_UNAVAILABLE`：停止几何运行，报告未实现。`INPUT_UNAVAILABLE`：检查真实上游结果和连接。`WORKER_TIMEOUT/CRASH/PROTOCOL`：保留错误，确认实现/环境后显式重试，不拿输入充当输出。权限、锁冲突和项目切换错误：停止修改，不转用隐藏页或正式服务直提任务。

## 后续门禁

M2 几何算法、M3 冻结资产桥、M4 增量 3D 展示、M5 正式画布验收均未包含于本切片。冻结快照来源/哈希与允许改动范围，以及后续几何实现复用或自写路线，仍待木一决定。详见 `DEV_STEPS.md`。
