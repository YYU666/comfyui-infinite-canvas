"""Local, serialized Blender CPU jobs. This module never calls ComfyUI."""
from __future__ import annotations

import json
import math
import mimetypes
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import threading
import time
import uuid

import psutil
from PIL import Image

from project_store import StoreError
from workbench_lifecycle import atomic_write_json

JOB_ID = re.compile(r"spa_[0-9a-f]{32}")
FILES = {"albedo": "albedo.png", "normal": "normal.png", "metadata": "atlas.json"}
MAX_PIXELS = 64_000_000
MAX_SIDE = 8192
MAX_INPUT = 512 * 1024**2
MAX_QUEUE = 4
MAX_HISTORY = 1000
TIMEOUT = 1800
TERMINAL = {"done", "error", "cancelled"}


def find_blender():
    """Discovery only: never install, update, or run an unrelated executable."""
    configured = os.environ.get("H3_BLENDER_PATH", "").strip()
    if configured:
        path = Path(configured).expanduser()
        return path.resolve() if path.is_file() and path.name.lower() in {"blender", "blender.exe"} else None
    found = shutil.which("blender")
    if found:
        return Path(found).resolve()
    for base in (Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Blender Foundation",
                 Path("/Applications/Blender.app/Contents/MacOS")):
        candidates = sorted(base.glob("Blender*/blender.exe"), reverse=True) if base.name == "Blender Foundation" else [base / "Blender"]
        for path in candidates:
            if path.is_file():
                return path.resolve()
    return None


def _number(value, label, minimum, maximum, integer=False):
    if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum or (integer and type(value) is not int):
        raise StoreError("BAD_REQUEST", f"{label} 超出支持范围。")
    return value


def validate_options(value):
    defaults = dict(directions=8, frameSize=192, framesPerAction=8, actions=[], elevation=10, startYaw=0, padding=0.1, pivot=[0.5, 0.9])
    if not isinstance(value, dict) or set(value) - set(defaults):
        raise StoreError("BAD_REQUEST", "精灵图参数无效或包含未知字段。")
    result = {**defaults, **value}
    if type(result["directions"]) is not int or result["directions"] not in (4, 8, 16):
        raise StoreError("BAD_REQUEST", "方向数只支持 4、8、16。")
    for key, low, high, integer in (("frameSize", 32, 1024, True), ("framesPerAction", 1, 64, True), ("elevation", 0, 60, False), ("startYaw", -360, 360, False), ("padding", 0, 0.4, False)):
        _number(result[key], key, low, high, integer)
    actions = result["actions"]
    if not isinstance(actions, list) or len(actions) > 8 or any(not isinstance(a, str) or not 0 < len(a) <= 200 for a in actions) or len(set(actions)) != len(actions):
        raise StoreError("BAD_REQUEST", "最多选择 8 个不重复动作；留空表示全部动作。")
    pivot = result["pivot"]
    if not isinstance(pivot, list) or len(pivot) != 2:
        raise StoreError("BAD_REQUEST", "轴心点必须为两个 0.01–0.99 数值。")
    for item in pivot:
        _number(item, "pivot", 0.01, 0.99)
    width = result["frameSize"] * result["framesPerAction"]
    height = result["frameSize"] * result["directions"] * max(1, len(actions))
    if max(width, height) > MAX_SIDE or width * height > MAX_PIXELS:
        raise StoreError("BAD_REQUEST", "图集超过 8192 边长或 6400 万像素限制，请减少帧数、动作或尺寸。")
    # The renderer repeats this bound after discovering all animation clips.
    return result


def validate_input(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 32768 or "\0" in value:
        raise StoreError("BAD_REQUEST", "请填写本机 GLB 或 FBX 文件的绝对路径。")
    value = value.strip()
    if value.startswith(("\\\\", "//")) or re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", value):
        raise StoreError("BAD_REQUEST", "只支持本机文件，不支持网址或网络共享。")
    path = Path(value).expanduser()
    if not path.is_absolute() or path.suffix.lower() not in (".glb", ".fbx"):
        raise StoreError("BAD_REQUEST", "只支持本机 GLB 或 FBX 文件的绝对路径。")
    path = path.resolve()
    if str(path).startswith(("\\\\", "//")) or not path.is_file() or not 0 < path.stat().st_size <= MAX_INPUT:
        raise StoreError("BAD_REQUEST", "模型文件不存在、为空或超过 512 MiB。")
    return path


def _linked(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


class SpriteAtlasAPI:
    def __init__(self, store, directory, *, popen=None, blender=None, timeout=TIMEOUT):
        self.store = store
        self.root = Path(directory).absolute()
        self.popen = popen or subprocess.Popen
        self.blender = blender
        self.timeout = timeout
        self.jobs = {}
        self.lock = threading.RLock()
        self.wake = threading.Event()
        self.closed = threading.Event()
        self.thread = None

    def status(self):
        path = self.blender or find_blender()
        return {"available": path is not None, "blenderPath": str(path) if path else None, "backend": "blender-cpu", "message": "Blender CPU 渲染可用。" if path else "未找到 Blender。请指定 H3_BLENDER_PATH；不会自动安装。"}

    def active_count(self):
        with self.lock:
            return sum(j["status"] not in TERMINAL for j in self.jobs.values())

    def _safe_root(self):
        for component in (self.root, *self.root.parents):
            try:
                linked = _linked(component)
            except FileNotFoundError:
                continue
            if linked:
                raise StoreError("SPRITE_STORAGE", "精灵图输出目录不能使用链接或重解析路径。", 503)
        self.root = self.root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _directory(self, job):
        self._safe_root()
        path = self.root / job["id"]
        if not JOB_ID.fullmatch(job["id"]) or path.resolve().parent != self.root or not path.is_dir() or _linked(path):
            raise StoreError("SPRITE_STORAGE", "精灵图任务路径无效。", 503)
        return path

    def _file(self, job, name):
        path = self._directory(job) / name
        if path.resolve().parent != path.parent or not path.is_file() or _linked(path) or path.stat().st_nlink != 1:
            raise StoreError("SPRITE_STORAGE", "精灵图输出文件无效。", 503)
        return path

    def _authorize(self, project_id, node_id, revision=None, *, require_node=True):
        if not isinstance(project_id, str) or not isinstance(node_id, str):
            raise StoreError("BAD_REQUEST", "缺少项目或节点 ID。")
        path = self.store._project_path(project_id)
        self.store._require_writable(path)
        lock_path = path.parent / ".lock"
        if (lock_path, self.store.owner_id) not in self.store._held:
            raise StoreError("READ_ONLY", "请在当前实例中以可写方式打开项目。", 403)
        try:
            owner = json.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            owner = {}
        if owner.get("owner") != self.store.owner_id or owner.get("pid") != os.getpid():
            raise StoreError("LOCKED", "项目写入锁已改变。", 423)
        document = self.store.get(project_id)
        if revision is not None and (type(revision) is not int or revision != document["revision"]):
            raise StoreError("REVISION_CONFLICT", "项目已更新，请先保存后重新提交。", 409)
        if require_node and not any(n.get("id") == node_id and n.get("type") == "spriteAtlas" for n in document.get("canvas", {}).get("nodes", [])):
            raise StoreError("NOT_FOUND", "请先保存当前精灵图节点。", 404)
        return document

    @staticmethod
    def _snapshot(job):
        result = {k: job[k] for k in ("id", "projectId", "nodeId", "status", "createdAt")}
        if job.get("error"):
            result["error"] = job["error"]
        if job["status"] == "done":
            result["files"] = {k: f'/api/sprite-atlas/jobs/{job["id"]}/files/{name}' for k, name in FILES.items()}
        return result

    def _persist(self, job):
        atomic_write_json(self._directory(job) / "job.json", self._snapshot(job))

    def create(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"projectId", "revision", "nodeId", "inputPath", "options"}:
            raise StoreError("BAD_REQUEST", "精灵图任务字段无效。")
        if type(payload["revision"]) is not int or payload["revision"] < 1:
            raise StoreError("BAD_REQUEST", "必须提供已保存项目的有效 revision。")
        self._authorize(payload["projectId"], payload["nodeId"], payload["revision"])
        options = validate_options(payload["options"])
        source = validate_input(payload["inputPath"])
        blender = self.blender or find_blender()
        if blender is None:
            raise StoreError("BLENDER_MISSING", "未找到 Blender；未安装或下载任何软件。", 503)
        with self.lock:
            if self.closed.is_set():
                raise StoreError("SPRITE_CLOSED", "精灵图服务正在关闭。", 503)
            if sum(j["status"] not in TERMINAL for j in self.jobs.values()) >= MAX_QUEUE:
                raise StoreError("SPRITE_QUEUE_FULL", "本机精灵图队列已满，请等待已有任务完成。", 429)
            self._safe_root()
            job_id = "spa_" + uuid.uuid4().hex
            directory = self.root / job_id
            directory.mkdir()
            job = {"id": job_id, "projectId": payload["projectId"], "nodeId": payload["nodeId"], "status": "queued", "createdAt": time.time(), "cancel": threading.Event(), "blender": str(blender)}
            atomic_write_json(directory / "request.json", {"inputPath": str(source), "outputDir": str(directory), **options})
            self.jobs[job_id] = job
            self._persist(job)
            # Compact only terminal in-memory entries; durable exports remain.
            if len(self.jobs) > MAX_HISTORY:
                for old_id, old in list(self.jobs.items()):
                    if old["status"] in TERMINAL and old_id != job_id:
                        del self.jobs[old_id]
                        break
            if not self.thread or not self.thread.is_alive():
                self.thread = threading.Thread(target=self._loop, name="sprite-atlas-cpu", daemon=True)
                self.thread.start()
            self.wake.set()
            return self._snapshot(job)

    def _get(self, job_id):
        if not JOB_ID.fullmatch(job_id):
            raise StoreError("NOT_FOUND", "精灵图任务不存在。", 404)
        with self.lock:
            if job_id in self.jobs:
                return self.jobs[job_id]
            path = self.root / job_id / "job.json"
            try:
                probe = {"id": job_id}
                path = self._file(probe, "job.json")
                job = json.loads(path.read_text(encoding="utf-8"))
                if job.get("id") != job_id or job.get("status") not in TERMINAL | {"queued", "running"}:
                    raise ValueError()
                job["cancel"] = threading.Event()
                if job["status"] not in TERMINAL:
                    job.update(status="error", error="上次渲染被中断，请重新提交。")
                    self._persist(job)
                return job
            except (OSError, ValueError, KeyError):
                raise StoreError("NOT_FOUND", "精灵图任务不存在。", 404) from None

    def get(self, job_id):
        return self._snapshot(self._get(job_id))

    def cancel(self, job_id):
        job = self._get(job_id)
        # Deleting a node may be saved before its cancellation request arrives.
        # The original project's actual writable lock remains the authority.
        self._authorize(job["projectId"], job["nodeId"], require_node=False)
        with self.lock:
            if job["status"] in TERMINAL:
                return self._snapshot(job)
            job["cancel"].set()
            process = job.get("process")
            if process:
                self._stop_process(process)
            job.update(status="cancelled", error="精灵图渲染已取消。")
            self._persist(job)
            return self._snapshot(job)

    @staticmethod
    def _stop_process(process):
        if process.poll() is not None:
            return
        try:
            parent = psutil.Process(process.pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except psutil.NoSuchProcess:
                    pass
        except (psutil.Error, AttributeError, ValueError):
            pass
        try:
            process.kill()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            pass

    def _verify_outputs(self, job):
        sizes = []
        for key in ("albedo", "normal"):
            path = self._file(job, FILES[key])
            if path.stat().st_size > 256 * 1024**2:
                raise ValueError("渲染文件超过支持大小。")
            with Image.open(path) as image:
                if image.format != "PNG" or image.mode != "RGBA" or max(image.size) > MAX_SIDE or image.width * image.height > MAX_PIXELS:
                    raise ValueError("渲染输出必须为范围内的 RGBA PNG。")
                image.verify()
                sizes.append(image.size)
        metadata = self._file(job, "atlas.json")
        if metadata.stat().st_size > 8 * 1024**2:
            raise ValueError("图集描述文件过大。")
        value = json.loads(metadata.read_text(encoding="utf-8"))
        if sizes[0] != sizes[1] or value.get("schema") != "refmuse.sprite-atlas.v1" or value.get("size") != dict(zip(("width", "height"), sizes[0])):
            raise ValueError("颜色、法线图集或 JSON 布局不一致。")

    def _renderer_error(self, job):
        """Read a bounded structured error, never expose the whole render log."""
        try:
            with self._file(job, "render.log").open("rb") as log:
                log.seek(0, os.SEEK_END)
                log.seek(max(0, log.tell() - 16 * 1024))
                lines = log.read(16 * 1024).decode("utf-8", errors="replace").splitlines()
            for line in reversed(lines):
                if line.startswith("SPRITE_ATLAS_ERROR="):
                    message = line.partition("=")[2].strip()[:500]
                    return f"Blender 渲染失败：{message}" if message else None
        except (OSError, StoreError):
            return None
        return None

    def _run(self, job):
        process = None
        try:
            self._authorize(job["projectId"], job["nodeId"])
            directory = self._directory(job)
            with self.lock:
                if job["cancel"].is_set():
                    return
            command = [job["blender"], "--background", "--factory-startup", "--disable-autoexec", "--threads", "2", "--python-exit-code", "1", "--python", str(Path(__file__).resolve().parent / "scripts" / "blender_sprite_atlas.py"), "--", "--request", str(directory / "request.json")]
            environment = {**os.environ, "CUDA_VISIBLE_DEVICES": "", "HIP_VISIBLE_DEVICES": "", "ONEAPI_DEVICE_SELECTOR": "*:cpu"}
            with (directory / "render.log").open("wb") as log:
                with self.lock:
                    if job["cancel"].is_set() or self.closed.is_set():
                        return
                    process = self.popen(command, cwd=directory, stdout=log, stderr=subprocess.STDOUT, env=environment, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    job["process"] = process
                    job["status"] = "running"
                    self._persist(job)
                deadline = time.monotonic() + self.timeout
                while process.poll() is None:
                    if job["cancel"].wait(0.15) or self.closed.is_set():
                        self._stop_process(process)
                        break
                    if time.monotonic() >= deadline:
                        self._stop_process(process)
                        raise TimeoutError("Blender 渲染超过 30 分钟，已停止本任务进程。")
                    if (directory / "render.log").stat().st_size > 16 * 1024**2:
                        self._stop_process(process)
                        raise ValueError("Blender 日志超过 16 MiB，已停止本任务进程。")
                if job["cancel"].is_set() or self.closed.is_set():
                    with self.lock:
                        job.update(status="cancelled", error="精灵图渲染已取消。")
                        self._persist(job)
                    return
                if process.returncode != 0:
                    raise ValueError(self._renderer_error(job) or "Blender 渲染失败，请检查本任务 render.log；原节点与已有输出已保留。")
            self._verify_outputs(job)
            with self.lock:
                if not job["cancel"].is_set():
                    job.update(status="done")
                    self._persist(job)
        except Exception as exc:
            with self.lock:
                if job["status"] != "cancelled":
                    job.update(status="error", error=str(exc)[:1000])
                    self._persist(job)
        finally:
            if process and process.poll() is None:
                self._stop_process(process)
            with self.lock:
                job.pop("process", None)

    def _loop(self):
        while not self.closed.is_set():
            with self.lock:
                job = next((j for j in self.jobs.values() if j["status"] == "queued"), None)
            if job:
                self._run(job)
            else:
                self.wake.wait(0.5)
                self.wake.clear()

    def close(self):
        self.closed.set()
        self.wake.set()
        with self.lock:
            for job in self.jobs.values():
                if job["status"] not in TERMINAL:
                    job["cancel"].set()
                    if job.get("process"):
                        self._stop_process(job["process"])
                    job.update(status="cancelled", error="工作台关闭，精灵图渲染已取消。")
                    self._persist(job)
        if self.thread:
            self.thread.join(timeout=6)

    def file(self, job_id, name):
        if name not in FILES.values():
            raise StoreError("NOT_FOUND", "精灵图输出不存在。", 404)
        job = self._get(job_id)
        if job["status"] != "done":
            raise StoreError("SPRITE_NOT_DONE", "渲染尚未成功，无可下载成品。", 409)
        return self._file(job, name)

    @staticmethod
    def _json(handler):
        try:
            length = int(handler.headers.get("Content-Length", "0"))
            if not 0 < length <= 64 * 1024:
                raise ValueError()
            value = json.loads(handler.rfile.read(length).decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise StoreError("BAD_REQUEST", "精灵图请求必须是有界 JSON 对象。") from None

    def handle(self, handler, method, path):
        if not path.startswith("/api/sprite-atlas/"):
            return False
        try:
            match = re.fullmatch(r"/api/sprite-atlas/jobs/(spa_[0-9a-f]{32})(?:/(cancel|files/(?:albedo\.png|normal\.png|atlas\.json)))?", path)
            if method == "GET" and path == "/api/sprite-atlas/status":
                handler.send_json(200, self.status())
            elif method == "POST" and path == "/api/sprite-atlas/jobs":
                handler.send_json(202, self.create(self._json(handler)))
            elif match and method == "GET" and not match[2]:
                handler.send_json(200, self.get(match[1]))
            elif match and method == "POST" and match[2] == "cancel":
                self._json(handler)
                handler.send_json(200, self.cancel(match[1]))
            elif match and method == "GET" and match[2] and match[2].startswith("files/"):
                file = self.file(match[1], match[2].split("/")[1])
                handler.send_response(200)
                handler.send_header("Content-Type", mimetypes.guess_type(file.name)[0] or "application/octet-stream")
                handler.send_header("Content-Length", str(file.stat().st_size))
                handler.send_header("Content-Disposition", f'inline; filename="{file.name}"')
                handler.send_header("Cache-Control", "private, max-age=31536000, immutable")
                handler.end_headers()
                with file.open("rb") as source:
                    shutil.copyfileobj(source, handler.wfile, 1024 * 1024)
            else:
                handler.send_json(404, {"code": "NOT_FOUND", "message": "精灵图接口不存在。"})
        except StoreError as error:
            handler.send_json(error.status, {"code": error.code, "message": error.message, "details": error.details})
        except (OSError, ValueError):
            handler.send_json(500, {"code": "SPRITE_STORAGE", "message": "精灵图文件服务失败，请检查输出目录。"})
        return True
