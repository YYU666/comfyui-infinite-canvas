from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
MANIFEST = HERE.parent / "models" / "manifest.json"


def safe_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts or not pure.parts:
        raise ValueError(f"不安全的模型路径：{value}")
    return Path(*pure.parts)


def package_root(value: Path) -> Path:
    value = value.resolve()
    return value / "models" if (value / "models" / "diffusion_models").is_dir() else value


def main() -> int:
    parser = argparse.ArgumentParser(description="校验并复制 H3 工作台模型包")
    parser.add_argument("source", type=Path, help="模型包根目录，下面应包含 diffusion_models、loras 等")
    parser.add_argument("--comfy-root", type=Path, default=HERE.parents[1], help="ComfyUI 便携版根目录")
    parser.add_argument("--link", action="store_true", help="同盘使用硬链接，不复制实际字节")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-only", action="store_true", help="只校验模型包，不复制")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    source_root = package_root(args.source)
    target_root = args.comfy_root.resolve() / "ComfyUI" / "models"
    missing: list[str] = []
    mismatched: list[str] = []
    copied = 0
    skipped = 0

    for item in manifest["files"]:
        relative = safe_relative(item["path"])
        source = source_root / relative
        target = target_root / relative
        if not source.is_file():
            missing.append(item["path"])
            continue
        if source.stat().st_size != item["bytes"]:
            mismatched.append(item["path"])
            continue
        if args.verify_only:
            continue
        if target.is_file() and target.stat().st_size == item["bytes"]:
            skipped += 1
            continue
        print(f"{'硬链接' if args.link else '复制'}：{item['path']}")
        if not args.dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            if args.link:
                if target.exists():
                    target.unlink()
                os.link(source, target)
            else:
                shutil.copy2(source, target)
        copied += 1

    print(f"清单：{len(manifest['files'])}；本次处理：{copied}；已存在：{skipped}；缺失：{len(missing)}；大小不符：{len(mismatched)}")
    for name in missing:
        print(f"缺失：{name}")
    for name in mismatched:
        print(f"大小不符：{name}")
    return 1 if missing or mismatched else 0


if __name__ == "__main__":
    raise SystemExit(main())
