"""HTTP API adapter for local model management, locks, usage tiers, and pinned updates."""
from __future__ import annotations

import json

from workbench_models import ModelManager, ModelManagerError


class ModelManagerAPI:
    def __init__(self, manager: ModelManager):
        self.manager = manager

    @staticmethod
    def _read_json(handler, *, allow_empty: bool = False) -> dict:
        if handler.headers.get("Transfer-Encoding"):
            raise ModelManagerError("不支持分块传输请求。", status=400, code="BAD_REQUEST")
        raw_len = handler.headers.get("Content-Length", "")
        if not raw_len and allow_empty:
            return {}
        if not raw_len.isascii() or not raw_len.isdigit():
            raise ModelManagerError("缺少有效 Content-Length。", status=400, code="BAD_REQUEST")
        length = int(raw_len)
        if length == 0 and allow_empty:
            return {}
        if length < 2 or length > 8192:
            raise ModelManagerError("请求体大小无效。", status=400, code="BAD_REQUEST")
        data = handler.rfile.read(length)
        if len(data) != length:
            raise ModelManagerError("请求内容被截断。", status=400, code="BAD_REQUEST")
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ModelManagerError("请求体不是合法 JSON。", status=400, code="BAD_REQUEST") from exc
        if not isinstance(payload, dict):
            raise ModelManagerError("请求体必须是 JSON 对象。", status=400, code="BAD_REQUEST")
        return payload

    @staticmethod
    def _send_error(handler, exc: ModelManagerError) -> None:
        handler.send_json(exc.status, {"ok": False, "code": exc.code, "message": exc.message, "details": exc.details})

    def handle_get(self, handler, path: str) -> bool:
        if path != "/api/models":
            return False
        try:
            handler.send_json(200, self.manager.snapshot())
        except ModelManagerError as exc:
            self._send_error(handler, exc)
        return True

    def handle_post(self, handler, path: str) -> bool:
        if path not in {
            "/api/models/lock",
            "/api/models/lock-installed",
            "/api/models/delete",
            "/api/models/verify",
            "/api/models/download",
            "/api/models/cancel",
        }:
            return False
        try:
            payload = self._read_json(handler, allow_empty=(path == "/api/models/lock-installed"))
            if path == "/api/models/lock-installed":
                handler.send_json(200, self.manager.lock_all_installed())
            elif path == "/api/models/lock":
                handler.send_json(200, self.manager.set_lock(payload.get("path"), payload.get("locked")))
            elif path == "/api/models/delete":
                handler.send_json(200, self.manager.delete_model(payload.get("path")))
            elif path == "/api/models/verify":
                handler.send_json(200, self.manager.verify_model(payload.get("path")))
            elif path == "/api/models/download":
                handler.send_json(202, self.manager.start_download(payload.get("path")))
            elif path == "/api/models/cancel":
                handler.send_json(200, self.manager.cancel_download(payload.get("path")))
        except ModelManagerError as exc:
            self._send_error(handler, exc)
        return True
