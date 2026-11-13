# 视频节奏节点（恒定速度 + 时间重映射）

在 v1.0.10（`88d5739`）上接入 E1「视频编辑」，并增加两条独立的视频节奏节点。节奏不写进视频编辑节点。没有 3D、表达式或 AOV。每个节点一条视频流。曲线只有关键帧，插值是线性或缓入 / 缓出 / 缓入缓出。

后端用参数数组调用 FFmpeg，跑在工作台 Python 进程里，不进 ComfyUI 队列。取消只杀该作业的 ffmpeg 进程。

## 1. 添加节点菜单

右键菜单按类别分组：

| 类别 | 内容 |
| --- | --- |
| 媒体 | 图片、视频、音频、视频链接下载、PureRef |
| 图像生成 | 文生图、图生图、局部遮罩、图片高清；本机启用时含角色四视图、母图编辑 |
| 视频生成 | 视频生成、视频高清二采；本机启用时含角色替换 |
| 颜色 | 图片调色 |
| 视频节奏 | 恒定速度、时间重映射 |
| 剪辑合成 | 视频编辑、绿幕扣像合成、绿幕白模、图像混合、RGBA 通道合并 |
| 3D | 仅当对应预设已注册时显示 |
| 辅助 | 电子主美、文本备注、其余本机工具、已安装的节点工具 |

## 2. 预设与页面桥

页面桥工具名不变。`canvas_wait_for_node` 仍只在 `src/canvas-mcp.js`，页面桥不转发它。导出用 `canvas_generate_node { wait: false }`，再用 `canvas_get_state` 看 `status`。`canvas_get_state` 不接受 `includeNodes`。

### 恒定速度 `video_speed` / 类型 `videoSpeed` / 标题「恒定速度」

```jsonc
canvas_create_node { "preset": "video_speed", "title": "升格" }
canvas_connect_nodes { "sourceId": "<视频>", "targetId": "<id>" }   // 自动端口 v1
canvas_update_node { "nodeId": "<id>", "settings": { "speed": 0.5, "rhythmAudio": "preserve" } }
canvas_generate_node { "nodeId": "<id>", "wait": false }
canvas_get_state { "nodeId": "<id>" }
```

`settings` 与节点上的控件是同一组字段：

| 字段 | 含义 |
| --- | --- |
| `speed` | 数字，0.25–4。`0.5` 是两倍慢放（升格，每帧重复一次），`2` 是两倍快放（隔帧取样），`1` 是原速。毫秒级以外的无理数会被拒绝 |
| `rhythmAudio` | `preserve` 保持音高（ffmpeg `atempo`，默认）、`stretch` 拉长并变调、`mute` 静音。源没有音轨时导出为静音 |

成片帧率等于源帧率。输出帧数 = round(源帧数 / speed)。输出帧 `i` 取源帧 `min(N-1, floor(i * N / 输出帧数))`。

### 时间重映射 `video_time_remap` / 类型 `videoTimeRemap` / 标题「时间重映射」

界面和 agent 编辑**同一个** `remapKeyframes` 数组。

```jsonc
canvas_create_node { "preset": "video_time_remap" }
canvas_connect_nodes { "sourceId": "<视频>", "targetId": "<id>" }
canvas_update_node {
  "nodeId": "<id>",
  "settings": {
    "remapKeyframes": [
      { "output": 0, "source": 0, "interpolation": "linear" },
      { "output": 2, "source": 2, "interpolation": "linear" },
      { "output": 3, "source": 2, "interpolation": "linear" }
    ]
  }
}
canvas_generate_node { "nodeId": "<id>", "wait": false }
canvas_get_state { "nodeId": "<id>" }
```

上面就是「在 t=2 秒定格 1 秒」：0–2 秒 1:1 播放，2–3 秒源时间停在 2 秒。节点上的「在 2 秒定格 1 秒」写入同一数组。

| 字段 | 含义 |
| --- | --- |
| `output` | 成片时间，秒，X 轴。第一帧必须是 0，之后严格递增，精确到毫秒，最大 600 秒 |
| `source` | 源时间，秒，Y 轴。不能小于上一帧（倒放仍用视频编辑的 `reverse`） |
| `interpolation` | 这一帧到下一帧的插值：`linear`、`easeIn`（t²）、`easeOut`（1-(1-t)²）、`easeInOut`（smoothstep t²(3-2t)）。最后一帧的插值不使用。缺省 `linear` |

斜率 = Δsource / Δoutput。等于 0 是定格，小于 1 是慢放，大于 1 是快放，斜率变化就是加减速。成片帧率等于源的恒定帧率；帧 `i` 的采样时刻是 `i/fps`，再取最近的源帧（并列取较早的一帧）。本阶段重映射成片无声，且只接受恒定帧率。源时间超出素材时长会在导出时失败。

`canvas_get_state` 对节奏节点额外给出 `speed` / `rhythmAudio` 或 `remapKeyframes`，以及 `rhythmJobId`、`rhythmResultAssetPath`、`rhythmResult`（含 `frames`）、`rhythmStale`。

## 3. 下游连接

视频处理节点（视频编辑、恒定速度、时间重映射、绿幕扣像合成、绿幕白模）的成片可以从右侧 `ref` 连到：

- 另一个节奏节点的 `v1`
- 视频编辑的 `v1`–`v8`（音频仍走 `a1`）
- 绿幕扣像合成的 `fg` 或 `bg`
- 绿幕白模的 `v1`

上游还没导出时可以先连线；导出时若上游没有成片路径，会返回「请先导出上游」。

官方生成节点（含 SAM3 角色替换）仍然只接受媒体节点。视频编辑、节奏和绿幕扣像直接连到生成节点会被拒绝，提示先把成片导入为视频素材再连。绿幕白模导出后会登记成视频素材，可以从该素材或节点本身接到角色替换，见 docs/VIDEO_WHITE_PLATE_NODE_2026_11_13.md。

## 4. 后端

| 方法 | 路径 |
| --- | --- |
| POST | `/api/video-rhythm/jobs` `{projectId, nodeId, input, operation: "speed"\|"remap", settings}` |
| GET | `/api/video-rhythm/jobs/vry_<32hex>` |
| POST | `/api/video-rhythm/jobs/vry_<32hex>/cancel` `{projectId}` |
| POST | `/api/video-rhythm/jobs/vry_<32hex>/commit` `{projectId, revision}` |

`input` 只能是当前项目的 `assets/<sha256>.(mp4|mov|webm)`。结果由当前页面经版本化素材通道写回，后端不改 `project.json`。

## 5. 测试

```bash
python -m unittest test_video_edit_document test_video_edit_ffmpeg test_video_rhythm -v
node test-video-edit.mjs
node test-video-rhythm.mjs
```

Linux 上若 `python` 不在 PATH，节点测试用 `H3_TEST_PYTHON=python3`。
