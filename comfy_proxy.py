from __future__ import annotations

import http.client
import select
import socket
import urllib.parse

COMFY_PREFIX = "/api/comfy"
DEFAULT_COMFY_URL = "http://127.0.0.1:8188"
REQUEST_HEADERS = {
    "accept", "accept-language", "content-type", "content-length", "range",
    "if-match", "if-none-match", "if-modified-since", "if-unmodified-since",
}
RESPONSE_HEADERS = {
    "access-control-allow-origin", "cache-control", "connection", "content-security-policy",
    "keep-alive", "proxy-authenticate", "set-cookie", "te", "trailer",
    "transfer-encoding", "upgrade",
}


def is_comfy_path(path):
    return path == COMFY_PREFIX or path.startswith(COMFY_PREFIX + "/")


def upstream_path(handler):
    parsed = urllib.parse.urlsplit(handler.path)
    path = parsed.path[len(COMFY_PREFIX):] or "/"
    return path + (f"?{parsed.query}" if parsed.query else "")


def upstream_url(handler):
    return getattr(handler.server, "comfy_url", DEFAULT_COMFY_URL)


def proxy_http(handler):
    parsed = urllib.parse.urlsplit(upstream_url(handler))
    if parsed.scheme != "http" or not parsed.hostname:
        handler.send_json(500, {"error": "ComfyUI 反代地址配置无效。"})
        return
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        handler.send_json(400, {"error": "请求长度无效。"})
        return
    if length < 0:
        handler.send_json(400, {"error": "请求长度无效。"})
        return
    body = handler.rfile.read(length) if length else None
    headers = {name: value for name, value in handler.headers.items() if name.lower() in REQUEST_HEADERS}
    headers["Host"] = parsed.netloc
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=90)
    response_started = False
    try:
        connection.request(handler.command, upstream_path(handler), body=body, headers=headers)
        response = connection.getresponse()
        handler.send_response(response.status)
        response_started = True
        for name, value in response.getheaders():
            if name.lower() not in RESPONSE_HEADERS:
                handler.send_header(name, value)
        handler.end_headers()
        while True:
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            handler.wfile.write(chunk)
    except (OSError, http.client.HTTPException) as exc:
        handler.close_connection = True
        if not response_started:
            try:
                handler.send_json(502, {"error": f"无法连接 ComfyUI：{exc}"})
            except (BrokenPipeError, ConnectionError):
                pass
    finally:
        connection.close()


def is_websocket_request(handler):
    return handler.headers.get("Upgrade", "").lower() == "websocket"


def _receive_headers(connection):
    data = bytearray()
    while b"\r\n\r\n" not in data:
        chunk = connection.recv(4096)
        if not chunk:
            raise OSError("ComfyUI 在 WebSocket 握手期间断开了连接。")
        data.extend(chunk)
        if len(data) > 65536:
            raise OSError("ComfyUI WebSocket 握手响应过大。")
    return bytes(data)


def proxy_websocket(handler):
    parsed = urllib.parse.urlsplit(upstream_url(handler))
    if parsed.scheme != "http" or not parsed.hostname:
        handler.send_json(500, {"error": "ComfyUI 反代地址配置无效。"})
        return
    upstream = None
    try:
        upstream = socket.create_connection((parsed.hostname, parsed.port or 80), timeout=10)
        key = handler.headers.get("Sec-WebSocket-Key", "")
        version = handler.headers.get("Sec-WebSocket-Version", "13")
        if not key:
            raise OSError("缺少 WebSocket 握手密钥。")
        lines = [
            f"GET {upstream_path(handler)} HTTP/1.1",
            f"Host: {parsed.netloc}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            f"Sec-WebSocket-Version: {version}",
        ]
        protocol = handler.headers.get("Sec-WebSocket-Protocol")
        if protocol:
            lines.append(f"Sec-WebSocket-Protocol: {protocol}")
        upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
        response = _receive_headers(upstream)
        status_line = response.split(b"\r\n", 1)[0]
        if not status_line.startswith(b"HTTP/1.1 101 "):
            raise OSError("ComfyUI 拒绝了 WebSocket 握手。")
        handler.connection.sendall(response)
        handler.close_connection = True
        upstream.settimeout(None)
        handler.connection.settimeout(None)
        sockets = [handler.connection, upstream]
        while True:
            readable, _, failed = select.select(sockets, [], sockets, 1.0)
            if failed:
                break
            for source in readable:
                try:
                    chunk = source.recv(64 * 1024)
                except (ConnectionResetError, ConnectionAbortedError):
                    return
                if not chunk:
                    return
                target = upstream if source is handler.connection else handler.connection
                target.sendall(chunk)
    except (OSError, ValueError) as exc:
        if not handler.close_connection:
            try:
                handler.send_json(502, {"error": f"无法连接 ComfyUI 进度服务：{exc}"})
            except (BrokenPipeError, ConnectionError):
                pass
    finally:
        handler.close_connection = True
        if upstream:
            upstream.close()
