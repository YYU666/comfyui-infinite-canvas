from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

from agent_io import configure_utf8

HERE = Path(__file__).resolve().parent

NODE_PACKAGES = {
    "h3-relay": ("https://github.com/akatz-ai/h3-relay.git", "e2a7665b6eb8ea37a88c0de2c9c6b69a8f7c9220"),
    "ComfyUI-KJNodes": ("https://github.com/kijai/ComfyUI-KJNodes.git", "b5316a9e247338dc1460df8e4d01e906c566299c"),
    "comfyui-krea2edit": ("https://github.com/lbouaraba/comfyui-krea2edit.git", "13ef60f20828949becada815d3cbc371eb5ccaab"),
    "ComfyUI-Inpaint-CropAndStitch": ("https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch.git", "6005efc02f7745649118edd89cdd084c2b9bd3ae"),
    "Comfyui_Minimax_h3_latent_Upscaler": ("https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git", "40316cf008b2fd8663263270669eb4da23f89d2c"),
    "ComfyUI-Spectrum-MOSS": ("https://github.com/Rkkss/ComfyUI-Spectrum-MOSS.git", "1e5eb359160b50be02ff95d1a93f22af2947888c"),
}


def run(command: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def portable_python(root: Path) -> Path:
    return root / "python_embeded" / "python.exe"


def git_head(repository: Path) -> str:
    return subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True, encoding="ascii").strip()


def install_nodes(comfy_dir: Path, python: Path) -> None:
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
    parser = argparse.ArgumentParser(description="安装 Refmuse 本地工作台、节点和前端")
    parser.add_argument("--comfy-root", type=Path, default=HERE.parent, help="ComfyUI 便携版根目录")
    parser.add_argument("--models-source", type=Path, help="可选：已下载并解压的模型包目录")
    parser.add_argument("--profile", choices=("core-h3", "full"), default="core-h3", help="模型安装范围，默认核心七项")
    parser.add_argument("--skip-nodes", action="store_true")
    parser.add_argument("--skip-python", action="store_true")
    parser.add_argument("--skip-frontend", action="store_true")
    args = parser.parse_args()

    root = args.comfy_root.resolve()
    comfy_dir = root / "ComfyUI"
    if not (comfy_dir / "main.py").is_file():
        parser.error(f"没有找到 {comfy_dir / 'main.py'}；请传入 ComfyUI 便携版根目录。")
    python = portable_python(root)
    if not python.is_file():
        parser.error(f"没有找到 ComfyUI 便携版 Python：{python}；不会回退系统 Python。")

    if not args.skip_python:
        run([str(python), "-m", "pip", "install", "--require-hashes", "-r", str(HERE / "requirements.lock")])
    if not args.skip_nodes:
        if not shutil.which("git"):
            parser.error("没有找到 Git，请先安装 Git 或手动安装节点。")
        install_nodes(comfy_dir, python)
    if args.models_source:
        run([
            str(python), str(HERE / "scripts" / "install_models.py"),
            str(args.models_source), "--comfy-root", str(root), "--profile", args.profile,
        ])
    if not args.skip_frontend:
        node = shutil.which("node") or shutil.which("node.exe")
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not node or not npm:
            parser.error("没有找到 Node.js / npm；请安装 Node.js 20.19+ 后重试。")
        version = subprocess.check_output([node, "-p", "process.versions.node"], text=True, encoding="ascii").strip()
        parts = tuple(int(part) for part in version.split("."))
        if parts < (20, 19, 0):
            parser.error(f"Node.js {version} 不受 Vite 7 支持；请升级到 20.19+。")
        run([npm, "ci"], HERE)
        run([npm, "run", "build"], HERE)

    print("\n安装完成。双击 启动.vbs 启动；模型可用 scripts/verify_workbench.py 再次校验。")
    return 0


if __name__ == "__main__":
    configure_utf8()
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"\n安装命令失败，退出码：{exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode) from exc
