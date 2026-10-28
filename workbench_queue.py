from __future__ import annotations

import copy
import json
import queue
import threading
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from workbench_lifecycle import atomic_write_json, runtime_dir, utc_now

TERMINAL = {"done", "error", "cancelled"}
ACTIVE = {"running", "finishing"}


def _error(code, message, suggestion=None):
    return {"code": code, "message": str(message), "suggestion": suggestion or "检查 ComfyUI 状态和生成参数后重试。"}


def _public(job):
    hidden = {"workflow", "clientId"}
    return {key: copy.deepcopy(value) for key, value in job.items() if key not in hidden}


class ComfyQueueAdapter:
    def __init__(self, origin="http://127.0.0.1:8188", timeout=10):
        self.origin = origin.rstrip("/")
        self.timeout = timeout

    def _request(self, path, payload=None, timeout=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(self.origin + path, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
            return json.load(response)

    def submit(self, workflow, client_id):
        return self._request("/prompt", {"prompt": workflow, "client_id": client_id})["prompt_id"]

    def cancel(self, prompt_id):
        self._request("/interrupt", {})
        self._request("/queue", {"delete": [prompt_id]})

    def poll(self, prompt_id):
        history = self._request(f"/history/{prompt_id}")
        entry = history.get(prompt_id)
        if not entry:
            return {"status": "running"}
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            messages = status.get("messages") or []
            return {"status": "error", "progress": 100, "history": entry, "error": _error("COMFY_EXECUTION_FAILED", messages or "ComfyUI 执行失败。")}
        if status.get("completed") or status.get("status_str") == "success":
            return {"status": "done", "progress": 100, "history": entry, "outputs": entry.get("outputs") or {}}
        return {"status": "finishing", "history": entry}


class QueueManager:
    def __init__(self, path=None, adapter=None, concurrency=1, poll_interval=0.5):
        self.path = Path(path or runtime_dir() / "queue.json")
        self.adapter = adapter or ComfyQueueAdapter()
        self.concurrency = self._concurrency(concurrency)
        self.poll_interval = poll_interval
        self.jobs = []
        self.paused = False
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._listeners = set()
        self._event_id = 0
        self._load()

    @staticmethod
    def _concurrency(value):
        value = int(value)
        if value not in (1, 2):
            raise ValueError("队列并发只能设置为 1 或 2。")
        return value

    def _load(self):
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
                raise ValueError("queue.json 缺少 jobs。")
            self.jobs = data["jobs"]
            self.paused = bool(data.get("paused", False))
            self.concurrency = self._concurrency(data.get("concurrency", self.concurrency))
            for job in self.jobs:
                if job.get("status") in ACTIVE and not job.get("comfyPromptId"):
                    job["status"] = "queued"
        except FileNotFoundError:
            self.jobs = []
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"queue.json 无法恢复，已停止启动以避免重复生成：{exc}") from exc

    def start(self):
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(target=self._run, name="h3-queue", daemon=True)
            self._thread.start()

    def stop(self, timeout=5):
        self._stop.set()
        thread = self._thread
        if thread and thread.is_alive():
            thread.join(timeout)
        with self._lock:
            self._persist_locked()

    def snapshot(self):
        with self._lock:
            return {"jobs": [_public(job) for job in self.jobs], "paused": self.paused, "concurrency": self.concurrency}

    def get(self, job_id):
        with self._lock:
            job = self._find_locked(job_id)
            return _public(job)

    def enqueue(self, payload):
        workflow = payload.get("workflow")
        if not isinstance(workflow, dict) or not workflow:
            raise ValueError("入队任务缺少有效 ComfyUI 工作流。")
        now = utc_now()
        job = {
            "id": f"job_{uuid.uuid4().hex}",
            "projectId": payload.get("projectId"),
            "nodeId": payload.get("nodeId"),
            "shotId": payload.get("shotId"),
            "status": "queued",
            "progress": 0,
            "eta": None,
            "priority": int(payload.get("priority", 0)),
            "createdAt": now,
            "updatedAt": now,
            "startedAt": None,
            "finishedAt": None,
            "comfyPromptId": None,
            "error": None,
            "outputs": None,
            "history": None,
            "attempts": 0,
            "workflow": copy.deepcopy(workflow),
            "clientId": str(payload.get("clientId") or uuid.uuid4()),
        }
        with self._lock:
            self.jobs.append(job)
            self._changed_locked("job.queued", job)
            return _public(job)

    def pause(self, value=True):
        with self._lock:
            self.paused = bool(value)
            self._changed_locked("queue.paused" if self.paused else "queue.resumed", None)

    def set_concurrency(self, value):
        with self._lock:
            self.concurrency = self._concurrency(value)
            self._changed_locked("queue.concurrency", None)

    def set_priority(self, job_id, priority):
        with self._lock:
            job = self._find_locked(job_id)
            if job["status"] != "queued":
                raise ValueError("只有等待中的任务可以调整优先级。")
            job["priority"] = int(priority)
            self._changed_locked("job.priority", job)
            return _public(job)

    def cancel(self, job_id):
        with self._lock:
            job = self._find_locked(job_id)
            if job["status"] in TERMINAL:
                return _public(job)
            prompt_id = job.get("comfyPromptId")
        if prompt_id:
            self.adapter.cancel(prompt_id)
        with self._lock:
            job["status"] = "cancelled"
            job["finishedAt"] = utc_now()
            job["error"] = None
            self._changed_locked("job.cancelled", job)
            return _public(job)

    def retry(self, job_id):
        with self._lock:
            job = self._find_locked(job_id)
            if job["status"] not in TERMINAL:
                raise ValueError("任务尚未结束，不能重试。")
            job.update({"status": "queued", "progress": 0, "eta": None, "startedAt": None, "finishedAt": None,
                        "comfyPromptId": None, "error": None, "outputs": None, "history": None})
            self._changed_locked("job.retry", job)
            return _public(job)

    def clear_completed(self):
        with self._lock:
            retained = [job for job in self.jobs if job["status"] not in TERMINAL]
            removed = len(self.jobs) - len(retained)
            self.jobs = retained
            if removed:
                self._changed_locked("queue.cleared", None)
            return removed

    def subscribe(self):
        listener = queue.Queue(maxsize=200)
        with self._lock:
            self._listeners.add(listener)
        return listener

    def unsubscribe(self, listener):
        with self._lock:
            self._listeners.discard(listener)

    def _find_locked(self, job_id):
        for job in self.jobs:
            if job["id"] == job_id:
                return job
        raise KeyError(job_id)

    def _persist_locked(self):
        atomic_write_json(self.path, {"concurrency": self.concurrency, "paused": self.paused, "jobs": self.jobs})

    def _changed_locked(self, event_type, job):
        job_to_write = copy.deepcopy(job) if job else None
        if job:
            job["updatedAt"] = utc_now()
        self._persist_locked()
        self._event_id += 1
        event = {"id": self._event_id, "type": event_type, "job": _public(job_to_write) if job_to_write else None}
        for listener in list(self._listeners):
            try:
                listener.put_nowait(event)
            except queue.Full:
                try:
                    listener.get_nowait()
                    listener.put_nowait(event)
                except queue.Empty:
                    pass

    def _run(self):
        while not self._stop.is_set():
            submissions = []
            with self._lock:
                if not self.paused:
                    active_count = sum(job["status"] in ACTIVE for job in self.jobs)
                    slots = max(0, self.concurrency - active_count)
                    waiting = sorted((job for job in self.jobs if job["status"] == "queued"),
                                     key=lambda job: (-job["priority"], job["createdAt"]))
                    for job in waiting[:slots]:
                        job["status"] = "running"
                        job["startedAt"] = job["startedAt"] or utc_now()
                        job["attempts"] += 1
                        submissions.append(job)
                        self._changed_locked("job.started", job)
                active = [job for job in submissions or self.jobs if job["status"] in ACTIVE]

            for job in submissions:
                try:
                    prompt_id = self.adapter.submit(job["workflow"], job["clientId"])
                    with self._lock:
                        if job["status"] in TERMINAL:
                            continue
                        job["comfyPromptId"] = prompt_id
                        self._changed_locked("job.submitted", job)
                except Exception as exc:
                    with self._lock:
                        job["status"] = "error"
                        job["finishedAt"] = utc_now()
                        job["error"] = self._submission_error(exc)
                        self._changed_locked("job.error", job)

            for job in active:
                prompt_id = job.get("comfyPromptId")
                if not prompt_id or job["status"] in TERMINAL or self._stop.is_set():
                    continue
                try:
                    update = self.adapter.poll(prompt_id)
                except (OSError, urllib.error.URLError, TimeoutError):
                    continue
                with self._lock:
                    if job["status"] in TERMINAL:
                        continue
                    for key in ("progress", "eta", "outputs", "history", "error"):
                        if key in update:
                            job[key] = update[key]
                    status = update.get("status")
                    if status in ACTIVE | TERMINAL:
                        job["status"] = status
                    if status in TERMINAL:
                        job["finishedAt"] = utc_now()
                        if status == "done":
                            job["progress"] = 100
                    self._changed_locked(f"job.{status or 'progress'}", job)
            self._stop.wait(self.poll_interval)

    @staticmethod
    def _submission_error(exc):
        text = str(exc)
        if "out of memory" in text.lower() or "oom" in text.lower():
            return _error("OOM", text, "降低分辨率、时长或并发的生成任务后，使用相同配方重试。")
        return _error("COMFY_SUBMIT_FAILED", text, "确认 ComfyUI 在线、模型与节点完整后重试。")
