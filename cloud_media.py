"""Cloud generation for project-owned canvas nodes, independent of the Comfy queue."""
from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import tempfile
import threading
from pathlib import Path
from io import BytesIO

from PIL import Image

from cloud_media_providers import (
    HTTPS, HTTPStatusError, IMAGE_LIMIT, VIDEO_LIMIT, IMAGE_REFERENCE_COUNT, REFERENCE_LIMIT, PROVIDERS,
    config_for, image_result,
    https_url, invalid, request_for, task_path, task_result,
)
from project_store import StoreError
from workbench_lifecycle import atomic_write_json
from video_edit_ffmpeg import FFmpegError, Runner, _parse_framecrc

PREFIX = "/api/cloud-media"
JOB_PATH = re.compile(PREFIX + r"/(prj_[A-Za-z0-9_-]{1,160})/([0-9a-f]{32})(?:/(submit|refresh|media)(?:/([0-3]))?)?")
ASSET = re.compile(r"assets/[0-9a-f]{64}\.(?:png|jpg|jpeg)")
ROUTE_ERROR = "请重新配置提交任务时的供应商、模型、地址和密钥，再查询原任务。"
NETWORK_ERRORS = (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError, http.client.HTTPException, FFmpegError, Image.DecompressionBombError)
REJECTIONS = {
    400: "request", 401: "authentication", 402: "balance", 403: "permission",
    404: "route", 422: "request", 429: "limit",
}


class CloudMediaAPI:
    def __init__(self, store, directory, transport=None):
        self.store = store
        self.directory = Path(directory) / "cloud-media"
        self.transport = transport or HTTPS()
        self.configs = {}
        self.lock = threading.Lock()
        self.active = set()

    def profiles(self):
        with self.lock:
            return {"providers": [
                {"id": route, "label": p.label, "kind": p.kind, "base": p.base, "models": p.models,
                 "references": p.references, "configured": route in self.configs,
                 "configuration": self.configs[route][0] if route in self.configs else None}
                for route, p in PROVIDERS.items()
            ]}

    def configure(self, payload):
        route = payload.get("provider")
        if not isinstance(route, str) or route not in PROVIDERS:
            invalid("请选择供应商。")
        with self.lock:
            if payload.get("forget") is True:
                self.configs.pop(route, None)
            else:
                config = {**config_for(route, payload), "session": secrets.token_hex(12)}
                key = payload.get("key")
                if not isinstance(key, str) or not re.fullmatch(r"[!-~]{8,4096}", key):
                    invalid("请输入有效的 API 密钥。")
                self.configs[route] = (config, key)
        return self.profiles()

    def project(self, project, *, writable=False):
        store = self.store
        path = store._project_path(project)
        if writable:
            store._require_writable(path)
            if (path.resolve().parent / ".lock", store.owner_id) not in store._held:
                raise StoreError("CLOUD_PROJECT_CLOSED", "项目没有在当前工作台打开并取得写入权限。", 409)
        return store, path, store.get(project)

    def job_file(self, project_path, project, attempt):
        identity = hashlib.sha256(os.fsencode(project_path.resolve()) + b"\0" + project.encode()).hexdigest()
        return self.directory / identity / (attempt + ".json")

    def private_directory(self, path):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.mkdir(mode=0o700, exist_ok=True)

    def route_binding(self, route, config, key):
        self.private_directory(self.directory)
        salt_file = self.directory / "binding"
        if not salt_file.is_file():
            with tempfile.NamedTemporaryFile(dir=self.directory) as temporary:
                temporary.write(secrets.token_bytes(32))
                temporary.flush()
                os.fsync(temporary.fileno())
                try:
                    os.link(temporary.name, salt_file)
                except FileExistsError:
                    pass
        salt = salt_file.read_bytes()
        if len(salt) != 32:
            raise OSError("invalid credential binding")
        return hmac.new(salt, json.dumps([route, {k: v for k, v in config.items() if k != "session"}, key], sort_keys=True).encode(), "sha256").hexdigest()

    @staticmethod
    def read_job(path):
        try:
            return json.loads(path.read_bytes())
        except FileNotFoundError:
            return None

    def view(self, path, job):
        if not job:
            raise StoreError("CLOUD_JOB_NOT_FOUND", "此项目没有这次提交的记录。", 404)
        out = {k: job[k] for k in ("provider", "model", "state", "taskId", "outputs", "rejection") if k in job}
        with self.lock:
            if out["state"] == "submitting" and path not in self.active:
                out["state"] = "submission_unknown"
        return out

    @staticmethod
    def canvas_input(store, project, document, attempt, payload):
        node_id = payload.get("nodeId")
        nodes = {node["id"]: node for node in document["canvas"]["nodes"]}
        node = nodes.get(node_id) if isinstance(node_id, str) else None
        if not node or node.get("type") != "cloudMedia" or node.get("data", {}).get("cloudAttempt") != attempt:
            invalid("请先在当前项目保存云端生成节点。")
        data = node["data"]
        route = data.get("provider")
        if not isinstance(route, str) or route not in PROVIDERS:
            invalid("节点供应商无效。")
        declared = {asset["path"] for asset in document["assets"]}
        references = []
        seen_frames = set()
        for edge in document["canvas"]["edges"]:
            slot = edge.get("targetHandle")
            if edge.get("target") != node_id or slot not in ("references", "first", "last", "single"):
                continue
            source = nodes.get(edge["source"], {})
            source_data = source.get("data", {})
            relative = source_data.get("assetPath")
            if (source.get("type") != "media" or source_data.get("kind") != "image"
                    or not isinstance(relative, str) or not ASSET.fullmatch(relative) or relative not in declared):
                invalid("请先将连接的参考图保存为当前项目的图片素材。")
            max_references = 9 if route == "ark" else IMAGE_REFERENCE_COUNT
            if len(references) >= max_references or (slot != "references" and slot in seen_frames):
                invalid(f"此供应商最多接受 {max_references} 张参考图，每个帧端口只接受一张。")
            if slot != "references":
                seen_frames.add(slot)
            references.append((slot, inline_reference(store.asset_file(project, relative))))
        urls = payload.get("referenceUrls", [])
        if urls and route != "apipool":
            invalid("只有 APIPool 支持填写公开参考图链接。")
        return node_id, route, {**data, "referenceUrls": urls}, references

    def submit(self, project, attempt, payload):
        store, project_path, document = self.project(project, writable=True)
        path = self.job_file(project_path, project, attempt)
        existing = self.read_job(path)
        if existing:
            if existing["nodeId"] != payload.get("nodeId"):
                raise StoreError("CLOUD_JOB_CONFLICT", "提交记录属于同一项目的其他节点。", 409)
            return self.view(path, existing)
        source_node, route, options, references = self.canvas_input(store, project, document, attempt, payload)
        with self.lock:
            credentials = self.configs.get(route)
        if not credentials:
            invalid("请先在节点上配置供应商。")
        config, key = credentials
        if payload.get("configuration") != config:
            raise StoreError("CLOUD_ROUTE_CHANGED", "供应商配置已变更，请刷新节点配置并确认后提交。", 409)
        if options.get("cloudModel") and options["cloudModel"] != config["model"]:
            invalid("节点选择的模型与供应商会话配置不一致。")
        plan = request_for(route, config, options, references)
        self.private_directory(path.parent)
        job = {"nodeId": source_node, "provider": route, "model": config["model"],
               "binding": self.route_binding(route, config, key), "state": "submitting", "count": plan.get("n", 1)}
        with self.lock:
            existing = self.read_job(path)
            if not existing:
                # ProjectStore gives one workbench process the project write lock.
                atomic_write_json(path, job)
                self.active.add(path)
        if existing:
            if existing["nodeId"] != source_node:
                raise StoreError("CLOUD_JOB_CONFLICT", "提交记录属于同一项目的其他节点。", 409)
            return self.view(path, existing)
        try:
            try:
                try:
                    reply = self.transport.submit(route, config, key, plan)
                except HTTPStatusError as error:
                    if error.status not in REJECTIONS:
                        raise
                    job.update(state="rejected", rejection=REJECTIONS[error.status])
                    atomic_write_json(path, job)
                    return self.view(path, job)
                if PROVIDERS[route].poll:
                    task, state, resource = task_result(route, config["model"], reply, count=job["count"])
                    job.update(taskId=task, state=state if state != "ready" else "pending")
                    atomic_write_json(path, job)
                    if state == "ready":
                        self.receive(path, job, "url", resource)
                else:
                    method, resource = image_result(route, reply)
                    if method == "url":
                        https_url(resource)
                        job.update(state="download_pending", resource=resource)
                        atomic_write_json(path, job)
                    self.receive(path, job, method, resource)
            except NETWORK_ERRORS:
                if job["state"] == "submitting":
                    job["state"] = "submission_unknown"
                atomic_write_json(path, job)
            return self.view(path, job)
        finally:
            with self.lock:
                self.active.discard(path)

    def refresh(self, path, job):
        if job["state"] in ("done", "failed", "rejected", "submitting", "submission_unknown"):
            return self.view(path, job)
        route = job["provider"]
        with self.lock:
            if path in self.active:
                return {"state": "pending"}
            credentials = self.configs.get(route)
            self.active.add(path)
        try:
            job = self.read_job(path)
            if job["state"] in ("done", "failed", "rejected"):
                return self.view(path, job)
            if not credentials or not hmac.compare_digest(job["binding"], self.route_binding(route, *credentials)):
                raise StoreError("CLOUD_ROUTE_CHANGED", ROUTE_ERROR, 409)
            config, key = credentials
            try:
                if job["state"] == "download_pending":
                    self.receive(path, job, "url", job["resource"])
                else:
                    task = job["taskId"]
                    reply = self.transport.json("GET", config["base"] + task_path(route, task), key)
                    _, state, resource = task_result(route, config["model"], reply, task, job["count"])
                    if state == "ready":
                        self.receive(path, job, "url", resource)
                    else:
                        job["state"] = state
                        atomic_write_json(path, job)
            except NETWORK_ERRORS:
                raise StoreError("CLOUD_QUERY_UNCONFIRMED", "本次未能确认原任务或下载结果，可继续查单。", 502) from None
            return self.view(path, job)
        finally:
            with self.lock:
                self.active.discard(path)

    def receive(self, path, job, method, resource):
        resources = resource if isinstance(resource, list) else [resource]
        outputs = [self.receive_one(path, job, method, value, index) for index, value in enumerate(resources)]
        new = {k: v for k, v in job.items() if k != "resource"}
        new.update(state="done", outputs=outputs)
        atomic_write_json(path, new)
        job.clear()
        job.update(new)

    def receive_one(self, path, job, method, resource, index):
        media = path.with_suffix(f".{index}.media")
        kind = PROVIDERS[job["provider"]].kind
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temp:
            temporary = Path(temp.name)
            try:
                if method == "base64":
                    if not isinstance(resource, str) or len(resource) > (IMAGE_LIMIT + 2) // 3 * 4:
                        raise ValueError("invalid image")
                    temp.write(base64.b64decode(resource, validate=True))
                else:
                    self.transport.copy("GET", resource, temp, IMAGE_LIMIT if kind == "image" else VIDEO_LIMIT)
                temp.flush()
                os.fsync(temp.fileno())
                mime, extension, metadata = verify_media(temporary, kind)
                temp.close()
                os.replace(temporary, media)
            finally:
                temp.close()
                temporary.unlink(missing_ok=True)
        return {"mime": mime, "metadata": metadata, "name": f"{job['provider']}-{path.stem[:12]}-{index + 1}.{extension}"}

    def handle(self, handler, method, request_path):
        if not request_path.startswith(PREFIX + "/"):
            return False
        try:
            if request_path == PREFIX + "/providers":
                payload = self.profiles() if method == "GET" else self.configure(read_payload(handler))
            elif match := JOB_PATH.fullmatch(request_path):
                project, attempt, action, output = match.groups()
                if (action == "media") != (output is not None):
                    raise StoreError("CLOUD_NOT_FOUND", "接口不存在。", 404)
                if method == "POST" and action == "submit":
                    payload = self.submit(project, attempt, read_payload(handler))
                elif (method, action) in (("GET", None), ("GET", "media"), ("POST", "refresh")):
                    _, project_path, _ = self.project(project, writable=action is not None)
                    path = self.job_file(project_path, project, attempt)
                    job = self.read_job(path)
                    if not job:
                        self.view(path, job)
                    if action == "media":
                        self.send_media(handler, path, job, int(output))
                        return True
                    payload = self.refresh(path, job) if action == "refresh" else self.view(path, job)
                else:
                    raise StoreError("CLOUD_NOT_FOUND", "接口不存在。", 404)
            else:
                raise StoreError("CLOUD_NOT_FOUND", "接口不存在。", 404)
            handler.send_json(200, payload)
        except StoreError as error:
            handler.send_json(error.status, {"code": error.code, "message": error.message})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (OSError, ValueError, RecursionError):
            handler.send_json(500, {"code": "CLOUD_STORAGE_ERROR", "message": "云端任务记录或素材暂不可访问。"})
        return True

    @staticmethod
    def send_media(handler, path, job, index):
        if job["state"] != "done":
            raise StoreError("CLOUD_NOT_READY", "任务素材尚未准备好。", 409)
        if not index < len(job["outputs"]):
            raise StoreError("CLOUD_NOT_FOUND", "素材不存在。", 404)
        with path.with_suffix(f".{index}.media").open("rb") as source:
            handler.send_response(200)
            handler.send_header("Content-Type", job["outputs"][index]["mime"])
            handler.send_header("Content-Length", str(os.fstat(source.fileno()).st_size))
            handler.send_header("Cache-Control", "no-store")
            handler.end_headers()
            shutil.copyfileobj(source, handler.wfile, 128 * 1024)


def read_payload(handler):
    try:
        length = int(handler.headers.get("Content-Length", "0"))
        if not 0 < length <= 48 * 1024:
            raise ValueError
        data = json.loads(handler.rfile.read(length))
        if not isinstance(data, dict):
            raise ValueError
    except (ValueError, RecursionError):
        invalid("请求不是有效的云端配置或任务参数。")
    return data


def inline_reference(path):
    with path.open("rb") as source:
        raw = source.read(REFERENCE_LIMIT + 1)
    if not raw or len(raw) > REFERENCE_LIMIT:
        invalid("参考图须为 3 MB 以内的 PNG 或 JPEG。")
    try:
        with Image.open(BytesIO(raw)) as image:
            mime = {"PNG": "image/png", "JPEG": "image/jpeg"}.get(image.format)
            if not mime or not (0 < image.width <= 8192 and 0 < image.height <= 8192) or getattr(image, "n_frames", 1) != 1:
                raise ValueError("invalid reference image")
            image.verify()
    except (OSError, ValueError, Image.DecompressionBombError):
        invalid("参考图格式或尺寸无效，请选择单帧 PNG 或 JPEG。")
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


def verify_media(path, kind):
    if kind == "image":
        with Image.open(path) as image:
            extension = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}.get(image.format)
            if not extension or not (0 < image.width <= 8192 and 0 < image.height <= 8192) or getattr(image, "n_frames", 1) != 1:
                raise ValueError("invalid image")
            image.verify()
        with Image.open(path) as image:
            image.load()
            dimensions = {"width": image.width, "height": image.height}
        mime = "image/jpeg" if extension == "jpg" else f"image/{extension}"
        return mime, extension, dimensions
    duration = mp4_duration(path)
    output = Runner().run([
        "-protocol_whitelist", "file,pipe", "-f", "mov", "-enable_drefs", "0",
        "-max_pixels", "67108864", "-threads", "2", "-xerror", "-i", str(path),
        "-map", "0:V:0", "-an", "-sn", "-dn",
        "-frames:v", "1", "-c:v", "wrapped_avframe", "-f", "framecrc", "-",
    ], timeout=25)
    streams, rows = _parse_framecrc(output.decode("utf-8", "replace"))
    video = streams.get(0, {})
    if video.get("media_type") != "video" or not rows.get(0):
        raise ValueError("MP4 has no decodable video")
    width, height = map(int, video["dimensions"].split("x"))
    if not (0 < width <= 8192 and 0 < height <= 8192):
        raise ValueError("invalid video dimensions")
    return "video/mp4", "mp4", {"width": width, "height": height, "duration": duration}


def mp4_boxes(source, start, end):
    # Bounded walks of the top level and the movie header's immediate children.
    for _ in range(512):
        if start == end:
            return
        source.seek(start)
        header = source.read(8)
        if len(header) != 8:
            raise ValueError("incomplete MP4 header")
        size, tag = int.from_bytes(header[:4], "big"), header[4:]
        minimum = 8
        if size == 1:
            large_size = source.read(8)
            if len(large_size) != 8:
                raise ValueError("incomplete MP4 large box")
            size, minimum = int.from_bytes(large_size, "big"), 16
        if size == 0:
            size = end - start
        if size < minimum or start + size > end:
            raise ValueError("invalid MP4 box size")
        yield tag, start + minimum, start + size
        start += size
    if start != end:
        raise ValueError("too many MP4 boxes")


def mp4_duration(path):
    with path.open("rb") as source:
        boxes = list(mp4_boxes(source, 0, path.stat().st_size))
        if not any(tag == b"ftyp" and end - start >= 8 for tag, start, end in boxes):
            raise ValueError("missing MP4 file type")
        if not any(tag == b"mdat" and end > start for tag, start, end in boxes):
            raise ValueError("missing MP4 video data")
        movie, = [(start, end) for tag, start, end in boxes if tag == b"moov"]
        header, = [(start, end) for tag, start, end in mp4_boxes(source, *movie) if tag == b"mvhd"]
        source.seek(header[0])
        data = source.read(min(32, header[1] - header[0]))
        if len(data) >= 20 and data[0] == 0:
            tick_bytes, duration_bytes = data[12:16], data[16:20]
        elif len(data) >= 32 and data[0] == 1:
            tick_bytes, duration_bytes = data[20:24], data[24:32]
        else:
            raise ValueError("invalid MP4 duration header")
    tick_rate = int.from_bytes(tick_bytes, "big")
    ticks = int.from_bytes(duration_bytes, "big")
    if not tick_rate or not 0 < ticks <= tick_rate * 3600:
        raise ValueError("invalid MP4 duration")
    return ticks / tick_rate
