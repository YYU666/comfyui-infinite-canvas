"""Check unsigned CI zips: update excludes dist, portable includes dist/index.html."""
from __future__ import annotations

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_update_package import verify_checksum  # noqa: E402


def _names(path):
    with zipfile.ZipFile(path) as package:
        return [info.filename.replace("\\", "/") for info in package.infolist()]


def assert_packages(directory):
    directory = Path(directory)
    updates = sorted(directory.glob("refmuse-update-*.zip"))
    portables = sorted(directory.glob("refmuse-portable-*.zip"))
    if len(updates) != 1 or len(portables) != 1:
        raise RuntimeError(f"需要各一份更新包和便携包，实际 update={len(updates)} portable={len(portables)}")
    update_names = _names(updates[0])
    portable_names = _names(portables[0])
    if any(name.startswith("dist/") or name == "dist" for name in update_names):
        raise RuntimeError("更新包不得包含 dist。")
    if any(name.startswith("node_modules/") or "/credentials" in name or name.endswith("instance.json") for name in update_names + portable_names):
        raise RuntimeError("安装包包含依赖目录、凭据或实例文件。")
    if "dist/index.html" not in portable_names:
        raise RuntimeError("便携包缺少 dist/index.html。")
    if any("python_embeded/" in name or name.endswith("python.exe") or name.endswith("pythonw.exe") for name in portable_names):
        raise RuntimeError("便携包不得包含 Python 运行时。")
    verify_checksum(updates[0], with_bytes=False)
    verify_checksum(portables[0], with_bytes=True)
    print(f"package evidence ok update={updates[0].name} portable={portables[0].name} portable_bytes={portables[0].stat().st_size}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("用法：python scripts/assert_package_evidence.py <目录>")
    assert_packages(sys.argv[1])


if __name__ == "__main__":
    main()
