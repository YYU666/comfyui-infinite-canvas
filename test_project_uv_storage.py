import copy
import json
import unittest
from unittest.mock import patch

from project_uv_storage import (REFERENCE_KEY, STORAGE_KEY,
                                decode_project_json, json_bytes, pack_uv_plans)


class ProjectUVStorageTest(unittest.TestCase):
    def setUp(self):
        self.plan = {'planSha256': 'face', 'overlayAssetPath': 'assets/' + 'a' * 64 + '.bin',
                     'semanticDiagnostics': {'boundary': ['test'] * 80}}
        self.document = {'canvas': {'nodes': [{'type': 'native3d', 'data': {
            'nativeUVPlan': copy.deepcopy(self.plan),
            'metadata': {'uvPlan': copy.deepcopy(self.plan)},
            'nativeOutputRecords': [{'data': {'nativeUVPlan': copy.deepcopy(self.plan)}}],
        }}]}}

    def test_current_and_legacy_are_lossless_and_independently_editable(self):
        compact = pack_uv_plans(self.document)
        self.assertEqual(len(compact[STORAGE_KEY]['plans']), 1)
        self.assertLess(len(json_bytes(compact)), len(json_bytes(self.document)))
        loaded = decode_project_json(json_bytes(compact))
        self.assertEqual(loaded, self.document)
        self.assertEqual(decode_project_json(json_bytes(self.document)), self.document)
        node = loaded['canvas']['nodes'][0]['data']
        node['nativeUVPlan']['semanticDiagnostics']['boundary'].append('edited')
        self.assertEqual(node['metadata']['uvPlan'], self.plan)
        self.assertEqual(node['nativeOutputRecords'][0]['data']['nativeUVPlan'], self.plan)

    def test_different_payloads_and_unrelated_slots_are_not_interned(self):
        data = self.document['canvas']['nodes'][0]['data']
        data['nativeUVPlan']['revision'] = 2
        data['metadata']['uvPlan']['revision'] = 3
        self.assertNotIn(STORAGE_KEY, pack_uv_plans(self.document))

    def test_unwrap_report_is_interned_with_exact_history(self):
        data = self.document['canvas']['nodes'][0]['data']
        unwrap = {'bounds': [42] * 200, 'metadata': {'quality': 'accepted'}}
        data['metadata']['uv'] = copy.deepcopy(unwrap)
        historic = data['nativeOutputRecords'][0]['data']
        historic['metadata'] = {'uv': copy.deepcopy(unwrap)}
        packed = pack_uv_plans(self.document)
        self.assertEqual(len(packed[STORAGE_KEY]['plans']), 2)
        stored = packed['canvas']['nodes'][0]['data']
        self.assertEqual(stored['metadata']['uv'], stored['nativeOutputRecords'][0]['data']['metadata']['uv'])
        self.assertEqual(decode_project_json(json_bytes(packed)), self.document)

    def test_invalid_and_oversized_expansion_rejected(self):
        compact = pack_uv_plans(self.document)
        data = compact['canvas']['nodes'][0]['data']
        with patch('project_uv_storage.MAX_PROJECT_JSON_BYTES', len(json_bytes(compact))):
            with self.assertRaisesRegex(ValueError, 'exceeds'):
                decode_project_json(json_bytes(compact))
        data['nativeUVPlan'] = {REFERENCE_KEY: True}
        with self.assertRaisesRegex(ValueError, 'Invalid UV-plan reference'):
            decode_project_json(json_bytes(compact))

    def test_reserved_storage_field_is_rejected_at_pack(self):
        self.document[STORAGE_KEY] = {}
        with self.assertRaisesRegex(ValueError, 'reserved'):
            pack_uv_plans(self.document)

    def test_storage_backup_restore_and_portable_zip(self):
        import io
        from pathlib import Path
        import tempfile
        import zipfile
        from project_store import ProjectStore

        with tempfile.TemporaryDirectory() as root:
            store = ProjectStore(Path(root) / 'source')
            target = ProjectStore(Path(root) / 'target')
            try:
                doc = store.create('UV plan archive')
                asset = store.put_asset(doc['id'], 'plan.png', io.BytesIO(b'asset fixture'))['asset']
                doc = store.get(doc['id'])
                self.plan['overlayAssetPath'] = asset['path']
                data = self.document['canvas']['nodes'][0]['data']
                data['nativeUVPlan'] = copy.deepcopy(self.plan)
                data['metadata']['uvPlan'] = copy.deepcopy(self.plan)
                data['nativeOutputRecords'][0]['data']['nativeUVPlan'] = copy.deepcopy(self.plan)
                doc['canvas']['nodes'] = [{'id':'native3d-plan','type':'native3d',
                    'position':{'x':0,'y':0},'data':data}]
                from agent_handles import ensure_agent_handles
                ensure_agent_handles(doc)
                doc = store.save(doc['id'], doc, doc['revision'])
                old_revision = doc['revision']
                folder = store.root / doc['name']
                self.assertIn(STORAGE_KEY, json.loads((folder / 'project.json').read_bytes()))
                self.assertEqual(store.get(doc['id'])['canvas'], doc['canvas'])
                unchanged = store.save(doc['id'], doc, doc['revision'], skip_unchanged=True)
                self.assertEqual(unchanged['revision'], old_revision)
                doc['canvas']['viewport']['zoom'] = .6
                doc = store.save(doc['id'], doc, doc['revision'])
                backup = folder / 'backups' / f'project-r{old_revision}.json'
                self.assertIn(STORAGE_KEY, json.loads(backup.read_bytes()))
                restored = store.native3d_backup_fragment(doc['id'], old_revision)
                self.assertEqual(restored['nodes'][0]['data'], data)
                archive = store.export(doc['id'])
                with zipfile.ZipFile(archive) as z:
                    exported = json.loads(z.read('project.json'))
                    self.assertNotIn(STORAGE_KEY, exported)
                    self.assertEqual(exported['canvas'], doc['canvas'])
                    self.assertIn(asset['path'], z.namelist())
                imported = target.import_zip(archive)
                self.assertEqual(imported['canvas'], doc['canvas'])
                self.assertEqual(target.asset_file(imported['id'], asset['path']).read_bytes(), b'asset fixture')
            finally:
                target.close()
                store.close()
