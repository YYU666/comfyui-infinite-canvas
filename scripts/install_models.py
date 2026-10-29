from __future__ import annotations

import argparse
import json
import os
import shutil
from pathlib import Path, PurePosixPath

try:
    from .verify_workbench import file_sha256, select_model_files
except ImportError:
    from verify_workbench import file_sha256, select_model_files

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


def matches_manifest(item: dict, path: Path) -> bool:
    if not path.is_file() or path.stat().st_size != item["bytes"]:
        return False
    expected = item.get("sha256")
    return expected is None or file_sha256(path) == expected


def main() -> int:
    parser = argparse.ArgumentParser(description="校验并复制 H3 工作台模型包")
    parser.add_argument("source", type=Path, help="模型包根目录，下面应包含 diffusion_models、loras 等")
    parser.add_argument("--comfy-root", type=Path, default=HERE.parents[1], help="ComfyUI 便携版根目录")
    parser.add_argument("--profile", choices=("core-h3", "full"), default="full", help="默认处理完整模型库；核心安装使用 core-h3")
    parser.add_argument("--link", action="store_true", help="同盘使用硬链接，不复制实际字节")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-only", action="store_true", help="只校验模型包，不复制")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    files = select_model_files(manifest, args.profile)
    source_root = package_root(args.source)
    target_root = args.comfy_root.resolve() / "ComfyUI" / "models"
    missing: list[str] = []
    mismatched: list[str] = []
    conflicts: list[str] = []
    copied = 0
    skipped = 0

    for item in files:
        relative = safe_relative(item["path"])
        source = source_root / relative
        target = target_root / relative
        if not source.is_file():
            missing.append(item["path"])
            continue
        if not matches_manifest(item, source):
            mismatched.append(item["path"])
            continue
        if args.verify_only:
            continue
        if target.exists() or target.is_symlink():
            if not target.is_symlink() and matches_manifest(item, target):
                skipped += 1
            else:
                conflicts.append(item["path"])
            continue
        print(f"{'硬链接' if args.link else '复制'}：{item['path']}")
        if not args.dry_run:
            target.parent.mkdir(parents=True, exist_ok=True)
            if args.link:
                # 目标必须始终不存在；链接失败也不能删除或覆盖已有文件。
                os.link(source, target)
            else:
                temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
                try:
                    shutil.copy2(source, temporary)
                    if not matches_manifest(item, temporary):
                        raise OSError(f"复制后大小或 SHA256 校验失败：{item['path']}")
                    # 同目录硬链接发布是原子的，并在目标被并发创建时拒绝覆盖。
                    os.link(temporary, target)
                finally:
                    temporary.unlink(missing_ok=True)
        copied += 1

    print(f"配置：{args.profile}；清单：{len(files)}；本次处理：{copied}；已存在：{skipped}；缺失：{len(missing)}；大小或哈希不符：{len(mismatched)}；目标冲突：{len(conflicts)}")
    for name in missing:
        print(f"缺失：{name}")
    for name in mismatched:
        print(f"大小或 SHA256 不符：{name}")
    for name in conflicts:
        print(f"目标已存在且不一致，未修改：{name}")
    return 1 if missing or mismatched or conflicts else 0


if __name__ == "__main__":
    raise SystemExit(main())
