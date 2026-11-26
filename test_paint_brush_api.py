import base64
import json
import tempfile
import unittest
from pathlib import Path

from paint_brush_api import PaintBrushAPI


def png_b64():
    data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + b"IEND" + b"\x00" * 4
    return base64.b64encode(data).decode("ascii")


class Handler:
    def __init__(self, body=None):
        raw = json.dumps(body or {}).encode("utf-8")
        self.headers = {"Content-Length": str(len(raw))}
        self.rfile = __import__("io").BytesIO(raw)
        self.status = None
        self.payload = None
        self.body = None
        self.content_type = None

    def send_json(self, status, payload):
        self.status = status
        self.payload = payload

    def send_bytes(self, status, body, content_type):
        self.status = status
        self.body = body
        self.content_type = content_type


class PaintBrushApiTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.api = PaintBrushAPI(Path(self.temporary.name) / "paint-brushes")

    def tearDown(self):
        self.temporary.cleanup()

    def test_crud_round_trip(self):
        created = Handler({"name": "草图笔尖", "group": "导入", "pngBase64": png_b64(), "params": {"size": 900, "spacing": 0}})
        self.assertTrue(self.api.handle(created, "POST", "/api/paint/brushes"))
        self.assertEqual(created.status, 201)
        brush_id = created.payload["id"]
        self.assertEqual(created.payload["params"]["size"], 500)
        self.assertEqual(created.payload["params"]["spacing"], 1)
        listed = Handler()
        self.api.handle(listed, "GET", "/api/paint/brushes")
        self.assertEqual(listed.status, 200)
        self.assertEqual(sum(item["builtin"] for item in listed.payload["brushes"]), 8)
        self.assertIn(brush_id, [item["id"] for item in listed.payload["brushes"]])
        stamp = Handler()
        self.api.handle(stamp, "GET", f"/api/paint/brushes/{brush_id}/stamp")
        self.assertEqual(stamp.status, 200)
        self.assertTrue(stamp.body.startswith(b"\x89PNG"))
        patched = Handler({"name": "修改后的笔尖", "group": "角色"})
        self.api.handle(patched, "PATCH", f"/api/paint/brushes/{brush_id}")
        self.assertEqual(patched.payload["name"], "修改后的笔尖")
        self.assertEqual(patched.payload["group"], "角色")
        removed = Handler()
        self.api.handle(removed, "DELETE", f"/api/paint/brushes/{brush_id}")
        self.assertEqual(removed.payload["ok"], True)
        missing = Handler()
        self.api.handle(missing, "GET", f"/api/paint/brushes/{brush_id}/stamp")
        self.assertEqual(missing.status, 404)

    def test_path_escape_and_illegal_files_are_rejected(self):
        for path in ("/api/paint/brushes/..", "/api/paint/brushes/../secret", "/api/paint/brushes/..%2Fsecret", "/api/paint/brushes/foo%2Fbar"):
            handler = Handler()
            self.assertTrue(self.api.handle(handler, "GET", path))
            self.assertEqual(handler.status, 400)
            self.assertIn("路径穿越", handler.payload["message"])
        outside = Path(self.temporary.name) / "secret.txt"
        outside.write_text("secret", encoding="utf-8")
        self.assertTrue(outside.exists())
        builtin = Handler()
        self.api.handle(builtin, "DELETE", "/api/paint/brushes/builtin-hard-round")
        self.assertEqual(builtin.status, 403)
        illegal = Handler({"name": "坏文件", "pngBase64": base64.b64encode(b"not a png").decode("ascii")})
        self.api.handle(illegal, "POST", "/api/paint/brushes")
        self.assertEqual(illegal.status, 400)
        self.assertIn("PNG", illegal.payload["message"])
        self.assertEqual(list(Path(self.api.root).glob("br_*")), [])


if __name__ == "__main__":
    unittest.main()
