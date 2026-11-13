# 文生图 / 图生图自动选模

生成图片时，画布只改现有下拉：文生图的 `imageModel`（krea2 / moss / h3_image / flux3_klein）和图生图的 `qwenModel`（standard / turbo / h3_image / flux3_klein）。不新增模型选择器，也不动视频模型。

## 谁来选

- 用户或 Agent 改下拉，或提示里点名模型（如「用 H3」「换 Klein」）后，该节点写入 `modelLockedByUser`。之后自动选模不再改它。
- 点名的模型没装好时，直接说明缺哪些文件或节点，下拉保持原值。
- 没有点名、也没有锁的节点，在点击本地生成或调用 `canvas_generate_node` 之前自动选一次。Agent 也可以单独调用 `canvas_pick_image_model`。
- 选中的模型用一行字写在节点上，例如：`自动选了 H3-Image（场景概念 · 已安装 · 你上次收下了 3 张）`。生成回执里的 `announcement` 是同一句。

## 怎么选

只在当前画布连接的 ComfyUI `object_info` 里已安装、且和节点兼容的模型中打分。安装检查只读，不下载、不修复。ComfyUI 离线时不改下拉。

兼容规则与现在的下拉一致：有遮罩、单格裁切或局部放大时，H3-Image 和 FLUX 3 Klein 不可用；Krea2 风格 LoRA 只留在 krea2；真人化 LoRA 只留在 Qwen 标准版或 Turbo。选中 H3 或 Klein 时清掉 LoRA。Qwen 2.1 只在图生图下拉里。下拉里的 krea2 仍是 Muse V3.0 Turbo FP8。

分数是 `0.6 × 任务匹配 + 0.3 × 历史 + 0.1 × 速度`。任务匹配按内置顺序：第 1 名 1，之后 0.75、0.5、0.25。提示里有「快速 / 草图 / 多来几张 / 先看看 / 批量」时，速度权重改为 0.3，任务匹配改为 0.4，历史仍是 0.3。速度分是按步数和模型体积估的，不是本机实测。平分时按该任务的推荐顺序。

历史按「同一模型 × 同一任务」计算：`(收下 + 1) / (收下 + 否掉 + 2) - 0.5`，再乘 `min(1, n / 5)`。每条记录按 30 天半衰期衰减，所以一两条记录几乎不影响选择。

## 收下 / 否掉

文生图和图生图节点有结果时，节点上有「收下」「否掉」。Agent 用 `canvas_review_image`，`accepted: true` 为收下。未表态就重新生成，或删掉对应结果，记为否掉；把完成的结果连到下游，记为收下。

记录在两条地方：

- 节点 `imageReview`：`{ accepted, model, taskType, time, resultKey }`，只表示当前这张结果。
- 项目 `settings.imageModelHistory`：`{ model, field, taskType, accepted, time, nodeId, resultKey }`。同一节点的同一 `resultKey` 只留最新一条，超过 180 天的记录会丢掉，最多保留 400 条。保存画布时一并写入，不单独开接口。

这次改动只在前端。8790 从 `dist/` 提供页面，部署新包后需要重新构建前端并重启 8790 才会生效。不要为了这项功能下载模型或重启正在跑的任务。
