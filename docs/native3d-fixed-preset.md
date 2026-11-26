# AI低模默认配方

新建 AI低模节点使用“标准减面 v1”（meshanything-v2-demo-v1）。节点保存明确的 conditioningProfile=legacy_world_fp16、inputSeed=0、seed=0、sampling=false，避免以后默认值改变已保存节点的配方。后台省略参数的请求也使用这四项默认值。

来源任务：n3d_c5585a492d454bf0a87ed641f64e7b9d；检查点 SHA256：c7cb232f2dcede0e03921f373e659a1415bb2fb852faf1ad271803450d878ad0。Python 定义在 native3d_presets.py；前端副本由 test_native3d_fixed_preset.py 核对完整版本、来源与参数一致性。配方记录来源，不替换或绕过配置的权重哈希校验。

已有节点的显式参数保持原值；旧前端节点缺少 conditioningProfile/inputSeed 时继续按 canonical_safe/42 提交。后台直接省略参数与旧画布兼容行为不同，此区别是有意保留。高级参数仍允许自定义；界面只有四项值完全匹配才显示固定配方名称。重新部署后新建节点才获得默认配方，不批量迁移旧节点。

legacy FP16 精度、范围与几何验收检查保留，失败不会切换配方或放宽门槛。不同输入模型不能保证同样拓扑；本配方不含任何针对旧岩石的局部修补。mesh2sdf 桥没有配方默认值，仍只执行已校验的 MC256 输入。

激活需要前端构建及后端安全重载；应等待当前生成完成后操作。当前页面需正常刷新后再新建节点。
