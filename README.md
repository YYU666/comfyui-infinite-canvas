# H3 视频工作台

把本地 ComfyUI 包装为无限画布：素材引用、全能参考、首尾帧、角色替换、Krea2／MOSS 生图、Qwen 2.1 图生图、局部写实修复、无抠图换装、四视图、图片／视频高清和显存清理。包含画布 WebMCP，允许 Agent 读取和操作真实节点。

## 环境要求

- Windows，ComfyUI 便携版；本机验证版本为 ComfyUI 0.42.5，H3 Relay 要求 0.37.0 或更新版本。
- NVIDIA 显卡；复杂 H3 角色替换建议 24 GB 显存，较低显存需自行缩短时长和降低分辨率。
- Git、Node.js 20+，以及足够的模型磁盘空间。
- 模型包共 33 个去重文件、164.803 GiB；权重不在 GitHub 仓库中。

## 最快安装

1. 把本仓库文件夹 `video-workbench` 放到 `ComfyUI_windows_portable` 根目录，使其旁边同时存在 `ComfyUI/` 和 `python_embeded/`。
2. 双击 `install.bat` 安装节点、Python 依赖并构建画布。
3. 打开 `models/SOURCES.md`，让 Agent 按其中的夸克原链接／官方备用链接逐项下载，并按清单重命名、放入临时模型目录。不要全量转存 TB 级分享。
4. 校验并复制已整理的模型：

   ```bat
   install.bat --models-source "D:\H3-Workbench-Models"
   ```

   也可以手动把模型目录复制到 `ComfyUI\models\`，无需重复运行安装器。
5. 双击 `start.bat`，浏览器打开 `http://127.0.0.1:8790/`。

安装器不会更新或覆盖已有的第三方节点目录，只会克隆缺失节点；工作台自己的 `h3_workbench_refine` 节点会同步到 ComfyUI。

## AI 提示词优化（可选）

普通本地生成不需要 API 密钥。只有“AI 优化提示词”需要 DeepSeek：在本目录创建 `deepseek.key`，只写入密钥；也可使用环境变量 `DEEPSEEK_API_KEY`。密钥文件已被 Git 忽略，不要提交或分享。

## 模型包

完整路径、目标文件名和字节数见 `models/manifest.json`，目录说明见 `models/README.md`。**逐文件夸克原链接、官方备用、重命名规则及 Agent 安装步骤见 `models/SOURCES.md`。** 不再依赖统一网盘总包；其中 Muse V3.0 FP8 的完全匹配公开文件仍待核实，文档已明确标注。

校验已复制的模型和节点：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py
```

直接校验解压后的模型包：

```bat
python scripts\verify_workbench.py --model-root "D:\H3-Workbench-Models" --comfy-root ".."
```

生成一个用于上传网盘的规范目录（本机维护者使用）：

```bat
python scripts\prepare_cloud_package.py --model-root "C:\ComfyUI_windows_portable\ComfyUI\models" --model-root "D:\H3-Models" --output "D:\H3-Workbench-Models" --mode copy
```

同盘可使用 `--mode hardlink` 避免重复占用空间；跨盘必须使用 `copy`。先用 `--dry-run` 检查匹配结果。

## 自动安装的第三方节点

- `akatz-ai/h3-relay`
- `kijai/ComfyUI-KJNodes`
- `lbouaraba/comfyui-krea2edit`
- `lquesada/ComfyUI-Inpaint-CropAndStitch`
- `LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`
- `Rkkss/ComfyUI-Spectrum-MOSS`

MiniMax H3、Qwen 2.1、SAM3、SeedVR2 和循环节点由新版 ComfyUI 本体提供。某些加速注意力还依赖本机显卡与 ComfyUI 的 optional attention runtime；不能用时应切换普通注意力，而不是强行安装不兼容的 GPU 包。

## 数据与隐私

- 服务只监听 `127.0.0.1`。
- 默认参考素材和生成结果位于 `D:\H3_Workbench`；可通过 `H3_WORKBENCH_DATA_DIR` 修改。
- 画布项目保存在浏览器本机存储中。清理浏览器数据前请先备份。
- 仓库不包含人物母图、测试生成素材、浏览器 Cookie、API 密钥或模型权重。

## 常用开发检查

```bat
npm ci
npm run build
node test-canvas-layout.mjs
python -m py_compile video_workbench_launcher.py install.py scripts\install_models.py scripts\prepare_cloud_package.py scripts\verify_workbench.py
```
