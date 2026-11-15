# 3D 角色转多方向图集

把本机带动画 GLB / FBX 渲染为透明颜色图集、相机空间法线图集和 JSON。参考 [Spritebake](https://www.madeintaiwan.ai/projects/spritebake/en/) 的产品流程，采用独立实现；没有复制其代码或素材。RGS 第一阶段使用颜色 PNG，法线 PNG 一起导出保留。此功能没有修改冻结的 3D 生成模块，不依赖 ComfyUI。

## 节点与菜单

- preset：`sprite_atlas`
- 界面类型：`spriteAtlas`（独立的画布节点，不是 ComfyUI 工作流）
- 菜单：**游戏美术 / 精灵图 → 3D 角色转多方向图集**
- 节点内填写角色文件的本机绝对路径，例如 `D:/Characters/Hero.glb`。不接收网址、网络共享或 `.blend` 文件，不上传模型。
- 输出在节点内显示两张图集及三个下载链接。颜色与法线不能互相替代；旧结果会保留并标记参数已改变。失败或取消不删除节点。

| 参数 | 默认值 | 范围与含义 |
| --- | --- | --- |
| `spriteInputPath` | 空 | 本机 `.glb` / `.fbx`；最大 512 MiB |
| `spriteOptions.directions` | 8 | 4 / 8 / 16 |
| `frameSize` | 192 | 32–1024，方形单帧像素数 |
| `framesPerAction` | 8 | 1–64，每段动作每个方向的采样数 |
| `actions` | `[]` | 全部动作；或最多 8 个精确动作名，界面每行一个 |
| `elevation` | 10 | 0–60°，相机俯视角 |
| `startYaw` | 0 | -360–360°，第一个相机朝向 |
| `padding` | 0.1 | 0–0.4，构图留白 |
| `pivot` | `[0.5, 0.9]` | 每个坐标 0.01–0.99，从单帧左上角计的归一化轴心 |

表中除文件路径外，参数都放在 `spriteOptions` 中。已导入的动作名可在成功输出的 JSON 中查看；名称无效时会明确失败。没有动画的模型生成 `Static` 姿势。超过 8 个动作时要求显式筛选，不会悄悄丢弃动作。复杂多条 strip 的 NLA、非 Principled BSDF 材质会明确报错；先在素材工具中整理动作、转换为 glTF PBR。常规 Principled 基色纹理与 Alpha、骨骼和形态键按导入结果处理；没有承诺任意自定义着色网络都可烘焙。

## 输出与 RGS 读取约定

每个任务产生 `albedo.png`、`normal.png`、`atlas.json`，schema 为 `refmuse.sprite-atlas.v1`。

- 两张 PNG 均为 RGBA8，尺寸和帧矩形一致，背景透明。颜色为无灯光的 Base Color（sRGB），不把场景阴影烘进颜色图。法线使用线性数据，不做 sRGB 转换。
- 列顺序是帧索引，行顺序是动作索引 × 方向索引。`row = actionIndex * directionCount + directionIndex`。原点在左上角，JSON 的 `frames[].rect` 使用像素坐标。
- 默认 8 方向顺序为 `front, front-right, right, back-right, back, back-left, left, front-left`，对应 yaw `0,45,90,135,180,225,270,315`。4 / 16 方向以 JSON 中实际 `directions[]` 为准。`startYaw` 会偏移这些角度。
- 这些标签表示**模型的相机观察方位**，并非引擎的屏幕运动方向。Blender 世界轴向为 +Z 向上，相机 yaw0 位于 -Y、yaw90 位于 +X；RGS 应根据 `worldAxes`、yaw 和自己的角色前向约定映射，不能只按名称猜朝向。模型本身若不是朝向 -Y，需要调整 `startYaw`。
- 法线坐标为相机 +X 向画面右、+Y 向画面上、+Z 朝观察者，RGB=`0.5 * normal + 0.5`。解码后重新归一化；法线纹理应按线性数据加载，不套颜色纹理的 gamma。Alpha 是覆盖率；透明背景 RGB 不参与照明。
- 所有采样动作及方向共用固定正交缩放和世界锚点，避免每帧缩放跳动。`worldAnchor` 为采样包围范围的地面中心；相机把它投影到请求的 pivot。JSON 同时写入全局归一化轴心和每帧像素轴心。该锚点不是自动识别的脚骨或脚底接触点。
- 动作按源帧范围均匀采样，排除终点，避免循环末尾重复第一帧。`sourceFps` 是导入源时基；`actions[].durationSeconds`、`playbackFps` 是图集播放时长和采样帧率。RGS 应使用后者，而非直接用源 FPS 播放 N 张采样帧。`frames[].sourceFrame / sourceTimeSeconds / clipTimeSeconds` 保留溯源时间；Static 的播放速率为 0。
- RGS 本次先读取颜色 PNG + JSON；没有改动 RGS 引擎或承诺法线照明已经接入引擎。

例如一个动作 × 8 方向 × 8 帧 × 192px，图集为 1536×1536。两个动作时为 1536×3072。最多 8192px 单边、6400 万像素；若全部动作导致超限，任务失败并提示减少参数，不静默降质。

## 后端与生命周期

后端查找 `H3_BLENDER_PATH`、PATH 以及标准 Blender 安装目录；缺失时报告 `BLENDER_MISSING`，不会安装或下载。已在 Blender 5.2.3 LTS 验证。运行命令使用 `--background --factory-startup --disable-autoexec --threads 2 --python-exit-code 1`，Cycles CPU 单采样；禁用 GPU 可见性。两个线程限制 CPU 并行度，渲染仍会消耗主内存和磁盘。

队列同时只执行一个 Blender 子进程，最多 4 个未完成任务，单任务最长 30 分钟，日志最多 16 MiB。取消、关闭仅停止这个任务持有的子进程树。活动任务阻止应用升级和项目根目录切换。没有连接或提交 8188 / 8189 的逻辑。

接口均经过工作台已有会话、Host、Origin 检查：

| 接口 | 用途 |
| --- | --- |
| `GET /api/sprite-atlas/status` | 检查本机 Blender |
| `POST /api/sprite-atlas/jobs` | `{projectId, revision, nodeId, inputPath, options}`，返回任务 |
| `GET /api/sprite-atlas/jobs/{id}` | 查询 `queued/running/done/error/cancelled` |
| `POST /api/sprite-atlas/jobs/{id}/cancel` | 取消当前项目持有的任务 |
| `GET /api/sprite-atlas/jobs/{id}/files/{name}` | 仅下载该成功任务的三份成品 |

创建任务必须匹配已保存项目 revision、实际写锁以及 `spriteAtlas` 节点。取消仍校验原项目写锁，但允许节点已删除。导出存放在**当前实例 runtime 目录的 `sprite-atlas/{id}/`**，不会直接覆盖项目 JSON，也不受用户指定输出路径影响。成功结果可跨服务重启下载；被中断的任务不会自动重跑。页面重载只恢复查询已有任务。

项目节点保存的是本机输出链接；向另一台机器转交时，必须把两个 PNG 和 JSON 一起下载、打包转交。仅复制项目 JSON 不包含这些独立导出文件。

## 建议完整菜单方案（发布前群审稿）

这是建议方案，**本 PR 只新增“游戏美术 / 精灵图”分组**，没有重排既有全部菜单，也没有把第三方节点并入官方分类。

| 一级分类 | 二级分类 | 节点或入口 |
| --- | --- | --- |
| 素材与组织 | 素材 | 图片、视频、音频、PureRef 导入、视频链接下载 |
| 素材与组织 | 创作组织 | 备注、提示词优化 |
| 图片 | 生成 | H3-Image、Krea2、MOSS |
| 图片 | 编辑 | 多图编辑、图生图、角色四视图、角色/服装编辑等现有入口 |
| 图片 | 调色与合成 | 图片调色（类型放节点下拉菜单）、图像混合、RGBA 通道合并 |
| 图片 | 清晰度 | 图片高清（模型放节点内选择） |
| 视频 | 生成 | 现有 H3 视频生成、角色替换等 |
| 视频 | 增强 | H3 高清二采、视频超分（RTX / SeedVR2 在节点内选择） |
| 视频 | 兼容性待完成 | Open-H3 IC 2K 精修，明确禁用并显示缺口，完成前不列为可运行工具 |
| 游戏美术 | 精灵图 | **3D 角色转多方向图集** |
| 审图辅助 | 美术审查 | 电子主美 / 图解分析 |
| 3D | 保留当前分类 | 冻结的既有 3D 功能另行审计，本次不迁移 |
| 第三方工作流 | 按包来源/功能分组 | 本机导入的第三方节点，显示来源，与内置工具独立 |

审计重点：一项能力只保留一个菜单入口，模型、调色子类型放节点内部；“工作流来源”和“用途分类”分别标示；未完成的适配不能冒充可运行节点。该表需在发布前交群内审计；本线程未代为发群消息。合并使用 merge 方式，等木一本人确认后再合并、打 tag、发布。

## 开发验收

- `node test-sprite-atlas.mjs`：参数、资源边界、输出身份、轮询/取消、保存重载、复制/历史及页桥接口。
- `node test-sprite-atlas-ui.mjs`：独立 React 组件与 hook，模拟后端；不加载画布应用，不访问用户服务，不打开外部窗口。验证参数提交、只读、失败保留、下载链接和取消。
- `python -m unittest test_sprite_atlas test_sprite_renderer`：隔离后端、授权、进程与输出校验。无 Blender 的 CI 跳过显式实渲测试，不能把此跳过写成真实渲染通过。
- 本机实渲：指定 `H3_SPRITE_BLENDER` 为 Blender 可执行文件、`H3_SPRITE_SAMPLE_DIR` 为证据目录，再运行 `test_sprite_renderer`。程序自建带骨骼、两段动作及嵌入纹理的 GLB / FBX，不用用户素材。
- 实渲已检查 8 方向、两段动作、192px，配对 Alpha、法线相机基、纹理与动画变化、无裁切、GLB24fps / FBX30fps 时间；另有 4 / 16 方向小样。
- 用户画布上的验证交给“继续修改角色四视图工作流”线程；本线程不操作画布、不重启工作台或 ComfyUI。发布仍需群审、画布验收、CI 及木一本人确认。
