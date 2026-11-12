"""Background export jobs for the canvas video edit node (E1).

Jobs run FFmpeg on the CPU in one worker thread, never touch the ComfyUI queue
and never call a global interrupt.  Inputs are project asset paths resolved by
ProjectStore.asset_file (so arbitrary local paths are impossible).  The rendered
file stays in the job directory until the page commits it through
ProjectStore.put_asset with the page's current revision, exactly like a normal
asset upload; the node itself is then saved by the page, never by this module.
"""
from __future__ import annotations

import json
import re
import shutil
import threading
import time
import traceback
import uuid
from pathlib import Path

from project_store import StoreError
from video_edit_document import EditDocumentError, INPUT_SLOTS, normalize_document, plan, used_slots
from video_edit_ffmpeg import Cancelled, FFmpegError, Runner, probe, public_probe, render

JOB_ID = re.compile(r"ved_[a-f0-9]{32}")
PROJECT_ID = re.compile(r"prj_[A-Za-z0-9_-]{1,96}")
NODE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
ASSET_PATH = re.compile(r"assets/[a-f0-9]{64}\.(mp4|mov|webm|m4a|mp3|wav|aac)", re.IGNORECASE)
MIN_FREE_BYTES = 1024 ** 3
TERMINAL = {"completed", "failed", "cancelled"}


def _bad(message):
    return StoreError("BAD_REQUEST", message)


class VideoEditJobs:
    def __init__(self, root, store, *, runner_factory=Runner, max_jobs=64):
        self.root = Path(root)
        self.store = store
        self.runner_factory = runner_factory
        self.max_jobs = max_jobs
        self.jobs, self.runners = {}, {}
        self.lock = threading.RLock()
        self.wake = threading.Condition(self.lock)
        self.worker = None

    # ------------------------------------------------------------ validation
    def _asset(self, project_id, relative):
        if not isinstance(relative, str) or not ASSET_PATH.fullmatch(relative):
            raise _bad("只接受当前项目内的视频/音频素材路径（assets/<sha256>.<ext>）。")
        return self.store.asset_file(project_id, relative)

    def _identity(self, payload):
        project_id, node_id = payload.get("projectId"), payload.get("nodeId")
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
            raise _bad("projectId 无效。")
        if not isinstance(node_id, str) or not NODE_ID.fullmatch(node_id):
            raise _bad("nodeId 无效。")
        return project_id, node_id

    def probe_asset(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"projectId", "assetPath"}:
            raise _bad("probe 只接受 projectId 与 assetPath。")
        project_id = payload["projectId"]
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
            raise _bad("projectId 无效。")
        file = self._asset(project_id, payload["assetPath"])
        try:
            return public_probe(probe(self.runner_factory(), file))
        except (FFmpegError, EditDocumentError) as error:
            raise StoreError("VIDEO_PROBE_FAILED", str(error)[:400], 422) from error

    # ------------------------------------------------------------ lifecycle
    def submit(self, payload):
        if not isinstance(payload, dict) or set(payload) - {"projectId", "nodeId", "inputs", "document", "signature"}:
            raise _bad("视频编辑作业字段无效。")
        project_id, node_id = self._identity(payload)
        try:
            document = normalize_document(payload.get("document"))
        except EditDocumentError as error:
            raise StoreError("EDIT_DOCUMENT_INVALID", str(error), 400) from error
        inputs = payload.get("inputs")
        if not isinstance(inputs, dict) or not inputs or any(slot not in INPUT_SLOTS for slot in inputs):
            raise _bad("inputs 必须把输入端口映射到项目素材路径。")
        missing = [slot for slot in used_slots(document) if slot not in inputs]
        if missing:
            raise StoreError("EDIT_INPUT_MISSING", f"编辑文档引用了未连接的输入：{', '.join(missing)}。", 400)
        files = {slot: self._asset(project_id, inputs[slot]) for slot in used_slots(document)}
        signature = payload.get("signature")
        if signature is not None and (not isinstance(signature, str) or len(signature) > 200_000):
            raise _bad("signature 无效。")
        self.root.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(self.root).free < MIN_FREE_BYTES:
            raise StoreError("DISK_FULL", "作业目录可用空间不足 1 GB，未开始导出。", 507)
        job_id = f"ved_{uuid.uuid4().hex}"
        job = {"id": job_id, "projectId": project_id, "nodeId": node_id, "status": "queued", "progress": 0.0,
               "stage": "排队中", "error": None, "result": None, "createdAt": time.time(),
               "inputs": {slot: inputs[slot] for slot in files}, "signature": signature}
        with self.lock:
            active = [item for item in self.jobs.values() if item["nodeId"] == node_id and item["projectId"] == project_id and item["status"] not in TERMINAL]
            if active:
                raise StoreError("VIDEO_EDIT_BUSY", "此视频编辑节点已有导出作业，请等待或取消。", 409, {"jobId": active[0]["id"]})
            self._trim()
            self.jobs[job_id] = {**job, "_document": document, "_files": files}
            self.wake.notify_all()
            if not self.worker or not self.worker.is_alive():
                self.worker = threading.Thread(target=self._loop, name="video-edit-jobs", daemon=True)
                self.worker.start()
        return self.get(job_id)

    def _trim(self):
        finished = sorted((job for job in self.jobs.values() if job["status"] in TERMINAL), key=lambda job: job["createdAt"])
        while len(self.jobs) >= self.max_jobs and finished:
            old = finished.pop(0)
            shutil.rmtree(self.root / old["id"], ignore_errors=True)
            del self.jobs[old["id"]]
        if len(self.jobs) >= self.max_jobs:
            raise StoreError("VIDEO_EDIT_CAPACITY", "视频编辑作业过多，请稍后再试。", 429)

    def _job(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
            raise _bad("jobId 无效。")
        job = self.jobs.get(job_id)
        if not job:
            raise StoreError("NOT_FOUND", "视频编辑作业不存在（工作台可能已重启）。", 404)
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
                    runner.cancel()  # only this job's FFmpeg processes
        return self.get(job_id)

    def commit(self, job_id, payload):
        if not isinstance(payload, dict) or set(payload) != {"projectId", "revision"}:
            raise _bad("commit 只接受 projectId 与 revision。")
        with self.lock:
            job = self._job(job_id)
            if job["projectId"] != payload["projectId"]:
                raise StoreError("FORBIDDEN", "作业不属于此项目。", 403)
            if job["status"] != "completed":
                raise StoreError("VIDEO_EDIT_NOT_READY", "导出尚未完成。", 409)
            output = self.root / job_id / "output.mp4"
        revision = payload["revision"]
        if type(revision) is not int or revision < 1:
            raise _bad("revision 无效。")
        with output.open("rb") as source:
            saved = self.store.put_asset(job["projectId"], f"video-edit-{job_id[4:16]}.mp4", source, "video/mp4", expected_revision=revision)
        with self.lock:
            job["committedAsset"] = saved["asset"]["path"]
        return saved

    def output_file(self, job_id):
        with self.lock:
            job = self._job(job_id)
            if job["status"] != "completed":
                raise StoreError("VIDEO_EDIT_NOT_READY", "导出尚未完成。", 409)
            return self.root / job_id / "output.mp4"

    # ------------------------------------------------------------ worker
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
            files = job["_files"]
            probes = {}
            for slot, file in files.items():
                runner.check()
                probes[slot] = probe(runner, file)
            edit_plan = plan(job["_document"], probes)
            target = workdir / "output.part.mp4"
            result = render(runner, job["_document"], edit_plan, files, probes, target, workdir, self._progress(job))
            final = workdir / "output.mp4"
            target.replace(final)
            check = probe(runner, final)
            if check["frameCount"] != edit_plan["totalFrames"]:
                raise FFmpegError(f"成片校验失败：期望 {edit_plan['totalFrames']} 帧，实际 {check['frameCount']} 帧。")
            result["bytes"] = final.stat().st_size
            result["clips"] = [{"id": s["clip"]["id"], "timelineStartFrame": s["timelineStart"], "contentFrames": s["contentFrames"], "padFrames": s["padFrames"]} for s in edit_plan["segments"]]
            with self.lock:
                job.update(status="completed", progress=1.0, stage="已导出", result=result)
        except Cancelled:
            with self.lock:
                job.update(status="cancelled", stage="已取消")
        except (EditDocumentError, FFmpegError) as error:
            with self.lock:
                job.update(status="failed", stage="导出失败", error=str(error)[:600])
        except Exception as error:  # keep the worker alive; never leak paths
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
