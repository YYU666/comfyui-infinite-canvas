# H3-Image 在画布直接生成

画布右键添加「H3-Image 文生图」或「H3-Image 多图编辑」。现有文生图、图生图节点也可以在模型下拉框选择「MiniMax H3 Image INT8」。生成结果使用画布原有任务队列、结果图片与保存流程，可继续连接其他节点，无须去 ComfyUI 后台搬图。

## 使用

- 文生图：输入详细画面描述，选择比例和约 4MP / 16MP，点击本地生成。默认 4MP，正方形为 2048 × 2048。
- 图生图：把图片连接到参考图片端口，支持最多 10 张；图1决定输出比例。可调整图片顺序，并在提示词中用图1、图2指定用途。输出总像素由 H3-Image 输出尺寸控制。
- 固定 6 步、Euler / Simple、CFG 1。直接使用提示词，不额外运行提示词扩写模型或调用云 API。
- H3-Image 使用独立 Image VAE；不兼容 H3 视频 VAE、Qwen/Krea2 LoRA、Qwen 局部遮罩及裁切。已连接遮罩时请先断开并清除裁切设置，或继续使用 Qwen。
- 24GB 显卡建议先用约 4MP；16MP 将显著增加显存、系统内存与时间需求，不能仅由模型文件能装入显存推断可运行分辨率。

## 其他电脑

需同时更新画布和其连接的 ComfyUI。ComfyUI 必须注册 `MiniMaxH3ImageConditioning` 和 `minimax` CLIP 类型；仅在另一个端口的 ComfyUI 中装好模型不会影响当前画布的连接。画布提交前会检查当前连接的节点和文件列表，并显示具体缺项。

将以下官方 Comfy-Org 权重放在 ComfyUI 对应目录或已配置的外置模型目录：

| 目录 | 文件 |
| --- | --- |
| diffusion_models | minimax_h3_image_pruned_int8_convrot.safetensors |
| text_encoders | qwen3vl_32b_minimax_h3_int8_convrot.safetensors |
| vae | minimax_h3_image_vae_fp16.safetensors |

32B 文本编码器与原 MiniMax H3 共用，已有正确版本可复用。三份文件的[官方直接下载地址、字节数、SHA256 和兼容说明](../models/H3_IMAGE.md)已集中登记。已核验 ComfyUI 0.45.0；0.42.5 不包含新图片节点，升级画布不会自动升级 ComfyUI。模型受 MiniMax-H3-Image Community License Agreement 约束；模型权重不随画布代码分发。保留原有模型和节点，不自动改变其他电脑的磁盘路径或下载大权重。

Agent 在可见画布上使用 `h3_image` 和 `h3_image_edit` 预设，步骤见 `docs/AGENT_MANUAL.md` 配方 D：创建、连接、`canvas_generate_node`（`wait:false`），再轮询 `canvas_get_state`。不要改用 `apply`／`wait` 或向 8188 直接提交。对应参数分别为 `imageModel: h3_image` / `qwenModel: h3_image`，通用尺寸参数 `h3ImageResolution: 4MP | 16MP`。

## 可导入节点包

其他电脑暂未更新画布界面时，可从 [v1.0.11 Release](https://github.com/YYU666/comfyui-infinite-canvas/releases/tag/v1.0.11)下载 `refmuse-h3-image-1.0.0.h3pack`，在「节点库 → 本地节点 / 导入工作流」导入。也可在源码目录构建：

```text
python scripts/build_h3_image_pack.py --output refmuse-h3-image-1.0.0.h3pack
```

包内提供文生图，以及 1、2、3、4 张参考图片的独立编辑节点。按实际图片数量选节点，图片连接到对应图号端口；包内端口均为必填。默认输出 2048 × 2048，可分别选择宽高与种子；原生节点则支持最多 10 张参考、图1比例和 4MP / 16MP 档位。节点包不要求额外安装自定义 ComfyUI 插件，但画布实际连接的 ComfyUI 仍须具备上述官方节点和三份模型。

包只包含工作流配置及说明，没有模型权重、素材、个人路径或 API 密钥。画布更新后的扩展依赖下载使用 `models/h3-image-sources.json` 固定的官方版本和 SHA256；旧版画布可按上方官方来源自行放置模型。导入包不会自动升级 ComfyUI，也不会自动下载大型权重。
