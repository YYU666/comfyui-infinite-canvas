from __future__ import annotations

import contextlib
import datetime as dt
import json
import math
import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_VERSION = "1.0.1-rc.1"


def runtime_dir() -> Path:
    configured = os.environ.get("H3_WORKBENCH_RUNTIME_DIR")
    if configured:
        return Path(configured)
    local = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(local) / "H3Workbench"


def instance_path() -> Path:
    return runtime_dir() / "instance.json"


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def restrict_private_file(path: Path) -> None:
    """Limit token/key files to the current user on every supported platform."""
    if os.name != "nt":
        path.chmod(0o600)
        return
    import subprocess

    domain = os.environ.get("USERDOMAIN", "")
    user = os.environ.get("USERNAME", "")
    account = f"{domain}\\{user}" if domain and user else user
    if not account:
        raise RuntimeError("无法确认当前 Windows 用户，不能保护实例令牌。")
    result = subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{account}:(F)"],
        capture_output=True, text=True, encoding="mbcs", errors="replace", timeout=10, check=False,
    )
    if result.returncode:
        raise RuntimeError("无法限制实例令牌文件权限。")


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    if path == instance_path():
        restrict_private_file(path)


def read_instance() -> dict | None:
    try:
        value = json.loads(instance_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def probe_health(instance: dict, timeout: float = 0.6) -> dict | None:
    try:
        port = int(instance["port"])
        if not 1 <= port <= 65535:
            return None
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as response:
            health = json.load(response)
        if health.get("ok") is True and int(health.get("pid", -1)) == int(instance.get("pid", -2)):
            return health
    except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError, urllib.error.URLError):
        pass
    return None


def ensure_workbench(timeout: float = 120) -> dict:
    """Start the local service if needed and return only after both APIs respond."""
    if not math.isfinite(timeout) or not 0 < timeout <= 600:
        raise ValueError("启动等待时间必须大于 0 且不超过 600 秒。")
    deadline = time.monotonic() + timeout
    process = None
    instance = read_instance()
    health = probe_health(instance) if instance else None
    if not health:
        # Import lazily: settings uses lifecycle helpers as well.
        from workbench_settings import WorkbenchSettings

        settings = WorkbenchSettings()
        settings.load()
        root = Path(settings.data["comfyRoot"])
        python = root / "python_embeded" / "python.exe"
        if not python.is_file() or not (root / "ComfyUI" / "main.py").is_file():
            raise RuntimeError("未找到配置的 ComfyUI 便携版 Python 或 main.py；请设置 H3_COMFY_ROOT 或修正工作台设置。")
        here = Path(__file__).resolve().parent
        environment = os.environ.copy()
        environment.update(H3_WORKBENCH_NO_BROWSER="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        process = subprocess.Popen(
            [str(python), "-X", "utf8", str(here / "video_workbench_launcher.py")],
            cwd=here, env=environment,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )

    while time.monotonic() < deadline:
        instance = read_instance()
        health = probe_health(instance, timeout=min(0.6, max(0.01, deadline - time.monotonic()))) if instance else None
        if health:
            url = f"http://127.0.0.1:{instance['port']}"
            request = urllib.request.Request(url + "/api/comfy/system_stats", headers={"X-H3-Token": instance.get("token", "")})
            try:
                with urllib.request.urlopen(request, timeout=min(1, max(0.01, deadline - time.monotonic()))) as response:
                    stats = json.load(response)
                if isinstance(stats, dict) and isinstance(stats.get("system"), dict) and isinstance(stats.get("devices"), list):
                    return {"ok": True, "url": url + "/", "pid": health["pid"],
                            "started": process is not None and process.pid == health["pid"],
                            "workbenchReady": True, "comfyReady": True}
            except (OSError, ValueError, urllib.error.URLError):
                pass
        if process is not None and process.poll() not in (None, 0):
            raise RuntimeError(f"工作台启动失败；请检查 {runtime_dir() / 'logs' / 'app.log'}。")
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    if health:
        raise RuntimeError(f"画布服务已运行，但 ComfyUI 尚未就绪；请检查 {runtime_dir() / 'logs' / 'comfyui.log'}。未停止或重启已有服务。")
    raise RuntimeError(f"等待画布服务启动超时；请检查 {runtime_dir() / 'logs' / 'app.log'}。未停止后台启动过程。")


def remove_instance(pid: int) -> None:
    current = read_instance()
    if current and int(current.get("pid", -1)) == pid:
        instance_path().unlink(missing_ok=True)


@contextlib.contextmanager
def startup_guard():
    """Serialize startup so rapid repeated clicks cannot create several backends."""
    path = runtime_dir() / "startup.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            if handle.read(1) == b"":
                handle.write(b"0")
                handle.flush()
            deadline = time.monotonic() + 8
            while True:
                try:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("另一个启动操作超时，请查看后台日志后重试。")
                    time.sleep(0.1)
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False
