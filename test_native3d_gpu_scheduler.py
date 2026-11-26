"""Native3D scheduling through real local leases, with synthetic CPU workers."""
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
import uuid

from gpu_lease import GpuLeases
from native3d_jobs import Native3DJobs, atomic
from native3d_partfield import CHECKPOINT_SHA, COMMIT, feature_cache_path


DEVICE = 'gpu-2fea9501-69a5-4f36-b824-237dd6e08ae1'
HIGH = 'a' * 64
ENGINE = r"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, REPOSITORY)
from gpu_lease import WORKER_LEASE_ENV, adopt_worker_lease
p = argparse.ArgumentParser()
p.add_argument('--request')
p.add_argument('--output')
args = p.parse_args()
request = json.loads(Path(args.request).read_text())
out = Path(args.output)
lease = os.environ.get(WORKER_LEASE_ENV)
adopt_worker_lease()
(out/'execution.json').write_text(json.dumps({'leased': bool(lease), 'cuda': os.environ.get('CUDA_VISIBLE_DEVICES')}))
mode = request.get('mode')
if mode == 'orphan':
    code = (
        'from pathlib import Path; import sys,time; sys.path.insert(0,sys.argv[1]); '
        'from gpu_lease import adopt_worker_lease; adopt_worker_lease(); '
        'out=Path(sys.argv[2]); (out/"nested-ready").touch(); deadline=time.monotonic()+15; '
        'exec("while not (out/\\\"nested-stop\\\").exists() and time.monotonic()<deadline:\\n time.sleep(.03)")'
    )
    subprocess.Popen([sys.executable, '-B', '-c', code, REPOSITORY, str(out)], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     env={**os.environ, WORKER_LEASE_ENV: lease})
    for i in range(160):
        if (out/'nested-ready').exists():
            os._exit(37)
        time.sleep(.03)
    os._exit(38)
if mode == 'wait':
    time.sleep(20)
(out/'mesh.obj').write_text('v 0 0 0')
(out/'result.json').write_text(json.dumps({'metadata':{},'quality':{},'warnings':[],
                           'files':[{'name':'mesh.obj','role':'model','mime':'text/plain'}]}))
"""


class NativeGPUQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.manager = GpuLeases(root/'gpu')
        self.engine = root/'engine.py'
        self.engine.write_text('REPOSITORY = '+repr(str(Path(__file__).resolve().parent))+'\n'+ENGINE, encoding='utf-8')
        self.service = Native3DJobs(root/'jobs', None, engine_path=self.engine, gpu_leases=self.manager,
                                    gpu_device=lambda: DEVICE)
        self.addCleanup(self.service.close)
        self.cache = root/'cache'

    def job(self, operation, mode=None, *, executable=None):
        job_id = 'n3d_'+uuid.uuid4().hex
        directory = self.service.root/job_id
        directory.mkdir()
        request = {'id':job_id, 'projectId':'fixture', 'nodeId':job_id, 'opId':job_id,
                   'status':'queued', 'stage':'queued', 'progress':0, 'fingerprint':job_id,
                   'source':{'highSha256':HIGH}, 'operation':operation, 'parameters':{}, 'mode':mode,
                   'partfieldConfig':{'cacheRoot':str(self.cache)}}
        atomic(directory/'request.json', request)
        atomic(directory/'runtime.json', {'pythonExecutable':executable or sys.executable,'timeoutSeconds':12})
        with self.service.lock:
            self.service._admit(request)
        self.service.wake.set()
        return job_id

    def until(self, check, seconds=9):
        expire = time.monotonic() + seconds
        while time.monotonic() < expire:
            result = check()
            if result:
                return result
            time.sleep(.035)
        self.fail('Did not observe expected local lease state')

    def stage(self, job, stage):
        return self.until(lambda: self.service.get(job)['stage'] == stage and self.service.get(job))

    def _stop_orphan(self, job):
        marker = self.service.root/job/'output/nested-stop'
        if marker.parent.is_dir():
            marker.touch()
        grant = self.until(lambda: self.manager.claim(DEVICE, {'kind':'test-cleanup'})[0])
        grant.release()

    def test_only_inference_waits_for_gpu_and_waiting_cancel_never_starts(self):
        blocker, _ = self.manager.claim(DEVICE, {'kind':'external-fixture'})
        self.addCleanup(blocker.release)
        ai = self.job('ai_lowpoly')
        first = self.stage(ai, 'waiting_gpu')
        self.assertEqual(first['gpu']['state'], 'waiting')
        plan = self.job('uv_plan')
        self.stage(plan, 'waiting_gpu')
        apply = self.job('uv')
        self.assertNotIn('gpu', self.stage(apply, 'completed'))
        cancelled = self.service.cancel(ai)
        self.assertEqual(cancelled['status'], 'cancelled')
        self.assertFalse((self.service.root/ai/'output/execution.json').exists())

        cache = feature_cache_path(self.cache, HIGH)
        cache.mkdir(parents=True)
        for name in ('high-input.json','high-samples.npz','high-query-features.npy'):
            (cache/name).write_bytes(b'Synthetic classification only')
        (cache/'high-inference.json').write_text(json.dumps({'sourceSha256':HIGH,'officialCommit':COMMIT,'checkpointSha256':CHECKPOINT_SHA}))
        completed = self.stage(plan, 'completed')
        self.assertNotIn('gpu', completed)
        self.assertFalse(json.loads((self.service.root/plan/'output/execution.json').read_text())['leased'])

        self.assertTrue(blocker.release())
        fresh = self.job('ai_lowpoly')
        job = self.stage(fresh, 'completed')
        self.assertEqual(job['gpu']['state'], 'released')
        actual = json.loads((self.service.root/fresh/'output/execution.json').read_text())
        self.assertTrue(actual['leased'])
        self.assertEqual(actual['cuda'], 'GPU-'+DEVICE[4:])

    def test_launch_error_releases_lease_for_next_job(self):
        bad = self.job('ai_lowpoly', executable=str(self.temp.name+'/absent.exe'))
        self.assertEqual(self.stage(bad, 'failed')['gpu']['state'], 'released')
        self.assertEqual(self.stage(self.job('ai_lowpoly'), 'completed')['gpu']['state'], 'released')

    def test_running_cancel_releases_after_worker_stops(self):
        job = self.job('ai_lowpoly','wait')
        self.stage(job, 'starting')
        self.assertEqual(self.service.cancel(job)['status'], 'cancelled')
        self.until(lambda: self.service.get(job).get('gpu',{}).get('state') == 'released')
        self.assertEqual(self.stage(self.job('ai_lowpoly'), 'completed')['gpu']['state'], 'released')

    def test_abnormal_engine_exit_cannot_release_live_nested_worker(self):
        job = self.job('ai_lowpoly','orphan')
        self.addCleanup(self._stop_orphan, job)
        fault = self.stage(job, 'failed')
        self.assertTrue((self.service.root/job/'output/nested-ready').is_file())
        self.assertEqual(fault['gpu']['state'], 'reconciling')
        blocked, owner = self.manager.claim(DEVICE, {'kind':'next-fixture'})
        self.assertIsNone(blocked)
        self.assertEqual(owner['jobId'], job)
        (self.service.root/job/'output/nested-stop').touch()
        self.until(lambda: self.service.get(job)['gpu']['state'] == 'released')

    def test_new_token_is_not_cleared_by_old_terminal_receipt(self):
        stale, _ = self.manager.claim(DEVICE, {'kind':'old-fixture'})
        self.assertTrue(stale.release())
        current, _ = self.manager.claim(DEVICE, {'kind':'current-fixture'})
        self.addCleanup(current.release)
        self.assertFalse(stale.release())
        self.assertTrue(self.manager.reconcile_worker_release(DEVICE, stale.owner, token=stale.token))
        blocked, owner = self.manager.claim(DEVICE, {'kind':'other-fixture'})
        self.assertIsNone(blocked)
        self.assertEqual(owner, current.owner)


if __name__ == '__main__':
    unittest.main()

