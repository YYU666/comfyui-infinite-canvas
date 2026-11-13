"""HTTP adapter for the white-model plate. The launcher applies host checks first."""
from __future__ import annotations

import json
import re

from project_store import StoreError

PREFIX = "/api/video-plate/"


class VideoPlateAPI:
    def __init__(self, jobs):
        self.jobs = jobs

    @staticmethod
    def _json(handler, maximum=64 * 1024):
        try:
            length = int(handler.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise StoreError("BAD_REQUEST", "Content-Length 无效。") from error
        if length <= 0 or length > maximum:
            raise StoreError("BAD_REQUEST", "请求为空或过大。")
        try:
            value = json.loads(handler.rfile.read(length).decode("utf-8"), parse_constant=lambda name: (_ for _ in ()).throw(ValueError(name)))
        except (UnicodeError, ValueError) as error:
            raise StoreError("BAD_REQUEST", "JSON 请求格式无效。") from error
        if not isinstance(value, dict):
            raise StoreError("BAD_REQUEST", "JSON 请求必须是对象。")
        return value

    @staticmethod
    def _error(handler, error):
        handler.send_json(error.status, {"code": error.code, "message": error.message, "details": error.details})

    def handle_get(self, handler, path):
        if not path.startswith(PREFIX):
            return False
        try:
            if match := re.fullmatch(r"/api/video-plate/jobs/(vwp_[a-f0-9]{32})", path):
                handler.send_json(200, self.jobs.get(match[1]))
            else:
                handler.send_json(404, {"code": "NOT_FOUND", "message": "接口不存在。", "details": {}})
        except StoreError as error:
            self._error(handler, error)
        return True

    def handle_post(self, handler, path):
        if not path.startswith(PREFIX):
            return False
        try:
            if path == "/api/video-plate/jobs":
                handler.send_json(201, self.jobs.submit(self._json(handler)))
            elif match := re.fullmatch(r"/api/video-plate/jobs/(vwp_[a-f0-9]{32})/cancel", path):
                payload = self._json(handler, 4096)
                if set(payload) != {"projectId"}:
                    raise StoreError("BAD_REQUEST", "cancel 只接受 projectId。")
                handler.send_json(200, self.jobs.cancel(match[1], payload["projectId"]))
            elif match := re.fullmatch(r"/api/video-plate/jobs/(vwp_[a-f0-9]{32})/commit", path):
                handler.send_json(201, self.jobs.commit(match[1], self._json(handler, 4096)))
            else:
                handler.send_json(404, {"code": "NOT_FOUND", "message": "接口不存在。", "details": {}})
        except StoreError as error:
            self._error(handler, error)
        return True
