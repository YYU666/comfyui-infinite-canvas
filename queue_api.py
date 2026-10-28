from __future__ import annotations

import json
import logging
import queue
import re

LOGGER = logging.getLogger("h3-workbench")
JOB_PATH = re.compile(r"^/api/queue/(job_[A-Za-z0-9_-]+)$")
ACTION_PATH = re.compile(r"^/api/queue/(job_[A-Za-z0-9_-]+)/(cancel|retry|priority)$")


class QueueAPI:
    def __init__(self, manager):
        self.manager = manager

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
        if path != "/api/queue" and not ACTION_PATH.fullmatch(path):
            return False
        try:
            payload = self._payload(handler)
            if path == "/api/queue":
                action = payload.get("action")
                if not action:
                    result = self.manager.enqueue(payload)
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
                result = self.manager.retry(job_id)
            else:
                result = self.manager.set_priority(job_id, payload.get("priority", 0))
            handler.send_json(200, result)
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
