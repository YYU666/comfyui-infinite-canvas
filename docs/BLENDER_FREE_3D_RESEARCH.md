# Blender-free 3D：组件研究与验证计划

日期：2026-11-03。对应 PRD 修订：1.1.2；目标功能版本：画布 1.1.0。

本文件保留1.1.2基础组件核查记录。现行PRD为1.1.7；统一计算空间、首版材质精确支持表、8/12GB验证与新AI候选见 [流程复审及模型研究](3D_PIPELINE_REVIEW_AND_MODEL_SURVEY.md)，跨资产与可替换执行器见 [通用节点契约](3D_NODE_ADAPTER_DESIGN.md)。后续补充不代表这些库已安装或通过独立全流程验收。

状态：已阅读官方资料和部分实现，尚未安装、编译或运行候选引擎。本文是选型与验证计划，不是性能或功能验收报告。主依据为 [3D 流程 PRD](PRD_3D_ASSET_WORKFLOW.md)。

## 1. 决策

**采用完全独立于 Blender/ComfyUI 的后台执行器。** 不捆绑 Blender、不安装 bpy、不借用 Blender Python，也不在失败时自动回退到 Blender。复用现有 MeshAnything AI 候选→修复/贴合→QEM LOD 案例，迁移其环境相关包装；不把传统简化改成 AI 主线。

本轮没有确认一个同时满足 Windows、明确许可、可嵌入、完整 Normal/AO/PBR 转移的成熟一体化开源替代品。可行方式是复用成熟基础库，自研任务、烘焙与资产衔接。先验证最小完整链，再决定正式后端，避免同时维护多套未经验证的依赖。

## 2. 组件候选与复用边界

| 环节 | 推荐或候选 | 已核实能力 | 仍需开发/限制 |
|---|---|---|---|
| 导入/导出 | [trimesh](https://github.com/mikedh/trimesh)，MIT | Python 网格、场景、GLB/OBJ、采样等 | 使用 `process=False` 避免隐式处理；保留场景实例/变换；角点/材质往返需验证，不能因支持格式就保证无损；禁用 Blender backend |
| AI 候选 | 现有 MeshAnything V2 环境 | 本机历史真实 AI 候选与几何链 | 脱离 DCC 的预处理、通用输入、取消和回执；模型使用条款与代码子依赖独立核对 |
| 几何与 LOD | 已有修复/QEM 核心；[meshoptimizer](https://github.com/zeux/meshoptimizer)，MIT | meshoptimizer 提供简化、属性权重、边/顶点约束、缓存优化，支持 CMake/MSVC | 优先保留已验证 AI 后处理；meshoptimizer 主要用于显示代理/可选传统模式；现有 native 版本较旧，不能假设具备最新 API |
| UV | [xatlas](https://github.com/jpcy/xatlas)，MIT | 独立 C++11，分岛、参数化、打包、重打包，进度/取消 | 封装 worker；切缝约束、拉伸/重叠/留白检测；用 xref 保存接缝分裂映射；不是烘焙器 |
| 几何查询原型 | [Open3D](https://github.com/isl-org/Open3D)，MIT | RaycastingScene 射线、最近点；Windows Python wheel | 自研 UV 光栅化和材质采样；不是完整高低模烘焙器；原型通过后再决定是否长期保留 |
| 正式 CPU 射线候选 | [Embree](https://github.com/RenderKit/embree)，Apache-2.0 | Windows x86 CPU，求交、遮挡和属性插值基础 | 独立 C++ worker、BVH 生命周期、图块任务、取消；GPU 支持不能当 NVIDIA CUDA 烘焙 |
| 切线规范 | [MikkTSpace](https://github.com/mmikk/MikkTSpace)，zlib-style | 独立 C/H，生成切线及方向符号 | 不是 normal baker；输出按角点处理，不能平均回不适当的共享顶点；三角化必须与目标显示一致 |
| 查看和封面 | Three.js 查看器及待验证离屏任务 | 采用同一材质/相机定义的设计方案 | Windows 离屏渲染、上下文释放与失败回退需实测；不把浏览器高模直载作为默认路径 |

Assimp（BSD-3-Clause）留作后续格式适配候选。官方格式文档把 Blend 标为 deprecated，FBX 导出标 experimental；不以此承诺 `.blend` 或 FBX 的完整兼容。

## 3. 已有独立烘焙项目

| 项目 | 研究结论 | 处理 |
|---|---|---|
| [BakeForge](https://github.com/efimco/BakeForge) | MIT；Windows 10/11、DX11、C++20；有实际 UV 光栅化/BVH/Cage/切线法线实现及 glTF/GLB 导入。README 将 AO 和 padding 列在 roadmap | 可评估 Windows GPU 法线模块；需抽出无界面任务接口、命中掩码、取消/错误与测试；不作为现成完整 PBR baker。README/CMake 最低 CMake 版本不一致，构建以源码为准 |
| [Fornos](https://github.com/caosdoar/Fornos) | Normal/AO/Bent Normal/Height/Thickness 等方向相关，有 Visual Studio 工程；作者标 early preview，提示大模型内存与稳定性限制 | 根目录/README 未查到明确项目许可，暂不复制或分发；授权澄清后才能评估复用 |
| [giuliom95/baker](https://github.com/giuliom95/baker) | Embree + OpenEXR 的 C++ normal baker；作者只确认 CentOS7，TODO 含多线程 | 未查到明确项目许可，Windows 未证实；仅作技术阅读，不作为可分发依赖 |

代码公开可读不等于具有再分发授权。以上没有本机运行结果，不做速度排名。

## 4. 独立烘焙的实际开发量

执行链：低模 UV 像素→低模表面位置/角点法线→Cage 射线→高模三角形命中与重心坐标→源 UV/法线/材质插值→Normal/AO/源材质转移→扩边→接缝、命中与视觉报告。

- **Normal**：几何法线与源角点/细节法线来源明确，转换到低模 MikkTSpace；记录 normal Y 方向。
- **AO**：真实几何半球遮挡采样、距离与采样数明确，不能从底色灰度推断。
- **BaseColor/Roughness/Metallic**：先支持明确的单材质 glTF metallic-roughness 参数/纹理输入，按源 UV 与色彩空间传递；未支持的节点材质、多材质、UDIM 明确阻止而非丢弃。缺失通道用用户确认的基础值并标来源。
- **诊断与扩边**：独立记录 UV 内部、命中、漏烘、错层风险、岛和边缘，不把白色命中图当材质。先小图检查，再正式 2K/4K。

Open3D 的 `primitive_uvs` 指命中三角形的重心坐标，不是贴图 UV。`bake_vertex_attr_textures`/`bake_triangle_attr_textures` 只把已有网格属性写进纹理，不能直接完成上述高低模流程。`project_images_to_albedo` 需要相机标定，不能用任意参考图代替。signed-distance 内外符号对闭合性有前提，开放岩壁不能直接据此翻面。

Open3D UVAtlas 可作 xatlas 的备选对照，但需要流形输入、在 CPU 执行，不等同 xatlas。查询到 PyPI 0.20.0 有 Windows amd64 wheel（Python ≥3.10）；约 77–79 MB 是单 wheel 大小，不是完整运行环境体积。RaycastingScene 文档列 CPU/SYCL，不据此承诺本机 NVIDIA GPU 加速。

## 5. 实施验证门与停止条件

1. **环境与 I/O**：无 Blender/ComfyUI 的独立环境；GLB/OBJ 导入/导出保留几何、角点法线、变换、UV 和受支持材质。源文件只读；缺属性明示。绑定依赖版本、commit/hash 与许可证，开发时复查上游变化。
2. **几何迁移**：提取已有 AI 前后处理，替换 bpy/mathutils/BVHTree；在同一源快照上对照历史候选、修复、贴合和连续 LOD，检查轮廓/误差及拓扑，不只比面数。变更算法必须单独记录，不能借迁移重写已验证主线。
3. **UV 原型**：xatlas 独立执行，测试 seam/xref、开口、硬边、镜像、退化、重叠、留白。先交付真实低模 UV，再做烘焙。
4. **CPU 烘焙基线**：Open3D 查询原型或 Embree 实现至少 Normal、命中掩码、AO，再补受支持源材质转移。验证凹槽、开放片、错 Cage、跨层误命中、法线 Y、接缝、导出切线；历史 12.1943% 漏烘案例不能被误报通过。
5. **性能决策**：同一输入对照 CPU 基线与 BakeForge 法线候选；记录时间、峰值进程树 RAM、VRAM 和质量。只有收益与正确性证据充分才新增 GPU 依赖，不提前承诺倍率。
6. **产品接入**：统一 worker job/取消/恢复协议；来源高模、显示代理、实际烘焙源分开。结果经当前页面写入节点、连线和 revision。2K 完整材质链验收后再验证 4K 与大高模。

无 Blender 完整链失败时保留阶段成果，修复独立执行器；不隐藏启用 Blender。Normal 原型通过不代表 1.1.0 完整材质流程通过；所有正式通道、导出往返和质量门仍需完成。

## 6. 高模性能与交付边界

沿用 PRD 的单查看器、640px 封面、默认 10 万面代理、2K 预览、独立 RAM/VRAM 预算。高模只在受控后台使用；流式上传不等于流式解析。BVH、纹理、体素和 Python/native 双份数组分别计入峰值。射线按图块处理可限制输出缓冲，但不能声称全部源几何/BVH 都能分块或无限大。

迁移不自动保证更快、更省内存。先记录 CPU 基线；MeshAnything GPU 与烘焙/查看器争用资源由独立任务调度控制。缓存按源/参数/引擎哈希失效，源模型和正式结果不作为可清理缓存。

AI 环境与几何工具分包；MeshAnything 的 S-Lab 条款及 GPL 子组件仍需按具体选定版本核对，不因去掉 Blender 自动消失。权重和个人研究资产不纳入画布发行包。

## 7. 官方核对来源

- [xatlas README](https://github.com/jpcy/xatlas/blob/master/README.md)、[meshoptimizer README](https://github.com/zeux/meshoptimizer/blob/master/README.md)
- [trimesh README](https://github.com/mikedh/trimesh/blob/main/README.md)、[LICENSE](https://github.com/mikedh/trimesh/blob/main/LICENSE.md)
- [Open3D LICENSE](https://github.com/isl-org/Open3D/blob/main/LICENSE)、[RaycastingScene](https://www.open3d.org/docs/release/python_api/open3d.t.geometry.RaycastingScene.html)、[TriangleMesh](https://www.open3d.org/docs/release/python_api/open3d.t.geometry.TriangleMesh.html)、[PyPI](https://pypi.org/project/open3d/)
- [Embree README](https://github.com/RenderKit/embree/blob/master/README.md)
- [BakeForge README](https://github.com/efimco/BakeForge/blob/main/README.md)、[MIT LICENSE](https://github.com/efimco/BakeForge/blob/main/LICENSE)、[bakerPass.cpp](https://github.com/efimco/BakeForge/blob/main/src/passes/bakerPass.cpp)
- [MikkTSpace header 与许可](https://github.com/mmikk/MikkTSpace/blob/master/mikktspace.h)
- [Assimp 格式表](https://github.com/assimp/assimp/blob/master/doc/Fileformats.md)、[构建说明](https://github.com/assimp/assimp/blob/master/Build.md)、[LICENSE](https://github.com/assimp/assimp/blob/master/LICENSE)

官方默认分支可能继续变化；本文是本次核对结论，实施时需要固定版本并重新验证，不把网页描述当构建/性能测试。
