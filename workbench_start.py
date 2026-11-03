"""Per-user Windows launch integration; protocol input is never a command."""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # Portable Python's ._pth may exclude script directories.
PROTOCOL_KEY = r"Software\Classes\refmuse-canvas"
SHORTCUT_NAME = "Refmuse 画布.lnk"
PROTOCOL_OWNER = "RefmuseCanvasHandler"


def validate_protocol_url(value: str) -> str:
    # Some browsers append the authority's empty path. No decoding, query,
    # fragment, credentials, file path or caller-supplied options are supported.
    if value not in ("refmuse-canvas://start", "refmuse-canvas://start/"):
        raise ValueError("仅支持固定启动地址 refmuse-canvas://start。")
    return value


def validate_launch_paths(comfy_root: Path, workbench_root: Path = HERE) -> tuple[Path, Path, Path]:
    root, workbench = Path(comfy_root).resolve(), Path(workbench_root).resolve()
    for path in (root, workbench):
        if any(character in str(path) for character in ('"', '%', '\r', '\n', '\0')):
            raise ValueError("启动路径包含不支持的字符。")
    pythonw = root / "python_embeded" / "pythonw.exe"
    for path in (pythonw, root / "python_embeded" / "python.exe", root / "ComfyUI" / "main.py",
                 workbench / "workbench_start.py", workbench / "video_workbench_launcher.py"):
        if not path.is_file():
            raise ValueError(f"启动文件缺失：{path}；不会使用系统 Python。")
    # Do not register a portable executable that resolves outside its runtime.
    if pythonw.resolve().parent != (root / "python_embeded").resolve():
        raise ValueError("pythonw.exe 必须位于所选便携版的 python_embeded 目录。")
    return root, workbench, pythonw


def launch_arguments(root: Path, workbench: Path, mode: str) -> list[str]:
    if mode not in ("open", "protocol"):
        raise ValueError("未知启动方式。")
    return ["-s", "-X", "utf8", str(workbench / "workbench_start.py"),
            "--comfy-root", str(root), mode]


def protocol_command(root: Path, workbench: Path, pythonw: Path) -> str:
    # Direct executable invocation, never cmd.exe, PowerShell or shell=True.
    # %1 is intentionally quoted even though the allowed URL contains no spaces.
    return f'"{pythonw}" ' + subprocess.list2cmdline(launch_arguments(root, workbench, "protocol")) + ' "%1"'


def check_protocol_owner(registry=None) -> None:
    if registry is None:
        import winreg as registry
    try:
        # Read the merged view so a machine-wide handler is protected too;
        # writes below remain exclusively under HKEY_CURRENT_USER.
        with registry.OpenKey(registry.HKEY_CLASSES_ROOT, "refmuse-canvas", 0, registry.KEY_READ) as key:
            try:
                owner, _ = registry.QueryValueEx(key, PROTOCOL_OWNER)
            except FileNotFoundError:
                owner = None
            if owner != "1":
                raise RuntimeError("refmuse-canvas 协议已被其他程序注册，已保留原注册，未覆盖。")
    except FileNotFoundError:
        return


def register_protocol(root: Path, workbench: Path, pythonw: Path, icon: Path, registry=None) -> None:
    if registry is None:
        import winreg as registry
    check_protocol_owner(registry)
    entries = {
        "": {"": "URL:Refmuse Canvas", "URL Protocol": "", PROTOCOL_OWNER: "1"},
        "DefaultIcon": {"": f'"{icon}",0'},
        r"shell\open\command": {"": protocol_command(root, workbench, pythonw)},
    }
    for suffix, values in entries.items():
        key_path = PROTOCOL_KEY + ("\\" + suffix if suffix else "")
        with registry.CreateKeyEx(registry.HKEY_CURRENT_USER, key_path, 0, registry.KEY_WRITE) as key:
            for name, value in values.items():
                registry.SetValueEx(key, name, 0, registry.REG_SZ, value)


def create_shortcut(root: Path, workbench: Path, pythonw: Path, icon: Path) -> None:
    # WScript handles OneDrive/redirected desktops. All variable data travels as
    # JSON in an environment variable, never interpolated into PowerShell code.
    script = """
$ErrorActionPreference = 'Stop'
$config = $env:REFMUSE_SHORTCUT_CONFIG | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$path = Join-Path $shell.SpecialFolders.Item('Desktop') $config.name
$link = $shell.CreateShortcut($path)
$link.TargetPath = $config.target
$link.Arguments = $config.arguments
$link.WorkingDirectory = $config.workingDirectory
$link.IconLocation = $config.icon
$link.Description = '打开 Refmuse 画布'
$link.WindowStyle = 7
$link.Save()
"""
    environment = os.environ.copy()
    environment["REFMUSE_SHORTCUT_CONFIG"] = json.dumps({
        "name": SHORTCUT_NAME, "target": str(pythonw),
        "arguments": subprocess.list2cmdline(launch_arguments(root, workbench, "open")),
        "workingDirectory": str(workbench), "icon": f"{icon},0",
    }, ensure_ascii=False)
    powershell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
                    "-EncodedCommand", base64.b64encode(script.encode("utf-16-le")).decode("ascii")],
                   env=environment, check=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW,
                   capture_output=True)


def register_windows_integration(comfy_root: Path, workbench_root: Path = HERE) -> None:
    if os.name != "nt":
        raise RuntimeError("桌面快捷方式与 URL 协议注册仅支持 Windows。")
    root, workbench, pythonw = validate_launch_paths(comfy_root, workbench_root)
    icon = workbench / "public" / "favicon.ico"
    if not icon.is_file():
        raise ValueError(f"快捷方式图标缺失：{icon}")
    check_protocol_owner()
    create_shortcut(root, workbench, pythonw, icon)
    register_protocol(root, workbench, pythonw, icon)


def start_workbench(comfy_root: Path, *, open_browser: bool) -> int:
    # Set the default before importing the launcher. Its saved settings retain
    # precedence, and its startup_guard serializes cold/repeated invocations.
    os.environ["H3_COMFY_ROOT"] = str(Path(comfy_root).resolve())
    if open_browser:
        os.environ.pop("H3_WORKBENCH_NO_BROWSER", None)
    else:
        os.environ["H3_WORKBENCH_NO_BROWSER"] = "1"
    from video_workbench_launcher import main as launch
    return launch()


def report_failure(message: str) -> None:
    if sys.stderr is not None:
        print(f"Refmuse 启动操作失败：{message}", file=sys.stderr)
    elif os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, message, "Refmuse 画布启动失败", 0x10)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Refmuse 画布桌面启动与当前用户协议注册", allow_abbrev=False)
    parser.add_argument("--comfy-root", type=Path, required=True)
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("register", help="创建桌面快捷方式并注册当前用户的 refmuse-canvas://start")
    actions.add_parser("open", help="启动或复用服务，并打开浏览器")
    protocol = actions.add_parser("protocol", help="仅唤醒服务，不打开浏览器", allow_abbrev=False)
    protocol.add_argument("url", type=validate_protocol_url)
    args = parser.parse_args(argv)
    try:
        if args.action == "register":
            register_windows_integration(args.comfy_root)
            print("已创建 Refmuse 画布桌面快捷方式，并注册当前用户的 refmuse-canvas://start。")
            return 0
        code = start_workbench(args.comfy_root, open_browser=args.action == "open")
        if code:
            from workbench_lifecycle import runtime_dir
            report_failure(f"画布未能启动，请查看日志：{runtime_dir() / 'logs' / 'app.log'}")
        return code
    except (OSError, ValueError, RuntimeError, ImportError, subprocess.SubprocessError) as exc:
        report_failure(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
