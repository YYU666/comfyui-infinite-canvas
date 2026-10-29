# 第三方节点声明

工作台安装器从下表仓库的指定 commit 独立克隆节点；这些节点不随本仓库源码捆绑。节点许可证独立于工作台 Apache-2.0，也独立于模型许可证。机器可读清单见 [`third_party/nodes.json`](third_party/nodes.json)，一致性由 `test_license_inventory.py` 校验。

| 节点目录 | 上游作者／仓库 | 锁定 commit | 许可证 |
|---|---|---|---|
| `h3-relay` | `akatz-ai/h3-relay` | `e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220` | GPL-3.0 |
| `ComfyUI-KJNodes` | `kijai/ComfyUI-KJNodes` | `b5316a9e247338dc1460df8e4d01e906c566299c` | GPL-3.0 |
| `comfyui-krea2edit` | `lbouaraba/comfyui-krea2edit` | `13ef60f20828949becada815d3cbc371eb5ccaab` | Apache-2.0 |
| `ComfyUI-Inpaint-CropAndStitch` | `lquesada/ComfyUI-Inpaint-CropAndStitch` | `6005efc02f7745649118edd89cdd084c2b9bd3ae` | GPL-3.0 |
| `Comfyui_Minimax_h3_latent_Upscaler` | `LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler` | `40316cf008b2fd8663263270669eb4da23f89d2c` | MIT（Copyright 2026 LBH-123-AI） |
| `ComfyUI-Spectrum-MOSS` | `Rkkss/ComfyUI-Spectrum-MOSS` | `1e5eb359160b50be02ff95d1a93f22af2947888c` | GPL-3.0 |

这里只记录许可证文本中明确出现的 SPDX 标识，不推断 `only` 或 `or-later`。重新分发节点、修改版或聚合包时，必须保留原许可证、版权和修改声明，并按适用许可证提供对应源码及修改信息。GPL 节点不得因与本工作台一起安装而被改写为 Apache-2.0。
