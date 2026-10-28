from __future__ import annotations

import io
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_workbench_launcher import WorkbenchHandler, WorkbenchServer


class FakeDoctor:
    def __init__(self):
        self.calls = []

    def run(self, browser=None, check_deepseek=False):
        self.calls.append((browser, check_deepseek))
        return {"status": "ok", "summary": "诊断通过。", "browser": browser, "checks": []}

    def create_log_bundle(self, report):
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("doctor.json", json.dumps(report))
        return output.getvalue()


class DoctorAPITests(unittest.TestCase):
    def setUp(self):
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.token = "doctor-test-token"
        self.server.doctor = FakeDoctor()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

    def request(self, path, payload, authenticated=True):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["X-H3-Token"] = self.server.token
        request = urllib.request.Request(self.base + path, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()

    def test_doctor_requires_auth_and_forwards_explicit_connectivity_option(self):
        status, _, _ = self.request("/api/doctor", {}, authenticated=False)
        self.assertEqual(status, 401)
        status, _, body = self.request("/api/doctor", {"browser": {"userAgent": "Browser/1"}, "checkDeepSeek": True})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["browser"]["userAgent"], "Browser/1")
        self.assertEqual(self.server.doctor.calls, [({"userAgent": "Browser/1"}, True)])

    def test_log_bundle_is_a_zip_and_invalid_payload_is_rejected(self):
        status, headers, body = self.request("/api/doctor/log-bundle", {"browser": {"userAgent": "Browser/2"}})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "application/zip")
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertEqual(archive.namelist(), ["doctor.json"])
        status, _, body = self.request("/api/doctor", {"browser": "invalid"})
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body)["code"], "BAD_REQUEST")


if __name__ == "__main__":
    unittest.main()
