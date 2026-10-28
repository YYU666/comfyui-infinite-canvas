import base64
import hashlib
import http.client
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_api import ProjectAPI
from project_store import ProjectStore
from queue_api import QueueAPI
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
from workbench_queue import QueueManager


def read_exact(connection, length):
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            raise ConnectionError("socket closed")
        data.extend(chunk)
    return bytes(data)


def read_frame(connection):
    first, second = read_exact(connection, 2)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", read_exact(connection, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", read_exact(connection, 8))[0]
    mask = read_exact(connection, 4) if second & 0x80 else None
    payload = read_exact(connection, length)
    if mask:
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return first & 0x0F, payload


def send_frame(connection, payload, masked=False):
    first = 0x81
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    length = len(payload)
    mask_bit = 0x80 if masked else 0
    if length < 126:
        header = struct.pack("!BB", first, mask_bit | length)
    elif length < 65536:
        header = struct.pack("!BBH", first, mask_bit | 126, length)
    else:
        header = struct.pack("!BBQ", first, mask_bit | 127, length)
    if masked:
        mask = b"\x11\x22\x33\x44"
        payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        header += mask
    connection.sendall(header + payload)


class FakeComfyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_body(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.server.last_headers = dict(self.headers)
        if self.path.startswith("/ws"):
            accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            self.send_response(101)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            self.wfile.flush()
            send_frame(self.connection, "ready")
            opcode, payload = read_frame(self.connection)
            send_frame(self.connection, b"echo:" + payload)
            self.close_connection = True
            return
        if self.path.startswith("/view"):
            body = b"0123456789ab"
            range_header = self.headers.get("Range", "")
            if range_header == "bytes=2-5":
                self.send_body(206, body[2:6], "video/mp4", {"Content-Range": "bytes 2-5/12", "Accept-Ranges": "bytes"})
            else:
                self.send_body(200, body, "video/mp4", {"Accept-Ranges": "bytes"})
            return
        self.send_body(200, json.dumps({"path": self.path}).encode())

    def write_request(self):
        self.server.last_headers = dict(self.headers)
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        self.send_body(200, json.dumps({"path": self.path, "type": self.headers.get("Content-Type"), "body": body.decode("utf-8")}).encode())

    do_POST = write_request
    do_PUT = write_request
    do_DELETE = write_request


class ComfyProxyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeComfyHandler)
        self.upstream_thread = threading.Thread(target=self.upstream.serve_forever, daemon=True)
        self.upstream_thread.start()
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "proxy-test-token"
        self.server.comfy_url = f"http://127.0.0.1:{self.upstream.server_port}"
        self.server.queue_manager = QueueManager(root / "queue.json", poll_interval=0.01)
        self.server.queue_api = QueueAPI(self.server.queue_manager)
        self.server.project_store = ProjectStore(root / "projects", "proxy-test")
        self.server.project_api = ProjectAPI(self.server.project_store)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.upstream.shutdown()
        self.upstream.server_close()
        self.thread.join(timeout=3)
        self.upstream_thread.join(timeout=3)
        self.server.queue_manager.stop()
        self.server.project_store.close()
        self.temporary.cleanup()

    def request(self, method, path, body=None, content_type="application/json", token=True):
        headers = {"Content-Type": content_type}
        if token:
            headers["X-H3-Token"] = self.server.token
        request = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_auth_csp_and_sensitive_headers(self):
        status, _, _ = self.request("GET", "/api/comfy/system_stats", token=False)
        self.assertEqual(status, 401)
        status, headers, body = self.request("GET", "/api/comfy/system_stats?x=1")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/system_stats?x=1")
        csp = headers["Content-Security-Policy"]
        self.assertIn("default-src 'self'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertNotIn(":8188", csp)
        self.assertNotIn("Cookie", self.upstream.last_headers)
        self.assertNotIn("X-H3-Token", self.upstream.last_headers)

    def test_json_multipart_and_range_requests(self):
        payload = json.dumps({"prompt": {"1": {}}}).encode()
        status, _, body = self.request("POST", "/api/comfy/prompt", payload)
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual((result["path"], result["body"]), ("/prompt", payload.decode()))
        status, _, _ = self.request("POST", "/api/comfy/upload/image", b"raw", "text/plain")
        self.assertEqual(status, 415)
        multipart = b"--boundary\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.png\"\r\nContent-Type: image/png\r\n\r\nfake\r\n--boundary--\r\n"
        status, _, body = self.request("POST", "/api/comfy/upload/image", multipart, "multipart/form-data; boundary=boundary")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["path"], "/upload/image")
        status, headers, body = self.request("GET", "/api/comfy/view?filename=a.mp4", token=True)
        self.assertEqual((status, len(body)), (200, 12))
        request = urllib.request.Request(self.base + "/api/comfy/view?filename=a.mp4", headers={"X-H3-Token": self.server.token, "Range": "bytes=2-5"})
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 2-5/12")
            self.assertEqual(response.read(), b"2345")

    def test_websocket_handshake_and_bidirectional_frames(self):
        connection = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=5)
        try:
            key = base64.b64encode(os.urandom(16)).decode()
            request = (
                f"GET /api/comfy/ws?clientId=proxy-test HTTP/1.1\r\nHost: 127.0.0.1:{self.server.server_port}\r\n"
                f"Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
                f"X-H3-Token: {self.server.token}\r\n\r\n"
            )
            connection.sendall(request.encode())
            response = bytearray()
            while b"\r\n\r\n" not in response:
                response.extend(connection.recv(4096))
            self.assertTrue(response.startswith(b"HTTP/1.1 101 "), response.decode(errors="replace"))
            self.assertEqual(read_frame(connection), (1, b"ready"))
            send_frame(connection, "hello", masked=True)
            self.assertEqual(read_frame(connection), (1, b"echo:hello"))
            self.assertNotIn("X-H3-Token", self.upstream.last_headers)
        finally:
            connection.close()


if __name__ == "__main__":
    unittest.main()
