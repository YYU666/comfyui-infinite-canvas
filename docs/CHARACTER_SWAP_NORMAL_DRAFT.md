# 法线引导角色替换：禁用草稿

此分支只提取现有 `character-swap-map.js` 的接口与工作流图。标准角色替换不变。没有新增菜单或 MCP 参数入口；即使程序调用传入 `characterSwapMethod: preprocessorMap`，主 API 也明确拒绝生成，不会静默回落到标准算法。

原接口为 `characterSwapMethod`（standard / preprocessorMap）、`characterSwapStage`（guide / generate）和 `mapGuideApproved`（布尔）。guide 阶段使用 SAM3.1 跟踪、MoGe DirectX 法线与单人混合图，保存可审查的红色法线引导；generate 阶段要求明确确认完整引导、单张身份参考，再构建 Fro099 normal map conditioning 图。图本身按现有运行时保留，未替换节点或伪造实现。

当前阻塞项：

- 已授权源码快照缺少 `H3MapPrepareFrames`、`H3MapSinglePersonGuide`、`H3MapValidateGuide` 实现，无法核验节点注册、帧准备、引导区域和确认边界。
- 需要 MoGe 节点（LoadMoGeModel / MoGeInference / MoGeRender）和 BFSH3KeyframeConditioning；本次没有安装或在线验证。
- 图指定 `moge_3_vitl_fp16.safetensors`、`minimax_h3_DMAD_8step_full_lora_avg_rank_58_bf16.safetensors`、`minimax_h3_character_swap_v1.0_preprocessor_map_fro099.safetensors`，模型字节数与 SHA256 尚未核实，不下载或用近似权重代替。
- 源图注明 Alissonerdx / Fro099 归属；对应工作流、节点与模型许可尚未核实，不能推定商用或再分发授权。
- 无真实 ComfyUI、GPU、用户素材或画布生成验收。Node 测试仅检查静态图结构、参数拒绝、确认要求与入口禁用。

后续启用须先取得可审查的缺失节点源码与来源/授权证据，再验证依赖注册、尺寸/帧序/音频、完整引导确认、可见画布结果与原有标准角色替换回归。当前只适合作为独立 draft 代码审查候选。
