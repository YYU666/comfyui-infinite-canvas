# 视频超分与 Open-H3 IC 兼容状态

## 使用

添加「视频超分」节点（Agent 预设 `video_super_resolution`），上传本地视频或将视频素材连到 `guide`，选择模型和倍率后点击「开始超分」。

- RTX VFX：默认 2×、ULTRA、强度 1。需要本机注册 NVIDIA 官方 `RTXVideoSuperResolution` 节点及可用 SDK；本功能不自动安装或下载。
- SeedVR2 3B / 7B：实验视频入口，使用原生时间分块采样及平铺 VAE。需对应 INT8 模型、VAE 和原生 SeedVR2 节点。分块限制采样显存，但完整视频帧仍占用主内存，建议先验收短片。
- 保留源帧率、完整时间序列和原声内容。保存 MP4 时音频会重新编码，不保证音频压缩包或文件字节相同。RTX 输出尺寸按原节点规则取 8 的倍数。
- 成品仅绑定本次任务中 `SaveVideo` 写出的 `H3_RTX_VFX_*` / `H3_SeedVR2_*` 输出；输入片或临时预览不会充当结果。失败保留源节点、处理节点及已有成品。
- 工作流和预检均在本机执行，不调用云端视频 API。

## Open-H3-Regenerate-2K-IC

当前入口明确显示「兼容适配未完成」，不提交生成。此项与 RTX / SeedVR2 是不同算法。

官方 Diffusers HyperFlow 是发布的 up3/up4/hf8 配方必需项。它有 316 对 LoRA，包含当前时间和终点时间的四对线性层。普通 312 对块权重转换器无法补齐双时间执行语义；改名或丢掉额外权重会得到错误配方。需要独立模型克隆、gate 混合、逐步 next-sigma 注入及固定参考／音频条件行，并验证量化和 low-VRAM 卸载。

默认 LMS Sharp 另有 50 个 8 维 AdaLN 曲线分支，需要时间曲线运行时。上游允许显式 Sharp0，但它不能解决 HyperFlow 的缺口。节点包的默认配方是 124 帧横屏，不能当作竖屏完整视频的验收。

`scripts/check_open_h3_2k_compatibility.py` 只读取有限的 Safetensors 头与模型源码，报告结构差异，不加载张量、不转换权重、不下载。必须显式传入 `--hyperflow`、`--sharp`、`--base` 和 `--model-source`；`--report` 只新建文件。退出码 2 表示运行时适配未验证，1 表示输入无效。结构检查不能替代真机推理验收。

参考：[HyperFlow](https://github.com/Video-Rebirth/hyperflow)、[NVIDIA IC](https://github.com/NVlabs/Sana/tree/sol-engine/models/Open-H3-Regenerate-2K/IC)、[ComfyUI IC helper](https://github.com/slmonker/ComfyUI-OpenH3Regenerate2KIC/tree/a85bd9664a752637c5ec88bf4b1930b4688fc251)。不再分发这些模型或 SDK。
