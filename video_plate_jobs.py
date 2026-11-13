"""Jobs for the green-screen white-model plate.

Segmentation goes to local ComfyUI through the official SAM3 graph. The
composite itself stays in this process, like the chroma node, and never
edits project.json. Tests inject a segmenter that returns a mask file.
"""
from __future__ import annotations

import re
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path

from project_store import StoreError
from video_edit_document import EditDocumentError
from video_edit_ffmpeg import Cancelled, FFmpegError, Runner, probe
from video_plate_document import PlateDocumentError, normalize_plate_document
from video_plate_ffmpeg import inspect_video, render_plate
from video_plate_sam3 import ComfySam3Segmenter, PlateSegmentError

JOB_ID = re.compile(r"vwp_[a-f0-9]{32}")
PROJECT_ID = re.compile(r"prj_[A-Za-z0-9_-]{1,96}")
NODE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
VIDEO_PATH = re.compile(r"assets/[a-f0-9]{64}\.(mp4|mov|webm)", re.IGNORECASE)
MIN_FREE_BYTES = 1024 ** 3
TERMINAL = {"completed", "failed", "cancelled"}


def _bad(message):
    return StoreError("BAD_REQUEST", message)


def _document_error(error):
    return StoreError("PLATE_DOCUMENT_INVALID", str(error), 400)


class VideoPlateJobs:
    def __init__(self, root, store, *, runner_factory=Runner, segmenter=None, comfy_url="http://127.0.0.1:8188", max_jobs=64):
        self.root = Path(root)
        self.store = store
        self.runner_factory = runner_factory
        self.segmenter = segmenter or ComfySam3Segmenter(comfy_url)
        self.max_jobs = max_jobs
        self.jobs, self.runners = {}, {}
        self.lock = threading.RLock()
        self.wake = threading.Condition(self.lock)
        self.worker = None

    def _asset(self, project_id, relative):
        if not isinstance(relative, str) or not VIDEO_PATH.fullmatch(relative):
            raise _bad("视频只接受当前项目内的素材路径（assets/<sha256>.<ext>）。")
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
            raise StoreError("PLATE_DOCUMENT_INVALID", "settings 必须是对象。", 400)
        try:
            return normalize_plate_document(settings)
        except PlateDocumentError as error:
            raise _document_error(error) from error

    def submit(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"projectId", "nodeId", "video", "settings"}:
            raise _bad("绿幕白模作业字段无效。")
        project_id, node_id = self._identity(payload)
        document = self._settings(payload)
        video = self._asset(project_id, payload.get("video"))
        self.root.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
            raise StoreError("DISK_FULL", "作业目录可用空间不足 1 GB，未开始导出。", 507)
        job_id = f"vwp_{uuid.uuid4().hex}"
        job = {
            "id": job_id, "projectId": project_id, "nodeId": node_id, "status": "queued", "progress": 0.0,
            "stage": "排队中", "error": None, "result": None, "createdAt": time.time(), "video": payload.get("video"),
        }
        with self.lock:
            active = [item for item in self.jobs.values() if item["nodeId"] == node_id and item["projectId"] == project_id and item["status"] not in TERMINAL]
            if active:
                raise StoreError("VIDEO_PLATE_BUSY", "此绿幕白模节点已有导出作业，请等待或取消。", 409, {"jobId": active[0]["id"]})
            self._trim()
            self.jobs[job_id] = {**job, "_document": document, "_video": video}
            self.wake.notify_all()
            if not self.worker or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._loop, name="video-plate-jobs", daemon=True)
                self.worker.start()
        return self.get(job_id)

    def _trim(self):
        finished = sorted((job for job in self.jobs.values() if job["status"] in TERMINAL), key=lambda job: job["createdAt"])
        while len(self.jobs) >= self.max_jobs and finished:
            old = finished.pop(0)
            shutil.rmtree(self.root / old["id"], ignore_errors=True)
            del self.jobs[old["id"]]
        if len(self.jobs) >= self.max_jobs:
            raise StoreError("VIDEO_PLATE_CAPACITY", "绿幕白模作业过多，请稍后再试。", 429)

    def _job(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise _bad("jobId 无效。")
        job = self.jobs.get(job_id)
        if not job:
            raise StoreError("NOT_FOUND", "绿幕白模作业不存在（工作台可能已重启）。", 404)
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
                raise StoreError("VIDEO_PLATE_NOT_READY", "导出尚未完成。", 409)
            output = self.root / job_id / "output.mp4"
        revision = payload["revision"]
        if type(revision) is not int or revision < 1:
            raise _bad("revision 无效。")
        with output.open("rb") as source:
            saved = self.store.put_asset(job["projectId"], f"video-plate-{job_id[4:16]}.mp4", source, "video/mp4", expected_revision=revision)
        with self.lock:
            job["committedAsset"] = saved["asset"]["path"]
        return saved

    def output_file(self, job_id):
        with self.lock:
            job = self._job(job_id)
            if job["status"] != "completed":
                raise StoreError("VIDEO_PLATE_NOT_READY", "导出尚未完成。", 409)
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

    def _cancelled(self, job):
        def check():
            with self.lock:
                return job["status"] != "running" or job["stage"] == "正在取消"
        return check

    def _run(self, job, runner):
        workdir = self.root / job["id"]
        workdir.mkdir(parents=True, exist_ok=True)
        try:
            info = inspect_video(runner, job["_video"])
            mask = self.segmenter(job["_video"], job["_document"], info, workdir, self._progress(job), self._cancelled(job))
            target = workdir / "output.part.mp4"
            result = render_plate(runner, job["_document"], job["_video"], mask, target, self._progress(job))
            final = workdir / "output.mp4"
            target.replace(final)
            check = probe(runner, final)
            if check["frameCount"] != result["frames"] or check["width"] != result["width"] or check["height"] != result["height"]:
                raise FFmpegError(
                    f"成片校验失败：期望 {result['frames']} 帧 {result['width']}×{result['height']}，"
                    f"实际 {check['frameCount']} 帧 {check['width']}×{check['height']}。"
                )
            result["bytes"] = final.stat().st_size
            with self.lock:
                if job["stage"] == "正在取消":
                    job.update(status="cancelled", stage="已取消")
                else:
                    job.update(status="completed", progress=1.0, stage="已导出", result=result)
        except Cancelled:
            with self.lock:
                job.update(status="cancelled", stage="已取消")
        except (PlateDocumentError, EditDocumentError, FFmpegError, PlateSegmentError) as error:
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

    def wait(self, job_id, timeout=180):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.get(job_id)["status"] in TERMINAL:
                return self.get(job_id)
            time.sleep(0.05)
        raise TimeoutError(job_id)
