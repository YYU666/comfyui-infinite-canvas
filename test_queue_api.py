import http.client
import json
import sys
import threading
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from queue_api import QueueAPI
from test_workbench_queue import FakeAdapter, payload, wait_for
from video_workbench_launcher import WorkbenchHandler, WorkbenchServer
from workbench_queue import QueueManager


class QueueAPITests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.temporary = tempfile.TemporaryDirectory()
        self.adapter = FakeAdapter()
        self.manager = QueueManager(Path(self.temporary.name) / "queue.json", self.adapter, poll_interval=0.01)
        self.manager.start()
        self.server = WorkbenchServer(("127.0.0.1", 0), WorkbenchHandler)
        self.server.queue_api = QueueAPI(self.manager)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.manager.stop()
        self.temporary.cleanup()

    def request(self, path, body=None):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(self.origin + path, data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.load(response)

    def test_crud_events_and_browser_independent_progress(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request("GET", "/api/queue/events")
        events = connection.getresponse()
        self.assertEqual(events.status, 200)
        self.assertEqual(events.getheader("Content-Type"), "text/event-stream; charset=utf-8")
        self.assertEqual(events.readline().decode().strip(), "event: queue.snapshot")
        initial = json.loads(events.readline().decode().removeprefix("data: "))
        self.assertEqual(initial["jobs"], [])
        self.assertEqual(events.readline(), b"\n")

        status, job = self.request("/api/queue", payload(priority=3))
        self.assertEqual(status, 201)
        self.assertEqual(job["status"], "queued")
        wait_for(lambda: bool(self.adapter.submitted))
        self.assertEqual(events.readline().decode().strip(), "event: job.queued")
        queued_event = json.loads(events.readline().decode().removeprefix("data: "))
        self.assertEqual(queued_event["job"]["id"], job["id"])

        status, cancelled = self.request(f"/api/queue/{job['id']}/cancel", {})
        self.assertEqual(status, 200)
        self.assertEqual(cancelled["status"], "cancelled")
        _, retried = self.request(f"/api/queue/{job['id']}/retry", {})
        self.assertEqual(retried["status"], "queued")
        self.adapter.done = True
        wait_for(lambda: self.manager.get(job["id"])["status"] == "done")
        _, snapshot = self.request("/api/queue")
        self.assertEqual(snapshot["jobs"][0]["progress"], 100)
        self.assertEqual(snapshot["jobs"][0]["history"]["status"]["completed"], True)
        _, cleared = self.request("/api/queue", {"action": "clearCompleted"})
        self.assertEqual(cleared["jobs"], [])
        connection.close()

    def test_pause_concurrency_priority_and_bad_requests(self):
        _, paused = self.request("/api/queue", {"action": "pause"})
        self.assertTrue(paused["paused"])
        _, configured = self.request("/api/queue", {"action": "concurrency", "concurrency": 2})
        self.assertEqual(configured["concurrency"], 2)
        _, job = self.request("/api/queue", payload())
        _, prioritized = self.request(f"/api/queue/{job['id']}/priority", {"priority": 8})
        self.assertEqual(prioritized["priority"], 8)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/queue", {"action": "concurrency", "concurrency": 9})
        self.assertEqual(caught.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/api/queue/job_missing/cancel", {})
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
