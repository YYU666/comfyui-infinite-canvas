"""CPU jobs for the green-screen node. One worker thread, never the ComfyUI queue.

Preview renders a single PNG on the request thread so tuning does not wait
behind a full export. Export stays on the worker and can be cancelled on its own.
"""
from __future__ import annotations

import base64
import re
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path, PurePosixPath

from project_store import StoreError
from video_chroma_document import ChromaDocumentError, normalize_chroma_document, normalize_preview_request
from video_chroma_ffmpeg import render_export, render_preview
from video_edit_document import EditDocumentError
from video_edit_ffmpeg import Cancelled, FFmpegError, Runner, probe

JOB_ID = re.compile(r"vck_[a-f0-9]{32}")
PROJECT_ID = re.compile(r"prj_[A-Za-z0-9_-]{1,96}")
NODE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
FOREGROUND_PATH = re.compile(r"assets/[a-f0-9]{64}\.(mp4|mov|webm)", re.IGNORECASE)
BACKGROUND_PATH = re.compile(r"assets/[a-f0-9]{64}\.(mp4|mov|webm|png|jpg|jpeg|webp)", re.IGNORECASE)
MIN_FREE_BYTES = 1024 ** 3
TERMINAL = {"completed", "failed", "cancelled"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


def _bad(message):
    return StoreError("BAD_REQUEST", message)


def _document_error(error):
    return StoreError("CHROMA_DOCUMENT_INVALID", str(error), 400)


class VideoChromaJobs:
    def __init__(self, root, store, *, runner_factory=Runner, max_jobs=64):
        self.root = Path(root)
        self.store = store
        self.runner_factory = runner_factory
        self.max_jobs = max_jobs
        self.jobs, self.runners = {}, {}
        self.lock = threading.RLock()
        self.wake = threading.Condition(self.lock)
        self.worker = None

    def _asset(self, project_id, relative, pattern, label):
        if not isinstance(relative, str) or not pattern.fullmatch(relative):
            raise _bad(f"{label}只接受当前项目内的素材路径（assets/<sha256>.<ext>）。")
        return self.store.asset_file(project_id, relative)

    def _identity(self, payload):
        project_id, node_id = payload.get("projectId"), payload.get("nodeId")
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
            raise _bad("projectId 无效。")
        if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id):
            raise _bad("nodeId 无效。")
        return project_id, node_id

    def _settings(self, payload):
        settings = payload.get("settings")
        if not isinstance(settings, dict):
            raise StoreError("CHROMA_DOCUMENT_INVALID", "settings 必须是对象。", 400)
        try:
            return normalize_chroma_document(settings)
        except ChromaDocumentError as error:
            raise _document_error(error) from error

    def _sources(self, project_id, payload):
        foreground = self._asset(project_id, payload.get("foreground"), FOREGROUND_PATH, "前景")
        background_path = payload.get("background")
        background = self._asset(project_id, background_path, BACKGROUND_PATH, "背景")
        return foreground, background, PurePosixPath(str(background_path)).suffix.lower() in IMAGE_SUFFIXES

    def submit(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"projectId", "nodeId", "foreground", "background", "settings"}:
            raise _bad("绿幕扣像作业字段无效。")
        project_id, node_id = self._identity(payload)
        document = self._settings(payload)
        foreground, background, background_is_image = self._sources(project_id, payload)
        self.root.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
            raise StoreError("DISK_FULL", "作业目录可用空间不足 1 GB，未开始导出。", 507)
        job_id = f"vck_{uuid.uuid4().hex}"
        job = {"id": job_id, "projectId": project_id, "nodeId": node_id, "status": "queued", "progress": 0.0,
               "stage": "排队中", "error": None, "result": None, "createdAt": time.time(),
               "foreground": payload.get("foreground"), "background": payload.get("background")}
        with self.lock:
            active = [item for item in self.jobs.values() if item["nodeId"] == node_id and item["projectId"] == project_id and item["status"] not in TERMINAL]
            if active:
                raise StoreError("VIDEO_CHROMA_BUSY", "此绿幕节点已有导出作业，请等待或取消。", 409, {"jobId": active[0]["id"]})
            self._trim()
            self.jobs[job_id] = {**job, "_document": document, "_foreground": foreground, "_background": background, "_background_is_image": background_is_image}
            self.wake.notify_all()
            if not self.worker or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._loop, name="video-chroma-jobs", daemon=True)
                self.worker.start()
        return self.get(job_id)

    def preview(self, payload):
        """Synchronous single-frame PNG. Not queued, and it does not write project.json."""
        allowed = {"projectId", "nodeId", "foreground", "background", "settings", "time", "mode"}
        if not isinstance(payload, dict) or set(payload) - allowed:
            raise _bad("绿幕预览字段无效。")
        project_id, _node_id = self._identity(payload)
        document = self._settings(payload)
        try:
            request = normalize_preview_request(payload.get("time"), payload.get("mode"))
        except ChromaDocumentError as error:
            raise _document_error(error) from error
        foreground, background, background_is_image = self._sources(project_id, payload)
        runner = self.runner_factory()
        try:
            rendered = render_preview(runner, document, foreground, background, background_is_image, request["time"], request["mode"])
        except (ChromaDocumentError, EditDocumentError, FFmpegError) as error:
            raise StoreError("CHROMA_PREVIEW_FAILED", str(error)[:600], 400) from error
        finally:
            runner.cancel()
        return {
            "width": rendered["width"], "height": rendered["height"], "frame": rendered["frame"],
            "time": rendered["time"], "mode": rendered["mode"],
            "pngBase64": base64.b64encode(rendered["png"]).decode("ascii"),
        }

    def _trim(self):
        finished = sorted((job for job in self.jobs.values() if job["status"] in TERMINAL), key=lambda job: job["createdAt"])
        while len(self.jobs) >= self.max_jobs and finished:
            old = finished.pop(0)
            shutil.rmtree(self.root / old["id"], ignore_errors=True)
            del self.jobs[old["id"]]
        if len(self.jobs) >= self.max_jobs:
            raise StoreError("VIDEO_CHROMA_CAPACITY", "绿幕扣像作业过多，请稍后再试。", 429)

    def _job(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise _bad("jobId 无效。")
        job = self.jobs.get(job_id)
        if not job:
            raise StoreError("NOT_FOUND", "绿幕扣像作业不存在（工作台可能已重启）。", 404)
        return job

    def get(self, job_id):
        with self.lock:
            job = self._job(job_id)
            return {key: value for key, value in job.items() if not key.startswith("_")}

    def cancel(self, job_id, project_id=None):
        with self.lock:
            job = self._job(job_id)
            if project_id is not None and job["projectId"] != project_id:
                raise StoreError("FORBIDDEN", "作业不属于此项目。", 403)
            if job["status"] == "queued":
                job.update(status="cancelled", stage="已取消")
            elif job["status"] == "running":
                job["stage"] = "正在取消"
                runner = self.runners.get(job_id)
                if runner:
                    runner.cancel()
        return self.get(job_id)

    def commit(self, job_id, payload):
        if not isinstance(payload, dict) or set(payload) != {"projectId", "revision"}:
            raise _bad("commit 只接受 projectId 与 revision。")
        with self.lock:
            job = self._job(job_id)
            if job["projectId"] != payload["projectId"]:
                raise StoreError("FORBIDDEN", "作业不属于此项目。", 403)
            if job["status"] != "completed":
                raise StoreError("VIDEO_CHROMA_NOT_READY", "导出尚未完成。", 409)
            output = self.root / job_id / "output.mp4"
        revision = payload["revision"]
        if type(revision) is not int or revision < 1:
            raise _bad("revision 无效。")
        with output.open("rb") as source:
            saved = self.store.put_asset(job["projectId"], f"video-chroma-{job_id[4:16]}.mp4", source, "video/mp4", expected_revision=revision)
        with self.lock:
            job["committedAsset"] = saved["asset"]["path"]
        return saved

    def output_file(self, job_id):
        with self.lock:
            job = self._job(job_id)
            if job["status"] != "completed":
                raise StoreError("VIDEO_CHROMA_NOT_READY", "导出尚未完成。", 409)
            return self.root / job_id / "output.mp4"

    def _next(self):
        with self.lock:
            while True:
                queued = sorted((job for job in self.jobs.values() if job["status"] == "queued"), key=lambda job: job["createdAt"])
                if queued:
                    job = queued[0]
                    job.update(status="running", stage="正在探测素材", progress=0.01)
                    runner = self.runner_factory()
                    self.runners[job["id"]] = runner
                    return job, runner
                if not self.wake.wait(timeout=30):
                    return None, None

    def _loop(self):
        while True:
            job, runner = self._next()
            if job is None:
                with self.lock:
                    if not any(item["status"] == "queued" for item in self.jobs.values()):
                        self.worker = None
                        return
                continue
            self._run(job, runner)

    def _progress(self, job):
        def update(value, stage):
            with self.lock:
                if job["status"] == "running":
                    job["progress"] = round(min(max(value, 0), 1), 4)
                    if job["stage"] != "正在取消":
                        job["stage"] = stage
        return update

    def _run(self, job, runner):
        workdir = self.root / job["id"]
        workdir.mkdir(parents=True, exist_ok=True)
        try:
            target = workdir / "output.part.mp4"
            result = render_export(runner, job["_document"], job["_foreground"], job["_background"], job["_background_is_image"], target, self._progress(job))
            final = workdir / "output.mp4"
            target.replace(final)
            check = probe(runner, final)
            if check["frameCount"] != result["frames"] or check["width"] != result["width"] or check["height"] != result["height"]:
                raise FFmpegError(f"成片校验失败：期望 {result['frames']} 帧 {result['width']}×{result['height']}，实际 {check['frameCount']} 帧 {check['width']}×{check['height']}。")
            if result["width"] % 2 or result["height"] % 2:
                raise FFmpegError("成片宽高不是偶数。")
            result["bytes"] = final.stat().st_size
            with self.lock:
                job.update(status="completed", progress=1.0, stage="已导出", result=result)
        except Cancelled:
            with self.lock:
                job.update(status="cancelled", stage="已取消")
        except (ChromaDocumentError, EditDocumentError, FFmpegError) as error:
            with self.lock:
                job.update(status="failed", stage="导出失败", error=str(error)[:600])
        except Exception as error:
            traceback.print_exc()
            with self.lock:
                job.update(status="failed", stage="导出失败", error=f"内部错误：{type(error).__name__}")
        finally:
            with self.lock:
                self.runners.pop(job["id"], None)
            for leftover in workdir.glob("*"):
                if leftover.name != "output.mp4":
                    leftover.unlink(missing_ok=True)

    def wait(self, job_id, timeout=120):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.get(job_id)["status"] in TERMINAL:
                return self.get(job_id)
            time.sleep(0.05)
        raise TimeoutError(job_id)
