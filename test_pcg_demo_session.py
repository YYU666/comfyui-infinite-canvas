"""Synthetic isolated demo sessions and adversarial approved-import fixtures."""
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from unittest import mock

from pcg_contracts import PCGError, canonical
from pcg_demo_session import DemoSession, _glb_summary
from pcg_geometry import evaluate, summarize
from pcg_export import export_glb


def fixture_evidence(root, body=None):
    value = evaluate('primitive', {}, {})['geometry']; body = body or export_glb(value)
    sha = hashlib.sha256(body).hexdigest(); asset = root / 'approved.glb'; asset.write_bytes(body)
    handle = {'projectId': 'prj_fixture', 'nodeId': 'sphere', 'revision': 1, 'descriptorVersion': 1,
              'operationVersion': 1, 'runId': 'fixture-run', 'jobId': 'pcg_fixture', 'inputHash': 'a' * 64}
    artifact = {'artifactId': 'pcga_fixture', 'sha256': sha, 'format': 'glb', 'producerNodeId': 'sphere', 'summary': summarize(value),
                **{k: handle[k] for k in ('jobId', 'runId', 'inputHash', 'projectId', 'revision')}}
    evidence = {'runs': [{'name': 'Synthetic approved evidence', 'handle': handle, 'result': {'assets': [artifact]},
                          'assetsLocal': [{'path': str(asset), 'format': 'glb', 'sha256': sha, 'bytes': len(body)}]}]}
    (root / 'EVIDENCE.json').write_bytes(canonical(evidence)); return evidence, asset


def rewrite(root, evidence): (root / 'EVIDENCE.json').write_bytes(canonical(evidence))


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.session = DemoSession(self.root / 'service')
    def tearDown(self): self.session.close(); self.temp.cleanup()
    def boundary(self):
        if not self.session.runtime._isolation()['available']: self.skipTest('Native OS boundary unavailable; session fails closed.')
    def terminal(self, timeout=25):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            state = self.session.snapshot()
            if state['run'] and state['run']['status'] in {'succeeded', 'failed', 'cancelled'}: return state
            time.sleep(.01)
        self.fail('Session did not reach a terminal state.')

    def registered_asset(self):
        samples = self.root / 'samples'; samples.mkdir()
        fixture_evidence(samples); self.session._import_samples(samples)
        return self.session.snapshot()['desired']['assetId']

    def blocked_preview(self, asset_id, patch_target, action, expected_code=None, base_id=None):
        entered, release, control_done = threading.Event(), threading.Event(), threading.Event()
        errors, results = [], []
        import pcg_demo_session
        import pcg_preview_stream
        original = (pcg_demo_session._safe_read if patch_target.endswith('_safe_read')
                    else pcg_preview_stream.build_preview)
        def slow(*args, **kwargs):
            entered.set()
            if not release.wait(5): raise AssertionError('Control did not release test work')
            return original(*args, **kwargs)
        def preview():
            try: results.append(self.session.preview(asset_id, base_id or asset_id))
            except BaseException as error: errors.append(error)
        def control():
            try: action()
            except BaseException as error: errors.append(error)
            finally: control_done.set()
        with mock.patch(patch_target, side_effect=slow):
            worker = threading.Thread(target=preview); worker.start()
            observer = None
            try:
                self.assertTrue(entered.wait(2))
                observer = threading.Thread(target=control); observer.start()
                self.assertTrue(control_done.wait(2), 'Preview work held the session control lock')
            finally:
                release.set(); worker.join(3)
                if observer: observer.join(3)
        self.assertFalse(worker.is_alive())
        if observer: self.assertFalse(observer.is_alive())
        if expected_code is None:
            self.assertEqual(errors, []); self.assertEqual(len(results), 1)
        else:
            self.assertEqual(results, []); self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], PCGError); self.assertEqual(errors[0].code, expected_code)
            self.assertEqual(self.session.preview_descriptors, {})
            self.assertEqual(self.session.previews, {})

    def test_slow_asset_read_does_not_block_wait_snapshot_or_cancel(self):
        asset = self.registered_asset()
        with self.session.lock:
            self.session.run = {'runId': 'test-run', 'status': 'running', 'currentTask': None}
        def controls():
            state = self.session.snapshot()
            self.session.wait(state['eventCursor'], 0)
            self.assertEqual(self.session.cancel('test-run')['run']['status'], 'cancelling')
        self.blocked_preview(asset, 'pcg_demo_session._safe_read', controls)

    def test_slow_preview_build_does_not_block_wait_snapshot_or_cancel(self):
        asset = self.registered_asset()
        with self.session.lock:
            self.session.run = {'runId': 'test-run', 'status': 'running', 'currentTask': None}
        def controls():
            state = self.session.snapshot()
            self.session.wait(state['eventCursor'], 0)
            self.assertEqual(self.session.cancel('test-run')['run']['status'], 'cancelling')
        self.blocked_preview(asset, 'pcg_preview_stream.build_preview', controls)

    def test_preview_close_rejects_late_computed_descriptor(self):
        asset = self.registered_asset()
        self.blocked_preview(asset, 'pcg_preview_stream.build_preview', self.session.close, 'SESSION_CLOSED')

    def test_asset_close_rejects_late_file_read(self):
        asset = self.registered_asset()
        self.blocked_preview(asset, 'pcg_demo_session._safe_read', self.session.close, 'SESSION_CLOSED')

    def test_asset_path_change_rejects_late_file_read(self):
        asset = self.registered_asset()
        def change():
            with self.session.lock:
                self.session.records[asset] = self.root / 'unapproved.glb'
        self.blocked_preview(asset, 'pcg_demo_session._safe_read', change, 'ASSET_CHANGED')

    def test_preview_catalog_change_rejects_late_computed_descriptor(self):
        asset = self.registered_asset()
        def change():
            with self.session.lock:
                self.session.catalog[asset] = {**self.session.catalog[asset], 'sha256': 'f' * 64}
        self.blocked_preview(asset, 'pcg_preview_stream.build_preview', change, 'ASSET_CHANGED')

    def test_preview_path_change_rejects_late_computed_descriptor(self):
        asset = self.registered_asset()
        def change():
            with self.session.lock:
                self.session.records[asset] = self.root / 'unapproved.glb'
        self.blocked_preview(asset, 'pcg_preview_stream.build_preview', change, 'ASSET_CHANGED')

    def test_preview_base_path_change_rejects_late_computed_descriptor(self):
        asset = self.registered_asset(); body, meta = self.session.read_asset(asset)
        source = {**copy.deepcopy(meta['sourceIdentity']), 'evidenceRun': 'base-fixture'}
        base = self.session._register(body, summarize(evaluate('primitive', {}, {})['geometry']), source,
                                      meta['producerNodeId'], meta['runId'], meta['jobId'], meta['inputHash'], 'base-fixture')['assetId']
        self.assertNotEqual(base, asset)
        def change():
            with self.session.lock:
                self.session.records[base] = self.root / 'unapproved.glb'
        self.blocked_preview(asset, 'pcg_preview_stream.build_preview', change, 'ASSET_CHANGED', base_id=base)

    def test_real_incremental_geometry_and_field_stages(self):
        self.boundary(); initial = self.session.start(seed=11)
        run_id = initial['run']['runId']; observed_intermediate = False; sequence = []
        until = time.monotonic() + 25
        while time.monotonic() < until:
            state = self.session.snapshot()
            if state['desired'] and state['run']['status'] == 'running': observed_intermediate = True
            if state['desired'] and (not sequence or sequence[-1] != state['desired']['producerNodeId']): sequence.append(state['desired']['producerNodeId'])
            if state['run']['status'] in {'succeeded', 'failed', 'cancelled'}: break
            time.sleep(.005)
        self.assertEqual(state['run']['status'], 'succeeded', state['run'])
        self.assertTrue(observed_intermediate, 'First geometry must arrive while later stages still run.')
        self.assertEqual(len(state['run']['completedStages']), 7)
        self.assertEqual([a['producerNodeId'] for a in state['catalog']], ['sphere', 'displace', 'normals', 'publish'])
        self.assertEqual(state['desired']['producerNodeId'], 'publish')
        for stage in state['run']['completedStages']:
            self.assertEqual(stage['handle']['nodeId'], stage['nodeId'])
            if stage['nodeId'] in {'position', 'noise', 'multiply'}:
                self.assertEqual(stage['assetIds'], []); self.assertIsNotNone(stage['associatedAssetId'])
                self.assertLessEqual(len(stage['outputs']['field']['sample']), 64)
        for asset in state['catalog']:
            body, metadata = self.session.read_asset(asset['assetId'])
            self.assertEqual(body[:4], b'glTF'); self.assertEqual(hashlib.sha256(body).hexdigest(), metadata['sha256'])
            self.assertEqual(metadata['runId'], run_id)
            self.assertEqual(metadata['sourceIdentity']['handle']['jobId'], metadata['jobId'])
        self.assertTrue(any(s['cacheHits'] for s in state['run']['completedStages'][1:]))
        self.assertEqual(state['graph']['nodes'][0]['id'], 'sphere')
        text = json.dumps(state); self.assertNotIn(str(self.root), text); self.assertNotIn('assetPath', text)

    def test_real_scatter_failure_preserves_successful_geometry_and_identity(self):
        self.boundary(); self.session.start(recipe='scatter', seed=13, count=3, minDistance=100)
        state = self.terminal()
        self.assertEqual(state['run']['status'], 'failed', state['run'])
        self.assertEqual(state['run']['error']['code'], 'INSUFFICIENT_PLACEMENT')
        self.assertEqual(state['run']['currentNodeId'], 'points')
        self.assertEqual(state['desired']['producerNodeId'], 'publish')
        self.assertEqual(len(state['run']['completedStages']), 8)
        body, _ = self.session.read_asset(state['desired']['assetId']); self.assertEqual(body[:4], b'glTF')
        self.assertTrue(any(e['kind'] == 'run-failed' for e in state['events']))

    def test_real_manual_selection_epoch_and_cancellation_busy_oldrun(self):
        self.boundary(); first = self.session.start(recipe='scatter', seed=7, count=1000, minDistance=.001)
        old_run = first['run']['runId']; until = time.monotonic() + 15
        while time.monotonic() < until:
            state = self.session.snapshot()
            if state['catalog'] and state['run']['status'] == 'running': break
            time.sleep(.005)
        asset = state['catalog'][0]; epoch = state['selectionEpoch']
        selected = self.session.select(asset['assetId'])
        self.assertGreater(selected['selectionEpoch'], epoch); self.assertFalse(selected['autoFollow'])
        with self.assertRaises(PCGError) as caught: self.session.start()
        self.assertEqual(caught.exception.code, 'SESSION_BUSY')
        requested = self.session.cancel(old_run); self.assertIn(requested['run']['status'], {'cancelling', 'cancelled'})
        state = self.terminal(); self.assertEqual(state['run']['status'], 'cancelled', state['run'])
        self.assertEqual(state['desired']['assetId'], asset['assetId'])
        next_run = self.session.start(seed=3); self.assertTrue(next_run['autoFollow'])
        with self.assertRaises(PCGError) as caught: self.session.cancel(old_run)
        self.assertEqual(caught.exception.code, 'STALE_RUN')
        self.session.cancel(next_run['run']['runId']); self.assertEqual(self.terminal()['run']['status'], 'cancelled')

    def test_fail_closed_and_unknown_public_inputs(self):
        with mock.patch.object(self.session.runtime, '_isolation', return_value={'available': False}):
            self.session.start(); state = self.terminal()
        self.assertEqual(state['run']['status'], 'failed'); self.assertEqual(state['run']['error']['code'], 'ISOLATION_UNAVAILABLE')
        self.assertIsNone(state['desired'])
        for params in ({'recipe': 'script'}, {'seed': True}, {'roughness': float('nan')}, {'roughness': .41},
                       {'count': 1001}, {'count': 0}, {'minDistance': -1}, {'minDistance': 1001}):
            with self.assertRaises(PCGError): self.session.start(**params)
        for callback in (lambda: self.session.select('../secret'), lambda: self.session.read_asset('https://invalid'), lambda: self.session.cancel('old-run')):
            with self.assertRaises(PCGError): callback()

    def test_real_scatter_success_instances_and_close_cancellation(self):
        self.boundary(); self.session.start(recipe='scatter', count=5)
        state = self.terminal(); self.assertEqual(state['run']['status'], 'succeeded', state['run'])
        self.assertEqual(state['desired']['geometryType'], 'InstanceSet'); self.assertEqual(state['desired']['counts']['Instance'], 5)
        body, _ = self.session.read_asset(state['desired']['assetId'])
        self.assertEqual(_glb_summary(body)['counts']['Instance'], 5)
        self.session.start(seed=12); self.session.close()
        state = self.session.snapshot(); self.assertTrue(state['closed']); self.assertEqual(state['run']['status'], 'cancelled')
        self.assertFalse(self.session._thread.is_alive())

    def test_cursor_wait_gap_reset_timeout_and_snapshot_binding(self):
        state = self.session.snapshot()
        self.assertEqual(state['graphRevision'], self.session.document['revision'])
        self.assertEqual(state['graphHash'], hashlib.sha256(canonical(state['graph'])).hexdigest())
        result = self.session.wait(afterSequence=0, timeoutMs=1)
        self.assertFalse(result['reset']); self.assertEqual(result['events'], [])
        output = []
        waiter = threading.Thread(target=lambda: output.append(self.session.wait(afterSequence=0, timeoutMs=1000)))
        waiter.start()
        with self.session.lock: self.session._event('test-notification')
        waiter.join(timeout=2); self.assertFalse(waiter.is_alive())
        self.assertEqual(output[0]['events'][0]['sequence'], 1)
        for _ in range(270):
            with self.session.lock: self.session._event('test-overflow')
        result = self.session.wait(afterSequence=1, timeoutMs=0)
        self.assertTrue(result['reset']); self.assertEqual(len(result['events']), 256)
        self.assertEqual(result['cursor'], result['snapshot']['eventCursor'])
        result['snapshot']['graph']['nodes'].append({'bad': True})
        self.assertEqual(self.session.snapshot()['graph']['nodes'], [])
        self.assertTrue(self.session.wait(afterSequence=999, timeoutMs=0)['reset'])
        for params in ({'timeoutMs': 20001}, {'afterSequence': -1}, {'afterSequence': True}):
            with self.assertRaises(PCGError): self.session.wait(**params)

    def test_tune_saves_actual_graph_revision_and_executes_final_target(self):
        # Isolate admission/identity from OS process support; no fabricated geometry or performance evidence.
        with mock.patch.object(self.session, '_execute'):
            first = self.session.start(recipe='scatter', seed=4, count=5)
            self.session._thread.join()
            with self.session.lock: self.session.run['status'] = 'succeeded'
            run_id = first['run']['runId']; old_revision = first['graphRevision']
            for values in ({'script': 'x'}, {'translateY': float('nan')}, {'translateY': 101}, {'translateY': -101},
                           {'seed': True}, {'count': 1001}, {'count': 0}, {'roughness': .41}, {'minDistance': 1001}, {}):
                with self.assertRaises(PCGError): self.session.tune(run_id, values)
            tuned = self.session.tune(run_id, {'translateY': .4}); self.session._thread.join()
            self.assertGreater(tuned['graphRevision'], old_revision)
            self.assertEqual(tuned['graphRevision'], self.session.store.get(tuned['projectId'])['revision'])
            self.assertEqual(tuned['graph']['nodes'][-1]['data']['parameters']['translation'], [0, .4, 0])
            self.assertEqual(tuned['run']['stageCount'], 1)
            self.assertEqual(self.session._execute.call_args.args[1][0]['id'], 'instance-transform')
            self.assertEqual(tuned['run']['graphHash'], tuned['graphHash'])
            self.assertEqual(tuned['events'][-2]['kind'], 'graph-saved')
            with self.assertRaises(PCGError): self.session.tune(run_id, {'translateY': .5})

    def test_real_tune_translation_uses_actual_m2_cache(self):
        self.boundary(); self.session.start(recipe='scatter', count=5)
        before = self.terminal(timeout=60); self.assertEqual(before['run']['status'], 'succeeded')
        self.session.tune(before['run']['runId'], {'translateY': .4})
        after = self.terminal(timeout=60); self.assertEqual(after['run']['status'], 'succeeded', after['run'])
        stages = after['run']['completedStages']; self.assertEqual(len(stages), 1)
        self.assertEqual(stages[0]['computedNodes'], ['instance-transform'])
        self.assertEqual(stages[0]['dirtyNodes'], ['instance-transform'])
        self.assertIn('instances', stages[0]['cacheHits'])
        descriptor = self.session.preview(after['desired']['assetId'], before['desired']['assetId'])
        if descriptor['kind'] != 'snapshot':
            payload = self.session.read_preview(descriptor['sha256'])
            self.assertEqual(hashlib.sha256(payload).hexdigest(), descriptor['sha256'])
        for item in [after['run'], stages[0], after['desired'], after['events'][-1]]:
            self.assertEqual(item['graphRevision'], after['graphRevision'])
            self.assertEqual(item['projectId'], after['projectId'])
            self.assertEqual(item['graphHash'], after['graphHash'])

    def test_preview_pair_cache_reuses_builder_but_hash_checks_both_files(self):
        samples = self.root / 'approved-samples'; samples.mkdir()
        evidence, _ = fixture_evidence(samples); self.session._import_samples(samples)
        base = self.session.snapshot()['desired']
        value = evaluate('primitive', {}, {})['geometry']; value['positions'][0][0] += .125
        handle = evidence['runs'][0]['handle']
        target = self.session._register(export_glb(value), summarize(value),
            {'kind': 'm2-evidence', 'handle': handle, 'artifactId': 'pcga_target'},
            'sphere', handle['runId'], handle['jobId'], handle['inputHash'], 'target')
        from pcg_preview_stream import build_preview
        with mock.patch('pcg_preview_stream.build_preview', wraps=build_preview) as builder:
            first = self.session.preview(target['assetId'], base['assetId'])
            second = self.session.preview(target['assetId'], base['assetId'])
            self.assertEqual(first, second); self.assertEqual(builder.call_count, 1)
            second['kind'] = 'changed-returned-copy'
            self.assertEqual(self.session.preview(target['assetId'], base['assetId']), first)
            self.assertEqual(builder.call_count, 1)
            for asset in (base, target):
                path = self.session.records[asset['assetId']]; original = path.read_bytes()
                path.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
                with self.assertRaises(PCGError) as caught: self.session.preview(target['assetId'], base['assetId'])
                self.assertEqual(caught.exception.code, 'ASSET_HASH_MISMATCH')
                path.write_bytes(original)
            self.assertEqual(builder.call_count, 1)
        self.assertLessEqual(len(self.session.preview_descriptors), 512)
        with mock.patch('pcg_demo_session.MAX_CATALOG', 2):
            self.session.preview(base['assetId'])
            self.session.preview(target['assetId'])
            self.session.preview(base['assetId'], base['assetId'])
            self.assertEqual(len(self.session.preview_descriptors), 2)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name); self.samples = self.root / 'samples'; self.samples.mkdir()
        self.evidence, self.asset = fixture_evidence(self.samples); self.session = None
    def tearDown(self):
        if self.session: self.session.close()
        self.temp.cleanup()
    def make(self): self.session = DemoSession(self.root / ('service-' + str(time.monotonic_ns())), self.samples); return self.session

    def test_approved_import_copies_verified_bytes_and_readback_is_immutable(self):
        session = self.make(); state = session.snapshot(); self.assertEqual(len(state['catalog']), 1)
        metadata = state['catalog'][0]; self.assertEqual(metadata['sourceIdentity']['kind'], 'm2-evidence')
        body, _ = session.read_asset(metadata['assetId']); self.assertEqual(body, self.asset.read_bytes())
        self.asset.write_bytes(b'changed source after import')
        self.assertEqual(session.read_asset(metadata['assetId'])[0], body)
        state['desired']['bounds']['min'][0] = -999
        self.assertNotEqual(session.snapshot()['desired']['bounds']['min'][0], -999)
        session.records[metadata['assetId']].write_bytes(body[:-1] + b'x')
        with self.assertRaises(PCGError) as caught: session.read_asset(metadata['assetId'])
        self.assertEqual(caught.exception.code, 'ASSET_HASH_MISMATCH')

    def test_restarted_owned_cache_counts_prior_immutable_bytes(self):
        session = self.make(); directory = session.root
        metadata = session.snapshot()['catalog'][0]; session.close(); self.session = None
        second = DemoSession(directory, self.samples); self.session = second
        self.assertEqual(sum(second.unique_bytes.values()), metadata['bytes'])
        self.assertEqual(len(second.snapshot()['catalog']), 1)
        second.close(); self.session = None
        with mock.patch('pcg_demo_session.MAX_CACHE_BYTES', metadata['bytes'] - 1):
            with self.assertRaises(PCGError) as caught: DemoSession(directory)
            self.assertEqual(caught.exception.code, 'CATALOG_CAPACITY')

    def test_escape_hash_hardlink_and_evidence_identity_rejected(self):
        original = copy.deepcopy(self.evidence)
        for mutate in (lambda e: e['runs'][0]['assetsLocal'][0].update(path='../outside.glb'),
                       lambda e: e['runs'][0]['assetsLocal'][0].update(sha256='f' * 64),
                       lambda e: e['runs'][0]['result']['assets'][0].update(jobId='wrong-job')):
            current = copy.deepcopy(original); mutate(current); rewrite(self.samples, current)
            with self.assertRaises(PCGError): self.make()
        rewrite(self.samples, original)
        link = self.root / 'hardlink.glb'; os.link(self.asset, link)
        with self.assertRaises(PCGError): self.make()

    def test_absolute_escape_and_actual_import_hash_change_rejected(self):
        outside = self.root / 'outside.glb'; outside.write_bytes(self.asset.read_bytes())
        evidence = copy.deepcopy(self.evidence); evidence['runs'][0]['assetsLocal'][0]['path'] = str(outside)
        rewrite(self.samples, evidence)
        with self.assertRaises(PCGError) as caught: self.make()
        self.assertEqual(caught.exception.code, 'ASSET_PATH_FORBIDDEN')
        rewrite(self.samples, self.evidence)
        body = self.asset.read_bytes(); self.asset.write_bytes(body[:-1] + b'x')
        with self.assertRaises(PCGError) as caught: self.make()
        self.assertEqual(caught.exception.code, 'ASSET_HASH_MISMATCH')
        with self.assertRaises(PCGError): DemoSession(Path('//unapproved-server/share/session'))

    def test_symlink_import_rejected_when_supported(self):
        original = self.asset.with_suffix('.original'); self.asset.rename(original)
        try: self.asset.symlink_to(original)
        except OSError: original.rename(self.asset); self.skipTest('Symlink creation requires unavailable privilege.')
        with self.assertRaises(PCGError): self.make()

    def test_glb_external_resource_and_truncated_binary_rejected(self):
        raw = self.asset.read_bytes(); size = struct.unpack_from('<I', raw, 12)[0]
        document = json.loads(raw[20:20 + size]); document['buffers'][0]['uri'] = 'https://invalid/model.bin'
        data = canonical(document); data += b' ' * (-len(data) % 4)
        body = struct.pack('<4sII', b'glTF', 2, 20 + len(data) + len(raw[20 + size:])) + struct.pack('<I4s', len(data), b'JSON') + data + raw[20 + size:]
        evidence, self.asset = fixture_evidence(self.samples, body)
        with self.assertRaises(PCGError) as caught: self.make()
        self.assertEqual(caught.exception.code, 'GLB_EXTERNAL_RESOURCE')
        for body in (raw[:-1], b'glTF' + b'\x00' * 20):
            with self.assertRaises(PCGError): _glb_summary(body)

    def test_catalog_and_unique_byte_caps_fail_closed(self):
        with mock.patch('pcg_demo_session.MAX_CATALOG', 0):
            with self.assertRaises(PCGError) as caught: self.make()
            self.assertEqual(caught.exception.code, 'CATALOG_CAPACITY')
        with mock.patch('pcg_demo_session.MAX_CACHE_BYTES', 1):
            with self.assertRaises(PCGError) as caught: self.make()
            self.assertEqual(caught.exception.code, 'CATALOG_CAPACITY')


if __name__ == '__main__': unittest.main()
