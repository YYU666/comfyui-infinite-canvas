"""Real GLB delta reconstruction and immutable topology fallback checks."""
import base64
import copy
import hashlib
import json
import struct
import unittest
from unittest import mock

from pcg_contracts import PCGError, canonical
from pcg_export import export_glb
from pcg_geometry import evaluate
from pcg_preview_stream import build_preview, _changes


def metadata(body, name):
    return {'assetId': name, 'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body),
            'url': '/api/assets/' + name + '.glb'}


class PreviewStreamTests(unittest.TestCase):
    def setUp(self):
        self.mesh = evaluate('primitive', {}, {})['geometry']
        self.base = export_glb(self.mesh)

    def preview(self, target, base=None):
        base = self.base if base is None else base
        return build_preview(target, metadata(target, 'target'), base, metadata(base, 'base'))

    def reconstruct(self, base, descriptor, payload):
        self.assertEqual(hashlib.sha256(payload).hexdigest(), descriptor['sha256'])
        data = json.loads(payload); self.assertEqual(payload, canonical(data))
        output = bytearray(base); end = 0
        for change in data['changes']:
            start = change['offset']; body = base64.b64decode(change['base64'], validate=True)
            self.assertGreaterEqual(start, end); end = start + len(body)
            self.assertLessEqual(end, len(output)); output[start:end] = body
        self.assertEqual(len(output), descriptor['targetBytes'])
        self.assertEqual(hashlib.sha256(output).hexdigest(), descriptor['targetSha256'])
        return bytes(output)

    def test_same_topology_mesh_patch_reconstructs_actual_glb(self):
        mesh = copy.deepcopy(self.mesh); mesh['positions'][0][0] += .125
        target = export_glb(mesh); descriptor, payload = self.preview(target)
        self.assertEqual(descriptor['kind'], 'mesh-delta'); self.assertLess(len(payload), len(target))
        self.assertEqual(self.reconstruct(self.base, descriptor, payload), target)
        self.assertNotIn('changes', descriptor)

    def test_stable_instances_reuse_prototype_and_reconstruct(self):
        points = {'contractVersion': 1, 'type': 'PointSet', 'positions': [[0, 0, 0], [2, 0, 0], [4, 0, 0]]}
        instances = evaluate('instance_on_points', {}, {'points': points, 'prototype': self.mesh})['instances']
        left = evaluate('instance_transform', {'translation': [0, .3, 0]}, {'instances': instances})['instances']
        right = evaluate('instance_transform', {'translation': [0, .4, 0]}, {'instances': instances})['instances']
        base = export_glb(left); target = export_glb(right)
        descriptor, payload = self.preview(target, base)
        self.assertEqual(descriptor['kind'], 'instance-delta')
        self.assertEqual(self.reconstruct(base, descriptor, payload), target)

    def mutate_binary(self, accessor_index):
        body = bytearray(self.base); size = struct.unpack_from('<I', body, 12)[0]
        doc = json.loads(body[20:20 + size]); item = doc['accessors'][accessor_index]
        view = doc['bufferViews'][item['bufferView']]
        offset = 28 + size + view.get('byteOffset', 0) + item.get('byteOffset', 0)
        body[offset], body[offset + 4] = body[offset + 4], body[offset]
        # Indices 0 and 1 differ in low byte; swap whole 32-bit elements.
        body[offset:offset + 4], body[offset + 4:offset + 8] = self.base[offset + 4:offset + 8], self.base[offset:offset + 4]
        return bytes(body)

    def test_index_uv_topology_or_length_changes_fall_back(self):
        size = struct.unpack_from('<I', self.base, 12)[0]; doc = json.loads(self.base[20:20 + size])
        primitive = doc['meshes'][0]['primitives'][0]
        target = self.mutate_binary(primitive['indices'])
        descriptor, payload = self.preview(target)
        self.assertEqual(descriptor['kind'], 'snapshot'); self.assertIsNone(payload)
        self.assertEqual(descriptor['reason'], 'immutable-buffer-mismatch')
        body = bytearray(self.base); uv = doc['accessors'][primitive['attributes']['TEXCOORD_0']]
        offset = 28 + size + doc['bufferViews'][uv['bufferView']].get('byteOffset', 0)
        old = struct.unpack_from('<f', body, offset)[0]; struct.pack_into('<f', body, offset, old + .125)
        target = bytes(body)
        descriptor, payload = self.preview(target)
        self.assertEqual(descriptor['kind'], 'snapshot'); self.assertIsNone(payload)
        self.assertEqual(descriptor['reason'], 'immutable-buffer-mismatch')
        sphere = export_glb(evaluate('primitive', {'kind': 'sphere'}, {})['geometry'])
        descriptor, payload = self.preview(sphere)
        self.assertEqual(descriptor['kind'], 'snapshot'); self.assertIsNone(payload)

    def test_missing_base_hash_mismatch_size_budget_and_coalescing(self):
        descriptor, payload = build_preview(self.base, metadata(self.base, 'target'))
        self.assertEqual(descriptor['reason'], 'base-unavailable'); self.assertIsNone(payload)
        bad = metadata(self.base, 'target'); bad['sha256'] = 'f' * 64
        with self.assertRaises(PCGError): build_preview(self.base, bad)
        mesh = copy.deepcopy(self.mesh); mesh['positions'][0][0] += .125
        changed = export_glb(mesh)
        with mock.patch('pcg_preview_stream.MAX_PREVIEW_BYTES', 1):
            descriptor, payload = self.preview(changed)
            self.assertEqual(descriptor['reason'], 'patch-byte-budget'); self.assertIsNone(payload)
        changes = _changes(b'a' * 100, b'b' + b'a' * 15 + b'b' + b'a' * 83)
        self.assertEqual(len(changes), 1); self.assertEqual(len(base64.b64decode(changes[0]['base64'])), 17)

    def test_identical_content_returns_snapshot_without_empty_patch(self):
        descriptor, payload = self.preview(self.base)
        self.assertEqual(descriptor['kind'], 'snapshot'); self.assertEqual(descriptor['reason'], 'identical-content')
        self.assertIsNone(payload)

    def test_aliased_uv_view_cannot_smuggle_topology_changes(self):
        size = struct.unpack_from('<I', self.base, 12)[0]; doc = json.loads(self.base[20:20 + size])
        attrs = doc['meshes'][0]['primitives'][0]['attributes']
        uv = doc['accessors'][attrs['TEXCOORD_0']]; position = doc['accessors'][attrs['POSITION']]
        doc['bufferViews'][uv['bufferView']]['byteOffset'] = doc['bufferViews'][position['bufferView']]['byteOffset']
        data = canonical(doc); data += b' ' * (-len(data) % 4)
        tail = self.base[20 + size:]
        base = struct.pack('<4sII', b'glTF', 2, 20 + len(data) + len(tail)) + struct.pack('<I4s', len(data), b'JSON') + data + tail
        target = bytearray(base); offset = 28 + len(data)
        old = struct.unpack_from('<f', target, offset)[0]; struct.pack_into('<f', target, offset, old + .125)
        descriptor, payload = self.preview(bytes(target), base)
        self.assertEqual(descriptor['kind'], 'snapshot'); self.assertIsNone(payload)
        self.assertEqual(descriptor['reason'], 'immutable-buffer-mismatch')


if __name__ == '__main__': unittest.main()
