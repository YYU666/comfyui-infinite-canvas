# 保存路径与持久化

## 1. 数据盘选择与本机路径

不要固定假设所有电脑都使用 D 盘。导入素材和生成结果可能持续增长，新安装或明确迁移时，先检查各本地固定磁盘的可用空间、预计增长和剩余余量，优先选择空间充足的数据盘；空间足够时也可用其他盘，不局限于盘符 D。

通过 `H3_WORKBENCH_DATA_DIR` 设置实际数据根目录，并在交付说明中记录该真实路径。当前版本未配置环境变量时的内置默认值是 `D:\H3_Workbench`，不是自动选盘功能。已有项目沿用已核实配置，不擅自迁移或修改；需要迁移时先获得用户许可并保留原数据。

以下以**本机当前默认配置**为例，其他环境将 `<DATA_DIR>` 替换为实际数据根目录：

| 内容 | 本机默认保存位置 | 通用位置／说明 |
| --- | --- | --- |
| 数据根目录 | `D:\H3_Workbench` | `<DATA_DIR>`；仅素材和生成文件，不是画布项目文件目录 |
| 上传／输入素材 | `D:\H3_Workbench\references` | `<DATA_DIR>\references`；ComfyUI 输入素材 |
| 网页视频导入 | `D:\H3_Workbench\references\workbench` | `<DATA_DIR>\references\workbench` |
| 生成结果 | `D:\H3_Workbench\generated` | `<DATA_DIR>\generated`；ComfyUI 输出根目录 |
| 普通生成图片 | `D:\H3_Workbench\generated\image` | `<DATA_DIR>\generated\image`；前缀随工作流而变 |
| H3 视频 | `D:\H3_Workbench\generated\video` | `<DATA_DIR>\generated\video`；通常以 `H3_Workbench` 开头 |
| 画布项目 | 当前浏览器的 IndexedDB | `h3-canvas-projects`；不在上述数据目录中 |
| 画布内上传媒体 | 当前浏览器的 IndexedDB | 用于重新打开后恢复素材 |
| 内置模型目录 | `C:\ComfyUI_windows_portable\ComfyUI\models` | 本机 ComfyUI 便携版的模型目录 |
| 本机外置模型 | `D:\H3-Models` | 由模型路径配置决定，不属生成数据目录 |

源码依据：`video_workbench_launcher.py` 定义数据根目录及输入、输出目录；`src/workbench-api.js` 定义各工作流的输出子目录和文件名前缀。

## 2. 生成结果定位

不要只按修改时间猜结果。先读取画布真实结果节点，再按节点媒体信息或对应 ComfyUI 输出记录定位。

常见 `filename_prefix`：

- 视频：`video/H3_Workbench`、`video/H3_CharacterSwap`、`video/H3_HD_Refine`
- 图片：`image/H3_Image`、`image/H3_MOSS_Image`、`image/H3_Qwen21Edit`
- 局部写实：`image/H3_LocalRealism`
- 图片高清：`image/H3_Image_HD`
- 换装：按流程使用 `image/H3_OutfitSingle_<面板>` 或 `image/H3_OutfitQuad`

例如 `image/H3_Qwen21Edit` 对应数据根目录下的 `generated\image\`；ComfyUI 会在前缀后补充编号和扩展名。不要凭示例拼接一个未核实的完整文件名。

## 3. 画布项目的真实保存位置

当前已发布实现使用当前浏览器 `http://127.0.0.1:8790` 源下的存储：

| 数据 | 存储位置／键 |
| --- | --- |
| 各项目的名称、节点、连线、视口及修订号 | IndexedDB：`h3-canvas-projects`，对象仓库 `projects` |
| 当前项目与一次性迁移记录 | IndexedDB：`h3-canvas-projects`，对象仓库 `settings` |
| 当前画布的兼容缓存 | localStorage：`h3-infinite-canvas-v2`；不是完整项目库 |
| 旧版画布数据 | localStorage：`h3-infinite-canvas-v1` |
| 项目名兼容缓存 | localStorage：`h3-canvas-name-v1` |
| 上传媒体文件 | IndexedDB：`h3-workbench-media`，对象仓库 `files`；新素材按项目 ID 与不可变素材 ID 隔离 |

这意味着：

- 关闭网页或应用后，正常重新打开同一浏览器、同一地址会恢复项目。
- 从左上角项目名称旁的下拉菜单选择或新建画布。新建不会替换原画布；每个项目独立保存名称、布局、连线和视口。
- 首次打开项目列表会将原有单画布导入为第一个项目，并保留原 localStorage 记录和旧素材；迁移项目可以读取原有素材，新项目不会共用这些记录。
- 修改后自动保存，切换或新建前先完成当前项目与素材的保存。保存失败或任务进行中时，保留当前画布，不切换项目。
- 多窗口同时编辑同一个项目时，修订冲突会显示错误并阻止旧窗口覆盖较新记录。不要忽略保存失败提示后关闭页面。
- 删除节点不会立即删除浏览器中的素材记录，避免保存失败或旧窗口冲突时破坏已保存项目引用的文件。
- 换浏览器、换端口或换主机名不会自动共享项目。
- 清理该站点数据可能同时丢失画布和未落盘的上传媒体。
- 生成文件已写入数据盘，不等于节点布局、提示词和画布项目已备份到该数据盘。
- 完整备份需要包含项目库与所需素材；只导出 `h3-infinite-canvas-v2` 不能备份所有项目。
- 不要为了让 Agent “重新开始”而清空上述存储。

项目库的实现依据为 `src/canvas-projects.js` 与 `src/CanvasWorkbench.jsx`。项目仍保存在本机浏览器中；分类菜单中的协作空状态不表示已接入多人协作或云端同步。

## 4. 模型路径

模型按 `models/manifest.json` 放入 ComfyUI 模型目录，或通过 `extra_model_paths.yaml` 指向外置模型根目录。不要把模型复制进 `<DATA_DIR>\generated`。

本机两个模型来源是：

```text
C:\ComfyUI_windows_portable\ComfyUI\models
D:\H3-Models
```

模型安装、下载来源、目录映射、字节数验收及缺失项以仓库根目录 `AGENTS.md`、`models/manifest.json` 和 `models/SOURCES.md` 为准。保留已有模型配置，不擅自覆盖或删除。

## 5. 交付时的表述

完成生成后，分别报告：

1. 画布中的结果节点 ID 和标题。
2. 实际文件目录；只有核实完整路径后才给出完整文件名。
3. 画布仍依赖浏览器本机存储这一事实（仅在涉及备份、迁移、关闭或清理时提醒）。

不要报告“项目已备份”，除非确实完成了一种可恢复的项目导出并验证其内容。
