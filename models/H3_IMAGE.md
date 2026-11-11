# MiniMax H3-Image 模型下载与配置

H3-Image 用同一组权重进行文生图和多图编辑。它是可选图片模型，不属于 `core-h3` 的七个视频模型，也不属于原有 `full` 33 项清单。已有画布只补 H3-Image 时，无须重新下载整套视频模型。

## 官方地址与文件

- [MiniMax 官方项目](https://github.com/MiniMax-AI/MiniMax-H3-Image)
- [MiniMax 原始权重](https://huggingface.co/MiniMaxAI/MiniMax-H3-Image)
- [Comfy-Org 的 ComfyUI 权重](https://huggingface.co/Comfy-Org/MiniMax-H3-Image)

下面是画布当前支持的 **INT8 ConvRot** 配置。下载链接固定在 Comfy-Org 提交 `892de7cb61df49753bf15145a711154803a355cb`；文件名和目录请保留。不要整库下载：仓库还包含其他精度和重复格式。

| ComfyUI/models 下的目标目录 | 文件与直接下载地址 | 字节数 / 约 GB |
| --- | --- | --- |
| diffusion_models | [minimax_h3_image_pruned_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/892de7cb61df49753bf15145a711154803a355cb/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors) | 20,979,314,802 / 20.98 |
| text_encoders | [qwen3vl_32b_minimax_h3_int8_convrot.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/892de7cb61df49753bf15145a711154803a355cb/text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors) | 27,141,342,152 / 27.14 |
| vae | [minimax_h3_image_vae_fp16.safetensors](https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/892de7cb61df49753bf15145a711154803a355cb/vae/minimax_h3_image_vae_fp16.safetensors) | 1,168,505,312 / 1.17 |

三份合计约 49.29 GB（45.90 GiB）。原 H3 视频工作流中的同名、同哈希 32B INT8 文本编码器可以复用，此时只需新增约 22.15 GB（20.63 GiB）。**必须使用新图片 VAE**，视频 VAE 不能替代。直接提示词模式不需要下载额外的提示词扩写模型，也不需要云端 API 密钥。

SHA256：

```text
83eb140f1ff95c068f8a6886e6d3f3d0d4ab2e07bb2fe6d2ef992a51146ee622  minimax_h3_image_pruned_int8_convrot.safetensors
bc2ced0fbea64757fa9acddccfc0b3f4819d1dcf1da6c124d690d368be283923  qwen3vl_32b_minimax_h3_int8_convrot.safetensors
d80e9c2e5cfc9844869961ff5a58c9a9e52182df6bfb30b26018dd7f348721af  minimax_h3_image_vae_fp16.safetensors
```

在 Windows PowerShell 可用 `Get-FileHash -Algorithm SHA256 -LiteralPath '<模型文件完整路径>'` 核对。新图片模型和 VAE 的机器可读下载元数据见 [h3-image-sources.json](h3-image-sources.json)，复用编码器同时登记在原有 [manifest.json](manifest.json)。`install_models.py` 的旧 profile 不会安装上述两份新增文件；请手动放到对应模型目录，或沿用自己已有的 `extra_model_paths.yaml` 外置目录。

## ComfyUI 与画布必须连接同一套运行环境

已核验 ComfyUI **0.45.0**、提交 `0228a9d73cd7c2daf8f61fe13d56b12efe307171`。0.42.5 不包含新图片节点；只更新画布不会升级 ComfyUI。请保存项目、等待队列空闲后，按 [ComfyUI 官方更新说明](https://docs.comfy.org/installation/update_comfyui)更新现有便携版及其 Python 依赖，再重启 ComfyUI。

画布实际连接的 ComfyUI 需注册 `MiniMaxH3ImageConditioning`，`CLIPLoader` 需提供 `minimax` 类型，三个加载器的模型列表需包含上面的文件。若把新模型装到另一个端口，而画布仍连接旧后台，画布无法使用它。提交前会显示当前连接中具体缺失的节点或文件；遇到缺项应修复该后台，不要重复点击生成。

## 选择与切换模型

更新画布后刷新页面。在右键添加菜单选择「H3-Image 文生图」或「H3-Image 多图编辑」，也可在已有文生图的「生图模型」或图生图的模型下拉框中选择「MiniMax H3 Image INT8」，随时切回原模型。

文生图输入详细提示词；编辑时把图片连到参考端口，用「图1」「图2」指定用途，按列表顺序对应模型的 `<Picture 1>`、`<Picture 2>`。图1决定编辑结果比例。生成任务与结果直接保存在画布的原有流程中，无须去 ComfyUI 后台搬图。完整操作、便携节点包与限制见 [画布 H3-Image 使用说明](../docs/h3-image.md)。

默认约 4MP（正方形 2048×2048）、6 步、Euler / Simple、CFG 1；可切到约 16MP。24GB 显卡建议从 4MP 开始；16MP 的显存、系统内存与耗时需根据机器实测。当前适配不接受负面提示词、其他图片模型的 LoRA、Qwen 遮罩或局部裁切。其他精度权重不能仅改名为 INT8 文件使用。

## 授权

H3-Image 采用独立的 [MiniMax-H3-Image Community License Agreement](https://huggingface.co/MiniMaxAI/MiniMax-H3-Image/blob/main/LICENSE)，不是工作台的 Apache-2.0，也不能套用 H3 视频模型的收入门槛。协议含适用地区限制；年化收入超过 100 万美元，或向第三方提供托管服务时，需事先取得 MiniMax 书面授权。公开部署和再分发还须遵守其署名、通知及使用限制，以官方完整协议为准。本项目仅提供适配代码和下载链接，不分发权重。
