# Refmuse 本地图生 3D

这是面向单件资产的预览流程。将一张参考图连到节点，即可在本地 ComfyUI 运行 Pixal3D，完成网格重建、减面、UV 展开、材质投射和法线／AO 烘焙，再将带贴图的 GLB 交付到画布结果卡片。

## 开始使用

1. 启动 Refmuse v1.1.0 工作台与本地 ComfyUI。ComfyUI 需要能加载本流程使用的原生 3D 节点和下表的六个权重。按官方教程核对节点与权重来源。 [ComfyUI 官方教程](https://docs.comfy.org/tutorials/3d/pixal3d) · [Comfy-Org 权重](https://huggingface.co/Comfy-Org/Pixal3D)
2. 从画布添加菜单的「3D 资产加工」点击「检查 Pixal3D 图生 3D 依赖」。也可在仓库根目录运行下列命令。Windows 便携版可用 Python 的完整路径替换 `python`。按报告补齐 `missingNodes` 或 `models` 中标为 `missing` 的权重，并排查 `ambiguous` 的重复项。预检核对节点注册和权重选项。

   ```powershell
   python scripts/check_pixal3d.py --url http://127.0.0.1:8188
   ```

3. 在画布顶部进入「节点库 → 本地节点／导入工作流」，选择 [图生 3D API 工作流](../workflows/pixal3d_lamp_shade_api.json)，确认一个图片输入后添加到当前画布。连接一张主体完整、轮廓清晰的参考图，再运行节点。
4. 在画布的结果卡片检查 GLB。若要继续加工，在同一项目添加「原高模 · 百分比LOD」，查看「3D 资产加工」菜单里的「Native3D LOD」就绪状态，并把 GLB 结果卡片的 `model` 输出接到 LOD 的模型输入。首次运行 LOD 时，画布先将原 ComfyUI GLB 保存到当前项目。保存期间请留在当前项目；项目、写入权限或输入变化会阻止继续提交。 [Native3D 配置](NATIVE3D.md)
5. 需要独立文件时，可下载 GLB 并在 Blender 或支持 glTF 材质的查看器中检查背面、薄边、镂空、底色、金属度／粗糙度、法线与 AO。

| ComfyUI 模型目录 | 文件 |
| --- | --- |
| `diffusion_models` | `pixal3d_int8_convrot.safetensors` |
| `vae` | `trellis_2_shape_vae_bf16.safetensors`、`trellis_2_texture_vae_bf16.safetensors` |
| `clip_vision` | `dino_v3_L_naf_fp32.safetensors` |
| `geometry_estimation` | `moge_2_vitl_normal_fp16.safetensors` |
| `background_removal` | `birefnet.safetensors` |

## 当前验收范围

- 既有灯罩样例在 RTX 3090 Ti 24 GB 与 ComfyUI 0.45.0 上通过预检并导出 GLB。本轮回归检查了 GLB 到 LOD 的连线、项目保存保护和任务续查；图生 3D 到 LOD 的全链冷启动 GPU 验收以及其他显卡的端到端复跑待完成。
- 本工作流交付单图到单个带贴图的 GLB。灯罩演示中的双 LOD、曲率旧化和 AI 脏迹加工，以及后续参数化部件装配，各有独立的验证和交付范围。
- 工作流引用本机已安装的权重。参考图从画布输入口提供，`input.png` 只是 API 工作流中的占位名。
