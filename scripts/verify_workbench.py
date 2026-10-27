from __future__ import annotations

import argparse
import json
import re
import urllib.request
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
NODE_DIRS = [
    "h3_workbench_refine",
    "h3-relay",
    "ComfyUI-KJNodes",
    "comfyui-krea2edit",
    "ComfyUI-Inpaint-CropAndStitch",
    "Comfyui_Minimax_h3_latent_Upscaler",
    "ComfyUI-Spectrum-MOSS",
]


def safe_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts:
        raise ValueError(value)
    return Path(*pure.parts)


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 H3 工作台模型、节点和前端")
    parser.add_argument("--comfy-root", type=Path, default=ROOT.parent)
    parser.add_argument("--model-root", type=Path, action="append", help="默认检查 ComfyUI/models；有多个模型目录时可重复传入")
    parser.add_argument("--online", action="store_true", help="同时查询运行中的 ComfyUI 节点注册情况")
    args = parser.parse_args()

    root = args.comfy_root.resolve()
    comfy_dir = root / "ComfyUI"
    model_roots = [path.resolve() for path in (args.model_root or [comfy_dir / "models"])]
    model_roots = [path / "models" if (path / "models" / "diffusion_models").is_dir() else path for path in model_roots]
    manifest = json.loads((ROOT / "models" / "manifest.json").read_text(encoding="utf-8"))
    problems: list[str] = []

    for item in manifest["files"]:
        relative = safe_relative(item["path"])
        candidates = [path / relative for path in model_roots]
        if not any(path.is_file() for path in candidates):
            problems.append(f"模型缺失：{item['path']}")
        elif not any(path.is_file() and path.stat().st_size == item["bytes"] for path in candidates):
            problems.append(f"模型大小不符：{item['path']}")

    for name in NODE_DIRS:
        if not (comfy_dir / "custom_nodes" / name).is_dir():
            problems.append(f"节点目录缺失：{name}")
    if not (ROOT / "dist" / "index.html").is_file():
        problems.append("前端尚未构建：请运行 npm ci && npm run build")

    if args.online:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8188/object_info", timeout=10) as response:
                object_info = json.load(response)
            source = (ROOT / "src" / "workbench-api.js").read_text(encoding="utf-8")
            required = set(re.findall(r"class_type:\s*['\"]([^'\"]+)", source))
            for name in sorted(required - set(object_info)):
                problems.append(f"运行中的 ComfyUI 未注册节点：{name}")
        except OSError as exc:
            problems.append(f"无法连接 ComfyUI：{exc}")

    print(f"模型目录：{'; '.join(str(path) for path in model_roots)}")
    print(f"模型清单：{len(manifest['files'])} 个，{manifest['totalGiB']:.3f} GiB")
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for problem in problems:
            print(problem)
        return 1
    print("校验通过：模型、节点目录和前端构建均已就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
