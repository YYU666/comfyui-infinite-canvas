from __future__ import annotations

import copy
import datetime as dt
import json
import queue
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from outfit_queue import initial_state, stage_transfer, stage_workflow, validate_plan
from workbench_lifecycle import atomic_write_json, runtime_dir, utc_now

TERMINAL = {"done", "error", "cancelled"}
ACTIVE = {"running", "finishing"}


def _error(code, message, suggestion=None):
    return {"code": code, "message": str(message), "suggestion": suggestion or "检查 ComfyUI 状态和生成参数后重试。"}


def _public(job):
    hidden = {"workflow", "plan", "clientId"}
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

    def preflight(self, workflow):
        """Validate registered nodes and model choices without submitting or uploading."""
        object_info = self._request("/object_info", timeout=max(self.timeout, 15))
        missing_nodes = sorted({node.get("class_type") for node in workflow.values()
                                if node.get("class_type") not in object_info})
        if missing_nodes:
            raise ValueError(f"ComfyUI 未注册节点：{', '.join(missing_nodes)}")
        model_inputs = {"UNETLoader": "unet_name", "CLIPLoader": "clip_name", "VAELoader": "vae_name", "LoraLoaderModelOnly": "lora_name"}
        checked = []
        missing_models = []
        for node in workflow.values():
            class_type = node.get("class_type")
            field = model_inputs.get(class_type)
            if not field:
                continue
            value = node.get("inputs", {}).get(field)
            definition = object_info[class_type].get("input", {}).get("required", {}).get(field)
            choices = definition[0] if isinstance(definition, list) and definition and isinstance(definition[0], list) else None
            if choices is not None and value not in choices:
                missing_models.append(str(value))
            else:
                checked.append(str(value))
        if missing_models:
            raise ValueError(f"ComfyUI 缺少模型或 LoRA：{', '.join(sorted(set(missing_models)))}")
        return {"nodes": len(workflow), "models": checked}

    def cancel(self, prompt_id):
        current = self._request("/queue")

        def prompt_ids(key):
            return {str(item[1]) for item in current.get(key, []) if isinstance(item, (list, tuple)) and len(item) > 1}

        self._request("/queue", {"delete": [prompt_id]})
        if str(prompt_id) in prompt_ids("queue_running"):
            self._request("/interrupt", {})

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

    def download(self, file):
        query = urllib.parse.urlencode({"filename": file.get("filename", ""), "subfolder": file.get("subfolder", ""), "type": file.get("type", "output")})
        request = urllib.request.Request(f"{self.origin}/view?{query}")
        with urllib.request.urlopen(request, timeout=max(self.timeout, 60)) as response:
            return response.read()

    def upload_image(self, filename, content):
        boundary = f"----H3Workbench{uuid.uuid4().hex}"
        fields = {"type": "input", "subfolder": "workbench", "overwrite": "true"}
        body = bytearray()
        for key, value in fields.items():
            body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n".encode("utf-8"))
        safe_name = Path(filename).name
        body.extend(f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{safe_name}\"\r\nContent-Type: image/png\r\n\r\n".encode("utf-8"))
        body.extend(content)
        body.extend(f"\r\n--{boundary}--\r\n".encode("ascii"))
        request = urllib.request.Request(f"{self.origin}/upload/image", data=bytes(body), headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        with urllib.request.urlopen(request, timeout=max(self.timeout, 60)) as response:
            result = json.load(response)
        if not result.get("name"):
            raise ValueError("换装中间图上传失败。")
        return f"{result['subfolder']}/{result['name']}" if result.get("subfolder") else result["name"]

    def free(self):
        current = self._request("/queue")
        if current.get("queue_running") or current.get("queue_pending"):
            return False
        payload = json.dumps({"unload_models": True, "free_memory": True}).encode("utf-8")
        request = urllib.request.Request(f"{self.origin}/free", data=payload, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            response.read()
        return True


class QueueManager:
    def __init__(self, path=None, adapter=None, concurrency=1, poll_interval=0.5, job_timeout=60 * 60):
        self.path = Path(path or runtime_dir() / "queue.json")
        self.adapter = adapter or ComfyQueueAdapter()
        self.concurrency = self._concurrency(concurrency)
        self.poll_interval = poll_interval
        self.job_timeout = float(job_timeout)
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

    def _expired(self, job):
        if self.job_timeout <= 0 or not job.get("startedAt"):
            return False
        try:
            started = dt.datetime.fromisoformat(job["startedAt"])
            return (dt.datetime.now(dt.timezone.utc) - started).total_seconds() >= self.job_timeout
        except (TypeError, ValueError):
            return False

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
        plan = payload.get("plan")
        if plan is not None:
            plan = validate_plan(plan)
            workflow = None
        elif not isinstance(workflow, dict) or not workflow:
            raise ValueError("入队任务缺少有效 ComfyUI 工作流。")
        now = utc_now()
        job = {
            "id": f"job_{uuid.uuid4().hex}",
            "projectId": payload.get("projectId"),
            "nodeId": payload.get("nodeId"),
            "shotId": payload.get("shotId"),
            "kind": plan["kind"] if plan else "workflow",
            "status": "queued",
            "stage": "后台队列等待中",
            "progress": 0,
            "eta": None,
            "priority": int(payload.get("priority", 0)),
            "createdAt": now,
            "updatedAt": now,
            "startedAt": None,
            "finishedAt": None,
            "comfyPromptId": None,
            "cancelRequested": False,
            "error": None,
            "outputs": None,
            "history": None,
            "attempts": 0,
            "workflow": copy.deepcopy(workflow),
            "plan": plan,
            "planState": initial_state() if plan else None,
            "clientId": str(payload.get("clientId") or uuid.uuid4()),
        }
        with self._lock:
            if job["clientId"].startswith("agent:"):
                existing = next((item for item in self.jobs if item.get("clientId") == job["clientId"] and item.get("projectId") == job["projectId"]), None)
                if existing:
                    return _public(existing)
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
            # Persist intent before any network await. A prompt returned after
            # this point must still be registered and compensated by the worker.
            job["cancelRequested"] = True
            prompt_id = job.get("comfyPromptId")
            self._changed_locked("job.cancel_requested", job)
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
            job.update({"status": "queued", "stage": "后台队列等待中", "progress": 0, "eta": None, "startedAt": None, "finishedAt": None,
                        "comfyPromptId": None, "cancelRequested": False, "error": None, "outputs": None, "history": None,
                        "attempts": job.get("attempts", 0) + 1,
                        "planState": initial_state() if job.get("plan") else None})
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
                        job["attempts"] = max(1, job.get("attempts", 0))
                        if job.get("plan"):
                            panel = job["plan"]["panels"][job["planState"]["panelIndex"]]
                            count = len(job["plan"]["panels"])
                            job["stage"] = f"{'保留原图' if panel['preserve'] else '千问独立换装'} {job['planState']['panelIndex'] + 1}/{count} · {panel['label']}"
                        submissions.append(job)
                        self._changed_locked("job.started", job)
                active = [job for job in self.jobs if job["status"] in ACTIVE]
                submitted_ids = {id(job) for job in submissions}
                to_submit = submissions + [job for job in active if id(job) not in submitted_ids and job.get("plan") and not job.get("comfyPromptId")]

            for job in to_submit:
                submit_attempt = job["attempts"]
                try:
                    workflow = stage_workflow(job) if job.get("plan") else job["workflow"]
                    prompt_id = self.adapter.submit(workflow, job["clientId"])
                    with self._lock:
                        same_attempt = job["attempts"] == submit_attempt
                        needs_cancel = bool(job.get("cancelRequested") or job["status"] in TERMINAL or not same_attempt)
                        if same_attempt:
                            job["comfyPromptId"] = prompt_id
                        else:
                            job.setdefault("cancelledPromptIds", []).append(prompt_id)
                        if same_attempt and job.get("plan"):
                            job["planState"]["promptIds"].append(prompt_id)
                        elif same_attempt and not needs_cancel:
                            job["stage"] = "本地 GPU 生成中"
                        self._changed_locked("job.submitted", job)
                    if needs_cancel:
                        try:
                            self.adapter.cancel(prompt_id)
                        except Exception as exc:
                            with self._lock:
                                if same_attempt:
                                    job["status"] = "error"
                                    job["finishedAt"] = utc_now()
                                    job["error"] = _error("COMFY_CANCEL_FAILED", exc, "任务 ID 已保留，请在 ComfyUI 队列中确认该任务后重试取消。")
                                    self._changed_locked("job.error", job)
                except Exception as exc:
                    with self._lock:
                        if job["status"] in TERMINAL or job["attempts"] != submit_attempt:
                            continue
                        job["status"] = "error"
                        job["finishedAt"] = utc_now()
                        job["error"] = self._submission_error(exc)
                        self._changed_locked("job.error", job)

            for job in active:
                poll_attempt = job["attempts"]
                prompt_id = job.get("comfyPromptId")
                if not prompt_id or job["status"] in TERMINAL or self._stop.is_set():
                    continue
                if self._expired(job):
                    cancel_error = None
                    try:
                        self.adapter.cancel(prompt_id)
                    except Exception as exc:
                        cancel_error = str(exc)
                    with self._lock:
                        if job["status"] in TERMINAL or job["attempts"] != poll_attempt:
                            continue
                        message = f"任务超过 {int(self.job_timeout)} 秒仍未返回结果，已停止等待。"
                        if cancel_error:
                            message += f" 取消请求失败：{cancel_error}"
                        job["status"] = "error"
                        job["stage"] = "生成超时"
                        job["finishedAt"] = utc_now()
                        job["error"] = _error("COMFY_TIMEOUT", message, "检查 ComfyUI 是否仍在执行；降低分辨率、时长或换装视图数量后，使用相同配方重试。")
                        self._changed_locked("job.error", job)
                    continue
                try:
                    update = self.adapter.poll(prompt_id)
                except (OSError, urllib.error.URLError, TimeoutError):
                    continue
                outfit_done = bool(job.get("plan") and update.get("status") == "done")
                with self._lock:
                    if job["status"] in TERMINAL or job["attempts"] != poll_attempt:
                        continue
                    for key in ("progress", "eta", "outputs", "history", "error"):
                        if key in update:
                            job[key] = update[key]
                    status = update.get("status")
                    if not outfit_done:
                        if status in ACTIVE | TERMINAL:
                            job["status"] = status
                        if status in TERMINAL:
                            job["finishedAt"] = utc_now()
                            job["stage"] = "生成完成" if status == "done" else "生成失败"
                            if status == "done":
                                job["progress"] = 100
                        self._changed_locked(f"job.{status or 'progress'}", job)
                if outfit_done:
                    transfer_job = copy.deepcopy(job)
                    try:
                        patch = stage_transfer(transfer_job, self.adapter)
                    except Exception as exc:
                        patch = {"status": "error", "stage": "换装阶段失败", "error": _error("OUTFIT_STAGE_FAILED", exc, "检查中间图、ComfyUI 上传接口和磁盘空间后重试。")}
                    with self._lock:
                        if job["status"] in TERMINAL or job["attempts"] != poll_attempt:
                            continue
                        job.update(patch)
                        if job["status"] in TERMINAL:
                            job["finishedAt"] = utc_now()
                        self._changed_locked(f"job.{job['status'] if job['status'] in TERMINAL else 'progress'}", job)
            self._stop.wait(self.poll_interval)

    @staticmethod
    def _submission_error(exc):
        text = str(exc)
        if "out of memory" in text.lower() or "oom" in text.lower():
            return _error("OOM", text, "降低分辨率、时长或并发的生成任务后，使用相同配方重试。")
        return _error("COMFY_SUBMIT_FAILED", text, "确认 ComfyUI 在线、模型与节点完整后重试。")
