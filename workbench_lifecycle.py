from __future__ import annotations

import contextlib
import datetime as dt
import json
import os
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_VERSION = "1.0.0"


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


def atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    with temporary.open("wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


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
