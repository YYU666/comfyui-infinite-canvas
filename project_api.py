from __future__ import annotations

import json
import re
import subprocess
import urllib.parse
import uuid
from pathlib import Path

from project_store import ProjectStore, StoreError, default_projects_root


class LimitedStream:
    def __init__(self, stream, remaining):
        self.stream = stream
        self.remaining = remaining

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        if size is None or size < 0:
            size = self.remaining
        chunk = self.stream.read(min(size, self.remaining))
        self.remaining -= len(chunk)
        return chunk


class ProjectAPI:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def _error(handler, error):
        handler.send_json(error.status, {"code": error.code, "message": error.message, "details": error.details})

    def _json(self, handler, maximum=128 * 1024 * 1024):
        length = int(handler.headers.get("Content-Length", "0"))
        if length <= 0 or length > maximum:
            raise StoreError("BAD_REQUEST", "请求内容无效或过大。")
        try:
            value = json.loads(handler.rfile.read(length).decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise StoreError("BAD_REQUEST", "JSON 请求格式无效。") from exc
        if not isinstance(value, dict):
            raise StoreError("BAD_REQUEST", "JSON 请求必须是对象。")
        return value

    def handle_get(self, handler, path):
        if not path.startswith("/api/projects"):
            return False
        try:
            return self._handle_get(handler, path)
        except StoreError as error:
            self._error(handler, error)
            return True

    def _handle_get(self, handler, path):
        if path == "/api/projects":
            handler.send_json(200, {"projects": self.store.list()})
            return True
        if path == "/api/projects/trash":
            handler.send_json(200, {"projects": self.store.list_trash()})
            return True
        match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)", path)
        if match:
            handler.send_json(200, self.store.get(match.group(1)))
            return True
        match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)/assets/(.+)", path)
        if match:
            relative = urllib.parse.unquote(match.group(2))
            if not relative.startswith("assets/"):
                relative = f"assets/{relative}"
            file_path = self.store.asset_file(match.group(1), relative)
            status, headers, start, length = self.store.range_response(file_path, handler.headers.get("Range"))
            handler.send_response(status)
            for name, value in headers.items():
                handler.send_header(name, value)
            handler.end_headers()
            with file_path.open("rb") as source:
                source.seek(start)
                remaining = length
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                    remaining -= len(chunk)
            return True
        if path.startswith("/api/projects"):
            handler.send_json(404, {"code": "NOT_FOUND", "message": "项目接口不存在。", "details": {}})
            return True
        return False

    def handle_post(self, handler, path):
        if not path.startswith("/api/projects"):
            return False
        try:
            if path == "/api/projects":
                payload = self._json(handler)
                directory = payload.get("directory")
                if directory:
                    directory = Path(directory).expanduser().resolve()
                    root = self.store.root
                    if root != directory.parent:
                        raise StoreError("FORBIDDEN", "通过网页新建的项目必须位于默认项目根目录。", 403)
                document = self.store.create(payload.get("name"), payload.get("canvas"), payload.get("template", "blank"), directory)
                handler.send_json(201, document)
                return True
            if path == "/api/projects/open":
                payload = self._json(handler)
                read_only = bool(payload.get("readOnly"))
                if payload.get("path"):
                    document = self.store.open_path(payload["path"], read_only=read_only)
                else:
                    document = self.store.open(payload.get("id"), read_only=read_only)
                handler.send_json(200, document)
                return True
            if path == "/api/projects/migration-backup":
                length = int(handler.headers.get("Content-Length", "0"))
                if length <= 0 or length > 8 * 1024 * 1024 * 1024:
                    raise StoreError("BAD_REQUEST", "迁移备份为空或超过大小限制。")
                backups = self.store.root / ".migration-backups"
                backups.mkdir(parents=True, exist_ok=True)
                target = backups / f"indexeddb-{uuid.uuid4().hex}.zip"
                with target.open("wb") as output:
                    source = LimitedStream(handler.rfile, length)
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                handler.send_json(201, {"path": str(target), "bytes": target.stat().st_size})
                return True
            if path == "/api/projects/import":
                if handler.headers.get("Content-Type", "").split(";")[0] in {"application/zip", "application/x-zip-compressed", "application/octet-stream"}:
                    length = int(handler.headers.get("Content-Length", "0"))
                    if length <= 0 or length > 8 * 1024 * 1024 * 1024:
                        raise StoreError("BAD_REQUEST", "项目包为空或超过导入限制。")
                    self.store.root.mkdir(parents=True, exist_ok=True)
                    temporary = self.store.root / f".upload-{uuid.uuid4().hex}.zip"
                    try:
                        with temporary.open("wb") as output:
                            source = LimitedStream(handler.rfile, length)
                            while True:
                                chunk = source.read(1024 * 1024)
                                if not chunk:
                                    break
                                output.write(chunk)
                        document = self.store.import_zip(temporary)
                    finally:
                        temporary.unlink(missing_ok=True)
                else:
                    payload = self._json(handler)
                    document = self.store.import_zip(payload.get("path"))
                handler.send_json(201, document)
                return True
            if path == "/api/projects/restore":
                payload = self._json(handler)
                handler.send_json(200, self.store.restore(payload.get("name")))
                return True
            match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)/(duplicate|export)", path)
            if match:
                if match.group(2) == "duplicate":
                    handler.send_json(201, self.store.duplicate(match.group(1)))
                else:
                    archive = self.store.export(match.group(1))
                    handler.send_json(200, {"path": str(archive), "name": archive.name, "bytes": archive.stat().st_size})
                return True
            match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)/reveal", path)
            if match:
                project_file = self.store._project_path(match.group(1))
                subprocess.Popen(["explorer.exe", f"/select,{project_file}"], close_fds=True)
                handler.send_json(200, {"ok": True})
                return True
            handler.send_json(404, {"code": "NOT_FOUND", "message": "项目接口不存在。", "details": {}})
            return True
        except StoreError as error:
            self._error(handler, error)
            return True

    def handle_put(self, handler, path):
        if not path.startswith("/api/projects"):
            return False
        try:
            match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)", path)
            if match:
                document = self._json(handler)
                expected = handler.headers.get("If-Match", "").strip().strip('"')
                if expected.startswith("W/"):
                    expected = expected[2:].strip('"')
                expected = int(expected or document.get("revision", 0))
                handler.send_json(200, self.store.save(match.group(1), document, expected))
                return True
            match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)/assets/(.+)", path)
            if match:
                length = int(handler.headers.get("Content-Length", "0"))
                if length <= 0 or length > 2 * 1024 * 1024 * 1024:
                    raise StoreError("BAD_REQUEST", "素材为空或超过 2 GB。")
                filename = Path(urllib.parse.unquote(match.group(2))).name
                result = self.store.put_asset(match.group(1), filename, LimitedStream(handler.rfile, length), handler.headers.get("Content-Type"))
                handler.send_json(201, result)
                return True
            handler.send_json(404, {"code": "NOT_FOUND", "message": "项目接口不存在。", "details": {}})
            return True
        except (ValueError, StoreError) as error:
            if isinstance(error, StoreError):
                self._error(handler, error)
            else:
                handler.send_json(400, {"code": "BAD_REQUEST", "message": "revision 或 Content-Length 无效。", "details": {}})
            return True

    def handle_delete(self, handler, path):
        match = re.fullmatch(r"/api/projects/(prj_[A-Za-z0-9_-]+)", path)
        if not match:
            return False
        try:
            handler.send_json(200, self.store.delete(match.group(1)))
        except StoreError as error:
            self._error(handler, error)
        return True
