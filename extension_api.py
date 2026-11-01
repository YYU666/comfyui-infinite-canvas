"""Extension HTTP adapter; launcher authentication guards run before dispatch."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

from workflow_extensions import ExtensionError, ExtensionStore, MAX_ARCHIVE, read_json


class ExtensionAPI:
    def __init__(self, store: ExtensionStore, comfy_url="http://127.0.0.1:8188", object_info=None):
        self.store = store
        self.comfy_url = comfy_url.rstrip("/")
        self.object_info = object_info or self._object_info

    def _object_info(self):
        try:
            with urllib.request.urlopen(self.comfy_url + "/object_info", timeout=15) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError("response too large")
            return json.loads(data)
        except (OSError, ValueError) as exc:
            raise ExtensionError("无法读取 ComfyUI 节点信息，请确认服务就绪。", "COMFY_UNAVAILABLE", 503) from exc

    @staticmethod
    def _read(handler, maximum):
        if handler.headers.get("Transfer-Encoding"):
            raise ExtensionError("扩展请求不支持分块传输。", "BAD_REQUEST")
        raw = handler.headers.get("Content-Length", "")
        if not raw.isascii() or not raw.isdigit():
            raise ExtensionError("Content-Length 无效。", "BAD_REQUEST")
        length = int(raw)
        if length <= 0 or length > maximum:
            raise ExtensionError("请求内容为空或超过大小限制。", "REQUEST_TOO_LARGE", 413)
        data = handler.rfile.read(length)
        if len(data) != length:
            raise ExtensionError("请求内容被截断，尚未写入扩展。", "TRUNCATED_BODY")
        return data

    @staticmethod
    def _error(handler, exc):
        handler.send_json(exc.status, {"code": exc.code, "message": exc.message, "details": {}})

    def handle_get(self, handler, path):
        if path != "/api/extensions" and not path.startswith("/api/extensions/"):
            return False
        try:
            if path == "/api/extensions":
                handler.send_json(200, self.store.list())
            else:
                parts = path.removeprefix("/api/extensions/").split("/")
                if len(parts) == 1:
                    handler.send_json(200, self.store.get(parts[0]))
                elif len(parts) == 2 and parts[1] == "download":
                    data = self.store.download(parts[0])
                    handler.send_response(200)
                    handler.send_header("Content-Type", "application/zip")
                    handler.send_header("Content-Disposition", f'attachment; filename="{parts[0]}.h3pack"')
                    handler.send_header("Content-Length", str(len(data)))
                    handler.end_headers()
                    handler.wfile.write(data)
                else:
                    raise ExtensionError("扩展接口不存在。", "NOT_FOUND", 404)
        except ExtensionError as exc:
            self._error(handler, exc)
        except OSError:
            self._error(handler, ExtensionError("扩展存储暂时无法读取。", "EXTENSION_STORAGE_ERROR", 503))
        return True

    def handle_post(self, handler, path):
        if not path.startswith("/api/extensions/"):
            return False
        try:
            if path == "/api/extensions/import":
                data = self._read(handler, MAX_ARCHIVE)
                filename = urllib.parse.unquote(handler.headers.get("X-Filename", "workflow.json"))
                result = self.store.import_bytes(data, filename)
            else:
                parts = path.removeprefix("/api/extensions/").split("/")
                if len(parts) != 2 or parts[1] != "prepare":
                    raise ExtensionError("扩展接口不存在。", "NOT_FOUND", 404)
                payload = read_json(self._read(handler, 2 * 1024 * 1024), "prepare")
                # Resolve the pinned package before making an external request.
                self.store.get(parts[0])
                result = self.store.prepare(parts[0], payload, self.object_info())
            handler.send_json(200, result)
        except ExtensionError as exc:
            self._error(handler, exc)
        except OSError:
            self._error(handler, ExtensionError("扩展存储暂时无法写入。", "EXTENSION_STORAGE_ERROR", 503))
        return True
