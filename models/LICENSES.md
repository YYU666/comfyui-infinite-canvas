# 模型与 LoRA 授权矩阵

本文件解释 [`licenses.json`](licenses.json) 的 33 项逐文件记录。模型清单只说明工作台需要哪些权重，**不表示这些权重都是开源、可商用或可由本项目再分发**。GitHub 仓库不包含模型权重。

核查日期：2026-10-29。许可证可能更新，商用或公开分发前应打开作者官方页复核最新文本。夸克等网盘仅作下载镜像，**镜像不授予额外权利**；授权判断优先依据作者官方 Hugging Face／Civitai 页面。

## 使用前必须知道

- **MiniMax H3**：适用地区排除欧盟、英国、韩国和美国；在这些地区使用、复制、修改、分发或展示 H3 Works 或 Outputs 未获该社区协议授权，需另询 MiniMax。商业产品或服务年收入超过 2000 万美元须事先取得书面授权（`api@minimax.io`）。商业 UI 须显著显示 `MiniMax H3`；向第三方提供须以可执行条款约束接收者并具备安全保障和违规报告机制；非 Hosted Service 分发须附 LICENSE 和指定 NOTICE；公开环境发布生成内容须显著披露机器生成；不得用 H3 或其输出改进非 H3／非 H3 衍生模型。
- **Krea 2**：用户及共同控制关联方过去 12 个月全部收入低于 100 万美元才可按社区许可商用；达到门槛须联系 `opensource@krea.ai`。分发模型或衍生品须附协议、保留 NOTICE、模型名以 Krea 开头并声明修改；部署须合理内容过滤。
- **Qwen Image 2.1**：适用 Qwen Research License，不是 Apache-2.0；仅研究、评估等非商用用途。商用联系 `model-business@notice.qwencloud.com`。即使组合中的编码器或 LoRA 是 Apache-2.0，也不会解除基座的非商用限制。
- **Identity Edit V2**：仅个人、研究、教育等非商用免费；公司使用、客户工作、广告、出售输出或商业服务均须向作者逐案取得书面许可：`l.bouaraba@gmail.com`。
- **Civitai 单项许可**：每个作者对出售图片、生成服务、衍生模型、合并模型和署名的选择不同，不能把某一 LoRA 的权限套用到其他 LoRA。
- **未知项**：Muse 精确 FP8、Krea2 realism engine 精确身份和 asianMix 许可证尚未完全核实。`unknown` 不是“可自由使用”，取得作者授权前不要商用或再分发。

状态含义：`allowed` 表示许可证允许但仍须履行署名等义务；`conditional` 表示仅在列明条件和范围内允许；`non-commercial` 表示仅非商用；`unknown` 表示未知或精确身份未确认。

## 33 项逐文件矩阵

“商用／再分发”使用上述状态简称；完整限制和官方链接同时保存在机器可读的 `licenses.json`。

| # | 目标路径 | 作者 | 许可证 | 商用 | 再分发与主要限制 |
|---|---|---|---|---|---|
| 1 | `checkpoints/sam3.1_multiplex_fp16.safetensors` | Meta | SAM License | conditional | 分发附许可；研究发表致谢；遵守贸易管制、隐私和禁止用途。 |
| 2 | `diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors` | Stable_Yogi | Civitai 限制 + Krea 2；精确 FP8 待核实 | unknown | unknown；作者页不允许衍生分享且需署名，不能用其他版本替代。 |
| 3 | `diffusion_models/Moss_image/moss_image_sft_int8_convrot.safetensors` | OpenMOSS Team | Apache-2.0 | allowed | 保留版权、许可和 NOTICE，标明修改。 |
| 4 | `diffusion_models/krea2_turbo_fp8_scaled.safetensors` | Krea | Krea 2 Community | conditional | 收入门槛、协议与 NOTICE、Krea 命名、修改声明、内容过滤。 |
| 5 | `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部地区、商业、署名、披露、分发和训练限制。 |
| 6 | `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` | MiniMax | MiniMax H3 Community | conditional | 同 H3。 |
| 7 | `diffusion_models/qwen_image_2.1_int8_convrot.safetensors` | Qwen Team | Qwen Research | non-commercial | 商用另获授权；分发附协议、修改声明和 Notice。 |
| 8 | `diffusion_models/seedvr2_3b_int8_convrot.safetensors` | ByteDance Seed | Apache-2.0 | allowed | 保留版权、许可和 NOTICE，标明修改。 |
| 9 | `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors` | LBH-123-AI | Apache-2.0 | conditional | 文件本身 Apache；与 H3 组合仍受 H3 条款约束。 |
| 10 | `loras/Krea2-N/Krea2-realism_engine_v2.safetensors` | unknown；候选 RudySen | unknown；候选仓库标 MIT | unknown | 候选文件相差 48 字节，精确身份确认前不得商用或再分发。 |
| 11 | `loras/Krea2-功能/Krea2-亚洲asianMix_v1-bf16.safetensors` | unknown | unknown | unknown | 仅有镜像，作者和许可证待确认；授权前不得商用或再分发。 |
| 12 | `loras/Krea2-四视图QuadView_krea2_v1.safetensors` | NRDX | Civitai 作者许可 + Krea 2 | conditional | 作者允许其标注范围内商用和衍生；仍叠加 Krea 2。 |
| 13 | `loras/Krea2-风格/Krea2-奇幻现实FantasyRealism.safetensors` | vrgamedevgirl | Civitai 作者许可 + Krea 2 | conditional | 可售图／生成服务；不得分享衍生或合并模型；叠加 Krea 2。 |
| 14 | `loras/Krea2-风格/krea2_紫调复古旧动漫retroanime.safetensors` | Krea | Krea 2 Community | conditional | Krea 2 全部条件。 |
| 15 | `loras/Krea2-风格/krea2_装饰艺术柔和水彩softwatercolor.safetensors` | Krea | Krea 2 Community | conditional | Krea 2 全部条件。 |
| 16 | `loras/Qwen2.1_Anything2RealCharacters.safetensors` | WarmBloodAban | Apache-2.0 | non-commercial | 与 Qwen Image 2.1 组合默认仅非商用，除非另获基座授权。 |
| 17 | `loras/h3_character_swap_v1.5.safetensors` | Akatz Labs | MiniMax H3 Community | conditional | H3 全部条件。 |
| 18 | `loras/krea2_identity_edit_v2.safetensors` | Lars Bouaraba | Identity Edit V2 + Krea 2 | non-commercial | 任何商用逐案书面授权；保留两个许可和 NOTICE；衍生模型同限制。 |
| 19 | `loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部条件。 |
| 20 | `loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部条件。 |
| 21 | `loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部条件。 |
| 22 | `text_encoders/qwen3.5_9b_int8_convrot.safetensors` | OpenMOSS Team | Apache-2.0 | allowed | 保留版权、许可和 NOTICE，标明修改。 |
| 23 | `text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors` | Qwen / MiniMax | H3 Community；上游 Apache-2.0 | conditional | 按 H3 组合组件处理，上游许可不解除 H3 限制。 |
| 24 | `text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | Qwen / MiniMax | H3 Community；上游 Apache-2.0 | conditional | 同上。 |
| 25 | `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | Qwen Team | Apache-2.0 | allowed | 保留上游许可；与 Krea 2 组合另守 Krea 条款。 |
| 26 | `text_encoders/qwen3vl_8b_int8_convrot.safetensors` | Qwen Team | 上游 Apache-2.0 | non-commercial | 与 Qwen Image 2.1 组合默认仅非商用。 |
| 27 | `vae/flux2-vae_small.safetensors` | OpenMOSS Team | Apache-2.0 | allowed | 保留版权、许可和 NOTICE，标明修改。 |
| 28 | `vae/minimax_h3_audio_vae_fp32.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部条件。 |
| 29 | `vae/minimax_h3_video_vae_fp16.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部条件。 |
| 30 | `vae/minimax_h3_video_vae_int8_convrot.safetensors` | MiniMax | MiniMax H3 Community | conditional | H3 全部条件。 |
| 31 | `vae/qwen_image_2.1_vae_bf16.safetensors` | Qwen Team | Qwen Research | non-commercial | 商用另获授权；分发附协议和 Notice。 |
| 32 | `vae/qwen_image_vae.safetensors` | Qwen Team | Apache-2.0 | allowed | 保留许可；与 Krea 2 组合另守 Krea 条款。 |
| 33 | `vae/seedvr2_ema_vae_fp16.safetensors` | ByteDance Seed | Apache-2.0 | allowed | 保留版权、许可和 NOTICE，标明修改。 |

## 分发与输出责任

- 本仓库不分发上述权重。若维护者另行制作模型聚合包，必须逐款确认再分发权，并附对应许可证、版权、NOTICE 和修改声明；`unknown` 项不得打入公开聚合包。
- 生成内容还可能涉及人物肖像、隐私、著作权和输入素材授权。模型许可允许某类使用，不等于用户的输入或输出不侵权。
- 第三方节点许可证见根目录 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)；节点、模型和工作台代码的许可证互不替代。
- 本文件是工程授权清单，不是法律意见；无法确认时应联系作者，而不是根据文件名或下载页面猜测。
