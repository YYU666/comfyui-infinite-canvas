# 绿幕扣像合成

在视频节奏节点之外增加一个画布节点：把绿幕前景叠到一张图或另一段视频上。不做调色，不做转场，不做 3D。每个节点仍是一条成片视频流。

后端用参数数组调用 FFmpeg（`chromakey` + `despill` + `overlay`），跑在工作台 Python 进程里，不进 ComfyUI 队列。滤镜字符串只由校验过的数字和 `#RRGGBB` 拼出来。取消导出只杀该作业的 ffmpeg 进程。

## 1. 节点

添加节点菜单的「剪辑合成」里，排在「视频编辑」后面。

| 项 | 值 |
| --- | --- |
| 预设 | `video_chroma_key` |
| React 类型 | `videoChromaKey` |
| 标题 | 绿幕扣像合成 |
| 前景输入 | `fg`，只接受视频（素材，或视频编辑 / 恒定速度 / 时间重映射 / 本节点的成片） |
| 背景输入 | `bg`，图片素材，或视频素材 / 上述处理节点的成片 |
| 输出 | 右侧 `ref`，可再连到视频编辑、节奏节点或其他绿幕节点 |

图片会自动接到 `bg`。第一段视频自动接到空着的 `fg`，`fg` 已被占用时自动接到 `bg`。两段都是视频时，请显式传 `targetHandle`：`"fg"` 或 `"bg"`。

官方生成节点（含 SAM3 角色替换）仍然只接受媒体节点。处理节点的成片要先导出，再导入成视频素材，才能接进生成器。

## 2. 页面桥

工具名不变。导出用 `canvas_generate_node { wait: false }`，再用 `canvas_get_state` 看 `status`。`canvas_get_state` 不接受 `includeNodes`。`canvas_wait_for_node` 仍不在页面桥上。

界面和 `canvas_update_node` 改的是同一组字段。下面是 480×832、24fps 的绿幕人物叠到一张 9:16 夜景静帧（例如 720×1280）上，用默认参数即可：

```jsonc
canvas_create_node { "preset": "video_chroma_key", "title": "绿幕扣像合成" }
canvas_connect_nodes { "sourceId": "<绿幕视频>", "targetId": "<id>", "targetHandle": "fg" }
canvas_connect_nodes { "sourceId": "<夜景图片>", "targetId": "<id>", "targetHandle": "bg" }
canvas_update_node {
  "nodeId": "<id>",
  "settings": {
    "keyColor": "#00FF00",
    "similarity": 0.2,
    "blend": 0.08,
    "despill": 0.5,
    "choke": 0,
    "feather": 0,
    "scale": 1,
    "offsetX": 0,
    "offsetY": 0,
    "anchor": "center",
    "backgroundFit": "cover",
    "outputSize": "background",
    "chromaAudio": "preserve",
    "startOffset": 0,
    "previewTime": 0
  }
}
canvas_generate_node { "nodeId": "<id>", "wait": false }
canvas_get_state { "nodeId": "<id>" }
```

`canvas_get_state` 会带回上表每个字段，以及 `chromaJobId`、`chromaResultAssetPath`、`chromaResult`（含 `frames`、`width`、`height`、`fps`、`audio`、`overlay`）、`chromaStale`。

### 字段

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `keyColor` | `#00FF00` | 键色，`#RRGGBB`。节点上有取色器和十六进制输入；「吸取绿幕」会先渲染未抠像的前景帧，点一下写入同一个字段 |
| `similarity` | `0.2` | 0–1，步进 0.001。ffmpeg `chromakey` 的 similarity，`yuv=0`（按 RGB 比）。纯绿约 0.12 就能去掉；实拍可试 0.2–0.35 |
| `blend` | `0.08` | 0–1。边缘柔和，对应 ffmpeg 的 blend |
| `despill` | `0.5` | 0–1。溢色抑制强度，ffmpeg `despill` 的 mix。键色里蓝色严格强于绿色时用 `type=blue`，否则 `type=green` |
| `choke` | `0` | 0–8 的整数。抠完后按前景像素对 alpha 做几次 3×3 腐蚀 |
| `feather` | `0` | 0–16 的整数。alpha 的 boxblur 半径，单位也是前景像素 |
| `scale` | `1` | 0.05–8。`1` 是前景的原始像素，不是「撑满画面」。480×832 叠到 720×1280 时人物居中，四周露出夜景。要撑满高度可用 `scale ≈ 输出高 / 前景高`（1280/832 ≈ 1.538） |
| `offsetX` / `offsetY` | `0` | 锚点算完后再加的像素，-4096–4096 |
| `anchor` | `center` | `center`、`top`、`bottom`、`left`、`right`、`topLeft`、`topRight`、`bottomLeft`、`bottomRight` |
| `backgroundFit` | `cover` | 背景放进成片画幅的方式：`cover` 覆盖居中裁切，`contain` 完整放入并补黑边，`stretch` 拉满 |
| `outputSize` | `background` | `background`：成片宽高取背景，奇数向下取偶数（721×1281 → 720×1280）。`foreground`：改跟前景，同样取偶数。宽高取偶数后须在 16–4096 |
| `chromaAudio` | `preserve` | `preserve` 保留前景音轨（aac）；`mute` 静音。背景没有声音。前景本来就没音轨时结果也是静音 |
| `startOffset` | `0` | 秒，0–600，精确到毫秒。只对视频背景有意义：从背景的这个时间开始铺。超过背景时长时整段停在背景最后一帧。静帧忽略 |
| `previewTime` | `0` | 秒。只决定「预览当前帧」看哪一帧，不改变导出。帧号是 `min(N-1, floor(t × fps))` |

成片帧率 = 前景恒定帧率，成片帧数 = 前景帧数，因此时长跟前景。静帧背景按这个帧率循环。视频背景更短时用最后一帧补上，更长时被成片时长截断。编码是 H.264、`yuv420p`、恒定帧率、`veryfast`、CRF 16。前景必须是恒定帧率，1–20000 帧。

默认落点（480×832 前景，720×1280 背景，scale 1，居中）：

```text
成片 720×1280
前景仍是 480×832
overlay x = (720-480)/2 = 120
overlay y = (1280-832)/2 = 224
```

## 3. 预览一帧

节点上有三个按钮，都不跑完整导出：

| 按钮 | 模式 | 画面 |
| --- | --- | --- |
| 预览合成 | `composite` | 当前参数下的合成静帧 |
| 棋盘格 | `matte` | 同一张键，背景换成灰白棋盘，用来看边缘 |
| 吸取绿幕 | `foreground` | 未抠像的前景，点像素把颜色写回 `keyColor` |

对应接口（页面在用，不是新的页面桥工具）：

```jsonc
POST /api/video-chroma/preview
{
  "projectId": "prj_...",
  "nodeId": "videoChromaKey-...",
  "foreground": "assets/<sha256>.mp4",
  "background": "assets/<sha256>.png",
  "time": 0,
  "mode": "composite",
  "settings": { "schemaVersion": 1, "keyColor": "#00FF00", "similarity": 0.2 }
}
```

返回 `{ width, height, frame, time, mode, pngBase64 }`。`settings` 里缺的字段用上表默认值。这个请求在工作台进程里同步跑，不进导出队列，也不写 `project.json`。

## 4. 导出接口

| 方法 | 路径 |
| --- | --- |
| POST | `/api/video-chroma/jobs` |
| GET | `/api/video-chroma/jobs/vck_<32hex>` |
| POST | `/api/video-chroma/jobs/vck_<32hex>/cancel` `{projectId}` |
| POST | `/api/video-chroma/jobs/vck_<32hex>/commit` `{projectId, revision}` |

作业体：

```jsonc
{
  "projectId": "prj_...",
  "nodeId": "videoChromaKey-...",
  "foreground": "assets/<sha256>.mp4",
  "background": "assets/<sha256>.png",
  "settings": {
    "schemaVersion": 1,
    "keyColor": "#00FF00",
    "similarity": 0.2,
    "blend": 0.08,
    "despill": 0.5,
    "choke": 0,
    "feather": 0,
    "scale": 1,
    "offsetX": 0,
    "offsetY": 0,
    "anchor": "center",
    "backgroundFit": "cover",
    "outputSize": "background",
    "audio": "preserve",
    "startOffset": 0
  }
}
```

画布字段 `chromaAudio` 在这份 settings 里叫 `audio`。前景只能是 `assets/<sha256>.(mp4|mov|webm)`。背景还可以是 `png`、`jpg`、`jpeg`、`webp`。结果由当前页面经版本化素材通道写回，后端不改 `project.json`。

## 5. 测试

```bash
python -m unittest test_video_edit_document test_video_edit_ffmpeg test_video_rhythm test_video_chroma -v
node test-video-edit.mjs
node test-video-rhythm.mjs
node test-video-chroma.mjs
```

Linux 上若 `python` 不在 PATH，节点测试用 `H3_TEST_PYTHON=python3`。

## 6. 还没做

- 颜色类节点仍然是空的。
- 处理节点的成片不能直接接进官方生成器 / SAM3，需要先变成视频素材节点。
- 预览不在页面桥工具列表里，只能在当前节点上点，或直接调上面的 HTTP。
- 没有垃圾遮罩、没有逐帧键色动画。收缩只做腐蚀，不做反向膨胀。
- 前景不接受可变帧率。背景音频不会保留。
