# AGENTS.md — Refmuse 本地工作台安装执行说明

## 当前实现约定（2026-10-29）

- Owner：Kimi；分支：`web`；当前阶段：M0–M4 与开源整改已完成，候选发布 `v1.0.1-rc.1`；完整 8 小时长跑尚未完成。
- 唯一产品依据：本地网页端 PRD v2.0；桌面端 PRD 已废弃，不进入 M5。
- 形态：Python 后端 + 浏览器 UI；`启动.vbs` 无控制台，`启动.bat` 仅调试，`停止.bat` 优雅停止。
- 项目根：`%USERPROFILE%\Documents\H3 Workbench`；生成结果默认引用 ComfyUI 输出，导出复制到项目 `outputs/`。
- 角色、服装库 v1.0 为项目内；不制作 exe、安装包、桌面壳或托盘。程序更新采用启动检查、用户确认、校验备份和失败恢复，不静默强制升级。
- 不提交密钥、日志、模型或个人素材；不移动 D 盘用户数据；ComfyUI 有任务时不得停止或重启。

本文件是给安装 Agent 的操作规程。目标是在 **Windows + ComfyUI 便携版**上安装本仓库、第三方节点和用户所选模型配置，默认 `core-h3` 七项；只有用户明确需要完整模型库时才选 `full` 的 33 项。必须实际执行并核对结果，不能只阅读后声称安装完成。

普通安装属于执行现有脚本的有限任务：先按下面的最短路径操作，不默认扫描源码、创建开发计划、开子 Agent 或运行开发回归套件。代码开发与故障修复再按实际范围展开。

### 最短执行路径

1. 确认便携版路径与所选 profile，检查第 2–4 节的安全边界和环境要求。
2. 第一次只运行第 5 节安装命令，**不要**附带 `--models-source`。安装成功后立刻阅读 `docs/AGENT_MANUAL.md`，并用 `docs/MODEL_CATALOG.md` 或 `scripts/model_catalog.py list` 向用户说明各功能所需模型及体积。用户只要求「安装画布」不等于同意下载模型。手册要求不自评强弱、一律从标准配方开始；偏离须先写明原因且仍通过同一份核验，连续两次核验失败则回到标准配方。
3. 只有用户明确点名某个套装（例如 `core-h3` 或 `h3-image`）后，才补装模型：把已整理的目录交给 `install.py --comfy-root "<PORTABLE_ROOT>" --models-only --models-source "<MODEL_STAGE>" --profile core-h3`，或使用第 7 节脚本。不要重复运行完整安装，也不要在未经确认时从网络拉取权重。
4. 默认只看步骤摘要。详细子进程输出保存在 `.cache/install-logs/` 的本次目录；失败后先读失败步骤及日志末尾，必要时再扩大。`--verbose` 仅用于诊断。长命令等待同一进程，禁止重复提交安装或频繁拉取整份日志。
5. 安装器不自动下载模型，不代替最终验收。服务就绪时一次执行第 9 节 `--online` 校验，它同时包含离线检查；暂不能启动服务时先做第 8 节并明确“在线未验收”，之后再补在线。不要额外提交真实生成作安装验收。

## 1. 必读文件与优先级

按当前步骤读取需要的条目，不把以下文件作为整套必读上下文：

1. `AGENTS.md`：安装顺序、安全边界和验收流程。
2. `README.md`：仅在需要安装方式、启动或使用说明时读对应章节。
3. `models/SOURCES.md`：额外模型下载、重命名或来源失败时读对应条目；核心七项来自第 6.1 节官方仓库。
4. `models/manifest.json`：由安装/校验脚本读取；需要确认文件时只筛选所选 profile，不把完整 JSON 输出给 Agent。
5. `models/README.md`：需要目录布局或外部模型配置时读取。
6. `models/LICENSES.md` 与 `models/licenses.json`：遇到商用、再分发或授权问题时读对应模型及作者条款。未知许可仍不得推定；按需读取不改变授权边界。

若文件名或目标目录不一致，以 `models/manifest.json` 为准；若下载来源说明不一致，以 `models/SOURCES.md` 为准；授权状态以作者官方许可文本为准，矩阵未知项不得推定许可。不要凭记忆更换模型版本或下载地址。

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
3. 检查模型目标盘剩余空间。默认核心七项 **71.164 GiB**；仅显式完整配置为 **33 个去重文件、164.803 GiB**。下载和复制同时存在时需要更多空间。
4. 检查 `ComfyUI\custom_nodes\` 中已有节点，记录但不要在安装前更新它们。
5. 检查 ComfyUI 版本。原工作流在线节点验证基于 0.42.5；H3-Image 新图片模型要求含 `MiniMaxH3ImageConditioning` 的新版，已核验 0.45.0。0.45.0 的原有节点注册兼容检查通过，不等同于全部模型真实推理验收。H3-Image 安装按 `models/H3_IMAGE.md` 的独立三文件配置，不使用旧 `core-h3`／`full` profile，也不要仅升级画布而保留旧 ComfyUI 后台。
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

1. 经用户确认需要视频生成后，再安装 `core-h3` 七项（71.163 GiB；仓库部分文档曾写作 71.164 GiB）。完整 33 项不是默认选项。核心七项全部从 `https://huggingface.co/Comfy-Org/MiniMax-H3` 按 `profiles.core-h3.files` 的相对路径下载，无需夸克或重命名。说明体积与功能时以 `docs/MODEL_CATALOG.md` 为准。
2. 只有用户明确需要完整模型库时，才按 `models/SOURCES.md` 的 33 行映射继续下载其余文件。realism engine 仍指向一条夸克分享，Muse V3.0 FP8 仍没有匹配文件；其余已核实文件使用官方地址。不要整仓或整包转存。
3. 下载到 `MODEL_STAGE` 的临时下载区；不要改变清单之外已有文件。
4. 按 `models/manifest.json` 的 `path` 字段创建目标目录并移动／重命名。
5. 校验时，有 `sha256` 的文件必须验证内容哈希；其余文件只能按 `bytes` 检查并报告“待核实”。

### 6.2 必须注意的重命名

- 官方 `QuadView_krea2_v1.safetensors`
  → `loras/Krea2-四视图QuadView_krea2_v1.safetensors`
- 官方 `retroanime.safetensors`、`softwatercolor.safetensors`、`Krea2_FantasyRealism.safetensors`、`hina_krea2_asianMix_v1-bf16.safetensors`
  → `models/SOURCES.md` 第 14、15、13、11 行的目标名
- 官方 H3 latent upscaler 位于版本子目录；目标为
  → `latent_upscale_models/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors`
- MOSS 主模型官方路径没有 `Moss_image/` 子目录，下载后按清单放入该子目录，文件名不变。

### 6.3 官方备用下载

对 `models/SOURCES.md` 中的官方下载地址，可用浏览器或支持断点续传的下载工具。O-ASIAN 与 Muse V4 的 Civitai 下载需要用户自己登录。下载后仍必须按清单重命名和校验字节数；`.safetensors` 不是压缩包，不要解压。

### 6.4 已知例外

`diffusion_models/Krea2-MuseByStable_v30Turbo_fp8.safetensors` 尚未找到与本机文件名称及字节数完全匹配的公开下载项。作者页为：

```text
https://civitai.com/models/2741166
```

不得把 V1.5、V2、V3.5、V4 或 INT8 文件改名后冒充它。2026-11-12 复核时，作者页的 v3.0 Turbo fp8-scaled 为 14,128,290,360 字节，不是清单的 13,784,899,896 字节。若用户没有该权重，明确报告这一项尚未解决；其余已核实文件可以继续安装，但不得宣称完整验收通过。

`loras/Krea2-N/Krea2-realism_engine_v2.safetensors` 仍使用 `models/SOURCES.md` 的夸克入口。`RudySen/Krea2-realism-V2` 的 HEAD 大小是 1,562,410,344 字节，比清单多 48 字节，不能替换。搜不到清单文件时记录文件名，不要使用相似文件替代。

## 7. 配置模型目录

以下方式只选一种。

### 方式 A：复制或硬链接到 `ComfyUI\models`（推荐）

核心安装在 `PORTABLE_ROOT` 执行：

```bat
python_embeded\python.exe video-workbench\scripts\install_models.py "D:\H3-Workbench-Models" --comfy-root "." --profile core-h3
```

只有明确安装完整 33 项时才改用 `--profile full`。

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

在 `PORTABLE_ROOT` 执行核心配置校验：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "." --profile core-h3
```

方式 B 使用：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "." --model-root "D:\H3-Workbench-Models" --profile core-h3
```

只有输出“校验通过：所选模型、节点目录和前端构建均已就绪”才算离线验收通过。报告必须同时写明 profile、SHA256 已核实数和待核实数；若报告缺失、大小或哈希不符，逐项修正后重跑。核心验收不代表完整 33 项已通过。

## 9. 启动与在线验收

确认没有正在运行或排队的 ComfyUI 任务后，启动 `video-workbench\启动.vbs`；不要为启动工作台而关闭其他客户端正在使用的 ComfyUI。等待 ComfyUI 和画布服务就绪：

- ComfyUI：`http://127.0.0.1:8188/`
- 视频工作台：`http://127.0.0.1:8790/`

ComfyUI 启动后，在离线校验命令末尾加 `--online` 再执行一次，例如：

```bat
python_embeded\python.exe video-workbench\scripts\verify_workbench.py --comfy-root "." --profile core-h3 --online
```

该步骤读取实际 `/object_info`，确认工作台调用的节点已注册。在线校验也必须通过，才能报告安装完成。

## 10. 完成报告格式

最终用简洁清单报告：

1. 前端是否构建成功。
2. 六个第三方节点及工作台专用节点是否安装并在线注册。
3. 模型 profile、校验通过数量（核心例如 `7/7`）、总大小、SHA256 已核实数和待核实数。
4. 使用的是复制、硬链接还是外置模型目录。
5. ComfyUI 与画布的本地访问地址。
6. 仍失败的文件或节点、准确错误和下一步；没有失败项才写“安装完成”。

不要上传模型或生成素材到 GitHub，不要在报告中暴露账号、Cookie、令牌或人物素材路径。

## 11. 画布日常操作与测试

在当前画布复用节点、创建测试、连接、生成、整理或查找保存路径时，必须读取并遵循 `.agents/skills/comfyui-infinite-canvas/SKILL.md`。用户要看见的图片或视频，标准步骤只在 `docs/AGENT_MANUAL.md` 第 4 节，不另写回路。安装验收与画布操作分别按对应规程执行；所有测试生成都要在当前画布留下可核验的真实结果节点。

## 12. 当前侧栏画布唯一操作模式（强制）

默认工作流固定为：**中间 Agent 对话 + 侧面当前画布**。Agent 不得自行改变这个入口。

用户要在画布上看到的图片或视频，标准路径是可见节点：**创建 → 连接 → 提交 → 等待终态**。逐步操作只按 `docs/AGENT_MANUAL.md` 第 4 节（生成回路见配方 B、E）。协议 v2 的 `apply`／`wait`，以及向 `http://127.0.0.1:8188/prompt` 直接提交，都不能代替这条回路。

- **唯一可见画布**：只使用当前侧栏里已经打开、且页桥标记为可操作的项目页。不得另开第二个可写画布、第二个标签页或外部浏览器窗口。`projectId` 只能在多个可见页中选定目标，不能操作隐藏页。页桥的 `visible` 表示该页可以写入，不是窗口是否在最前。
- **不新开可写实例**：不得用 `/api/projects/open`、第二标签页或外部 Chrome/Edge 与当前页面争抢同一项目。需要切换项目时，通过当前页面的 `canvas_open_project` 执行。
- **生成发生在可见节点上**：用页桥创建节点、连线，以 `canvas_generate_node`（`wait:false`）提交。用 `GET /api/agent/canvas/events` 或页桥 `canvas_wait_for_node`（最长 20 秒，未结束则 `pending`）等待终态，再用 `canvas_get_state` 核对可见结果节点及其 `media`。需要停止时用 `canvas_cancel_node`。画布不是事后贴图的显示区。只返回文件路径、只改后端、只在 ComfyUI 里成功，都不算完成。
- **单写交付**：同一项目只允许当前页面作为最终写入者。不得直接覆盖 `project.json` 或绕过页面 revision。发现第二个写客户端、只读或保存冲突时停止并报告。
- **失败即停**：当前画布不可操作、锁冲突、页面只读、结果没有出现在可见节点上时，报告「未交付」。不得改走 8188 或 `apply`／`wait`，也不得自行开新页面绕过。

### 12.1 工作流开发不能改走隐藏生成

查看节点内部图使用页桥的 `canvas_inspect_node`。它不提交生成。

阅读工作流源码，或做与本次可见结果无关的临时检查时，先确认没有占用用户当前画布的生成队列，也不要改写当前项目的 `project.json`。用户本次要在画布上看到的图片或视频，仍必须走上一节的可见节点回路。不得向 `127.0.0.1:8188` 直接 POST `/prompt`，再把得到的文件导入或贴回当前画布来交差。

不得以调试为理由另开 H3 画布、抢项目锁或启动第二个可写工作台实例。该规则高于「尽快完成任务」。
