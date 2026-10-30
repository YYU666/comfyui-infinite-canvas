from __future__ import annotations

import argparse
import ast
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from workbench_update import asset_name, parse_version


def tracked_files():
    result = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError("无法读取 Git 跟踪文件，更新包未生成。")
    paths = sorted(item.decode("utf-8") for item in result.stdout.split(b"\0") if item)
    if not paths:
        raise RuntimeError("Git 跟踪文件为空，更新包未生成。")
    required = {"video_workbench_launcher.py", "workbench_update.py", "workbench_update_helper.py", "workbench_lifecycle.py", "package.json", "package-lock.json", "requirements.lock"}
    if not required.issubset(paths):
        raise RuntimeError("更新必需文件尚未纳入 Git，已阻止生成不完整升级包。")
    return paths


def build(tag, output):
    parse_version(tag)
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    tree = ast.parse((ROOT / "workbench_lifecycle.py").read_text(encoding="utf-8"))
    app_version = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == "APP_VERSION" for target in node.targets))
    if package.get("version") != tag.lstrip("v") or app_version != tag.lstrip("v"):
        raise RuntimeError("package.json、APP_VERSION 与 Release 标签必须完全一致。")
    files = []
    contents = {}
    for relative in tracked_files():
        path = ROOT.joinpath(*relative.split("/"))
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"更新包不允许符号链接或非普通文件：{relative}")
        data = path.read_bytes()
        contents[relative] = data
        files.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest()})
    manifest = json.dumps({"format": 1, "version": tag, "files": files}, ensure_ascii=False, indent=2).encode("utf-8")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / asset_name(tag)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package_zip:
        for relative, data in contents.items():
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            package_zip.writestr(info, data)
        info = zipfile.ZipInfo("release-files.json", date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        package_zip.writestr(info, manifest)
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = archive.with_name(archive.name + ".sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="ascii", newline="\n")
    print(json.dumps({"archive": str(archive), "checksum": str(checksum), "files": len(files), "bytes": archive.stat().st_size}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="构建带逐文件清单和 SHA256 的 Refmuse 安全更新包。")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, default=ROOT / ".release")
    arguments = parser.parse_args()
    build(arguments.tag, arguments.output.resolve())


if __name__ == "__main__":
    main()
