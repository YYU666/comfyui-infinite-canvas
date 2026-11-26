import base64
import json
import socket
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from paint_lan_bridge import LanBridge, filter_addresses


PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 16).decode("ascii")


def session():
    return {
        "nodeId": "paint-1",
        "paper": {"width": 320, "height": 240, "background": "white"},
        "activeLayerId": "layer-1",
        "layers": [{"id": "layer-1", "name": "图层 1", "visible": True, "opacity": 100, "pngBase64": PNG}],
        "brushes": [{"id": "builtin-hard-round", "name": "硬圆勾线笔"}],
    }


def request(port, method, path, body=None, cookie=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.read(), response.headers.get("Set-Cookie")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read(), exc.headers.get("Set-Cookie")


class LanBridgeTest(unittest.TestCase):
    def test_virtual_addresses_are_removed(self):
        usable = filter_addresses([
            {"name": "Ethernet", "address": "127.0.0.1"},
            {"name": "Link", "address": "169.254.3.4"},
            {"name": "docker0", "address": "172.17.0.1"},
            {"name": "vEthernet (WSL)", "address": "10.0.0.8"},
            {"name": "VMware Network Adapter", "address": "192.168.88.1"},
            {"name": "Wi-Fi", "address": "192.168.1.25"},
        ])
        self.assertEqual(usable, [{"name": "Wi-Fi", "address": "192.168.1.25"}])

    def test_bridge_stays_down_until_started_and_rejects_foreign_routes(self):
        bridge = LanBridge()
        self.assertFalse(bridge.status()["running"])
        source = Path("workbench_lifecycle.py").read_text(encoding="utf-8")
        self.assertIn('("127.0.0.1", port)', source)
        try:
            started = bridge.start(session(), host="127.0.0.1", port=0)
            self.assertTrue(started["running"])
            self.assertRegex(started["code"], r"^\d{6}$")
            port = started["port"]
            self.assertNotIn(port, {8188, 8189, 8790, 8870})
            for path in ("/api/projects", "/api/comfy/prompt", "/api/native3d/jobs"):
                status, _body, _cookie = request(port, "GET", path)
                self.assertEqual(status, 404, path)
            status, _body, _cookie = request(port, "GET", "/api/lan/session")
            self.assertEqual(status, 401)
            status, body, _cookie = request(port, "POST", "/api/lan/pair", {"code": "000000"})
            self.assertEqual(status, 401)
            self.assertIn("配对码".encode(), body)
            for _ in range(4):
                request(port, "POST", "/api/lan/pair", {"code": "111111"})
            status, _body, _cookie = request(port, "POST", "/api/lan/pair", {"code": "222222"})
            self.assertEqual(status, 429)
        finally:
            bridge.stop()

    def test_pair_once_then_invalidate_after_stop(self):
        bridge = LanBridge()
        try:
            started = bridge.start(session(), host="127.0.0.1", port=0)
            port = started["port"]
            code = started["code"]
            status, body, cookie = request(port, "POST", "/api/lan/pair", {"code": code})
            self.assertEqual(status, 200)
            self.assertIn("HttpOnly", cookie)
            token = cookie.split(";", 1)[0]
            status, _body, _cookie = request(port, "POST", "/api/lan/pair", {"code": code})
            self.assertEqual(status, 401)
            status, payload, _cookie = request(port, "GET", "/api/lan/session", cookie=token)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(payload)["nodeId"], "paint-1")
            status, image, _cookie = request(port, "GET", "/api/lan/layer/layer-1", cookie=token)
            self.assertEqual(status, 200)
            self.assertTrue(image.startswith(b"\x89PNG"))
            status, _body, _cookie = request(port, "GET", "/api/lan/session", cookie="refmuse_lan=deadbeef")
            self.assertEqual(status, 401)
            status, _body, _cookie = request(port, "POST", "/api/lan/stroke", {
                "clientId": "tablet", "layerId": "layer-1", "tool": "brush", "color": "#224466",
                "points": [{"x": 4, "y": 5, "pressure": 0.5}],
            }, cookie=token)
            self.assertEqual(status, 202)
            polled = bridge.poll()
            self.assertEqual(polled["strokes"][0]["color"], "#224466")
            self.assertEqual(bridge.poll()["strokes"], [])
            old = token
            bridge.stop()
            with self.assertRaises(OSError):
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
            restarted = bridge.start(session(), host="127.0.0.1", port=0)
            status, _body, _cookie = request(restarted["port"], "GET", "/api/lan/session", cookie=old)
            self.assertEqual(status, 401)
            page, html, _cookie = request(restarted["port"], "GET", "/companion")
            self.assertEqual(page, 200)
            self.assertIn(b"companion", html.lower())
            missing, _body, _cookie = request(restarted["port"], "GET", "/assets/not-companion.js")
            self.assertEqual(missing, 404)
        finally:
            bridge.stop()


if __name__ == "__main__":
    unittest.main()
