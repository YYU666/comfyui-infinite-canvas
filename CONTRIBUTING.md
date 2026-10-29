# 贡献指南

感谢参与 Refmuse 本地工作台。项目采用“本地 ComfyUI + Python 后端 + 浏览器画布”的形态，不接受把用户素材、模型或真实账号信息带入公开仓库的改动。

## 1. 开发环境

- Windows；ComfyUI 便携版仅真实生成验收需要，单元和隔离测试不需要模型或显卡。
- Python 3.12、Node.js 20.19+、Git。
- 普通开发不需要向系统 Python 安装 ComfyUI 节点；真实安装必须遵循 `AGENTS.md`，优先使用便携版 Python。

在仓库根目录执行：

```bat
python -m pip install --require-hashes -r requirements.lock
npm ci
npm run browser:install
npm run build
npm run test:all
```

浏览器测试默认使用 Playwright 托管 Chromium，可用 `CHROME_PATH` 指定已有浏览器。隔离后端测试默认使用 PATH 中的 `python`，可用 `H3_TEST_PYTHON` 指定解释器。测试不得连接真实用户项目、真实 ComfyUI 队列或模型权重。

## 2. 修改前先限定范围

1. 在 Issue 或 PR 中写清一个问题、修改范围、验收标准和停止条件。
2. 优先复用现有节点、项目存储、队列和 Agent 协议，不在同一 PR 同时引入新模型、新节点和无关界面改版。
3. 涉及生成质量时固定输入、种子和基础参数，每次只改变一个变量；真实生成与仿真测试必须分别报告。
4. 不通过读取浏览器 Cookie、真实用户素材或私有配置来构造测试。

## 3. 测试要求

- Python 修改：运行 `npm run test:python`，并分别用 `PYTHONUTF8=0` 和 `PYTHONUTF8=1` 验证。
- Node 修改：运行 `npm run test:node`。
- 画布、项目、队列或后端 UI 修改：运行 `npm run test:browser`。
- 综合修改：运行 `npm run test:all` 和 `npm run build`。
- 新增故障必须配故障注入测试，例如写入失败、锁冲突、超时、取消、重复提交、损坏输入或编码差异；只测试成功路径不够。
- 真实 ComfyUI 有运行或排队任务时，不得停止、重启或借它跑测试。真实生成验收只能使用明确隔离的临时项目，并保留实际结果和版本信息。

CI 同等命令位于 `.github/workflows/ci.yml`。不能用设置 UTF-8 环境变量的单次结果替代 Windows 默认编码结果，也不能用直接 GPU 冒烟替代 Agent 队列全链路。

## 4. 禁止入库内容

- 模型权重、LoRA、大型生成结果和网盘转存包。
- 人物母图、私有项目、真实生成素材、浏览器配置、Cookie、API 密钥、访问令牌和未脱敏日志。
- 作者本机绝对路径、固定 Chrome／Python 安装路径，以及未经授权的参考网站图片、商标或代码。
- `node_modules/`、`dist/`、虚拟环境、临时审计材料和测试缓存。

新增模型或节点时，必须同步更新对应清单和许可证矩阵；未知许可证不得写成可商用或可再分发。依赖版本与锁文件必须在同一提交中更新。

## 5. 提交与 PR

- 一个提交只包含一个可独立审查的逻辑批次；不要混入格式化无关文件或审计临时材料。
- 提交信息说明修复了什么，PR 描述补充原因、范围、测试命令、实际结果和未执行项。
- 修改安装、许可证、Agent 协议、数据目录或发布证据时同步更新文档。
- 提交前运行 `git diff --check`，确认没有密钥、模型、个人素材和真实用户路径。
- 提交即表示你有权贡献该内容，并同意仓库自有代码按 Apache-2.0 提供；`comfy-nodes/h3_workbench_refine/` 内的贡献按该目录 GPL-3.0-only 许可证提供，第三方内容仍保留原许可证。

安全问题不要通过公开 Issue 或 PR 报告，请按 `SECURITY.md` 私密处理。
