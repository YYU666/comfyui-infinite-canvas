from __future__ import annotations

import contextlib
import datetime as dt
import json
import math
import os
import socket
import subprocess
import sys
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path

APP_VERSION = "1.0.14"
WORKBENCH_PORT_SPAN = range(8790, 8800)
# Official instances must not take the worktree port span or the ComfyUI port.
OFFICIAL_FORBIDDEN_PORTS = frozenset(WORKBENCH_PORT_SPAN) | {8188}
OFFICIAL_ISOLATION_ENVS = ("H3_WORKBENCH_RUNTIME_DIR", "H3_WORKBENCH_DATA_DIR", "H3_PROJECTS_ROOT")


def official_port_requested() -> bool:
    """True when the parent process asked for an official/isolated port."""
    value = os.environ.get("H3_WORKBENCH_PORT")
    return isinstance(value, str) and value.strip() != ""


def comfy_autostart_enabled() -> bool:
    """Unset or 1 keeps today's Comfy startup. 0 is the production isolated-launch flag."""
    raw = os.environ.get("H3_COMFY_AUTOSTART")
    if raw is None or raw.strip() == "" or raw == "1":
        return True
    if raw == "0":
        return False
    raise RuntimeError("H3_COMFY_AUTOSTART 只能是未设置、1 或 0。0 表示不启动、不附着、也不探测 ComfyUI。")


def require_official_isolation() -> None:
    """Official mode must not fall back onto the signed-in user's workbench directories."""
    if not official_port_requested():
        return
    missing = []
    for name in OFFICIAL_ISOLATION_ENVS:
        value = os.environ.get(name, "").strip()
        if not value:
            missing.append(name)
            continue
        path = Path(value).expanduser()
        if not path.is_absolute():
            raise RuntimeError(f"{name} 必须是绝对路径。官方隔离启动不会改用 %LOCALAPPDATA%\\H3Workbench。")
    if missing:
        raise RuntimeError(
            "已设置 H3_WORKBENCH_PORT，官方隔离启动必须同时设置 "
            "H3_WORKBENCH_RUNTIME_DIR、H3_WORKBENCH_DATA_DIR 和 H3_PROJECTS_ROOT。"
            f"缺少：{'、'.join(missing)}。不会使用 %LOCALAPPDATA%\\H3Workbench，也不会附着到用户现有的 8790 实例。"
        )


def apply_cli_port(argv) -> None:
    """`--port` is the same contract as H3_WORKBENCH_PORT, including official isolation."""
    if "--port" not in argv:
        return
    index = argv.index("--port")
    if index + 1 >= len(argv) or str(argv[index + 1]).startswith("-"):
        raise RuntimeError("--port 需要一个 0–65535 的整数。")
    value = str(argv[index + 1]).strip()
    current = os.environ.get("H3_WORKBENCH_PORT", "").strip()
    if current and current != value:
        raise RuntimeError("H3_WORKBENCH_PORT 与 --port 不一致。")
    os.environ["H3_WORKBENCH_PORT"] = value


def explicit_workbench_port(argv=None) -> int | None:
    """None scans 8790–8799. 0 lets the OS assign. Any other value binds only that port."""
    if argv is not None:
        apply_cli_port(list(argv))
    raw = os.environ.get("H3_WORKBENCH_PORT", "").strip()
    if raw == "":
        return None
    if not raw.isdigit() or (len(raw) > 1 and raw.startswith("0")):
        raise RuntimeError("H3_WORKBENCH_PORT 必须是 0–65535 的十进制整数，不能有前导零。0 表示由操作系统分配。")
    port = int(raw)
    if port > 65535:
        raise RuntimeError("H3_WORKBENCH_PORT 必须是 0–65535 的整数。")
    if port in OFFICIAL_FORBIDDEN_PORTS:
        raise RuntimeError("官方隔离启动禁止使用 8188 和 8790–8799。请设置范围外端口，或使用 0 让操作系统分配。")
    return port


def comfy_launch_switches(root: Path) -> tuple[bool, bool]:
    """Return (enabled, allow_start). Disabled means no start, no attach, and no port 8188 probe."""
    if not comfy_autostart_enabled():
        return False, False
    # A managed runtime root has python_embeded and no ComfyUI tree. Do not treat it as Comfy.
    if official_port_requested() and not (Path(root) / "ComfyUI" / "main.py").is_file():
        return False, False
    return True, os.environ.get("H3_WORKBENCH_TEST_MODE") != "1"


def runtime_dir() -> Path:
    require_official_isolation()
    configured = os.environ.get("H3_WORKBENCH_RUNTIME_DIR", "").strip()
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
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    try:
        with temporary.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(50):
            try:
                os.replace(temporary, path)
                break
            except OSError as exc:
                # Windows readers/AV can briefly deny replacement. Retry only the
                # same atomic rename; never rewrite content or bypass permissions.
                if os.name != "nt" or getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 49:
                    raise
                time.sleep(0.01)
    finally:
        with contextlib.suppress(OSError):
            temporary.unlink(missing_ok=True)
    if path == instance_path():
        restrict_private_file(path)


def read_instance() -> dict | None:
    try:
        value = json.loads(instance_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def probe_health(instance: dict, timeout: float = 3) -> dict | None:
    # /api/health may spend up to two seconds checking an unavailable ComfyUI.
    # A shorter default can mistake a healthy workbench for a dead instance.
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


def workbench_ports(instance: dict | None) -> list[int]:
    """Keep a disconnected page's origin when its previous port is available."""
    explicit = explicit_workbench_port()
    if explicit is not None:
        return [explicit]
    ports = list(WORKBENCH_PORT_SPAN)
    preferred = instance.get("port") if isinstance(instance, dict) else None
    if type(preferred) is not int or preferred not in ports:
        try:
            saved = json.loads((runtime_dir() / "workbench-port.json").read_text(encoding="utf-8"))
            preferred = saved.get("port") if isinstance(saved, dict) else None
        except (OSError, ValueError):
            preferred = None
    if type(preferred) is int and preferred in ports:
        ports.remove(preferred)
        ports.insert(0, preferred)
    return ports


def instance_process_alive(instance: dict | None) -> bool:
    """Do not spawn a second backend while the recorded owner is unresponsive."""
    if not isinstance(instance, dict) or type(instance.get("pid")) is not int or instance["pid"] <= 0:
        return False
    import psutil
    try:
        process = psutil.Process(instance["pid"])
        created = instance.get("pidCreatedAt")
        if isinstance(created, (int, float)) and abs(process.create_time() - created) > 0.01:
            return False  # The OS has reused an exited backend's PID.
        return process.is_running()
    except psutil.NoSuchProcess:
        return False
    except psutil.AccessDenied:
        return True  # Cannot prove it exited; fail closed.


def bind_workbench(server_factory, instance: dict | None = None, ports=None):
    """Bind the explicit port, or the worktree span. Never scan after an explicit port fails."""
    explicit = explicit_workbench_port()
    error = None
    selected = list(workbench_ports(instance) if ports is None else ports)
    for port in selected:
        try:
            return server_factory(("127.0.0.1", port))
        except OSError as exc:
            error = exc
            if explicit is not None:
                break
    if explicit == 0:
        raise RuntimeError("操作系统未能分配工作台端口。") from error
    if explicit is not None:
        raise RuntimeError(f"端口 {explicit} 不可用。已指定端口时只绑定该端口，不会改扫 8790–8799。") from error
    raise RuntimeError("8790–8799 端口均被占用，请查看诊断日志。") from error


def request_comfy_start(instance, health, timeout=3):
    """One authenticated hint for managed backends; old backends stay compatible."""
    if not comfy_autostart_enabled():
        return False
    comfy = health.get("comfy", {})
    if comfy.get("enabled") is False or comfy.get("state") in {None, "starting", "disabled"}:
        return False
    if comfy.get("state") in {"unresponsive", "timeout"} and comfy.get("owned") and comfy.get("running"):
        return False
    # A cached ready snapshot can outlive an external service. The manager
    # rechecks HTTP/owned processes before spawning, so explicit reuse may hint once.
    request = urllib.request.Request(f"http://127.0.0.1:{int(instance['port'])}/api/local-comfy/start",
        data=b"{}", headers={"X-H3-Token": instance.get("token", ""), "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 202
    except (OSError, ValueError, urllib.error.URLError):
        return False


def _workbench_ready(instance, health, process):
    return {"ok": True, "url": f"http://127.0.0.1:{instance['port']}/", "pid": health["pid"],
            "started": process is not None and process.pid == health["pid"],
            "workbenchReady": True, "comfyReady": False}


def ensure_workbench(timeout: float = 120) -> dict:
    """Start the local service if needed and return only after both APIs respond."""
    if not math.isfinite(timeout) or not 0 < timeout <= 600:
        raise ValueError("启动等待时间必须大于 0 且不超过 600 秒。")
    deadline = time.monotonic() + timeout
    process = None
    instance = read_instance()
    health = probe_health(instance) if instance else None
    if health and not comfy_autostart_enabled():
        return _workbench_ready(instance, health, process)
    if health:
        request_comfy_start(instance, health, timeout=min(3, timeout))
    if not health:
        # Import lazily: settings uses lifecycle helpers as well.
        from workbench_settings import WorkbenchSettings

        settings = WorkbenchSettings()
        settings.load()
        root = Path(settings.data["comfyRoot"])
        python = root / "python_embeded" / "python.exe"
        if not python.is_file() or (comfy_autostart_enabled() and not (root / "ComfyUI" / "main.py").is_file()):
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
        if health and not comfy_autostart_enabled():
            return _workbench_ready(instance, health, process)
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
        raise RuntimeError(f"画布服务已运行，但 ComfyUI 尚未就绪；请检查 {runtime_dir() / 'logs'}。未停止或重启已有服务。")
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
                # Windows permits locking beyond EOF. Acquire first: reading
                # a byte held by another startup raises PermissionError.
                handle.seek(0)
                if handle.read(1) == b"":
                    handle.write(b"0")
                    handle.flush()
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
