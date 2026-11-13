# 绿幕白模

把一段视频做成「纯绿幕 + 白模」底板。人物，以及提示词里点名的前景物体（默认还有杆子），留成没有贴图的白模；其余全部变成纯 `#00FF00`，包括白地板。成片的宽、高、帧数和帧率跟输入一致。

第一段要对上的片子，是底部大约 37% 为白地板、色度键抠不掉的镜头。地板不在保留提示里，所以变成绿；人物扶着的杆子在保留提示里，所以留下。

分割只走本机 ComfyUI 上的官方 SAM3，也就是角色替换已经在用的那条链路：`CheckpointLoaderSimple`（`sam3.1_multiplex_fp16.safetensors`）、`CLIPTextEncode`、`SAM3_Detect`、`H3RelaySelectMask`、`SAM3_VideoTrack`、`SAM3_TrackToMask`、`H3RelayRecoverMasks`、`H3RelayExpandMask`。每个提示词单独一条轨迹，`max_objects` 为 1，再把遮罩相加。这样杆子不会因为人更大而被丢掉。不访问云，也不下载新模型。

这条 SAM3 图只有文字条件。`SAM3_Detect` 和 `SAM3_VideoTrack` 没有点或框输入，所以节点不接收点选或框选。要留下的东西写进 `keepPrompts`。

遮罩扩张和羽化在工作台进程里用 FFmpeg 做，参数数组，不经过 shell。SAM 图里的 `H3RelayExpandMask.expansion_px` 固定为 0，避免和 `maskGrow` 扩张两次。白模以外的像素由 `geq` 写成精确的绿，编码用 `libx264rgb` / `rgb24` / `qp 0`。yuv420 会把 `#00FF00` 偏掉，所以这里不用它。

帧数对齐和绿幕扣像在 `05b5e30` 里的规则相同：输出帧数等于输入帧数；遮罩偏短时先克隆最后一帧，再 `fps`，再 `trim` 到这个帧数（FFmpeg 7.1 上 `fps` 不能放在 `tpad` 前面）；封装用 `-r` 和 `-fps_mode cfr`。校验按解码出来的帧数、宽、高，不用两条时间轴的时长差去误杀成片。

## 1. 节点

添加节点菜单的「剪辑合成」里，排在「绿幕扣像合成」后面。

| 项 | 值 |
| --- | --- |
| 预设 | `video_white_plate` |
| React 类型 | `videoWhitePlate` |
| 标题 | 绿幕白模 |
| 输入 | `v1`，一段视频 |
| 输出 | 右侧 `ref`。导出后旁边多一个标题为「绿幕白模成片」的视频素材节点 |

## 2. 参数

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `keepPrompts` | `["person", "pole"]` | 要留下的文字提示，1–4 项。也可以写成 `"person, pole"` |
| `maskGrow` | `8` | 遮罩向外扩张的像素，0–64 |
| `maskFeather` | `2` | 遮罩羽化半径，0–32。要检查纯绿和纯白时用 0 |
| `shadeMode` | `flat` | `flat` 是纯白 `#FFFFFF`；`shaded` 按亮度做成 210–255 的灰白，形体还看得出来 |
| `greenColor` | `#00FF00` | 背景色，`#RRGGBB` |

没有点、框参数。

## 3. 接到角色替换

角色替换的源视频端口只接受视频素材节点，不接受视频处理节点本身。绿幕白模导出完成后会把成片登记成项目里的视频素材，并在旁边放上「绿幕白模成片」。`canvas_get_state` 里的 `plateResultNodeId` 就是这个素材。

接法：

1. `canvas_create_node`，预设 `video_white_plate`。
2. 把源视频连到它的 `v1`。
3. `canvas_generate_node`，`wait: false`，再用 `canvas_get_state` 等到 `status` 为 `done`。
4. 把 `plateResultNodeId` 连到角色替换节点的 `guide`（上方源视频）。身份图仍连 `identity`（下方）。
5. 从绿幕白模节点自己的输出口往角色替换拖线也可以。导出之后，这条线会改接到「绿幕白模成片」，而不是把处理节点直接塞进 SAM3。

还没导出就去接角色替换，会提示先导出。视频编辑、节奏和绿幕扣像仍然不能直接接到生成节点。

## 4. 页面桥

工具名不变。`canvas_update_node` 的 `settings` 使用上面五个字段。`canvas_get_state` 不接受 `includeNodes`。`canvas_wait_for_node` 仍不在页面桥上。

```jsonc
canvas_create_node { "preset": "video_white_plate", "title": "绿幕白模" }
canvas_update_node {
  "nodeId": "<绿幕白模节点>",
  "settings": {
    "keepPrompts": ["person", "pole"],
    "maskGrow": 8,
    "maskFeather": 2,
    "shadeMode": "flat",
    "greenColor": "#00FF00"
  }
}
```

## 5. 重启

运行中的 8790 要先重新构建前端，再重启工作台进程，才会加载这个节点和 `/api/video-plate`。这次没有重启 8790、8188 或 8189。
