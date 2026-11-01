import http.client
import json
import copy
import subprocess
import sys
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

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
        self.server.token = "queue-test-token"
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
        request = urllib.request.Request(self.origin + path, data=data, headers={"Content-Type": "application/json", "X-H3-Token": self.server.token})
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status, json.load(response)

    def test_crud_events_and_browser_independent_progress(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        connection.request("GET", "/api/queue/events", headers={"X-H3-Token": self.server.token})
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

    def sheet_fixture(self):
        self.manager.pause(True)
        script = "globalThis.window={location:{hostname:'127.0.0.1'}}; const {buildCharacterSheetQueuePlan}=await import('./src/workbench-api.js'); console.log(JSON.stringify(buildCharacterSheetQueuePlan({prompt:'fixture',seed:281306,qwenCacheDevice:'cpu',references:[{kind:'image',slot:'guide',name:'fixture.png'}]})));"
        plan = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=Path(__file__).parent, text=True, encoding='utf-8'))
        row = self.manager.enqueue({'projectId': 'prj_inspect', 'nodeId': 'sheet', 'plan': plan})
        with self.manager._lock:
            job = self.manager._find_locked(row['id'])
            job.update(status='done', comfyPromptId='sheet-p5', attempts=1)
            job['planState'].update(panelIndex=3, phase='stitch', promptIds=[f'sheet-p{i}' for i in range(1, 6)],
                                    images={panel['id']: f"workbench/{panel['id']}.png" for panel in plan['panels']})
            self.manager._persist_locked()
        return row['id']

    def test_inspect_sheet_saved_front_cache_and_no_mutation(self):
        job_id = self.sheet_fixture()
        before = self.manager.path.read_bytes()
        status, result = self.request(f'/api/queue/inspect?projectId=prj_inspect&nodeId=sheet&jobId={job_id}&promptId=sheet-p5')
        self.assertEqual(status, 200)
        self.assertEqual(result['defaultStage'], 'front_portrait')
        self.assertEqual(len(result['stages']), 5)
        angle = result['stages'][1]
        self.assertEqual(angle['graph']['angle_source']['inputs']['image'], 'workbench/front_portrait.png')
        self.assertEqual(angle['graph']['cache']['inputs'], {'model': ['model', 0], 'device': 'cpu', 'dtype': 'default'})
        self.assertEqual(angle['provenance'], 'persisted-plan')
        self.assertTrue(angle['executed'])
        self.assertNotIn('outputs', result)
        self.assertEqual(self.manager.path.read_bytes(), before)
        self.assertEqual(self.adapter.submitted, [])

    def test_inspect_scope_old_result_and_never_run(self):
        job_id = self.sheet_fixture()
        newer = self.manager.enqueue({'projectId': 'prj_inspect', 'nodeId': 'sheet', 'workflow': payload()['workflow']})
        self.assertNotEqual(newer['id'], job_id)
        _, old = self.request('/api/queue/inspect?projectId=prj_inspect&promptId=sheet-p2')
        self.assertEqual(old['jobId'], job_id)
        for query in [f'projectId=wrong&jobId={job_id}', f'projectId=prj_inspect&nodeId=wrong&jobId={job_id}',
                      'projectId=prj_inspect&jobId=job_missing', 'projectId=prj_inspect&promptId=missing-old-result',
                      f'projectId=prj_inspect&jobId={newer["id"]}&promptId=sheet-p2', 'projectId=prj_inspect&nodeId=never-run']:
            with self.subTest(query=query), self.assertRaises(urllib.error.HTTPError) as caught:
                self.request(f'/api/queue/inspect?{query}')
            self.assertEqual(caught.exception.code, 404)
        self.manager.retry(job_id)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request(f'/api/queue/inspect?projectId=prj_inspect&jobId={job_id}&promptId=sheet-p5')
        self.assertEqual(caught.exception.code, 404, 'retry must not substitute a new attempt for an old result')

    def test_inspect_actual_history_failure_stage_and_unavailable_dependencies(self):
        job_id = self.sheet_fixture()
        with self.manager._lock:
            job = self.manager._find_locked(job_id)
            job.update(status='error', comfyPromptId='sheet-p2')
            job['planState'].update(panelIndex=1, phase='single', promptIds=['sheet-p1', 'sheet-p2'])
            job['planState']['images'] = {}
            exact = {'actual': {'class_type': 'Test', 'inputs': {'seed': 77}}}
            job['history'] = {'prompt': [0, 'sheet-p2', exact, {}]}
        _, result = self.request(f'/api/queue/inspect?projectId=prj_inspect&jobId={job_id}')
        self.assertEqual(result['defaultStage'], 'three_quarter_portrait')
        self.assertEqual(result['stages'][1]['graph'], exact)
        self.assertEqual(result['stages'][1]['provenance'], 'execution')
        self.assertIsNone(result['stages'][-1]['graph'])
        self.assertFalse(result['stages'][2]['executed'])

    def test_inspect_outfit_missing_hd_does_not_invent_input_and_limits(self):
        from test_outfit_queue import plan
        self.manager.pause(True)
        row = self.manager.enqueue({'projectId': 'prj_inspect', 'nodeId': 'outfit', 'plan': plan()})
        _, result = self.request(f'/api/queue/inspect?projectId=prj_inspect&jobId={row["id"]}')
        self.assertIsNone(result['stages'][1]['graph'])
        self.assertEqual(result['stages'][1]['provenance'], 'unavailable')
        single = self.manager.enqueue({'projectId': 'prj_inspect', 'nodeId': 'single', 'plan': plan('tr')})
        with self.manager._lock:
            job = self.manager._find_locked(single['id'])
            job.update(status='done', comfyPromptId='hd-completed')
            job['planState'].update(phase='hd', currentInput='workbench/already-upscaled.png')
        _, single_result = self.request(f'/api/queue/inspect?projectId=prj_inspect&jobId={single["id"]}')
        self.assertIsNone(single_result['stages'][1]['graph'], 'the HD output cannot be misrepresented as its former input')
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/api/queue/inspect?jobId=job_missing')
        self.assertEqual(caught.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/api/queue/inspect?projectId=x&projectId=y&nodeId=z')
        self.assertEqual(caught.exception.code, 400)
        huge = self.manager.enqueue({'projectId': 'prj_inspect', 'nodeId': 'huge', 'workflow': {str(i): {'class_type': 'Test', 'inputs': {}} for i in range(2049)}})
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request(f'/api/queue/inspect?projectId=prj_inspect&jobId={huge["id"]}')
        self.assertEqual(caught.exception.code, 400)

    def test_comfy_frame_csp_and_installer_copies_extension(self):
        request = urllib.request.Request(self.origin + '/api/queue', headers={'X-H3-Token': self.server.token})
        with urllib.request.urlopen(request, timeout=3) as response:
            policy = response.headers['Content-Security-Policy']
            self.assertIn('frame-src http://127.0.0.1:8188 http://localhost:8188', policy)
            self.assertNotIn('frame-src *', policy)
        import install
        target = Path(self.temporary.name) / 'comfy-fixture'
        with patch.object(install, 'NODE_PACKAGES', {}), patch.object(install, 'run') as run:
            install.install_nodes(target, Path('unused-python'))
        run.assert_not_called()
        installed = target / 'custom_nodes/h3_workbench_refine'
        self.assertIn('WEB_DIRECTORY = "./web"', (installed / '__init__.py').read_text(encoding='utf-8'))
        self.assertEqual((installed / 'web/workbench-inspector.js').read_bytes(), (Path(__file__).parent / 'comfy-nodes/h3_workbench_refine/web/workbench-inspector.js').read_bytes())


if __name__ == "__main__":
    unittest.main()
