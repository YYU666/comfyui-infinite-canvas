"""Immutable GLB/JSON host publication with path and handle isolation."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from pcg_assets import GeometryAssetBroker
from pcg_contracts import PCGError, parse_json
from project_store import ProjectStore


class GeometryAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.store = ProjectStore(Path(self.temp.name) / 'projects')
        self.document = self.store.create('Synthetic'); self.broker = GeometryAssetBroker(self.store)
        self.task = {'projectId': self.document['id'], 'nodeId': 'mesh', 'revision': 1, 'descriptorVersion': 1, 'operationVersion': 1, 'runId': 'run', 'jobId': 'pcg_fixture', 'inputHash': 'a' * 64}
        self.value = {'contractVersion': 1, 'type': 'Mesh', 'positions': [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 'triangles': [[0, 1, 2]], 'normals': [], 'uvs': []}

    def tearDown(self): self.store.close(); self.temp.cleanup()

    def test_real_content_hash_job_owned_immutable_exports(self):
        glb = self.broker.publish(self.task, 'geometry', self.value, 'glb')
        body, _ = self.broker.read(self.task, glb['artifactId'])
        self.assertEqual(body[:4], b'glTF'); self.assertEqual(glb['sha256'], hashlib.sha256(body).hexdigest())
        self.assertEqual(glb, self.broker.publish(self.task, 'geometry', self.value, 'glb'))
        record = self.broker.publish(self.task, 'geometry', self.value, 'json')
        raw, _ = self.broker.read(self.task, record['artifactId']); self.assertEqual(parse_json(raw), self.value)
        self.assertNotIn('path', glb); self.assertIn('/api/pcg/artifacts/', glb['url']); self.assertEqual(glb['role'], 'model')
        with self.assertRaises(PCGError): self.broker.read({**self.task, 'runId': 'other'}, glb['artifactId'])
        with self.assertRaises(PCGError): self.broker.read(self.task, '../secret')
        target = self.broker.records[glb['artifactId']]['path']; target.write_bytes(body[:-1] + b'x')
        with self.assertRaises(PCGError) as caught: self.broker.read(self.task, glb['artifactId'])
        self.assertEqual(caught.exception.code, 'ASSET_HASH_MISMATCH')


if __name__ == '__main__': unittest.main()
