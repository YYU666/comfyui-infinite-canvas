# 3D 全流程复审与 8GB / 12GB 模型选型

核查日期：2026-11-03。对应 PRD 修订 1.1.6；目标功能版本仍为画布 1.1.0。

状态：流程与官方资料审查，未安装候选模型、下载权重或运行新推理。文中的显存和速度数字若未特别说明，均为作者声明，不是本机测量，也不是画布的已支持规格。检索覆盖相关官方仓库、公开模型卡和部分代码，不声称穷尽所有新模型。

## 1. 决策

- 保留已验证的 MeshAnything V2 几何链作为本机研究基线；产品层定义可替换的 AI 几何执行器，不能将该权重硬编码成整个3D模块的唯一能力。
- 新低模候选优先研究 BPT 与 TreeMeshGPT；BPT 有约12GB的作者依据，但没有桌面余量，且许可证需澄清；TreeMeshGPT 有更高坐标精度/面数选项，8/12GB峰值未知。两者均不能直接宣称优于本机基线或立即随产品发布。
- MeshFlow、FastMesh、MeshRipple 值得跟进；新论文、秒级速度或更大面数不等于8GB可运行、保形更好或允许商业使用。
- 图像生成高模另外选型：低显存可先研究 Hunyuan3D-2/2mini、TripoSG；Pixal3D 与 TRELLIS.2 是较新的高保真/PBR方向，不作为8/12GB默认承诺。此分支不新增为1.1.0必须完成的功能。
- 全流程低显存方案是阶段串行、AI显存释放、CPU几何/UV/烘焙和轻量显示代理；不是让每个环节都挤进同一个GPU进程。CPU方案仍受RAM与时间预算限制。
- 授权是产品选型门：公开仓库、免费权重、代码MIT和输出可商用是不同事项。限制商业用途的执行器不得默认推荐给游戏资产生产用户；不因画布本身开源就忽略输出限制。

## 2. 流程复审：已覆盖内容与需要补齐的契约

已有规划已经覆盖源资产只读、AI新拓扑、低模新UV、原材质对烘、源法线转基、LOD分别验收、单查看器、任务恢复和当前页面单写。下面是实现前必须补齐的细节，归入原T01–T13，不额外堆菜单节点。

### 2.1 P0：统一计算空间（T01/T03/T06/T09）

固定内部制作空间：右手系、Y向上；已知物理单位时统一为米。导入无可靠单位时设置 `unitScale=null`，只转换轴向，采用原始或明确归一化的无量纲制作空间及包围盒相对距离；用户确认比例前禁用以米表达的AO/Cage参数，不能将导出标为物理尺寸已验证。源坐标轴/单位、完整父子变换、实例身份、转换矩阵及逆矩阵都保存。相同网格不同实例不能共享错误的世界空间BVH。

高模、低模、Cage、BVH与射线必须在同一冻结制作空间求交；位置用完整矩阵，法线用逆转置并归一化；负行列式正确处理绕序与切线手性，不能同时翻面两次。奇异变换/零缩放拒绝处理。AI归一化独立记录且只逆回一次。单位与变换变化使所有依赖距离的分析、Cage、AO和投射失效。

验证夹具包含离原点、非均匀缩放、镜像、嵌套实例和不同单位的同一物体；不仅检查文件“有矩阵”，还要验证表面对应、AO尺度、法线方向及导出位置相同。

### 2.2 P0：原材质支持清单与早期分流（T03/T10/T11）

在昂贵AI计算前，按通道生成 `supported / needs_conversion / unsupported / missing` 报告。用户仍可选择只做几何，但无法兑现原材质还原时不能继续显示“完整还原”目标已就绪。

首版实施目标清单（仍需代码与往返验收）：

| 输入 | 支持目标 | 不可默默省略的内容 |
|---|---|---|
| GLB/glTF核心 metallic-roughness，单材质、OPAQUE | BaseColor及factor、线性顶点色因子、Metallic/Roughness及factor、Normal及scale、Occlusion及strength、Emissive及factor、doubleSided；首版材质纹理采用TEXCOORD_0 | 使用TEXCOORD_1或其他UV集、扩展、透明/透射、多材质、程序着色时先报告；未实现的UV变换不可忽略 |
| 源纹理采样 | repeat/mirrored-repeat/clamp，明确过滤/LOD、色彩空间；ORM按通道读取 | 不把整张ORM当灰度图；BaseColor/Emissive以sRGB解码，属性纹理为线性数据 |
| OBJ/MTL | 几何、UV、角点法线；受测的Kd/map_Kd可转移底色 | Ks/Ns不自动等于Metallic/Roughness；bump不冒充切线Normal；材料缺项保持缺失，不能称完整PBR还原 |
| 缺失原材质 | 明示的中性基础材质或用户常量 | 不自动根据底色猜物理属性；不把基础材质称原材质恢复 |

含Emissive的受支持源，Emissive也是还原必需项，缺失时不能仅因五个基础通道齐全就通过。KHR_texture_transform等扩展后续可逐项加入能力表与夹具；未支持时在预检指出具体扩展。源贴图已经烘入的灯光无法保证自动移除。

doubleSided与背面渲染法线须在查看器和导出间一致，未支持时预检阻断完整还原。烘焙射线背面剔除和AO背面策略单独记录，不能由显示材质的双面开关隐式代替。

源UV的镜像/重复是合法采样场景，目标烘焙图集默认独立无重叠。若源Normal使用不同UV集，则在对应能力实现前阻断该通道，不借用BaseColor的UV。采样与透明覆盖、AO来源、源法线是否已包含几何细节均写入配方。

### 2.3 P0：质量判定必须可执行（T06/T08–T13）

`pass` 必须引用已版本化的测量方法与阈值；没有阈值或缺少必要测量就是 `needs_review / not_tested`。Agent不能现场提高阈值让失败结果过关。

初始严格规则：

- 非有限坐标、非法索引、零面积目标UV、错误面关联、未支持且必需的材质通道、错误切线约定：硬失败。
- 目标UV重叠采用三角形空间检测与光栅检查结合；只共享边不算面积重叠，不能因为亚像素冲突在小诊断图上不可见就通过。几何容差单独随尺度设置并记录。
- 正式UV内部有效覆盖样本未命中数要求为0；分母是预定义的有效覆盖样本，边缘与AA样本单独报告。扩边只能填岛外，不允许填平岛内漏烘来伪造命中率。正确命中哪一层无法确认时仍须复核。
- 每个资产先冻结轮廓/距离目标profile，记录采样数、分位数、最大采样误差与位置；没有目标观看尺度时不自动授予“游戏可用”。小于距离门槛也不能掩盖碎片、自交、重要孔洞丢失。
- 简单已知答案夹具用于验证算法：恒色/编号图案、平面与镜像法线、已知UV与相同几何对烘；无重采样边界的恒色夹具线性误差目标≤2/255，平面法线角误差≤1°。这些是开发初值与测法回归，不是任意生产资产的通用质量保证。
- 真实材质额外检查跨岛接缝、重采样模糊、斜视与mip表现；Normal滤波后重新归一化，不能把RGB颜色过滤规则直接用于法线；BaseColor在适当线性空间过滤。高反差边界可能需要提高采样，不用平均色差掩盖局部错误。

自交/开口的语义不同：开放岩壁外边界可合法，非预期裂缝不可。QA报告要标实际检测范围，未完成全量检查不写“全模型无自交”。现有12.1943%漏烘案例继续作负例。

### 2.4 P1：预处理与失效规则（T05/T06/T09）

MC256是已测案例的基线，不是所有资产的无损默认。开放岩壁、薄片、间隙接近偏移尺度时先标复核；未验证原表面采样或替代预处理前，不用MC强行封口后再称保形成功。普通闭合厚实体也要检查预处理偏差。

高低模命中对应保存为有版本的派生资产，至少依赖源/目标几何、变换、投射法线、Cage、射线参数与射线后端。低模位置、投射法线或Cage变化，使所有依赖命中的BaseColor/Roughness/Metallic/Emissive/Normal等结果失效。只改目标着色切线且不改变投射时，可只重算Normal及展示/导出报告。每档LOD从源高模采样，不从上一档低模贴图反复对烘。

### 2.5 P1：恢复与输出能力（T02/T11/T12）

按PRD的临时产物→完成清单→可领取回执→页面保存revision顺序处理；注入磁盘写满、清单提交前后崩溃、取消与成功竞态、页面领取后保存失败、执行器升级等故障。能恢复完整阶段不等于能从神经网络任意token续算。

导出前冻结三角化/角点法线/切线，GLB与OBJ能力分别报告。OBJ/MTL不能无条件表达完整PBR时，交付模型＋分通道贴图＋配方清单，提示目标软件需绑定，不称与GLB等价。明确Normal Y、ORM打包、AO用途、单位、轴向、Emissive和贴图色彩空间；重新导入并检查实际效果。首版不暗中承诺碰撞、lightmap UV2、骨骼或引擎自动LOD识别。

外部依赖文件只从批准的资产根解析；拒绝路径穿越、远程URL自动抓取、超额解压/纹理解码和任意pickle执行。公开模型的`.pt/.pth`也要按可信发布者、固定哈希和加载方式审查，不能让用户节点包注入任意模型Python。

## 3. 直接相关：已有高模生成低模的新模型

以下是几何重建/再拓扑候选，不保证保留源UV、原顶点或动画布线。面数与顶点数是不同单位。

| 模型 | 官方能力/更新 | 显存证据 | 本项目决策 |
|---|---|---|---|
| [MeshAnything V2](https://github.com/buaacyw/MeshAnythingV2) | 已有本机案例；8192个位置/法线输入；训练范围约1600面 | README约8GB，作者环境A6000；本机24GB案例不能代替真实8GB验收 | 保留基线；8GB卡没有足够桌面余量的可能性必须实测，不能标普适8GB即用 |
| [BPT](https://github.com/Tencent-Hunyuan/bpt/blob/4e6510e7ebaac6d21f558252ad7eb573aed0234a/README.md) | dense mesh输入，500M lite权重，可生成超过8k面 | 官方约12GB FP16、平均约2分钟；Linux环境 | 12GB边界研究候选；实际8GB未证实。当前仓库Community License与旧HF卡MIT标记不同，先澄清再产品化 |
| [TreeMeshGPT](https://github.com/sail-sg/TreeMeshGPT/blob/35821582ac14090f2a9cb173e4ea5fa022ca760a/README.md) | 点云条件；7bit最多5500面，9bit最多11000面；已有推理与权重链接 | 没有查到作者8/12GB峰值 | 先测7bit，再评估9bit精度/预算；代码MIT，权重独立条款与Windows仍需核对 |
| [FastMesh](https://github.com/jhkim0759/FastMesh/blob/8e971227e48db7f277f1c30359a4d823b1a7009c/README.md) | 3DV2026；mesh输入，V1K/V4K权重公开 | 官方A6000环境；无8/12GB依据 | S-Lab非商业许可，研究项；FlashAttention/Kaolin/mesh2sdf需Windows适配。第三方用户曾报告12GB失败，不能据此推导统一最低显存 |
| [Meta MeshFlow](https://github.com/facebookresearch/meshflow/blob/55f56f60e1bbf98d1c1991670ac998094d5f59ae/README.md) | CVPR2026；MeshVAE＋Flow DiT；几何/点云＋可选图片；默认4096 latent顶点预算；作者宣称约1秒 | 没有查到官方8/12GB峰值；几何单独推理不加载DINOv3 | 技术上重点观察，非默认生产后端；FAIR研究许可限制商业输出，HF权重需授权；Windows/依赖组合未验收 |
| [MeshRipple](https://github.com/MayMhappy/MeshRipple/blob/2ada1e283638c6be36d97727200995beb668c308/README.md) | CVPR2026；10k/20k版本及权重链接；连续表面生成研究 | 无8/12GB依据；NSA推理尚无KV cache | 研究观察；Linux专用安装路径，未找到根目录明确许可，不能当可自由分发依赖 |

MeshFlow的顶点数量条件是约束信号，不能承诺精确面数；VAE重建与高模点云条件生成是不同路径，不能把VAE输入预算当作任意高模解析能力。约1秒不能外推成本机端到端时间或峰值显存。

检索中另外排除：MeshCraft官方仍写代码待发布；Nautilus缺可公开完整checkpoint；SATO当前只有tokenizer、推理待发布；Meshtron本轮未确认可部署官方代码＋权重。论文出现UV、四边面或低显存关键词不等于已有可用接口。这些是当前核对状态，后续可重新发现能力。

## 4. 图像生成高模/材质：另一路候选

| 模型 | 可用能力 | 作者显存/平台证据 | 8/12GB判断 |
|---|---|---|---|
| [Hunyuan3D-2 / 2mini](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/README.md) | 单图/多视角形状；mini与Turbo公开，mini为0.6B；另有纹理模型 | 仓库总述形状6GB、形状＋纹理16GB，支持低显存模式；不能把6GB指定为所有mini配置的实测峰值 | 8GB形状生成优先候选；完整材质未因此获准8GB；Community License有地域/规模条件 |
| [TripoSG](https://github.com/VAST-AI-Research/TripoSG/blob/fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c/README.md) | 图像生成形状，另有scribble＋prompt | 官方至少8GB | 8/12GB形状候选；没有因此得到原PBR。`--faces`在源码中调用传统QEM后处理，不是AI精确低模条件。MIT代码不覆盖RMBG等独立组件 |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR/blob/107cefdc244c39106fa830359024f6a2f1c78871/README.md) | 较早的单图重建 | 默认单图约6GB；MIT代码/权重说明 | 轻量对照，不能称最新或完整PBR生产方案 |
| [Hunyuan3D-2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/82920d643c0dc2f7bfd7255f45f62d386edfe60c/README.md) | 形状＋生成PBR材质 | 官方形状10GB、纹理21GB、合计29GB | 12GB只可优先研究形状阶段；不是12GB全流程PBR方案 |
| [Hunyuan3D-Omni](https://github.com/Tencent-Hunyuan/Hunyuan3D-Omni/blob/4d47c0cc2bd0c4281963a7314ab330a5af36bfa8/README.md) | 图像＋点云/体素/骨架/包围盒控制形状 | 官方10GB | 12GB可控形状研究候选；控制信号不保证精确保形、原UV或低模拓扑 |
| [TRELLIS.2](https://github.com/microsoft/TRELLIS.2/blob/75fbf0183001ed9876c8dbb35de6b68552ee08bd/README.md) | 4B，图像→几何＋完整PBR；另有给定形状的PBR生成示例 | 官方至少24GB，仅Linux测试 | 新材质方向重要；社区offload/量化另作后端验证，不标8/12GB官方支持 |
| [Pixal3D](https://github.com/TencentARC/Pixal3D/blob/f7cf38429b0bd264f1995f0f8743a88b1c728b94/README.md) | SIGGRAPH2026；主分支基于TRELLIS.2，9月新增多视角推理，几何＋PBR | 有按需加载的low_vram模式，默认体素流水线分辨率1024而非1536；未给8/12GB保证 | 新高保真重点观察；依赖TRELLIS.2/NATTEN，低显存模式名称不构成8GB证据；多视角需相机参数 |
| [PartCrafter](https://github.com/wgsxm/PartCrafter/blob/3d773bf02fad51c7ab31a5615573fec93b287b30/README.md) | 图像条件分部件形状生成 | 官方至少8GB，可减少parts/tokens；官方Debian环境，Windows社区适配 | 分件研究参考；生成多个部件不等于把用户高模正确分件并保持接缝 |
| [Direct3D-S2](https://github.com/DreamTechAI/Direct3D-S2/blob/a1cf235b2881cff04a91900060a9546b40e7ee5d/README.md) | 稀疏体素高分辨率形状生成 | 官方512至少10GB、1024约24GB，作者不推荐512质量 | 不作为12GB质量默认选项 |

Pixal3D的1024/1536是其生成流水线分辨率，不是贴图分辨率或最终面数。论文分支与当前main不同，论文结果不能无条件当main同设置实测。新模型所谓高保真需要在我们的资产集比较后才能称“更强”。

[Hunyuan3D-Buffalo1.0](https://github.com/Tencent-Hunyuan/Hunyuan3D-Buffalo1.0/blob/941986c5f487738174364a5098c081c3c31ab8c9/README.md)在2026年8月公布生成/理解/编辑研究，但本轮官方README只有论文、展示和项目页，未确认公开可运行推理与权重，不能当本地8/12GB可安装方案。

生成PBR是为模型创造/预测材质，与忠实转移用户原高模材质不同。前者不替代本版的可验证对烘；低显存使用已有源贴图＋CPU对烘时无需加载额外材质生成模型。

## 5. 8GB / 12GB 的可执行验证计划

### 5.1 分档策略

| 档位 | 规划中的执行方式 | 可对外声明的边界 |
|---|---|---|
| 8GB | 单个AI候选、batch1、受测FP16；预览转静态或低负载；先验证MeshAnything当前路径，其他候选不自动启用。阶段完成退出AI worker，CPU修复/UV/分块烘焙，默认2K | 只有真实8GB端到端通过才标支持；作者约8GB并不预留系统/桌面显存。暂时跑不下时仍可导入/查看/CPU处理已提供低模，AI明确不可用，不偷偷传统替代 |
| 12GB | 沿用串行流程；BPT为边界实验，先纯几何短任务资源测量，再长输出和复杂输入；TreeMeshGPT先7bit研究 | 不因为作者约12GB就保证12GB卡可用；受当前可用显存及安全余量门限制，无法满足则拒绝/待适配 |
| 更大显存 | 做新模型质量与速度基线，单独测TRELLIS.2/Pixal3D等 | 大卡成功不能用于授予8/12GB支持；限制allocator也不等于换了真实小卡 |

复用PRD资源门：预测峰值＋max(1GiB,总显存15%)≤当前可用显存；该初值可根据实测修订，不能为让表格好看取消余量。按6GB/10GB作者数字换算仅能估可试性，GB/GiB、驱动占用和模型配置仍有差异。

CPU offload必须测主存峰值与PCIe开销；支持offload的后端才显示该选项。没有已实现代码和质量对照时不虚构INT8/4bit可用。FlashAttention、SDPA、编译模式和GPU计算能力分别记录，不能仅按显存容量判断兼容。高模解析、BVH、贴图解码可能先耗尽RAM，建议实验同时覆盖16GB与32GB以上RAM，但不预先把这些数值称最低规格。

量化/分页/分块解码是可研究适配，并非任意模型都能无损开启。OOM后只能在同一run剩余预算内使用已验证降级策略；保留源资产，不能自动缩小烘焙源或切换算法身份。GPU使用者仅能由用户明确授权后协调释放，不能杀其他程序。

### 5.2 比较矩阵与停止条件

1. 固定3–5类受支持资产：现有岩壁、闭合岩石、带孔硬表面、带源UV/编号贴图的道具；薄片/多部件作边界或负例。先明确输入许可和内容哈希。
2. 同时比较原始AI候选、统一受约束后处理、相近面数LOD最终结果；较多面不能直接算更优。共同报告轮廓、双向距离、自交/碎片/孔洞、烘焙命中和材质外观。
3. 同输入预处理可统一时固定；不能统一时记录模型规定的差异。独立输入seed/解码seed，基线＋最多两候选，禁止无限重试选幸运样本。
4. 记录冷加载、预处理、推理、修复、UV、2K烘焙及导出的分阶段时间；GPU峰值包括加载与解码，RAM包括整个进程树；公开缺失测量，不把论文速度当端到端性能。
5. 真8GB与12GB各做冷启动、长受支持输出、查看器共存、连续任务与取消后显存回收；重复至少3次观察残留和峰值。未完成该档位只标待验证。
6. 4K贴图独立验收：图块含边缘halo，扩边/滤波/mip避免块缝；源几何/BVH不能分块时如实限制输入。CPU内存超预算也须拒绝，不以耗尽交换文件硬跑冒充支持。
7. 质量、资源、许可、平台任一门失败，不切默认模型。结果后续必须交付当前画布并保存revision；本次只是资料与计划，不提交生成。

## 6. 证据、发布边界与后续顺序

已核对上表官方README与部分源码；固定commit链接便于复核。特别核对的许可/实现依据：

- [MeshFlow FAIR许可](https://github.com/facebookresearch/meshflow/blob/55f56f60e1bbf98d1c1991670ac998094d5f59ae/LICENSE)：明确限制Research Materials及outputs/results商业使用；[权重入口](https://huggingface.co/facebook/meshflow)为gated，不绕过授权。
- [BPT当前License](https://github.com/Tencent-Hunyuan/bpt/blob/4e6510e7ebaac6d21f558252ad7eb573aed0234a/License)与[旧HF权重卡](https://huggingface.co/whaohan/bpt)许可标记不一致。联系/明确选定版本适用条款前不将其写成无条件MIT产品依赖。
- [FastMesh许可](https://github.com/jhkim0759/FastMesh/blob/8e971227e48db7f277f1c30359a4d823b1a7009c/LICENSE)；[低显存问题#4](https://github.com/jhkim0759/FastMesh/issues/4)只是第三方用户报告。
- [TreeMeshGPT代码许可](https://github.com/sail-sg/TreeMeshGPT/blob/35821582ac14090f2a9cb173e4ea5fa022ca760a/LICENSE)不代替权重、数据和子依赖检查。
- [TripoSG面数后处理](https://github.com/VAST-AI-Research/TripoSG/blob/fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c/scripts/inference_triposg.py)：调用pymeshlab quadric edge collapse；[代码许可](https://github.com/VAST-AI-Research/TripoSG/blob/fc5c40990181e2a756c4e0b1c2f4d6b5202faf8c/LICENSE)为MIT，默认背景移除模型另有条款。
- [Hunyuan3D-2许可](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/f8db63096c8282cb27354314d896feba5ba6ff8a/LICENSE)为Community License，含地域与商业规模条件；不能按“开源”二字省略。

执行顺序：先落实第2节契约与独立CPU材质基线 → 审核候选许可/环境 → 固定资产基准 → 真实小卡测量 → 同预算几何/材质比较 → 决定是否替换默认或增加可选执行器。8/12GB的支持状态逐阶段公开，不以未知硬件指标拖延所有非AI功能，也不把部分可用说成整链可用。

本轮决策：接受流程补充与研究计划；不接受任何新模型已通过画布、Windows、8/12GB或商业发布验收的结论。不改运行服务、不发布版本、不上传权重。
