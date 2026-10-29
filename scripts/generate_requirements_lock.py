from __future__ import annotations

import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    pins = []
    for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            name, separator, version = line.partition("==")
            if not separator or not name or not version:
                raise ValueError(f"requirements.txt 只能包含 name==version：{line}")
            pins.append((name, version))
    output = [
        "# 由 scripts/generate_requirements_lock.py 生成，请勿手改。",
        "# 每个固定版本包含 PyPI 发布文件的 SHA256；更新时单独提交审查。",
        "--require-hashes",
        "",
    ]
    for name, version in pins:
        request = urllib.request.Request(f"https://pypi.org/pypi/{name}/{version}/json", headers={"User-Agent": "H3-Workbench-Lock-Generator/1"})
        with urllib.request.urlopen(request, timeout=30) as response:
            release = json.load(response)
        files = release.get("urls") or []
        if not files:
            raise RuntimeError(f"PyPI 未返回 {name}=={version} 的发布文件")
        hashes = sorted({item["digests"]["sha256"] for item in files})
        output.append(f"{name}=={version} \\")
        output.extend(f"    --hash=sha256:{digest} \\" for digest in hashes[:-1])
        output.append(f"    --hash=sha256:{hashes[-1]}")
        output.append("")
        print(f"locked {name}=={version}: {len(hashes)} hashes")
    (ROOT / "requirements.lock").write_text("\n".join(output), encoding="utf-8")


if __name__ == "__main__":
    main()
