# AGENTS.md — H3 视频工作台安装执行说明

## 当前实现约定（2026-10-29）

- Owner：Kimi；分支：`web`；当前阶段：M0–M4 已完成，发布 `v1.0.0`。
- 唯一产品依据：本地网页端 PRD v2.0；桌面端 PRD 已废弃，不进入 M5。
- 形态：Python 后端 + 浏览器 UI；`启动.vbs` 无控制台，`启动.bat` 仅调试，`停止.bat` 优雅停止。
- 项目根：`%USERPROFILE%\Documents\H3 Workbench`；生成结果默认引用 ComfyUI 输出，导出复制到项目 `outputs/`。
- 角色、服装库 v1.0 为项目内；不制作 exe、安装包、桌面壳、托盘或自动更新。
- 不提交密钥、日志、模型或个人素材；不移动 D 盘用户数据；ComfyUI 有任务时不得停止或重启。

本文件是给安装 Agent 的操作规程。目标是在 **Windows + ComfyUI 便携版**上安装本仓库、第三方节点和 33 个模型／LoRA，并完成离线及在线校验。不要只阅读本文件后声称安装完成，必须实际执行并核对命令结果。

## 1. 必读文件与优先级

按顺序阅读：

1. `AGENTS.md`：安装顺序、安全边界和验收流程。
2. `README.md`：面向用户的下载链接与两种模型配置方式。
3. `models/SOURCES.md`：33 个文件的夸克原链接、官方备用、分享内搜索名及重命名规则。
4. `models/manifest.json`：目标相对路径与字节数的机器可读权威清单。
5. `models/README.md`：最终模型目录结构。

若文件名或目标目录不一致，以 `models/manifest.json` 为准；若下载来源说明不一致，以 `models/SOURCES.md` 为准。不要凭记忆更换模型版本或下载地址。

## 2. 安全边界

- 不提交、不上传模型权重、人物素材、生成结果、Cookie、账号密码或 API 密钥。
- 不读取浏览器 Cookie 来绕过网盘登录；需要登录时让用户在浏览器中自行登录。
- 不整包转存或下载 TB 级夸克分享，只下载清单点名的文件。
- 不用旧版、不同量化版、r64／r128、7B／3B 或相似名称文件冒充目标权重。
- 不删除或覆盖用户已有模型和第三方节点。已有节点由安装器保留；已有模型只有在目标路径及字节数都正确时才跳过。
- 不修改系统 Python；优先使用 ComfyUI 便携版 `python_embeded\python.exe`。
- 不执行需要管理员权限的命令，不关闭无关程序，不清理无关磁盘内容。
- 模型许可证彼此独立。公开再分发或商用前，需分别核对作者条款。

## 3. 路径约定

后续命令默认从 **ComfyUI 便携版根目录**执行，例如：

```text
C:\ComfyUI_windows_portable\
├─ ComfyUI\
│  ├─ main.py
│  ├─ models\
│  └─ custom_nodes\
├─ python_embeded\
│  └─ python.exe
└─ video-workbench\
   ├─ AGENTS.md
   ├─ install.py
   ├─ models\
   └─ scripts\
```

约定：

- `PORTABLE_ROOT`：上述便携版根目录。
- `WORKBENCH`：`PORTABLE_ROOT\video-workbench`。
- `MODEL_STAGE`：下载并整理后的临时模型目录，由用户选择空间充足且可写的磁盘，不要求存在 D 盘；示例为 `D:\H3-Workbench-Models`。
- `MODEL_STAGE` 下直接是 `diffusion_models/`、`loras/`、`text_encoders/`、`vae/` 等，不要再多套一层 `models/` 或分享文件夹。

若仓库不在便携版根目录，先移动或重新克隆到正确位置；不要通过猜路径继续安装。

## 4. 安装前检查

1. 确认 `ComfyUI\main.py` 与 `python_embeded\python.exe` 存在。
2. 确认 Git 可用，Node.js 为 20.19 或更新版本，npm 可用。
3. 检查模型目标盘剩余空间。完整清单为 **33 个去重文件、164.803 GiB**；下载和复制同时存在时需要更多空间。
4. 检查 `ComfyUI\custom_nodes\` 中已有节点，记录但不要在安装前更新它们。
5. 检查 ComfyUI 版本。当前唯一完成在线节点验证的版本为 0.42.5；更低版本不在支持矩阵中，不能只凭 H3 Relay 的最低版本推断整个工作台兼容。
6. 检查 NVIDIA 显卡和显存。复杂 H3 角色替换建议 24 GB；低显存环境只能降低分辨率和时长，不能因此替换清单模型。

任何前置条件不满足时，先报告缺失项，不要跳过检查后宣称可用。

## 5. 安装工作台、节点与前端

在 `PORTABLE_ROOT` 执行：

```bat
python_embeded\python.exe video-workbench\install.py --comfy-root "."
```

该命令会：

- 使用 `requirements.lock` 中的 SHA256 校验安装 Python 依赖；便携版 Python 缺失时直接报错，不回退系统 Python；
- 同步工作台专用 `h3_workbench_refine` 节点；
- 按 `install.py` 中的仓库＋commit 安装缺失的第三方节点；已有节点提交不一致时保留原目录并停止，不自动更新或覆盖；
- 安装第三方节点各自声明的 Python 依赖；
- 执行 `npm ci` 和 `npm run build`，生成 `dist/`。

应安装的第三方节点：

- `akatz-ai/h3-relay`
- `kijai/ComfyUI-KJNodes`
- `lbouaraba/comfyui-krea2edit`
- `lquesada/ComfyUI-Inpaint-CropAndStitch`
- `LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`
- `Rkkss/ComfyUI-Spectrum-MOSS`

若某个节点克隆或其依赖安装失败，记录完整错误并解决后再继续；不要把“目录存在”当作节点可正常注册。

## 6. 下载与整理模型

### 6.1 下载原则

1. 打开 `README.md` 或 `models/SOURCES.md` 中的夸克原链接。
2. 使用分享内搜索，按 `models/SOURCES.md` 的 33 行映射逐项查找。
3. 下载到 `MODEL_STAGE` 的临时下载区；不要改变清单之外已有文件。
4. 按 `models/manifest.json` 的 `path` 字段创建目标目录并移动／重命名。
5. 按 `bytes` 字段检查每个文件大小，再进入配置阶段。

### 6.2 必须注意的重命名

- `Qwen21-任转真Anything2RealCharacters.safetensors`
  → `loras/Qwen2.1_Anything2RealCharacters.safetensors`
- 官方 `QuadView_krea2_v1.safetensors`
  → `loras/Krea2-四视图QuadView_krea2_v1.safetensors`
- 官方 H3 latent upscaler 位于版本子目录；目标为
  → `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors`

### 6.3 官方备用下载

对 `models/SOURCES.md` 中以 `O-` 开头的直接下载地址，可用浏览器或支持断点续传的下载工具。下载后仍必须按清单重命名和校验字节数；`.safetensors` 不是压缩包，不要解压。

### 6.4 已知例外

`diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors` 尚未找到与本机文件名称及字节数完全匹配的公开下载项。作者页为：

```text
https://civitai.com/models/2741166
```

不得把 V1.5、V2、V3.5、V4 或 INT8 文件改名后冒充它。若用户没有该权重，明确报告这一项尚未解决；其余文件可以继续安装，但不得宣称完整验收通过。

`Q-H3-EXTRA` 和 `Q-QUAD` 内部分文件尚需在分享内搜索确认。搜不到时记录具体文件名，不要使用相似文件替代。

## 7. 配置模型目录

以下方式只选一种。

### 方式 A：复制或硬链接到 `ComfyUI\models`（推荐）

在 `PORTABLE_ROOT` 执行：

```bat
python_embeded\python.exe video-workbench\scripts\install_models.py "D:\H3-Workbench-Models" --comfy-root "."
```

- 默认复制，适用于跨盘。
- 若 `MODEL_STAGE` 与 `ComfyUI\models` 在同盘，可加 `--link` 使用硬链接。
- 想先检查而不写入时，加 `--dry-run`；但 dry-run 不能作为安装完成依据。

### 方式 B：配置外置模型目录

1. 将 `video-workbench\extra_model_paths.example.yaml` 复制为 `ComfyUI\extra_model_paths.yaml`。
2. 只把 `base_path` 改为实际 `MODEL_STAGE`，路径使用 `/`，例如 `D:/H3-Workbench-Models`。
3. 保留 `checkpoints`、`diffusion_models`、`text_encoders`、`vae`、`loras`、`latent_upscale_models` 的相对目录值。
4. 如果已有 `extra_model_paths.yaml`，先读取并合并，不能覆盖其他模型配置。

方式 B 的后续校验必须额外传入 `--model-root "D:\H3-Workbench-Models"`。

## 8. 离线验收

在 `PORTABLE_ROOT` 执行方式 A 的校验：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "."
```

方式 B 使用：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "." --model-root "D:\H3-Workbench-Models"
```

只有输出“校验通过：模型、节点目录和前端构建均已就绪”才算离线验收通过。若报告缺失或大小不符，逐项修正后重跑；不要忽略错误继续生成。

## 9. 启动与在线验收

确认没有正在运行或排队的 ComfyUI 任务后，启动 `video-workbench\启动.vbs`；不要为启动工作台而关闭其他客户端正在使用的 ComfyUI。等待 ComfyUI 和画布服务就绪：

- ComfyUI：`http://127.0.0.1:8188/`
- 视频工作台：`http://127.0.0.1:8790/`

ComfyUI 启动后，在离线校验命令末尾加 `--online` 再执行一次，例如：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "." --online
```

该步骤读取实际 `/object_info`，确认工作台调用的节点已注册。在线校验也必须通过，才能报告安装完成。

## 10. 完成报告格式

最终用简洁清单报告：

1. 前端是否构建成功。
2. 六个第三方节点及工作台专用节点是否安装并在线注册。
3. 模型校验通过数量，例如 `33/33`，以及总大小。
4. 使用的是复制、硬链接还是外置模型目录。
5. ComfyUI 与画布的本地访问地址。
6. 仍失败的文件或节点、准确错误和下一步；没有失败项才写“安装完成”。

不要上传模型或生成素材到 GitHub，不要在报告中暴露账号、Cookie、令牌或人物素材路径。

## 11. 画布日常操作与测试

在当前画布复用节点、创建测试、连接、生成、整理或查找保存路径时，必须读取并遵循 `.agents/skills/comfyui-infinite-canvas/SKILL.md`。安装验收与画布操作分别按对应规程执行；所有测试生成都要在当前画布留下可核验的真实结果节点。
