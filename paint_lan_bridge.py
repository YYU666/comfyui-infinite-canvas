"""On-demand LAN sketch companion. It never binds the main workbench port."""

from __future__ import annotations

import base64
import ipaddress
import json
import math
import os
import queue
import re
import secrets
import socket
import struct
import subprocess
import threading
import time
import urllib.parse
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VIRTUAL_HINTS = (
    "wsl", "hyper-v", "hyperv", "docker", "vmware", "vbox", "virtualbox", "bluetooth", "loopback",
    "tun", "tap", "wintun", "wireguard", "tailscale", "zerotier", "clash", "mihomo", "sing-box",
    "tap-windows", "vethernet", "virtual",
)
IDLE_TIMEOUT = 2 * 60 * 60
COOKIE = "refmuse_lan"
MAX_FAILURES = 5
MAX_BODY = 12 * 1024 * 1024
LAYER_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
EMBEDDED_COMPANION = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refmuse 平板画板</title></head><body><main id="companion">Refmuse LAN Sketch Companion</main></body></html>"""


class BridgeError(Exception):
    def __init__(self, message, status=400, code="BAD_LAN"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def filter_addresses(items):
    usable = []
    for item in items or []:
        name = str(item.get("name", ""))
        address = str(item.get("address", ""))
        if any(hint in name.lower() for hint in VIRTUAL_HINTS):
            continue
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            continue
        if ip.version != 4 or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
            continue
        if str(ip).startswith("169.254.") or str(ip).startswith("127."):
            continue
        usable.append({"name": name, "address": str(ip), "description": str(item.get("description", ""))})
    return sorted(usable, key=address_rank)


def address_rank(item):
    label = f"{item.get('name', '')} {item.get('description', '')}".lower()
    ip = ipaddress.ip_address(item["address"])
    wifi = any(token in label for token in ("wi-fi", "wifi", "wlan", "wireless", "无线"))
    ethernet = any(token in label for token in ("ethernet", "以太网"))
    if ip in ipaddress.ip_network("192.168.0.0/16") and (wifi or ethernet):
        return (0, item["address"])
    if ip in ipaddress.ip_network("192.168.0.0/16"):
        return (1, item["address"])
    if ip in ipaddress.ip_network("172.16.0.0/12") and (wifi or ethernet):
        return (2, item["address"])
    if ip in ipaddress.ip_network("10.0.0.0/8") and (wifi or ethernet):
        return (3, item["address"])
    if ip in ipaddress.ip_network("172.16.0.0/12"):
        return (4, item["address"])
    if ip in ipaddress.ip_network("10.0.0.0/8"):
        return (5, item["address"])
    return (6, item["address"])


def parse_ipconfig(text):
    items = []
    current = None
    for raw in str(text or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if line[:1] not in {" ", "\t"} and ":" in line:
            current = {"name": line.split(":", 1)[0].strip(), "description": ""}
            continue
        if current is None or ":" not in line:
            continue
        key, value = line.split(":", 1)
        value = value.strip()
        if "Description" in key or "描述" in key:
            current["description"] = value
        if "IPv4" in key or key.strip() in {"IP Address", "IP 地址", "IPv4 地址"} or "IPv4 地址" in key:
            address = value.split("(")[0].strip()
            label = f"{current['name']} {current['description']}".strip()
            items.append({"name": label, "description": current["description"], "address": address})
    return items


def decode_ipconfig(data):
    if isinstance(data, str):
        return data
    for encoding in ("utf-8", "cp936"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def windows_adapters():
    if os.name != "nt":
        return []
    try:
        import ctypes
        from ctypes import wintypes
        iphlpapi = ctypes.WinDLL("iphlpapi")
        size = wintypes.ULONG(16 * 1024)
        buffer = ctypes.create_string_buffer(size.value)
        flags = 0x0002 | 0x0004 | 0x0008
        for _ in range(3):
            ret = iphlpapi.GetAdaptersAddresses(2, flags, None, ctypes.cast(buffer, ctypes.c_void_p), ctypes.byref(size))
            if ret == 0:
                break
            if ret != 111:
                return []
            buffer = ctypes.create_string_buffer(size.value)
        else:
            return []
        pointer = ctypes.sizeof(ctypes.c_void_p)
        if pointer == 8:
            next_off, uni_off, desc_off, name_off = 8, 24, 64, 72
        else:
            next_off, uni_off, desc_off, name_off = 8, 16, 36, 40
        items = []
        current = ctypes.addressof(buffer)
        for _ in range(64):
            if not current:
                break
            nxt = int.from_bytes(ctypes.string_at(current + next_off, pointer), "little")
            uni = int.from_bytes(ctypes.string_at(current + uni_off, pointer), "little")
            desc_ptr = int.from_bytes(ctypes.string_at(current + desc_off, pointer), "little")
            name_ptr = int.from_bytes(ctypes.string_at(current + name_off, pointer), "little")
            description = ctypes.wstring_at(desc_ptr) if desc_ptr else ""
            friendly = ctypes.wstring_at(name_ptr) if name_ptr else ""
            node = uni
            for _hop in range(32):
                if not node:
                    break
                if pointer == 8:
                    node_next = int.from_bytes(ctypes.string_at(node + 8, 8), "little")
                    sockaddr = int.from_bytes(ctypes.string_at(node + 16, 8), "little")
                else:
                    node_next = int.from_bytes(ctypes.string_at(node + 8, 4), "little")
                    sockaddr = int.from_bytes(ctypes.string_at(node + 12, 4), "little")
                if sockaddr and int.from_bytes(ctypes.string_at(sockaddr, 2), "little") == 2:
                    ip = ".".join(str(byte) for byte in ctypes.string_at(sockaddr + 4, 4))
                    items.append({"name": f"{friendly} {description}".strip(), "description": description, "address": ip})
                node = node_next
            current = nxt
        return items
    except Exception:
        return []


def local_interfaces():
    if os.name == "nt":
        found = windows_adapters()
        if not found:
            try:
                completed = subprocess.run(["ipconfig", "/all"], capture_output=True, timeout=4)
                found = parse_ipconfig(decode_ipconfig(completed.stdout or b""))
            except Exception:
                found = []
        if found:
            return found
    found = []
    route = Path("/proc/net/route")
    names = []
    if route.is_file():
        for line in route.read_text(encoding="utf-8", errors="replace").splitlines()[1:]:
            parts = line.split()
            if parts and parts[0] not in names:
                names.append(parts[0])
    try:
        import fcntl
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            for name in names:
                try:
                    packed = struct.pack("256s", name.encode("utf-8")[:15])
                    result = fcntl.ioctl(sock.fileno(), 0x8915, packed)
                    found.append({"name": name, "address": socket.inet_ntoa(result[20:24])})
                except OSError:
                    continue
        finally:
            sock.close()
    except Exception:
        found = []
    if found:
        return found
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        infos = []
    return [{"name": socket.gethostname(), "address": item[4][0]} for item in infos]


def _finite(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number):
        return None
    return number


def _png_bytes(value):
    if value in (None, ""):
        return b""
    if not isinstance(value, str):
        raise BridgeError("图层图案不是有效的 PNG。")
    try:
        data = base64.b64decode(value, validate=True)
    except Exception as exc:
        raise BridgeError("图层图案不是有效的 PNG。") from exc
    if len(data) > 8 * 1024 * 1024 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise BridgeError("图层图案不是有效的 PNG。")
    return data


class LanBridge:
    def __init__(self, static_root=None, interfaces=None):
        self.static_root = Path(static_root) if static_root else None
        self.interface_source = interfaces
        self.lock = threading.RLock()
        self.httpd = None
        self.thread = None
        self.port = None
        self.code = None
        self.token = None
        self.failures = 0
        self.session = None
        self.strokes = []
        self.commands = []
        self.events = []
        self.revision = 0
        self.subscribers = []
        self.idle_timeout = IDLE_TIMEOUT
        self._now = time.monotonic
        self.last_activity = self._now()

    def touch(self):
        self.last_activity = self._now()

    def expired(self):
        return self.running and (self._now() - self.last_activity) > self.idle_timeout

    def expire_if_idle(self):
        if self.expired():
            self.stop()
            return True
        return False

    def publish(self, event):
        if not isinstance(event, dict):
            raise BridgeError("同步事件无效。")
        if self.expire_if_idle() or not self.running:
            raise BridgeError("局域网画板尚未开启。", 409, "LAN_STOPPED")
        with self.lock:
            self.touch()
            self.revision += 1
            payload = {
                "type": str(event.get("type") or "update")[:40],
                "clientId": str(event.get("clientId") or "")[:40],
                "layerId": str(event.get("layerId") or "")[:64],
                "revision": self.revision,
            }
            for key in ("tool", "brushId", "color", "opacity", "visible"):
                if key in event:
                    payload[key] = event[key]
            if isinstance(event.get("points"), list):
                payload["points"] = event["points"][:5000]
            if isinstance(event.get("params"), dict):
                payload["params"] = event["params"]
            self.events.append(payload)
            self.events = self.events[-200:]
            subscribers = list(self.subscribers)
        for subscriber in subscribers:
            subscriber.append(payload)
        return payload

    def addresses(self):
        source = self.interface_source() if self.interface_source else local_interfaces()
        return filter_addresses(source)

    @property
    def running(self):
        return self.httpd is not None

    def status(self):
        self.expire_if_idle()
        with self.lock:
            return {
                "running": self.running,
                "port": self.port,
                "code": self.code if self.running else None,
                "hosts": self.addresses(),
                "nodeId": (self.session or {}).get("nodeId"),
                "paired": bool(self.token),
            }

    def start(self, session, host="0.0.0.0", port=0):
        self._validate_session(session)
        with self.lock:
            self.session = session
            self.code = f"{secrets.randbelow(1000000):06d}"
            self.token = None
            self.failures = 0
            self.strokes = []
            self.commands = []
            self.events = []
            self.revision = 0
            self.touch()
            if self.httpd is None:
                handler = lambda *args, **kwargs: CompanionHandler(self, *args, **kwargs)
                self.httpd = ThreadingHTTPServer((host, int(port)), handler)
                self.httpd.bridge = self
                self.port = self.httpd.server_address[1]
                self.thread = threading.Thread(target=self.httpd.serve_forever, name="paint-lan", daemon=True)
                self.thread.start()
        return self.status()

    def update_session(self, session):
        self._validate_session(session)
        with self.lock:
            if not self.running:
                raise BridgeError("局域网画板尚未开启。", 409, "LAN_STOPPED")
            self.session = session
        return self.status()

    def stop(self):
        with self.lock:
            httpd = self.httpd
            self.httpd = None
            self.code = None
            self.token = None
            self.failures = 0
            self.session = None
            self.strokes = []
            self.commands = []
            self.events = []
            self.revision = 0
            subscribers = list(self.subscribers)
            self.subscribers = []
            port = self.port
            self.port = None
        if httpd is not None:
            httpd.shutdown()
            httpd.server_close()
        for subscriber in subscribers:
            subscriber.append(None)
        return {"running": False, "port": port}

    def poll(self):
        if self.expire_if_idle():
            return {"running": False, "strokes": [], "commands": []}
        with self.lock:
            self.touch()
            strokes = list(self.strokes)
            commands = list(self.commands)
            self.strokes = []
            self.commands = []
            running = self.running
        return {"running": running, "strokes": strokes, "commands": commands}

    def handle_control(self, handler, method, path):
        if not path.startswith("/api/paint/lan/"):
            return False
        try:
            if path == "/api/paint/lan/status" and method == "GET":
                handler.send_json(200, self.status())
                return True
            if path == "/api/paint/lan/poll" and method == "GET":
                handler.send_json(200, self.poll())
                return True
            if path == "/api/paint/lan/start" and method == "POST":
                payload = _json_body(handler)
                host = payload.get("bindHost") or "0.0.0.0"
                if host not in {"0.0.0.0", "127.0.0.1"}:
                    raise BridgeError("伴侣服务只绑定局域网或本机回环。")
                handler.send_json(200, self.start(payload, host=host, port=int(payload.get("port") or 0)))
                return True
            if path == "/api/paint/lan/snapshot" and method == "POST":
                handler.send_json(200, self.update_session(_json_body(handler)))
                return True
            if path == "/api/paint/lan/stop" and method == "POST":
                handler.send_json(200, self.stop())
                return True
            if path == "/api/paint/lan/publish" and method == "POST":
                handler.send_json(200, self.publish(_json_body(handler)))
                return True
            handler.send_json(404, {"code": "NOT_FOUND", "message": "接口不存在。"})
            return True
        except BridgeError as exc:
            handler.send_json(exc.status, {"code": exc.code, "message": exc.message})
            return True
        except (TypeError, ValueError):
            handler.send_json(400, {"code": "BAD_LAN", "message": "局域网画板参数无效。"})
            return True

    def _validate_session(self, payload):
        if not isinstance(payload, dict) or not isinstance(payload.get("nodeId"), str) or not payload["nodeId"]:
            raise BridgeError("缺少要授权的绘画节点。")
        paper = payload.get("paper") or {}
        width = int(paper.get("width") or 0)
        height = int(paper.get("height") or 0)
        if width < 64 or height < 64 or width > 4096 or height > 4096:
            raise BridgeError("画纸尺寸无效。")
        layers = payload.get("layers") or []
        if not isinstance(layers, list) or not layers or len(layers) > 12:
            raise BridgeError("图层数量无效。")
        stored = []
        for layer in layers:
            if not isinstance(layer, dict) or not LAYER_ID.fullmatch(str(layer.get("id") or "")):
                raise BridgeError("图层编号无效。")
            stored.append({
                "id": layer["id"], "name": str(layer.get("name") or "图层")[:40],
                "visible": bool(layer.get("visible", True)), "opacity": max(0, min(100, int(layer.get("opacity") or 100))),
                "blendMode": str(layer.get("blendMode") or "normal")[:20],
                "clippingMask": bool(layer.get("clippingMask")), "alphaLock": bool(layer.get("alphaLock")),
                "png": _png_bytes(layer.get("pngBase64")),
            })
        payload["layers"] = stored
        payload["basePng"] = _png_bytes(payload.get("basePngBase64"))
        overlay = payload.get("baseOverlay") if isinstance(payload.get("baseOverlay"), dict) else {}
        payload["baseOverlay"] = {
            "visible": bool(overlay.get("visible", True)),
            "opacity": max(0, min(100, int(overlay.get("opacity") or 100))),
            "position": "above" if overlay.get("position") == "above" else "below",
        }
        brushes = payload.get("brushes") if isinstance(payload.get("brushes"), list) else []
        payload["brushes"] = [item for item in brushes if isinstance(item, dict)][:40]
        return payload


def _json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length < 0 or length > MAX_BODY:
        raise BridgeError("请求过大。", 413, "TOO_LARGE")
    raw = handler.rfile.read(length) if length else b"{}"
    return json.loads(raw.decode("utf-8"))


class CompanionHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, bridge, *args, **kwargs):
        self.bridge = bridge
        super().__init__(*args, **kwargs)

    def log_message(self, format, *args):
        return

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def _route(self, method):
        path = urllib.parse.urlparse(self.path).path
        if path in {"/api/projects", "/api/comfy/prompt", "/api/native3d/jobs"} or path.startswith(("/api/projects", "/api/comfy/", "/api/native3d/", "/api/agent/")):
            self._send(404, {"code": "NOT_FOUND", "message": "伴侣服务不提供该接口。"})
            return
        if path in {"/companion", "/companion/"} and method == "GET":
            body, content_type = self.bridge._companion_body()
            self._raw(200, body, content_type)
            return
        static = self.bridge._static(path) if method == "GET" else None
        if static:
            self._raw(200, static[0], static[1])
            return
        if path == "/api/lan/pair" and method == "POST":
            self._pair()
            return
        if not path.startswith("/api/lan/"):
            self._send(404, {"code": "NOT_FOUND", "message": "伴侣服务不提供该接口。"})
            return
        if not self._authorized():
            self._send(401, {"code": "UNAUTHORIZED", "message": "平板会话无效或已断开。"})
            return
        if path == "/api/lan/session" and method == "GET":
            self._send(200, self._public_session())
            return
        if path == "/api/lan/base-image" and method == "GET":
            self._image((self.bridge.session or {}).get("basePng") or b"")
            return
        if path.startswith("/api/lan/layer/") and method == "GET":
            self._layer(path.rsplit("/", 1)[-1])
            return
        if path == "/api/lan/events" and method == "GET":
            self._events()
            return
        if path == "/api/lan/sync" and method == "GET":
            self._sync()
            return
        if path == "/api/lan/stroke" and method == "POST":
            self._stroke()
            return
        if path == "/api/lan/command" and method == "POST":
            self._command()
            return
        self._send(404, {"code": "NOT_FOUND", "message": "伴侣服务不提供该接口。"})

    def _authorized(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return False
        morsel = cookie.get(COOKIE)
        with self.bridge.lock:
            return bool(morsel and self.bridge.token and secrets.compare_digest(morsel.value, self.bridge.token))

    def _pair(self):
        try:
            payload = _json_body(self)
        except Exception:
            self._send(400, {"code": "BAD_LAN", "message": "配对参数无效。"})
            return
        code = str(payload.get("code") or "")
        with self.bridge.lock:
            if not self.bridge.running or not self.bridge.code:
                self._send(401, {"code": "UNAUTHORIZED", "message": "配对码已失效。"})
                return
            if self.bridge.failures >= MAX_FAILURES:
                self.bridge.code = None
                self._send(429, {"code": "PAIR_LOCKED", "message": "配对失败次数过多，请在电脑上重新生成。"})
                return
            if len(code) != len(self.bridge.code) or not secrets.compare_digest(code, self.bridge.code):
                self.bridge.failures += 1
                self._send(401, {"code": "BAD_CODE", "message": "配对码不正确。"})
                return
            self.bridge.token = secrets.token_hex(16)
            self.bridge.code = None
            token = self.bridge.token
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        body = json.dumps({"ok": True, "session": self._public_session()}, ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Set-Cookie", f"{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _public_session(self):
        session = self.bridge.session or {}
        return {
            "nodeId": session.get("nodeId"),
            "paper": session.get("paper"),
            "layers": [{
                "id": layer["id"], "name": layer["name"], "visible": layer["visible"], "opacity": layer["opacity"],
                "blendMode": layer.get("blendMode") or "normal", "clippingMask": bool(layer.get("clippingMask")),
                "alphaLock": bool(layer.get("alphaLock")),
            } for layer in session.get("layers") or []],
            "baseOverlay": session.get("baseOverlay") or {"visible": True, "opacity": 100, "position": "below"},
            "brushes": [{
                "id": item.get("id"), "name": item.get("name"), "kind": item.get("kind") or "",
                "params": item.get("params") if isinstance(item.get("params"), dict) else {},
                "stampPngBase64": item.get("stampPngBase64") if isinstance(item.get("stampPngBase64"), str) and len(item.get("stampPngBase64")) < 300000 else "",
            } for item in session.get("brushes") or [] if isinstance(item, dict)],
            "activeLayerId": session.get("activeLayerId") or (session.get("layers") or [{"id": ""}])[0]["id"],
        }

    def _layer(self, layer_id):
        if not LAYER_ID.fullmatch(layer_id):
            self._send(404, {"code": "NOT_FOUND", "message": "找不到图层。"})
            return
        for layer in (self.bridge.session or {}).get("layers") or []:
            if layer["id"] == layer_id:
                self._image(layer.get("png") or b"")
                return
        self._send(404, {"code": "NOT_FOUND", "message": "找不到图层。"})

    def _image(self, data):
        if not data:
            self._send(404, {"code": "NOT_FOUND", "message": "没有可同步的图像。"})
            return
        self._raw(200, data, "image/png")

    def _stroke(self):
        try:
            payload = _json_body(self)
        except Exception:
            self._send(400, {"code": "BAD_LAN", "message": "笔迹无效。"})
            return
        points = payload.get("points") if isinstance(payload.get("points"), list) else []
        if len(points) > 5000:
            self._send(413, {"code": "TOO_LARGE", "message": "单笔点数过多。"})
            return
        layer_id = str(payload.get("layerId") or "")
        if not any(layer["id"] == layer_id for layer in (self.bridge.session or {}).get("layers") or []):
            self._send(404, {"code": "NOT_FOUND", "message": "笔迹图层不存在。"})
            return
        cleaned = []
        for point in points:
            if not isinstance(point, dict):
                continue
            x = _finite(point.get("x"))
            y = _finite(point.get("y"))
            pressure = _finite(point.get("pressure", 1))
            if x is None or y is None or pressure is None:
                self._send(400, {"code": "BAD_LAN", "message": "笔迹坐标无效。"})
                return
            cleaned.append({"x": x, "y": y, "pressure": pressure})
        stroke = {
            "clientId": str(payload.get("clientId") or "")[:40],
            "layerId": layer_id,
            "tool": payload.get("tool") if payload.get("tool") in {"brush", "eraser", "bucket", "picker", "geometry"} else "brush",
            "brushId": str(payload.get("brushId") or "builtin-hard-round")[:64],
            "color": str(payload.get("color") or "#111111")[:32],
            "params": payload.get("params") if isinstance(payload.get("params"), dict) else {},
            "points": cleaned,
        }
        if self.bridge.expire_if_idle():
            self._send(409, {"code": "LAN_STOPPED", "message": "局域网画板已因空闲关闭。"})
            return
        with self.bridge.lock:
            self.bridge.touch()
            self.bridge.strokes.append(stroke)
        self._send(202, {"ok": True})

    def _command(self):
        try:
            payload = _json_body(self)
        except Exception:
            self._send(400, {"code": "BAD_LAN", "message": "图层指令无效。"})
            return
        kind = payload.get("type")
        if kind not in {"switchLayer", "toggleVisible", "opacity", "undo", "redo", "clearLayer"}:
            self._send(400, {"code": "BAD_LAN", "message": "不支持的图层指令。"})
            return
        command = {"type": kind, "layerId": str(payload.get("layerId") or ""), "opacity": payload.get("opacity"), "visible": payload.get("visible"), "clientId": str(payload.get("clientId") or "")[:40]}
        if self.bridge.expire_if_idle():
            self._send(409, {"code": "LAN_STOPPED", "message": "局域网画板已因空闲关闭。"})
            return
        with self.bridge.lock:
            self.bridge.touch()
            self.bridge.commands.append(command)
        self._send(202, {"ok": True})

    def _sync(self):
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        try:
            since = int((query.get("since") or ["0"])[0])
        except ValueError:
            since = 0
        with self.bridge.lock:
            self.bridge.touch()
            events = [item for item in self.bridge.events if item.get("revision", 0) > since]
            revision = self.bridge.revision
        self._send(200, {"revision": revision, "events": events, "session": self._public_session()})

    def _events(self):
        updates = []
        with self.bridge.lock:
            self.bridge.subscribers.append(updates)
            revision = self.bridge.revision
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.write(f"event: ready\ndata: {json.dumps({'revision': revision})}\n\n".encode("utf-8"))
            self.wfile.flush()
            while self.bridge.running:
                if updates:
                    item = updates.pop(0)
                    if item is None:
                        break
                    self.wfile.write(b"event: update\ndata: " + json.dumps(item, ensure_ascii=False).encode("utf-8") + b"\n\n")
                    self.wfile.flush()
                    continue
                time.sleep(0.2)
                if not updates:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            with self.bridge.lock:
                if updates in self.bridge.subscribers:
                    self.bridge.subscribers.remove(updates)

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._raw(status, body, "application/json; charset=utf-8")

    def _raw(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def _companion_text(static_root):
    path = Path(static_root) / "companion.html" if static_root else None
    if path and path.is_file() and not path.is_symlink():
        return path.read_text(encoding="utf-8")
    return EMBEDDED_COMPANION


def _content_type(path):
    if path.endswith(".js"):
        return "text/javascript; charset=utf-8"
    if path.endswith(".css"):
        return "text/css; charset=utf-8"
    if path.endswith(".svg"):
        return "image/svg+xml"
    return "application/octet-stream"


def _static_file(bridge, path):
    if not bridge.static_root:
        return None
    html = _companion_text(bridge.static_root)
    refs = set(re.findall(r'(?:src|href)="([^"]+)"', html))
    relative = path[1:] if path.startswith("/") else path
    if path not in refs and f"/{relative}" not in refs and relative not in refs:
        return None
    if ".." in Path(relative).parts or relative.startswith(("/", "\\")):
        return None
    root = bridge.static_root.resolve()
    file = (root / relative).resolve()
    if root not in file.parents or not file.is_file() or file.is_symlink():
        return None
    return file.read_bytes(), _content_type(file.name)


def _companion_body(bridge):
    return _companion_text(bridge.static_root).encode("utf-8"), "text/html; charset=utf-8"


LanBridge._companion_body = lambda self: _companion_body(self)
LanBridge._static = lambda self, path: _static_file(self, path)
