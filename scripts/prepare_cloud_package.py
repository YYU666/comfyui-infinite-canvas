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


def locate(roots: list[Path], relative: Path, expected_size: int) -> Path | None:
    for root in roots:
        direct = root / relative
        if direct.is_file() and direct.stat().st_size == expected_size:
            return direct
    for root in roots:
        for candidate in root.rglob(relative.name):
            if candidate.is_file() and candidate.stat().st_size == expected_size:
                return candidate
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="按 ComfyUI 目录生成统一网盘上传目录")
    parser.add_argument("--model-root", type=Path, action="append", required=True, help="本机模型根目录，可重复传入")
    parser.add_argument("--output", type=Path, required=True, help="输出目录；建议放在空间充足的磁盘")
    parser.add_argument("--mode", choices=["hardlink", "copy"], default="hardlink")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    roots = [path.resolve() for path in args.model_root]
    output = args.output.resolve()
    missing: list[str] = []
    total = 0
    for item in manifest["files"]:
        relative = safe_relative(item["path"])
        source = locate(roots, relative, item["bytes"])
        if not source:
            missing.append(item["path"])
            continue
        total += item["bytes"]
        target = output / relative
        print(f"{item['path']} <- {source}")
        if args.dry_run:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and target.stat().st_size == item["bytes"]:
            continue
        if args.mode == "hardlink":
            try:
                os.link(source, target)
            except OSError as exc:
                raise RuntimeError(f"硬链接失败：{source} -> {target}。跨盘时请改用 --mode copy。") from exc
        else:
            shutil.copy2(source, target)

    print(f"已匹配 {len(manifest['files']) - len(missing)}/{len(manifest['files'])}，{total / 1024**3:.3f} GiB；缺失 {len(missing)}")
    for name in missing:
        print(f"缺失：{name}")
    if not args.dry_run and not missing:
        output.mkdir(parents=True, exist_ok=True)
        shutil.copy2(MANIFEST, output / "manifest.json")
        print(f"上传这个总目录即可：{output}")
    return 1 if missing else 0


if __name__ == "__main__":
    raise SystemExit(main())
