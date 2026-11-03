"""Disposable, persistent node previews. Originals and project documents are never changed."""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from project_store import StoreError

VERSION = "webp-640-v1"
MAX_BYTES = 128 * 1024 * 1024
MAX_PIXELS = 64 * 1024 * 1024
MAX_CACHE_BYTES = 512 * 1024 * 1024


def _key(identity):
    return hashlib.sha256(json.dumps([VERSION, identity], sort_keys=True).encode()).hexdigest()


def _relative(value, *, nested=False, empty=False):
    if not isinstance(value, str) or (not value and not empty):
        raise StoreError("BAD_REQUEST", "缩略图素材路径无效。", 400)
    if value and (any(c in value for c in "\\:\x00") or value.startswith("/")
                  or any(part in {"", ".", ".."} for part in value.split("/"))
                  or (not nested and "/" in value)):
        raise StoreError("BAD_REQUEST", "缩略图素材路径无效。", 400)
    return value


class ThumbnailCache:
    def __init__(self, root, store, comfy_url):
        self.root = Path(root)
        self.store = store
        self.comfy_url = comfy_url
        self.slots = threading.BoundedSemaphore(2)
        self.prune_lock = threading.Lock()
        self.last_prune = 0

    def _cached(self, identity):
        target = self.root / f"{_key(identity)}.webp"
        return target if target.is_file() else None

    def _encode(self, source, identity):
        cached = self._cached(identity)
        if cached:
            return cached
        self.root.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with Image.open(source) as image:
                if image.width * image.height > MAX_PIXELS:
                    raise StoreError("IMAGE_TOO_LARGE", "图片超过缩略图解码限制，请直接预览原图。", 413)
                # draft reduces JPEG decoding memory; thumbnail preserves aspect ratio.
                image.draft("RGB", (640, 640))
                image.thumbnail((640, 640), Image.Resampling.LANCZOS)
                preview = ImageOps.exif_transpose(image).convert("RGBA")
                with tempfile.NamedTemporaryFile(dir=self.root, suffix=".tmp", delete=False) as output:
                    temporary = Path(output.name)
                    preview.save(output, "WEBP", quality=82, method=4)
                preview.close()
            target = self.root / f"{_key(identity)}.webp"
            os.replace(temporary, target)
            self._prune(target)
            return target
        except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
            raise StoreError("THUMBNAIL_FAILED", "无法生成缩略图，可重试或双击查看原图。", 422) from exc
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)

    def _prune(self, keep):
        if time.monotonic() - self.last_prune < 60 or not self.prune_lock.acquire(blocking=False):
            return
        try:
            self.last_prune = time.monotonic()
            entries = []
            for file in self.root.glob("*.webp"):
                try:
                    stat = file.stat()
                    entries.append((stat.st_mtime_ns, stat.st_size, file))
                except FileNotFoundError:
                    continue
            total = sum(size for _, size, _ in entries)
            for _, size, file in sorted(entries):
                if total <= MAX_CACHE_BYTES:
                    break
                if file != keep:
                    try:
                        file.unlink(missing_ok=True)
                        total -= size
                    except OSError:
                        pass  # A concurrent reader on Windows may hold this cache file.
        finally:
            self.prune_lock.release()

    def _project(self, query):
        project_id = query["project"]
        if not re.fullmatch(r"prj_[A-Za-z0-9_-]+", project_id):
            raise StoreError("BAD_REQUEST", "项目标识无效。", 400)
        asset = _relative(query.get("asset"), nested=True)
        source = self.store.asset_file(project_id, asset)
        before = source.stat()
        if before.st_size > MAX_BYTES:
            raise StoreError("IMAGE_TOO_LARGE", "图片超过缩略图文件限制。", 413)
        identity = [str(source.resolve()), before.st_size, before.st_mtime_ns, before.st_ctime_ns]
        cached = self._cached(identity)
        if cached:
            return cached
        with source.open("rb") as stream:
            result = self._encode(stream, identity)
        after = source.stat()
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            result.unlink(missing_ok=True)
            raise StoreError("SOURCE_CHANGED", "素材正在更新，请重试缩略图。", 409)
        return result

    def _comfy(self, query):
        filename = _relative(query.get("filename"))
        subfolder = _relative(query.get("subfolder", ""), nested=True, empty=True)
        kind = query.get("type", "output")
        if kind not in {"input", "output", "temp"}:
            raise StoreError("BAD_REQUEST", "ComfyUI 素材类型无效。", 400)
        configured = urllib.parse.urlsplit(self.comfy_url)
        if configured.scheme != "http" or not configured.hostname or configured.username or configured.password:
            raise StoreError("THUMBNAIL_UNAVAILABLE", "ComfyUI 地址配置无效。", 503)
        # The client supplies only a media identity, never an origin, URL or filesystem path.
        path = "/view?" + urllib.parse.urlencode({"filename": filename, "subfolder": subfolder, "type": kind})
        connection = http.client.HTTPConnection(configured.hostname, configured.port or 80, timeout=15)
        try:
            connection.request("HEAD", path)
            response = connection.getresponse()
            validator = response.getheader("ETag")
            modified = response.getheader("Last-Modified")
            length = response.getheader("Content-Length")
            status = response.status
            response.read()
            if status not in {200, 405, 501}:
                raise StoreError("THUMBNAIL_SOURCE_UNAVAILABLE", "ComfyUI 素材无法读取。", 502)
            if length and status == 200 and int(length) > MAX_BYTES:
                raise StoreError("IMAGE_TOO_LARGE", "图片超过缩略图文件限制。", 413)
            # ComfyUI's FileResponse exposes a stat-based ETag. Unsupported HEAD
            # or absent validators falls back to a bounded download + content hash.
            identity = [self.comfy_url, path, validator, modified, length] if status == 200 and validator else None
            cached = self._cached(identity) if identity else None
            if cached:
                return cached
            connection.request("GET", path)
            response = connection.getresponse()
            if response.status != 200:
                raise StoreError("THUMBNAIL_SOURCE_UNAVAILABLE", "ComfyUI 素材无法读取。", 502)
            get_validator = response.getheader("ETag")
            # Bind the bytes to GET's validator rather than a possibly stale HEAD.
            if identity and get_validator != validator:
                identity = None
            digest = hashlib.sha256()
            size = 0
            with tempfile.TemporaryFile() as source:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise StoreError("IMAGE_TOO_LARGE", "图片超过缩略图文件限制。", 413)
                    digest.update(chunk)
                    source.write(chunk)
                source.seek(0)
                return self._encode(source, identity or [self.comfy_url, path, digest.hexdigest()])
        except (OSError, http.client.HTTPException, ValueError) as exc:
            raise StoreError("THUMBNAIL_SOURCE_UNAVAILABLE", "无法读取 ComfyUI 缩略图，请稍后重试。", 502) from exc
        finally:
            connection.close()

    def get(self, query):
        allowed = {"project", "asset"} if "project" in query else {"filename", "subfolder", "type"}
        if set(query) - allowed:
            raise StoreError("BAD_REQUEST", "缩略图参数无效。", 400)
        if not self.slots.acquire(timeout=1):
            raise StoreError("THUMBNAIL_BUSY", "缩略图正在处理，请稍后重试。", 503)
        try:
            return self._project(query) if "project" in query else self._comfy(query)
        finally:
            self.slots.release()

    def handle_get(self, handler):
        try:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise StoreError("BAD_REQUEST", "缩略图参数重复。", 400)
            target = self.get({key: values[0] for key, values in query.items()})
            etag = f'"{target.stem}"'
            if handler.headers.get("If-None-Match") == etag:
                handler.send_response(304)
                handler.send_header("ETag", etag)
                handler.end_headers()
                return
            # Read the small derivative before responding; pruning cannot interrupt a response.
            body = target.read_bytes()
            handler.send_response(200)
            handler.send_header("Content-Type", "image/webp")
            handler.send_header("Content-Length", str(len(body)))
            handler.send_header("ETag", etag)
            handler.end_headers()
            handler.wfile.write(body)
        except StoreError as error:
            handler.send_json(error.status, {"code": error.code, "message": error.message})
        except OSError:
            handler.send_json(503, {"code": "THUMBNAIL_UNAVAILABLE", "message": "缩略图缓存暂不可用，请重试。"})
