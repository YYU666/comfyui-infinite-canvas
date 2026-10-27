from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

NODE_PACKAGES = {
    "h3-relay": "https://github.com/akatz-ai/h3-relay.git",
    "ComfyUI-KJNodes": "https://github.com/kijai/ComfyUI-KJNodes.git",
    "comfyui-krea2edit": "https://github.com/lbouaraba/comfyui-krea2edit.git",
    "ComfyUI-Inpaint-CropAndStitch": "https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch.git",
    "Comfyui_Minimax_h3_latent_Upscaler": "https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git",
    "ComfyUI-Spectrum-MOSS": "https://github.com/Rkkss/ComfyUI-Spectrum-MOSS.git",
}


def run(command: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(str(part) for part in command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def portable_python(root: Path) -> Path:
    embedded = root / "python_embeded" / "python.exe"
    return embedded if embedded.is_file() else Path(sys.executable)


def install_nodes(comfy_dir: Path, python: Path) -> None:
    custom_nodes = comfy_dir / "custom_nodes"
    custom_nodes.mkdir(parents=True, exist_ok=True)
    own_node = HERE / "comfy-nodes" / "h3_workbench_refine"
    target = custom_nodes / "h3_workbench_refine"
    shutil.copytree(own_node, target, dirs_exist_ok=True)
    print(f"已安装工作台专用节点：{target}")

    for directory, repository in NODE_PACKAGES.items():
        destination = custom_nodes / directory
        if destination.exists():
            print(f"保留已有节点：{directory}")
        else:
            run(["git", "clone", "--depth", "1", repository, str(destination)])
        requirements = destination / "requirements.txt"
        if requirements.is_file():
            run([str(python), "-m", "pip", "install", "-r", str(requirements)])


def main() -> int:
    parser = argparse.ArgumentParser(description="安装 H3 视频工作台、节点和前端")
    parser.add_argument("--comfy-root", type=Path, default=HERE.parent, help="ComfyUI 便携版根目录")
    parser.add_argument("--models-source", type=Path, help="可选：已下载并解压的模型包目录")
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
        parser.error("没有找到可用 Python。")

    if not args.skip_python:
        run([str(python), "-m", "pip", "install", "-r", str(HERE / "requirements.txt")])
    if not args.skip_nodes:
        if not shutil.which("git"):
            parser.error("没有找到 Git，请先安装 Git 或手动安装节点。")
        install_nodes(comfy_dir, python)
    if args.models_source:
        run([
            str(python), str(HERE / "scripts" / "install_models.py"),
            str(args.models_source), "--comfy-root", str(root),
        ])
    if not args.skip_frontend:
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if not npm:
            parser.error("没有找到 Node.js / npm；请安装 Node.js 20+ 后重试。")
        run([npm, "ci"], HERE)
        run([npm, "run", "build"], HERE)

    print("\n安装完成。双击 start.bat 启动；模型可用 scripts/verify_workbench.py 再次校验。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(f"\n安装命令失败，退出码：{exc.returncode}", file=sys.stderr)
        raise SystemExit(exc.returncode) from exc
