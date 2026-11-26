# 烘焙默认设置与成熟工具对照

日期：2026-11-04。范围：本地 1.1.0 开发；不发布、不上传，不覆盖既有模型、UV 或烘焙结果。

## 本轮决定

先对照成熟工具的公开设置和投射机制，再运行有明确目标的验证。禁止把反复调整整图参数当作定位算法缺陷的方法；参数质量提升不等于投射缺陷修复。

本机 CPU 实测为 AMD Ryzen 9 5950X。Intel OIDN 支持具有 SSE4.1 的 x86-64 CPU，适用于该 AMD CPU；Intel 是项目名称而非 CPU 厂商限制。OIDN 尚未安装或实测，不保证 UV AO 图的降噪效果，也不用于掩盖错投射或法线问题。

## 可核实的官方依据

| 来源 | 官方明确说明 | 采用方式与限制 |
| --- | --- | --- |
| [Substance Bakers 通用参数](https://experienceleague.adobe.com/en/docs/substance-3d/bakers/bakers-settings/common-parameters) | 默认输出 2048；独立前/后投射距离；自定义 cage；Average Normals；按名称匹配；扩边；AA 默认 None，可选 2×2/4×4/8×8 | 采用 2048 基线。保留已有 2×2 法线采样，不把它宣称为 Adobe 默认或等同全图超采样。距离按模型尺度解释，不跨软件照抄绝对数值。 |
| [Substance AO From Mesh](https://experienceleague.adobe.com/en/docs/substance-3d/bakers/bakers-settings/ambient-occlusion-from-mesh) | 默认 64 条 secondary rays；最大遮挡距离 .1；最小距离 .00001；cosine；180°；linear attenuation；遮挡范围可按包围盒归一化 | 采用 64、独立 AO 半径 .1 高模对角线和线性衰减。AO 最小命中距离与起射偏移是不同概念，本轮不把 .00001 偷换成 epsilon。 |
| [Substance Tangent Space](https://experienceleague.adobe.com/en/docs/substance-3d/bakers/features/tangent-space) | Painter 使用 MikkTSpace；per-fragment 选项影响与 Blender/UE 等的兼容 | 已接入真实 Mikk 角点基底；仍须验证解码/插值约定。Mikk 标签本身不是跨引擎验收。 |
| [Marmoset 官方烘焙教程](https://marmoset.co/posts/toolbag-baking-tutorial/) | Smooth Cage、Ignore Back Faces、Bake Groups、Estimate Offset、局部 Offset/Skew 绘制、局部重新烘焙、按分辨率自动 padding | 借鉴机制与交互。教程发表于 2017，不把其中数字称为 Toolbag 最新版出厂值。文中 AO 默认 256、中等质量，512+ 高质量；本轮 256 是本产品可选精细档上限。 |
| [Intel OIDN](https://github.com/RenderKit/oidn)及[API](https://github.com/RenderKit/oidn/blob/master/doc/api.md) | 神经网络降噪、支持 AMD 等兼容 CPU；RT 为光追渲染图，RTLightmap 为 HDR/方向光照贴图 | 后续可选实验；不将普通 AO 图直接等同官方训练分布，不把切线法线当颜色滤波。 |

Substance 通用文档注明不同宿主软件行为可能不同。其通用表格与 Painter 具体版本界面不应混为一谈。未安装商业软件运行同模型，不宣称已与 SP/SD/八猴达到相同效果。

## 当前实现的差距

- 历史默认仅 1024 / 16 AO rays，试验模型用过 2048 / 32 rays；AO 最大距离由 cage×4 推出。调投射范围会同时改变阴影范围。
- 当前有真实 Mikk 基底、2×2 法线子采样、余弦半球 AO、有界方向投射与已认证补充候选。
- 当前缺少独立前后 cage 距离、每部件匹配、局部 offset/skew、局部重新烘焙。单岩石案例不能证明这些通用能力已有。
- primary 背面命中目前报告而非自动拒绝；AO 是否接收背面和高低模投射是否接收背面是两个独立设置，不能混为一次开关。
- AO 起射偏移仍为 max(cage×1e-4, 1e-7)，尚未做数值精度与局部厚度联合估计。本轮仅拆开最大遮挡距离，不能声称所有 AO 参数已与 cage 解耦。

## 本轮有界代码目标

| 参数 | 预览组合 | 默认标准组合 | 可选精细组合 |
| --- | --- | --- | --- |
| 分辨率 | 1024 | 2048 | 2048 或 4096 |
| AO rays | 16 | 64 | 256 |
| AO 最大距离 | 高模对角线×.1 | 同左 | 同左 |
| AO 衰减 | linear | linear | linear |
| 岛外 padding | 自动 8px | 自动 16px | 2048:16px / 4096:32px |
| 法线采样 | 保留现有 2×2 | 同左 | 同左 |

这些是本产品参数组合，不宣称是三个软件共有预设。默认提高采样会增加计算时间；本轮不在用户岩石上反复全图重烘焙，也不声称新的耗时结果。用户已有显式分辨率/样本数不覆盖。历史任务若要严格复现还需保留历史代码与完整参数，新算法版本需记录在结果 metadata。

线性 AO 衰减仅改变距离权重，不用于“变白消黑”；必须验证已知解析距离的输出以及 none 模式旧行为。扩边仅在 UV 覆盖之外操作，不填充岛内歧义。投射算法、原始模型和 UV 本轮不动。

## 黑块的现有证据及后续验证顺序

来源：`NATIVE3D_BAKE_NORMAL_AO_PILOT.md` 与 `.cache/native3d/blender-bake-2048-20261104/`。

- Blender 恒白 Emission 对照显示深槽黑块包含投射漏失；AO only_local 开关未改变该对照像素。现有证据不支持直接归因于低模作为 AO 遮挡物，也不证明高低模完全没有穿插。
- 旧自研近点投射曾落在相邻内层；已修复投射及基底后，2048 覆盖中仍有 377 个不确定纹素，其中 374 个不同表层歧义、3 个法线子采样失败。这些不是 AO 随机噪声，不能用更多 rays 或 OIDN 解决。
- 后续先保存/复用命中位置、方向、primitive、失败分类；优先对异常区域验证 cage、匹配关系与方向，再进行一次必要的整体验收。局部重烘焙属于后续实现项，当前不能冒称已具备。
- 通用能力顺序：明确高低模匹配组 → 分离前后/局部 cage 预算 → AO 数值精度与局部尺度偏移 → AO 空间抗锯齿/适应采样 → 每组质量报告与异常遮罩 → 可选 AI 降噪。

验收分为实现正确性、真实资产视觉效果、跨工具兼容三层。针对解析夹具的单测不替代真实资产视觉验收；保留 needs_review，不接受用中性占位或滤波将剩余未知标为成功。

## 本轮实现验收

决定：接受本轮默认设置与独立 AO 参数的有界实现；真实岩石剩余歧义及跨工具视觉验收仍待处理。

已修改 `native3d_jobs.py`、`native3d_engine.py`、`native3d_bake_ao.py`，新增 `test_native3d_bake_settings.py`。队列与 worker 使用相同严格参数校验；显式参数不覆盖；结果记录 `bake-defaults-20261104` 及实际解析参数。自动扩边 0 表示按分辨率推导，用户可显式设置 1–64px。

执行 `.cache/native3d/venv/Scripts/python.exe -m unittest test_native3d_bake_settings test_native3d_bake_ao test_native3d_jobs test_native3d_bake_texture_transfer`：31 项通过，主线程复核约 4.40 秒。覆盖解析平面遮挡积分、none 兼容、无命中、参数非法值、显式值保留、尺度解耦和材质转烘。独立只读复核无 P1/P2；补充精确距离及非法距离检查通过。

本轮未更改投射算法、原模型或 UV，未安装 OIDN、未重新烘焙用户资产、未重启服务、未发布。运行中的后端及页面可能仍持有旧 schema，不能将磁盘代码通过视为当前页面已加载新默认。377 个未知的历史结果仍保留，不作成功化处理。

## 用户授权的 256 采样实测与交付

随后用户要求提高采样重新烘焙。仅运行一次独立 native worker：同源高模及 1772 面低模、2048×2048、AO256、半径 .1、linear、自动扩边16。实际耗时223.72秒。原始角点位置和UV一致；覆盖、命中遮罩一致；UV覆盖内法线像素完全一致。有效2458392/覆盖2458769，377个未知仍保留。与此前32样本/.08半径/none对照同时变化了半径和衰减，不解释为纯采样效果。

自动审批拒绝后端重启（仅返回“策略阻止”）；没有重新尝试重启，也没有修改旧服务schema。采用允许的独立后台计算，再从当前页面正常导入模型与对照图。当前页节点21为实际带贴图模型，22为AO前后对照，已通过诊断参考线连接新旧结果及真实UV来源，并保存。证据：`.cache/native3d/bake-256-20261104/final-delivery.json`。

交付核对发现 analyze 导入生成的预览会丢失标准TANGENT属性。修复为仅在已通过原有输入验证、静态自包含GLB、≤100000面且无需简化的analyze中逐字节保留原始GLB；分析与海报仍使用世界坐标，其余路径不变。4项定向测试及独立复核通过。当前页重新分析后，model/proxy与本次原始烘焙GLB SHA256完全一致。无需重烘或重启。用户模型、UV、旧结果均保留，未上传发布。
