import tempfile
import unittest
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from native3d_highpoly import FACE_LIMIT, derive_shared_lods, repair_high, topology_report
from native3d_jobs import validate_parameters
from native3d_material_atlas import texture_qc_warnings, write_packed_maps


def _grid(n=8):
    vertices, uv, faces = [], [], []
    for y in range(n + 1):
        for x in range(n + 1):
            vertices.append((x, y, 0.0))
            uv.append((x / n, y / n))
    def index(x, y):
        return y * (n + 1) + x
    for y in range(n):
        for x in range(n):
            a, b, c, d = index(x, y), index(x + 1, y), index(x + 1, y + 1), index(x, y + 1)
            faces.append((a, b, c))
            faces.append((a, c, d))
    mesh = trimesh.Trimesh(np.array(vertices, dtype=float), np.array(faces, dtype=int), process=False)
    mesh.visual = trimesh.visual.TextureVisuals(uv=np.array(uv, dtype=float), material=trimesh.visual.material.PBRMaterial(roughnessFactor=0.8, metallicFactor=0.0))
    return mesh


def _dirty_box():
    box = trimesh.creation.box()
    vertices = np.array(box.vertices, dtype=float)
    faces = np.array(box.faces, dtype=int)
    vertices = np.vstack([vertices, vertices[0]])
    duplicate = len(vertices) - 1
    faces[0, 0] = duplicate
    vertices = np.vstack([vertices, vertices[1], vertices[1]])
    faces = np.vstack([faces, [duplicate, len(vertices) - 2, len(vertices) - 1]])
    island = len(vertices)
    vertices = np.vstack([vertices, [[5, 5, 5], [5.01, 5, 5], [5, 5.01, 5]]])
    faces = np.vstack([faces, [island, island + 1, island + 2]])
    shared = (int(faces[1][0]), int(faces[1][1]))
    midpoint = (vertices[shared[0]] + vertices[shared[1]]) / 2
    midpoint = midpoint + np.array([0.02, 0.02, 0.02])
    vertices = np.vstack([vertices, midpoint])
    faces = np.vstack([faces, [shared[0], shared[1], len(vertices) - 1]])
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    return mesh


class HighpolyRepairTests(unittest.TestCase):
    def test_clean_mesh_is_unchanged(self):
        box = trimesh.creation.box()
        result, report = repair_high(box)
        self.assertFalse(report['changed'])
        self.assertIs(result, box)
        self.assertEqual(report['after']['nonManifoldEdges'], 0)
        self.assertEqual(report['after']['degenerateTriangles'], 0)

    def test_repair_removes_nonmanifold_fragments_and_unwelded_points(self):
        repaired, report = repair_high(_dirty_box())
        self.assertTrue(report['changed'])
        self.assertGreater(report['before']['nonManifoldEdges'], 0)
        self.assertGreater(report['before']['weldedVertices'], 0)
        self.assertGreater(report['before']['isolatedFragments'], 0)
        self.assertEqual(report['after']['nonManifoldEdges'], 0)
        self.assertEqual(report['after']['degenerateTriangles'], 0)
        self.assertEqual(topology_report(repaired)['nonManifoldEdges'], 0)
        self.assertGreaterEqual(report['after']['faces'], 4)
        self.assertLessEqual(report['after']['faces'], FACE_LIMIT)
        self.assertIn('before', report)
        self.assertIn('faces', report['before'])
        self.assertIn('boundaryEdges', report['after'])

    def test_uv_seams_are_not_reported_as_boundary_edges(self):
        vertices = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], dtype=float)
        faces = np.array([[0, 1, 2], [3, 4, 5]], dtype=int)
        uv = np.array([[0, 0], [1, 0], [0, 1], [0.2, 0], [0.2, 1], [0, 1]], dtype=float)
        mesh = trimesh.Trimesh(vertices, faces, process=False)
        mesh.visual = trimesh.visual.TextureVisuals(uv=uv)
        report = topology_report(mesh)
        self.assertEqual(report['boundaryEdges'], 4)
        self.assertEqual(report['nonManifoldEdges'], 0)
        self.assertEqual(report['uvSeamEdges'], 1)
        self.assertEqual(report['uvSeamsReportedAsBoundary'], 0)
        self.assertEqual(report['degenerateTriangles'], 0)

    def test_face_cap_accepts_120000_and_new_lod_defaults(self):
        params = validate_parameters('source_lod', {})
        self.assertEqual(params['lodCount'], 3)
        self.assertEqual(params['lod0FaceCap'], 120000)
        self.assertEqual(params['lod0KeepPercent'], 55)
        self.assertEqual(params['lod1KeepPercent'], 30)
        self.assertEqual(params['lod2KeepPercent'], 12)
        self.assertEqual(validate_parameters('source_lod', {'lod0FaceCap': 120000})['lod0FaceCap'], 120000)
        self.assertEqual(validate_parameters('source_lod', {'lodCount': 5})['lodCount'], 5)
        with self.assertRaises(Exception):
            validate_parameters('source_lod', {'lod0FaceCap': 120001})
        with self.assertRaises(Exception):
            validate_parameters('source_lod', {'lodCount': 6})

    def test_three_lods_share_uv_and_orm_matches_pbr_channels(self):
        mesh = _grid()
        derived = derive_shared_lods(mesh, distortion_limit=2)
        high_uv = np.asarray(derived['high'].visual.uv)
        for key in ('medium', 'low'):
            uv = np.asarray(derived[key].visual.uv)
            self.assertEqual(len(uv), len(derived[key].vertices))
            self.assertGreater(len(uv), 0)
            self.assertIs(derived[key].visual.material, mesh.visual.material)
        self.assertLess(derived['reports']['low']['faces'], derived['reports']['medium']['faces'])
        self.assertLessEqual(derived['reports']['medium']['faces'], int(round(len(mesh.faces) * 0.45)) + 4)
        self.assertEqual(derived['sharedTextures'], ['basecolor.png', 'normal.png', 'roughness.png', 'metallic.png', 'ao.png', 'orm.png'])
        self.assertFalse(derived['reports']['low']['uvDistortionExceeded'])
        self.assertEqual(high_uv.shape[1], 2)
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            ao = np.full((8, 8), 200, np.uint8)
            roughness = np.arange(64, dtype=np.uint8).reshape(8, 8)
            metallic = np.full((8, 8), 17, np.uint8)
            write_packed_maps(folder, ao, roughness, metallic)
            orm = np.asarray(Image.open(folder / 'orm.png'))
            self.assertTrue(np.array_equal(orm[..., 0], ao))
            self.assertTrue(np.array_equal(orm[..., 1], roughness))
            self.assertTrue(np.array_equal(orm[..., 2], metallic))

    def test_low_uv_over_threshold_is_resampled_and_flat_textures_warn(self):
        mesh = _grid(6)
        mesh.visual.uv = np.random.default_rng(3).random((len(mesh.vertices), 2))
        derived = derive_shared_lods(mesh, distortion_limit=0.05)
        low = derived['reports']['low']
        self.assertTrue(low['uvDistortionExceeded'])
        self.assertTrue(low['resampled'])
        self.assertGreater(low['uvDistortion'], 0.05)
        flat_normal = np.zeros((4, 4, 3), np.uint8)
        flat_normal[..., 0] = 128
        flat_normal[..., 1] = 128
        flat_normal[..., 2] = 255
        warnings = texture_qc_warnings(flat_normal, np.full((4, 4), 128, np.uint8))
        self.assertTrue(any('纯平紫' in item for item in warnings))
        self.assertTrue(any('死灰' in item for item in warnings))
        varied_normal = np.zeros((4, 4, 3), np.uint8)
        varied_normal[..., 0] = np.arange(16, dtype=np.uint8).reshape(4, 4)
        self.assertEqual(texture_qc_warnings(varied_normal, np.arange(16, dtype=np.uint8).reshape(4, 4)), [])


if __name__ == '__main__':
    unittest.main()
