# Native3D 本地 3D 资产加工

从当前项目的添加菜单选择「3D 资产加工 → 3D模型」，导入本机 GLB 或 OBJ，再将模型连接到原高模百分比 LOD、UV 展开或材质烘焙等节点。FBX 导入需另行配置本机转换器。源文件和加工结果保存在本地项目，完成后可在结果节点检查网格、贴图和下载文件。

## 配置基础加工

标准画布默认显示菜单。加工任务由独立 Native3D Python 环境运行，基础操作不需要模型权重或 ComfyUI 队列。使用可创建虚拟环境的本机 Python，在工作台根目录执行：

```powershell
python scripts/setup_native3d.py --venv <path>
```

脚本安装 `requirements-native3d.txt` 并输出虚拟环境的 Python 路径。将该绝对路径设为 `H3_NATIVE3D_PYTHON`，或写入当前工作台运行目录下 `native3d-config.json` 的 `pythonExecutable`。Windows 默认运行目录是 `%LOCALAPPDATA%\H3Workbench`，设有 `H3_WORKBENCH_RUNTIME_DIR` 时使用指定位置。ComfyUI 的 Python 环境不适用于此配置。重启工作台后，在节点上检查所选操作的就绪状态。「3D 资产加工」菜单显示「Native3D LOD」状态。Agent 可用 `canvas_native3d_capabilities` 查看 `source_lod` 的就绪状态和参数。

## 图生白模与曲率磨损

「图生白模 · 未展UV无材质」只接上一张已保存的参考图。支持透明 PNG / WebP、浅色背景或保留整图。配置写在运行目录的 `native3d-config.json`，配置的 Python 应能使用 NVIDIA CUDA：

```json
{
  "imageTo3D": {
    "pythonExecutable": "C:/path/to/triposr/venv/Scripts/python.exe",
    "sourceDirectory": "C:/path/to/official/TripoSR",
    "modelDirectory": "C:/path/to/triposr/weights"
  }
}
```

`sourceDirectory` 指向官方 TripoSR 仓库根（验收版本 `107cefdc244c39106fa830359024f6a2f1c78871`）。`modelDirectory` 包含 Stability AI 的 `config.yaml` 和 `model.ckpt`，以及 DINO ViT-B/16 的 `config.json`（保存为 `dino-config.json`）。这些文件必须通过固定 SHA-256 校验。运行环境需安装 CUDA Torch、TorchVision、Transformers、OmegaConf、einops、Trimesh、NumPy、Pillow、imageio、huggingface-hub、PyMCubes、fast-simplification 和 psutil。已有独立 CUDA 环境缺少个别包时，可把补充安装目录的绝对路径配置为 `pythonModuleDirectory`。节点加载本地模型，导出几何 GLB。顶点色只供预览，这一步不展 UV，也不写材质贴图。没有用过的权重请在获得授权后下载。[上游源码](https://github.com/VAST-AI-Research/TripoSR) · [官方权重](https://huggingface.co/stabilityai/TripoSR)

按「参考图 → 图生白模 → 修模 / LOD → 之后的 UV → 材质烘焙 → 曲率磨损」连接节点。白模节点到此为止。烘焙的高模输入回接修模后的 GLB，低模输入接对应 LOD 的 UV 结果。烘焙可投射高模顶点色，并输出基于高模凸棱夹角的曲率贴图。曲率磨损调节底色、粗糙度与可选的金属露出，沿用该烘焙的原网格、UV、法线和 AO。用「查看材质效果」验证模型，运行完成后可下载 GLB 和各张贴图。没有曲率通道的历史烘焙需要从原节点重新运行。

## 处理图生白模结果

把图生白模节点的 `model` 输出直接连到修模、LOD 或分析节点。自定义工作流完成时已把 GLB 写入当前项目 `assets/`。尚未落盘的旧 ComfyUI 地址，会在第一次 Native3D 加工时保存到当前项目。保存期间请留在当前项目；项目、写入权限或模型输入变化会阻止此次提交。Agent 可用原 `nodeId` 和提交返回的 `jobId` 调用 `canvas_wait_for_node`；`pending:true` 时续查同一任务。

## 可选能力与检查

AI 低模和 UV 切缝方案分别使用附加适配器。根据节点提示配置相应运行环境、模型权重及校验信息。通过几何检查的输出可连接后续 UV 与烘焙，遇到阻断时先检查结果节点的诊断。适配器能力和处理结果取决于单项就绪状态与输入资产。Pixal3D 是另一条本机 ComfyUI 工作流，需独立准备六份权重。 [Pixal3D 配置](REFMUSE_LOCAL_IMAGE_TO_3D.md)
