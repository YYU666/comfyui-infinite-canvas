"""Check the Windows amd64 runtime zip and print its measured size and SHA-256."""
from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_update_package import verify_checksum  # noqa: E402


def assert_runtime(directory):
    directory = Path(directory)
    archives = sorted(path for path in directory.glob("refmuse-runtime-python-win-amd64-*.zip") if path.is_file())
    if len(archives) != 1:
        raise RuntimeError(f"需要恰好一份运行时 zip，实际 {len(archives)}")
    archive = archives[0]
    verify_checksum(archive, with_bytes=True)
    with zipfile.ZipFile(archive) as package:
        names = [info.filename.replace("\\", "/") for info in package.infolist()]
    if not any(name.endswith("runtime-manifest.json") for name in names):
        raise RuntimeError("运行时 zip 缺少 runtime-manifest.json。")
    if not any(name.endswith("python_embeded/pythonw.exe") for name in names):
        raise RuntimeError("运行时 zip 缺少 python_embeded/pythonw.exe。")
    if not any(name.endswith("LICENSES/PSF-LICENSE.txt") for name in names):
        raise RuntimeError("运行时 zip 缺少 LICENSES/PSF-LICENSE.txt。")
    data = archive.read_bytes()
    payload = {"archive": archive.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    print(json.dumps(payload, ensure_ascii=False))
    return payload


def main():
    if len(sys.argv) != 2:
        raise SystemExit("用法：python scripts/assert_runtime_evidence.py <目录>")
    assert_runtime(sys.argv[1])


if __name__ == "__main__":
    main()
