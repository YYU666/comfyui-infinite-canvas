from __future__ import annotations

import hashlib
import json
import logging
import queue
import re
import urllib.parse

from project_store import StoreError
from workbench_security import valid_token

LOGGER = logging.getLogger("h3-workbench")
JOB_PATH = re.compile(r"^/api/queue/(job_[A-Za-z0-9_-]+)$")
ACTION_PATH = re.compile(r"^/api/queue/(job_[A-Za-z0-9_-]+)/(cancel|retry|priority)$")


class QueueAPI:
    def __init__(self, manager, canvas_context=None):
        self.manager = manager
        self.canvas_context = canvas_context

    def _enqueue(self, payload):
        if self.canvas_context is None:
            return self.manager.enqueue(payload)
        store, bridge = self.canvas_context()
        project_id, node_id = payload.get("projectId"), payload.get("nodeId")
        request_id, revision = payload.get("requestId"), payload.get("revision")
        if (not isinstance(project_id, str) or not re.fullmatch(r"prj_[A-Za-z0-9_-]+", project_id)
                or not isinstance(node_id, str) or not node_id
                or not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id)
                or type(revision) is not int or revision < 1):
            raise StoreError("VISIBLE_CANVAS_REQUIRED", "生成须先在当前可写画布保存目标和准备记录。", 409)
        proof = payload.get("page")
        with bridge.lock:
            bridge.assert_generation_page(proof, project_id, node_id, request_id)
        path = store._project_path(project_id)
        with store._guard(path):
            store._require_writable(path)
            project = store.get(project_id)
            if project["revision"] != revision:
                raise StoreError("REVISION_CONFLICT", "保存修订已改变，本次生成未提交。", 409)
            node = next((node for node in project["canvas"]["nodes"] if node["id"] == node_id), None)
            run = node.get("data", {}).get("visibleRun") if node and node["type"] == "generator" else None
            if (not isinstance(run, dict) or run.get("requestId") != request_id or run.get("phase") != "prepared"
                    or not isinstance(run.get("inputs"), list) or not isinstance(run.get("parameters"), dict)):
                raise StoreError("VISIBLE_CANVAS_REQUIRED", "项目中没有匹配的、已保存的生成准备记录。", 409)
            sources = {item["id"]: item for item in project["canvas"]["nodes"]}
            edges = {(edge.get("source"), edge.get("targetHandle")) for edge in project["canvas"]["edges"]
                     if edge.get("target") == node_id}
            for source in run["inputs"]:
                if not isinstance(source, dict) or not isinstance(source.get("nodeId"), str) or not isinstance(source.get("slot"), str):
                    raise StoreError("INPUT_CHANGED", "生成准备记录缺少已绑定的输入。", 409)
                live = sources.get(source["nodeId"], {}).get("data", {})
                if ((source["nodeId"], source["slot"]) not in edges
                        or source.get("assetPath") != live.get("assetPath")
                        or source.get("resolvedName") != live.get("remoteName")):
                    raise StoreError("INPUT_CHANGED", "已保存的生成输入与准备记录不符。", 409)
            execution_text = payload.get("executionJson")
            execution_record = run.get("execution")
            if (not isinstance(execution_text, str) or not isinstance(execution_record, dict)
                    or hashlib.sha256(execution_text.encode("utf-8")).hexdigest() != execution_record.get("digest")):
                raise StoreError("EXECUTION_CHANGED", "实际工作流与已保存的准备记录不符，未提交。", 409)
            execution = json.loads(execution_text)
            if not isinstance(execution, dict) or set(execution) != {"workflow", "plan"}:
                raise ValueError("执行配置必须包含 workflow 和 plan。")
            with bridge.lock:
                bridge.assert_generation_page(proof, project_id, node_id, request_id)
                return self.manager.enqueue({**payload, **execution, "clientId": f"canvas:{project_id}:{request_id}",
                    "canvasAdmission": {"origin": run.get("origin"), "preparedRevision": revision,
                                        "basisRevision": run.get("basisRevision"), "digest": execution_record["digest"]}})

    def _legacy_prompt(self, handler, payload):
        if (self.canvas_context is None or handler.headers.get("Sec-Fetch-Site") != "same-origin"
                or not valid_token({"Cookie": handler.headers.get("Cookie", "")}, handler.server.token, handler.server.server_port)):
            raise StoreError("LEGACY_MANUAL_REQUIRED", "简易模式只接受当前浏览器内的人工生成。", 403)
        _, bridge = self.canvas_context()
        proof = payload.get("page")
        workflow, client_id = payload.get("workflow"), payload.get("clientId")
        if (not isinstance(proof, dict) or not isinstance(workflow, dict) or not workflow
                or not isinstance(client_id, str) or not client_id.startswith("legacy:") or len(client_id) > 120):
            raise ValueError("简易模式缺少有效会话或工作流。")
        with bridge.lock:
            bridge._epoch(proof)
            if bridge.current("legacy")["sessionId"] != bridge._id(proof, "sessionId"):
                raise StoreError("LEGACY_MANUAL_REQUIRED", "原简易模式页面已关闭或切换。", 409)
            job = self.manager.enqueue({"workflow": workflow, "clientId": client_id}, legacy_manual=True)
        return {"jobId": job["id"], "origin": job["origin"], "canvasOwned": job["canvasOwned"]}

    def _retry(self, job_id, payload):
        if self.canvas_context is None:
            return self.manager.retry(job_id)
        store, bridge = self.canvas_context()
        request_id, revision, attempt = payload.get("requestId"), payload.get("revision"), payload.get("expectedAttempt")
        proof = payload.get("page")
        if (not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", request_id)
                or type(revision) is not int or revision < 1 or type(attempt) is not int or attempt < 1
                or not isinstance(proof, dict)):
            raise StoreError("VISIBLE_CANVAS_REQUIRED", "重新执行须先在当前可写画布保存重试记录。", 409)
        job = self.manager.get(job_id)
        project_id, node_id = job.get("projectId"), job.get("nodeId")
        if not project_id or not node_id:
            raise StoreError("VISIBLE_CANVAS_REQUIRED", "此历史任务缺少画布来源，不能在项目队列重新执行。", 409)
        path = store._project_path(project_id)
        with store._guard(path):
            store._require_writable(path)
            project = store.get(project_id)
            if project["revision"] != revision:
                raise StoreError("REVISION_CONFLICT", "保存修订已改变，本次重新执行未提交。", 409)
            node = next((item for item in project["canvas"]["nodes"] if item["id"] == node_id), None)
            data = node.get("data", {}) if node else {}
            retry = data.get("visibleRetry")
            if (data.get("queueJobId") != job_id or not isinstance(retry, dict)
                    or retry.get("requestId") != request_id or retry.get("phase") != "prepared"
                    or retry.get("jobId") != job_id or retry.get("previousAttempt") != attempt):
                raise StoreError("VISIBLE_CANVAS_REQUIRED", "找不到当前节点已保存的重新执行记录。", 409)
            with bridge.lock:
                bridge.assert_generation_page(proof, project_id, node_id, request_id, tool="canvas_retry_generation")
                return self.manager.retry(job_id, request_id=request_id, expected_attempt=attempt,
                                          admission={"preparedRevision": revision, "origin": retry.get("origin")})

    @staticmethod
    def _error(handler, status, code, message, details=None):
        handler.send_json(status, {"code": code, "message": str(message), "details": details or {}})

    def _payload(self, handler):
        length = int(handler.headers.get("Content-Length", "0"))
        if length < 0 or length > 10 * 1024 * 1024:
            raise ValueError("队列请求内容过大。")
        if not length:
            return {}
        payload = json.loads(handler.rfile.read(length).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("队列请求必须是 JSON 对象。")
        return payload

    def handle_get(self, handler, path):
        if path == "/api/queue/inspect":
            try:
                query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
                allowed = {"projectId", "nodeId", "jobId", "promptId"}
                if set(query) - allowed or any(len(values) != 1 or len(values[0]) > 256 for values in query.values()):
                    raise ValueError("工作流查看参数无效。")
                values = {key: value[0] for key, value in query.items()}
                handler.send_json(200, self.manager.inspect_workflow(values.get("projectId"), values.get("nodeId"), values.get("jobId"), values.get("promptId")))
            except KeyError:
                self._error(handler, 404, "NO_EXECUTION", "尚无执行记录，或指定记录已清理；不会改用其他任务。")
            except (ValueError, TypeError) as exc:
                self._error(handler, 400, "BAD_REQUEST", exc)
            return True
        if path == "/api/queue/events":
            self._events(handler)
            return True
        if path == "/api/queue":
            handler.send_json(200, self.manager.snapshot())
            return True
        match = JOB_PATH.fullmatch(path)
        if not match:
            return False
        try:
            handler.send_json(200, self.manager.get(match.group(1)))
        except KeyError:
            self._error(handler, 404, "NOT_FOUND", "队列任务不存在。")
        return True

    def handle_post(self, handler, path):
        if path not in ("/api/queue", "/api/legacy/prompt") and not ACTION_PATH.fullmatch(path):
            return False
        try:
            payload = self._payload(handler)
            if path == "/api/legacy/prompt":
                handler.send_json(201, self._legacy_prompt(handler, payload))
                return True
            if path == "/api/queue":
                action = payload.get("action")
                if not action:
                    result = self._enqueue(payload)
                    handler.send_json(201, result)
                    return True
                if action == "pause":
                    self.manager.pause(True)
                elif action == "resume":
                    self.manager.pause(False)
                elif action == "clearCompleted":
                    self.manager.clear_completed()
                elif action == "concurrency":
                    self.manager.set_concurrency(payload.get("concurrency"))
                else:
                    raise ValueError("不支持的队列操作。")
                handler.send_json(200, self.manager.snapshot())
                return True
            match = ACTION_PATH.fullmatch(path)
            job_id, action = match.groups()
            if action == "cancel":
                result = self.manager.cancel(job_id)
            elif action == "retry":
                result = self._retry(job_id, payload)
            else:
                result = self.manager.set_priority(job_id, payload.get("priority", 0))
            handler.send_json(200, result)
        except StoreError as exc:
            self._error(handler, exc.status, exc.code, exc.message, exc.details)
        except KeyError:
            self._error(handler, 404, "NOT_FOUND", "队列任务不存在。")
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self._error(handler, 400, "BAD_REQUEST", exc)
        except Exception as exc:
            LOGGER.exception("队列操作失败：%s", exc)
            self._error(handler, 500, "INTERNAL", "队列操作失败，请查看诊断信息。")
        return True

    def _events(self, handler):
        listener = self.manager.subscribe()
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
            handler.send_header("Cache-Control", "no-cache")
            handler.send_header("Connection", "keep-alive")
            handler.end_headers()
            self._write_event(handler, "queue.snapshot", self.manager.snapshot())
            while True:
                try:
                    event = listener.get(timeout=15)
                except queue.Empty:
                    handler.wfile.write(b": keepalive\n\n")
                    handler.wfile.flush()
                    continue
                self._write_event(handler, event["type"], event)
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.manager.unsubscribe(listener)

    @staticmethod
    def _write_event(handler, event_type, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        handler.wfile.write(f"event: {event_type}\ndata: {body}\n\n".encode("utf-8"))
        handler.wfile.flush()
