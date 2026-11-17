"""Synthetic isolated demo sessions and adversarial approved-import fixtures."""
import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
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
        self.boundary(); first = self.session.start(recipe='scatter', seed=7, count=2000, minDistance=.001)
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
        for params in ({'recipe': 'script'}, {'seed': True}, {'roughness': float('nan')}, {'count': 10001}, {'minDistance': -1}):
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
