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

from gpu_lease import alive, comfy_device, comfy_process, gpu_status, job_owner
from outfit_queue import initial_state, sheet_stage_label, stage_transfer, stage_workflow, validate_plan
from workbench_lifecycle import atomic_write_json, runtime_dir, utc_now

TERMINAL = {"done", "error", "cancelled"}
ACTIVE = {"running", "finishing"}


def _error(code, message, suggestion=None):
    return {"code": code, "message": str(message), "suggestion": suggestion or "检查 ComfyUI 状态和生成参数后重试。"}


def _public(job):
    hidden = {"workflow", "plan", "clientId", "gpuDispatch", "gpuBackend"}
    return {key: copy.deepcopy(value) for key, value in job.items() if key not in hidden}


class ComfyQueueAdapter:
    def __init__(self, origin="http://127.0.0.1:8188", timeout=10):
        self.origin = origin.rstrip("/")
        self.timeout = timeout

    def _request(self, path, payload=None, timeout=None):
        data = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(self.origin + path, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=timeout or self.timeout) as response:
            content = response.read()
            return json.loads(content) if content.strip() else {}

    def gpu_target(self):
        device = comfy_device(self._request("/system_stats", timeout=3))
        return device, comfy_process(self.origin) if device else None

    def submit(self, workflow, client_id, *, gpu_dispatch=None):
        payload = {"prompt": workflow, "client_id": client_id}
        if gpu_dispatch:
            payload["extra_data"] = {"refmuse_gpu_dispatch": gpu_dispatch}
        return self._request("/prompt", payload)["prompt_id"]

    def find_gpu_dispatch(self, dispatch):
        def matches(item):
            return (isinstance(item, list) and len(item) > 3 and isinstance(item[3], dict)
                    and item[3].get("refmuse_gpu_dispatch") == dispatch)
        queue = self._request("/queue", timeout=3)
        for item in queue.get("queue_pending", []) + queue.get("queue_running", []):
            if matches(item):
                return item[1]
        history = self._request("/history?max_items=100", timeout=3)
        for prompt_id, entry in history.items():
            if isinstance(entry, dict) and matches(entry.get("prompt")):
                return prompt_id
        return None

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
        self._request("/queue", {"delete": [prompt_id]})
        current = self._request("/queue")
        if any(isinstance(item, (list, tuple)) and len(item) > 1 and item[1] == prompt_id
               for item in current.get("queue_running", [])):
            self._request("/interrupt", {"prompt_id": prompt_id})

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
        fields = {"type": "input", "subfolder": "workbench", "overwrite": "false"}
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
    def __init__(self, path=None, adapter=None, concurrency=1, poll_interval=0.5, job_timeout=60 * 60, gpu_leases=None):
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
        self.gpu_leases = gpu_leases
        self._gpu_grants = {}
        self._load()
        self._restore_terminal_gpu()

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
                    if job.get("submissionPending") is False:
                        job["status"] = "queued"
                    elif job.get("gpuDispatch"):
                        job["stage"] = "原 ComfyUI 提交待核对"
                    else:
                        # ComfyUI may have accepted a request immediately before
                        # the process died. Missing acknowledgement is not proof
                        # of rejection, including queues written by older builds.
                        job.update(status="error", finishedAt=utc_now(), stage="提交结果待核对",
                                   error=_error("COMFY_SUBMISSION_UNKNOWN", "服务中断时提交结果尚未保存，已停止自动重试以避免重复生成。",
                                                "先核对 ComfyUI 队列和历史；确认没有已提交任务后再手动重试。"))
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

    def enqueue(self, payload, *, legacy_manual=False):
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
            **({"origin": "legacy-manual", "canvasOwned": False} if legacy_manual else {}),
            **({"requestId": payload["requestId"]} if payload.get("requestId") else {}),
            **({"canvasAdmission": payload["canvasAdmission"]} if payload.get("canvasAdmission") else {}),
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
            "submissionPending": False,
            "cancelRequested": False,
            "error": None,
            "outputs": None,
            "history": None,
            "attempts": 1 if payload.get("canvasAdmission") else 0,
            "workflow": copy.deepcopy(workflow),
            "plan": plan,
            "planState": initial_state() if plan else None,
            "clientId": str(payload.get("clientId") or uuid.uuid4()),
        }
        with self._lock:
            if job["clientId"].startswith(("agent:", "canvas:")):
                existing = next((item for item in self.jobs if item.get("clientId") == job["clientId"] and item.get("projectId") == job["projectId"]), None)
                if existing:
                    if job["clientId"].startswith("canvas:") and any(existing.get(key) != job.get(key) for key in ("nodeId", "workflow", "plan")):
                        raise ValueError("该请求已用于不同的节点或执行内容。")
                    return _public(existing)
            self.jobs.append(job)
            try:
                self._changed_locked("job.queued", job)
            except OSError:
                self.jobs.pop()
                raise
            return _public(job)

    def inspect_workflow(self, project_id, node_id=None, job_id=None, prompt_id=None):
        """Return one scoped, bounded view copy; never submit or mutate a job."""
        if not project_id or not (node_id or job_id or prompt_id):
            raise ValueError("查看工作流需要项目和节点、任务或提示词 ID。")
        with self._lock:
            candidates = [job for job in self.jobs if job.get("projectId") == project_id
                          and (not node_id or job.get("nodeId") == node_id)
                          and (not job_id or job.get("id") == job_id)]
            if prompt_id:
                candidates = [job for job in candidates if prompt_id == job.get("comfyPromptId")
                              or prompt_id in (job.get("planState") or {}).get("promptIds", [])]
            if not candidates:
                raise KeyError("尚无执行记录，或指定记录已清理。")
            job = copy.deepcopy(candidates[-1])
        plan = job.get("plan")
        state = job.get("planState") or {}
        submitted = state.get("promptIds") or []
        history_prompt = (job.get("history") or {}).get("prompt")
        exact = history_prompt[2] if isinstance(history_prompt, list) and len(history_prompt) > 2 and isinstance(history_prompt[2], dict) else None
        exact_id = history_prompt[1] if exact is not None else None
        stages = []

        def add(stage_id, label, graph, stage_prompt=None, executed=None, reason=None):
            actual = exact is not None and stage_prompt == exact_id
            graph = copy.deepcopy(exact if actual else graph)
            if graph is not None and (not isinstance(graph, dict) or len(graph) > 2048):
                raise ValueError("工作流超过查看上限（2048 个节点）。")
            stages.append({"id": stage_id, "label": label, "graph": graph,
                           "promptId": stage_prompt, "executed": executed,
                           "provenance": "execution" if actual else "persisted-plan" if graph else "unavailable",
                           "reason": reason if not graph else None})

        if not plan:
            add("workflow", "工作流", job.get("workflow"), job.get("comfyPromptId"), bool(job.get("comfyPromptId")))
        elif plan.get("kind") == "characterSheet":
            for index, panel in enumerate(plan["panels"]):
                stage_state = {**state, "phase": "single", "panelIndex": index}
                try:
                    graph = stage_workflow({**job, "planState": stage_state})
                    reason = None
                except (KeyError, ValueError):
                    graph, reason = None, "前序图片尚未保存，无法还原实际加载路径。"
                add(panel["id"], panel["label"], graph, submitted[index] if index < len(submitted) else None, index < len(submitted), reason)
            try:
                graph = stage_workflow({**job, "planState": {**state, "phase": "stitch"}})
                reason = None
            except (KeyError, ValueError):
                graph, reason = None, "四张图片尚未全部保存，拼接输入不可用。"
            stitch_index = len(plan["panels"])
            add("stitch", "最终拼接", graph, submitted[stitch_index] if len(submitted) > stitch_index else None, len(submitted) > stitch_index, reason)
        else:
            for index, panel in enumerate(plan["panels"]):
                current = index == state.get("panelIndex")
                add(f"{panel['id']}:single", f"{panel['label']} · 单图", panel["single"],
                    job.get("comfyPromptId") if current and state.get("phase") == "single" else None)
                if panel.get("hd"):
                    is_current = current and state.get("phase") == "hd"
                    # A completed single-panel HD run overwrites currentInput
                    # with its HD output. That is not the input it sampled.
                    graph = stage_workflow(job) if is_current and job.get("status") != "done" and state.get("currentInput") else None
                    add(f"{panel['id']}:hd", f"{panel['label']} · 高清", graph,
                        job.get("comfyPromptId") if is_current else None, reason="这一步的原始高清输入未单独保留，无法准确还原。")
            if plan.get("stitch"):
                ready = all(panel["id"] in state.get("images", {}) for panel in plan["panels"])
                graph = stage_workflow({**job, "planState": {**state, "phase": "stitch"}}) if ready else None
                add("stitch", "最终拼接", graph, job.get("comfyPromptId") if state.get("phase") == "stitch" else None,
                    reason="拼接图片尚未全部保存。")
        default = stages[0]["id"]
        if plan and job.get("status") in ACTIVE | {"error", "cancelled"}:
            phase = state.get("phase")
            if phase == "stitch":
                default = "stitch"
            elif isinstance(state.get("panelIndex"), int) and state["panelIndex"] < len(plan["panels"]):
                panel_id = plan["panels"][state["panelIndex"]]["id"]
                default = panel_id if plan["kind"] == "characterSheet" else f"{panel_id}:{phase}"
        result = {"jobId": job["id"], "nodeId": job.get("nodeId"), "projectId": project_id,
                  "kind": job.get("kind"), "status": job.get("status"), "attempt": job.get("attempts", 1),
                  "defaultStage": default, "stages": stages}
        if len(stages) > 12 or len(json.dumps(result, ensure_ascii=False).encode("utf-8")) > 8 * 1024 * 1024:
            raise ValueError("工作流查看数据超过上限，请导出后检查。")
        return result

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
            cancel_attempt = job.get("attempts", 0)
            self._changed_locked("job.cancel_requested", job)
        if prompt_id:
            self.adapter.cancel(prompt_id)
        with self._lock:
            # The old prompt may finish while its cancellation call is in flight,
            # allowing retry() to start a new attempt. Never cancel that retry.
            if job.get("attempts", 0) != cancel_attempt:
                return _public(job)
            if job.get("gpu", {}).get("state") == "waiting":
                job.pop("gpu")
            elif job.get("gpu", {}).get("state") == "held":
                job["gpu"]["state"] = "reconciling"
            job["status"] = "cancelled"
            job["stage"] = "已取消生成"
            job["finishedAt"] = utc_now()
            job["error"] = None
            self._changed_locked("job.cancelled", job)
            return _public(job)

    def retry(self, job_id, *, request_id=None, expected_attempt=None, admission=None):
        with self._lock:
            job = self._find_locked(job_id)
            previous = job.get("retryAdmission") or {}
            if request_id and previous.get("requestId") == request_id:
                if previous.get("previousAttempt") != expected_attempt:
                    raise ValueError("请求 ID 已用于另一轮尝试。")
                return _public(job)
            if expected_attempt is not None and job.get("attempts") != expected_attempt:
                raise ValueError("任务尝试轮次已变化，请按原身份查询。")
            if job["status"] not in TERMINAL:
                raise ValueError("任务尚未结束，不能重试。")
            prior = copy.deepcopy(job)
            for field in ("gpu", "gpuDispatch", "gpuBackend"):
                job.pop(field, None)
            job.update({"status": "queued", "stage": "后台队列等待中", "progress": 0, "eta": None, "startedAt": None, "finishedAt": None,
                        "comfyPromptId": None, "submissionPending": False, "cancelRequested": False, "error": None, "outputs": None, "history": None,
                        "attempts": job.get("attempts", 0) + 1,
                        "planState": initial_state() if job.get("plan") else None})
            if request_id:
                job["retryAdmission"] = {**admission, "requestId": request_id,
                                         "previousAttempt": expected_attempt, "attempt": job["attempts"]}
            try:
                self._changed_locked("job.retry", job)
            except OSError:
                job.clear()
                job.update(prior)
                raise
            return _public(job)

    def clear_completed(self):
        with self._lock:
            retained = [job for job in self.jobs if job["status"] not in TERMINAL
                        or job.get("gpu", {}).get("state") in {"held", "reconciling"}]
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

    def _gpu_ready(self, job):
        if self.gpu_leases is None:
            return True
        key = (job["id"], job["attempts"])
        if key in self._gpu_grants:
            return True
        try:
            device, backend = self.adapter.gpu_target()
            if device is None:
                return True
            owner = job_owner("comfy", job)
            grant, blocker = self.gpu_leases.claim(device, owner, recovery=self.adapter.origin if job.get("comfyPromptId") else None)
            if grant:
                self._gpu_grants[key] = (grant, job.get("gpuBackend") or backend)
                if job.get("comfyPromptId"):
                    grant.restore_prompt(self.adapter.origin, backend, job["comfyPromptId"])
            with self._lock:
                if job["status"] in TERMINAL or job["attempts"] != key[1]:
                    return False
                state = gpu_status(device, "held" if grant else "waiting", owner if grant else blocker)
                if job.get("gpu") != state:
                    job["gpu"] = state
                    if not grant:
                        job["stage"] = "等待 GPU"
                    elif job["status"] == "queued":
                        job["stage"] = "GPU 已接力 · 待提交"
                    self._changed_locked("job.progress", job)
            return bool(grant)
        except (OSError, ValueError, RuntimeError) as exc:
            with self._lock:
                if job["status"] not in TERMINAL and job["attempts"] == key[1] and not job.get("comfyPromptId"):
                    job.update(status="error", stage="GPU 不可用", finishedAt=utc_now(),
                               error=_error("GPU_UNAVAILABLE", exc))
                    self._changed_locked("job.error", job)
            return False

    def _restore_terminal_gpu(self):
        if self.gpu_leases is None:
            return
        for job in self.jobs:
            gpu = job.get("gpu") or {}
            if job["status"] not in TERMINAL or gpu.get("state") not in {"held", "reconciling"}:
                continue
            device, owner = gpu["device"], job_owner("comfy", job)
            recovered = self.gpu_leases.recover_comfy(device, owner, self.adapter.origin)
            if recovered:
                self._gpu_grants[(job["id"], job["attempts"])] = recovered
            else:
                job["gpu"] = gpu_status(device, "released", owner)

    def _recover_gpu_dispatches(self):
        with self._lock:
            unresolved = [(job, job["attempts"], job["gpuDispatch"], job.get("gpuBackend"))
                          for job in self.jobs if job.get("gpuDispatch") and job.get("submissionPending")
                          and not job.get("comfyPromptId")
                          and (job["status"] in ACTIVE
                               or (job.get("cancelRequested") and (job["id"], job["attempts"]) in self._gpu_grants))]
        for job, attempt, dispatch, backend in unresolved:
            try:
                prompt = self.adapter.find_gpu_dispatch(dispatch)
            except (OSError, ValueError, RuntimeError):
                prompt = None
            with self._lock:
                if job["attempts"] != attempt:
                    continue
                cancel = job.get("cancelRequested")
            if prompt and cancel:
                try:
                    self.adapter.cancel(prompt)
                except (OSError, ValueError, RuntimeError):
                    continue
            with self._lock:
                if job["attempts"] != attempt:
                    continue
                if prompt:
                    target = self._gpu_grants.get((job["id"], attempt))
                    if target:
                        job["gpu"] = gpu_status(target[0].device, "reconciling" if cancel else "held", target[0].owner)
                        # A foreign runtime may already have retired a proven terminal row.
                        try:
                            target[0].acknowledge(prompt)
                        except RuntimeError:
                            self._gpu_grants.pop((job["id"], attempt), None)
                    job.update(comfyPromptId=prompt, submissionPending=False)
                    if not cancel:
                        job["stage"] = "已查回原 ComfyUI 任务"
                    if job.get("plan"):
                        job["planState"]["promptIds"].append(prompt)
                    self._changed_locked("job.submitted", job)
                elif backend and not alive(backend):
                    job["submissionPending"] = False
                    if cancel:
                        self._changed_locked("job.progress", job)
                    else:
                        job.update(status="error", stage="ComfyUI 已退出", finishedAt=utc_now(),
                                   error=_error("COMFY_EXITED", "提交失联后原 ComfyUI 进程已退出。"))
                        self._changed_locked("job.error", job)

    def _retire_gpu(self):
        for key, (grant, _) in list(self._gpu_grants.items()):
            with self._lock:
                job = next((candidate for candidate in self.jobs if candidate["id"] == key[0]), None)
                current = job is not None and job["attempts"] == key[1]
                if current and job["status"] not in TERMINAL and (job["status"] != "queued" or not self.paused):
                    continue
            try:
                settled = grant.retire_comfy(self.adapter.free)
            except (OSError, ValueError, RuntimeError):
                continue
            if settled:
                self._gpu_grants.pop(key, None)
            with self._lock:
                if current and job["attempts"] == key[1]:
                    state = gpu_status(grant.device, "released" if settled else "reconciling", grant.owner)
                    if job.get("gpu") != state:
                        job["gpu"] = state
                        self._changed_locked("job.progress", job)

    def _run(self):
        while not self._stop.is_set():
            self._recover_gpu_dispatches()
            self._retire_gpu()
            submissions = []
            with self._lock:
                active_count = sum(job["status"] in ACTIVE for job in self.jobs)
                slots = 0 if self.paused else max(0, self.concurrency - active_count)
                waiting = sorted((job for job in self.jobs if job["status"] == "queued"),
                                 key=lambda job: (-job["priority"], job["createdAt"]))[:slots]
                for job in waiting:
                    job["attempts"] = max(1, job.get("attempts", 0))
            for job in waiting:
                if not self._gpu_ready(job):
                    continue
                with self._lock:
                    if self.paused or job["status"] != "queued" or job.get("cancelRequested"):
                        continue
                    job["status"] = "running"
                    job["startedAt"] = job["startedAt"] or utc_now()
                    if job.get("plan"):
                        panel = job["plan"]["panels"][job["planState"]["panelIndex"]]
                        count = len(job["plan"]["panels"])
                        job["stage"] = sheet_stage_label(job["planState"], job["plan"]) if job["kind"] == "characterSheet" else f"{'保留原图' if panel['preserve'] else '千问独立换装'} {job['planState']['panelIndex'] + 1}/{count} · {panel['label']}"
                    submissions.append(job)
                    self._changed_locked("job.started", job)
            with self._lock:
                active = [job for job in self.jobs if job["status"] in ACTIVE]
                submitted_ids = {id(job) for job in submissions}
                to_submit = submissions + [job for job in active if id(job) not in submitted_ids and job.get("plan") and not job.get("comfyPromptId") and not job.get("submissionPending")]

            for job in to_submit:
                submit_attempt = job["attempts"]
                if not self._gpu_ready(job):
                    continue
                target = self._gpu_grants.get((job["id"], submit_attempt))
                dispatch = None
                try:
                    if job.get("kind") == "characterSheet":
                        with self._lock:
                            if job.get("cancelRequested") or job["status"] in TERMINAL:
                                continue
                    workflow = stage_workflow(job) if job.get("plan") else job["workflow"]
                    with self._lock:
                        if job.get("cancelRequested") or job["status"] in TERMINAL or job["attempts"] != submit_attempt:
                            continue
                        job["submissionPending"] = True
                        self._changed_locked("job.submitting", job)
                    if target:
                        grant, backend = target
                        dispatch = grant.dispatch(self.adapter.origin, backend)
                        with self._lock:
                            cancelled_before_send = job.get("cancelRequested") or job["attempts"] != submit_attempt
                            if not cancelled_before_send:
                                job.update(gpuDispatch=dispatch, gpuBackend=backend)
                                self._persist_locked()
                        if cancelled_before_send:
                            grant.rejected()
                            continue
                        prompt_id = self.adapter.submit(workflow, job["clientId"], gpu_dispatch=dispatch)
                        grant.acknowledge(prompt_id)
                    else:
                        prompt_id = self.adapter.submit(workflow, job["clientId"])
                    with self._lock:
                        same_attempt = job["attempts"] == submit_attempt
                        needs_cancel = bool(job.get("cancelRequested") or job["status"] in TERMINAL or not same_attempt)
                        if same_attempt:
                            job["comfyPromptId"] = prompt_id
                            job["submissionPending"] = False
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
                    if dispatch:
                        if isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500:
                            target[0].rejected()
                        else:
                            target[0].uncertain()
                    with self._lock:
                        if job["status"] in TERMINAL or job["attempts"] != submit_attempt:
                            continue
                        if dispatch and not (isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500):
                            job["stage"] = "原 ComfyUI 提交待核对"
                            job["gpu"] = gpu_status(target[0].device, "reconciling", target[0].owner)
                            self._changed_locked("job.progress", job)
                        else:
                            job["status"] = "error"
                            job["finishedAt"] = utc_now()
                            job["error"] = self._submission_error(exc)
                            self._changed_locked("job.error", job)

            for job in active:
                poll_attempt = job["attempts"]
                prompt_id = job.get("comfyPromptId")
                if not prompt_id or job["status"] in TERMINAL or self._stop.is_set():
                    continue
                # Polling old upstream work is read-only. The durable row still
                # guards any live worker even before this process re-attaches.
                self._gpu_ready(job)
                target = self._gpu_grants.get((job["id"], poll_attempt))
                if target and not alive(target[1]):
                    with self._lock:
                        if job["status"] in ACTIVE and job["attempts"] == poll_attempt:
                            job.update(status="error", stage="ComfyUI 已退出", finishedAt=utc_now(),
                                       error=_error("COMFY_EXITED", "本次任务的 ComfyUI 进程已退出。"))
                            self._changed_locked("job.error", job)
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
                            if key == "progress" and job.get("kind") == "characterSheet":
                                fraction = max(0, min(100, float(update[key]))) / 100
                                state = job["planState"]
                                stage_progress = 94 + fraction * 5 if state["phase"] == "stitch" else (state["panelIndex"] + fraction) * 90 / 4
                                job[key] = max(job["progress"], stage_progress)
                                continue
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
                        sheet = job.get("kind") == "characterSheet"
                        patch = {"status": "error", "stage": "角色表阶段失败" if sheet else "换装阶段失败", "error": _error("CHARACTER_SHEET_STAGE_FAILED" if sheet else "OUTFIT_STAGE_FAILED", exc, "检查中间图、ComfyUI 上传接口和磁盘空间后重试。")}
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
