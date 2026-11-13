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


def assert_public_path(relative):
    parts = relative.replace('\\', '/').casefold().split('/')
    basename=parts[-1]
    private_directories={'.local-node-tools','.cache','node_modules','dist','runtime','.runtime','credentials','.credentials','secrets','.secrets','h3workbench'}
    private_names={'art-director-credentials.dpapi','credentials.json','credential-store.json','api-keys.json','providers.private.json','instance.json','id_rsa','id_ed25519','id_ecdsa','deepseek-key.json','deepseek-key.txt'}
    private_suffixes=('.h3pack','.dpapi','.key','.pem','.p12','.pfx','.local','.local.json','.private.json')
    env_file=basename.startswith('.env') and basename!='.env.example'
    if any(part in private_directories for part in parts) or basename in private_names or basename.endswith(private_suffixes) or env_file:
        raise RuntimeError(f"本机凭据、运行目录、工具和构建缓存不得随开源更新发布：{relative}")



def write_deterministic_zip(archive, members):
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package_zip:
        for relative, data in members.items():
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            package_zip.writestr(info, data)


def write_checksum(archive, *, with_bytes):
    """Update packages stay `sha256  name`. Portable and runtime also record the byte size."""
    data = archive.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    checksum = archive.with_name(archive.name + ".sha256")
    if with_bytes:
        line = f"{digest}  {len(data)}  {archive.name}\n"
    else:
        line = f"{digest}  {archive.name}\n"
    checksum.write_text(line, encoding="ascii", newline="\n")
    return checksum


def verify_checksum(archive, *, with_bytes):
    archive = Path(archive)
    text = archive.with_name(archive.name + ".sha256").read_text(encoding="ascii").strip()
    parts = text.split()
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if not parts or parts[0] != digest or parts[-1] != archive.name:
        raise RuntimeError(f"校验文件与 {archive.name} 不一致。")
    if with_bytes:
        if len(parts) != 3 or int(parts[1]) != archive.stat().st_size:
            raise RuntimeError(f"{archive.name} 的校验文件必须同时给出 SHA-256 和字节数。")
    elif len(parts) != 2:
        raise RuntimeError(f"{archive.name} 的更新包校验文件必须保持 SHA-256 与文件名两列。")
    return digest


def tracked_files():
    result = subprocess.run(["git", "-C", str(ROOT), "ls-files", "-z"], capture_output=True, timeout=30, check=False)
    if result.returncode:
        raise RuntimeError("无法读取 Git 跟踪文件，更新包未生成。")
    paths = sorted(item.decode("utf-8") for item in result.stdout.split(b"\0") if item)
    if not paths:
        raise RuntimeError("Git 跟踪文件为空，更新包未生成。")
    required = {"video_workbench_launcher.py", "workbench_comfy_lifecycle.py", "workbench_update.py", "workbench_update_helper.py", "workbench_lifecycle.py", "package.json", "package-lock.json", "requirements.lock"}
    if not required.issubset(paths):
        raise RuntimeError("更新必需文件尚未纳入 Git，已阻止生成不完整升级包。")
    return paths


def assert_release_tag(tag):
    parse_version(tag)
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    tree = ast.parse((ROOT / "workbench_lifecycle.py").read_text(encoding="utf-8"))
    app_version = next(ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == "APP_VERSION" for target in node.targets))
    if package.get("version") != tag.lstrip("v") or app_version != tag.lstrip("v"):
        raise RuntimeError("package.json、APP_VERSION 与 Release 标签必须完全一致。")


def build(tag, output):
    assert_release_tag(tag)
    files = []
    contents = {}
    for relative in tracked_files():
        assert_public_path(relative)
        path = ROOT.joinpath(*relative.split("/"))
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"更新包不允许符号链接或非普通文件：{relative}")
        data = path.read_bytes()
        contents[relative] = data
        files.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest()})
    manifest = json.dumps({"format": 1, "version": tag, "files": files}, ensure_ascii=False, indent=2).encode("utf-8")
    output.mkdir(parents=True, exist_ok=True)
    archive = output / asset_name(tag)
    write_deterministic_zip(archive, {**contents, "release-files.json": manifest})
    checksum = write_checksum(archive, with_bytes=False)
    print(json.dumps({"archive": str(archive), "checksum": str(checksum), "files": len(files), "bytes": archive.stat().st_size}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser(description="构建带逐文件清单和 SHA256 的 Refmuse 安全更新包。")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, default=ROOT / ".release")
    arguments = parser.parse_args()
    build(arguments.tag, arguments.output.resolve())


if __name__ == "__main__":
    main()
