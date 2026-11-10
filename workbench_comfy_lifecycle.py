"""Bounded, single-flight startup of an owned ComfyUI. Never restart live processes."""
from __future__ import annotations

import datetime as dt
import errno
import json
import re
import socket
import threading
import time
import urllib.request
import urllib.parse
import uuid
from pathlib import Path

import psutil


def sanitized_url(url):
    parsed = urllib.parse.urlsplit(url)
    host = parsed.hostname or "localhost"
    if ":" in host:
        host = f"[{host}]"
    return f"{parsed.scheme}://{host}" + (f":{parsed.port}" if parsed.port else "")


def ready_probe(url):
    try:
        with urllib.request.urlopen(url + "/system_stats", timeout=1) as response:
            payload = json.load(response)
        return isinstance(payload, dict) and isinstance(payload.get("system"), dict) and isinstance(payload.get("devices"), list)
    except Exception:
        return False


def startup_obstacle(url, root):
    """Fail closed on a listening port or another matching (possibly still loading) process."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname not in {"localhost", "127.0.0.1"} or (parsed.port or 80) != 8188:
        return "当前 ComfyUI 地址不支持托管启动，请手动检查目标服务。"
    try:
        # Windows may take ~2 seconds to refuse a connect to an EMPTY loopback
        # port. A short connect timeout is not evidence of a listener. Ask the
        # kernel whether the exact launch address can be exclusively bound;
        # never listen or enable address reuse, and release before spawning.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reservation:
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                reservation.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            reservation.bind(("127.0.0.1", 8188))
    except OSError as exc:
        if exc.errno in {errno.EADDRINUSE, 10048} or getattr(exc, "winerror", None) == 10048:
            return "ComfyUI 端口已被占用但服务未就绪；未启动重复进程，请检查占用进程。"
        return "无法确认 ComfyUI 端口可用；未启动新进程，请稍后重试。"
    expected = (Path(root) / "ComfyUI" / "main.py").resolve()
    for process in psutil.process_iter(["cmdline", "cwd"]):
        try:
            args = process.info.get("cmdline") or []
            for arg in args:
                if not isinstance(arg, str) or Path(arg).name.lower() != "main.py":
                    continue
                path = Path(arg)
                if not path.is_absolute():
                    cwd = process.info.get("cwd")
                    if not cwd:
                        return "存在无法确认归属的 main.py 进程，请检查后重试。"
                    path = Path(cwd) / path
                if path.resolve() == expected:
                    return "ComfyUI 进程已存在但服务未就绪；未重复启动，请等待或查看日志。"
        except (psutil.NoSuchProcess, psutil.AccessDenied, OSError):
            continue
    return ""


def supports_disable_assets(root):
    try:
        source = (Path(root) / "ComfyUI" / "comfy" / "cli_args.py").read_text(encoding="utf-8")
        return bool(re.search(r'add_argument\(\s*[\'"]--disable-assets[\'"]', source))
    except OSError:
        return False


def missing_assets_migration(log_path):
    try:
        with Path(log_path).open("rb") as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 2 * 1024 * 1024))
            text = stream.read().decode("utf-8", errors="replace")
        return "ASSETS_STARTUP_FAILED" in text and bool(re.search(r"(?:Path doesn't exist|No such file or directory|cannot find|not found)[^\r\n]*alembic_db|alembic_db[^\r\n]*(?:does not exist|not found)", text, re.I))
    except OSError:
        return False


def prune_attempt_logs(directory, keep=5):
    # Match only our generated attempt groups, including their rotated segments.
    groups = {}
    for path in Path(directory).glob("comfyui-*.log*"):
        match = re.fullmatch(r"(comfyui-\d{8}-\d{6}-[0-9a-f]{8}\.log)(?:\.\d+)?", path.name)
        if match:
            groups.setdefault(match[1], []).append(path)
    newest = sorted(groups, key=lambda name: max(p.stat().st_mtime for p in groups[name]), reverse=True)
    for name in newest[keep:]:
        for path in groups[name]:
            try:
                path.unlink()
            except OSError:
                pass


class ComfyLifecycle:
    def __init__(self, *, url, root, log_dir, command, spawn, enabled=True, allow_start=True,
                 probe=ready_probe, obstacle=startup_obstacle, supports=supports_disable_assets,
                 timeout=120, interval=0.5):
        self.url, self.root, self.log_dir = url, Path(root), Path(log_dir)
        self.command, self.spawn = list(command), spawn
        self.enabled, self.allow_start = enabled, allow_start
        self.probe, self.obstacle, self.supports = probe, obstacle, supports
        self.timeout, self.interval = timeout, interval
        self.process = self.logger = None
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._refresh_thread = None
        self._refresh_after = 0
        self._state = {"state": "stopped" if enabled else "disabled", "error": "", "exitCode": None,
                       "degraded": False, "warning": "", "lastCheckedAt": None}

    def _set(self, **values):
        self._state.update(values, lastCheckedAt=dt.datetime.now(dt.timezone.utc).isoformat())

    def _refresh_status(self, process, startup_thread):
        ready = self.probe(self.url)
        code = process.poll() if process else None
        with self._lock:
            # A newer start/ownership change invalidates this older HTTP result.
            if self._stop.is_set() or self._thread is not startup_thread or self.process is not process:
                return
            if ready:
                if process and code is not None:
                    self.process = self.logger = None
                    self._set(exitCode=None, degraded=False, warning="")
                self._set(state="ready", error="")
            elif process and code is not None:
                self._set(state="exited", exitCode=code, error=self._state["error"] or "ComfyUI 进程已退出，请查看诊断日志后点击重试。")
            elif self._state["state"] == "ready":
                self._set(state="unresponsive", error="ComfyUI 暂未响应；保留现有进程，请稍后检查或查看诊断日志。")
            else:
                self._set()

    def status(self, refresh=False):
        with self._lock:
            # /health must remain prompt even while ComfyUI refuses connections.
            # Refresh one cached snapshot asynchronously; CLI health deadlines
            # are shorter than ComfyUI's HTTP timeout. Never queue refreshes.
            if (refresh and self.enabled and not self._stop.is_set()
                    and not (self._thread and self._thread.is_alive())
                    and not (self._refresh_thread and self._refresh_thread.is_alive())
                    and time.monotonic() >= self._refresh_after):
                self._refresh_after = time.monotonic() + 1
                self._refresh_thread = threading.Thread(target=self._refresh_status,
                    args=(self.process, self._thread), name="comfy-health", daemon=True)
                self._refresh_thread.start()
            alive = self.process is not None and self.process.poll() is None
            return {**self._state, "running": alive or self._state["state"] == "ready", "ready": self._state["state"] == "ready",
                    "owned": self.process is not None, "enabled": self.enabled,
                    "pid": self.process.pid if self.process else None, "url": sanitized_url(self.url)}

    def request_start(self):
        with self._lock:
            if not self.enabled or not self.allow_start or self._stop.is_set():
                return self.status()
            if self._thread and self._thread.is_alive():
                return self.status()
            self._set(state="starting", error="")
            self._thread = threading.Thread(target=self._start, name="comfy-startup", daemon=True)
            self._thread.start()
            return self.status()

    def _start(self):
        try:
            # Socket/process probes run outside the state lock; health and
            # repeated start requests must not wait behind network timeouts.
            ready = self.probe(self.url)
            with self._lock:
                if self._stop.is_set():
                    return
                # Never restart an alive child, even after timeout/loss of HTTP.
                if self.process and self.process.poll() is None:
                    self._set(state="ready" if ready else "unresponsive",
                              error="" if ready else "ComfyUI 进程仍在运行，未重复启动；请稍后检查或查看诊断日志。")
                    return
                if ready:
                    self.process = self.logger = None
                    self._set(state="ready", error="", exitCode=None, degraded=False, warning="")
                    return
            reason = self.obstacle(self.url, self.root)
            with self._lock:
                if self._stop.is_set():
                    return
                if reason:
                    self._set(state="port_conflict", error=reason)
                    return
                self._set(exitCode=None, degraded=False, warning="")
            for attempt in range(2):
                # Recheck before both initial and degraded spawn, outside the state lock.
                reason = self.obstacle(self.url, self.root)
                with self._lock:
                    if self._stop.is_set():
                        return
                    if reason:
                        self._set(state="port_conflict", error=reason)
                        return
                    prune_attempt_logs(self.log_dir)
                    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
                    log = self.log_dir / f"comfyui-{stamp}-{uuid.uuid4().hex[:8]}.log"
                    command = self.command + (["--disable-assets"] if attempt else [])
                    self.process, self.logger = self.spawn(command, self.root, log)
                    self._set(state="starting", exitCode=None, degraded=bool(attempt), warning="素材库功能已停用。请修复 ComfyUI 的 alembic_db 迁移文件后重新启动。" if attempt else "")
                deadline = time.monotonic() + self.timeout
                while not self._stop.is_set():
                    code = self.process.poll()
                    if code is not None:
                        break
                    if self.probe(self.url):
                        with self._lock:
                            self._set(state="ready", error="")
                        return
                    if time.monotonic() >= deadline:
                        with self._lock:
                            self._set(state="timeout", error="ComfyUI 启动超时，进程已保留。请查看诊断日志；不会自动重启。")
                        return
                    self._stop.wait(self.interval)
                if self._stop.is_set():
                    return
                # Wait for current-attempt output only; stale rotating logs never trigger fallback.
                try:
                    self.logger.wait(timeout=5)
                except Exception:
                    pass
                assets_missing = missing_assets_migration(log)
                with self._lock:
                    self._set(state="exited", exitCode=code, error="ComfyUI 素材库启动失败：缺少 alembic_db 迁移文件。请修复安装或查看诊断日志。" if assets_missing else "ComfyUI 进程已退出，请下载诊断日志查看原因后重试。")
                if attempt or not assets_missing or not self.supports(self.root):
                    return
        except Exception:
            # Public health must never expose exception text, paths, tokens, or subprocess output.
            with self._lock:
                self._set(state="failed", error="ComfyUI 启动失败，请确认便携版 Python 和 main.py 存在，并下载诊断日志。")

    def close(self):
        with self._lock:
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=8)
        if self._refresh_thread:
            self._refresh_thread.join(timeout=2)
