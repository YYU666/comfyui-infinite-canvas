# Refmuse 本地工作台 v1.1.0

本次更新将本地 3D 资产加工带到默认画布，并收录可手动导入的 Pixal3D 图生 3D 工作流。

## 本地 3D

- 右键添加菜单的「3D 资产加工」可导入本机 3D 模型，并连接原高模百分比 LOD、UV 展开或材质烘焙。默认显示入口，运行前需配置独立 Native3D Python，并通过所选操作的依赖检查。AI 低模、UV 切缝方案和 FBX 导入有各自的额外依赖。详见 [Native3D 配置](docs/NATIVE3D.md)。
- Pixal3D 是面向单件资产的可选本机预览流程。配置支持对应节点的 ComfyUI 和六份独立权重后，在节点库导入 API 工作流，连接单张参考图并运行，完成后从画布结果卡片下载带材质的 GLB。详见 [Pixal3D 配置及验收](docs/REFMUSE_LOCAL_IMAGE_TO_3D.md)。

## 画布与视频

- 画布新增恒定速度和时间重映射、视频编辑、绿幕合成、CPU 局部修补和绿幕白模。运行条件随节点变化。常用编辑依赖本机 FFmpeg，绿幕白模还需本机 ComfyUI 的 SAM3.1 权重及对应节点。 [视频编辑](docs/VIDEO_EDITOR_E1.md) · [绿幕白模](docs/VIDEO_WHITE_PLATE.md)
- 视频超分提供 RTX VFX 与实验性 SeedVR2 选项，所选模型和本机节点需通过预检。Open-H3 2K IC 入口保持禁用，等待兼容运行时。 [视频超分和运行条件](docs/VIDEO_SUPER_RESOLUTION.md)
- 文生图和图生图可在本机已安装且兼容的模型中自动选型，保留用户手动选择。节点库新增针对已安装包的版本预检与发布状态查询。MOSS 姿势控制为实验入口。 [图像选模](docs/image-model-picker.md) · [节点库发布记录](docs/NODE_LIBRARY_UPDATE_SYNC.md) · [MOSS 姿势控制](docs/MOSS_POSE.md)

## 验证范围

Native3D 版本检查覆盖独立运行环境、队列与受控更新边界。实际加工取决于所选操作、本机依赖及模型。Pixal3D 的单图到 GLB 记录来自灯罩样例与本机 RTX 3090 Ti 24 GB，使用 ComfyUI 0.45.0。其他显卡、干净环境的完整 Pixal3D 复跑及参数化部件装配仍待验证。

## 更新与全新安装

已有官方安装使用 `refmuse-update-v1.1.0.zip` 和同名 `.sha256`。全新安装使用 `refmuse-portable-v1.1.0.zip` 及其 `.sha256`，并按安装说明配套单独的 Windows amd64 Python runtime 压缩包及校验文件。维护者通过 GitHub Actions 手动校验候选提交；正式发布需从默认分支核对 commit SHA 和远端版本标签，并在草稿中验证六份远端文件后再公开。GitHub 自动生成的源码压缩包仅供查看源码。

程序包仅包含公开程序文件，便携包另带前端构建。Native3D 独立环境、可选适配器、Pixal3D 权重、Blender、用户项目和生成结果由各自的本机环境管理。已有程序的升级流程见 [程序更新](docs/UPDATES.md)。
