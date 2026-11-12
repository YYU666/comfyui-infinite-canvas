# 模型下载源与 Agent 安装指令

可选 FLUX 3 Image Klein 的四项依赖、固定官方来源和校验信息见 [FLUX3_KLEIN.md](FLUX3_KLEIN.md)；它不属于下列 33 项安装清单，也不会随默认安装下载。

可选 **MiniMax H3-Image** 的三份所需文件、固定官方直接下载地址和 SHA256 见 [H3_IMAGE.md](H3_IMAGE.md)；新增图片主模型和图片 VAE 使用 [h3-image-sources.json](h3-image-sources.json) 登记，32B INT8 文本编码器可复用。它不属于下列视频／综合安装 profile；不要用 H3 视频 VAE 或其他精度文件替代。

本文件配合 `manifest.json` 使用。当前清单为 **33 个去重文件，164.803 GiB**。模型权重不放入 GitHub。按下面的官方地址逐文件下载；不要把整仓或网盘分享整包转存。

下载、商用或再分发前必须另读 [`LICENSES.md`](LICENSES.md) 与 [`licenses.json`](licenses.json)。网盘镜像不授予额外权利。H3、Krea 2、Qwen Image 2.1、Identity Edit V2 和 Civitai 单项模型各有独立限制，未知项不得推定可商用或可再分发。

2026-11-12 用 Hugging Face 的 HEAD（不跟随到文件体，只读 `x-linked-size` 与 `x-linked-etag`）和 Civitai 版本 API 核对了下列地址，没有下载权重。清单里已有 SHA256 的文件，其 `x-linked-etag` 与清单一致。没有 SHA256 的文件只确认了官方文件名和字节数，安装时仍标为待核实。

## 下载源索引

前缀型地址表示在该地址后拼接「远程路径」。远程路径与清单目标路径相同的，下表不再重复。

| 编号 | 原始下载入口 | 用途与核实状态 |
|---|---|---|
| O-H3-COMFY | https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/ | H3 主模型、三份 Turbo LoRA、INT8 与 NVFP4 文本编码器、音频 VAE、FP16 与 INT8 视频 VAE。远程路径等于清单路径。HEAD 大小一致；清单中的 SHA256 与 `x-linked-etag` 一致。 |
| O-QWEN | https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/ | Qwen 2.1 主模型、8B 编码器、VAE。远程路径等于清单路径，HEAD 大小一致。作者 `Qwen/Qwen-Image-2.1` 是分片 Diffusers 权重，字节数不同，不能顶替这三份 ComfyUI 文件。 |
| O-KREA | https://huggingface.co/Comfy-Org/Krea-2/resolve/main/ | Krea2 Turbo FP8 scaled、4B FP8 编码器、`qwen_image_vae`。远程路径等于清单路径，HEAD 大小一致。 |
| O-MOSS | https://huggingface.co/Comfy-Org/MOSS-Image/resolve/main/ | MOSS 主模型、9B 编码器、`flux2-vae_small`。主模型的远程路径不带子目录，见第 3 行。HEAD 大小一致。 |
| O-SEEDVAE | https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors | SeedVR2 VAE。HEAD 大小 501,324,814，与清单一致。不要改下 7B 主模型来充当 3B。 |
| O-SWAP | https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA/resolve/main/h3_character_swap_v1.5.safetensors | 角色替换 LoRA v1.5。文件名与字节数 155,110,792 与清单一致。 |
| O-A2R | https://huggingface.co/WarmBloodAban/Qwen-Image-2.1-LoRAs/resolve/main/Qwen2.1_Anything2RealCharacters.safetensors | 写实 LoRA。官方文件名已经是清单目标名，字节数 318,820,200 一致。 |
| O-RETRO | https://huggingface.co/krea/Krea-2-LoRA-retroanime/resolve/main/retroanime.safetensors | 作者官方复古动漫 LoRA。字节数 469,291,992。下载后按第 14 行改名。`Comfy-Org/Krea-2` 的 `loras/krea2_retroanime.safetensors` 与它的 `x-linked-etag` 相同。 |
| O-WATER | https://huggingface.co/krea/Krea-2-LoRA-softwatercolor/resolve/main/softwatercolor.safetensors | 作者官方水彩 LoRA。字节数 469,291,992。下载后按第 15 行改名。`Comfy-Org/Krea-2` 的 `loras/krea2_softwatercolor.safetensors` 与它的 `x-linked-etag` 相同。 |
| O-FANTASY | https://huggingface.co/vrgamedevgirl84/Krea2_FantasyRealism/resolve/main/Krea2_FantasyRealism.safetensors | 作者官方奇幻现实 LoRA。字节数 234,704,064；`x-linked-etag` 等于 Civitai 版本 3072304 公布的 SHA256。下载后按第 13 行改名。 |
| O-ASIAN | https://civitai.com/models/2746042?modelVersionId=3093245 | hinablue 的 Krea2 Asian Mix **v1.0 RAW**。官方文件名 `hina_krea2_asianMix_v1-bf16.safetensors`，API `sizeKB` 换算为 228,617,720 字节，与清单一致。匿名下载接口返回 401，作者要求登录 Civitai 后才能下载。不要改用 v2 及以后版本，那些文件大小不同。 |
| O-REALISM | https://pan.quark.cn/s/83b5ad9265e8 | **仅** realism engine 仍用这条夸克分享，在分享内搜索 `Krea2-realism_engine_v2`。作者候选仓库 `RudySen/Krea2-realism-V2` 的同名文件经 HEAD 为 1,562,410,344 字节，比清单多 48 字节，不能替换。 |
| O-MUSE | https://civitai.com/models/2741166 | Muse 作者原页。**没有**与清单 V3.0 FP8（13,784,899,896 字节）同名且同大小的公开文件。v3.0 Turbo 的 fp8-scaled 为 14,128,290,360 字节。不能用 V1.5、V2、V3.5、V4 或 INT8 改名顶替。 |
| O-IDENTITY | https://huggingface.co/conradlocke/krea2-identity-edit/resolve/main/krea2_identity_edit_v2.safetensors | Identity Edit V2 官方权重。HEAD 大小与 SHA256 均与清单一致。 |
| O-QUAD | https://huggingface.co/Alissonerdx/CharacterSheet/resolve/main/QuadView_krea2_v1.safetensors | 四视图官方权重。HEAD 大小与 SHA256 均与清单一致，下载后按第 12 行加前缀。 |
| O-SEED3B | https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors | SeedVR2 3B 官方权重。HEAD 大小与 SHA256 均与清单一致。 |
| O-SAM | https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors | SAM3.1 官方权重。HEAD 大小与 SHA256 均与清单一致。 |
| O-H3-UP | https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors | H3 latent 高清模型。HEAD 大小与 SHA256 均与清单一致；放到目标目录根下，不要保留版本子目录。 |

## 核心 H3 安装

新用户先安装 `core-h3` 七项，而不是默认下载完整 33 项。七项都在 O-H3-COMFY，相对路径与 `manifest.json` 里 `profiles.core-h3.files` 相同。七项都有官方 SHA256，损坏或错版会被校验器拒绝。

## 33 个文件的来源与目标位置

下表的「目标路径」均相对于 `ComfyUI/models/`。下载后的目录以本表目标路径为准，不以官方仓库的子目录为准。

| # | 目标路径 | 来源 | 远程文件与重命名 |
|---|---|---|---|
| 1 | `checkpoints/sam3.1_multiplex_fp16.safetensors` | O-SAM | 文件名不变。 |
| 2 | `diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors` | O-MUSE，确切 FP8 文件仍未核实 | 不用 V1.5、V2、V3.5、V4 或 INT8 顶替。 |
| 3 | `diffusion_models/Moss_image/moss_image_sft_int8_convrot.safetensors` | O-MOSS | 远程路径是 `diffusion_models/moss_image_sft_int8_convrot.safetensors`。下载后放入 `Moss_image/`，文件名不变。 |
| 4 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | O-KREA | 路径与文件名不变。 |
| 5 | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 6 | `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 7 | `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | O-QWEN | 路径与文件名不变。 |
| 8 | `diffusion_models/seedvr2_3b_int8_convrot.safetensors` | O-SEED3B | 必须是 `3b`，不要下载 7B。 |
| 9 | `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors` | O-H3-UP | 官方文件在版本子目录内；目标不再保留版本子目录。 |
| 10 | `loras/Krea2-N/Krea2-realism_engine_v2.safetensors` | O-REALISM | 只在该夸克分享内搜索这个文件名。不要用 RudySen 多出 48 字节的文件顶替。 |
| 11 | `loras/Krea2-功能/Krea2-亚洲asianMix_v1-bf16.safetensors` | O-ASIAN | 只下载 v1.0 RAW 的 `hina_krea2_asianMix_v1-bf16.safetensors`，再改成目标名。需要登录 Civitai。 |
| 12 | `loras/Krea2-四视图QuadView_krea2_v1.safetensors` | O-QUAD | 官方原名 `QuadView_krea2_v1.safetensors`，下载后加上 `Krea2-四视图` 前缀。 |
| 13 | `loras/Krea2-风格/Krea2-奇幻现实FantasyRealism.safetensors` | O-FANTASY | 官方原名 `Krea2_FantasyRealism.safetensors`，下载后改成目标名。 |
| 14 | `loras/Krea2-风格/krea2_紫调复古旧动漫retroanime.safetensors` | O-RETRO | 官方原名 `retroanime.safetensors`，下载后改成目标名。 |
| 15 | `loras/Krea2-风格/krea2_装饰艺术柔和水彩softwatercolor.safetensors` | O-WATER | 官方原名 `softwatercolor.safetensors`，下载后改成目标名。 |
| 16 | `loras/Qwen2.1_Anything2RealCharacters.safetensors` | O-A2R | 官方文件名已是目标名。 |
| 17 | `loras/h3_character_swap_v1.5.safetensors` | O-SWAP | 文件名不变。 |
| 18 | `loras/krea2_identity_edit_v2.safetensors` | O-IDENTITY | 必须是 V2 完整版，不使用 r128、r64 或 V1.x。 |
| 19 | `loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | O-H3-COMFY | 路径与文件名不变。这是 768p 的 4-step，不是 8-step。 |
| 20 | `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 21 | `loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 22 | `text_encoders/qwen3.5_9b_int8_convrot.safetensors` | O-MOSS | 路径与文件名不变。 |
| 23 | `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 24 | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | O-H3-COMFY | 路径与文件名不变。不能用 INT8 那份顶替。 |
| 25 | `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | O-KREA | 路径与文件名不变。 |
| 26 | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | O-QWEN | 路径与文件名不变。 |
| 27 | `vae/flux2-vae_small.safetensors` | O-MOSS | 路径与文件名不变。不能用 Klein 的 `flux2-vae.safetensors` 顶替。 |
| 28 | `vae/minimax_h3_audio_vae_fp32.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 29 | `vae/minimax_h3_video_vae_fp16.safetensors` | O-H3-COMFY | 路径与文件名不变。不能用 INT8 视频 VAE 顶替。 |
| 30 | `vae/minimax_h3_video_vae_int8_convrot.safetensors` | O-H3-COMFY | 路径与文件名不变。 |
| 31 | `vae/qwen_image_2.1_vae_bf16.safetensors` | O-QWEN | 路径与文件名不变。 |
| 32 | `vae/qwen_image_vae.safetensors` | O-KREA | 路径与文件名不变。与 Qwen 2.1 的 VAE 不是同一文件。 |
| 33 | `vae/seedvr2_ema_vae_fp16.safetensors` | O-SEEDVAE | 文件名不变。 |

## 给安装 Agent 的执行步骤

1. 将仓库放在 ComfyUI 便携版根目录下，目录名保持 `video-workbench`。
2. 先运行 `install.bat`，安装缺失的第三方节点、Python 依赖并构建画布。已有第三方节点不会被自动更新或覆盖。
3. 按上表打开官方地址，只下载点名文件。前缀型地址要接上对应远程路径。O-ASIAN 需要用户自己登录 Civitai。不要下载整个仓库，也不要转存夸克分享；O-REALISM 是唯一仍指向夸克的文件。
4. 把所有下载文件整理到一个临时模型根目录，严格按「目标路径」建目录和重命名。临时目录例如 `D:\H3-Workbench-Models`，其下直接包含 `diffusion_models/`、`loras/` 等。
5. 官方直链可用浏览器或支持断点续传的下载工具；遵守原模型许可证，不要将 `.safetensors` 当作压缩包解压。
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

- Muse V3.0 FP8 仍没有与清单文件名和字节数都一致的公开官方文件，见第 2 行。realism engine 的作者候选文件大 48 字节，因此第 10 行保留原夸克链接。其余 31 项使用上表官方地址。
- 这些官方地址只写在文档和授权页里。安装器可信任自动下载列表没有扩大，仍只有原来登记的那些 Hugging Face 直链。
- 当前 15 项已登记官方 LFS SHA256，其中核心 H3 七项全部覆盖；其余 18 项只校验字节数并标为待核实。不要据相同字节数断言两个来源的权重完全相同。
- 模型可能各自采用不同许可证，公开分发、商业使用及人物素材使用需分别遵守作者条款。
