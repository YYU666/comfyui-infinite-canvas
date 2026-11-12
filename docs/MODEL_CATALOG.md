# 模型与功能对照（供用户决定是否下载）

安装画布时**不会**自动下载下面这些权重。GitHub 仓库也不包含模型。请先看「你要做的功能」，再看体积和来源，决定下哪一套。

体积一律按仓库清单中的 **字节数** 换算为 GiB（1 GiB = 1024³ 字节），并同时给出字节。未在清单或官方元数据中出现的大小标为「未知」，不会估算。显存只收录仓库已经写明的建议；未写明的标为「未登记」。

下载、商用或再分发前请阅读 [`models/LICENSES.md`](../models/LICENSES.md) 与作者官方条款。可下载不等于可商用。网盘镜像不授予额外权利。不要用旧版、其他量化或相似文件名顶替清单中的文件。

校验：有 SHA256 的文件必须核对内容哈希；只有字节数的文件只能做大小检查，并视为「待核实」。

---

## 建议套装

| 套装 | 能做什么 | 需要另外下载的体积 | 说明 |
| --- | --- | --- | --- |
| **最小（默认安装结果）** | 导入图片／视频／音频、PureRef、调色、图像混合、通道合并、备注、电子主美（示例或自备密钥）、视频链接下载。若使用已含视频编辑／节奏／绿幕的分支，且本机有 ffmpeg，还可以剪辑、变速、扣像。 | **0** | 只安装画布和 ComfyUI 节点／前端。不能做 H3 视频生成或本地扩散生图。 |
| **视频核心 `core-h3`** | 文生视频、全能参考视频、首尾帧视频（默认 Turbo）。 | **71.163 GiB**（76,410,807,376 字节） | 7 个文件，均可从 Hugging Face `Comfy-Org/MiniMax-H3` 按相对路径下载，七份都有 SHA256。仓库 README 写作 71.164 GiB，本表按清单字节换算为 71.163 GiB。 |
| **视频进阶** | 在视频核心之上增加角色替换、视频高清二采。 | 核心 71.163 GiB，另加 **23.695 GiB**（25,442,394,351 字节）的替换与二采专用文件 | 角色替换与二采**不能只用核心七项**：它们使用另一份 NVFP4 文本编码器和 FP16 视频 VAE。角色替换还建议 24 GB 显存。公开菜单默认可能不提供「角色替换」新建入口，需本机已注册该工具。 |
| **H3-Image** | MiniMax 文生图与多图编辑（4MP／16MP，6 步）。 | 三份合计 **45.904 GiB**（49,289,162,266 字节）；若已装视频核心的 32B INT8 编码器，增量 **20.627 GiB**（22,147,820,114 字节） | 必须另装图片 VAE，不能用视频 VAE。需要 ComfyUI 0.45.0。24 GB 显卡请先用 4MP。 |
| **千问生图** | Qwen 2.1 图生图、局部遮罩编辑；可选 Turbo 与漫转真 LoRA。 | 标准三件 **16.096 GiB**；Turbo 主模型另加 **6.758 GiB**；任转真 LoRA 另加 **0.297 GiB** | 局部遮罩节点本身不占模型。 |
| **FLUX 3 Klein** | 可选文生图／多参考编辑（1MP／2K／4K）。 | **19.344 GiB**（20,770,759,307 字节） | 四份官方文件，有 SHA256。权重许可为 FLUX Kommunity License，仓库需登录／接受条款后才能下载。官方相似名称的 MOSS 编码器或 `flux2-vae_small` **不能替代**。 |
| **Krea2 文生图** | 节点默认的 Krea2／Muse V3.0 Turbo 文生图，可选风格 LoRA。 | 主模型＋编码器＋VAE **17.957 GiB**；五个风格 LoRA 另加 **2.761 GiB** | **Muse V3.0 FP8 与清单完全匹配的公开来源尚未解决**，不能用 V4 或 INT8 改名冒充。未解决前不要宣称这一套可完整自动安装。 |
| **MOSS 文生图** | 文生图模型切换为 MOSS。 | **14.353 GiB**（15,411,341,830 字节） | 来源以 `models/SOURCES.md` 的 Q-MOSS 等为准；不在当前官方直链自动下载列表中。 |
| **完整 33 项 `full`** | 工作台旧综合清单里的视频＋多种生图＋部分 LoRA＋3B 高清等。 | **164.803 GiB**（176,955,706,249 字节） | **不建议作为默认。** 仍不包含 H3-Image 新图片模型、Klein、Qwen Turbo、Muse V4、SeedVR2 7B。其中 Muse V3.0 FP8 来源未解决，不能声称 33／33 都可下载。 |

「全部已知清单文件」（33 项＋H3-Image 新增两份＋Klein 四份＋四视图升级三份，去重后 42 个文件）合计 **231.860 GiB**（248,957,923,723 字节）。没有任何人需要一次性装齐。

---

## 按功能列出的模型

「必要／可选」针对该功能本身：没有必要文件则该功能不能跑；可选文件只增强效果或提供另一档质量。

「官方直链」表示已登记在安装器可信任源（`extension_dependencies.canonical_sources` 或独立 JSON 的 Hugging Face 地址）。未标官方直链的，请按 `models/SOURCES.md` 在点名的夸克分享中搜索，不要整包转存。

### 0. 不需要扩散模型的功能

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 素材导入、PureRef、备注、调色、混合、通道合并、视频链接下载 | 无 | 0 | 未登记 | — |
| 视频编辑、恒定速度、时间重映射、绿幕扣像（video-rhythm 分支） | 无扩散模型；需要 ffmpeg | 0 | 未登记 | ffmpeg 必要 |
| 电子主美 | 无本地权重；云端密钥可选 | 0 | — | 密钥可选 |

### 1. H3 文生视频／参考视频／首尾帧（视频核心）

路径均相对于 `ComfyUI/models/`。来源：`https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/` ＋ 下表路径。七份均有 SHA256。HEAD 抽查 `vae/minimax_h3_audio_vae_fp32.safetensors` 的 `Content-Length` 与清单一致（605,254,808）。

| 功能 | 模型（目标路径） | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 文生视频、首尾帧 | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 19.530 GiB（20,970,379,616 字节） | 未登记峰值；复杂相关任务建议 24 GB | 文生／首尾帧必要 |
| 全能参考视频（角色替换／二采也要用） | `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` | 19.530 GiB（20,970,379,616 字节） | 同上 | 参考视频必要 |
| 上述视频功能共用 | `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | 25.277 GiB（27,141,342,152 字节） | 未登记 | 必要；可与 H3-Image 复用 |
| 上述视频功能共用 | `vae/minimax_h3_video_vae_int8_convrot.safetensors` | 2.618 GiB（2,811,065,184 字节） | 未登记 | 必要（核心视频；替换／二采用的是另一份 FP16 VAE） |
| 上述视频功能共用 | `vae/minimax_h3_audio_vae_fp32.safetensors` | 0.564 GiB（605,254,808 字节） | 未登记 | 必要 |
| 文生视频默认 Turbo（8 步） | `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | 1.822 GiB（1,956,193,000 字节） | 未登记 | 默认开启时必要；角色替换也使用 |
| 参考视频默认 Turbo（4 步） | `loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | 1.822 GiB（1,956,193,000 字节） | 未登记 | 默认开启时必要 |

合计 **71.163 GiB**（76,410,807,376 字节）。

### 2. 角色替换（本地可选节点）

除复用参考视频主模型、音频 VAE、8-step Turbo 外，还需要下列文件。其中编码器和视频 VAE **与核心七项不是同一份文件**。

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 角色替换 | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 14.610 GiB（15,687,142,551 字节） | 复杂角色替换建议 24 GB | 必要；不能用 INT8 那份顶替 |
| 角色替换 | `vae/minimax_h3_video_vae_fp16.safetensors` | 4.850 GiB（5,207,808,496 字节） | 同上 | 必要；不能用 INT8 视频 VAE 顶替 |
| 角色替换 | `loras/h3_character_swap_v1.5.safetensors` | 0.144 GiB（155,110,792 字节） | 同上 | 必要 |
| 角色替换（SAM 检测／跟踪） | `checkpoints/sam3.1_multiplex_fp16.safetensors` | 1.626 GiB（1,745,546,848 字节） | 同上 | 必要；官方直链 `Comfy-Org/sam3.1` |

仅额外四项合计 **21.230 GiB**。若本机还没有核心里被复用的三份（REF2VA、音频 VAE、8-step Turbo），整套角色替换为 **43.146 GiB**（46,327,436,111 字节）。

SAM 有官方直链且已登记 SHA256。其余额外项当前主要来自 `models/SOURCES.md` 的 H3 包／补充包，不在安装器「可信任自动下载」14 项之内（SAM 除外）。

### 3. 视频高清二采

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 视频高清二采 | 复用 REF2VA、NVFP4 编码器、FP16 视频 VAE、音频 VAE、角色替换 LoRA | 见上表 | 未登记峰值 | 必要 |
| 视频高清二采 | `loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | 1.822 GiB（1,956,192,992 字节） | 未登记 | 必要（注意是 768p 的 4-step，与核心里的 8-step 不同） |
| 视频高清二采 | `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors` | 0.643 GiB（690,592,672 字节） | 未登记 | 必要；官方直链，下载后放在该目录根下，不要保留版本子目录 |

在已有角色替换额外文件的前提下，二采再增加 **2.465 GiB**。从零计算的二采相关文件（含复用项）约 **42.163 GiB**。

### 4. MiniMax H3-Image

官方仓库 `Comfy-Org/MiniMax-H3-Image`，固定修订 `892de7cb61df49753bf15145a711154803a355cb`。HEAD 抽查图片 VAE 的 `Content-Length` 与清单一致（1,168,505,312）。许可为 MiniMax-H3-Image Community License，与工作台 Apache-2.0 及 H3 视频许可都不同。

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 文生图／多图编辑 | `diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors` | 19.539 GiB（20,979,314,802 字节） | 24 GB 建议先用 4MP；16MP 未登记峰值 | 必要 |
| 同上（可与视频核心复用） | `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | 25.277 GiB（27,141,342,152 字节） | 未登记 | 必要；与核心视频同一哈希则可跳过 |
| 同上 | `vae/minimax_h3_image_vae_fp16.safetensors` | 1.088 GiB（1,168,505,312 字节） | 未登记 | 必要；**不能**用任何 H3 视频 VAE 替代 |

### 5. Qwen 2.1 图生图、局部修复、四视图（默认）

标准三件来自 `models/manifest.json` 与 `SOURCES.md` 的 Q-QWEN，**当前不在官方自动下载列表**。Turbo 与 7B、Muse V4 登记在 `models/character-upgrades.json`。HEAD 抽查 Turbo 主模型 `Content-Length` 与清单一致（7,256,787,829）。

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 图生图标准版、局部写实、默认四视图／换装 | `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | 6.758 GiB（7,256,783,064 字节） | 未登记 | 标准版必要 |
| 同上 | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | 8.709 GiB（9,350,798,360 字节） | 未登记 | 必要 |
| 同上 | `vae/qwen_image_2.1_vae_bf16.safetensors` | 0.629 GiB（675,509,688 字节） | 未登记 | 必要 |
| 漫转真、写实修复可选 | `loras/Qwen2.1_Anything2RealCharacters.safetensors` | 0.297 GiB（318,820,200 字节） | 未登记 | 可选；若下载源名为 `Qwen21-任转真…`，须改成目标名 |
| 图生图 Turbo、换装 Turbo 预设 | `diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors` | 6.758 GiB（7,256,787,829 字节） | 未登记 | Turbo 档必要；与标准主模型并存，不是同一文件 |
| 图片高清 7B、换装 7B 高清 | `diffusion_models/seedvr2_7b_int8_convrot.safetensors` | 7.762 GiB（8,334,897,976 字节） | 24 GB 仍依赖分块与内存管理，未登记峰值 | 7B 档必要；不要下载成 7B 却当作清单里的 3B，反之亦然 |
| 换装 Muse V4 预设 | `diffusion_models/museByStableYogi_v40INT8Extended.safetensors` | 12.565 GiB（13,491,952,248 字节） | 未登记 | 该预设必要；镜像来源与作者条款需自行核对 |

标准三件合计 **16.096 GiB**（17,283,091,112 字节）。

### 6. 图片高清 SeedVR2（3B 为画布默认）

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 图片高清默认 3B | `diffusion_models/seedvr2_3b_int8_convrot.safetensors` | 3.221 GiB（3,458,259,704 字节） | 未登记 | 3B 必要；官方直链，HEAD 与清单一致 |
| 图片高清（3B／7B 共用） | `vae/seedvr2_ema_vae_fp16.safetensors` | 0.467 GiB（501,324,814 字节） | 未登记 | 必要；来源见 SOURCES.md（Q-MOSS 已确认），不在自动下载 14 项内 |
| 图片高清 7B | `diffusion_models/seedvr2_7b_int8_convrot.safetensors` | 7.762 GiB（见上） | 见上 | 仅 7B 档必要 |

3B 套装（主模型＋VAE）**3.688 GiB**（3,959,584,518 字节）。

### 7. Krea2 文生图、风格 LoRA、母图编辑

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| 文生图默认 Krea2 | `diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors` | 12.838 GiB（13,784,899,896 字节） | 未登记 | 该默认档必要；**与清单完全匹配的公开来源未解决** |
| 文生图 Krea2／母图编辑共用 | `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | 4.882 GiB（5,242,467,968 字节） | 未登记 | 必要；与 Klein 的 `qwen3vl_4b_int8_convrot` 不是同一文件 |
| 文生图 Krea2／母图编辑共用 | `vae/qwen_image_vae.safetensors` | 0.236 GiB（253,806,246 字节） | 未登记 | 必要；与 Qwen 2.1 的 `qwen_image_2.1_vae_bf16` 不是同一文件 |
| 写实风格 LoRA | `loras/Krea2-N/Krea2-realism_engine_v2.safetensors` | 1.455 GiB（1,562,410,296 字节） | 未登记 | 可选 |
| 亚洲人物 LoRA | `loras/Krea2-功能/Krea2-亚洲asianMix_v1-bf16.safetensors` | 0.213 GiB（228,617,720 字节） | 未登记 | 可选 |
| 奇幻现实 LoRA | `loras/Krea2-风格/Krea2-奇幻现实FantasyRealism.safetensors` | 0.219 GiB（234,704,064 字节） | 未登记 | 可选 |
| 复古动漫 LoRA | `loras/Krea2-风格/krea2_紫调复古旧动漫retroanime.safetensors` | 0.437 GiB（469,291,992 字节） | 未登记 | 可选 |
| 柔和水彩 LoRA | `loras/Krea2-风格/krea2_装饰艺术柔和水彩softwatercolor.safetensors` | 0.437 GiB（469,291,992 字节） | 未登记 | 可选 |
| 母图编辑 V2 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | 12.239 GiB（13,141,730,784 字节） | 未登记 | 母图编辑必要 |
| 母图编辑 V2 | `loras/krea2_identity_edit_v2.safetensors` | 1.703 GiB（1,828,285,728 字节） | 未登记 | 必要；官方直链，必须是 V2 完整版，不用 r64／r128 或 V1 |
| 四视图 LoRA | `loras/Krea2-四视图QuadView_krea2_v1.safetensors` | 0.851 GiB（914,160,176 字节） | 未登记 | 可选；官方原名无此外文／中文前缀，下载后须按目标名重命名 |

Krea2 文生图三件 **17.957 GiB**；风格 LoRA 五件 **2.761 GiB**；母图编辑（主模型＋Identity LoRA＋共用编码器／VAE）**19.061 GiB**。

### 8. MOSS 文生图

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| MOSS 文生图 | `diffusion_models/Moss_image/moss_image_sft_int8_convrot.safetensors` | 5.042 GiB（5,413,698,958 字节） | 未登记 | 必要 |
| MOSS 文生图 | `text_encoders/qwen3.5_9b_int8_convrot.safetensors` | 9.079 GiB（9,748,121,532 字节） | 未登记 | 必要；与 Klein 的 PUP `qwen3.5_9b_flux3_prompt_upsampler_int8_convrot` 不是同一文件 |
| MOSS 文生图 | `vae/flux2-vae_small.safetensors` | 0.232 GiB（249,521,340 字节） | 未登记 | 必要；与 Klein 的 `vae/flux2-vae.safetensors` 不是同一文件 |

合计 **14.353 GiB**。

### 9. FLUX 3 Image Klein（可选，未加入安装 profile）

官方 `black-forest-labs/flux-3-image-klein-comfy`，修订 `9d36114cf7a2e03a45c28f5cc4987d20ebfdb6c1`。四份都有 SHA256，合计 **19.344 GiB**（20,770,759,307 字节）。本次对 `vae/flux2-vae.safetensors` 做 HTTP HEAD 返回 **401**（需接受许可），故远程大小未能用 HEAD 复核，体积以 `models/flux3-klein.json` 为准。

| 功能 | 模型 | 大小 | 显存 | 必要／可选 |
| --- | --- | --- | --- | --- |
| Klein 文生图／编辑 | `diffusion_models/flux3-image-klein-int8-convrot.safetensors` | 5.428 GiB（5,827,874,779 字节） | 峰值未登记。仓库仅记录 2026-11-03 在 RTX 3090 Ti 24 GB 上一次 4096×2144、16 步的成功，耗时约 136 秒，不代表全面验收 | 必要 |
| 同上 | `text_encoders/qwen3vl_4b_int8_convrot.safetensors` | 4.525 GiB（4,858,559,240 字节） | 未登记 | 必要 |
| 同上（提示词扩写 PUP） | `text_encoders/qwen3.5_9b_flux3_prompt_upsampler_int8_convrot.safetensors` | 9.079 GiB（9,748,113,996 字节） | 未登记 | 必要；只下主模型不能跑通 |
| 同上 | `vae/flux2-vae.safetensors` | 0.313 GiB（336,211,292 字节） | 未登记 | 必要 |

Klein 不支持把 Qwen 遮罩／裁切或 Qwen／Krea2 LoRA 直接套用。

### 10. 清单中有、但当前工作流未作为默认档引用的文件

`full` 33 项里还有 `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` 和 `vae/minimax_h3_video_vae_fp16.safetensors`（角色替换／二采使用），以及 `diffusion_models/krea2_turbo_fp8_scaled.safetensors` 等，均已在上面按功能列出。不要为了「装满 33 项」而默认下载。

---

## 当前可走官方直链、并且安装器已登记为可信任源的文件

下列 14 个文件可由工作台依赖检查使用固定 Hugging Face 地址下载（仍必须先得到你的同意）。合计 **99.834 GiB**（107,195,472,618 字节）。

- 视频核心七项（71.163 GiB）
- H3-Image 新增主模型与图片 VAE（20.627 GiB；编码器已含在核心七项中）
- SAM3.1、SeedVR2 3B 主模型、H3 Latent 放大、Identity Edit V2、四视图 LoRA

其余文件（Qwen 标准套件、MOSS、Krea 风格 LoRA、NVFP4 编码器、FP16 视频 VAE、角色替换 LoRA、4-step 768p Turbo、SeedVR2 VAE、Klein、升级档等）需要按 `SOURCES.md` 或各独立说明手动准备，或等待后续把已核实官方源登记进目录。Muse V3.0 FP8 在来源解决之前不能自动安装。

---

## 给用户的一句决定参考

- 先试试画布、或只做剪辑／调色：选 **最小**，现在不用下模型。
- 主要做 H3 视频：选 **视频核心**，约 71.163 GiB。
- 还要角色替换或视频二采：再看 **视频进阶** 的额外 23.695 GiB，并确认本机有没有该节点入口、显存是否够。
- 主要做图片：按模型分开选 **H3-Image**、**千问**、**Klein**，已有视频核心时可少下 25.277 GiB 的共用编码器。
- 不要默认选「完整 33 项」或「全部 42 项」。
