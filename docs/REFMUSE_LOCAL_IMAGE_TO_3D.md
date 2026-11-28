# Refmuse 本地图生 3D

这是面向单件资产的预览流程。阶段 2「图生白模 · 未展UV无材质」只接收上一张参考图，只输出未展 UV、无材质贴图的高模几何 GLB。内置 TripoSR 与 [几何白模工作流](../workflows/pixal3d_white_mesh_api.json) 都走这一步。UV 与 PBR／ORM 留到修模之后，不在这一步展开或烘焙。

[灯罩完整工作流](../workflows/pixal3d_lamp_shade_api.json) 仍是另一条带 UV、材质、法线和 AO 的既有配方，依赖检查继续核对它的六个权重。它不是阶段 2 的白模契约。

## 开始使用

1. 启动 Refmuse v1.1.0 工作台与本地 ComfyUI。ComfyUI 需要能加载本流程使用的原生 3D 节点和下表的六个权重。按官方教程核对节点与权重来源。 [ComfyUI 官方教程](https://docs.comfy.org/tutorials/3d/pixal3d) · [Comfy-Org 权重](https://huggingface.co/Comfy-Org/Pixal3D)
2. 从画布添加菜单的「3D 资产加工」点击「检查 Pixal3D 图生 3D 依赖」。也可在仓库根目录运行下列命令。Windows 便携版可用 Python 的完整路径替换 `python`。按报告补齐 `missingNodes` 或 `models` 中标为 `missing` 的权重，并排查 `ambiguous` 的重复项。预检核对节点注册和权重选项。

   ```powershell
   python scripts/check_pixal3d.py --url http://127.0.0.1:8188
   ```

3. 阶段 2 从画布添加「图生白模 · 未展UV无材质」，或在「节点库 → 本地节点／导入工作流」选择 [几何白模工作流](../workflows/pixal3d_white_mesh_api.json)。确认只有图片输入和模型输出后添加到当前画布。把上一张参考图的图片输出直接连到该节点，再运行。
4. 单个 GLB 显示在生成节点内部，并写入当前项目 `assets/`。从该节点的 `model` 输出直接连到下游修模、LOD 或分析节点的模型输入。已绑定的下游结果在上游重跑后仍指向当时那一版。需要单独卡片时，在节点上选择「提取到画布」。 [Native3D 配置](NATIVE3D.md)
5. 需要独立文件时，使用节点上的「下载 GLB」。白模这一步没有 UV 岛，也没有材质贴图。

| ComfyUI 模型目录 | 文件 |
| --- | --- |
| `diffusion_models` | `pixal3d_int8_convrot.safetensors` |
| `vae` | `trellis_2_shape_vae_bf16.safetensors`、`trellis_2_texture_vae_bf16.safetensors` |
| `clip_vision` | `dino_v3_L_naf_fp32.safetensors` |
| `geometry_estimation` | `moge_2_vitl_normal_fp16.safetensors` |
| `background_removal` | `birefnet.safetensors` |

## 当前验收范围

- 既有灯罩样例在 RTX 3090 Ti 24 GB 与 ComfyUI 0.45.0 上通过预检并导出 GLB。本轮回归检查了 GLB 到 LOD 的连线、项目保存保护和任务续查；图生 3D 到 LOD 的全链冷启动 GPU 验收以及其他显卡的端到端复跑待完成。
- 灯罩完整配方交付单图到单个带贴图的 GLB。几何白模工作流只交付未展 UV、无材质的 GLB。灯罩演示中的双 LOD、曲率旧化和 AI 脏迹加工，以及后续参数化部件装配，各有独立的验证和交付范围。
- 工作流引用本机已安装的权重。参考图从画布输入口提供，`input.png` 只是 API 工作流中的占位名。
