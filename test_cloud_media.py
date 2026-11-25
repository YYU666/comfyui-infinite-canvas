import base64
import http.client
import io
import json
import os
import socket
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

from PIL import Image

from cloud_media import CloudMediaAPI, verify_media
from cloud_media_providers import HTTPS, PublicHTTPS, config_for, image_result, request_for, task_result, https_url
from project_store import ProjectStore, StoreError
from video_edit_ffmpeg import FFmpegError, Runner

FIXTURE_KEY = "synthetic-cloud-key"
PNG = io.BytesIO()
Image.new("RGB", (256, 240), (31, 158, 194)).save(PNG, format="PNG")
PNG = PNG.getvalue()
DATA = "data:image/png;base64," + base64.b64encode(PNG).decode()
IMAGE_GATEWAY = "https://image-gateway.example/v1"
DEFAULTS = {"prompt": "synthetic test", "size": "512x768", "quality": "medium", "duration": 5,
            "ratio": "adaptive", "resolution": "480p", "aspect": "1:1", "imageResolution": "1k", "count": 1}
RESPONSES_IMAGE = {"output": [{"type": "message", "content": [
    {"type": "image_generation_call", "result": base64.b64encode(PNG).decode()}]}]}


class LocalConnection(http.client.HTTPConnection):
    def __init__(self, hostname, port, timeout):
        super().__init__("127.0.0.1", port, timeout=timeout)
        self.provider_host = hostname

    def putrequest(self, method, url, **kwargs):
        super().putrequest(method, url, **{**kwargs, "skip_host": True})
        self.putheader("Host", self.provider_host)


class LocalTransport(HTTPS):
    def __init__(self, port):
        self.port = port

    def connection(self, value, timeout):
        url = https_url(value)
        return LocalConnection(url.hostname, self.port, timeout), url


def provider_fixture(directory):
    counts = {}
    lock = threading.Lock()

    class ProviderHandler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def result(self, body, status=200, mime="application/json", *, connection=None):
            if mime == "application/json":
                body = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(body)))
            if connection:
                self.send_header("Connection", connection)
                self.close_connection = connection == "close"
            self.end_headers()
            self.wfile.write(body)

        def trace(self, **data):
            event = {"method": self.command, "path": self.path, "host": self.headers.get("Host"),
                     "bearer": self.headers.get("Authorization") == "Bearer " + FIXTURE_KEY,
                     "authorizationPresent": bool(self.headers.get("Authorization")), **data}
            with lock, (directory / "provider.jsonl").open("a", encoding="utf-8") as target:
                target.write(json.dumps(event) + "\n")

        def do_POST(self):
            content = self.rfile.read(int(self.headers["Content-Length"]))
            kind = self.headers["Content-Type"]
            if kind.startswith("multipart/form-data;"):
                self.trace(multipart=b'name="image"; filename="source.png"' in content and PNG in content)
                self.result({"id": "imgtask_fixture", "object": "image_generation.task",
                             "model": "gpt-image-2", "status": "submitted"}, 202)
                return
            data = json.loads(content)
            self.trace(data=data, asyncHeader=self.headers.get("X-DashScope-Async"))
            prompt = data.get("prompt")
            if prompt == "disconnect after receiving":
                self.connection.shutdown(socket.SHUT_RDWR)
                return
            if prompt == "authorization rejected" or self.headers.get("Authorization") != "Bearer " + FIXTURE_KEY:
                self.result({"error": {"message": "provider private diagnostic"}}, 401)
                return
            if self.path == "/v1/responses":
                self.protocol_version = "HTTP/1.1"
                self.result(RESPONSES_IMAGE, connection="keep-alive")
            elif self.path == "/v1/images/generations":
                if self.headers["Host"] == "app.apipool.dev":
                    self.result({"id": "imgtask_fixture", "object": "image_generation.task",
                                 "model": data["model"], "status": "submitted"}, 202)
                else:
                    self.protocol_version = "HTTP/1.1"
                    self.result({"data": [{"b64_json": base64.b64encode(PNG).decode()}]}, connection="close")
            elif self.path.endswith("/multimodal-generation/generation"):
                self.result({"output": {"choices": [{"message": {"content": [
                    {"image": "https://fixture.example/image.png?signature=synthetic"}]}}]}})
            elif self.path == "/api/v3/contents/generations/tasks":
                self.result({"id": "ark-fixture"})
            elif self.path.endswith("/video-generation/video-synthesis"):
                self.result({"output": {"task_id": "wan-fixture", "task_status": "PENDING"}})
            else:
                self.result({}, 404)

        def do_GET(self):
            self.trace()
            path = urlsplit(self.path).path
            if path.startswith("/media/") or path == "/image.png":
                if self.headers.get("Authorization"):
                    self.result({}, 403)
                elif path.endswith(".png"):
                    self.result(PNG, mime="image/png")
                elif (directory / "fixture.mp4").is_file():
                    self.result((directory / "fixture.mp4").read_bytes(), mime="video/mp4")
                else:
                    self.result({}, 503)
                return
            with lock:
                count = counts.get(path, 0)
                counts[path] = count + 1
            if path == "/api/v3/contents/generations/tasks/ark-fixture":
                state = ("queued", "running", "succeeded")[min(count, 2)]
                self.result({"id": "ark-fixture", "status": state,
                             "content": {"video_url": "https://fixture.example/media/video.mp4?signature=synthetic"}})
            elif path == "/api/v1/tasks/wan-fixture":
                self.result({"output": {"task_id": "wan-fixture", "task_status": "SUCCEEDED",
                                        "video_url": "https://fixture.example/media/video.mp4?signature=synthetic"}})
            elif path == "/v1/tasks/imgtask_fixture":
                self.result({"id": "imgtask_fixture", "object": "image_generation.task", "model": "gpt-image-2",
                             "status": "completed", "data": [{"url": "https://fixture.example/media/one.png"},
                                                             {"url": "https://fixture.example/media/two.png"}]})
            else:
                self.result({}, 404)

    server = ThreadingHTTPServer(("127.0.0.1", 0), ProviderHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


class CloudMediaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = provider_fixture(self.root)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.transport = LocalTransport(self.server.server_port)
        self.store = ProjectStore(self.root / "projects")
        self.addCleanup(self.store.close)
        self.api = CloudMediaAPI(self.store, self.root, self.transport)

    def events(self):
        path = self.root / "provider.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.is_file() else []

    def prepare(self, route, prompt=DEFAULTS["prompt"], *, refs=(), ref_bytes=PNG, **options):
        profile = self.profile(route)
        attempt = os.urandom(16).hex()
        doc = self.store.create("Cloud " + attempt)
        project = doc["id"]
        self.store.open(project)
        result = self.store.put_asset(project, "ref.png", io.BytesIO(ref_bytes), "image/png")
        doc = self.store.get(project)
        doc["canvas"] = {"viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [
            {"id": "generation", "type": "cloudMedia", "position": {"x": 100, "y": 0},
             "data": {**DEFAULTS, **options, "prompt": prompt, "provider": route, "cloudAttempt": attempt}},
            {"id": "reference", "type": "media", "position": {"x": 0, "y": 0},
             "data": {"kind": "image", "assetPath": result["asset"]["path"]}}],
            "edges": [{"id": f"edge-{i}", "source": "reference", "target": "generation",
                       "sourceHandle": "ref", "targetHandle": slot} for i, slot in enumerate(refs)]}
        self.store.save(project, doc, doc["revision"])
        payload = {"nodeId": "generation", "configuration": profile}
        path = self.api.job_file(self.store._project_path(project), project, attempt)
        return project, attempt, payload, path

    def profile(self, route, key=FIXTURE_KEY):
        defaults = {"images": "fixture-image", "responses": "fixture-orchestration",
                    "qianwen": "qwen-image-3.0-pro", "apipool": "gpt-image-2", "ark": "doubao-seedance-2-0-mini-260615",
                    "wan-beijing": "wan2.6-i2v-flash", "wan-singapore": "wan2.6-i2v-flash"}
        return next(p["configuration"] for p in self.api.configure({"provider": route, "model": defaults[route], "key": key, **({"base": IMAGE_GATEWAY} if route == "images" else {})})
                    ["providers"] if p["id"] == route)

    def test_sync_routes_and_ordered_references(self):
        for route, slots in (("images", ()), ("responses", ("references",)), ("qianwen", ("references",))):
            with self.subTest(route=route):
                project, attempt, payload, path = self.prepare(route, refs=slots)
                job = self.api.submit(project, attempt, payload)
                self.assertEqual(job["state"], "done")
                self.assertEqual(path.with_suffix(".0.media").read_bytes(), PNG)
                self.assertNotIn(FIXTURE_KEY, path.read_text())
                self.assertNotIn("signature=", path.read_text())
        posts = [event for event in self.events() if event["method"] == "POST"]
        self.assertEqual(posts[0]["data"]["size"], "512x768")
        self.assertEqual(posts[1]["data"]["input"][0]["content"][1], {"type": "input_image", "image_url": DATA})
        self.assertEqual(posts[2]["data"]["input"]["messages"][0]["content"][0], {"image": DATA})
        download = self.events()[-1]
        self.assertEqual(download["path"], "/image.png?signature=synthetic")
        self.assertFalse(download["authorizationPresent"])

    def test_multipart_multiple_and_wrong_credential_cold_query(self):
        project, attempt, payload, path = self.prepare("apipool", refs=("references",), count=2)
        self.assertEqual(self.api.submit(project, attempt, payload)["taskId"], "imgtask_fixture")
        self.assertEqual(self.api.submit(project, attempt, payload)["state"], "queued")
        self.api = CloudMediaAPI(self.store, self.root, self.transport)
        self.profile("apipool", "another-synthetic-key")
        with self.assertRaisesRegex(StoreError, "重新配置"):
            self.api.refresh(path, self.api.read_job(path))
        self.profile("apipool")
        self.assertEqual(len(self.api.refresh(path, self.api.read_job(path))["outputs"]), 2)
        self.assertEqual(path.with_suffix(".1.media").read_bytes(), PNG)
        self.assertEqual([event["method"] for event in self.events()], ["POST", "GET", "GET", "GET"])
        self.assertEqual(self.events()[0]["path"], "/v1/images/edits")
        self.assertTrue(self.events()[0]["multipart"])
        self.assertFalse(self.events()[-1]["authorizationPresent"])

    def test_pending_payment_is_never_retried_and_rejection_is_distinct(self):
        project, attempt, payload, path = self.prepare("images", "disconnect after receiving")
        self.assertEqual(self.api.submit(project, attempt, payload)["state"], "submission_unknown")
        self.api = CloudMediaAPI(self.store, self.root, self.transport)
        self.assertEqual(self.api.submit(project, attempt, payload)["state"], "submission_unknown")
        self.assertEqual(self.api.refresh(path, self.api.read_job(path))["state"], "submission_unknown")
        another = self.store.create("another project")
        self.assertFalse(self.api.job_file(self.store._project_path(another["id"]), another["id"], attempt).is_file())
        self.store.release(project)
        with self.assertRaises(StoreError):
            self.api.submit(project, attempt, payload)
        reject_project, reject_attempt, reject_payload, reject_path = self.prepare("images", "authorization rejected")
        result = self.api.submit(reject_project, reject_attempt, reject_payload)
        self.assertEqual((result["state"], result["rejection"]), ("rejected", "authentication"))
        self.assertNotIn("private diagnostic", reject_path.read_text())
        self.assertEqual([event["method"] for event in self.events()], ["POST", "POST"])

    def test_seedance_and_wanxiang_wire_contracts(self):
        profile = config_for("ark", {"model": "doubao-seedance-2-0-mini-260615"})
        refs = [("references", DATA)] * 9
        body = request_for("ark", profile, DEFAULTS, refs)
        self.assertEqual([entry["role"] for entry in body["content"][1:]], ["reference_image"] * 9)
        self.assertEqual(body["generate_audio"], False)
        with self.assertRaises(StoreError):
            request_for("ark", profile, DEFAULTS, [("last", DATA)])
        wan = config_for("wan-beijing", {"model": "wan2.6-i2v-flash"})
        for alpha in (255, 100):
            image = io.BytesIO()
            Image.new("RGBA", (256, 240), (31, 158, 194, alpha)).save(image, format="PNG")
            ref = "data:image/png;base64," + base64.b64encode(image.getvalue()).decode()
            if alpha == 255:
                planned = request_for("wan-beijing", wan, DEFAULTS, [("first", ref)])
                with Image.open(io.BytesIO(base64.b64decode(planned["input"]["img_url"].split(",", 1)[1]))) as rgb:
                    self.assertEqual(rgb.mode, "RGB")
                    self.assertEqual(rgb.getpixel((0, 0)), (31, 158, 194))
            else:
                with self.assertRaisesRegex(StoreError, "完全不透明"):
                    request_for("wan-beijing", wan, DEFAULTS, [("first", ref)])
        opaque = io.BytesIO()
        Image.new("RGBA", (256, 240), (31, 158, 194, 255)).save(opaque, format="PNG")
        for route, host in (("wan-beijing", "dashscope.aliyuncs.com"), ("wan-singapore", "dashscope-intl.aliyuncs.com")):
            project, attempt, payload, path = self.prepare(route, refs=("first",), ref_bytes=opaque.getvalue())
            self.assertEqual(self.api.submit(project, attempt, payload)["state"], "queued")
            event = self.events()[-1]
            self.assertEqual((event["host"], event["asyncHeader"]), (host, "enable"))
            self.assertEqual(event["data"]["input"]["img_url"], DATA)
            self.assertEqual(event["data"]["parameters"], {"resolution": "720P", "duration": 5, "audio": False, "watermark": False})
            with self.assertRaisesRegex(StoreError, "未能确认"):
                self.api.refresh(path, self.api.read_job(path))
            self.assertEqual(self.events()[-2]["host"], host)
            self.assertEqual(self.events()[-2]["path"], "/api/v1/tasks/wan-fixture")

    def test_concurrent_submissions_only_send_one_post(self):
        project, attempt, payload, path = self.prepare("images")
        barrier = threading.Barrier(4)

        def submit_together():
            barrier.wait()
            return self.api.submit(project, attempt, payload)["state"]

        with ThreadPoolExecutor(4) as pool:
            states = list(pool.map(lambda _index: submit_together(), range(4)))
        self.assertIn("done", states)
        self.assertTrue(set(states) <= {"submitting", "done"})
        self.assertEqual(self.api.view(path, self.api.read_job(path))["state"], "done")
        self.assertEqual(len(self.events()), 1)

    def test_transport_and_result_validation(self):
        for value in ("http://api.example", "https://localhost.test/path", "https://127.0.0.1/path",
                      "https://api.example@somewhere.example/path", "https://api.example:443/path"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                https_url(value)
        with patch("cloud_media_providers.socket.getaddrinfo", return_value=[
                     (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 443))]), self.assertRaises(OSError):
            PublicHTTPS("api.example").connect()
        with self.assertRaises(ValueError):
            task_result("ark", "model", {"id": "other", "status": "running"}, "expected")
        with self.assertRaises(ValueError):
            image_result("responses", {"output": [{"type": "message", "content": [{"type": "output_text", "text": "http://example"}]}]})
        invalid = self.root / "no-video.mp4"
        invalid.write_bytes(b"\x00\x00\x00\x08ftyp\x00\x00\x00\x08moov\x00\x00\x00\x08mdat")
        with self.assertRaises((FFmpegError, ValueError)):
            verify_media(invalid, "video")


def serve_browser_fixture(directory):
    import video_workbench_launcher as launcher
    store = ProjectStore(directory / "projects")
    if not store.list():
        original = io.BytesIO()
        Image.new("RGB", (256, 240), (219, 156, 31)).save(original, format="PNG")
        for name in ("Cloud media fixture", "Independent project"):
            document = store.create(name)
            project = document["id"]
            asset = store.put_asset(project, "reference.png", io.BytesIO(original.getvalue()), "image/png")["asset"]
            document = store.get(project)
            document["canvas"] = {"edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [
                {"id": "reference", "type": "media", "position": {"x": 50, "y": 65},
                 "data": {"title": "合成参考图", "kind": "image", "assetPath": asset["path"], "name": "reference.png", "localFile": True}}]}
            store.save(project, document, document["revision"])
        store.close()
    media = directory / "fixture.mp4"
    if not media.exists():
        Runner().run(["-f", "lavfi", "-i", "color=c=lightskyblue:s=128x72:r=12:d=1",
                      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(media)], timeout=25)
    fake = provider_fixture(directory)
    launcher.CloudMediaAPI = lambda store, runtime: CloudMediaAPI(store, runtime, LocalTransport(fake.server_port))
    try:
        return launcher.main(["--port", "0", "--debug"])
    finally:
        fake.shutdown()
        fake.server_close()


if __name__ == "__main__":
    if sys.argv[1:2] == ["--browser-fixture"]:
        raise SystemExit(serve_browser_fixture(Path(sys.argv[2])))
    unittest.main()
