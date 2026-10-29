# 模型下载源与 Agent 安装指令

本文件配合 `manifest.json` 使用。当前清单为 **33 个去重文件，164.803 GiB**。模型权重不放入 GitHub；优先从下列夸克原分享中只下载点名文件，不转存或下载整个分享。

下载、商用或再分发前必须另读 [`LICENSES.md`](LICENSES.md) 与 [`licenses.json`](licenses.json)。夸克仅是镜像，不授予额外权利；H3、Krea 2、Qwen Image 2.1、Identity Edit V2 和 Civitai 单项模型各有独立限制，未知项不得推定可商用或可再分发。

“已确认”表示已在分享中看到该文件；“待搜索”表示原分享存在，但尚未逐项确认目标文件。不要以相似名称、旧版或其他量化版本代替清单中的权重。

## 下载源索引

| 编号 | 原始下载入口 | 用途与核实状态 |
|---|---|---|
| Q-H3 | https://pan.quark.cn/s/9ec095b95838 | H3 主模型包；主模型、32B 编码器、音频／视频 VAE、角色替换 LoRA 已确认。 |
| Q-H3-EXTRA | https://pan.quark.cn/s/b9409d65ed09 | H3 局部重绘／补充包；8-step FL2V Turbo 已确认，其余 H3 Turbo、INT8 VAE、SAM3.1 待 Agent 在分享内逐项搜索。 |
| Q-QWEN | https://pan.quark.cn/s/3df73f2e9f00 | Qwen 2.1 主模型、8B 编码器、VAE、写实 LoRA 已确认。 |
| Q-KREA | https://pan.quark.cn/s/83b5ad9265e8 | Krea2 Turbo、4B 编码器、VAE、写实／亚洲／奇幻现实／复古动漫／水彩 LoRA 已确认。 |
| Q-MOSS | https://pan.quark.cn/s/70e57d93e32d | MOSS 主模型、9B 编码器、FLUX2 VAE、SeedVR2 VAE 已确认；其中 SeedVR2 主模型为 7B，不是本清单需要的 3B。 |
| Q-QUAD | https://pan.quark.cn/s/4b5a36d50e9c | 四视图原视频模型分享；目标 LoRA 尚未在分享内逐项核实，搜不到时使用官方 H-QUAD。 |
| O-MUSE | https://civitai.com/models/2741166 | Muse 作者原页，选择 V3.0 Turbo。**当前公开文件的文件名和大小与本机 FP8 权重不一致，不能直接冒充本清单版本；若必须字节级复现，请保留原有权重或补充确切 FP8 来源。** |
| O-IDENTITY | https://huggingface.co/conradlocke/krea2-identity-edit/resolve/main/krea2_identity_edit_v2.safetensors | Identity Edit V2 官方权重。 |
| O-QUAD | https://huggingface.co/Alissonerdx/CharacterSheet/resolve/main/QuadView_krea2_v1.safetensors | 四视图官方权重，下载后需按清单加 `Krea2-四视图` 前缀。 |
| O-SEED3B | https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors | SeedVR2 3B 官方权重。 |
| O-SAM | https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors | SAM3.1 官方备用。 |
| O-H3-UP | https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors | H3 latent 高清模型官方备用。 |
| O-H3-COMFY | https://huggingface.co/Comfy-Org/MiniMax-H3 | H3 主模型、Turbo LoRA、32B 文本编码器和三个 VAE 的官方 ComfyUI 权重；核心七项均已核对文件名、字节数及 LFS SHA256。 |

## 核心 H3 安装

新用户先安装 `core-h3` 七项，而不是默认下载完整 33 项。进入 O-H3-COMFY 的 `Files and versions`，按 `manifest.json` 中 `profiles.core-h3.files` 的七个路径下载，保持相对路径和文件名不变；也可在 `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/` 后拼接目标相对路径。七项都有官方 SHA256，损坏或错版会被校验器拒绝。

## 33 个文件的来源、搜索名与目标位置

下表的“目标路径”均相对于 `ComfyUI/models/`。下载来源若与子目录结构不同，以本表目标路径为准。H3 的 10 个文件优先使用 O-H3-COMFY，表内夸克入口仅作备用；官方文件的 SHA256 已登记在 `manifest.json`。

| # | 目标路径 | 来源 | 分享内搜索名／重命名说明 |
|---|---|---|---|
| 1 | `checkpoints/sam3.1_multiplex_fp16.safetensors` | Q-H3-EXTRA（待搜索）；备用 O-SAM | `sam3.1_multiplex_fp16` |
| 2 | `diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors` | O-MUSE，确切 FP8 文件待核实 | 不用 V1.5、V2、V3.5、V4 或 INT8 顶替。 |
| 3 | `diffusion_models/Moss_image/moss_image_sft_int8_convrot.safetensors` | Q-MOSS（已确认） | `moss_image_sft_int8_convrot` |
| 4 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | Q-KREA（已确认） | `krea2_turbo_fp8_scaled` |
| 5 | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | Q-H3（已确认） | `minimax_h3_fl2va_pruned_int8_convrot` |
| 6 | `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` | Q-H3（已确认） | `minimax_h3_ref2va_pruned_int8_convrot` |
| 7 | `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | Q-QWEN（已确认） | `qwen_image_2.1_int8_convrot` |
| 8 | `diffusion_models/seedvr2_3b_int8_convrot.safetensors` | O-SEED3B | 必须是 `3b`，不要下载 Q-MOSS 中的 7B。 |
| 9 | `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors` | O-H3-UP | 官方文件在版本子目录内；目标不再保留版本子目录。 |
| 10 | `loras/Krea2-N/Krea2-realism_engine_v2.safetensors` | Q-KREA（已确认） | `Krea2-realism_engine_v2` |
| 11 | `loras/Krea2-功能/Krea2-亚洲asianMix_v1-bf16.safetensors` | Q-KREA（已确认） | `asianMix_v1` |
| 12 | `loras/Krea2-四视图QuadView_krea2_v1.safetensors` | Q-QUAD（待搜索）；备用 O-QUAD | 搜索 `QuadView_krea2_v1`；官方原名无 `Krea2-四视图` 前缀，下载后重命名。 |
| 13 | `loras/Krea2-风格/Krea2-奇幻现实FantasyRealism.safetensors` | Q-KREA（已确认） | `FantasyRealism` |
| 14 | `loras/Krea2-风格/krea2_紫调复古旧动漫retroanime.safetensors` | Q-KREA（已确认） | `retroanime` |
| 15 | `loras/Krea2-风格/krea2_装饰艺术柔和水彩softwatercolor.safetensors` | Q-KREA（已确认） | `softwatercolor` |
| 16 | `loras/Qwen2.1_Anything2RealCharacters.safetensors` | Q-QWEN（已确认） | 搜索 `Qwen21-任转真Anything2RealCharacters.safetensors`，下载后改为目标名。 |
| 17 | `loras/h3_character_swap_v1.5.safetensors` | Q-H3（已确认） | `h3_character_swap_v1.5` |
| 18 | `loras/krea2_identity_edit_v2.safetensors` | O-IDENTITY | 必须是 V2 完整版，不使用 r128、r64 或 V1.x。 |
| 19 | `loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | Q-H3-EXTRA（待搜索） | `minimax_h3_fl2v_turbo_4step` |
| 20 | `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | Q-H3-EXTRA（已确认） | `minimax_h3_fl2v_turbo_8step` |
| 21 | `loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | Q-H3-EXTRA（待搜索） | `minimax_h3_ref2v_turbo_4step` |
| 22 | `text_encoders/qwen3.5_9b_int8_convrot.safetensors` | Q-MOSS（已确认） | `qwen3.5_9b_int8_convrot` |
| 23 | `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | Q-H3（已确认） | `qwen3vl_32b_minimax_h3_int8_convrot` |
| 24 | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | Q-H3（已确认） | `qwen3vl_32b_minimax_h3_nvfp4_awq` |
| 25 | `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | Q-KREA（已确认） | `qwen3vl_4b_fp8_scaled` |
| 26 | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | Q-QWEN（已确认） | `qwen3vl_8b_int8_convrot` |
| 27 | `vae/flux2-vae_small.safetensors` | Q-MOSS（已确认） | `flux2-vae_small` |
| 28 | `vae/minimax_h3_audio_vae_fp32.safetensors` | Q-H3（已确认） | `minimax_h3_audio_vae_fp32` |
| 29 | `vae/minimax_h3_video_vae_fp16.safetensors` | Q-H3（已确认） | `minimax_h3_video_vae_fp16` |
| 30 | `vae/minimax_h3_video_vae_int8_convrot.safetensors` | Q-H3-EXTRA（待搜索） | `minimax_h3_video_vae_int8_convrot` |
| 31 | `vae/qwen_image_2.1_vae_bf16.safetensors` | Q-QWEN（已确认） | `qwen_image_2.1_vae_bf16` |
| 32 | `vae/qwen_image_vae.safetensors` | Q-KREA（已确认） | `qwen_image_vae` |
| 33 | `vae/seedvr2_ema_vae_fp16.safetensors` | Q-MOSS（已确认） | `seedvr2_ema_vae_fp16` |

## 给安装 Agent 的执行步骤

1. 将仓库放在 ComfyUI 便携版根目录下，目录名保持 `video-workbench`。
2. 先运行 `install.bat`，安装缺失的第三方节点、Python 依赖并构建画布。已有第三方节点不会被自动更新或覆盖。
3. 打开上方夸克原链接，用分享内搜索逐个查找本表文件，只下载点名文件。不要全量转存 TB 级分享。
4. 把所有下载文件整理到一个临时模型根目录，严格按“目标路径”建目录和重命名。临时目录例如 `D:\H3-Workbench-Models`，其下直接包含 `diffusion_models/`、`loras/` 等。
5. 对官方备用链接，可使用浏览器或支持断点续传的下载工具；遵守原模型许可证，不要将 `.safetensors` 当作压缩包解压。
6. 校验并复制到 ComfyUI：

   ```bat
   python_embeded\python.exe video-workbench\scripts\install_models.py "D:\H3-Workbench-Models" --comfy-root "."
   ```

   同盘且希望避免额外占用空间时，可加 `--link` 使用硬链接；跨盘不要加。
7. 运行最终校验：

   ```bat
   python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "."
   ```

8. 双击 `video-workbench\启动.vbs`。ComfyUI 启动后再加 `--online` 校验一次，确认实际节点注册也无缺失。
9. 遇到校验失败，先按报告修正文件名、目录和文件大小；不要启动大模型生成任务反复试错。

### 当前下载注意

- Muse V3.0 FP8 是唯一尚未找到与清单完全匹配的公开下载项，见第 2 行说明。其余 32 项已有夸克或官方入口；其中 Q-H3-EXTRA 与 Q-QUAD 内部分文件仍需 Agent 在分享中搜索确认，核心 H3 七项则已全部由 O-H3-COMFY 覆盖。
- 当前 15 项已登记官方 LFS SHA256，其中核心 H3 七项全部覆盖；其余 18 项只校验字节数并标为待核实。不要据相同字节数断言两个来源的权重完全相同。
- 模型可能各自采用不同许可证，公开分发、商业使用及人物素材使用需分别遵守作者条款。
