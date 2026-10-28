import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_lifecycle import atomic_write_json, utc_now
from workbench_queue import ComfyQueueAdapter, QueueManager


class FakeAdapter:
    def __init__(self):
        self.submitted = []
        self.cancelled = []
        self.done = False
        self.active = 0
        self.maximum = 0
        self.lock = threading.Lock()

    def submit(self, workflow, client_id):
        with self.lock:
            self.active += 1
            self.maximum = max(self.maximum, self.active)
        prompt_id = f"prompt-{len(self.submitted) + 1}"
        self.submitted.append({"id": prompt_id, "workflow": workflow, "clientId": client_id})
        return prompt_id

    def cancel(self, prompt_id):
        self.cancelled.append(prompt_id)

    def poll(self, prompt_id):
        if self.done:
            with self.lock:
                self.active = max(0, self.active - 1)
            return {"status": "done", "progress": 100, "outputs": {"16": {"videos": []}}, "history": {"status": {"completed": True}}}
        return {"status": "running", "progress": 40, "eta": 12}


def wait_for(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.02)
    raise AssertionError("queue condition timed out")


def payload(project="prj_test", node="node-1", priority=0):
    return {"projectId": project, "nodeId": node, "priority": priority, "clientId": "client-test", "workflow": {"1": {"class_type": "Test", "inputs": {"seed": 42, "node": node}}}}


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / "queue.json"
        self.adapter = FakeAdapter()
        self.manager = QueueManager(self.path, self.adapter, poll_interval=0.01)

    def tearDown(self):
        self.manager.stop()
        self.temporary.cleanup()

    def test_priority_pause_finish_and_persistence(self):
        self.manager.pause(True)
        self.manager.enqueue(payload(node="low", priority=1))
        self.manager.enqueue(payload(node="high", priority=9))
        self.adapter.done = True
        self.manager.start()
        time.sleep(0.08)
        self.assertEqual(self.adapter.submitted, [])
        self.manager.pause(False)
        wait_for(lambda: all(job["status"] == "done" for job in self.manager.snapshot()["jobs"]))
        self.assertEqual([item["workflow"]["1"]["inputs"]["node"] for item in self.adapter.submitted], ["high", "low"])
        self.assertEqual(self.adapter.submitted[0]["clientId"], "client-test")
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual([job["nodeId"] for job in stored["jobs"]], ["low", "high"])
        self.assertTrue(all(job["status"] == "done" for job in stored["jobs"]))
        self.assertNotIn("workflow", self.manager.snapshot()["jobs"][0])

    def test_running_recovery_does_not_submit_duplicate(self):
        job = {"id": "job_recover", "projectId": "prj_test", "nodeId": "n1", "status": "running", "progress": 55,
               "priority": 0, "createdAt": utc_now(), "updatedAt": utc_now(), "startedAt": utc_now(), "finishedAt": None,
               "comfyPromptId": "already-submitted", "error": None, "attempts": 1, "workflow": payload()["workflow"], "clientId": "client-test"}
        self.manager.stop()
        atomic_write_json(self.path, {"concurrency": 1, "paused": False, "jobs": [job]})
        self.adapter.done = True
        recovered = QueueManager(self.path, self.adapter, poll_interval=0.01)
        recovered.start()
        wait_for(lambda: recovered.get("job_recover")["status"] == "done")
        self.assertEqual(self.adapter.submitted, [])
        self.assertEqual(recovered.get("job_recover")["comfyPromptId"], "already-submitted")
        recovered.stop()

    def test_cancel_retry_same_recipe_and_clear(self):
        job = self.manager.enqueue(payload())
        listener = self.manager.subscribe()
        self.manager.start()
        wait_for(lambda: bool(self.adapter.submitted))
        cancelled = self.manager.cancel(job["id"])
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(self.adapter.cancelled, ["prompt-1"])
        retried = self.manager.retry(job["id"])
        self.assertEqual(retried["status"], "queued")
        self.adapter.done = True
        wait_for(lambda: self.manager.get(job["id"])["status"] == "done")
        self.assertEqual(len(self.adapter.submitted), 2)
        self.assertEqual(self.adapter.submitted[0]["workflow"], self.adapter.submitted[1]["workflow"])
        self.assertEqual(self.adapter.submitted[0]["workflow"]["1"]["inputs"]["seed"], 42)
        self.assertEqual(self.manager.clear_completed(), 1)
        self.assertEqual(self.manager.snapshot()["jobs"], [])
        self.assertFalse(listener.empty())
        self.manager.unsubscribe(listener)

    def test_concurrency_limit_and_validation(self):
        self.manager.set_concurrency(2)
        for index in range(3):
            self.manager.enqueue(payload(node=f"n{index}"))
        self.manager.start()
        wait_for(lambda: len(self.adapter.submitted) == 2)
        time.sleep(0.08)
        self.assertEqual(len(self.adapter.submitted), 2)
        self.assertEqual(self.adapter.maximum, 2)
        self.adapter.done = True
        wait_for(lambda: len(self.manager.snapshot()["jobs"]) == 3 and all(job["status"] == "done" for job in self.manager.snapshot()["jobs"]))
        with self.assertRaises(ValueError):
            self.manager.set_concurrency(3)

    def test_queued_priority_and_terminal_guards(self):
        first = self.manager.enqueue(payload(priority=1))
        second = self.manager.enqueue(payload(priority=2))
        changed = self.manager.set_priority(first["id"], 7)
        self.assertEqual(changed["priority"], 7)
        self.manager.cancel(second["id"])
        with self.assertRaises(ValueError):
            self.manager.set_priority(second["id"], 8)
        self.assertEqual(self.manager.retry(second["id"])["status"], "queued")
        with self.assertRaises(ValueError):
            self.manager.enqueue({"workflow": {}})

    def test_stalled_job_times_out_and_can_be_retried(self):
        self.manager.stop()
        self.manager = QueueManager(self.path, self.adapter, poll_interval=0.01, job_timeout=0.05)
        job = self.manager.enqueue(payload())
        self.manager.start()
        wait_for(lambda: self.manager.get(job["id"])["status"] == "error")
        failed = self.manager.get(job["id"])
        self.assertEqual(failed["error"]["code"], "COMFY_TIMEOUT")
        self.assertEqual(failed["stage"], "生成超时")
        self.assertEqual(self.adapter.cancelled, ["prompt-1"])
        self.adapter.done = True
        self.assertEqual(self.manager.retry(job["id"])["status"], "queued")
        wait_for(lambda: self.manager.get(job["id"])["status"] == "done")

    def test_comfy_cancel_only_interrupts_the_target_running_prompt(self):
        adapter = ComfyQueueAdapter()
        for running, pending, expected_interrupt in [
            (["target"], [], True),
            ([], ["target"], False),
            (["another"], [], False),
        ]:
            with self.subTest(running=running, pending=pending):
                calls = []

                def request(path, body=None, timeout=None):
                    calls.append((path, body))
                    if path == "/queue" and body is None:
                        return {
                            "queue_running": [[1, value] for value in running],
                            "queue_pending": [[2, value] for value in pending],
                        }
                    return {}

                adapter._request = request
                adapter.cancel("target")
                self.assertEqual(calls[0], ("/queue", None))
                self.assertEqual(calls[1], ("/queue", {"delete": ["target"]}))
                self.assertEqual(any(path == "/interrupt" for path, _ in calls), expected_interrupt)


if __name__ == "__main__":
    unittest.main()
