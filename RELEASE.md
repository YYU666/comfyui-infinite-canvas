# Refmuse 本地工作台 v1.0.17 · 多方向精灵图集

新增「游戏美术 / 精灵图 → 3D 角色转多方向图集」节点（preset `sprite_atlas`，界面类型 `spriteAtlas`）。输入本机带动画 GLB / FBX，通过 Blender CPU 渲染 4 / 8 / 16 方向、每动作 N 帧，默认单帧 192px。

同步导出透明颜色图集 `albedo.png`、相机空间法线图集 `normal.png` 和 `atlas.json`，两张图集尺寸、格局一致。JSON 包含方向顺序 / yaw、帧矩形、轴心和动画播放时基；RGS 首期可只用颜色图集。

支持动作筛选、帧数、尺寸、俯视角、起始朝向、留白和轴心设置；失败保留节点与已有结果。独立 CPU 队列不调用 ComfyUI，也不会自动安装 Blender或下载权重。复杂 NLA 和非 Principled PBR 材质明确报错。导出文件位于本机运行目录，跨机器转交时须一起下载三份文件。

## 验证

- Blender 5.2.3 CPU：程序生成的动画 GLB24fps / FBX30fps、两动作、8方向、192px 图集实测通过，另测4/16方向；配对 Alpha、纹理透明度、法线方向、动画变化和布局通过检查。
- 独立组件测试覆盖参数、只读、取消、失败保留和下载链接；真实后台到 Blender 的输出及成功文件重新读取验证通过。
- Node 回归51个文件通过；Python CI两种编码环境各505项通过（3项条件跳过）；构建、隔离浏览器及公开包检查通过。
- Codex 独立审查通过，菜单分类方案已公示。没有操作或重启用户现有画布及 ComfyUI；当前画布验收由专门线程继续进行。

## 更新

已有官方安装使用 `refmuse-update-v1.0.17.zip` 和同名 `.sha256`。全新安装使用 `refmuse-portable-v1.0.17.zip` 及其 `.sha256`，并按安装说明配套 Windows Python runtime；不要用 GitHub 自动生成的源码压缩包代替更新包。

本版不包含 Blender、模型权重、第三方节点目录、个人素材或生成结果。使用精灵图功能需本机已有 Blender；可设置 `H3_BLENDER_PATH` 指向可执行文件。完整用法见 `docs/SPRITE_ATLAS.md`。
