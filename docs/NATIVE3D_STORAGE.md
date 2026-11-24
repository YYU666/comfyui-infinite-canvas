# Native3D 作业空间盘点

在工作台目录用 Python 3.10 或更新版本执行。此命令只读文件和元数据，输出到终端。

```powershell
$runtime = $env:H3_WORKBENCH_RUNTIME_DIR
if (-not $runtime) ` $runtime = Join-Path $env:LOCALAPPDATA 'H3Workbench' `
$settings = Get-Content -LiteralPath (Join-Path $runtime 'config.json') -Raw | ConvertFrom-Json
python -B scripts/native3d_storage_inventory.py --jobs-root (Join-Path $runtime 'native3d-jobs') --projects-root $settings.projectsRoot
```

追加 `--json` 可得到版本化 JSON，包括每个作业的逻辑字节数、状态、项目记录路径、依赖和可再生成的文件。完整结果含本机路径。针对配置根目录之外的项目，重复传入 `--projects-root "项目路径"` 补齐范围。工具递归读取指定位置内的 `project.json`、`backups/*.json`、冲突副本及回收站项目。扫描范围以报告中的根目录为准，浏览器未保存状态和未解包的项目归档不在其中。

- `referenced` 表示已发现项目引用，或该作业是项目引用或运行中作业的上游依赖。引用包含作业 ID、文件 URL 和保存后尚待回填作业 ID 的提交身份。
- `unproven` 表示目前没有充分证据支持清理，包括未匹配作业、运行中数据、未知文件以及历史作业的模型、清单、输入快照和诊断。
- `regenerable` 仅计入未发现引用的成功 UV 作业中、与保留模型 SHA-256 匹配并符合现行重渲染规则的普通 seams 和 checker 缓存。工具不调用渲染环境。
- 出现未读、损坏、超限或链接跳过等问题时，退出码为 2，报告仍保留已读结果并将可再生成字节保守计为零。未扫描到项目记录时也按此规则处理。

数值为文件逻辑大小，反映盘点时观察到的文件。并发的项目编辑和后台作业可能改变结果，压缩、稀疏文件和硬链接会影响实际磁盘占用。盘点没有删除入口，结果也不承诺可释放空间。
