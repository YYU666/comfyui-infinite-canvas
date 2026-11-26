"""CPU-only conditioning-order regression checks; no model/runtime imports."""
import os
import hashlib
import json
from pathlib import Path
import unittest
import numpy as np
import trimesh
from native3d_engine import official_mc_conditioning, official_surface_sample, official_mc_mesh


class ConditioningTest(unittest.TestCase):
    def test_canonical_default_bytes_unchanged(self):
        mesh = trimesh.creation.icosphere(subdivisions=2)
        points, ids = official_surface_sample(mesh, 8192, 0)
        raw = np.concatenate([points, mesh.face_normals[ids]], axis=1, dtype=np.float16)
        p = raw[:, :3]
        center = (p.min(0) + p.max(0)) / 2
        centered = p - center
        radius = np.abs(centered).max()
        expected = np.concatenate([centered / radius * .9995, raw[:, 3:]], axis=1, dtype=np.float16)
        actual, source_center, source_radius, receipt = official_mc_conditioning(mesh, np.array([10., 20., 30.]), 2., 0)
        self.assertEqual(actual.tobytes(), expected.tobytes())
        np.testing.assert_array_equal(source_center, center.astype(float) / 2 + [10, 20, 30])
        self.assertEqual(source_radius, float(radius) / 2)
        self.assertEqual(receipt['conditioningProfile'], 'canonical_safe')

    def test_legacy_rejects_translated_tiny_and_overflow(self):
        mesh = trimesh.creation.icosphere(subdivisions=1)
        for center, scale in ((np.array([100., 100., 100.]), 1e5), (np.array([1e8, 0., 0.]), 1.)):
            with self.subTest(center=center, scale=scale):
                with self.assertRaises(ValueError):
                    official_mc_conditioning(mesh, center, scale, 0, 'legacy_world_fp16')
        # Canonical default keeps the translated tiny input representable.
        pc, _, _, _ = official_mc_conditioning(mesh, np.full(3, 100.), 1e5, 0)
        self.assertTrue(np.isfinite(pc).all())

    def test_profile_unknown_rejected(self):
        with self.assertRaisesRegex(ValueError, 'conditioningProfile'):
            official_mc_conditioning(trimesh.creation.box(), np.zeros(3), 1., 0, 'unknown')

    def test_historical_fixture_byte_exact(self):
        root = Path(os.environ.get('NATIVE3D_HISTORICAL_FIXTURE', str(Path.home() / 'Documents/ChatGPT/UE测试/TopoForge/artifacts/meshanything_official_settings_v1')))
        if not (root / 'processed_mesh_yup.npz').is_file():
            self.skipTest('Optional local historical fixture unavailable')
        with np.load(root / 'processed_mesh_yup.npz') as data:
            mesh = trimesh.Trimesh(data['vertices'], data['faces'], process=False)
        actual, center, radius, receipt = official_mc_conditioning(mesh, np.zeros(3), 1., 0, 'legacy_world_fp16')
        expected = np.load(root / 'inputs/seed0.npy')
        self.assertEqual(actual.tobytes(), expected.tobytes())
        np.testing.assert_array_equal(center, [-.087890625, 3.1953125, -.0634765625])
        self.assertEqual(radius, 6.9609375)
        self.assertLess(receipt['fp16MaxQuantizationExtentRatio'], .001)

    def test_fresh_lossless_sdf_full_legacy_profile_byte_exact(self):
        root = Path(os.environ.get('NATIVE3D_HISTORICAL_FIXTURE', str(Path.home() / 'Documents/ChatGPT/UE测试/TopoForge/artifacts/meshanything_official_settings_v1')))
        fresh = Path(__file__).parent / '.cache/native3d/replay-audit/original-lossless-mc/mc_sdf.npy'
        if not fresh.is_file() or not (root / 'inputs/seed0.npy').is_file():
            self.skipTest('Optional fresh lossless source MC fixture unavailable')
        receipt = json.loads((root.parent / 'meshanything_rock_mc_v1/sdf_input_receipt.json').read_text(encoding='utf-8'))
        center = np.asarray(receipt['to_orig_center'])
        scale = receipt['to_orig_scale']
        sdf = np.load(fresh)
        self.assertEqual(hashlib.sha256(fresh.read_bytes()).hexdigest(),
                         '9d4e3849ecfa157d4f4d218b9f4f052c74067c050696c9c51acbfb4c9c2c363b')
        processed = official_mc_mesh(sdf, center, scale)
        historical = np.load(root / 'processed_mesh_yup.npz')
        np.testing.assert_array_equal(processed.vertices, historical['vertices'])
        np.testing.assert_array_equal(processed.faces, historical['faces'])
        actual, _, _, _ = official_mc_conditioning(processed, center, scale, 0,
            'legacy_world_fp16', source_world=True)
        self.assertEqual(actual.tobytes(), np.load(root / 'inputs/seed0.npy').tobytes())
        self.assertEqual(hashlib.sha256(actual.tobytes()).hexdigest(),
                         '51f3cb917df82716c4bcafb08e2303e1444c7275c1ebac503c7601da15820fe3')


if __name__ == '__main__':
    unittest.main()
