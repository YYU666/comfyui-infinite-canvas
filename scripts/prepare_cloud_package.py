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
LICENSES = HERE.parent / "models" / "licenses.json"


def safe_relative(value: str) -> Path:
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts or not pure.parts:
        raise ValueError(f"不安全的模型路径：{value}")
    return Path(*pure.parts)


def locate(roots: list[Path], relative: Path, expected_size: int, expected_hash: str | None = None) -> Path | None:
    def matches(candidate):
        return (candidate.is_file() and candidate.stat().st_size == expected_size
                and (expected_hash is None or file_sha256(candidate) == expected_hash))

    for root in roots:
        direct = root / relative
        if matches(direct):
            return direct
    for root in roots:
        for candidate in root.rglob(relative.name):
            if matches(candidate):
                return candidate
    return None


def license_assignments(values, files):
    assignments = {}
    for value in values or []:
        model_path, separator, license_path = value.partition("=")
        model_path = model_path.strip().replace("\\", "/")
        if not separator or not model_path or not license_path.strip():
            raise ValueError("--license-file 必须使用 模型相对路径=许可文本路径 格式。")
        if model_path in assignments:
            raise ValueError(f"重复指定许可文本：{model_path}")
        assignments[model_path] = Path(license_path.strip()).resolve()
    known = {item["path"] for item in files}
    unknown = sorted(set(assignments) - known)
    if unknown:
        raise ValueError(f"许可文本对应了清单外文件：{', '.join(unknown)}")
    return assignments


def publish_file(source, target, mode, expected_size):
    if target.exists() or target.is_symlink():
        if target.is_file() and not target.is_symlink() and target.stat().st_size == expected_size:
            return
        raise RuntimeError(f"目标已存在且不一致，未覆盖：{target}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if mode == "hardlink":
        try:
            os.link(source, target)
        except OSError as exc:
            raise RuntimeError(f"硬链接失败：{source} -> {target}。跨盘时请改用 --mode copy。") from exc
        return
    temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        shutil.copy2(source, temporary)
        if temporary.stat().st_size != expected_size:
            raise RuntimeError(f"复制后大小不一致：{target}")
        os.link(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def distribution_notice(files, inventory, license_targets):
    lines = [
        "# 公开分发许可与义务", "",
        "本目录由公开分发模式生成。每个模型仍受各自作者条款约束；本通知不授予额外权利。",
        "上传前必须由分发者逐条复核限制、署名、地区、商用和生成内容披露义务。", "",
    ]
    for index, item in enumerate(files, 1):
        record = inventory[item["path"]]
        lines.extend([
            f"## {index}. `{item['path']}`", "",
            f"- 作者：{record['authors']}",
            f"- 许可证：{record['license']}",
            f"- 官方页面：{record['officialPage']}",
            f"- 许可来源：{record['licenseUrl']}",
            f"- 随附许可文本：`licenses/{license_targets[item['path']].name}`",
            f"- 再分发状态：{record['redistribution']}",
            f"- 限制与义务：{record['restrictions']}", "",
        ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="整理本地模型目录，或在许可校验后生成公开分发目录")
    parser.add_argument("--model-root", type=Path, action="append", required=True, help="本机模型根目录，可重复传入")
    parser.add_argument("--output", type=Path, required=True, help="输出目录；建议放在空间充足的磁盘")
    parser.add_argument("--mode", choices=["hardlink", "copy"], default="hardlink")
    parser.add_argument("--purpose", choices=["local", "public"], default="local", help="默认仅本地整理；public 执行公开分发门禁")
    parser.add_argument("--profile", choices=["core-h3", "full"], default="full")
    parser.add_argument("--license-file", action="append", help="公开模式必填：模型相对路径=实际许可文本路径，可重复传入")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    files = select_model_files(manifest, args.profile)
    roots = [path.resolve() for path in args.model_root]
    output = args.output.resolve()
    assignments = license_assignments(args.license_file, files)
    if args.purpose == "local" and assignments:
        parser.error("--license-file 仅用于 --purpose public。")

    inventory_document = json.loads(LICENSES.read_text(encoding="utf-8"))
    inventory = {item["path"]: item for item in inventory_document["files"]}
    blocked = []
    missing_licenses = []
    if args.purpose == "public":
        for item in files:
            record = inventory.get(item["path"])
            if not record or record["redistribution"] not in {"allowed", "conditional"}:
                blocked.append(item["path"])
            if item["path"] not in assignments or not assignments[item["path"]].is_file():
                missing_licenses.append(item["path"])
    if blocked or missing_licenses:
        for name in blocked:
            print(f"禁止公开分发（未知或未确认允许）：{name}")
        for name in missing_licenses:
            print(f"缺少实际许可文本：{name}")
        print("公开分发预检失败，未写入任何文件。")
        return 2

    sources = {}
    missing = []
    total = 0
    for item in files:
        relative = safe_relative(item["path"])
        source = locate(roots, relative, item["bytes"], item.get("sha256") if args.purpose == "public" else None)
        if not source:
            missing.append(item["path"])
            continue
        sources[item["path"]] = source
        total += item["bytes"]
        print(f"{item['path']} <- {source}")
    if missing:
        print(f"已匹配 {len(sources)}/{len(files)}，{total / 1024**3:.3f} GiB；缺失或校验不符 {len(missing)}")
        for name in missing:
            print(f"缺失或校验不符：{name}")
        print("未生成完成的分发目录。")
        return 1

    license_targets = {}
    if not args.dry_run:
        for index, item in enumerate(files, 1):
            publish_file(sources[item["path"]], output / safe_relative(item["path"]), args.mode, item["bytes"])
        selected_manifest = {key: value for key, value in manifest.items() if key not in {"files", "profiles", "fileCount", "totalBytes", "totalGiB"}}
        selected_manifest.update({"fileCount": len(files), "totalBytes": total, "totalGiB": round(total / 1024**3, 3), "files": files})
        output.mkdir(parents=True, exist_ok=True)
        (output / "manifest.json").write_text(json.dumps(selected_manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        if args.purpose == "public":
            for index, item in enumerate(files, 1):
                suffix = assignments[item["path"]].suffix or ".txt"
                target = output / "licenses" / f"{index:02d}{suffix}"
                publish_file(assignments[item["path"]], target, "copy", assignments[item["path"]].stat().st_size)
                license_targets[item["path"]] = target
            shutil.copy2(LICENSES, output / "licenses.json")
            (output / "DISTRIBUTION_NOTICE.md").write_text(distribution_notice(files, inventory, license_targets), encoding="utf-8")

    print(f"已匹配 {len(files)}/{len(files)}，{total / 1024**3:.3f} GiB；范围：{args.profile}；用途：{args.purpose}")
    if args.dry_run:
        print("预检通过，未写入文件。")
    elif args.purpose == "public":
        print(f"公开分发目录及许可文本已生成：{output}；上传前仍须人工复核 DISTRIBUTION_NOTICE.md。")
    else:
        print(f"本地整理完成：{output}；这不代表获得公开上传或再分发权限。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
