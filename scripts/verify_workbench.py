from __future__ import annotations

import argparse
import hashlib
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
    if pure.is_absolute() or ".." in pure.parts or not pure.parts:
        raise ValueError(value)
    return Path(*pure.parts)


def select_model_files(manifest: dict, profile: str = "full") -> list[dict]:
    profiles = manifest.get("profiles", {})
    if profile == "full" and not profiles:
        return list(manifest["files"])
    if profile not in profiles:
        raise ValueError(f"未知模型配置：{profile}")
    selection = profiles[profile]
    if selection.get("include") == "all":
        return list(manifest["files"])
    by_path = {item["path"]: item for item in manifest["files"]}
    selected = []
    for path in selection.get("files", []):
        if path not in by_path:
            raise ValueError(f"模型配置 {profile} 引用了不存在的文件：{path}")
        selected.append(by_path[path])
    if not selected:
        raise ValueError(f"模型配置 {profile} 为空")
    return selected


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_model_files(files: list[dict], model_roots: list[Path]):
    problems: list[str] = []
    pending_hashes: list[str] = []
    verified_hashes = 0
    for item in files:
        relative = safe_relative(item["path"])
        candidates = [path / relative for path in model_roots]
        existing = [path for path in candidates if path.is_file()]
        if not existing:
            problems.append(f"模型缺失：{item['path']}")
            continue
        sized = [path for path in existing if path.stat().st_size == item["bytes"]]
        if not sized:
            problems.append(f"模型大小不符：{item['path']}")
            continue
        expected = item.get("sha256")
        if expected is None:
            pending_hashes.append(item["path"])
            continue
        if not re.fullmatch(r"[0-9a-f]{64}", expected):
            raise ValueError(f"模型 SHA256 格式无效：{item['path']}")
        if not any(file_sha256(path) == expected for path in sized):
            problems.append(f"模型 SHA256 不符：{item['path']}")
        else:
            verified_hashes += 1
    return problems, verified_hashes, pending_hashes


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 Refmuse 本地工作台模型、节点和前端")
    parser.add_argument("--comfy-root", type=Path, default=ROOT.parent)
    parser.add_argument("--model-root", type=Path, action="append", help="默认检查 ComfyUI/models；有多个模型目录时可重复传入")
    parser.add_argument("--profile", choices=("core-h3", "full"), default="full", help="core-h3 只检查七个核心视频权重；full 检查完整可选模型库")
    parser.add_argument("--manifest", type=Path, default=ROOT / "models" / "manifest.json", help=argparse.SUPPRESS)
    parser.add_argument("--online", action="store_true", help="同时查询运行中的 ComfyUI 节点注册情况")
    args = parser.parse_args()

    root = args.comfy_root.resolve()
    comfy_dir = root / "ComfyUI"
    model_roots = [path.resolve() for path in (args.model_root or [comfy_dir / "models"])]
    model_roots = [path / "models" if (path / "models" / "diffusion_models").is_dir() else path for path in model_roots]
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    files = select_model_files(manifest, args.profile)
    problems, verified_hashes, pending_hashes = verify_model_files(files, model_roots)

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

    total_bytes = sum(item["bytes"] for item in files)
    print(f"模型目录：{'; '.join(str(path) for path in model_roots)}")
    print(f"模型配置：{args.profile}；{len(files)} 个，{total_bytes / 1024 ** 3:.3f} GiB")
    print(f"SHA256：已登记并核实 {verified_hashes} 个；待核实 {len(pending_hashes)} 个（这些文件仅校验了字节数）")
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for problem in problems:
            print(problem)
        return 1
    print("校验通过：所选模型、节点目录和前端构建均已就绪。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
