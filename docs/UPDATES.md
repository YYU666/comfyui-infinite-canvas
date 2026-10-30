# Release 检查与一键安全升级

## 用户操作

1. 保持网络可用，正常启动 Refmuse 本地工作台。默认只在启动后检查 `YYU666/comfyui-infinite-canvas` 的最新 GitHub Release；离线、限流或没有新版时不会弹出错误。
2. 发现新版后阅读版本号和 Release notes。可“稍后”、“查看 Release”或“立即升级”。也可在“设置 → 程序更新”手动检查，或关闭“启动时检查 GitHub Release”。
3. 升级前保存当前项目并返回项目启动页，等待生成和排队任务结束。活动任务、打开的项目、Git 跟踪文件的本地修改、磁盘空间不足都会阻止升级。
4. 点击“立即升级”后不要关闭电脑。程序下载并校验更新包，在独立目录安装 Node 依赖和构建画布，然后由工作台外部恢复程序备份、替换、安装锁定的 Python 依赖并重启。页面健康检查到目标版本后自动刷新。

这是一套“自动检查＋用户确认＋自动安装”机制，不会未经确认静默升级。

## 保留与替换边界

更新包只含 Git 跟踪的工作台源码和文档；构建阶段生成独立 `dist/` 与 `node_modules/`。更新不会替换或清空：

- ComfyUI 本体和第三方节点；
- 模型、LoRA 和外置模型目录；
- 项目根目录、引用素材、生成结果和导出；
- `%LOCALAPPDATA%\H3Workbench\config.json`、系统密钥库和其他用户设置；
- 工作台目录内不属于更新清单的本地未跟踪文件。

Git 安装会在下载前和重启前两次检查跟踪文件修改，发现修改即停止。非 Git 源码安装无法通过 Git 判断代码修改，因此被替换的旧文件仍会保留在本次更新备份中。首次升级没有历史文件清单时，不删除无法确认归属的旧文件；后续升级只清理上一版清单登记、且新版已删除的程序文件。

## 包完整性与故障恢复

- Release 必须同时提供 `refmuse-update-<tag>.zip` 和同名 `.zip.sha256`。
- 后端只从固定官方仓库读取 Release，下载地址必须为 GitHub HTTPS；客户端只能提交刚确认的 `tag`，不能提交下载 URL。
- 下载包限制为 128 MiB、2500 个文件、解压后 256 MiB。ZIP 路径逃逸、绝对路径、符号链接、重复清单、额外文件、缺失文件、错误版本和错误 SHA256 均拒绝。
- `package.json`、`workbench_lifecycle.APP_VERSION` 和 Release 标签必须一致。校验只解析文本和 AST，不执行下载包中的安装脚本。
- 工作台进程退出后才替换文件。安装或健康检查失败会还原程序、前端、Node 依赖和锁定的 Python 依赖，并尝试重新启动旧版。
- 本次备份位于 `%LOCALAPPDATA%\H3Workbench\updates\prepare-*\backup\`。确认新版稳定后可删除不再需要的旧 `prepare-*` 目录；更新状态为 `preparing` 或 `restarting` 时不要删除。
- 若自动恢复也失败，保留备份并重新运行 `install.bat`，不要删除项目目录或模型目录。更新接口不会要求管理员权限。

## 发布新版

1. 在同一个提交中更新 `package.json`、`package-lock.json` 的版本，以及 `workbench_lifecycle.py` 的 `APP_VERSION`。三者与 Release 标签去掉开头 `v` 后必须一致，例如 `v1.1.0` 对应 `1.1.0`。
2. 运行完整测试和构建，再创建带发布说明的 GitHub Release。语义化版本比较支持 `rc.1` 等预发布标识；GitHub“最新 Release”接口的选择规则保持不变。
3. `.github/workflows/release.yml` 在 Release 发布时执行：

   ```bat
   python scripts\build_update_package.py --tag v1.1.0 --output .release
   ```

   随后把 ZIP 与 SHA256 附加到同一 Release。打包只读取 Git 跟踪文件，不包含本地项目、模型、密钥、未跟踪审计文档或生成结果。
4. 等 Release 资源上传工作流成功结束，再通知用户检查更新。缺少升级包或校验文件时，界面只允许手动查看 Release，不会尝试不安全安装。

手动打包后也必须同时上传 `.zip` 与 `.zip.sha256`，不能只上传 GitHub 自动生成的 Source code ZIP。

## 开发者验证

更新测试全部使用临时目录、合成 Release、合成 ZIP 和模拟进程，不访问真实 Release、不重启用户工作台、不读取模型或人物素材：

```bat
python -m unittest discover -s . -p "test_*update*.py" -t . -v
npm run build
node test-update-center-ui.mjs
```

覆盖版本比较、离线无打扰、标签绑定、令牌保护、活动状态阻止、恶意 ZIP、哈希不匹配、重复升级、用户目录保留、依赖失败回滚和界面重复点击。模拟 UI 测试不代表真实线上升级已执行；发布前仍应在另一台隔离测试机完成一次真实 Release 升级验收。
