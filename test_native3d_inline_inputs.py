import copy
import unittest
from unittest.mock import patch
import test_native3d_jobs as fixtures
from project_store import StoreError


class InlineInputTests(unittest.TestCase):
    setUp = fixtures.Native3DJobsTests.setUp
    tearDown = fixtures.Native3DJobsTests.tearDown

    def fixture(self, status='blocked'):
        job_id = 'n3d_' + 'd' * 32
        self.jobs.jobs[job_id] = {'id': job_id, 'projectId': self.doc['id'], 'nodeId': 'producer',
            'status': 'succeeded', 'operation': 'repair_lod', 'opId': 'prior',
            'result': {'metadata': {'geometry': {'status': status}},
                       'files': [{'name': 'model.obj', 'role': 'model', 'sha256': self.asset['sha256']}]}}
        output = {'operation': 'analyze', 'status': 'completed', 'sourceJobId': job_id,
                  'sourceNodeId': 'producer', 'assetPath': self.asset['path'],
                  'nativeGeometryProvenance': True,
                  'metadata': {'operation': 'repair_lod', 'geometry': {'status': status}}}
        record = {'schemaVersion': 1, 'recordId': 'native3d-result-' + job_id, 'jobId': job_id, 'data': output}
        document = self.store.get(self.doc['id'])
        document['canvas'] = {'nodes': [{'id': 'producer', 'type': 'native3d', 'data': {
            'operation': 'repair_lod', 'resultAssetPath': 'assets/' + 'f' * 64 + '.obj',
            'nativeCurrentOutputId': 'newer-record', 'nativeOutputRecords': [record]}}], 'edges': []}
        return document, record

    def test_historical_blocked_output_preflight_not_only_current_pointer(self):
        document, record = self.fixture()
        self.payload.update(operation='uv', parameters={'externalGeometryReviewed': True})
        with patch.object(self.store, 'get', return_value=document), self.assertRaises(StoreError) as error:
            self.jobs.submit(self.payload)
        self.assertEqual(error.exception.code, 'GEOMETRY_BLOCKED')
        self.assertEqual(list(self.jobs._canvas_source_records(document, self.asset['path'])), [record['data']])
        self.assertEqual(len(self.jobs.jobs), 1)

    def test_valid_accepted_record_enumerated_without_mutating_snapshot(self):
        document, record = self.fixture('accepted')
        before = copy.deepcopy(document)
        self.assertEqual(list(self.jobs._canvas_source_records(document, self.asset['path'])), [record['data']])
        self.assertEqual(document, before)

    def test_tampered_identity_or_unregistered_output_fails_closed(self):
        for field in ('schemaVersion', 'jobId', 'sourceJobId', 'sourceNodeId', 'projectId', 'sha256'):
            with self.subTest(field=field):
                document, record = self.fixture('accepted')
                if field in ('schemaVersion', 'jobId'): record[field] = 'wrong'
                elif field in ('sourceJobId', 'sourceNodeId'): record['data'][field] = 'wrong'
                elif field == 'projectId': self.jobs.jobs[record['jobId']]['projectId'] = 'other'
                else: self.jobs.jobs[record['jobId']]['result']['files'][0]['sha256'] = '0' * 64
                with self.assertRaises(StoreError) as error:
                    list(self.jobs._canvas_source_records(document, self.asset['path']))
                self.assertEqual(error.exception.code, 'GEOMETRY_BLOCKED')

    def test_accepted_canvas_label_does_not_override_authoritative_geometry(self):
        document, record = self.fixture()
        record['data']['metadata']['geometry']['status'] = 'accepted'
        self.payload.update(operation='uv', parameters={'externalGeometryReviewed': True})
        with patch.object(self.store, 'get', return_value=document), self.assertRaises(StoreError) as error:
            self.jobs.submit(self.payload)
        self.assertEqual(error.exception.code, 'GEOMETRY_BLOCKED')


if __name__ == '__main__':
    unittest.main()
