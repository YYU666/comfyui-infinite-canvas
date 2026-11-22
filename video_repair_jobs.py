"""Bounded local CPU jobs. The canvas alone attaches committed output assets."""
from __future__ import annotations

import base64
import re
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from project_store import StoreError
from video_edit_document import EditDocumentError
from video_edit_ffmpeg import Cancelled, FFmpegError, Runner
from video_repair_document import RepairDocumentError, normalize_preview_request, normalize_repair_document
from video_repair_ffmpeg import MAX_OUTPUT_BYTES, render_export, render_preview

TERMINAL = {"completed", "failed", "cancelled"}
MIN_FREE_BYTES = 1024 ** 3
MAX_ROOT_BYTES = 2 * 1024 ** 3
JOB_ID = re.compile(r"vrp_[a-f0-9]{32}")


def bad(message):
    return StoreError("BAD_REQUEST", message)


class VideoRepairJobs:
    def __init__(self, root, store, *, runner_factory=Runner, max_jobs=16):
        self.root, self.store = Path(root), store
        self.runner_factory, self.max_jobs = runner_factory, max_jobs
        self.jobs, self.runners, self.previews = {}, {}, {}
        self.lock = threading.RLock()
        self.preview_slot = threading.BoundedSemaphore(1)
        self.closed = False
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-repair")

    def replace_store(self, store):
        with self.lock:
            if self.active_count():
                raise StoreError("VIDEO_EDIT_BUSY", "视频仍在导出，无法切换素材存储。", 409)
            # Completed jobs also belong to the old root and must never commit
            # into another root containing an identically named project.
            self.jobs.clear()
            self.store = store

    def active_count(self):
        with self.lock:
            return len(self.previews) + sum(job["status"] not in TERMINAL for job in self.jobs.values())

    def _request(self, payload, preview=False):
        allowed = {"projectId", "nodeId", "source", "settings"} | ({"time", "mode"} if preview else set())
        if not isinstance(payload, dict) or set(payload) - allowed:
            raise bad("局部修复请求字段无效。")
        for key, pattern in (("projectId", r"prj_[A-Za-z0-9_-]{1,96}"), ("nodeId", r"[A-Za-z0-9_-]{1,100}"),
                             ("source", r"assets/[a-f0-9]{64}\.(?:mp4|mov|webm)")):
            if not isinstance(payload.get(key), str) or not re.fullmatch(pattern, payload[key]):
                raise bad(f"{key} 无效；仅接受当前项目的素材。")
        try:
            document = normalize_repair_document(payload.get("settings"))
            request = normalize_preview_request(payload.get("time", 0), payload.get("mode", "repaired"))
        except RepairDocumentError as error:
            raise StoreError("REPAIR_DOCUMENT_INVALID", str(error)) from error
        # Both the manifest and the store's resolved asset path must agree.
        project = self.store.get(payload["projectId"])
        if not any(a.get("path") == payload["source"] for a in project.get("assets", [])):
            raise bad("素材未登记在当前项目。")
        source = self.store.asset_file(payload["projectId"], payload["source"])
        if source.stat().st_size > MAX_OUTPUT_BYTES:
            raise bad("局部修复输入不能超过 512 MiB。")
        return document, source, request

    def _job(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise bad("jobId 无效。")
        if job_id not in self.jobs:
            raise StoreError("NOT_FOUND", "作业不存在，可能已过期或服务已重启。", 404)
        return self.jobs[job_id]

    def get(self, job_id):
        with self.lock:
            return {k: v for k, v in self._job(job_id).items() if not k.startswith("_")}

    def _capacity(self):
        self.root.mkdir(parents=True, exist_ok=True)
        finished = sorted((j for j in self.jobs.values() if j["status"] in TERMINAL), key=lambda j: j["createdAt"])
        for job in finished:
            if len(self.jobs) < self.max_jobs and time.time() - job["createdAt"] <= 1800:
                continue
            path = self.root / job["id"]
            if path.exists() and not path.is_symlink():
                shutil.rmtree(path)
            del self.jobs[job["id"]]
        # Only server-generated job directories are eligible for cleanup.
        for path in self.root.iterdir():
            if not JOB_ID.fullmatch(path.name) or not path.is_dir() or path.is_symlink():
                continue
            job = self.jobs.get(path.name)
            if (job is None or job["status"] in TERMINAL) and time.time() - path.stat().st_mtime > 1800:
                shutil.rmtree(path)
                self.jobs.pop(path.name, None)
        active = sum(j["status"] not in TERMINAL for j in self.jobs.values())
        used = sum(p.stat().st_size for p in self.root.glob("vrp_*/*") if p.is_file())
        if active >= 4 or len(self.jobs) >= self.max_jobs:
            raise StoreError("VIDEO_REPAIR_CAPACITY", "作业已满，请等待或清理过期结果。", 429)
        reserve = (active + 1) * MAX_OUTPUT_BYTES
        if used + reserve > MAX_ROOT_BYTES or shutil.disk_usage(self.root).free < MIN_FREE_BYTES + reserve:
            raise StoreError("DISK_FULL", "局部修复缓存配额或磁盘空间不足。", 507)

    def submit(self, payload):
        # Bind source resolution and admission to one project-store epoch.
        with self.lock:
            document, source, _ = self._request(payload)
            with self.lock:
                if self.closed: raise StoreError("VIDEO_REPAIR_CLOSED", "视频修补服务正在关闭。", 503)
                if any(j["projectId"] == payload["projectId"] and j["nodeId"] == payload["nodeId"]
                       and j["status"] not in TERMINAL for j in self.jobs.values()):
                    raise StoreError("VIDEO_REPAIR_BUSY", "此节点已有修复作业。", 409)
                self._capacity()
                job_id = "vrp_" + uuid.uuid4().hex
                self.jobs[job_id] = {"id": job_id, "projectId": payload["projectId"], "nodeId": payload["nodeId"],
                                     "source": payload["source"], "status": "queued", "stage": "排队中", "progress": 0,
                                     "error": None, "result": None, "createdAt": time.time(),
                                     "_document": document, "_source": source}
                self.pool.submit(self._run, job_id)
            return self.get(job_id)

    def preview(self, payload):
        if not self.preview_slot.acquire(blocking=False):
            raise StoreError("VIDEO_REPAIR_BUSY", "已有预览正在处理。", 429)
        runner = None
        try:
            with self.lock:
                if self.closed: raise StoreError("VIDEO_REPAIR_CLOSED", "视频修补服务正在关闭。", 503)
                document, source, request = self._request(payload, preview=True)
                runner = self.runner_factory()
                self.previews[id(runner)] = runner
            rendered = render_preview(runner, document, source, **request)
            rendered["pngBase64"] = base64.b64encode(rendered.pop("png")).decode("ascii")
            return rendered
        except (RepairDocumentError, EditDocumentError, FFmpegError) as error:
            raise StoreError("REPAIR_PREVIEW_FAILED", str(error)[:600]) from error
        finally:
            if runner:
                runner.cancel()
            with self.lock:
                if runner: self.previews.pop(id(runner), None)
            self.preview_slot.release()

    def cancel(self, job_id, project_id):
        with self.lock:
            job = self._job(job_id)
            if project_id != job["projectId"]:
                raise StoreError("FORBIDDEN", "作业不属于此项目。", 403)
            if job["status"] == "queued":
                job.update(status="cancelled", stage="已取消")
            elif job["status"] == "running":
                job["stage"] = "正在取消"
                self.runners[job_id].cancel()
        return self.get(job_id)

    def commit(self, job_id, payload):
        if not isinstance(payload, dict) or set(payload) != {"projectId", "revision"}:
            raise bad("commit 只接受 projectId 与 revision。")
        if type(payload["revision"]) is not int or payload["revision"] < 1:
            raise bad("revision 无效。")
        # Hold the lock through asset save so pruning cannot race the file read.
        with self.lock:
            job = self._job(job_id)
            if job["projectId"] != payload["projectId"]:
                raise StoreError("FORBIDDEN", "作业不属于此项目。", 403)
            if job["status"] != "completed":
                raise StoreError("VIDEO_REPAIR_NOT_READY", "修复尚未完成。", 409)
            with (self.root / job_id / "output.mp4").open("rb") as source:
                saved = self.store.put_asset(job["projectId"], f"video-repair-{job_id[4:16]}.mp4", source,
                                            "video/mp4", expected_revision=payload["revision"])
            job["committedAsset"] = saved["asset"]["path"]
            return saved

    def _run(self, job_id):
        workdir = self.root / job_id
        runner = None
        watchdog = None
        stopped = threading.Event()
        failure = []
        try:
            with self.lock:
                job = self._job(job_id)
                if job["status"] != "queued":
                    return
                runner = self.runner_factory()
                self.runners[job_id] = runner
                job.update(status="running", stage="正在检查素材")
            workdir.mkdir(parents=True)

            def monitor():
                deadline = time.monotonic() + 240
                while not stopped.wait(1):
                    if time.monotonic() >= deadline or shutil.disk_usage(workdir).free < MIN_FREE_BYTES:
                        failure.append("处理超时或磁盘空间不足，已停止。")
                        runner.cancel()
                        return

            watchdog = threading.Thread(target=monitor, daemon=True)
            watchdog.start()

            def progress(value, stage):
                with self.lock:
                    job.update(progress=round(value, 4))
                    if job["stage"] != "正在取消":
                        job["stage"] = stage

            # Resolve again in case the project was moved or its asset removed in the queue.
            source = self.store.asset_file(job["projectId"], job["source"])
            target = workdir / "output.part.mp4"
            result = render_export(runner, job["_document"], source, target, progress)
            runner.check()
            if target.stat().st_size >= MAX_OUTPUT_BYTES:
                raise FFmpegError("输出超过 512 MiB 配额，未交付。")
            result["bytes"] = target.stat().st_size
            with self.lock:
                runner.check()
                target.replace(workdir / "output.mp4")
                job.update(status="completed", stage="局部修复完成", progress=1, result=result)
        except Cancelled:
            with self.lock:
                job.update(status="failed" if failure else "cancelled", stage="处理停止" if failure else "已取消",
                           error=failure[0] if failure else None)
        except (RepairDocumentError, EditDocumentError, FFmpegError, StoreError) as error:
            with self.lock:
                job.update(status="failed", stage="局部修复失败", error=str(error)[:600])
        except Exception as error:
            with self.lock:
                job.update(status="failed", stage="局部修复失败", error=f"内部错误：{type(error).__name__}")
        finally:
            stopped.set()
            if watchdog:
                watchdog.join(2)
            if runner:
                runner.cancel()
            with self.lock:
                self.runners.pop(job_id, None)
                if workdir.exists() and job["status"] != "completed":
                    shutil.rmtree(workdir)

    def wait(self, job_id, timeout=120):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            job = self.get(job_id)
            if job["status"] in TERMINAL:
                return job
            time.sleep(.05)
        raise TimeoutError(job_id)

    def close(self):
        with self.lock:
            self.closed = True
            for runner in self.previews.values(): runner.cancel()
            for job in self.jobs.values():
                if job["status"] not in TERMINAL:
                    self.cancel(job["id"], job["projectId"])
        self.pool.shutdown(wait=True, cancel_futures=True)
