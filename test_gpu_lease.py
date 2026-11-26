import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from gpu_lease import GpuGrant, GpuLeases, process_identity
from native3d_jobs import Native3DJobs
from local_worker import verified_result, worker_progress
from workbench_queue import QueueManager


DEVICE = "gpu-12345678-1234-1234-1234-123456789abc"
OTHER = "gpu-87654321-1234-1234-1234-123456789abc"
FIRST = {"kind": "native3d", "jobId": "n3d_fixture", "projectId": "prj_first", "nodeId": "node_a"}
SECOND = {"kind": "comfy", "jobId": "job_fixture", "projectId": "prj_second", "nodeId": "node_b", "attempt": 1}
WORKFLOW = {"1": {"class_type": "Synthetic", "inputs": {}}}


def until(predicate, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.02)
    raise AssertionError("lease condition did not settle")


class FixtureComfy:
    origin = "http://127.0.0.1:8765"

    def __init__(self):
        self.dispatched = threading.Event()
        self.cancelled = threading.Event()
        self.finished = False
        self.dispatch = None

    def gpu_target(self):
        return DEVICE, process_identity()

    def submit(self, workflow, client_id, *, gpu_dispatch):
        self.dispatch = gpu_dispatch
        self.dispatched.set()
        return "fixture-prompt"

    def poll(self, _prompt):
        return {"status": "done" if self.finished else "running", "outputs": {}}

    def cancel(self, _prompt):
        self.cancelled.set()  # upstream execution only stops when 'finished' changes

    def free(self):
        return True


class LeaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.leases = GpuLeases(self.root / "physical")

    def test_process_exit_hands_the_same_uuid_to_next_project(self):
        script = ("import json, sys, time; sys.path.insert(0, sys.argv[4]); from gpu_lease import GpuLeases; "
                  "grant,_=GpuLeases(sys.argv[1]).claim(sys.argv[2],json.loads(sys.argv[3])); "
                  "print(bool(grant),flush=True); time.sleep(20)")
        child = subprocess.Popen([sys.executable, "-u", "-c", script, str(self.leases.root), DEVICE,
                                  json.dumps(FIRST), str(Path(__file__).resolve().parent)],
                                 stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "True")
            self.assertEqual(self.leases.claim(DEVICE, SECOND), (None, FIRST))
            separate, _ = self.leases.claim(OTHER, SECOND)
            self.assertTrue(separate.release())
            child.kill()
            child.wait(timeout=5)
            handoff, _ = self.leases.claim(DEVICE, SECOND)
            self.assertTrue(handoff.release())
        finally:
            if child.poll() is None:
                child.kill()
            child.wait(timeout=5)
            child.stdout.close()

    def test_worker_adoption_keeps_lease_after_host_exit(self):
        host = """
import json, os, subprocess, sys, time
sys.path.insert(0, sys.argv[4])
from gpu_lease import GpuLeases
grant, _ = GpuLeases(sys.argv[1]).claim(sys.argv[2], json.loads(sys.argv[3]))
worker = subprocess.Popen([sys.executable, '-u', '-c',
    'import sys, time; sys.path.insert(0, sys.argv[1]); from gpu_lease import adopt_worker_lease; '
    'adopt_worker_lease(); time.sleep(30)', sys.argv[4]], env=grant.worker_environment(os.environ))
print(worker.pid, flush=True)
time.sleep(30)
"""
        parent = subprocess.Popen([sys.executable, "-u", "-c", host, str(self.leases.root), DEVICE,
                                   json.dumps(FIRST), str(Path(__file__).resolve().parent)],
                                 stdout=subprocess.PIPE, text=True)
        try:
            pid = int(parent.stdout.readline())
            until(lambda: any('"phase": "worker"' in file.read_text(encoding="utf-8")
                              for file in self.leases.root.glob("*.json")))
            parent.kill()
            parent.wait(timeout=5)
            self.assertEqual(self.leases.claim(DEVICE, SECOND), (None, FIRST))
            import psutil
            process = psutil.Process(pid)
            process.kill()
            process.wait(timeout=5)
            grant, _ = self.leases.claim(DEVICE, SECOND)
            self.assertTrue(grant.release())
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)
            parent.stdout.close()

    def test_cancelled_comfy_keeps_gpu_until_upstream_settles(self):
        held, _ = self.leases.claim(DEVICE, FIRST)
        adapter = FixtureComfy()
        queue = QueueManager(self.root / "queue.json", adapter, gpu_leases=self.leases, poll_interval=.02)
        queue.start()
        self.addCleanup(queue.stop)
        job = queue.enqueue({"projectId": "prj_second", "nodeId": "node_b", "workflow": WORKFLOW})
        waiting = until(lambda: (state if (state := queue.get(job["id"])).get("gpu", {}).get("state") == "waiting" else None))
        self.assertEqual(waiting["status"], "queued")
        self.assertEqual(waiting["gpu"]["owner"], FIRST)
        self.assertFalse(adapter.dispatched.is_set())
        with patch("gpu_lease._reconcile_comfy", side_effect=lambda _row: adapter.finished):
            self.assertTrue(held.release())
            self.assertTrue(adapter.dispatched.wait(5))
            until(lambda: queue.get(job["id"]).get("comfyPromptId") == "fixture-prompt")
            self.assertEqual(queue.cancel(job["id"])["status"], "cancelled")
            self.assertTrue(adapter.cancelled.is_set())
            until(lambda: queue.get(job["id"]).get("gpu", {}).get("state") == "reconciling")
            self.assertEqual(self.leases.claim(DEVICE, FIRST)[1]["jobId"], job["id"])
            adapter.finished = True
            until(lambda: queue.get(job["id"]).get("gpu", {}).get("state") == "released")
            next_grant, _ = self.leases.claim(DEVICE, FIRST)
            self.assertTrue(next_grant.release())

    def test_unknown_upstream_dispatch_cannot_be_replaced_without_evidence(self):
        grant, _ = self.leases.claim(DEVICE, SECOND)
        dispatch = grant.dispatch("http://127.0.0.1:8765", process_identity())
        grant.uncertain()
        with patch("gpu_lease.comfy_process", return_value=process_identity()), \
                patch("gpu_lease._comfy_request", return_value={"queue_pending": [], "queue_running": []}):
            self.assertEqual(self.leases.claim(DEVICE, FIRST), (None, SECOND))
        history = {"fixture": {"prompt": [0, "p", {}, {"refmuse_gpu_dispatch": dispatch}],
                               "status": {"completed": True}}}
        def request(_origin, path):
            return history if path.startswith("/history") else {"queue_pending": [], "queue_running": []}
        with patch("gpu_lease.comfy_process", return_value=process_identity()), \
                patch("gpu_lease._comfy_request", side_effect=request):
            recovered, _ = self.leases.claim(DEVICE, FIRST)
            self.assertTrue(recovered.release())

    def test_lost_ack_recovers_and_completes_original_job_without_replay(self):
        adapter = FixtureComfy()
        submissions = []
        def dropped(workflow, client_id, *, gpu_dispatch):
            submissions.append(gpu_dispatch)
            raise TimeoutError("connection closed after acceptance")
        adapter.submit = dropped
        adapter.find_gpu_dispatch = lambda dispatch: "original-prompt" if submissions == [dispatch] else None
        queue = QueueManager(self.root / "queue.json", adapter, gpu_leases=self.leases, poll_interval=.02)
        queue.start()
        self.addCleanup(queue.stop)
        with patch("gpu_lease._reconcile_comfy", side_effect=lambda _row: adapter.finished):
            job = queue.enqueue({"projectId": "prj_second", "nodeId": "node_b", "workflow": WORKFLOW})
            until(lambda: queue.get(job["id"]).get("comfyPromptId") == "original-prompt")
            self.assertEqual(queue.get(job["id"])["attempts"], 1)
            adapter.finished = True
            until(lambda: queue.get(job["id"]).get("gpu", {}).get("state") == "released")
        self.assertEqual(queue.get(job["id"])["status"], "done")
        self.assertEqual(len(submissions), 1)

    def test_native_scheduler_waits_for_comfy_then_launches_gpu_worker_and_allows_cpu(self):
        adapter = FixtureComfy()
        queue = QueueManager(self.root / "queue.json", adapter, gpu_leases=self.leases, poll_interval=.02)
        queue.start()
        self.addCleanup(queue.stop)
        worker = self.root / "fixture_worker.py"
        worker.write_text("""import json, sys, os
from pathlib import Path
sys.path.insert(0, os.environ['GPU_TEST_MODULE_DIR'])
from gpu_lease import adopt_worker_lease
adopt_worker_lease()
request = Path(sys.argv[sys.argv.index('--request')+1])
output = Path(sys.argv[sys.argv.index('--output')+1])
assert request.is_file()
print(json.dumps({'stage':'fixture', 'progress':0.5}), flush=True)
(output/'mesh.glb').write_bytes(b'test work')
(output/'result.json').write_text(json.dumps({'metadata':{},'quality':{},'warnings':[],
    'files':[{'name':'mesh.glb','role':'model','mime':'model/gltf-binary'}]}))
""", encoding="utf-8")
        with (patch.dict("os.environ", {"GPU_TEST_MODULE_DIR": str(Path(__file__).parent)}),
              patch("gpu_lease._reconcile_comfy", side_effect=lambda _row: adapter.finished)):
            running = queue.enqueue({"projectId": "prj_second", "nodeId": "node_b", "workflow": WORKFLOW})
            self.assertTrue(adapter.dispatched.wait(5))
            native = Native3DJobs(self.root / "native", None, engine_path=worker,
                                  gpu_leases=self.leases, gpu_device=lambda: DEVICE)
            self.addCleanup(native.close)
            def enqueue(job_id, operation):
                job = {"id": job_id, "projectId": "prj_first", "nodeId": operation, "opId": operation,
                       "progress": 0, "status": "queued", "stage": "queued", "operation": operation}
                directory = native.root / job_id
                directory.mkdir()
                (directory / "request.json").write_text("{}", encoding="utf-8")
                (directory / "runtime.json").write_text(json.dumps({"pythonExecutable": sys.executable,
                    "imageTo3D": {}}), encoding="utf-8")
                with native.lock:
                    native.jobs[job_id] = job
                native.wake.set()
            gpu_id, cpu_id = "n3d_" + "1" * 32, "n3d_" + "2" * 32
            enqueue(gpu_id, "image_to_3d")
            enqueue(cpu_id, "analyze")
            until(lambda: native.get(cpu_id)["status"] == "succeeded")
            waiting = native.get(gpu_id)
            self.assertEqual(waiting["gpu"]["state"], "waiting")
            self.assertEqual(waiting["gpu"]["owner"]["jobId"], running["id"])
            self.assertFalse((native.root / gpu_id / "worker.log").exists())
            real_release = GpuGrant.release
            competitor_seen = threading.Event()
            def take_first(grant):
                if grant.owner["jobId"] == gpu_id and not competitor_seen.is_set():
                    replacement, _ = self.leases.claim(DEVICE, SECOND)
                    self.assertIsNotNone(replacement)
                    self.assertFalse(real_release(grant))
                    self.assertTrue(real_release(replacement))
                    competitor_seen.set()
                    return False
                return real_release(grant)
            with patch.object(GpuGrant, "release", take_first):
                adapter.finished = True
                until(lambda: native.get(gpu_id)["status"] == "succeeded")
            self.assertTrue(competitor_seen.is_set())
            job = native.get(gpu_id)
            self.assertEqual(job["gpu"]["state"], "released")
            self.assertEqual(job["gpu"]["owner"]["jobId"], gpu_id)
            self.assertEqual(job["result"]["files"][0]["bytes"], 9)

    def test_legacy_manual_waits_and_cancels_in_the_shared_gpu_queue(self):
        blocker, _ = self.leases.claim(DEVICE, FIRST)
        self.assertIsNotNone(blocker)
        adapter = FixtureComfy()
        queue = QueueManager(self.root / "queue.json", adapter, gpu_leases=self.leases, poll_interval=.02)
        queue.start()
        self.addCleanup(queue.stop)
        with patch("gpu_lease._reconcile_comfy", side_effect=lambda _row: adapter.finished):
            cancel_before_dispatch = queue.enqueue({"workflow": WORKFLOW, "clientId": "legacy:cancel"}, legacy_manual=True)
            waiting = until(lambda: queue.get(cancel_before_dispatch["id"])["gpu"]
                            if queue.get(cancel_before_dispatch["id"]).get("gpu") else None)
            self.assertEqual(waiting["state"], "waiting")
            self.assertEqual(waiting["owner"], FIRST)
            self.assertFalse(adapter.dispatched.is_set())
            self.assertEqual(queue.cancel(cancel_before_dispatch["id"])["status"], "cancelled")
            job = queue.enqueue({"workflow": WORKFLOW, "clientId": "legacy:run"}, legacy_manual=True)
            self.assertEqual((job["origin"], job["canvasOwned"]), ("legacy-manual", False))
            self.assertIsNone(job["projectId"])
            self.assertIsNone(job["nodeId"])
            until(lambda: queue.get(job["id"]).get("gpu", {}).get("state") == "waiting")
            self.assertTrue(blocker.release())
            self.assertTrue(adapter.dispatched.wait(5))
            until(lambda: queue.get(job["id"]).get("comfyPromptId") == "fixture-prompt")
            occupied = queue.get(job["id"])["gpu"]
            self.assertEqual(occupied["state"], "held")
            self.assertEqual(occupied["owner"]["jobId"], job["id"])
            self.assertEqual(occupied["owner"]["origin"], "legacy-manual")
            self.assertEqual(queue.cancel(job["id"])["gpu"]["state"], "reconciling")
            self.assertTrue(adapter.cancelled.is_set())
            self.assertEqual(self.leases.claim(DEVICE, FIRST), (None, occupied["owner"]))
            adapter.finished = True
            until(lambda: queue.get(job["id"]).get("gpu", {}).get("state") == "released")
            following, _ = self.leases.claim(DEVICE, FIRST)
            self.assertTrue(following.release())

    def test_cancelled_lost_ack_recovers_original_prompt_after_scheduler_restart(self):
        adapter = FixtureComfy()
        sent, drop_ack = threading.Event(), threading.Event()
        submissions = []

        def dropped(workflow, client_id, *, gpu_dispatch):
            submissions.append(gpu_dispatch)
            sent.set()
            if drop_ack.wait(5):
                raise TimeoutError("acknowledgement lost")
            raise AssertionError("fixture failed to control response")

        adapter.submit = dropped
        adapter.find_gpu_dispatch = lambda dispatch: None
        path = self.root / "queue.json"
        queue = QueueManager(path, adapter, gpu_leases=self.leases, poll_interval=.02)
        queue.start()
        self.addCleanup(queue.stop)
        with patch("gpu_lease._reconcile_comfy", side_effect=lambda _row: adapter.finished):
            job = queue.enqueue({"workflow": WORKFLOW, "clientId": "legacy:lost-ack"}, legacy_manual=True)
            self.assertTrue(sent.wait(5))
            self.assertEqual(queue.cancel(job["id"])["gpu"]["state"], "reconciling")
            drop_ack.set()
            queue.stop()
            owner = queue.get(job["id"])["gpu"]["owner"]
            self.assertEqual(self.leases.claim(DEVICE, FIRST), (None, owner))
            adapter.find_gpu_dispatch = lambda dispatch: "original-prompt" if submissions == [dispatch] else None
            recovered = QueueManager(path, adapter, gpu_leases=self.leases, poll_interval=.02)
            recovered.start()
            try:
                self.assertTrue(adapter.cancelled.wait(5))
                until(lambda: recovered.get(job["id"]).get("comfyPromptId") == "original-prompt")
                self.assertEqual(recovered.get(job["id"])["status"], "cancelled")
                self.assertEqual(len(submissions), 1)
                self.assertEqual(self.leases.claim(DEVICE, FIRST), (None, owner))
                adapter.finished = True
                until(lambda: recovered.get(job["id"]).get("gpu", {}).get("state") == "released")
            finally:
                recovered.stop()

    def test_worker_progress_and_host_artifact_identity(self):
        self.assertEqual(list(worker_progress(io.StringIO('debug\n{"stage":"sample","progress":0.5}\n{"progress":true}\n'))),
                         [{"stage": "sample", "progress": .5}])
        artifact = self.root / "mesh.glb"
        artifact.write_bytes(b"test artifact")
        manifest = self.root / "result.json"
        manifest.write_text(json.dumps({"metadata": {}, "quality": {}, "warnings": [],
                                        "files": [{"name": "mesh.glb", "role": "model", "mime": "model/gltf-binary",
                                                   "sha256": "untrusted"}]}), encoding="utf-8")
        verified = verified_result(manifest, lambda name: (self.root / name, "/fixture/" + name))
        self.assertEqual(verified["files"][0]["bytes"], len(b"test artifact"))
        self.assertRegex(verified["files"][0]["sha256"], r"^[a-f0-9]{64}$")
