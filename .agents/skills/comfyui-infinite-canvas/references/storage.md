# 保存路径与持久化

## 1. 先分清三套目录

当前版本由 Python 后端通过 HTTP API 持久化项目。画布项目、ComfyUI 输入／输出和运行时配置是三套不同目录，不要互相替代，也不要只按修改时间猜文件位置。

| 内容 | 通用位置 | 配置方式 |
| --- | --- | --- |
| 画布项目库 | `<PROJECTS_ROOT>\<项目名>\` | 设置页的项目根目录，或启动前设置 `H3_PROJECTS_ROOT` |
| ComfyUI 输入素材 | `<DATA_DIR>\references\` | `H3_WORKBENCH_DATA_DIR`；未显式配置时使用已保存的数据目录选择 |
| ComfyUI 生成结果 | `<DATA_DIR>\generated\` | 同上 |
| 运行时配置与日志 | `<RUNTIME_DIR>\` | `H3_WORKBENCH_RUNTIME_DIR`；默认在当前用户本地应用数据目录的 `H3Workbench` 下 |

首次没有已保存选择时，数据目录选择器会检查本地固定磁盘并优先选择空间充足的位置；若旧版 `D:\H3_Workbench` 已存在则保留旧路径。选择结果写入 `<RUNTIME_DIR>\data-directory.json`，后续重启不会因剩余空间变化而静默换盘。配置损坏或目录不可用时必须明确处理，不要删除配置后擅自迁移数据。

不要假设所有电脑都有 D 盘。导入和生成内容可能持续增长，新安装或明确迁移时应检查实际固定磁盘的可用空间与余量。已有项目沿用已核实配置；迁移前先获得用户许可并保留原数据。

## 2. 磁盘项目的真实结构

每个项目是一个独立文件夹：

```text
<PROJECTS_ROOT>\<项目名>\
├─ project.json       # 名称、节点、连线、视口、镜头、Take、资产清单和 revision
├─ assets\           # 上传素材，按内容 SHA256 命名
├─ outputs\          # 已复制进项目的交付结果
├─ exports\          # 项目 ZIP 等导出文件
├─ backups\          # project.json 历史备份，保留最近 20 份常规备份
└─ .cache\           # 可重建缓存
```

`project_store.py` 的 `ProjectStore` 是磁盘项目权威实现；前端 `src/project-store-http.js` 通过本地 HTTP API 读写。自动保存成功以服务端持久化结果为准，不以浏览器缓存或节点已经显示为据。

- 默认引用 ComfyUI 输出的 Take 使用 `comfy://view?...` 外部引用；这不等于已复制到项目 `outputs/`。
- 项目 ZIP 包含 `project.json`、`assets/` 和 `outputs/`。默认外部引用的 ComfyUI 原始输出若已被清理，不会凭空包含在 ZIP 中。
- 多窗口通过 revision 冲突保护避免旧窗口覆盖新记录；冲突副本不能静默替代当前项目。
- 完整备份应使用经过验证的项目导出，或在工作台关闭后复制整个项目文件夹。只复制 `project.json` 不包含素材。
- 不要为了让 Agent“重新开始”而清空项目目录、浏览器站点数据或运行时配置。

## 3. IndexedDB 仅用于历史迁移

旧版 `h3-canvas-projects` 与 `h3-workbench-media` IndexedDB 不再是当前项目主存储。启动器发现旧记录时，可将其迁移为磁盘项目；迁移前生成 ZIP 备份，并保留原浏览器记录。localStorage 中的旧画布键和少量界面偏好也不是当前项目库。

因此，换浏览器、换端口或清理站点数据不会替代磁盘项目备份；反之，磁盘中有生成文件也不等于旧浏览器项目已经迁移。实现依据为 `src/legacy-migration.js`、`src/project-store-http.js` 和 `project_store.py`。

## 4. 生成结果定位

先读取画布真实结果节点、Take 的 `recipe.output` 或对应 ComfyUI 历史，再按 `filename`、`subfolder`、`type` 定位，不要只按修改时间猜结果。

常见 `filename_prefix`：

- 视频：`video/H3_Workbench`、`video/H3_CharacterSwap`、`video/H3_HD_Refine`
- 图片：`image/H3_Image`、`image/H3_MOSS_Image`、`image/H3_Qwen21Edit`
- 局部写实：`image/H3_LocalRealism`
- 图片高清：`image/H3_Image_HD`
- 换装：`image/H3_OutfitSingle_<面板>` 或 `image/H3_OutfitQuad`

例如 `image/H3_Qwen21Edit` 对应 `<DATA_DIR>\generated\image\`，ComfyUI 会在前缀后补编号和扩展名。工作流定义见 `src/workbench-api.js`；只有核实完整路径后才报告完整文件名。

## 5. 模型路径

模型按 `models/manifest.json` 安装到 ComfyUI 模型目录，或通过 `extra_model_paths.yaml` 指向外置模型根目录。模型来源、目标路径和校验规则以根目录 `AGENTS.md`、`models/SOURCES.md` 与清单为准。不要把模型复制进 `<DATA_DIR>\generated`，不要覆盖或删除已有模型配置。

## 6. 交付时的表述

完成生成后分别报告：

1. 画布中的结果节点 ID 和标题。
2. 已核实的实际文件目录；需要时区分 ComfyUI 外部输出与项目内 `outputs/`。
3. 涉及备份、迁移或关闭时，说明项目是磁盘文件，不依赖当前浏览器 IndexedDB 主存储。

不要报告“项目已备份”，除非确实完成项目导出或完整文件夹备份并验证内容。
