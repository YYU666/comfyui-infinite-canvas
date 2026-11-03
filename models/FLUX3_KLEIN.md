# FLUX 3 Image Klein 可选接入

文生图与图生图的模型选择中可选 `FLUX 3 Image Klein INT8`。保留原有模型默认值；Klein 支持 1MP、2K、4K 选择，2K/4K 指长边 2048/4096，输出保持所选比例或首张参考图比例。

本接入已通过构建、隔离工作流/界面测试及本机 ComfyUI 节点参数校验；**尚未完成真实 GPU 生图验收**，不承诺具体显存、速度、画质或 4K 成功率。

## 文件与来源

官方来源：[black-forest-labs/flux-3-image-klein-comfy](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy)，固定 revision `9d36114cf7a2e03a45c28f5cc4987d20ebfdb6c1`。四个文件共 20,770,759,307 字节，约 19.34 GiB。精确大小与 SHA256 记录在 [flux3-klein.json](flux3-klein.json)，已与官方 LFS 元数据核对。

| 放入 `ComfyUI/models/` 的相对路径 | 用途 |
| --- | --- |
| `diffusion_models/flux3-image-klein-int8-convrot.safetensors` | Klein distilled INT8 图像模型 |
| `text_encoders/qwen3vl_4b_int8_convrot.safetensors` | 图像模型文本编码器 |
| `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors` | PUP 提示词扩写模型 |
| `vae/flux2-vae.safetensors` | 图像 VAE |

在官方仓库接受适用条款后下载这些指定文件，保持名称与目录不变；不要覆盖不同内容的同名已有模型。扩写模型属于这条工作流的依赖，单独下载主模型不能完成接入。现有 MOSS 或其他模型使用的相似名称编码器、VAE 不视为上述文件的替代品。

这是独立的可选模型资料，**未加入安装器 `core-h3` / `full` 配置**，也不提供 `--profile flux3-klein` 参数。普通安装不额外下载这四项。其他机器需自行准备相同文件，并通过节点依赖检查；仅有此 JSON 不会自动安装模型。

## ComfyUI 与工作流

工作流使用 BFL 的 distilled 参数：16 步、Euler/simple、CFG 1，先用 PUP 扩写提示词，再编码生成。ComfyUI 需支持 `flux3` 文本编码器类型和对应的 TextGenerate、参考编码、尺寸处理等节点；提交前检查缺失模型与必需节点并提示，检查失败不入队。

图生图可使用最多十张有序参考。PUP 使用统一预览尺寸的副本，图像模型使用各张原始参考；参考编码尺寸与输出尺寸分开，避免继承旧 Qwen 设置导致输出分辨率错误。

当前不支持将 Qwen 的局部裁切、遮罩，以及 Qwen/Krea2 LoRA 直接用于 Klein，遇到这些配置会阻止生成。原 Qwen 流程继续保留，局部遮罩编辑仍使用它。

## 许可证与再分发

权重模型卡明确标记为 **FLUX Kommunity License**，以[固定版本的作者条款](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/blob/9d36114cf7a2e03a45c28f5cc4987d20ebfdb6c1/LICENSE.md)为准。工作台 Apache-2.0 许可不覆盖模型权重；本仓库只提供接入代码、文件名、来源与校验信息，不分发权重。

PUP 提示词摘录来自 BFL 的 Apache-2.0 代码仓库，其来源和修改说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。代码许可证与权重许可证分别适用。
