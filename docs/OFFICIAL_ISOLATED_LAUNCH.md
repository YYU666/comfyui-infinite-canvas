# 官方隔离启动（引擎用）

本文是给 RGS 引擎和发布验收用的草案。普通工作树双击 `启动.vbs` 的行为不变：不设置下面的官方变量时，仍然在 `8790–8799` 里选空闲端口，并可以使用本机已有的数据目录。

本轮运行时**只有 Windows amd64**。macOS 只做平台探测，不提供、也不声称有可安装的 Python 运行时。

## 两种包不要混用

| 包 | 用途 | 里面有什么 |
|---|---|---|
| `refmuse-update-<tag>.zip` | 只覆盖更新**已经装好**的工作台 | Git 跟踪的源码和文档。公开路径门禁**拒绝** `dist/`、`node_modules/`、运行目录和凭据。目标机器仍要自己 `npm ci` 和 `npm run build`。 |
| `refmuse-portable-<tag>.zip` | 引擎安装到**空的** `official-canvas/<tag>` | 同一份公开源码，加上 CI 用 Node 22 构建出来的 `dist/`（必须有 `dist/index.html`）。 |
| `refmuse-runtime-python-win-amd64-<pythonver>.zip` | 这一份画布进程自己的 Python | 官方 CPython 3.12 embeddable，加上按 `requirements.lock` 安装的依赖。**不**打进更新包，也**不**打进便携包。 |

引擎规则：

1. 只把**便携包**解压进空的官方目录。不要把更新包当作安装源。更新包没有 `dist/index.html`，也没有 Python。
2. 运行时解压到它自己的版本目录，不要解进会和下一个标签互相覆盖的 `official-canvas/python_embeded`。
3. 解压前同时核对 SHA-256 和字节数。只对其中一个不能算通过。

将来的 GitHub Release（本分支不会发 Release、也不会打标签）由 `.github/workflows/release.yml` 在 `release: published` 时上传这三组 zip 和各自的 `.sha256`。PR 上的 CI 只把同样的文件做成**未签名的 Actions artifact**，供审计查看包含规则，不能当作生产安装包。

## 校验 SHA-256 和字节数

便携包和运行时包的 `.sha256` 是一行 ASCII：

```text
<64位小写sha256>  <字节数>  <文件名>
```

更新包仍是原来的两列（`sha256` 和文件名），供现有升级器使用。引擎安装便携包和运行时时不要用更新包那条校验逻辑代替字节数检查。

核对步骤：

1. 下载 zip 和同名的 `.sha256`。不要用 GitHub 自动生成的 Source code 压缩包。
2. 计算 zip 的 SHA-256，与第一列逐字比较。
3. 比较 zip 的实际字节数与第二列。不一致就删除，不要解压。
4. 解压目标必须是空目录。便携包进 `official-canvas/<tag>/`。运行时进下面的 identity 目录。

PR 的 CI artifact 没有 Release 签名。引擎锁定版本时要以已发布 Release 上的资产为准，并重新做上面的两步核对。

## Windows amd64 Python 运行时

配方在 `scripts/build_runtime_package.py`。`python scripts/build_runtime_package.py --describe` 会打印同一份内容，任何系统都可以查看；真正打包只允许在 Windows amd64（CI 使用 `windows-latest`）上执行。

| 项 | 值 |
|---|---|
| Python | CPython **3.12.10** embeddable，Windows amd64。这是 3.12 系列最后一个带官方 Windows 二进制的版本；3.12.11 起按 PEP 693 只有源码包。CI 和 Release 工作流的 `setup-python` 仍选择 3.12 这条线。 |
| 官方 zip | `https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip` |
| 字节数 | `11133606` |
| SHA-256 | `4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3` |
| 官方 SPDX | `https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip.spdx.json` 里名为 CPython、文件名为 `python-3.12.10-embed-amd64.zip` 的 `checksumValue` 必须与上一行相同。 |
| get-pip | `https://bootstrap.pypa.io/get-pip.py`，字节数 `2397294`，SHA-256 `356e0d0de21cdc348c3394084d90939b85e4246c4d14c76aee6ca4f46646ea98`（2026-11-13 钉死；不一致则停止，不会改用别的安装器）。 |
| 依赖 | 启用 `python312._pth` 里的 `import site`，再用这份嵌入式 `python.exe` 执行 `python -m pip install --require-hashes -r requirements.lock`。不使用正在跑的 8790 工作树解释器，也不使用用户的 ComfyUI `python_embeded`。 |

构建机下载官方 zip 后先比字节数、再比 SHA-256，通过才解压。运行时 zip 自己的 SHA-256 和字节数写在旁边的 `.sha256` 里，引擎解压前再核一次。

### 目录和身份

zip 顶层不是裸的 `python_embeded/`。顶层目录名是：

```text
refmuse-runtime-python-win-amd64-3.12.10-<requirements.lock 的 sha256 前 12 位>
```

里面有：

```text
runtime-manifest.json    # python 版本、requirements.lock 哈希、包身份、平台
LICENSES/PSF-LICENSE.txt
LICENSES/THIRD-PARTY.txt
LICENSES/wheels/...
python_embeded/python.exe
python_embeded/pythonw.exe
```

`runtime-manifest.json` 的 `identity` 就是这个目录名。下一个画布标签如果 `requirements.lock` 变了，身份也变，不会覆盖上一份运行时。引擎把 `H3_COMFY_ROOT` 指到**这个 identity 目录**（包含 `python_embeded` 的那一层）。

在这份用法里，`H3_COMFY_ROOT` 是工作台进程的 Python 根，**不是** ComfyUI 安装根。`启动.vbs` 只在这个目录下找 `python_embeded\pythonw.exe`。官方启动必须同时设置 `H3_COMFY_AUTOSTART=0`，避免把这份运行时当成 Comfy 根去拉起或探测 8188。

### 许可证

- 嵌入式解释器是官方 CPython，许可证为 PSF License。构建时从官方 zip 复制 `LICENSE` 到 `LICENSES/PSF-LICENSE.txt`。说明见 <https://docs.python.org/3/license.html>。
- 第三方包只来自仓库里的 `requirements.lock`（带 SHA-256）。各轮子的许可证从安装后的 `*.dist-info` 复制到 `LICENSES/wheels/`，并记入 `LICENSES/THIRD-PARTY.txt`。未知许可证不能当成允许再分发或商用。
- `pip` / `setuptools` / `wheel` 只来自上面钉死的 `get-pip.py`，用来安装锁定依赖。
- 运行时 zip 不进 Git。仓库里只有脚本、工作流、测试和这份说明。

## 环境变量

官方模式的开关是**进程启动前**已经设置的 `H3_WORKBENCH_PORT`（`--port` 与它等价，隔离目录也必须事先设好）。

| 变量 | 未设置时 | 官方隔离启动 |
|---|---|---|
| `H3_WORKBENCH_PORT` | 在 `8790–8799` 里选一个空闲端口，并优先沿用该实例上次的端口 | 正整数：只绑定这个端口，被占用就失败，**不**再扫描 `8790–8799`。`0`：交给操作系统分配，并把实际端口写回**这个实例自己的** `instance.json` 和 `workbench-port.json`。`8188` 和 `8790–8799` 直接拒绝。 |
| `H3_WORKBENCH_RUNTIME_DIR` | `%LOCALAPPDATA%\H3Workbench` | 必填绝对路径。`instance.json`、日志、锁只写在这里。 |
| `H3_WORKBENCH_DATA_DIR` | 沿用已记住的数据目录，否则按现有规则选盘 | 必填绝对路径。不写用户的数据目录选择文件。 |
| `H3_PROJECTS_ROOT` | `%USERPROFILE%\Documents\H3 Workbench` | 必填绝对路径。 |
| `H3_COMFY_AUTOSTART` | 未设置或 `1`：保持现在的 Comfy 启动/附着行为。`H3_WORKBENCH_TEST_MODE` 仍然只用于测试，它还会关掉更新检查并改健康检查字段，**不能**拿来代替本开关。 | 必须设为 `0`。不启动 Comfy，不附着已有 Comfy，健康检查、诊断、Comfy 代理和队列都不会连接 `8188`。 |
| `H3_COMFY_ROOT` | `启动.vbs` 在未设置端口时用脚本目录的上一级，并在那里找 `python_embeded\pythonw.exe` | 必填，指到上面的运行时 identity 目录。端口已设置但此变量为空时，`启动.vbs` 直接失败，不会改用安装目录的上一级（那会变成 `official-canvas/python_embeded`）。 |

`H3_WORKBENCH_PORT` 已设置但三个目录里缺任何一个时，进程直接失败，并说明缺哪一个。失败路径不会创建 `%LOCALAPPDATA%\H3Workbench`，也不会去附着用户正在用的 `8790` 实例。

官方实例不要使用 `8790–8799` 或 `8188`。引擎应设置范围外的端口，或设置 `0` 让系统分配。

## 三层就绪

1. **进程已创建**  
   该实例 `H3_WORKBENCH_RUNTIME_DIR/instance.json` 里有 `pid`。再用进程创建时间核对这个 pid 仍然是这次启动的进程（现有 `instance_process_alive`）。

2. **HTTP 已就绪**  
   `GET /api/health` 不需要令牌。`Host` 必须带真实端口，例如 `Host: 127.0.0.1:23456`；只有主机名、端口不对，仍然是 403。响应里的 `pid` 必须等于 `instance.json` 的 `pid`，`port` 必须是实际监听端口。可以读 `uiReady` / `uiReadyAt`。这个接口不会返回令牌，也不会因为官方模式多开放别的未认证接口。

3. **窗口已打开**  
   前端根页面加载时（项目启动页即可，不必等项目打开）向 `POST /api/ui-ready` 报告。这个请求**必须**带现有会话令牌：`X-H3-Token`，或打开页面时 `GET /` 写下的 HttpOnly Cookie。没有令牌返回 401，并且不会把 `uiReady` 改成真。成功后再次 `GET /api/health` 可以看到 `uiReady: true`，仍然不需要令牌，响应里也没有令牌。  
   `webbrowser.open` 是发出去就结束的，不能单独当成窗口已打开。

`instance.json` 里的令牌仍然只在那个运行目录中，健康检查不会把它抄出来。
