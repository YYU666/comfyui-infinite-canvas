"""Task identity, worker and HTTP tests using only temp projects and mocked IO."""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pcg_api import PCGAPI
from pcg_contracts import PCGError, canonical
from pcg_runtime import HANDLE, PCGRuntime, WORKER_PATH
from project_store import ProjectStore, StoreError


def pcg_node(node_id='pcg1', descriptor='refmuse.pcg.diagnostic', parameters=None):
    return {'id': node_id, 'type': 'pcg', 'position': {'x': 0, 'y': 0}, 'data': {'descriptorId': descriptor, 'descriptorVersion': 1, 'operationVersion': 1, 'parameters': parameters or {}}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ProjectStore(Path(self.temp.name) / 'projects')
        self.document = self.store.create('Synthetic', {'nodes': [pcg_node()], 'edges': [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})
        self.runtime = PCGRuntime(self.store)
        self.identity = {'projectId': self.document['id'], 'nodeId': 'pcg1', 'revision': 1, 'descriptorVersion': 1, 'operationVersion': 1, 'runId': 'run-1'}

    def tearDown(self):
        self.runtime.close(); self.store.close(); self.temp.cleanup()

    @staticmethod
    def handle(task): return {k: task[k] for k in HANDLE}

    def run_wait(self, identity=None):
        task = self.runtime.run(identity or self.identity)
        return self.runtime.wait({**self.handle(task), 'timeoutMs': 10000})['task']

    def save_nodes(self, nodes, edges=None):
        document = self.store.get(self.document['id'])
        document['canvas'] = {'nodes': nodes, 'edges': edges or [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}}
        self.document = self.store.save(document['id'], document, document['revision'])
        self.identity['revision'] = self.document['revision']

    def test_real_separate_worker_diagnostic_idempotent_verify(self):
        preflight = self.runtime.preflight(self.identity)
        task = self.run_wait()
        self.assertEqual(task['status'], 'succeeded', task)
        self.assertEqual(task['inputHash'], preflight['inputHash'])
        self.assertNotEqual(task['result']['report']['workerPid'], os.getpid())
        self.assertEqual(task['result']['report']['inputCount'], 0)
        self.assertTrue(self.runtime.verify(self.handle(task))['verified'])
        self.assertEqual(self.runtime.run(self.identity)['jobId'], task['jobId'])
        self.assertEqual(self.runtime.list_tasks(self.identity['projectId'], 'pcg1')['tasks'][0]['jobId'], task['jobId'])

    def test_handles_cross_project_node_run_version_input_rejected(self):
        task = self.run_wait(); handle = self.handle(task)
        other = self.store.create('Other', {'nodes': [pcg_node()], 'edges': [], 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})
        for key, value in [('projectId', other['id']), ('nodeId', 'other'), ('runId', 'other'), ('inputHash', 'f' * 64), ('descriptorVersion', 2), ('operationVersion', 2)]:
            with self.assertRaises(PCGError): self.runtime.read({**handle, key: value})
        with self.assertRaises(PCGError): self.runtime.run({**self.identity, 'script': 'no'})
        with self.assertRaises(PCGError): self.runtime.run({**self.identity, 'revision': True})

    def test_stale_task_discoverable_but_cannot_verify_or_run(self):
        original = dict(self.identity); task = self.run_wait()
        self.save_nodes([pcg_node(parameters={'label': 'Updated'})])
        self.assertTrue(self.runtime.read(self.handle(task))['task']['stale'])
        self.assertTrue(self.runtime.list_tasks(self.identity['projectId'], 'pcg1')['tasks'][0]['stale'])
        for callback in (lambda: self.runtime.verify(self.handle(task)), lambda: self.runtime.run(original), lambda: self.runtime.preflight(original)):
            with self.assertRaises(PCGError) as caught: callback()
            self.assertEqual(caught.exception.code, 'REVISION_CONFLICT')
        with self.assertRaises(PCGError) as caught: self.runtime.run(self.identity)
        self.assertEqual(caught.exception.code, 'IDEMPOTENCY_CONFLICT')

    def test_readonly_and_foreign_lock_rejected(self):
        path = self.store._project_path(self.document['id'])
        self.store._read_only.add(path.resolve())
        with self.assertRaises(StoreError) as caught: self.runtime.preflight(self.identity)
        self.assertEqual(caught.exception.code, 'READ_ONLY')
        self.store._read_only.clear()
        foreign = ProjectStore(self.store.root, 'foreign')
        try:
            foreign.open(self.document['id'])
            with self.assertRaises(StoreError) as caught: self.runtime.run(self.identity)
            self.assertEqual(caught.exception.code, 'LOCKED')
        finally: foreign.close()

    def test_geometry_stub_retained_failed_no_worker(self):
        self.save_nodes([pcg_node(descriptor='refmuse.pcg.geometry_stub')])
        with self.assertRaises(PCGError) as caught: self.runtime.preflight(self.identity)
        self.assertEqual(caught.exception.code, 'EXECUTOR_UNAVAILABLE')
        with mock.patch('pcg_runtime.subprocess.Popen', side_effect=AssertionError('must not execute')):
            task = self.runtime.run(self.identity)
        self.assertEqual(task['status'], 'failed'); self.assertEqual(task['error']['code'], 'EXECUTOR_UNAVAILABLE')
        self.assertIsNone(task['result'])
        self.assertEqual(self.runtime.wait(self.handle(task))['task']['jobId'], task['jobId'])

    def test_typed_edges_missing_dependency_unknown_port_and_schema(self):
        source = pcg_node('stub', 'refmuse.pcg.geometry_stub')
        edge = {'id': 'edge', 'source': 'stub', 'target': 'pcg1', 'sourceHandle': 'geometry', 'targetHandle': 'geometry', 'data': {'pcgType': 'GeometryArtifact'}}
        self.save_nodes([source, pcg_node()], [edge])
        with self.assertRaises(PCGError) as caught: self.runtime.preflight(self.identity)
        self.assertEqual(caught.exception.code, 'EXECUTOR_UNAVAILABLE')
        for target, code in [('field', 'PORT_TYPE_MISMATCH'), ('unknown', 'PORT_UNKNOWN')]:
            self.save_nodes([source, pcg_node()], [{**edge, 'targetHandle': target}])
            with self.assertRaises(PCGError) as caught: self.runtime.preflight(self.identity)
            self.assertEqual(caught.exception.code, code)
        self.save_nodes([pcg_node(parameters={'execute': 'arbitrary'})])
        with self.assertRaises(PCGError): self.runtime.preflight(self.identity)

    def test_worker_crash_timeout_protocol_failures_retained(self):
        fixtures = [('WORKER_CRASH', mock.Mock(returncode=3, communicate=mock.Mock(return_value=(b'', b'')))),
                    ('WORKER_PROTOCOL', mock.Mock(returncode=0, communicate=mock.Mock(return_value=(b'{}', b'')))),
                    ('WORKER_TIMEOUT', mock.Mock(returncode=-9, communicate=mock.Mock(side_effect=[subprocess.TimeoutExpired('worker', 5), (b'', b'')])))]
        for index, (code, process) in enumerate(fixtures):
            process.pid = 999999
            with mock.patch('pcg_runtime.subprocess.Popen', return_value=process):
                task = self.run_wait({**self.identity, 'runId': f'failure-{index}'})
            self.assertEqual(task['status'], 'failed', task)
            self.assertEqual(task['error']['code'], code, task)
            self.assertEqual(self.runtime.read(self.handle(task))['task']['error']['code'], code)

    def test_malformed_worker_values_are_terminal_protocol_failures(self):
        for index, raw in enumerate((b'[]', b'null', b'"string"', b'{}', b'{"ok":true}', b'{"ok":true,"result":[]}')):
            process = mock.Mock(returncode=0, pid=999999, communicate=mock.Mock(return_value=(raw, b'')))
            with mock.patch('pcg_runtime.subprocess.Popen', return_value=process):
                task = self.run_wait({**self.identity, 'runId': f'malformed-{index}'})
            self.assertEqual(task['status'], 'failed', task)
            self.assertEqual(task['error']['code'], 'WORKER_PROTOCOL', task)
        self.assertEqual(self.runtime.active_count(), 0)

    def test_wait_bounded_concurrent_isolation_no_sensitive_env(self):
        tasks = [self.runtime.run({**self.identity, 'runId': f'parallel-{i}'}) for i in range(3)]
        results = [self.runtime.wait({**self.handle(t), 'timeoutMs': 10000})['task'] for t in tasks]
        self.assertTrue(all(t['status'] == 'succeeded' for t in results), results)
        self.assertEqual(len({t['jobId'] for t in tasks}), 3)
        for invalid in (-1, 20001, True):
            with self.assertRaises(PCGError): self.runtime.wait({**self.handle(tasks[0]), 'timeoutMs': invalid})
        real_popen = subprocess.Popen
        calls = []
        def capture(*args, **kwargs):
            calls.append((args, kwargs)); return real_popen(*args, **kwargs)
        with mock.patch.dict(os.environ, {'SECRET_FIXTURE_KEY': 'not-for-worker'}), mock.patch('pcg_runtime.subprocess.Popen', side_effect=capture):
            task = self.run_wait({**self.identity, 'runId': 'environment'})
        self.assertEqual(task['status'], 'succeeded', task)
        self.assertNotIn('SECRET_FIXTURE_KEY', calls[0][1]['env'])
        self.assertEqual(calls[0][0][0], [sys.executable, '-I', str(WORKER_PATH)])

    def test_direct_worker_strict_protocol_and_no_dynamic_operation(self):
        base = {'protocolVersion': 1, 'descriptorId': 'refmuse.pcg.diagnostic', 'descriptorVersion': 1, 'operationVersion': 1, 'parameters': {}, 'inputs': {}, 'projectId': self.document['id'], 'inputHash': 'a' * 64}
        for mutation, code in [({'descriptorId': 'refmuse.pcg.geometry_stub'}, 'EXECUTOR_UNAVAILABLE'), ({'protocolVersion': 2}, 'VERSION_UNSUPPORTED'), ({'executable': 'anything'}, 'INVALID_CONTRACT')]:
            result = subprocess.run([sys.executable, '-I', str(WORKER_PATH)], input=canonical({**base, **mutation}), capture_output=True, timeout=10, cwd=self.temp.name)
            output = json.loads(result.stdout)
            self.assertFalse(output['ok']); self.assertEqual(output['error']['code'], code)


class FakeHandler:
    def __init__(self, path, payload=None, headers=None):
        self.path = path; self.body = canonical(payload) if payload is not None else b''
        self.headers = {'Content-Length': str(len(self.body)), **(headers or {})}
        self.rfile = io.BytesIO(self.body); self.response = None
    def send_json(self, status, payload): self.response = (status, payload)


class APITests(unittest.TestCase):
    handle = staticmethod(RuntimeTests.handle)
    def setUp(self):
        RuntimeTests.setUp(self); self.api = PCGAPI(self.store)
    def tearDown(self):
        self.api.close(); RuntimeTests.tearDown(self)

    def test_api_registry_diagnostic_loop_and_query(self):
        handler = FakeHandler('/api/pcg/registry')
        self.api.handle(handler, 'GET', '/api/pcg/registry')
        self.assertEqual(handler.response[1], self.api.runtime.registry)
        handler = FakeHandler('/api/pcg/run', self.identity)
        self.api.handle(handler, 'POST', '/api/pcg/run')
        self.assertEqual(handler.response[0], 202, handler.response)
        task = handler.response[1]['task']
        handler = FakeHandler('/api/pcg/wait', {**self.handle(task), 'timeoutMs': 10000})
        self.api.handle(handler, 'POST', '/api/pcg/wait')
        self.assertEqual(handler.response[1]['task']['status'], 'succeeded', handler.response)
        import urllib.parse
        query = urllib.parse.urlencode({k: v for k, v in self.handle(task).items() if k != 'jobId'})
        handler = FakeHandler('/api/pcg/tasks/' + task['jobId'] + '?' + query)
        self.api.handle(handler, 'GET', '/api/pcg/tasks/' + task['jobId'])
        self.assertEqual(handler.response[0], 200, handler.response)
        handler = FakeHandler('/api/pcg/tasks?' + urllib.parse.urlencode({'projectId': self.identity['projectId'], 'nodeId': 'pcg1'}))
        self.api.handle(handler, 'GET', '/api/pcg/tasks')
        self.assertEqual(len(handler.response[1]['tasks']), 1)

    def test_api_request_bounds_revision_and_unknown_fields(self):
        for payload, headers, status in [(self.identity, {'Content-Length': '65537'}, 400), (self.identity, {'If-Match': '999'}, 409), ({**self.identity, 'code': 'no'}, {}, 400)]:
            handler = FakeHandler('/api/pcg/run', payload, headers)
            self.api.handle(handler, 'POST', '/api/pcg/run')
            self.assertEqual(handler.response[0], status, handler.response)
        handler = FakeHandler('/api/pcg/tasks?projectId=a&projectId=b&nodeId=c')
        self.api.handle(handler, 'GET', '/api/pcg/tasks')
        self.assertEqual(handler.response[0], 400)

    def test_host_origin_auth_guards_precede_pcg_dispatch_without_network(self):
        from video_workbench_launcher import WorkbenchHandler
        handler = object.__new__(WorkbenchHandler)
        handler.server = mock.Mock(server_port=18888, token='fixture-token')
        handler.path = '/api/pcg/run'; handler.command = 'POST'
        handler.send_json = mock.Mock()
        for headers, status in [({'Host': 'remote.invalid'}, 403),
                                ({'Host': '127.0.0.1:18888', 'Origin': 'https://remote.invalid'}, 403),
                                ({'Host': '127.0.0.1:18888'}, 401),
                                ({'Host': '127.0.0.1:18888', 'X-H3-Token': 'fixture-token', 'Content-Length': '1', 'Content-Type': 'text/plain'}, 415)]:
            handler.headers = headers
            handler.server.pcg_api.handle.reset_mock(); handler.send_json.reset_mock()
            handler.do_POST()
            self.assertEqual(handler.send_json.call_args.args[0], status)
            handler.server.pcg_api.handle.assert_not_called()

    def test_active_diagnostic_blocks_update_and_root_switch(self):
        from video_workbench_launcher import validate_settings_change, validate_update_ready
        from workbench_settings import SettingsError
        from workbench_update import UpdateError
        server = mock.Mock(project_store=self.store, sprite_atlas_api=None)
        server.pcg_api.active_count.return_value = 1
        with self.assertRaises(UpdateError) as caught: validate_update_ready(server)
        self.assertEqual(caught.exception.code, 'QUEUE_BUSY')
        with self.assertRaises(SettingsError) as caught: validate_settings_change(server, {'projectsRoot': str(Path(self.temp.name) / 'different')})
        self.assertEqual(caught.exception.code, 'QUEUE_BUSY')


if __name__ == '__main__': unittest.main()
