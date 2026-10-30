"""Standalone updater recovered outside the workbench source tree.

This file is copied to the runtime update directory before it is launched. It must
only use the Python standard library: the application and its dependencies are
being replaced while this process runs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath


def atomic_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def safe_path(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or "\x00" in relative:
        raise RuntimeError("更新清单包含无效路径。")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or pure.parts[0].endswith(":") or any(part in {"", ".", ".."} for part in pure.parts):
        raise RuntimeError("更新清单包含越界路径。")
    root = Path(root).resolve()
    target = root.joinpath(*pure.parts)
    if root != target.parent and root not in target.parents:
        raise RuntimeError("更新目标不在工作台目录内。")
    return target


def manifest_paths(path):
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
        files = value["files"]
        paths = [item["path"] for item in files]
        if not paths or len(paths) != len(set(paths)):
            raise ValueError("empty or duplicate")
        return paths
    except (OSError, UnicodeError, ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        if isinstance(path, Path) and path.name == "installed-files.json" and not path.exists():
            return []
        raise RuntimeError("更新文件清单无法读取。") from exc


def wait_for_exit(pid, timeout=120):
    if os.name == "nt":
        import ctypes
        synchronize = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(synchronize, False, int(pid))
        if not handle:
            return
        try:
            result = ctypes.windll.kernel32.WaitForSingleObject(handle, int(timeout * 1000))
            if result != 0:
                raise RuntimeError("旧工作台未能按时退出，未替换任何程序文件。")
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.2)
    raise RuntimeError("旧工作台未能按时退出，未替换任何程序文件。")


def copy_file(source, target):
    source = Path(source)
    target = Path(target)
    if source.is_symlink():
        raise RuntimeError("工作台目录包含不支持的符号链接，已停止升级。")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    try:
        shutil.copy2(source, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def backup_current(root, backup, paths):
    root = Path(root)
    backup = Path(backup)
    backup.mkdir(parents=True, exist_ok=False)
    for relative in paths:
        source = safe_path(root, relative)
        if source.exists():
            if not source.is_file() or source.is_symlink():
                raise RuntimeError("工作台程序路径异常，已停止升级。")
            copy_file(source, safe_path(backup / "program", relative))
    for name in ("dist", "node_modules"):
        source = root / name
        if source.exists():
            if source.is_symlink() or not source.is_dir():
                raise RuntimeError(f"工作台 {name} 目录异常，已停止升级。")
            shutil.copytree(source, backup / name)


def replace_program(root, source, backup, new_paths, old_paths):
    root = Path(root)
    source = Path(source)
    backup = Path(backup)
    for relative in old_paths:
        target = safe_path(root, relative)
        if target.exists():
            target.unlink()
    for relative in new_paths:
        copy_file(safe_path(source, relative), safe_path(root, relative))
    for name in ("dist", "node_modules"):
        target = root / name
        if target.exists():
            shutil.rmtree(target)
        staged = source / name
        if name == "dist" and not (staged / "index.html").is_file():
            raise RuntimeError("新版画布构建结果不完整。")
        if staged.exists():
            shutil.copytree(staged, target)


def restore_program(root, backup, new_paths, old_paths):
    root = Path(root)
    backup = Path(backup)
    for relative in set(new_paths) | set(old_paths):
        target = safe_path(root, relative)
        if target.exists():
            target.unlink()
    old_program = backup / "program"
    if old_program.exists():
        for source in old_program.rglob("*"):
            if source.is_file():
                copy_file(source, root / source.relative_to(old_program))
    for name in ("dist", "node_modules"):
        target = root / name
        if target.exists():
            shutil.rmtree(target)
        if (backup / name).exists():
            shutil.copytree(backup / name, target)


def install_dependencies(python, requirements, runner=None):
    runner = runner or subprocess.run
    result = runner([str(python), "-m", "pip", "install", "--require-hashes", "-r", str(requirements)],
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, check=False)
    if result.returncode:
        raise RuntimeError("Python 依赖安装失败。")


def start_workbench(python, root):
    flags = (subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
    environment = os.environ.copy()
    environment.pop("H3_WORKBENCH_NO_BROWSER", None)
    return subprocess.Popen([str(python), "-s", str(Path(root) / "video_workbench_launcher.py")], cwd=root,
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            close_fds=True, creationflags=flags, start_new_session=os.name != "nt", env=environment)


def read_instance(runtime_dir):
    try:
        value = json.loads((Path(runtime_dir) / "instance.json").read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def wait_for_health(runtime_dir, target_version=None, timeout=90):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        instance = read_instance(runtime_dir)
        if instance:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{int(instance['port'])}/api/health", timeout=1) as response:
                    health = json.load(response)
                if health.get("ok") is True and int(health.get("pid", -1)) == int(instance.get("pid", -2)):
                    if target_version is None or health.get("version") == target_version.lstrip("v"):
                        return health
            except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                pass
        time.sleep(0.5)
    raise RuntimeError("新版工作台未能通过启动健康检查。")


def stop_workbench(runtime_dir, expected_pid=None):
    instance = read_instance(runtime_dir)
    if not instance:
        return
    if expected_pid is not None and int(instance.get("pid", -1)) != int(expected_pid):
        return
    try:
        request = urllib.request.Request(f"http://127.0.0.1:{int(instance['port'])}/api/shutdown", data=b"{}",
                                         headers={"Content-Type": "application/json", "X-H3-Token": str(instance["token"])}, method="POST")
        with urllib.request.urlopen(request, timeout=3):
            pass
        wait_for_exit(int(instance["pid"]), timeout=30)
    except Exception as exc:
        raise RuntimeError("无法安全停止未通过检查的新版工作台。") from exc


def run(request):
    root = Path(request["root"]).resolve()
    source = Path(request["source"]).resolve()
    backup = Path(request["backup"]).resolve()
    status_path = Path(request["status"])
    new_paths = manifest_paths(request["manifest"])
    installed_manifest = Path(request["installedManifest"])
    old_paths = manifest_paths(installed_manifest) if installed_manifest.exists() else []
    all_paths = sorted(set(new_paths) | set(old_paths))
    atomic_json(status_path, {"phase": "restarting", "message": "正在备份旧版并安装更新…", "version": request["targetVersion"]})
    backup_current(root, backup, all_paths)
    process = None
    try:
        replace_program(root, source, backup, new_paths, old_paths)
        install_dependencies(request["python"], root / "requirements.lock")
        process = start_workbench(request["python"], root)
        health = wait_for_health(request["runtimeDir"], request["targetVersion"])
        atomic_json(installed_manifest, json.loads(Path(request["manifest"]).read_text(encoding="utf-8")))
        atomic_json(status_path, {"phase": "success", "message": "更新安装成功。", "version": request["targetVersion"], "pid": health.get("pid")})
    except Exception as original:
        atomic_json(status_path, {"phase": "restarting", "message": "新版启动失败，正在恢复旧版…", "version": request["targetVersion"]})
        instance = read_instance(request["runtimeDir"])
        if instance:
            stop_workbench(request["runtimeDir"], instance.get("pid"))
        elif process and process.poll() is None:
            process.terminate()
            process.wait(timeout=30)
        restore_program(root, backup, new_paths, old_paths)
        try:
            install_dependencies(request["python"], backup / "program" / "requirements.lock")
        except Exception:
            atomic_json(status_path, {"phase": "error", "message": "新版安装失败，程序文件已恢复，但旧版 Python 依赖恢复失败。请运行 install.bat。", "version": request["targetVersion"]})
            raise
        restored = start_workbench(request["python"], root)
        try:
            health = wait_for_health(request["runtimeDir"])
        except Exception:
            atomic_json(status_path, {"phase": "error", "message": "新版安装失败，旧版文件已恢复但无法自动启动。请运行 install.bat 后启动，旧版备份仍保留。", "version": request["targetVersion"]})
            raise
        atomic_json(status_path, {"phase": "error", "message": f"新版安装失败，已恢复并重新启动旧版。原因：{str(original)[:180]}", "version": request["targetVersion"], "pid": health.get("pid")})
    finally:
        shutil.rmtree(source, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    arguments = parser.parse_args()
    request_path = Path(arguments.request).resolve()
    request = json.loads(request_path.read_text(encoding="utf-8"))
    try:
        wait_for_exit(int(request["expectedPid"]))
        run(request)
    except Exception as exc:
        try:
            existing = json.loads(Path(request["status"]).read_text(encoding="utf-8"))
            if existing.get("phase") != "error" or not existing.get("message"):
                atomic_json(request["status"], {"phase": "error", "message": f"升级未完成：{str(exc)[:180]}", "version": request.get("targetVersion")})
        except Exception:
            pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
