# Refmuse 本地图片转 PBR

将 `comfy-nodes/refmuse_pbr` 安装到本地 ComfyUI 的 `custom_nodes`，待队列空闲后重新加载 ComfyUI。确认 `/object_info/RefmuseTextureToPBR` 中有六个图像输出。节点使用 ComfyUI 已有的 Torch，无需模型权重。

在 Refmuse 节点库导入 `workflows/refmuse_texture_to_pbr_api.json`，连接图片即可检查基色、高度、切线法线、粗糙度、金属度和近似 AO。独立节点的金属度默认是零，ComfyUI 中可以连接显式金属遮罩。高度、粗糙度和 AO 是图像估算值。

运行 `python scripts/build_pixal3d_pbr_workflow.py chest_uv_pbr_api.json` 可以生成另一个可导入画布的工作流。它从 Pixal3D 已投射到 UV 图集的颜色估算粗糙度，保留几何烘焙的法线、AO 和 Pixal3D 的金属度，把贴图写入 GLB。参考图上的贴图预览与模型 UV 图集是两个独立分支。
