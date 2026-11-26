# 游戏LOD与UE Nanite制作依据

文档修订：1.1.22；目标功能版本仍为画布1.1.0。核查日期2026-11-05。网页取回时Epic页面标为Unreal Engine5.8，项目应按实际UE版本验证；本文没有执行UE性能测试。

本轮产品选择：按用户最新要求，Nanite与传统LOD0复用同一最终模型、UV和材质。这是当前工作流的选择，不是Epic规定的通用最佳面数；UE导入、Nanite构建及场景性能仍须独立验收。

## 结论

百分比比固定三角面数更适合跨资产复用，但只定义保留数量，不自动保证保形。传统LOD应同时控制保留比、形状误差、轮廓/UV/法线、运行时屏幕大小及目标平台性能。没有全行业统一的五级面数表、每级固定50%或固定切换米数。

Nanite静态网格的几何细节由内部簇层级自动选择；没有官方统一的最佳三角面数或最低面数，不应默认先压到10万再使用Nanite。传统LOD资产与Nanite资产应作为两个导出目标，分别验收。

## 1. 查到的官方依据

- [Epic自动LOD](https://dev.epicgames.com/documentation/en-us/unreal-engine/static-mesh-automatic-lod-generation-in-unreal-engine)：使用二次误差简化，推荐项目级LOD Groups；配置示例多为LODPercentTriangles=50，并同时设置PixelError和SilhouetteImportance。手动教程另用75/25/12，说明这些是示例而非统一行业标准。
- [Epic创建和使用LOD](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-and-using-lods-in-unreal-engine)：切换取决于Screen Size，不是固定距离；实例大小不同，同距离可处于不同LOD。
- [Epic减面参数API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/FMeshReductionSettings)：PercentTriangles是保留百分比，另有BaseLODModel、MaxDeviation、SilhouetteImportance、TextureImportance等。不能只记录百分比而遗漏基准LOD。
- [Unity6 LOD Group](https://docs.unity3d.com/6000.0/Documentation/Manual/class-LODGroup.html)：同样使用屏幕空间相对高度阈值，支持cross-fade；不能把Unity与UE的屏幕尺寸数值公式视为完全相同。
- [Nanite概览](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-virtualized-geometry-in-unreal-engine)：自动几何LOD、多UV、可导入扫描/影视级资产，但实例数、每网格三角数、材质、分辨率和硬件仍须量测。
- [Nanite技术细节](https://dev.epicgames.com/documentation/en-us/unreal-engine/nanite-technical-details)：Keep Triangle Percent、Trim Relative Error、Explicit Tangents、Lerp UVs、精度和Fallback参数的具体定义。概览页仍有旧的“不保存切线/未来支持”文字，本文以该具体设置页为准，不沿用旧概览断言。
- [Nanite内容制作](https://dev.epicgames.com/documentation/en-us/unreal-engine/working-with-naniteenabled-content)：关注过度绘制、密集叠层及碎片几何、意外全面硬法线；顶点/三角形比例达到2:1以上需要检查，3:1说明每三角独立顶点。不是禁止必要硬边。
- [UV通道](https://dev.epicgames.com/documentation/en-us/unreal-engine/using-uv-channels-with-static-meshes-in-unreal-engine)及[Lightmap UV](https://dev.epicgames.com/documentation/en-us/unreal-engine/understanding-lightmapping-in-unreal-engine)：材质UV和光照UV要求不同；平铺材质允许重复，光照贴图需要独占区域和足够间距。

## 2. 传统LOD流程与百分比语义

推荐流程：明确目标平台/镜头最近距离/物体尺寸 → 确立合格LOD0 → 减面并保护轮廓、部件、UV/法线/材质边界 → 检查各档及过渡 → 按屏幕占比设切换 → 真机场景验证GPU/CPU/阴影/内存 → 导出。

UI使用“保留百分比”，避免“减50%”与“保留50%”混淆。支持两种明确基准：

- 相对LOD0：100/50/25/12.5/6.25是可选温和起点，绝非官方强制值。
- 相对前一级：后续每级保留50%可得到上面累计比例。采用实际前档面数计算，显示实际累计比，不能一直用预计面数假算。

原高模→LOD0另外设置保留比，与LOD0→其余LOD的比例分开。源可能有无效扫描噪声或冗余三角形，因此原高模面数不是目标质量本身。

本例上一轮的LOD0≤100000、LOD1≤10000仍记录为预算约束，可由用户显式修改；新资产可选启用，不把本例上限固定给所有资产。最新要求以比例为主。若LOD0为100000而LOD1上限10000，则LOD1实际最多保留10%，不可能同时满足“每级50%”。UI应显示“比例目标50000，预算上限10000，实际目标10000/有效保留10%”，并提示需要复核跃变；不能静默覆盖比例。用户可调整比例、预算或增加档位。

旧100000/10000/3000/1000/300不再是通用默认表；相对LOD0即100/10/3/1/0.3，仅代表先前这个案例的激进预算。LOD4也不固定300面，取决于屏幕误差与用途。

算法仍可逐级继承真实结果，记录父子hash。内部拆多步不是质量保证，累计误差要对原LOD0/原高模核验。面数目标与误差限制冲突时保留更多面或报告未达预算，不强减到洞穿/轮廓失真。

传统LOD建议尽量共用材质、UV对应和贴图，降低资产及内存开销；不同档位若重新独立展开UV，就必须正确转移或另烘，不能直接套同一张图。是否每档独立4K应成为显式选择，不是默认制作标准。

## 3. Nanite最佳面数：没有一个统一数字

Nanite不是“面数无限所以无需优化”，也不是“超过10万必卡”。是否值得保留某部分三角形，取决于它对最近镜头的形状、轮廓、阴影或细节是否有贡献，以及材质、场景可见实例、叠层、流送和磁盘预算。

官方默认保留全部源三角形；Keep Triangle Percent和Trim Relative Error用于导入数据裁剪，主要面向存储/下载体积，不能等同运行时固定绘制面数或承诺同倍帧率提升。Nanite运行时自动选择细节是另一层机制。

对这块约100万面的实心岩石，建议将原高模作为Nanite基准，另比较保留100/50/25/10%的候选；这些只是本项目评测档位，不是Epic推荐最佳数值，也没有实测哪个最好。按最近实际镜头、轮廓、法线、阴影和目标场景性能选择满足预算的最小候选。不要为了遵守传统LOD0上限先破坏Nanite源细节。

源导入模型、Nanite内部细节、Fallback Mesh三者分别记录。Fallback服务不支持Nanite或需要传统网格的功能，不能直接把300面LOD4指定为所有场景碰撞/光追回退。碰撞还应有独立简化/凸包策略。

岩石初始设置建议（不是通用最优）：Enable Nanite开启；Keep Triangle Percent先100、Trim Relative Error先0作为对照；Position Precision先Auto；普通纹理UV开启Lerp UVs；Preserve Area不为实心岩石启用（官方该项针对植被）；Explicit Tangents按实际烘焙法线对照决定。不能挪用静态位移教程的Trim0.04作为所有扫描模型的通用值。

## 4. Nanite的UV与法线

Nanite没有额外的“必须方正/必须四边面/固定岛数”要求；核心网格仍为三角形。UV优先满足材质用途、密度、拉伸、接缝和纹理mip过滤，岛越少并不总越好，过度合并也会拉伸。合理的硬边/UV边界保留，避免无意义的全硬边和大量小碎岛导致顶点拆分与数据开销。

| 用途 | 要求及建议 |
|---|---|
| 普通材质UV | 常规连续插值；Lerp UVs尽量开，让简化同时考虑UV误差。存索引等不可插值数据的UV才另行处理并关闭该项 |
| 唯一烘焙图集 | 同一图集页内不冲突，合理间距/边缘扩展，考虑最低mip；保持法线切线约定与源材质通道正确 |
| 平铺/叠UV/Trim材质 | 可有意重复或超出0–1，不把这种合法材质安排误判为UV错误；不适合直接当唯一AO/颜色烘焙图集 |
| Lightmap UV | 仅需预计算光照时生成；独占、不重叠、足够间距；与材质UV分开 |
| 动态光照/Lumen为主 | 若项目没有预计算光照需求，不必为每个高密Nanite网格强制生成Lightmap UV，减少导入时间和额外UV数据 |

“只有动态光照不需要Lightmap”不等于“不需要材质UV”。Lightmap文档的通常至少4texel间距是该光照压缩语境，不能直接当所有4K法线/颜色图的万能间距。

原高模已有合格UV和完整纹理时，Nanite路线优先保留并检查，不必先重拓扑/重新展开/全套转烘。确实改变拓扑或UV后才进入必要的传递/对烘，不能假定UV不变或纹理自动正确。

法线贴图仍可表达细微表面和材质变化，Nanite不禁止使用；它只是可用真实几何承载更多细节。Explicit Tangents存储显式切线，技术文档给出的存储增量约10%，可针对隐式切线不够精确时测试。导入法线、UV、Mikk切线、OpenGL/DirectX约定应一致；这个开关不能修复错误高低模投射或未命中的烘焙像素。

## 5. 画布计划变更

输出目标增加“传统LOD / Nanite准备 / 两者”。传统路线以百分比、基准、误差、屏幕尺寸预览及可选上限控制。Nanite准备保留高质量源与材质UV，显示目标UE版本、建议构建/精度/切线/Fallback设置及验证清单，不伪装在画布内已完成UE专有Nanite构建。

PartField与AO辅助切缝仍适用于需要新UV的路线；已有可用UV可选择保留，不强制运行神经分区。节点应显示真实来源、实际面数、保留比、阶段用时和已完成的质量检查，保留“计划值/实测值”区别。

需在UE内验证的项目：最近/远景观感、LOD过渡、Nanite Triangles/Clusters/Overdraw、目标分辨率GPU耗时、材质及阴影开销、数据体积/流送、Fallback与碰撞。未进入UE测试前，不给“最佳面数”或性能通过结论。
