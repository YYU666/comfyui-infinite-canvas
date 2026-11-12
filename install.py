from __future__ import annotations

import argparse
import codecs
import os
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from agent_io import configure_utf8

NODE_PACKAGES = {
    "h3-relay": ("https://github.com/akatz-ai/h3-relay.git", "e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220"),
    "ComfyUI-KJNodes": ("https://github.com/kijai/ComfyUI-KJNodes.git", "b5316a9e247338dc1460df8e4d01e906c566299c"),
    "comfyui-krea2edit": ("https://github.com/lbouaraba/comfyui-krea2edit.git", "13ef60f20828949becada815d3cbc371eb5ccaab"),
    "ComfyUI-Inpaint-CropAndStitch": ("https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch.git", "6005efc02f7745649118edd89cdd084c2b9bd3ae"),
    "Comfyui_Minimax_h3_latent_Upscaler": ("https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git", "40316cf008b2fd8663263270669eb4da23f89d2c"),
    "ComfyUI-Spectrum-MOSS": ("https://github.com/Rkkss/ComfyUI-Spectrum-MOSS.git", "1e5eb359160b50be02ff95d1a93f22af2947888c"),
}


class InstallFailure(RuntimeError):
    def __init__(self, code: int, log: Path):
        super().__init__(f"命令退出码：{code}")
        self.code = code
        self.log = log


def safe_tail(path: Path) -> str:
    """Read a bounded suffix; discard a partial line before redacting secrets."""
    with path.open("rb") as stream:
        size = stream.seek(0, 2)
        start = max(0, size - 65536)
        stream.seek(start)
        data = stream.read(65536)
    if start:
        # A truncated assignment/URL may have lost its secret marker.
        data = data.partition(b"\n")[2]
    lines = data.decode("utf-8", errors="replace").splitlines()[-12:]
    clean = []
    for line in lines:
        line = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", line)
        if re.search(r"(?i)(?:password|passwd|pwd|token|api[_-]?key|access[_-]?key|secret|authorization|cookie)[\w-]*[\"']?\s*[:=]", line):
            line = "[含凭据的日志行已隐藏]"
        line = re.sub(r"(?i)(\b[a-z][a-z0-9+.-]{0,31}://)[^/\s]+@", r"\1[redacted]@", line)
        clean.append(line)
    text = "\n".join(clean) or "[没有完整日志行；请查看日志文件]"
    return text.encode("utf-8")[-3072:].decode("utf-8", errors="ignore")


class InstallerReport:
    def __init__(self, directory: Path, verbose: bool = False):
        directory.mkdir(parents=True, exist_ok=True)
        self.directory = Path(tempfile.mkdtemp(prefix=datetime.now().strftime("%Y%m%d-%H%M%S-"), dir=directory))
        self.verbose = verbose
        self.stage_name = "前置检查"
        self.sequence = 0
        self.completed = 0
        self.started = time.monotonic()

    @contextmanager
    def stage(self, name: str):
        self.stage_name = name
        started = time.monotonic()
        print(f"[开始] {name}", flush=True)
        yield
        self.completed += 1
        print(f"[完成] {name} ({time.monotonic() - started:.1f}s)", flush=True)

    def command(self, command: list[str], cwd: Path | None = None) -> Path:
        self.sequence += 1
        label = re.sub(r"[^\w.-]+", "-", self.stage_name).strip("-")
        log = self.directory / f"{self.sequence:03d}-{label}.log"
        with log.open("wb") as stream:
            if self.verbose:
                decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
                with subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
                    assert child.stdout is not None
                    while chunk := child.stdout.read(65536):
                        stream.write(chunk)
                        print(decoder.decode(chunk), end="", flush=True)
                    print(decoder.decode(b"", final=True), end="", flush=True)
                    code = child.wait()
            else:
                code = subprocess.run(command, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, check=False).returncode
        if code:
            raise InstallFailure(code, log)
        return log

    def capture(self, command: list[str]) -> str:
        log = self.command(command)
        with log.open("rb") as stream:
            data = stream.read(4097)
        if len(data) > 4096:
            raise InstallFailure(1, log)
        return data.decode("ascii").strip()

    def failure(self, exc: Exception) -> int:
        code = exc.code if isinstance(exc, InstallFailure) else 1
        log = exc.log if isinstance(exc, InstallFailure) else self.directory / "failure.log"
        try:
            if not isinstance(exc, InstallFailure):
                log.write_text(f"{type(exc).__name__}: {exc}\n", encoding="utf-8")
            tail = safe_tail(log)
        except OSError:
            tail = "[无法保存或读取失败日志，请检查日志目录权限和磁盘空间]"
        print(f"[失败] {self.stage_name}；退出码：{code}；耗时 {time.monotonic() - self.started:.1f}s；日志：{log}", file=sys.stderr)
        print(tail, file=sys.stderr)
        print("已停止；未完成安装验收。", file=sys.stderr)
        return code if code > 0 else 1


_REPORT: ContextVar[InstallerReport | None] = ContextVar("install_report", default=None)


def run(command: list[str], cwd: Path | None = None) -> None:
    reporter = _REPORT.get()
    if reporter is None:
        reporter = InstallerReport(HERE / ".cache" / "install-logs")
    reporter.command(command, cwd)


def portable_python(root: Path) -> Path:
    return root / "python_embeded" / "python.exe"


def git_head(repository: Path) -> str:
    reporter = _REPORT.get() or InstallerReport(HERE / ".cache" / "install-logs")
    return reporter.capture(["git", "-C", str(repository), "rev-parse", "HEAD"])


def install_nodes(comfy_dir: Path, python: Path) -> None:
    configure_utf8()
    custom_nodes = comfy_dir / "custom_nodes"
    custom_nodes.mkdir(parents=True, exist_ok=True)
    own_node = HERE / "comfy-nodes" / "h3_workbench_refine"
    target = custom_nodes / "h3_workbench_refine"
    shutil.copytree(own_node, target, dirs_exist_ok=True)
    print(f"已安装工作台专用节点：{target}")

    for directory, (repository, commit) in NODE_PACKAGES.items():
        destination = custom_nodes / directory
        if destination.exists():
            if not (destination / ".git").exists() or git_head(destination) != commit:
                raise RuntimeError(f"已有节点 {directory} 不是锁定提交 {commit}；已保留原目录，请手动核对后重试。")
            print(f"保留已锁定节点：{directory} @ {commit[:12]}")
        else:
            destination.mkdir()
            try:
                run(["git", "init", str(destination)])
                run(["git", "-C", str(destination), "remote", "add", "origin", repository])
                run(["git", "-C", str(destination), "fetch", "--depth", "1", "origin", commit])
                run(["git", "-C", str(destination), "checkout", "--detach", "FETCH_HEAD"])
                if git_head(destination) != commit:
                    raise RuntimeError(f"节点 {directory} 的提交校验失败。")
            except BaseException:
                shutil.rmtree(destination)
                raise
        requirements = destination / "requirements.txt"
        if requirements.is_file():
            run([str(python), "-m", "pip", "install", "-r", str(requirements)])


def main() -> int:
    configure_utf8()
    parser = argparse.ArgumentParser(description="安装 Refmuse 本地工作台、节点和前端")
    parser.add_argument("--comfy-root", type=Path, default=HERE.parent, help="ComfyUI 便携版根目录")
    parser.add_argument("--models-source", type=Path, help="可选：已下载并解压的模型包目录")
    parser.add_argument("--models-only", action="store_true", help="只安装模型；必须同时指定 --models-source")
    parser.add_argument("--profile", choices=("core-h3", "full"), default="core-h3", help="模型安装范围，默认核心七项")
    parser.add_argument("--verbose", action="store_true", help="同时在终端显示完整子进程输出（默认仅记录日志）")
    parser.add_argument("--log-dir", type=Path, default=HERE / ".cache" / "install-logs", help="安装日志父目录，每次运行创建独立子目录")
    parser.add_argument("--skip-nodes", action="store_true")
    parser.add_argument("--skip-python", action="store_true")
    parser.add_argument("--skip-frontend", action="store_true")
    args = parser.parse_args()
    if args.models_only and not args.models_source:
        parser.error("--models-only 必须同时指定 --models-source。")
    if args.models_only:
        args.skip_python = args.skip_nodes = args.skip_frontend = True

    root = args.comfy_root.resolve()
    comfy_dir = root / "ComfyUI"
    python = portable_python(root)

    try:
        reporter = InstallerReport(args.log_dir.resolve(), args.verbose)
    except OSError as exc:
        print(f"[失败] 无法创建安装日志：{str(exc)[:500]}", file=sys.stderr)
        return 1
    token = _REPORT.set(reporter)
    try:
        print(f"安装日志：{reporter.directory}", flush=True)
        with reporter.stage("前置检查"):
            if not (comfy_dir / "main.py").is_file():
                raise RuntimeError(f"没有找到 {comfy_dir / 'main.py'}；请传入 ComfyUI 便携版根目录。")
            if not python.is_file():
                raise RuntimeError(f"没有找到 ComfyUI 便携版 Python：{python}；不会回退系统 Python。")
            # Check every enabled tool before installing Python, nodes or models.
            if not args.skip_nodes:
                git = shutil.which("git")
                if not git:
                    raise RuntimeError("没有找到 Git，请先安装 Git 或手动安装节点。")
                reporter.capture([git, "--version"])
            npm = None
            if not args.skip_frontend:
                node = shutil.which("node") or shutil.which("node.exe")
                npm = shutil.which("npm") or shutil.which("npm.cmd")
                if not node or not npm:
                    raise RuntimeError("没有找到 Node.js / npm；请安装 Node.js 20.19+ 后重试。")
                version = reporter.capture([node, "-p", "process.versions.node"])
                if not re.fullmatch(r"\d+\.\d+\.\d+", version):
                    raise RuntimeError("无法解析 Node.js 版本；请检查前置检查日志。")
                parts = tuple(int(part) for part in version.split("."))
                if parts < (20, 19, 0):
                    raise RuntimeError(f"Node.js {version} 不受 Vite 7 支持；请升级到 20.19+。")
                reporter.capture([npm, "--version"])
        if not args.skip_python:
            with reporter.stage("Python 依赖（SHA256 锁定）"):
                run([str(python), "-m", "pip", "install", "--require-hashes", "-r", str(HERE / "requirements.lock")])
        if not args.skip_nodes:
            with reporter.stage("ComfyUI 节点"):
                install_nodes(comfy_dir, python)
        if args.models_source:
            with reporter.stage(f"模型安装（{args.profile}）"):
                run([
                    str(python), str(HERE / "scripts" / "install_models.py"),
                    str(args.models_source), "--comfy-root", str(root), "--profile", args.profile,
                ])
        if not args.skip_frontend:
            assert npm is not None
            with reporter.stage("前端依赖"):
                run([npm, "ci"], HERE)
            with reporter.stage("前端构建"):
                run([npm, "run", "build"], HERE)
        if os.name == "nt" and not args.models_only:
            with reporter.stage("桌面快捷方式与当前用户启动协议"):
                run([str(python), "-X", "utf8", str(HERE / "workbench_start.py"),
                     "--comfy-root", str(root), "register"], HERE)
        print(f"本次请求的步骤已完成（含前置检查 {reporter.completed} 阶段，{time.monotonic() - reporter.started:.1f}s）。")
        print("尚未运行工作台离线/在线验收；请运行 scripts/verify_workbench.py，并在服务就绪后加 --online。尚未安装所选模型时，不要把模型缺失当成画布程序安装失败。")
        print(f"Agent 安装完成后请先阅读：{HERE / 'docs' / 'AGENT_MANUAL.md'}")
        print(f"向用户说明各功能所需模型及体积：{HERE / 'docs' / 'MODEL_CATALOG.md'}")
        print("列出套装（不会下载）：python scripts/model_catalog.py list")
        if not args.models_source:
            print("本次只安装画布本体与 ComfyUI 依赖／节点／前端，未安装或校验模型。请先向用户说明套装与体积，得到明确同意后再下载。")
        print(f"完整日志：{reporter.directory}")
        return 0
    except (OSError, RuntimeError, ValueError, subprocess.SubprocessError) as exc:
        return reporter.failure(exc)
    finally:
        _REPORT.reset(token)


if __name__ == "__main__":
    configure_utf8()
    raise SystemExit(main())
