# 模型包目录

`manifest.json` 是工作台当前实际引用的模型清单：33 个去重文件，合计 164.803 GiB。GitHub 仓库不包含模型权重。

从夸克原链接或官方备用链接下载后，应整理为以下结构，再将这些目录复制到 `ComfyUI/models/`。**逐文件来源、分享内搜索名、重命名规则和 Agent 安装步骤见 `SOURCES.md`。**

```text
checkpoints/
diffusion_models/
  Moss_image/
latent_upscale_models/
loras/
  Krea2-N/
  Krea2-功能/
  Krea2-风格/
text_encoders/
vae/
```

注意：

- `Qwen2.1_Anything2RealCharacters.safetensors` 是目标文件名；若下载源使用 `Qwen21-任转真Anything2RealCharacters.safetensors`，请按清单重命名。
- 不要重复保存 C、D 两个模型根目录中的相同文件。
- 可以用 `python scripts/verify_workbench.py --model-root "模型包路径"` 校验文件名和字节数。
- 本清单只保证工作台代码所需文件完整，不表示其他 ComfyUI 工作流也已满足全部依赖。
