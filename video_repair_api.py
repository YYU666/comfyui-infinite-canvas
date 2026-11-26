"""HTTP adapter. Mount only after launcher host/origin/session-token guards."""
from __future__ import annotations

import json
import re

from project_store import StoreError
from video_job_submission import submit_video_from_page

PREFIX = "/api/video-repair/"


class VideoRepairAPI:
    def __init__(self, jobs):
        self.jobs = jobs

    @staticmethod
    def _json(handler, maximum=16 * 1024):
        try:
            length = int(handler.headers.get("Content-Length", "0"))
            if not 0 < length <= maximum:
                raise ValueError()
            value = json.loads(handler.rfile.read(length).decode("utf-8"),
                               parse_constant=lambda name: (_ for _ in ()).throw(ValueError(name)))
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError, RecursionError) as error:
            raise StoreError("BAD_REQUEST", "JSON 请求为空、过大或格式无效。") from error

    def _handle(self, handler, path, post):
        if not path.startswith(PREFIX):
            return False
        try:
            match = re.fullmatch(r"/api/video-repair/jobs/(vrp_[a-f0-9]{32})(?:/(cancel|commit))?", path)
            if post and path == PREFIX + "jobs":
                handler.send_json(201, submit_video_from_page(handler, self.jobs, self._json(handler)))
            elif post and path == PREFIX + "preview":
                handler.send_json(200, self.jobs.preview(self._json(handler)))
            elif match and not post and match[2] is None:
                handler.send_json(200, self.jobs.get(match[1]))
            elif match and post and match[2] == "cancel":
                payload = self._json(handler, 4096)
                if set(payload) != {"projectId"}:
                    raise StoreError("BAD_REQUEST", "cancel 只接受 projectId。")
                handler.send_json(200, self.jobs.cancel(match[1], payload["projectId"]))
            elif match and post and match[2] == "commit":
                handler.send_json(201, self.jobs.commit(match[1], self._json(handler, 4096)))
            else:
                handler.send_json(404, {"code": "NOT_FOUND", "message": "接口不存在。", "details": {}})
        except StoreError as error:
            handler.send_json(error.status, {"code": error.code, "message": error.message, "details": error.details})
        return True

    def handle_get(self, handler, path):
        return self._handle(handler, path, False)

    def handle_post(self, handler, path):
        return self._handle(handler, path, True)
