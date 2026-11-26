import json
import unittest
from native3d_uv_evidence import read_face_labels
from native3d_jobs import validate_parameters
from project_store import StoreError


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.value = dict(sourceSha256='a'*64, method='partfield', labels=[0, 1, 1], faceOrderVerified=True)

    def test_exact_binding(self):
        labels, report = read_face_labels(json.dumps(self.value), 'a'*64, 3)
        self.assertEqual(labels, [0, 1, 1])
        self.assertEqual(report['parts'], 2)

    def test_reject_wrong_mesh_count_or_unverified_order(self):
        for sha, count in [('b'*64, 3), ('a'*64, 4)]:
            with self.assertRaises(ValueError): read_face_labels(json.dumps(self.value), sha, count)
        for patch in [dict(faceOrderVerified=False), dict(method='heuristic'), dict(labels=[True, 1, 2]), dict(labels=[-1, 1, 2]), dict(path='C:/elsewhere')]:
            with self.assertRaises(ValueError): read_face_labels(json.dumps({**self.value, **patch}), 'a'*64, 3)

    def test_ao_schema_bounds_and_default(self):
        self.assertEqual(validate_parameters('uv', {})['seamStrategy'], 'structural')
        self.assertEqual(validate_parameters('uv', {'seamStrategy':'ao_geometry'})['aoRaySamples'],32)
        self.assertEqual(validate_parameters('uv', {'seamStrategy':'coherent'})['alignDirection'],'world_up')
        for value in [{'chartMergeCost':21}, {'alignDirection':'arbitrary'}, {'aoRaySamples':129}, {'aoRadiusFraction':0.31}, {'coarseAngleDegrees':float('nan')}, {'segmentationEvidence':'x'*48001}, {'aoDarknessThreshold':-1}]:
            with self.assertRaises(StoreError): validate_parameters('uv', value)

if __name__ == '__main__': unittest.main()
