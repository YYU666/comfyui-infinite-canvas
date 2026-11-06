from __future__ import annotations

import io
import http.client
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_store import ProjectStore, StoreError
from thumbnail_cache import ThumbnailCache


def png(color="red", size=(1600, 900)):
    stream = io.BytesIO()
    Image.new("RGB", size, color).save(stream, "PNG")
    return stream.getvalue()


class ComfyFixture(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self.server.heads += 1
        self.send_response(self.server.head_status)
        if self.server.etag:
            self.send_header("ETag", self.server.etag)
        self.send_header("Content-Length", str(len(self.server.image)))
        self.end_headers()

    def do_GET(self):
        self.server.gets += 1
        self.server.paths.append(self.path)
        self.send_response(200)
        if self.server.etag:
            self.send_header("ETag", self.server.etag)
        self.send_header("Content-Length", str(len(self.server.image)))
        self.end_headers()
        self.wfile.write(self.server.image)

    def log_message(self, *args):
        pass


class ThumbnailTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.store = ProjectStore(self.root / "projects", "thumbnail-test")
        self.project = self.store.create("synthetic")
        self.asset = self.root / "projects/synthetic/assets/source.png"
        self.asset.write_bytes(png())
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ComfyFixture)
        self.server.heads = self.server.gets = 0
        self.server.paths = []
        self.server.etag = '"first"'
        self.server.head_status = 200
        self.server.image = png()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.cache = ThumbnailCache(self.root / "cache", self.store, self.url)
        self.query = {"project": self.project["id"], "asset": "assets/source.png"}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()
        self.temp.cleanup()

    def test_project_reload_hit_keeps_original_and_source_mutation_invalidates(self):
        original = self.asset.read_bytes()
        first = self.cache.get(self.query)
        with Image.open(first) as image:
            self.assertEqual(image.size, (640, 360))
            self.assertEqual(image.format, "WEBP")
        self.assertEqual(self.asset.read_bytes(), original)
        fresh_process = ThumbnailCache(self.root / "cache", self.store, self.url)
        with mock.patch("thumbnail_cache.Image.open", side_effect=AssertionError("must reuse disk thumbnail")):
            self.assertEqual(fresh_process.get(self.query), first)
        self.asset.write_bytes(png("blue", (1200, 1800)))
        second = fresh_process.get(self.query)
        self.assertNotEqual(first, second)
        with Image.open(second) as image:
            self.assertEqual(image.size, (427, 640))
        self.assertFalse(list((self.root / "cache").glob("*.tmp")))

    def test_comfy_real_view_identity_reload_and_invalidation(self):
        query = {"filename": "synthetic.png", "subfolder": "nested/生成", "type": "input"}
        first = self.cache.get(query)
        fresh_process = ThumbnailCache(self.root / "cache", self.store, self.url)
        with mock.patch("thumbnail_cache.Image.open", side_effect=AssertionError("cache hit cannot decode")):
            self.assertEqual(fresh_process.get(query), first)
        self.assertEqual(self.server.gets, 1)
        self.assertEqual(self.server.heads, 2)
        self.assertIn("/view?filename=synthetic.png", self.server.paths[0])
        self.assertIn("type=input", self.server.paths[0])
        self.server.etag = '"changed"'
        self.server.image = png("green")
        self.assertNotEqual(fresh_process.get(query), first)
        self.assertEqual(self.server.gets, 2)

    def test_reject_paths_and_arbitrary_sources_before_network_or_decode(self):
        for query in [
            {**self.query, "asset": "assets/../secret.png"},
            {**self.query, "asset": "C:/secret.png"},
            {**self.query, "project": "../other"},
            {"filename": "../secret.png"}, {"filename": "C:\\secret.png"},
            {"filename": "image.png", "subfolder": "../elsewhere"},
            {"filename": "image.png", "type": "unknown"},
            {"url": "http://untrusted/secret.png"},
            {"filename": "image.png", "source": "http://untrusted/"},
        ]:
            with self.subTest(query=query), self.assertRaises(StoreError):
                self.cache.get(query)
        self.assertEqual(self.server.heads + self.server.gets, 0)

    def test_missing_validator_rechecks_content_and_redirect_is_not_followed(self):
        query = {"filename": "synthetic.png"}
        self.server.etag = None
        first = self.cache.get(query)
        self.assertEqual(self.cache.get(query), first)
        self.assertEqual(self.server.gets, 2, "missing validators must never permanently serve stale bytes")
        self.server.image = png("blue")
        self.assertNotEqual(self.cache.get(query), first)
        self.server.head_status = 302
        with self.assertRaises(StoreError):
            self.cache.get(query)
        self.assertEqual(self.server.gets, 3, "redirected view must not be fetched")

    def test_decode_slots_bound_concurrency(self):
        self.cache.slots.acquire()
        self.cache.slots.acquire()
        try:
            with self.assertRaises(StoreError) as error:
                self.cache.get(self.query)
            self.assertEqual(error.exception.status, 503)
        finally:
            self.cache.slots.release()
            self.cache.slots.release()

    def test_guarded_launcher_route_and_single_cache_policy(self):
        with mock.patch.dict(os.environ, {"H3_WORKBENCH_DATA_DIR": str(self.root / "data")}):
            from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
        server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        server.token = "synthetic-token"
        server.thumbnail_cache = self.cache
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection("127.0.0.1", server.server_port)
        path = "/api/thumbnails?project=" + self.project["id"] + "&asset=assets/source.png"
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            self.assertEqual(response.status, 401)
            response.read()
            connection.request("GET", path, headers={"X-H3-Token": server.token})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual([value for key, value in response.getheaders() if key.lower() == "cache-control"], ["no-cache"])
            etag = response.getheader("ETag")
            self.assertEqual(Image.open(io.BytesIO(response.read())).size, (640, 360))
            connection.request("GET", path, headers={"X-H3-Token": server.token, "If-None-Match": etag})
            response = connection.getresponse()
            self.assertEqual(response.status, 304)
            self.assertEqual(response.read(), b"")
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_resource_limits_and_corrupt_image(self):
        with mock.patch("thumbnail_cache.MAX_PIXELS", 100):
            with self.assertRaises(StoreError) as error:
                self.cache.get(self.query)
            self.assertEqual(error.exception.status, 413)
        with mock.patch("thumbnail_cache.MAX_BYTES", 100):
            with self.assertRaises(StoreError) as error:
                self.cache.get(self.query)
            self.assertEqual(error.exception.status, 413)
        self.asset.write_bytes(b"broken image")
        with self.assertRaises(StoreError) as error:
            self.cache.get(self.query)
        self.assertEqual(error.exception.status, 422)
        self.assertFalse(list((self.root / "cache").glob("*.webp")))

    def test_http_etag_and_duplicate_parameters(self):
        class Handler:
            path = "/api/thumbnails?project=" + self.project["id"] + "&asset=assets/source.png"
            headers = {}
            wfile = io.BytesIO()

            def send_response(self, status):
                self.status = status
                self.sent_headers = {}

            def send_header(self, key, value):
                self.sent_headers[key] = value

            def end_headers(self):
                pass

            def send_json(self, status, body):
                self.status = status
                self.body = body

        handler = Handler()
        self.cache.handle_get(handler)
        self.assertEqual(handler.status, 200)
        self.assertEqual(handler.sent_headers["Content-Type"], "image/webp")
        handler.headers = {"If-None-Match": handler.sent_headers["ETag"]}
        handler.wfile = io.BytesIO()
        self.cache.handle_get(handler)
        self.assertEqual(handler.status, 304)
        self.assertEqual(handler.wfile.getvalue(), b"")
        handler.path += "&asset=assets/another.png"
        self.cache.handle_get(handler)
        self.assertEqual(handler.status, 400)


if __name__ == "__main__":
    unittest.main()
