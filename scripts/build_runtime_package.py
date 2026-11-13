"""Build the Windows amd64 CPython runtime zip. Not part of refmuse-update-*.

The zip is a Release/CI artifact. It is never committed. macOS is detect-only:
this script refuses to claim or emit a Mac runtime.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from build_update_package import write_checksum, write_deterministic_zip  # noqa: E402

# Last CPython 3.12 release that publishes an official Windows embeddable zip.
# 3.12.11 and later are source-only (PEP 693). CI/release workflows still select
# the 3.12 line via actions/setup-python; this pin is the official embed binary.
PYTHON_VERSION = "3.12.10"
EMBED_NAME = f"python-{PYTHON_VERSION}-embed-amd64.zip"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{EMBED_NAME}"
EMBED_SPDX_URL = EMBED_URL + ".spdx.json"
EMBED_BYTES = 11133606
# SHA-256 of the embed zip, matched to the downloaded bytes and to the CPython
# package entry in the official SPDX document above (checked 2026-11-13).
EMBED_SHA256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3"
GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"
GET_PIP_BYTES = 2397294
GET_PIP_SHA256 = "356e0d0de21cdc348c3394084d90939b85e4246c4d14c76aee6ca4f46646ea98"
PACKAGE_ID = "refmuse-runtime-python-win-amd64"


def lock_sha256():
    return hashlib.sha256((ROOT / "requirements.lock").read_bytes()).hexdigest()


def runtime_identity(lock_digest=None):
    digest = lock_digest or lock_sha256()
    return f"{PACKAGE_ID}-{PYTHON_VERSION}-{digest[:12]}"


def runtime_asset_name():
    return f"{PACKAGE_ID}-{PYTHON_VERSION}.zip"


def host_can_build():
    return platform.system() == "Windows" and platform.machine().lower() in {"amd64", "x86_64"}


def runtime_support():
    return {
        "bundledRuntime": "win-amd64",
        "python": PYTHON_VERSION,
        "host": f"{platform.system()}-{platform.machine()}",
        "mac": "detect-only",
        "canBuildHere": host_can_build(),
    }


def recipe():
    return {
        "package": PACKAGE_ID,
        "asset": runtime_asset_name(),
        "identity": runtime_identity(),
        "python": PYTHON_VERSION,
        "platform": "win-amd64",
        "embed": {
            "url": EMBED_URL,
            "bytes": EMBED_BYTES,
            "sha256": EMBED_SHA256,
            "spdx": EMBED_SPDX_URL,
            "verification": "下载后先比较字节数，再比较 SHA-256 与本配方以及官方 SPDX 中 CPython 包的 checksumValue。不一致则删除，不解压。",
        },
        "getPip": {"url": GET_PIP_URL, "bytes": GET_PIP_BYTES, "sha256": GET_PIP_SHA256},
        "requirementsLock": "requirements.lock",
        "requirementsLockSha256": lock_sha256(),
        "install": "enable site in python312._pth, then python.exe get-pip.py, then python.exe -m pip install --require-hashes -r requirements.lock",
        "layout": {
            "h3ComfyRoot": "解压后的 identity 目录。它包含 python_embeded/pythonw.exe，是工作台进程的 Python 根，不是 ComfyUI 安装根。",
            "pythonw": "python_embeded/pythonw.exe",
        },
        "support": runtime_support(),
        "license": "CPython 使用 PSF License（zip 内 LICENSES/PSF-LICENSE.txt）。第三方轮子来自 requirements.lock，许可证随 dist-info 复制到 LICENSES/wheels/。",
    }


def _download(url, expected_bytes, expected_sha256, allowed_hosts):
    request = urllib.request.Request(url, headers={"User-Agent": "Refmuse-Runtime-Builder"})
    with urllib.request.urlopen(request, timeout=180) as response:
        final = urllib.parse.urlsplit(response.geturl())
        if final.scheme != "https" or final.hostname not in allowed_hosts:
            raise RuntimeError(f"下载地址不受信任：{response.geturl()}")
        data = response.read(expected_bytes + 1)
    if len(data) != expected_bytes:
        raise RuntimeError(f"官方文件字节数不符：期望 {expected_bytes}，实际 {len(data)}。未继续。")
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256:
        raise RuntimeError("官方文件 SHA-256 不符。未继续。")
    return data


def _safe_extract(data, destination):
    import io

    destination.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        for info in package.infolist():
            name = info.filename.replace("\\", "/")
            if not name or name.endswith("/"):
                continue
            parts = [part for part in name.split("/") if part not in {"", "."}]
            if any(part == ".." for part in parts) or Path(name).is_absolute():
                raise RuntimeError(f"官方 embed 包路径不安全：{name}")
            target = destination.joinpath(*parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(package.read(info))


def _enable_site(embed_dir):
    matches = sorted(embed_dir.glob("python*._pth"))
    if len(matches) != 1:
        raise RuntimeError("embeddable Python 的 ._pth 不唯一，已停止。")
    text = matches[0].read_text(encoding="utf-8")
    if "#import site" not in text and not any(line.strip() == "import site" for line in text.splitlines()):
        raise RuntimeError("未能在 ._pth 中启用 site。")
    matches[0].write_text(text.replace("#import site", "import site"), encoding="utf-8", newline="\n")


def _run(command, cwd, env):
    result = subprocess.run(command, cwd=cwd, env=env, text=True, encoding="utf-8", errors="replace", check=False)
    if result.returncode:
        raise RuntimeError(f"命令失败，退出码 {result.returncode}：{Path(command[0]).name} {' '.join(command[1:])}")


def _license_notes(embed_dir, licenses_dir):
    license_file = next((path for path in embed_dir.glob("LICENSE*") if path.is_file()), None)
    if license_file is None:
        raise RuntimeError("官方 embed 包缺少 LICENSE 文件，不能发布运行时。")
    shutil.copyfile(license_file, licenses_dir / "PSF-LICENSE.txt")
    site = embed_dir / "Lib" / "site-packages"
    lines = [
        "第三方 Python 包由 requirements.lock 的哈希锁定安装。",
        "每项的许可证以该轮子 dist-info 中的声明为准，未知项不得推定可再分发或可商用。",
        "pip、setuptools、wheel 来自经过 SHA-256 校验的 get-pip.py，只用于安装锁定依赖。",
        "本运行时只覆盖 Windows amd64。macOS 仅探测，不包含解释器。",
        "",
    ]
    for dist in sorted(site.glob("*.dist-info")):
        metadata_path = dist / "METADATA"
        metadata = metadata_path.read_text(encoding="utf-8", errors="replace") if metadata_path.is_file() else ""
        fields = {}
        for line in metadata.splitlines():
            if not line.strip():
                break
            if ":" in line:
                key, value = line.split(":", 1)
                fields.setdefault(key.strip().lower(), value.strip())
        name = fields.get("name") or dist.name
        version = fields.get("version") or ""
        license_name = fields.get("license") or "见随包许可证文件"
        target = licenses_dir / "wheels" / f"{name}-{version}"
        target.mkdir(parents=True, exist_ok=True)
        copied = False
        for item in dist.iterdir():
            if item.is_file() and "license" in item.name.casefold():
                shutil.copyfile(item, target / item.name)
                copied = True
        lines.append(f"- {name} {version}: {license_name}" + ("" if copied else "（dist-info 未附带 LICENSE 文件）"))
    (licenses_dir / "THIRD-PARTY.txt").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def _zip_tree(archive, identity_dir):
    members = {}
    for path in sorted(identity_dir.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"运行时包不允许符号链接：{path}")
        if not path.is_file():
            continue
        # Drop the executable bit from unrelated files; keep scripts executable.
        relative = path.relative_to(identity_dir.parent).as_posix()
        members[relative] = path.read_bytes()
    write_deterministic_zip(archive, members)


def build_runtime(output):
    if not host_can_build():
        support = runtime_support()
        raise RuntimeError(
            "本轮只在 Windows amd64 上构建 refmuse-runtime-python-win-amd64。"
            f"当前主机是 {support['host']}。macOS 仅探测，不提供运行时包。"
            "请在 GitHub Actions windows-latest 上运行 scripts/build_runtime_package.py。"
        )
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    identity = runtime_identity()
    stage = output / f".{identity}.stage"
    if stage.exists():
        shutil.rmtree(stage)
    identity_dir = stage / identity
    embed_dir = identity_dir / "python_embeded"
    embed = _download(EMBED_URL, EMBED_BYTES, EMBED_SHA256, {"www.python.org"})
    _safe_extract(embed, embed_dir)
    _enable_site(embed_dir)
    get_pip = _download(GET_PIP_URL, GET_PIP_BYTES, GET_PIP_SHA256, {"bootstrap.pypa.io"})
    installer = embed_dir / "get-pip.py"
    installer.write_bytes(get_pip)
    python = embed_dir / "python.exe"
    pythonw = embed_dir / "pythonw.exe"
    if not python.is_file() or not pythonw.is_file():
        raise RuntimeError("官方 embed 包缺少 python.exe 或 pythonw.exe。")
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONUTF8"] = "1"
    env.pop("PYTHONPATH", None)
    _run([str(python), str(installer), "--no-warn-script-location"], embed_dir, env)
    installer.unlink()
    _run([str(python), "-m", "pip", "install", "--require-hashes", "-r", str(ROOT / "requirements.lock")], ROOT, env)
    _run([str(python), "-c", "import psutil, imageio_ffmpeg, jsonschema, PIL, yt_dlp"], ROOT, env)
    licenses = identity_dir / "LICENSES"
    licenses.mkdir()
    _license_notes(embed_dir, licenses)
    manifest = {
        "format": 1,
        "package": PACKAGE_ID,
        "identity": identity,
        "pythonVersion": PYTHON_VERSION,
        "platform": "win-amd64",
        "implementation": "CPython",
        "macRuntime": False,
        "embed": {"url": EMBED_URL, "bytes": EMBED_BYTES, "sha256": EMBED_SHA256, "spdx": EMBED_SPDX_URL},
        "requirementsLockSha256": lock_sha256(),
        "h3ComfyRoot": "本 identity 目录。包含 python_embeded/pythonw.exe。这是工作台进程 Python 根，不是 ComfyUI 根。",
        "pythonw": "python_embeded/pythonw.exe",
    }
    (identity_dir / "runtime-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    archive = output / runtime_asset_name()
    _zip_tree(archive, identity_dir)
    checksum = write_checksum(archive, with_bytes=True)
    try:
        shutil.rmtree(stage)
    except OSError:
        pass
    print(json.dumps({"archive": str(archive), "checksum": str(checksum), "bytes": archive.stat().st_size, "identity": identity, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}, ensure_ascii=False))
    return archive, checksum


def main():
    import argparse

    parser = argparse.ArgumentParser(description="构建 Windows amd64 的独立 CPython 运行时 zip。")
    parser.add_argument("--output", type=Path, default=ROOT / ".release")
    parser.add_argument("--describe", action="store_true", help="打印配方并退出，不下载、不打包。")
    arguments = parser.parse_args()
    if arguments.describe:
        print(json.dumps(recipe(), ensure_ascii=False, indent=2))
        return
    build_runtime(arguments.output.resolve())


if __name__ == "__main__":
    main()
