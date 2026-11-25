"""Provider wire formats and a bounded, direct HTTPS transport for cloud media."""
from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
import http.client
import ipaddress
import json
import re
import secrets
import socket
import threading
import time
from urllib.parse import quote, urlsplit

from PIL import Image

from project_store import StoreError

REFERENCE_LIMIT = 3_000_000
IMAGE_REFERENCE_COUNT = 16
IMAGE_LIMIT = 20 * 1024 * 1024
VIDEO_LIMIT = 256 * 1024 * 1024
MODEL = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}")
TASK = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}")
APIPOOL_TASK = re.compile(r"imgtask_[a-zA-Z0-9_-]{1,120}")


@dataclass(frozen=True)
class Provider:
    label: str
    kind: str
    base: str
    path: str
    models: tuple = ()
    poll: str = ""
    references: str = "none"


PROVIDERS = {
    "images": Provider("兼容 Images 网关", "image", "", "/images/generations"),
    "responses": Provider("OpenAI 兼容 Responses", "image", "https://api.openai.com/v1", "/responses", references="images"),
    "qianwen": Provider("千问多模态", "image", "https://maas.qianwenaiapi.com/api/v1",
                        "/services/aigc/multimodal-generation/generation", ("qwen-image-3.0-pro",), references="images"),
    "apipool": Provider("APIPool 图片", "image", "https://app.apipool.dev/v1", "/images/generations",
                        ("gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"), "/tasks/", "urls"),
    "ark": Provider("火山引擎 Seedance Mini", "video", "https://ark.cn-beijing.volces.com/api/v3",
                    "/contents/generations/tasks", ("doubao-seedance-2-0-mini-260615",), "/contents/generations/tasks/", "ark"),
    "wan-beijing": Provider("万相 Flash · 北京", "video", "https://dashscope.aliyuncs.com/api/v1",
                           "/services/aigc/video-generation/video-synthesis", ("wan2.6-i2v-flash",), "/tasks/", "first"),
    "wan-singapore": Provider("万相 Flash · 新加坡", "video", "https://dashscope-intl.aliyuncs.com/api/v1",
                             "/services/aigc/video-generation/video-synthesis", ("wan2.6-i2v-flash",), "/tasks/", "first"),
}


def invalid(message):
    raise StoreError("CLOUD_INVALID", message)


def https_url(value, *, base=False):
    if not isinstance(value, str) or not value.isascii() or len(value) > 8192 or re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError("invalid URL")
    url = urlsplit(value)
    if (url.scheme != "https" or not re.fullmatch(r"(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]{1,62}", url.netloc)
            or url.netloc.lower().endswith((".local", ".localhost", ".internal", ".test", ".invalid"))
            or "#" in value or (base and ("?" in value or "%" in url.path or ".." in url.path))):
        raise ValueError("invalid HTTPS origin")
    return url


class PublicHTTPS(http.client.HTTPSConnection):
    """Resolve once, connect to the checked IP, and verify TLS for the original hostname."""

    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global
                                or ipaddress.ip_address(item[4][0]).is_multicast for item in addresses):
            raise OSError("non-public address")
        deadline = time.monotonic() + self.timeout
        for family, socktype, proto, _, address in addresses:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            sock = socket.socket(family, socktype, proto)
            try:
                sock.settimeout(remaining)
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError:
                sock.close()
        raise OSError("HTTPS connect failed")


class HTTPStatusError(OSError):
    def __init__(self, status):
        super().__init__("provider HTTP error")
        self.status = status


class HTTPS:
    def connection(self, value, timeout):
        url = https_url(value)
        return PublicHTTPS(url.hostname, timeout=timeout), url

    def copy(self, method, value, destination, limit, *, body=None, headers=None, timeout=120, expected_status=None):
        conn, url = self.connection(value, min(timeout, 20))
        target = url.path or "/"
        if url.query:
            target += "?" + url.query
        deadline = time.monotonic() + timeout
        timer = None
        try:
            conn.connect()
            sock = conn.sock
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            timer = threading.Timer(remaining, interrupt_request, args=(sock,))
            timer.daemon = True
            timer.start()
            sock.settimeout(remaining)
            conn.request(method, target, body=body, headers=headers or {})
            # This transport never pools connections. Keep ownership of the socket until
            # the body is read, including when the peer uses Connection: close or HTTP/1.0.
            with conn.response_class(sock, method=method) as response:
                response.begin()
                # Redirects and provider errors are never forwarded or logged.
                if not 200 <= response.status < 300:
                    raise HTTPStatusError(response.status)
                if expected_status is not None and response.status != expected_status:
                    raise OSError("unexpected provider status")
                if int(response.getheader("Content-Length", "0")) > limit:
                    raise OSError("response too large")
                total = 0
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError
                    sock.settimeout(min(remaining, 20))
                    chunk = response.read1(min(128 * 1024, limit - total + 1))
                    if not chunk:
                        if time.monotonic() >= deadline:
                            raise TimeoutError
                        break
                    total += len(chunk)
                    if total > limit:
                        raise OSError("response too large")
                    destination.write(chunk)
                if not total or (response.length is not None and response.length != 0):
                    raise OSError("incomplete response")
        finally:
            if timer:
                timer.cancel()
            conn.close()

    def json(self, method, url, key, payload=None, *, async_header=False, png=None, expected_status=None):
        dest = BytesIO()
        headers = {"Accept": "application/json", "Authorization": f"Bearer {key}"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if png is not None:
            boundary = "cloudmedia-" + secrets.token_hex(24)
            headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
            body = multipart(boundary, payload, png)
        else:
            body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        if async_header:
            headers["X-DashScope-Async"] = "enable"
        self.copy(method, url, dest, IMAGE_LIMIT * 4 // 3 + 1024 * 1024,
                  body=body, headers=headers, timeout=300 if method == "POST" else 60, expected_status=expected_status)
        data = json.loads(dest.getvalue())
        if not isinstance(data, dict) or data.get("error") or data.get("code"):
            raise ValueError("provider result rejected")
        return data


    def submit(self, route, config, key, payload):
        png = payload.get("_editPng")
        body = {key: value for key, value in payload.items() if key != "_editPng"}
        path = "/images/edits" if png is not None else PROVIDERS[route].path
        return self.json("POST", config["base"] + path, key, body, png=png,
                         async_header=route.startswith("wan-"), expected_status=202 if route == "apipool" else None)


def interrupt_request(sock):
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def multipart(boundary, fields, image):
    parts = []
    for field, value in fields.items():
        parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n'.encode(),
                      str(value).encode(), b"\r\n"])
    parts.extend([f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="source.png"\r\n'.encode(),
                  b"Content-Type: image/png\r\n\r\n", image, f"\r\n--{boundary}--\r\n".encode()])
    return b"".join(parts)


def config_for(route, body):
    profile = PROVIDERS[route]
    base = profile.base
    if not profile.models:
        base = body.get("base", base)
        try:
            https_url(base, base=True)
        except ValueError:
            invalid("API 地址必须是公开 DNS 上的 HTTPS 基础地址。")
        base = base.rstrip("/")
    model = body.get("model")
    if not isinstance(model, str) or not MODEL.fullmatch(model) or profile.models and model not in profile.models:
        invalid("请选择或填写有效的模型 ID。")
    return {"base": base, "model": model}


def wan_frame(value):
    prefix = "data:image/png;base64,"
    if not value.startswith(prefix) or len(value) - len(prefix) > 4_000_000:
        invalid("万相首帧须是不透明 PNG，原图不能超过 3 MB。")
    raw = base64.b64decode(value[len(prefix):], validate=True)
    with Image.open(BytesIO(raw)) as frame:
        if min(frame.size) < 240 or max(frame.size) > 8000:
            invalid("万相首帧的宽和高须各在 240–8000 像素之间。")
        if raw[24] == 16 or frame.width * frame.height * len(frame.getbands()) > 64 * 1024 * 1024:
            invalid("万相首帧仅支持 8 位 PNG，且解码体积不得超过 64 MiB。")
        if "A" in frame.getbands() or "transparency" in frame.info:
            if frame.convert("RGBA").getchannel("A").getextrema() != (255, 255):
                invalid("万相首帧需使用完全不透明的 PNG。")
        target = BytesIO()
        rgb = frame.convert("RGB")
        rgb.info.pop("transparency", None)
        rgb.save(target, format="PNG")
    encoded = base64.b64encode(target.getvalue()).decode("ascii")
    if len(encoded) > 4_000_000:
        invalid("转换后的万相首帧超过体积限制。")
    return prefix + encoded


def request_for(route, config, options, refs):
    model = config["model"]
    prompt = options.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or "\0" in prompt or len(prompt) > (1500 if route.startswith("wan-") else 2000 if route == "ark" else 4000):
        invalid("请填写符合当前模型长度限制的提示词。")
    images = [value for slot, value in refs if slot == "references"]
    frames = {slot: value for slot, value in refs if slot in ("first", "last")}
    single = next((value for slot, value in refs if slot == "single"), None)
    if PROVIDERS[route].kind == "video":
        duration = options.get("duration")
        ratio = options.get("ratio")
        resolution = options.get("resolution")
        if type(duration) is not int or not 4 <= duration <= 15:
            invalid("视频时长须为 4–15 秒。")
        if route.startswith("wan-"):
            if images or single or set(frames) != {"first"}:
                invalid("万相 Flash 需要一张首帧。")
            return {"model": model, "input": {"img_url": wan_frame(frames["first"]), "prompt": prompt},
                    "parameters": {"resolution": "720P", "duration": duration, "audio": False, "watermark": False}}
        if ratio not in ("16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive") or resolution not in ("480p", "720p"):
            invalid("请选择 Seedance 支持的比例和分辨率。")
        if sum(map(bool, (single, images, frames))) > 1 or ("last" in frames and "first" not in frames) or len(images) > 9:
            invalid("请选择单图引导、参考图序列或首尾帧中的一种；尾帧需要先连接首帧。")
        content = [{"type": "text", "text": prompt}]
        if single:
            content.append({"type": "image_url", "image_url": {"url": single}})
        content.extend({"type": "image_url", "image_url": {"url": frames[slot]}, "role": slot + "_frame"}
                       for slot in ("first", "last") if slot in frames)
        content.extend({"type": "image_url", "image_url": {"url": value}, "role": "reference_image"} for value in images)
        return {"model": model, "content": content, "duration": duration, "resolution": resolution, "ratio": ratio, "generate_audio": False}

    size = options.get("size")
    quality = options.get("quality")
    if route != "apipool" and (not isinstance(size, str) or not re.fullmatch(r"[1-9][0-9]{2,3}x[1-9][0-9]{2,3}", size)
                               or any(not 256 <= int(n) <= 4096 for n in size.split("x"))):
        invalid("请选择有效的图片尺寸。")
    if quality not in ("auto", "low", "medium", "high", "xhigh", "max"):
        invalid("请选择有效的图片质量。")
    if frames or single or len(images) > IMAGE_REFERENCE_COUNT:
        invalid(f"图片节点最多接受 {IMAGE_REFERENCE_COUNT} 张有序参考图。")
    if route == "images":
        if quality in ("auto", "xhigh", "max"):
            invalid("传统图片接口不支持所选质量。")
        if images:
            invalid("Images 生成端点仅支持文本；参考图请使用 Responses 或千问。")
        return {"model": model, "prompt": prompt, "size": size, "quality": quality, "n": 1, "response_format": "b64_json", "watermark": False}
    if route == "responses":
        if quality in ("auto", "xhigh", "max"):
            invalid("Responses 不支持所选质量。")
        content = [{"type": "input_text", "text": prompt}]
        content.extend({"type": "input_image", "image_url": value} for value in images)
        return {"model": model, "input": [{"role": "user", "content": content}],
                "tools": [{"type": "image_generation", "size": size, "quality": quality}]}
    if route == "qianwen":
        if not images:
            invalid("千问多模态需要至少一张参考图。")
        return {"model": model, "input": {"messages": [{"role": "user", "content": [
            *({"image": value} for value in images), {"text": prompt}]}]},
            "parameters": {"prompt_extend": True, "n": 1, "size": size.replace("x", "*")}}
    aspect = options.get("aspect")
    resolution = options.get("imageResolution")
    urls = options.get("referenceUrls", [])
    count = options.get("count", 1)
    if (type(count) is not int or not 1 <= count <= 4 or count != 1 and model != "gpt-image-2"
            or aspect not in ("1:1", "16:9") or resolution not in ("1k", "2k", "4k")
            or not isinstance(urls, list) or len(urls) > IMAGE_REFERENCE_COUNT
            or model == "gpt-image-2" and (urls or quality in ("xhigh", "max") or len(images) > 1)
            or model != "gpt-image-2" and images):
        invalid("当前 APIPool 模型、参数或参考链接组合不受支持。")
    try:
        for url in urls:
            https_url(url)
            if len(url) > 2048:
                raise ValueError("reference URL is too long")
    except ValueError:
        invalid("APIPool 参考图需要公开 HTTPS 图片链接。")
    body = {"model": model, "prompt": prompt, "size": aspect, "resolution": resolution, "quality": quality, "n": count}
    if images:
        prefix = "data:image/png;base64,"
        if not images[0].startswith(prefix):
            invalid("GPT Image 2 编辑需要一张 PNG。")
        body["_editPng"] = base64.b64decode(images[0][len(prefix):], validate=True)
    if urls:
        body["image_urls"] = urls
    return body


def task_path(route, task):
    return PROVIDERS[route].poll + quote(task, safe="")


def task_result(route, model, data, expected=None, count=1):
    if route.startswith("wan-"):
        output = data["output"]
        task = output["task_id"]
        status = output["task_status"]
        states = {"PENDING": "queued", "RUNNING": "running", "SUCCEEDED": "ready", "FAILED": "failed", "CANCELED": "failed"}
        resource = output.get("video_url")
    elif route == "ark":
        task = data.get("id", expected)
        status = data.get("status", "queued" if expected is None else None)
        states = {"queued": "queued", "running": "running", "succeeded": "ready", "failed": "failed"}
        resource = (data.get("content") or {}).get("video_url")
    else:
        task = data["id"]
        status = data["status"]
        if expected is None and status not in ("submitted", "submission_unknown"):
            raise ValueError("unconfirmed APIPool acceptance")
        if data["model"] != model or data["object"] != "image_generation.task":
            raise ValueError("wrong task type")
        states = {"submitted": "queued", "submission_unknown": "pending", "queued": "queued", "running": "running", "completed": "ready", "failed": "failed"}
        resource = None
        if status == "completed":
            if len(data["data"]) != count:
                raise ValueError("wrong result count")
            resource = [item["url"] for item in data["data"]]
    pattern = APIPOOL_TASK if route == "apipool" else TASK
    if not isinstance(task, str) or not pattern.fullmatch(task) or ".." in task or expected is not None and task != expected:
        raise ValueError("wrong task identity")
    reported_model = data.get("model")
    if reported_model is not None and reported_model != model:
        raise ValueError("wrong task model")
    state = states.get(status, "pending")
    if state == "ready" and not (isinstance(resource, str) or isinstance(resource, list) and all(isinstance(url, str) for url in resource)):
        raise ValueError("missing result")
    return task, state, resource if state == "ready" else None


def image_result(route, data):
    if route == "images":
        entry, = data["data"]
        return "base64", entry["b64_json"]
    if route == "responses":
        def calls(items):
            for item in items:
                if item.get("type") == "image_generation_call":
                    yield item
                elif isinstance(item.get("content"), list):
                    yield from calls(item["content"])
        entry, = calls(data["output"])
        result = entry["result"]
        if isinstance(result, (dict, list)):
            item, = result["data"] if isinstance(result, dict) else result
            result = item["b64_json"] if isinstance(item, dict) else item
        return "base64", result
    choice, = data["output"]["choices"]
    resource, = [part["image"] for part in choice["message"]["content"] if "image" in part]
    if isinstance(resource, str) and resource.startswith(("data:image/png;base64,", "data:image/jpeg;base64,")):
        return "base64", resource.split(",", 1)[1]
    return "url", resource
