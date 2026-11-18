"""Viewport invalidation capability tests; no OS worker or running service needed."""
import copy
import io
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

from pcg_api import PCGAPI
from pcg_contracts import PCGError, canonical
from pcg_runtime import HANDLE, PCGRuntime
from project_store import ProjectStore, StoreError


def node(node_id='target'):
    return {'id': node_id, 'type': 'pcg', 'position': {'x': 0, 'y': 0},
            'data': {'descriptorId': 'refmuse.pcg.diagnostic', 'descriptorVersion': 1,
                     'operationVersion': 1, 'parameters': {}}}


class Handler:
    def __init__(self, path, payload, headers=None):
        self.path = path; body = canonical(payload)
        self.headers = {'Content-Length': str(len(body)), **(headers or {})}
        self.rfile = io.BytesIO(body); self.response = None
    def send_json(self, status, value): self.response = (status, value)


class ViewportCancelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ProjectStore(Path(self.temp.name) / 'projects')
        self.document = self.store.create('Viewport cancellation',
            {'nodes': [node()], 'edges': [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})
        self.api = PCGAPI(self.store); self.runtime = self.api.runtime
        self.execution = mock.patch.object(self.runtime, '_execute', return_value=None)
        self.execution.start()  # Real admission, deliberately controlled pending worker boundary.
    def tearDown(self):
        self.api.close(); self.execution.stop(); self.store.close(); self.temp.cleanup()
    def admit(self, run_id='old', node_id='target'):
        task = self.runtime.run({'projectId': self.document['id'], 'nodeId': node_id,
            'revision': self.document['revision'], 'descriptorVersion': 1,
            'operationVersion': 1, 'runId': run_id})
        return {k: task[k] for k in HANDLE}
    def save(self, nodes):
        document = self.store.get(self.document['id']); document['canvas']['nodes'] = nodes
        self.document = self.store.save(document['id'], document, document['revision'])
    def post(self, handle, path='/api/pcg/cancel-obsolete', headers=None):
        handler = Handler(path, handle, headers); self.assertTrue(self.api.handle(handler, 'POST', path))
        return handler.response

    def test_removed_node_old_revision_cancels_exact_worker_only(self):
        handle = self.admit(); task = self.runtime.tasks[handle['jobId']]
        process = mock.Mock(); process.poll.return_value = None; task['_process'] = process
        self.save([])
        with self.assertRaises(PCGError) as caught: self.runtime.cancel(handle)
        self.assertEqual(caught.exception.code, 'REVISION_CONFLICT')
        self.assertFalse(task['_cancel'].is_set())
        status, result = self.post(handle)
        self.assertEqual(status, 200); self.assertTrue(result['task']['stale'])
        self.assertTrue(task['_cancel'].is_set()); process.kill.assert_called_once()
        self.assertFalse(task['_event'].is_set(), 'Worker completion remains authoritative.')
        self.assertEqual(result['task']['jobId'], handle['jobId'])
        self.assertEqual(result['task']['revision'], handle['revision'])
        self.assertFalse(any(k.startswith('_') for k in result['task']))

    def test_old_task_never_cancels_newer_or_foreign_task(self):
        old = self.admit(); self.save([node()]); newer = self.admit('new')
        result = self.runtime.cancel_obsolete(old)
        self.assertTrue(result['task']['stale'])
        self.assertTrue(self.runtime.tasks[old['jobId']]['_cancel'].is_set())
        self.assertFalse(self.runtime.tasks[newer['jobId']]['_cancel'].is_set())
        other_runtime = PCGRuntime(self.store)
        try:
            with self.assertRaises(PCGError) as caught: other_runtime.cancel_obsolete(newer)
            self.assertEqual(caught.exception.code, 'TASK_NOT_FOUND')
        finally: other_runtime.close()
        self.assertFalse(self.runtime.tasks[newer['jobId']]['_cancel'].is_set())
        current = self.runtime.cancel_obsolete(newer)
        self.assertFalse(current['task']['stale'])
        self.assertTrue(self.runtime.tasks[newer['jobId']]['_cancel'].is_set())

    def test_obsolete_cancel_reaches_existing_m2_callback_and_completion_event(self):
        from pcg_isolation import IsolationError
        self.execution.stop()
        geometry = node(); geometry['data']['descriptorId'] = 'refmuse.pcg.primitive'
        self.save([geometry]); entered = threading.Event()
        def controlled_boundary(_request, *, cancelled, **_kwargs):
            entered.set(); deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                if cancelled(): raise IsolationError('CANCELLED', 'Controlled cancellation boundary observed flag.')
                time.sleep(.01)
            raise IsolationError('TIMEOUT', 'Cancellation flag was not observed.')
        with mock.patch.object(self.runtime, '_isolation', return_value={'available': True}), \
                mock.patch('pcg_isolation.execute', side_effect=controlled_boundary):
            handle = self.admit('geometry'); self.assertTrue(entered.wait(3))
            self.save([]); self.assertEqual(self.post(handle)[0], 200)
            task = self.runtime.wait({**handle, 'timeoutMs': 3000})['task']
        self.assertEqual(task['status'], 'cancelled'); self.assertTrue(task['stale'])
        self.assertEqual(task['error']['code'], 'WORKER_CANCELLED')
        self.assertTrue(self.runtime.tasks[handle['jobId']]['_event'].is_set())
        self.assertEqual(self.runtime.active_count(), 0)

    def test_every_handle_field_and_closed_schema_are_enforced(self):
        handle = self.admit(); second = self.admit('second')
        other = self.store.create('Other', {'nodes': [node()], 'edges': [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})
        alternatives = {'projectId': other['id'], 'nodeId': 'different', 'runId': 'different',
            'revision': handle['revision'] + 1, 'descriptorVersion': 2, 'operationVersion': 2,
            'jobId': second['jobId'], 'inputHash': 'f' * 64}
        for field, value in alternatives.items():
            with self.subTest(field=field):
                status, _ = self.post({**handle, field: value}); self.assertIn(status, (400, 404, 409))
        for missing in HANDLE:
            incomplete = dict(handle); incomplete.pop(missing)
            self.assertEqual(self.post(incomplete)[0], 400)
        for extra in ('nodeContract', 'script', 'timeoutMs'):
            self.assertEqual(self.post({**handle, extra: 'no'})[0], 400)
        self.assertFalse(self.runtime.tasks[handle['jobId']]['_cancel'].is_set())
        self.assertFalse(self.runtime.tasks[second['jobId']]['_cancel'].is_set())

    def test_terminal_task_is_idempotent_and_normal_cancel_remains_strict(self):
        handle = self.admit(); task = self.runtime.tasks[handle['jobId']]
        task.update(status='succeeded', result={'report': 'retained'})
        self.save([]); before = copy.deepcopy(task['result'])
        result = self.runtime.cancel_obsolete(handle)
        self.assertTrue(result['task']['stale']); self.assertEqual(task['result'], before)
        self.assertFalse(task['_cancel'].is_set()); self.assertEqual(task['status'], 'succeeded')
        with self.assertRaises(PCGError) as caught: self.runtime.verify(handle)
        self.assertEqual(caught.exception.code, 'REVISION_CONFLICT')
        self.assertEqual(self.post(handle, '/api/pcg/cancel')[0], 409)
        self.assertEqual(self.post(handle, '/api/pcg/cancel_obsolete')[0], 404)

    def test_readonly_foreign_lock_and_if_match_still_block(self):
        handle = self.admit(); path = self.store._project_path(self.document['id'])
        self.store._read_only.add(path.resolve())
        try:
            with self.assertRaises(StoreError) as caught: self.runtime.cancel_obsolete(handle)
            self.assertEqual(caught.exception.code, 'READ_ONLY')
        finally: self.store._read_only.clear()
        self.store.release(self.document['id'])
        foreign = ProjectStore(self.store.root, 'foreign')
        try:
            foreign.open(self.document['id'])
            with self.assertRaises(StoreError) as caught: self.runtime.cancel_obsolete(handle)
            self.assertEqual(caught.exception.code, 'LOCKED')
        finally: foreign.close()
        self.assertEqual(self.post(handle, headers={'If-Match': '999'})[0], 409)
        self.assertFalse(self.runtime.tasks[handle['jobId']]['_cancel'].is_set())

    def test_existing_host_auth_guards_precede_obsolete_route(self):
        from video_workbench_launcher import WorkbenchHandler
        handler = object.__new__(WorkbenchHandler)
        handler.server = mock.Mock(server_port=18888, token='fixture-token')
        handler.path = '/api/pcg/cancel-obsolete'; handler.command = 'POST'; handler.send_json = mock.Mock()
        for headers, status in (({'Host': 'remote.invalid'}, 403),
            ({'Host': '127.0.0.1:18888', 'Origin': 'https://remote.invalid'}, 403),
            ({'Host': '127.0.0.1:18888'}, 401),
            ({'Host': '127.0.0.1:18888', 'X-H3-Token': 'fixture-token', 'Content-Length': '1', 'Content-Type': 'text/plain'}, 415)):
            handler.headers = headers; handler.server.pcg_api.handle.reset_mock(); handler.send_json.reset_mock()
            handler.do_POST()
            self.assertEqual(handler.send_json.call_args.args[0], status)
            handler.server.pcg_api.handle.assert_not_called()


if __name__ == '__main__': unittest.main()
