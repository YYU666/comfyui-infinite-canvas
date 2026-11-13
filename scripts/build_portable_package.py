"""Build refmuse-portable-<tag>.zip: public sources plus a CI-built dist/.

The update zip stays a source overlay and still rejects dist/. This package is
the only archive an engine may extract into an empty official directory.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from build_update_package import (  # noqa: E402
    assert_public_path,
    assert_release_tag,
    tracked_files,
    write_checksum,
    write_deterministic_zip,
)


def portable_asset_name(tag):
    return f"refmuse-portable-{tag}.zip"


def assert_portable_dist_path(relative):
    """Allow only real files under dist/. Every other private rule still applies."""
    normalized = relative.replace("\\", "/")
    if not normalized.startswith("dist/") or normalized.endswith("/") or ".." in normalized.split("/"):
        raise RuntimeError(f"便携包只额外包含 dist/ 下的构建文件：{relative}")
    # Judge the remainder with the update-package gate so dist cannot smuggle secrets.
    assert_public_path("public-build/" + normalized[len("dist/"):])


def dist_members(dist_dir):
    root = Path(dist_dir)
    index = root / "index.html"
    if not index.is_file() or index.is_symlink():
        raise RuntimeError("便携包必须包含已构建的 dist/index.html。请先用 Node 22 执行 npm ci && npm run build。")
    members = {}
    for path in sorted(root.rglob("*")):
        relative = "dist/" + path.relative_to(root).as_posix()
        if path.is_symlink():
            raise RuntimeError(f"便携包不允许符号链接：{relative}")
        if not path.is_file():
            continue
        assert_portable_dist_path(relative)
        members[relative] = path.read_bytes()
    if "dist/index.html" not in members:
        raise RuntimeError("便携包必须包含 dist/index.html。")
    return members


def build_portable(tag, output, dist_dir):
    assert_release_tag(tag)
    output = Path(output)
    contents = {}
    for relative in tracked_files():
        assert_public_path(relative)
        path = ROOT.joinpath(*relative.split("/"))
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"便携包不允许符号链接或非普通文件：{relative}")
        contents[relative] = path.read_bytes()
    extra = dist_members(dist_dir)
    overlap = set(contents).intersection(extra)
    if overlap:
        raise RuntimeError(f"便携包的 dist 与公开源码冲突：{sorted(overlap)[0]}")
    contents.update(extra)
    files = [{"path": relative, "sha256": hashlib.sha256(data).hexdigest()} for relative, data in contents.items()]
    manifest = json.dumps({"format": 1, "package": "refmuse-portable", "version": tag, "files": files}, ensure_ascii=False, indent=2).encode("utf-8")
    archive = output / portable_asset_name(tag)
    write_deterministic_zip(archive, {**contents, "release-files.json": manifest})
    checksum = write_checksum(archive, with_bytes=True)
    print(json.dumps({
        "archive": str(archive),
        "checksum": str(checksum),
        "files": len(files),
        "bytes": archive.stat().st_size,
        "distIndex": "dist/index.html" in contents,
    }, ensure_ascii=False))
    return archive, checksum


def main():
    import argparse

    parser = argparse.ArgumentParser(description="构建带 dist/index.html 与 SHA256+字节数的 Refmuse 便携安装包。")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--dist", type=Path, default=ROOT / "dist")
    parser.add_argument("--output", type=Path, default=ROOT / ".release")
    arguments = parser.parse_args()
    build_portable(arguments.tag, arguments.output.resolve(), arguments.dist.resolve())


if __name__ == "__main__":
    main()
