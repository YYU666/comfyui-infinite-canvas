"""Saved-graph runtime acceptance using only synthetic local projects."""
import copy
import io
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from pcg_api import PCGAPI
from pcg_contracts import PCGError, canonical, load_registry
from pcg_runtime import PCGRuntime, HANDLE
from project_store import ProjectStore
from test_pcg_runtime import pcg_node


def edge(source, target, target_port='geometry', source_port='geometry'):
    return {'id': source + '-' + target + '-' + target_port, 'source': source, 'target': target, 'sourceHandle': source_port, 'targetHandle': target_port, 'data': {'pcgType': 'Geometry'}}


class M2RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.store = ProjectStore(Path(self.temp.name) / 'projects')
        self.nodes = [pcg_node('source', 'refmuse.pcg.primitive'), pcg_node('move', 'refmuse.pcg.transform'), pcg_node('final', 'refmuse.pcg.publish_geometry'), pcg_node('other', 'refmuse.pcg.primitive')]
        self.edges = [edge('source', 'move'), edge('move', 'final')]
        self.document = self.store.create('Synthetic', {'nodes': self.nodes, 'edges': self.edges, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}})
        self.runtime = PCGRuntime(self.store)
        self.identity = {'projectId': self.document['id'], 'nodeId': 'final', 'revision': 1, 'descriptorVersion': 1, 'operationVersion': 1, 'runId': 'run-1'}

    def tearDown(self): self.runtime.close(); self.store.close(); self.temp.cleanup()
    @staticmethod
    def handle(task): return {k: task[k] for k in HANDLE}
    def require_boundary(self):
        if not self.runtime._isolation()['available']: self.skipTest('Required OS isolation is unavailable on this host.')
    def execute(self, identity=None):
        task = self.runtime.run(identity or self.identity)
        return self.runtime.wait({**self.handle(task), 'timeoutMs': 20000})['task']
    def save(self):
        document = self.store.get(self.document['id']); document['canvas']['nodes'] = copy.deepcopy(self.nodes)
        self.document = self.store.save(document['id'], document, document['revision']); self.identity['revision'] = self.document['revision']

    def test_fail_closed_retained_without_isolation(self):
        with mock.patch.object(self.runtime, '_isolation', return_value={'available': False}), mock.patch('pcg_runtime.subprocess.Popen', side_effect=AssertionError('no fallback')):
            with self.assertRaises(PCGError) as caught: self.runtime.preflight(self.identity)
            self.assertEqual(caught.exception.code, 'ISOLATION_UNAVAILABLE')
            task = self.execute()
        self.assertEqual(task['status'], 'failed'); self.assertEqual(task['error']['code'], 'ISOLATION_UNAVAILABLE')
        self.assertEqual(self.runtime.read(self.handle(task))['task']['error'], task['error'])

    def test_host_output_byte_budget_exact_and_one_byte_over(self):
        from pcg_contracts import parse_json
        from pcg_worker import evaluate_graph
        def fixed_worker(request, **kwargs):
            return canonical({'ok': True, 'result': evaluate_graph(parse_json(request))})
        _, request, _ = self.runtime._prepare(self.identity, permit_unavailable=True)
        expected = evaluate_graph(request)
        size = len(canonical(expected['outputs']))
        target = next(d for d in self.runtime.registry['nodes'] if d['id'] == 'refmuse.pcg.publish_geometry')
        target['budget']['maxOutputBytes'] = size
        with mock.patch.object(self.runtime, '_isolation', return_value={'available': True}), \
                mock.patch('pcg_isolation.execute', side_effect=fixed_worker):
            exact_task = self.execute()
            self.assertEqual(exact_task['status'], 'succeeded', exact_task)
            timing = exact_task['result']['report']['timings'][-1]
            self.assertEqual(timing['outputBytes'], size)
            self.assertTrue(self.runtime.verify(self.handle(exact_task))['verified'])
            target['budget']['maxOutputBytes'] = size - 1
            oversized = self.execute({**self.identity, 'runId': 'one-byte-over'})
        self.assertEqual(oversized['status'], 'failed', oversized)
        self.assertEqual(oversized['error']['code'], 'BUDGET_EXCEEDED')
        self.assertIsNone(oversized['result'])

    def test_real_graph_exports_readback_verify_and_local_cache(self):
        self.require_boundary()
        preflight = self.runtime.preflight(self.identity)
        self.assertEqual(preflight['executionOrder'], ['source', 'move', 'final'])
        task = self.execute(); self.assertEqual(task['status'], 'succeeded', task)
        self.assertEqual(task['result']['report']['computedNodes'], ['source', 'move', 'final'])
        self.assertEqual(task['result']['report']['cacheHits'], [])
        self.assertEqual({a['format'] for a in task['result']['assets']}, {'glb', 'json', 'svg'})
        self.assertNotIn('positions', task['result']['outputs']['geometry'])
        stages = task['result']['stagePreviews']; self.assertEqual([s['nodeId'] for s in stages], ['source', 'move', 'final'])
        for stage in stages:
            self.assertEqual(stage['runId'], task['runId']); self.assertEqual(len(stage['assets']), 1)
            preview = stage['assets'][0]; self.assertEqual(preview['producerNodeId'], stage['nodeId'])
            svg, _ = self.runtime.download(self.handle(task), preview['artifactId'])
            self.assertIn(b'<svg', svg); self.assertEqual(preview['role'], 'preview')
        self.assertTrue(self.runtime.verify(self.handle(task))['verified'])
        exported = self.runtime.export({**self.handle(task), 'format': 'glb', 'port': 'geometry'})['artifact']
        body, metadata = self.runtime.download(self.handle(task), exported['artifactId'])
        self.assertEqual(body[:4], b'glTF'); self.assertEqual(metadata['jobId'], task['jobId'])
        self.nodes[-1]['data']['parameters'] = {'size': [2, 2, 2]}; self.save(); self.identity['runId'] = 'run-2'
        preflight = self.runtime.preflight(self.identity); self.assertEqual(preflight['dirtyNodes'], [])
        second = self.execute(); self.assertEqual(second['status'], 'succeeded', second)
        self.assertEqual(second['result']['report']['computedNodes'], [])
        self.assertEqual(second['result']['report']['cacheHits'], ['source', 'move', 'final'])
        self.nodes[1]['data']['parameters'] = {'translation': [1, 0, 0]}; self.save(); self.identity['runId'] = 'run-3'
        third = self.execute(); self.assertEqual(third['status'], 'succeeded', third)
        self.assertEqual(third['result']['report']['computedNodes'], ['move', 'final'])
        self.assertEqual(third['result']['report']['cacheHits'], ['source'])
        self.assertTrue(self.runtime.read(self.handle(task))['task']['stale'])
        with self.assertRaises(PCGError): self.runtime.export(self.handle(task))
        with self.assertRaises(PCGError): self.runtime.download(self.handle(task), exported['artifactId'])
        self.assertEqual(self.store.get(self.document['id'])['revision'], self.identity['revision'])

    def test_latest_run_identity_oldrun_cannot_publish_and_cancel_own_task(self):
        self.require_boundary()
        from pcg_isolation import IsolationError
        from pcg_worker import evaluate_graph
        first_started = threading.Event(); release = threading.Event()
        def delay(request, **kwargs):
            first_started.set()
            while not release.wait(.01):
                if kwargs['cancelled'](): raise IsolationError('CANCELLED', 'cancelled fixture')
            from pcg_contracts import parse_json
            return canonical({'ok': True, 'result': evaluate_graph(parse_json(request))})
        with mock.patch('pcg_isolation.execute', side_effect=delay):
            first = self.runtime.run(self.identity); self.assertTrue(first_started.wait(2))
            # Different target has its own cancellation identity and owned worker job.
            other_identity = {**self.identity, 'nodeId': 'other', 'runId': 'other-run'}
            other = self.runtime.run(other_identity)
            self.runtime.cancel(self.handle(other))
            cancelled = self.runtime.wait({**self.handle(other), 'timeoutMs': 2000})['task']
            self.assertEqual(cancelled['status'], 'cancelled', cancelled)
            self.assertFalse(self.runtime.tasks[first['jobId']]['_cancel'].is_set())
            newer = self.runtime.run({**self.identity, 'runId': 'newer-run'})
            release.set()
            old = self.runtime.wait({**self.handle(first), 'timeoutMs': 20000})['task']
            current = self.runtime.wait({**self.handle(newer), 'timeoutMs': 20000})['task']
        self.assertEqual(old['status'], 'failed', old); self.assertEqual(old['error']['code'], 'STALE_RUN')
        self.assertIsNone(old['result']); self.assertEqual(current['status'], 'succeeded', current)

    def test_worker_hash_tamper_retained_and_full_handle_export_required(self):
        self.require_boundary()
        from pcg_worker import evaluate_graph
        from pcg_contracts import parse_json
        def corrupt(request, **_):
            result = evaluate_graph(parse_json(request)); result['records'][0]['outputHash'] = 'f' * 64
            return canonical({'ok': True, 'result': result})
        with mock.patch('pcg_isolation.execute', side_effect=corrupt): task = self.execute()
        self.assertEqual(task['status'], 'failed'); self.assertEqual(task['error']['code'], 'WORKER_PROTOCOL')
        with self.assertRaises(PCGError): self.runtime.export({'jobId': task['jobId'], 'format': 'glb'})
        self.assertEqual(self.runtime.active_count(), 0)

    def test_http_export_download_auth_adapter_and_m3_unavailable(self):
        self.require_boundary()
        from test_pcg_runtime import FakeHandler
        api = PCGAPI(self.store); api.runtime.close(); api.runtime = self.runtime
        task = self.execute(); self.assertEqual(task['status'], 'succeeded', task)
        handler = FakeHandler('/api/pcg/export', {**self.handle(task), 'format': 'glb'})
        api.handle(handler, 'POST', '/api/pcg/export')
        self.assertEqual(handler.response[0], 200, handler.response)
        artifact = handler.response[1]['artifact']
        handler = FakeHandler(artifact['url']); handler.wfile = io.BytesIO()
        handler.send_response = mock.Mock(); handler.send_header = mock.Mock(); handler.end_headers = mock.Mock()
        api.handle(handler, 'GET', artifact['url'].split('?')[0])
        handler.send_response.assert_called_once_with(200)
        self.assertEqual(handler.wfile.getvalue()[:4], b'glTF')
        handler.send_header.assert_any_call('X-Content-Type-Options', 'nosniff')
        handler = FakeHandler('/api/pcg/artifacts/' + artifact['artifactId'] + '?projectId=' + self.document['id'])
        api.handle(handler, 'GET', '/api/pcg/artifacts/' + artifact['artifactId'])
        self.assertEqual(handler.response[0], 400)
        self.nodes[2]['data']['descriptorId'] = 'refmuse.pcg.game_asset'
        self.document = self.store.get(self.document['id'])
        self.document['canvas']['nodes'] = [self.nodes[2]]; self.document['canvas']['edges'] = []
        self.document = self.store.save(self.document['id'], self.document, self.document['revision'])
        self.identity.update(revision=self.document['revision'], runId='m3-unavailable')
        with self.assertRaises(PCGError) as caught: self.runtime.preflight(self.identity)
        self.assertEqual(caught.exception.code, 'M3_BRIDGE_UNAVAILABLE')
        unavailable = self.execute()
        self.assertEqual(unavailable['error']['code'], 'M3_BRIDGE_UNAVAILABLE')

    def test_stage_preview_budget_fails_before_publication(self):
        self.require_boundary()
        with mock.patch('pcg_preview.render_preview_svg', return_value=b'x' * (8 * 1024 * 1024 + 1)):
            task = self.execute()
        self.assertEqual(task['status'], 'failed', task)
        self.assertEqual(task['error']['code'], 'BUDGET_EXCEEDED')
        self.assertEqual(self.runtime.assets.records, {})
        self.assertIsNone(task['result'])

    def test_final_preview_reuses_budgeted_target_stage_bytes(self):
        self.require_boundary()
        from pcg_preview import render_preview_svg
        with mock.patch('pcg_preview.render_preview_svg', wraps=render_preview_svg) as renderer:
            task = self.execute()
        self.assertEqual(task['status'], 'succeeded', task)
        self.assertEqual(renderer.call_count, 3)
        final = next(a for a in task['result']['assets'] if a['format'] == 'svg')
        stage = task['result']['stagePreviews'][-1]['assets'][0]
        self.assertEqual(final, stage)
        body, metadata = self.runtime.download(self.handle(task), final['artifactId'])
        self.assertIn(b'<svg', body)
        self.assertEqual(metadata, final)

    def assert_slots_released(self):
        self.assertTrue(self.runtime.geometry_slot.acquire(blocking=False))
        self.runtime.geometry_slot.release()
        admitted = 0
        try:
            for _ in range(4):
                self.assertTrue(self.runtime.slots.acquire(blocking=False)); admitted += 1
            self.assertFalse(self.runtime.slots.acquire(blocking=False))
        finally:
            for _ in range(admitted): self.runtime.slots.release()

    def test_geometry_executes_one_at_a_time_and_cancel_waiter(self):
        self.require_boundary()
        from pcg_isolation import IsolationError, execute as real_execute
        started = threading.Event(); release = threading.Event(); counter_lock = threading.Lock()
        counters = {'active': 0, 'maximum': 0, 'calls': 0}
        def controlled(request, **kwargs):
            with counter_lock:
                counters['active'] += 1; counters['calls'] += 1
                counters['maximum'] = max(counters['maximum'], counters['active'])
            started.set()
            try:
                while not release.wait(.01):
                    if kwargs['cancelled'](): raise IsolationError('CANCELLED', 'Cancelled test worker')
                return real_execute(request, **kwargs)
            finally:
                with counter_lock: counters['active'] -= 1
        with mock.patch('pcg_isolation.execute', side_effect=controlled):
            first = self.runtime.run(self.identity); self.assertTrue(started.wait(2))
            waiting = self.runtime.run({**self.identity, 'nodeId': 'source', 'runId': 'waiting'})
            third = self.runtime.run({**self.identity, 'nodeId': 'other', 'runId': 'third'})
            self.assertEqual(self.runtime.read(self.handle(waiting))['task']['status'], 'queued')
            self.assertEqual(self.runtime.read(self.handle(third))['task']['status'], 'queued')
            self.runtime.cancel(self.handle(waiting))
            cancelled = self.runtime.wait({**self.handle(waiting), 'timeoutMs': 2000})['task']
            self.assertEqual(cancelled['status'], 'cancelled', cancelled)
            self.assertEqual(counters['calls'], 1)
            self.assertEqual(self.runtime.read(self.handle(first))['task']['status'], 'running')
            self.assertFalse(self.runtime.tasks[first['jobId']]['_cancel'].is_set())
            release.set()
            first = self.runtime.wait({**self.handle(first), 'timeoutMs': 20000})['task']
            third = self.runtime.wait({**self.handle(third), 'timeoutMs': 20000})['task']
        self.assertEqual(first['status'], 'succeeded', first); self.assertEqual(third['status'], 'succeeded', third)
        self.assertEqual(counters, {'active': 0, 'maximum': 1, 'calls': 2})
        self.assert_slots_released()

    def test_close_cancels_active_and_queued_geometry_and_releases_slots(self):
        self.require_boundary()
        from pcg_isolation import IsolationError
        started = threading.Event(); calls = []
        def controlled(request, **kwargs):
            calls.append(request); started.set()
            while not kwargs['cancelled'](): time.sleep(.01)
            raise IsolationError('CANCELLED', 'Host close test worker')
        with mock.patch('pcg_isolation.execute', side_effect=controlled):
            first = self.runtime.run(self.identity); self.assertTrue(started.wait(2))
            waiting = self.runtime.run({**self.identity, 'nodeId': 'other', 'runId': 'waiting-close'})
            self.assertEqual(self.runtime.read(self.handle(waiting))['task']['status'], 'queued')
            self.runtime.close()
        for task in (first, waiting):
            actual = self.runtime.read(self.handle(task))['task']
            self.assertEqual(actual['status'], 'cancelled', actual)
            self.assertTrue(self.runtime.tasks[task['jobId']]['_event'].is_set())
            self.assertFalse(self.runtime.tasks[task['jobId']]['_thread'].is_alive())
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.runtime.active_count(), 0)
        self.assert_slots_released()

    def test_unexpected_host_exception_is_terminal_and_releases_slots(self):
        with mock.patch.object(self.runtime, '_isolation', return_value={'available': True}), \
                mock.patch('pcg_isolation.execute', side_effect=RuntimeError('private request text')):
            task = self.execute()
        self.assertEqual(task['status'], 'failed', task)
        self.assertEqual(task['error']['code'], 'WORKER_CRASH')
        self.assertIn('RuntimeError', task['error']['message'])
        self.assertNotIn('private request text', task['error']['message'])
        self.assertTrue(self.runtime.tasks[task['jobId']]['_event'].is_set())
        self.assertEqual(self.runtime.active_count(), 0)
        self.assert_slots_released()

    def test_retained_graph_errors_timeout_crash_budget_protocol(self):
        self.require_boundary()
        from pcg_isolation import IsolationError
        for index, (injected, expected) in enumerate([('TIMEOUT', 'WORKER_TIMEOUT'), ('WORKER_FAILED', 'WORKER_CRASH'), ('BUDGET_EXCEEDED', 'BUDGET_EXCEEDED')]):
            with mock.patch('pcg_isolation.execute', side_effect=IsolationError(injected, 'Synthetic boundary failure')):
                task = self.execute({**self.identity, 'runId': 'error-' + str(index)})
            self.assertEqual(task['status'], 'failed'); self.assertEqual(task['error']['code'], expected)
            self.assertEqual(self.runtime.read(self.handle(task))['task']['error']['code'], expected)
        for index, response in enumerate((b'[]', b'null', b'{"ok":true,"result":[]}')):
            with mock.patch('pcg_isolation.execute', return_value=response):
                task = self.execute({**self.identity, 'runId': 'protocol-' + str(index)})
            self.assertEqual(task['status'], 'failed', task)
        self.assertEqual(self.runtime.active_count(), 0)


if __name__ == '__main__': unittest.main()
