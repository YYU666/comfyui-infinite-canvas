# 模型包目录

`manifest.json` 是工作台当前实际引用的模型清单。GitHub 仓库不包含模型权重。

- `core-h3`：7 个 H3 文生视频／参考图视频核心权重，合计 71.164 GiB；七个文件均可从 Comfy-Org 官方仓库取得并已登记 SHA256。
- `full`：33 个去重文件，合计 164.803 GiB，增加可选生图、高清和风格 LoRA；Muse V3.0 FP8 的完全匹配来源仍未解决，不属于完整可下载保证。

从官方或夸克原链接下载后，应整理为以下结构，再将这些目录复制到 `ComfyUI/models/`。**逐文件来源、分享内搜索名、重命名规则和 Agent 安装步骤见 `SOURCES.md`。**

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

核心 H3 的官方仓库为 `https://huggingface.co/Comfy-Org/MiniMax-H3`。在仓库 `Files and versions` 中按 `manifest.json` 的七个 `core-h3` 路径下载，保持目录与文件名不变，不需要网盘或重命名。其直接下载地址规则为 `https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/` 加上目标相对路径。

注意：

- `Qwen2.1_Anything2RealCharacters.safetensors` 是目标文件名；若下载源使用 `Qwen21-任转真Anything2RealCharacters.safetensors`，请按清单重命名。
- 不要重复保存 C、D 两个模型根目录中的相同文件。
- 用 `python scripts/verify_workbench.py --model-root "模型包路径" --profile core-h3` 校验核心配置；省略 `--profile` 时默认校验完整 33 项。
- 清单中有 `sha256` 的文件会执行内容哈希校验；其余文件只检查文件名和字节数，并在结果中明确列为“待核实”。相同字节数不等于内容相同。
- 本清单只保证工作台代码所需文件完整，不表示其他 ComfyUI 工作流也已满足全部依赖。
