# MOSS 单骨架姿势控制（实验）

入口：第三方工具 → MOSS 姿势控制。使用一个姿势参考，可选连接角色四视图；仅输出最终单张结果。当前只完成离线/合成验证，尚未完成真实推理和画质验收，不宣称整套依赖可一键安装。

基础配方沿用作者单彩色骨架条件：MOSS SFT + pose-control LoRA，30 步、CFG 4、Euler/simple、LoRA 1、seed 42。现有模型采用 INT8 编码器 `qwen3.5_9b_int8_convrot.safetensors`，不是对其他精度效果等价的承诺。MOSS 主模型、Flux2 VAE 和姿势 LoRA 必须使用节点列出的精确文件；没有用相似权重替代。姿势 LoRA 来源记录见 `models/official-sources.lock.json` 中 `thedeoxen/MOSS-Image-pose-controlnet` 条目；登记来源不代表安装过节点或权重。

## 输入与可选身份阶段

- 已有彩色 OpenPose 骨架：直接缩放至选定总像素，跳过 DWPose，不依赖 ONNX 或 comfyui_controlnet_aux。
- 照片：需要先手工安装并加载提供 `DWPreprocessor` 的 `comfyui_controlnet_aux`，以及下表两份辅助 ONNX。节点校验真实本地大小和 SHA-256 后才允许入队，执行时复验；不调用 `from_pretrained` 或下载函数。版本必须具备本适配器使用的 DWPose/Wholebody API，未就绪则报错停止，不静默联网或换模型。
- 可选角色四视图：MOSS 先生成姿势图，随后由现有 Qwen 图生图对齐身份与穿搭。它是额外编辑阶段，不能称为 MOSS 官方多参考/身份保持能力；依赖 Qwen 权重和许可，耗时增加。最终只保留此阶段的 SaveImage 输出。

## 手工辅助预处理文件

这些是预处理辅助文件，**不进入 safetensors/GGUF 公开模型下载锁和下载器**。先取得用户安装授权，再按作者固定版本取文件并校验；放入 controlnet_aux 实际配置的 `ckpts/yzd-v/DWPose/` 目录。适配器从已加载节点的配置确认该目录，不能只凭目录存在宣称就绪。无需照片预处理时可直接接已有骨架。

| 文件 | 字节数 | SHA-256 | 作者固定来源与许可 |
| --- | ---: | --- | --- |
| `dw-ll_ucoco_384.onnx` | 134399116 | `724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843` | [yzd-v/DWPose @ 1a714410](https://huggingface.co/yzd-v/DWPose/resolve/1a7144101628d69ee7a3768d1ee3a094070dc388/dw-ll_ucoco_384.onnx) · [Apache-2.0](https://huggingface.co/yzd-v/DWPose/blob/1a7144101628d69ee7a3768d1ee3a094070dc388/LICENSE) |
| `yolox_l.onnx` | 216746733 | `7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411` | [yzd-v/DWPose @ 1a714410](https://huggingface.co/yzd-v/DWPose/resolve/1a7144101628d69ee7a3768d1ee3a094070dc388/yolox_l.onnx) · [Apache-2.0](https://huggingface.co/yzd-v/DWPose/blob/1a7144101628d69ee7a3768d1ee3a094070dc388/LICENSE) |

缺少节点、权重枚举不含精确文件、辅助哈希校验失败时不入队。已有骨架模式不会检查或安装 ONNX。工作台代码许可不替代 MOSS、姿势 LoRA、编码器、Qwen 或辅助文件的作者条款。
