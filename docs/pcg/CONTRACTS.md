# PCG v1 合同速查

本文件说明 M1 的封闭数据合同。严格检查实现在 `pcg_contracts.py`；机器可发现的节点操作在 `pcg/registry.json`。下列元数据通过不表示实际几何已生成或通过资产质量门。

## NodeDescriptor v1

注册表根字段为 `descriptorVersion:1`、`namespace:"refmuse.pcg"`、`pluginVersion:"1.0.0"` 和 `nodes` 数组。每项必须包含以下字段，未知字段拒绝。

| 字段 | 类型与含义 |
| --- | --- |
| id | 命名空间内唯一操作 ID |
| descriptorVersion / operationVersion | 整数 1；分别固定描述协议与操作语义 |
| pluginVersion | 当前精确插件版本 |
| label / category | 展示标签与分类标识 |
| parameters | 封闭对象 schema；M1 只需有默认值的有界字符串 |
| inputs / outputs | `{name,type,required}` 数组，名称唯一；严格匹配端口类型 |
| budget | timeoutMs≤5000、maxInputBytes≤1MiB、maxOutputBytes≤64KiB、maxItems≤1024 |
| permissions | 当前只能 `[]`；不授权网络、文件路径或代码执行 |
| readiness | ready/null 或 unavailable/EXECUTOR_UNAVAILABLE |
| examples / errors | 参数示例及稳定错误码；完整工具示例/恢复说明由 describe 返回 |

这不是任意插件加载器：修改 JSON 不能使未知操作获得执行权限，worker 还会复核固定操作白名单。

## GeometryArtifact / InstanceSet

两类都必须带 `contractVersion:1` 和精确 `type`。资产文件为同项目清单注册的 `assets/<sha256>.pcg.json`，artifactId 必须为 `pcg_<sha256>`。

| 字段 | 类型与约束 |
| --- | --- |
| projectId / artifactId | 项目身份及内容寻址身份 |
| sha256 / assetPath | 64 位小写十六进制哈希及对应受管相对路径 |
| format | 几何为 `pcg.geometry.json`，实例为 `pcg.instances.json` |
| coordinates | 精确 `{units:"m",handedness:"right",upAxis:"Y"}` |
| bounds | `{min:[x,y,z],max:[x,y,z]}`，有限数值、每轴 min≤max |
| producer | `{pluginId,pluginVersion,commit}`；commit 为 40 位小写 Git SHA |
| provenance | `{nodeId,jobId,runId,revision,recipeHash,inputHashes}`；revision≥1，摘要均 SHA256，输入最多16项 |
| metadata | `{uvSets,normalDomain,materials,quality}`，UV最多8组/材质最多64，normalDomain 为 Point、Corner 或 null；quality 只能 diagnostic-only，不得 accepted |
| topologyId | 拓扑/实例顺序版本；数组下标不是跨版本稳定身份 |
| counts（几何） | `{Point,Face,Corner}`，各≤1024，Corner≥Face |
| geometry（实例） | `{artifactId,sha256,topologyId}`，绑定原型几何 |
| count / instanceIds（实例） | 数量≤1024，等长、唯一、稳定实例 ID |
| transforms（实例） | 与 count 等长的 row-major 4×4 仿射矩阵；平移在第4/8/12个元素，最后一行为 `[0,0,0,1]` |

M1 文件容器为封闭 `{contractVersion:1,format,payload}`，payload 为有界对象。broker 验证封闭容器、项目归属、字节数、哈希及普通单链接文件；不解析网格 payload，也不负责本轮的模型发布/导出。实例不会被隐式实体化。

## 属性域与 Field

上下文为 `{binding:{artifactId,sha256,topologyId},counts:{...域计数,Detail:1}}`。`geometry_context` 从几何构造 Point/Face/Corner/Detail；`instance_context` 从实例集构造 Instance/Detail。绑定和计数必须匹配，不按同名属性跨几何猜测。

属性格式：`{contractVersion:1,type:"Attribute",geometry:binding,domain,valueType,values}`。域为 Point/Face/Corner/Instance/Detail 之一；值类型为 float/integer/boolean/vector3。数组长度必须等于该域计数，最多1024项。Selection 同格式，type 为 Selection 且 valueType 必须 boolean。

Field 格式：`{contractVersion:1,type:"Field",geometry:binding,domain,valueType,nodes,output}`。nodes 有1–64项，按拓扑顺序列出，引用只能指向更早节点。支持固定 constant、attribute、add、multiply；不包含自由表达式。运算类型不能隐式转换，boolean 不能参与数值加乘。

最小 Field（将 `B` 换成真实受管几何的 binding，`C` 为该几何上下文）：

```python
field = {
    "contractVersion": 1, "type": "Field", "geometry": B,
    "domain": "Corner", "valueType": "float",
    "nodes": [{"id": "constant", "op": "constant", "valueType": "float", "value": 0.5}],
    "output": "constant",
}
validate_field(field, C)
```

此示例仅验证描述，不执行求值；几何计算是后续阶段。Corner 与 Point 数量不同，不能将角 UV/法线按共享点合并。拓扑变更必须换绑定；Field 中捕获的属性也须来自同一绑定和域。

## 任务、权限与版本

任务请求必含 projectId/nodeId/revision/descriptorVersion/operationVersion/runId；任务 handle 再含 jobId/inputHash。预检/运行从已保存图读取参数与端口，要求写锁与准确 revision。不同项目、节点、版本或输入不能复用同一 handle。

重复 projectId/runId 且输入完全相同返回原任务；身份或输入变化拒绝。读回/等待旧任务会带 stale，verify 拒绝 stale。任务保留到当前宿主结束，最多256项；容量满明确拒绝，页面重载用 list_tasks 恢复，宿主重启后不可继续查询旧内存任务。

worker 只有固定诊断入口和实际 PID/报告，超时、崩溃、畸形响应必须进入 failed；任务和失败节点保留。只读面板显示实际状态和报告，不生成模型缩略图。操作手册及完整工具闭环见 [AGENT_GUIDE.md](AGENT_GUIDE.md)。
