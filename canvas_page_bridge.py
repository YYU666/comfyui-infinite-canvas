"""Deliver bounded canvas commands to an already-open page; never launch a browser."""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
import uuid

from project_store import StoreError

TOOLS = frozenset({"canvas_get_state", "canvas_create_node", "canvas_update_node", "canvas_connect_nodes",
                   "canvas_generate_node", "canvas_delete_node", "canvas_focus_node", "canvas_tidy", "canvas_import_asset"})
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,100}")


class CanvasPageBridge:
    def __init__(self, *, now=time.monotonic, ttl=15, capacity=512):
        self.epoch = uuid.uuid4().hex
        self.now, self.ttl, self.capacity = now, ttl, capacity
        self.sessions, self.commands = {}, {}
        self.lock = threading.RLock()

    @staticmethod
    def _id(payload, key):
        value = payload.get(key)
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
            raise StoreError("BAD_REQUEST", f"Invalid {key}.")
        return value

    def _epoch(self, payload):
        if payload.get("epoch") != self.epoch:
            raise StoreError("CANVAS_EPOCH_CHANGED", "工作台已重启，请重新读取当前页面；旧命令不会重放。", 409)

    def _expire(self):
        for key, session in list(self.sessions.items()):
            if self.now() - session["seen"] > self.ttl:
                del self.sessions[key]
        for command in self.commands.values():
            if command["status"] in {"queued", "dispatched"} and command["sessionId"] not in self.sessions:
                command["status"] = "expired" if command["status"] == "queued" else "unknown"

    def current(self, project_id=None):
        with self.lock:
            self._expire()
            pages = [page for page in self.sessions.values() if page["visible"] and (not project_id or page["projectId"] == project_id)]
            if not pages:
                raise StoreError("NO_VISIBLE_CANVAS", "没有连接到当前可见画布，请在现有网页打开项目；不要另开后台画布。", 409)
            if len(pages) != 1:
                raise StoreError("AMBIGUOUS_CANVAS", "有多个可见画布，请只保留一个目标页面后重试。", 409)
            page = pages[0]
            return {"epoch": self.epoch, "sessionId": page["sessionId"], "projectId": page["projectId"]}

    def heartbeat(self, payload):
        with self.lock:
            session_id, project_id = self._id(payload, "sessionId"), self._id(payload, "projectId")
            if not project_id.startswith("prj_") or not isinstance(payload.get("visible"), bool) or not isinstance(payload.get("busy", False), bool):
                raise StoreError("BAD_REQUEST", "Invalid canvas heartbeat.")
            self._expire()
            previous = self.sessions.get(session_id)
            if previous and previous["projectId"] != project_id:
                raise StoreError("CANVAS_SESSION_CHANGED", "页面已切换项目，请使用新的页面会话。", 409)
            if session_id not in self.sessions and len(self.sessions) >= 32:
                raise StoreError("CANVAS_CAPACITY", "页面会话数量已达上限。", 429)
            self.sessions[session_id] = {"sessionId": session_id, "projectId": project_id, "visible": payload["visible"], "seen": self.now()}
            response = {"epoch": self.epoch, "command": None}
            try:
                active = self.current(project_id)
            except StoreError:
                return response
            if payload.get("busy") or active["sessionId"] != session_id:
                return response
            for command in self.commands.values():
                if command["status"] == "queued" and command["sessionId"] == session_id:
                    command["status"] = "dispatched"  # Never redeliver, including a lost HTTP response.
                    response["command"] = {key: command[key] for key in ("opId", "epoch", "sessionId", "projectId", "tool", "args")}
                    break
            return response

    def submit(self, payload):
        with self.lock:
            self._epoch(payload)
            op_id = self._id(payload, "opId")
            session_id, project_id = self._id(payload, "sessionId"), self._id(payload, "projectId")
            tool, args = payload.get("tool"), payload.get("args", {})
            if not isinstance(tool, str) or tool not in TOOLS or not isinstance(args, dict):
                raise StoreError("BAD_REQUEST", "Unsupported canvas tool or arguments.")
            if tool == "canvas_generate_node" and args.get("wait", False) is not False:
                raise StoreError("BAD_REQUEST", "当前页通道只提交生成（wait:false），请用 canvas_get_state 查询结果。")
            identity = {"sessionId": session_id, "projectId": project_id, "tool": tool, "args": args}
            encoded = json.dumps(identity, sort_keys=True, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(encoded) > 32768:
                raise StoreError("BAD_REQUEST", "画布命令过大。")
            fingerprint = hashlib.sha256(encoded).hexdigest()
            existing = self.commands.get(op_id)
            if existing:
                if existing["fingerprint"] != fingerprint:
                    raise StoreError("CANVAS_OP_CONFLICT", "同一 opId 已用于不同命令。", 409)
                return self.get(op_id)
            active = self.current(project_id)
            if active["sessionId"] != session_id:
                raise StoreError("CANVAS_SESSION_CHANGED", "目标页面已失效，请重新读取当前画布。", 409)
            if len(self.commands) >= self.capacity:
                raise StoreError("CANVAS_CAPACITY", "当前页命令记录已满；不会删除去重记录或重放生成。", 429)
            self.commands[op_id] = {**identity, "opId": op_id, "epoch": self.epoch, "fingerprint": fingerprint, "status": "queued"}
            return self.get(op_id)

    def complete(self, payload):
        with self.lock:
            self._epoch(payload)
            op_id = self._id(payload, "opId")
            command = self.commands.get(op_id)
            if not command:
                raise StoreError("NOT_FOUND", "Canvas command not found.", 404)
            if any(payload.get(key) != command[key] for key in ("sessionId", "projectId")):
                raise StoreError("CANVAS_SESSION_CHANGED", "结果不属于派发页面。", 409)
            result = payload.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                raise StoreError("BAD_REQUEST", "Invalid canvas result.")
            if len(json.dumps(result, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 131072:
                result = {"ok": False, "error": "结果过大；请按 nodeId 读取。命令已执行，不会重放。"}
            if command["status"] == "done":
                if result != command["result"]:
                    raise StoreError("CANVAS_OP_CONFLICT", "结果已登记，不能覆盖。", 409)
            elif command["status"] not in {"dispatched", "unknown"}:
                raise StoreError("BAD_REQUEST", "Command was not dispatched.")
            else:
                command.update(status="done", result=result)
            return self.get(op_id)

    def get(self, op_id):
        with self.lock:
            self._expire()
            command = self.commands.get(op_id)
            if not command:
                raise StoreError("NOT_FOUND", "Canvas command not found.", 404)
            return {key: command[key] for key in ("opId", "epoch", "sessionId", "projectId", "status", "result") if key in command}

    def release(self, payload):
        with self.lock:
            session_id = self._id(payload, "sessionId")
            self.sessions.pop(session_id, None)
            self._expire()
            return {"released": True}
