# PCG 最小只读 3D 演示：Agent 使用手册

这是独立测试页，真实加载 M2 的 GLB。它不是正式画布入口，不保存或修改正式项目；没有选择点面、拖拽变换或建模工具。自动取景、自动转台、阶段刷新只使用本地 CPU/GPU，不按帧请求模型。游戏资产桥及完整生产验收仍未交付。

## 启动和发现

在本分支独立 worktree 根目录，用**已存在且满足 M2 隔离要求**的 Python 启动：

```powershell
python pcg_demo_server.py --runtime-dir "D:\PCG-Demo\run-unique" --samples-root "D:\RefmuseReviews\pcg-plugin-plan-20261117\m2-samples" --port 0
```

`--runtime-dir` 必须是本任务专用本地目录；同目录所有权标记存在即拒绝第二服务。不要删除活动标记以绕过冲突，改用新目录。`--samples-root` 可省略，省略时先启动真实测试才会有模型；指定时只读取该目录 `EVIDENCE.json` 中校验通过的 GLB，复制到本实例不可变缓存，不写回样例。拒绝网络目录、链接、路径逃逸、外部资源和内容校验不符。

`--port 0` 由系统分配空闲端口，只绑定 `127.0.0.1`。8188、8189、8790 被显式禁止；不启动/停止其他服务。标准输出给出 URL、端口、PID、实例 ID，**不输出令牌**。凭据只保存在本地 `runtime-dir/instance.json`，不要复制到聊天、截图或 Git。只关闭自己启动的服务；正常退出释放所有权标记。

浏览器打开实际 URL，首页设置本服务 HttpOnly 会话 Cookie。此页面可新开，不连接正式画布。MCP 客户端从本地实例文件取 `mcpUrl` 和 `token`，将 token 放入 `Authorization: Bearer ...`，不放 URL。本服务提供无会话 JSON Streamable HTTP MCP 子集：`initialize`、`notifications/initialized`、`ping`、`tools/list`、`tools/call`；不提供 SSE/订阅，状态按需读回。MCP 工具本身不启动系统浏览器，`pcg_demo_open` 返回 URL 后由调用客户端打开。

工具权威定义是 [demo-tools.json](../../pcg/demo-tools.json)，HTTP `/api/tools` 和 MCP `tools/list` 共用它；浏览器与 Agent 共用会话状态/产物合同。最小传输例子（实际 token 只在内存中）：

```python
import json, urllib.request
from pathlib import Path
instance = json.loads(Path(r'D:\PCG-Demo\run-unique\instance.json').read_text('utf-8'))
def call(name, arguments=None):
    body = {'jsonrpc':'2.0', 'id':1, 'method':'tools/call',
            'params':{'name':name, 'arguments':arguments or {}}}
    request = urllib.request.Request(instance['mcpUrl'], json.dumps(body).encode(),
        headers={'Content-Type':'application/json', 'Authorization':'Bearer '+instance['token']})
    with urllib.request.urlopen(request) as response:
        result = json.load(response)['result']
    if result['isError']: raise RuntimeError(result['content'][0]['text'])
    return json.loads(result['content'][0]['text'])
discovery = call('pcg_demo_describe')
page = call('pcg_demo_open')  # 打开 page['url']，不要打印凭据
state = call('pcg_demo_read_state')
```

## 六个工具：输入、输出、最小例子及恢复

| 工具 | 用途与输入 | 输出与最小调用 | 常见错误与恢复 |
|---|---|---|---|
| `pcg_demo_describe` | 发现 schema、实例和本地渲染边界；无参数 | `call('pcg_demo_describe')` → schema、instanceId、url、mcpUrl、readOnly、aiCallsPerFrame=0 | 连接失败先核对实例文件/PID，只重启自己拥有的隔离服务 |
| `pcg_demo_open` | 获取已有演示页；无参数 | `call('pcg_demo_open')` → url、instanceId、readOnly；由客户端打开 url | 服务未启动先按上节启动；不要重启正式画布 |
| `pcg_demo_read_state` | 读回真实阶段、图、资产、期望和实际显示；无参数 | `state=call('pcg_demo_read_state')` → 下节状态合同 | 无 viewer 回执先打开页面；failed 保留结果，先读 error，不重复提交 |
| `pcg_demo_select` | 切换受管结果；必填 `assetId`，字符串 1–128 | `call('pcg_demo_select', {'assetId':state['catalog'][0]['assetId']})` → 新状态；递增 selectionEpoch | ASSET_NOT_FOUND 重读 catalog；不要传文件路径。加载失败保留旧模型；手动切换关闭本轮自动跟随 |
| `pcg_demo_run` | 在本实例合成项目执行真实图；可选 recipe=rock/scatter（默认 rock）、seed=0..2147483647（0）、roughness=0..0.4（0.2）、count=1..1000（100）、minDistance=0..1000（0） | `state=call('pcg_demo_run', {'recipe':'rock','seed':22,'roughness':0.3})` → 立即返回 running 状态，随后读回。散布例子：`call('pcg_demo_run', {'recipe':'scatter','seed':17,'count':100,'minDistance':0.6})` | SESSION_BUSY 等已有任务终态；ISOLATION_UNAVAILABLE 修已有宿主能力，不降级；INSUFFICIENT_PLACEMENT 显式降低数量/间距后新运行 |
| `pcg_demo_cancel` | 只取消本实例精确运行；必填 runId，字符串 1–128 | `call('pcg_demo_cancel', {'runId':state['run']['runId']})` → cancelling/终态；保留既有模型 | STALE_RUN 重读身份；等待终态后新运行；不停止其他任务/服务 |

所有输入 schema 都拒绝未知字段。单请求最多 32768 bytes，严格 JSON，禁止重复 key/非有限数。MCP 工具错误以 `isError:true` 返回 code/message；HTTP API 的契约错误为非 2xx、code/message。不得把 tool HTTP 200 当几何成功。

## 运行、等待、读回、校验

```python
import time
state = call('pcg_demo_run', {'recipe':'scatter', 'seed':17, 'count':100})
run_id = state['run']['runId']
while True:
    state = call('pcg_demo_read_state')
    assert state['run']['runId'] == run_id
    if state['run']['status'] in ('succeeded','failed','cancelled'): break
    time.sleep(0.5)
assert state['run']['status'] == 'succeeded', state['run']['error']
# 浏览器实际绘制确认可以晚于几何完成；有上限地等待，失败时保留已有模型。
for _ in range(40):
    state = call('pcg_demo_read_state')
    viewer = state['viewer']
    if viewer['loaded'] and viewer.get('selectionEpoch') == state['selectionEpoch'] and viewer['displayed']['assetId'] == state['desired']['assetId']: break
    time.sleep(0.5)
else: raise RuntimeError('Browser did not acknowledge the selected real model')
```

状态有 `contractVersion:1`、`instanceId`、单调 `revision`、`selectionEpoch`、`autoFollow`、`run`、`graph.nodes/edges`、`catalog`、`desired`、`events` 和 `viewer`。`run` 包含外层 demo runId、真实 currentTask 完整 M2 handle、currentNodeId、stageIndex/stageCount、completedStages、status/error。每一阶段执行真实 M2 任务并 verify，成功即发布 GLB；Field 步骤保留关联几何并公开统计。没有完成后的动画回放，也没有人工制造阶段进度。

`rock` 图：primitive → attribute_read/noise_field → field_math → set_position → recompute_normals → publish_geometry。`scatter` 再加入独立 ground、scatter_points → instance_on_points → instance_transform。所有边与端口在页面可读图中显示。每个阶段是已有 M2 原子操作，没有新增正式节点或新算法。参数和错误按 [AGENT_GUIDE.md](AGENT_GUIDE.md) 的 M2 合同执行。

`desired` 是期望资产，不表示浏览器已加载；`viewer.displayed` 才是成功 GPU 上传并至少真实绘制一帧后的资产，需同时核对实例、selectionEpoch、assetId。新选择/运行期间保留旧模型并显示各自身份，不伪装为当前结果。回执还带每客户端单调 reportSequence，迟到的成功不能覆盖较新的 context-lost；相同请求可幂等重试。GPU 回执是浏览器自报展示状态，并非远端证明或几何验证的替代；M2 verify 和 SHA256 仍独立执行。

GLB 加载失败保持前一成功 GPU 场景；任务失败保留最后成功阶段；旧响应/旧 epoch 不覆盖新选择。WebGL context lost 会清实际显示身份，恢复后重新加载。只有展示控件（暂停/继续转台、切换产物），没有 DCC 视口操作。隐藏页面停止帧绘制和轮询，显示后恢复；转台帧不发网络请求，每 350ms 可见页状态轮询一次，不调用 AI。

`viewer.metrics` 是最近一次加载或展示控件变更时的绘制回执，`reportedAt` 标明采样时间；帧计数、角度不会按帧上传服务。每帧状态只存在浏览器本地，用于本地测试，不把回执快照当成连续遥测。

## 支持范围、预算与恢复

支持本次 M2 导出的 Mesh、PointSet、共享原型 InstanceSet，完整实例绘制，不采样成静态图。独立解码器与会话的严格 M2 子集不同：演示服务只接受已验证 M2 单网格导出。外部资源、贴图材质、动画、蒙皮、扩展不在支持范围，明确拒绝；不能声称通用 GLB 查看器。精确字节/拓扑/实例预算见 [查看器合同](../../pcg/DEMO_VIEWER_API.md) 和 [会话合同](../../pcg/DEMO_SESSION_API.md)。模型为中性颜色的几何展示。

缓存最多 128MiB、catalog 最多512项，单 GLB 最多64MiB；M2 保留任务上限256个，不自动清历史产物。容量到达保持失败及上一结果，正常关闭自己服务后用新目录启动，不清用户样例。宿主需已有 M2 验证过的 Windows 隔离运行时；不可用时图/样例可读，真实执行 fail closed。崩溃遗留 owner 标记需人工核对该 PID 已退出，不能自动抢占。

本地验证命令：`python -m unittest discover -s . -p 'test_pcg_demo_*.py' -t .`，`node --test test-pcg-demo-viewer.mjs`，`node test-pcg-demo-ui.mjs`。可用 `H3_TEST_PYTHON` / `PCG_TEST_PYTHON` 指向已有解释器、`CHROME_PATH` 指向已有浏览器。浏览器测试的截图/模型仅保存在本地测试目录；不上传素材或工程。测试 harness 可指定 `--exit-on-stdin-close` 并持有 stdin 管道，结束管道时仅优雅关闭该演示服务及其自有任务；普通启动不要带此标志。
