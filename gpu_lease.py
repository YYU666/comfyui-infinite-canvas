"""Physical-device ownership shared by local Refmuse runtimes."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from functools import lru_cache

import psutil

from workbench_lifecycle import atomic_write_json


DEVICE = re.compile(r"GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)
WORKER_LEASE_ENV = "H3_LOCAL_WORKER_GPU_LEASE"


def process_identity(pid=None):
    process = psutil.Process(os.getpid() if pid is None else pid)
    return {"pid": process.pid, "created": process.create_time()}


def alive(identity):
    if not identity:
        return False
    try:
        process = psutil.Process(identity["pid"])
        return abs(process.create_time() - identity["created"]) < 0.01 and process.status() != psutil.STATUS_ZOMBIE
    except (psutil.NoSuchProcess, psutil.ZombieProcess):
        return False
    except (psutil.Error, OSError):
        # An unreadable process is not evidence that the GPU is idle.
        return True


def physical_device():
    return _physical_device(os.environ.get("H3_GPU_DEVICE_UUID", "").strip().lower())


@lru_cache(maxsize=4)
def _physical_device(requested):
    try:
        result = subprocess.run(["nvidia-smi", "--query-gpu=uuid", "--format=csv,noheader"],
                                check=True, capture_output=True, text=True, timeout=4,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("无法确认本机 NVIDIA 物理 GPU；未提交。") from exc
    devices = [value.strip().lower() for value in result.stdout.splitlines() if value.strip()]
    if not devices or any(not DEVICE.fullmatch(value) for value in devices):
        raise RuntimeError("本机 GPU UUID 无法确认；未提交。")
    if requested and requested in devices:
        return requested
    if not requested and len(devices) == 1:
        return devices[0]
    raise RuntimeError("请为这台多卡工作台配置实际使用的 H3_GPU_DEVICE_UUID；未提交。")


def _local_origin(origin):
    parsed = urllib.parse.urlsplit(origin)
    if (parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1", "localhost"}
            or not parsed.port or parsed.username or parsed.password or parsed.path not in {"", "/"}
            or parsed.query or parsed.fragment):
        raise ValueError("GPU 互斥要求 ComfyUI 使用可验证的本机回环端点。")
    return parsed


def comfy_process(origin):
    parsed = _local_origin(origin)
    for connection in psutil.net_connections(kind="tcp"):
        if connection.status == psutil.CONN_LISTEN and connection.laddr.port == parsed.port and connection.pid:
            if connection.laddr.ip not in {"127.0.0.1", "::1", "0.0.0.0", "::"}:
                continue
            return process_identity(connection.pid)
    raise RuntimeError("无法确认 ComfyUI 本机进程；未提交。")


def comfy_device(info):
    devices = info.get("devices") or []
    if len(devices) != 1:
        raise RuntimeError("ComfyUI 未报告唯一执行设备；未提交。")
    selected = devices[0]
    if selected.get("type") == "cpu":
        return None
    device = physical_device()
    reported = str(selected.get("uuid") or "").lower()
    if reported:
        if reported != device:
            raise RuntimeError("ComfyUI 报告的 GPU 与本机已配置的物理 UUID 不一致。")
    else:
        try:
            # Do not equate a logical CUDA ordinal with a physical GPU.
            single = _physical_device("")
        except RuntimeError as exc:
            raise RuntimeError("多卡 ComfyUI 必须报告实际物理 UUID。") from exc
        if single != device:
            raise RuntimeError("ComfyUI 物理 GPU 无法验证。")
    return device


def default_root():
    configured = os.environ.get("H3_GPU_LEASE_DIR")
    return Path(configured) if configured else Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".local" / "state") / "Refmuse" / "gpu-leases"


@contextlib.contextmanager
def _exclusive(path):
    with path.open("a+b") as file:
        deadline = time.monotonic() + 2
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    file.seek(0)
                    msvcrt.locking(file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.02)
        try:
            yield
        finally:
            if os.name == "nt":
                file.seek(0)
                msvcrt.locking(file.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(file.fileno(), fcntl.LOCK_UN)


def job_owner(kind, job):
    owner = {"kind": kind, "projectId": job["projectId"], "nodeId": job["nodeId"], "jobId": job["id"]}
    if kind == "comfy":
        owner["attempt"] = job["attempts"]
    return owner


def gpu_status(device, state, owner):
    return {"device": device, "state": state, "owner": dict(owner)}


def _comfy_request(origin, path):
    _local_origin(origin)
    with urllib.request.urlopen(origin + path, timeout=2) as response:
        return json.load(response)


def _matches_dispatch(item, dispatch):
    return (isinstance(item, list) and len(item) > 3 and isinstance(item[3], dict)
            and item[3].get("refmuse_gpu_dispatch") == dispatch)


def _terminal(entry):
    status = entry.get("status") or {}
    return bool(status.get("completed") or status.get("status_str") in {"success", "error"})


def _reconcile_comfy(row):
    """Prove upstream completion/exit. Missing unacknowledged work stays reserved."""
    backend = row.get("backend")
    if not backend:
        return False
    if not alive(backend):
        return True
    origin = row["origin"]
    try:
        if comfy_process(origin) != backend:
            return False
        prompt = row.get("prompt")
        if prompt:
            history = _comfy_request(origin, "/history/" + urllib.parse.quote(str(prompt), safe=""))
            if _terminal(history.get(prompt) or {}):
                return True
        queue = _comfy_request(origin, "/queue")
        if not all(isinstance(queue.get(key), list) for key in ("queue_running", "queue_pending")):
            return False
        pending = queue["queue_running"] + queue["queue_pending"]
        if prompt:
            return not any(isinstance(item, list) and len(item) > 1 and item[1] == prompt for item in pending)
        dispatch = row["dispatch"]
        if any(_matches_dispatch(item, dispatch) for item in pending):
            return False
        history = _comfy_request(origin, "/history?max_items=100")
        return any(_matches_dispatch(entry.get("prompt"), dispatch) and _terminal(entry)
                   for entry in history.values() if isinstance(entry, dict))
    except (OSError, ValueError, RuntimeError, psutil.Error):
        return False


class GpuLeases:
    def __init__(self, root=None):
        self.root = Path(root or default_root()).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _paths(self, device):
        if not DEVICE.fullmatch(device):
            raise ValueError("Invalid physical GPU UUID")
        name = hashlib.sha256(device.lower().encode("ascii")).hexdigest()
        return self.root / (name + ".lock"), self.root / (name + ".json")

    @contextlib.contextmanager
    def _row(self, device):
        lock, state = self._paths(device)
        with _exclusive(lock):
            try:
                row = json.loads(state.read_text(encoding="utf-8"))
            except FileNotFoundError:
                row = None
            if row is not None and (not isinstance(row, dict) or row.get("device") != device or not row.get("token")):
                raise ValueError("Unreadable GPU lease; retained for local inspection")
            yield state, row

    def claim(self, device, owner, *, recovery=None):
        with self._row(device) as (state, row):
            if row is not None:
                abandoned = row["phase"] == "reserved" and not alive(row["host"])
                worker_exited = row["phase"] == "worker" and not alive(row["worker"])
                if abandoned or worker_exited:
                    row = None
            if row is None:
                token = uuid.uuid4().hex
                atomic_write_json(state, {"device": device, "owner": owner, "phase": "reserved",
                                          "token": token, "host": process_identity()})
                return GpuGrant(self, device, token, owner), None
            if recovery and row["owner"] == owner and row.get("origin") == recovery and not alive(row["host"]):
                # A restarted queue may adopt the same acknowledged upstream task.
                row["host"] = process_identity()
                atomic_write_json(state, row)
                return GpuGrant(self, device, row["token"], owner), None
            reconcile = row["phase"] == "comfy" and (row.get("uncertain") or not alive(row["host"]))
        if reconcile and _reconcile_comfy(row):
            if self._clear(device, row["token"], previous=row):
                return self.claim(device, owner, recovery=recovery)
        return None, row["owner"]

    def _change(self, device, token, **changes):
        with self._row(device) as (state, row):
            if not row or row["token"] != token:
                raise RuntimeError("GPU lease was lost before execution")
            row.update(changes)
            atomic_write_json(state, row)

    def _clear(self, device, token, previous=None):
        with self._row(device) as (state, row):
            if row is None or row["token"] != token or (previous is not None and row != previous):
                return False
            if row["phase"] == "worker" and alive(row.get("worker")):
                return False
            state.unlink()
            return True


class GpuGrant:
    def __init__(self, manager, device, token, owner):
        self.manager, self.device, self.token, self.owner = manager, device, token, owner

    def dispatch(self, origin, backend):
        dispatch = uuid.uuid4().hex
        self.manager._change(self.device, self.token, phase="comfy", origin=origin, backend=backend,
                             dispatch=dispatch, prompt=None, uncertain=False)
        return dispatch

    def acknowledge(self, prompt):
        self.manager._change(self.device, self.token, prompt=prompt)

    def uncertain(self):
        self.manager._change(self.device, self.token, uncertain=True)

    def release(self):
        return self.manager._clear(self.device, self.token)

    def restore_prompt(self, origin, backend, prompt):
        with self.manager._row(self.device) as (state, row):
            if row and row["token"] == self.token and row["phase"] == "reserved":
                row.update(phase="comfy", origin=origin, backend=backend, dispatch=None, prompt=prompt)
                atomic_write_json(state, row)

    def rejected(self):
        self.manager._change(self.device, self.token, phase="reserved")

    def retire_comfy(self, unload):
        with self.manager._row(self.device) as (_, row):
            if not row or row["token"] != self.token:
                return True
        if row["phase"] == "reserved":
            return self.release()
        if not _reconcile_comfy(row):
            return False
        try:
            if alive(row.get("backend")):
                unload()
        except (OSError, ValueError, RuntimeError):
            # Completion owns no execution slot even if cache cleanup failed.
            pass
        return self.manager._clear(self.device, self.token, previous=row)

    def worker_environment(self, env):
        return {**env, "CUDA_VISIBLE_DEVICES": "GPU-" + self.device[4:],
                WORKER_LEASE_ENV: json.dumps({"root": str(self.manager.root), "device": self.device, "token": self.token})}


def adopt_worker_lease():
    raw = os.environ.pop(WORKER_LEASE_ENV, None)
    if not raw:
        return
    grant = json.loads(raw)
    manager = GpuLeases(grant["root"])
    manager._change(grant["device"], grant["token"], phase="worker", worker=process_identity())
