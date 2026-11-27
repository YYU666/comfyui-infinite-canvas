import json
import struct
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from native3d_geometry_audit import audit_geometry
from native3d_highpoly import (
    FACE_LIMIT, _occupancy, _topology_defects, _triangulate_loop, deliver_shared_lods,
    derive_shared_lods, repair_high, topology_report,
)
from native3d_jobs import validate_parameters
from native3d_lod_source import resolve_lod_settings, run_source_lod
from native3d_material_atlas import shares_orm_storage, texture_qc_warnings, write_packed_maps


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

    def test_new_lod_settings_default_to_three_levels(self):
        fresh = resolve_lod_settings()
        self.assertEqual(fresh['lodCount'], 3)
        legacy = resolve_lod_settings({'lodCount': 5})
        self.assertNotIn('lodCount', legacy)

    def test_large_mesh_lods_keep_uv_islands_apart(self):
        mesh = _seamed_panels(24)
        self.assertGreater(len(mesh.faces), 2000)
        self.assertGreater(len(mesh.faces), 1500)
        derived = derive_shared_lods(mesh)
        for key in ('medium', 'low'):
            model = derived[key]
            uv = np.asarray(model.visual.uv)
            triangles = uv[np.asarray(model.faces)]
            horizontal = triangles[:, :, 0]
            left = (horizontal >= 0.05 - 1e-3) & (horizontal <= 0.40 + 1e-3)
            right = (horizontal >= 0.60 - 1e-3) & (horizontal <= 0.95 + 1e-3)
            self.assertTrue(np.all(left | right))
            self.assertTrue(np.all(left.all(axis=1) | right.all(axis=1)))
            self.assertTrue(np.any(left))
            self.assertTrue(np.any(right))
            lengths = np.linalg.norm(np.stack((
                triangles[:, 0] - triangles[:, 1],
                triangles[:, 1] - triangles[:, 2],
                triangles[:, 2] - triangles[:, 0],
            )), axis=2)
            report = derived['reports'][key]
            self.assertIn('per-UV-island', report['uvTransfer'])
            self.assertTrue(report['resampled'])
            self.assertAlmostEqual(report['uvDistortion'], float(lengths.max()), places=5)
            self.assertGreater(report['uvDistortion'], 0)
            self.assertEqual(
                bool(report['uvDistortionExceeded']),
                report['uvDistortion'] > report['uvDistortionLimit'])

    def test_large_nonmanifold_repair_is_vectorized(self):
        mesh = _seamed_panels(100, fins=80)
        self.assertGreaterEqual(len(mesh.faces), 20000)
        started = time.perf_counter()
        repaired, report = repair_high(mesh)
        after = topology_report(repaired)
        elapsed = time.perf_counter() - started
        self.assertGreaterEqual(report['before']['nonManifoldEdges'], 80)
        self.assertGreater(report['before']['uvSeamEdges'], 0)
        self.assertEqual(after['nonManifoldEdges'], 0)
        self.assertEqual(after['degenerateTriangles'], 0)
        self.assertEqual(report['after']['nonManifoldEdges'], 0)
        self.assertEqual(report['after']['degenerateTriangles'], 0)
        self.assertLess(elapsed, 3.0)

    def test_texture_qc_uses_uv_coverage_mask(self):
        mask = np.zeros((64, 64), dtype=bool)
        mask.ravel()[: int(0.6 * 64 * 64)] = True
        roughness = np.zeros((64, 64), np.uint8)
        roughness[mask] = 157
        normal = np.zeros((64, 64, 3), np.uint8)
        normal[mask, 0] = 128
        normal[mask, 1] = 128
        normal[mask, 2] = 255
        warnings = texture_qc_warnings(normal, roughness, mask)
        self.assertTrue(any('死灰' in item for item in warnings))
        self.assertTrue(any('纯平紫' in item for item in warnings))
        self.assertFalse(any('死灰' in item or '纯平紫' in item for item in texture_qc_warnings(normal, roughness)))
        healthy_roughness = np.zeros((64, 64), np.uint8)
        covered = int(mask.sum())
        healthy_roughness[mask] = np.arange(covered, dtype=np.uint8) % 180
        healthy_normal = np.zeros((64, 64, 3), np.uint8)
        healthy_normal[mask, 0] = np.arange(covered, dtype=np.uint8)
        healthy_normal[mask, 1] = 40
        healthy_normal[mask, 2] = 200
        self.assertEqual(texture_qc_warnings(healthy_normal, healthy_roughness, mask), [])

    def test_shared_lod_glb_exports_tangents_and_one_orm(self):
        mesh = _grid()
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            delivered = deliver_shared_lods(mesh, folder, distortion_limit=2)
            self.assertEqual(delivered['files'], ['LOD0_high.glb', 'LOD1_medium.glb', 'LOD2_low.glb'])
            for name in delivered['files']:
                blob = (folder / name).read_bytes()
                self.assertEqual(blob[:4], b'glTF')
                json_size = struct.unpack('<I', blob[12:16])[0]
                document = json.loads(blob[20:20 + json_size])
                attributes = document['meshes'][0]['primitives'][0]['attributes']
                self.assertIn('TANGENT', attributes)
                self.assertNotIn('_TANGENT', attributes)
                self.assertTrue(shares_orm_storage(document, document['materials'][0]))

    def test_compound_defects_repair_into_three_lods(self):
        vertices = np.array([
            [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
            [0.2, 0.2, -1], [0.8, 0.8, -1],
        ], dtype=float)
        occupied = np.array([[0, 2, 4], [0, 5, 2]], dtype=int)
        counts, keys = _occupancy(occupied)
        for edge in ((0, 1), (1, 2), (2, 3), (3, 0)):
            counts[edge] = 1
        capped = _triangulate_loop(vertices, [0, 1, 2, 3], counts, keys)
        self.assertEqual(counts[(0, 2)], 2)
        self.assertGreaterEqual(counts.get((1, 3), 0), 1)
        self.assertTrue(capped)
        for triangle in capped:
            self.assertLessEqual(max(counts[tuple(sorted((int(triangle[i]), int(triangle[(i + 1) % 3]))))] for i in range(3)), 2)

        mesh = _compound_dirty_mesh()
        before = topology_report(mesh)
        incoming = _topology_defects(mesh.vertices, mesh.faces)
        self.assertGreater(before['nonManifoldEdges'], 1)
        self.assertGreater(incoming['nonManifoldVertices'], 0)
        self.assertGreater(incoming['inconsistentWindingEdges'], 0)
        repaired, report = repair_high(mesh)
        self.assertEqual(report['after']['nonManifoldEdges'], 0)
        self.assertEqual(report['before']['nonManifoldEdges'], before['nonManifoldEdges'])
        self.assertGreater(report['splitNonManifoldVertices'], 0)
        self.assertGreater(report['maxFilledLoop'], 4)
        self.assertIsNone(report['reconstruction'])
        audit = audit_geometry(repaired.vertices, repaired.faces, max_seconds=30)
        self.assertEqual(audit['status'], 'accepted', audit.get('blocker'))
        self.assertEqual(audit['nonmanifold_vertices_count'], 0)
        self.assertEqual(audit['inconsistent_winding_edges'], 0)
        self.assertEqual(audit['nonmanifold_edges_count'], 0)
        self.assertEqual(audit['boundary_edges'], 0)
        with tempfile.TemporaryDirectory() as temporary:
            _selected, manifest, _artifacts = run_source_lod(repaired, temporary, {
                'lodCount': 3, 'lod0KeepPercent': 80,
                'lodKeepPercents': [100, 70, 50, 30, 15], 'maxSeconds': 180,
            })
        self.assertEqual(manifest['status'], 'accepted', manifest.get('blocker'))
        self.assertTrue(manifest['chainComplete'])
        levels = [row['lodLevel'] for row in manifest['logicalLevels']]
        self.assertEqual(levels, [0, 1, 2])
        accepted = [stage for stage in manifest['stages'] if stage.get('status') == 'accepted' and stage.get('lodLevel') in (0, 1, 2)]
        self.assertGreaterEqual(len({stage['lodLevel'] for stage in accepted}), 3)


def _compound_dirty_mesh():
    """Closed sphere with several fins, a pinch, flipped faces, and a fan that repair opens into a >4 hole."""
    base = trimesh.creation.icosphere(subdivisions=3)
    vertices = np.array(base.vertices, dtype=float)
    faces = np.array(base.faces, dtype=int)
    fan = np.flatnonzero(np.any(faces == 0, axis=1))
    if len(fan) <= 4:
        raise RuntimeError('vertex fan is not a >4 edge hole')
    for face_index in fan.tolist():
        triangle = [int(vertex) for vertex in faces[face_index]]
        rim = [vertex for vertex in triangle if vertex != 0]
        left, right = rim
        tip = (vertices[left] + vertices[right]) * 0.5
        tip = tip / max(np.linalg.norm(tip), 1e-8) * 3.0
        vertices = np.vstack([vertices, tip])
        faces = np.vstack([faces, [left, right, len(vertices) - 1]])
    for face_index, scale in ((80, 0.04), (90, 0.05), (100, 0.06)):
        left, right = int(faces[face_index][0]), int(faces[face_index][1])
        tip = (vertices[left] + vertices[right]) * 0.5
        tip = tip / max(np.linalg.norm(tip), 1e-8) * (1 + scale)
        vertices = np.vstack([vertices, tip])
        faces = np.vstack([faces, [left, right, len(vertices) - 1]])
    anchor = int(faces[140][2])
    if anchor == 0:
        anchor = int(faces[200][2])
    normal = vertices[anchor] / max(np.linalg.norm(vertices[anchor]), 1e-8)
    tangent = np.array([-normal[1], normal[0], 0.0])
    tangent = tangent / max(np.linalg.norm(tangent), 1e-8)
    bitangent = np.cross(normal, tangent)
    tip = len(vertices)
    vertices = np.vstack([vertices, [
        vertices[anchor] + normal * 0.45 + tangent * 0.2,
        vertices[anchor] + normal * 0.45 - tangent * 0.2,
        vertices[anchor] + normal * 0.45 + bitangent * 0.35,
    ]])
    # Closed tetrahedron sharing only anchor, so the vertex has two fans and no new boundary.
    faces = np.vstack([faces, [
        [anchor, tip, tip + 1],
        [anchor, tip + 1, tip + 2],
        [anchor, tip + 2, tip],
        [tip, tip + 2, tip + 1],
    ]])
    faces = np.array(faces, copy=True)
    faces[220:224] = faces[220:224, ::-1]
    return trimesh.Trimesh(vertices, faces, process=False)


def _seamed_panels(n, fins=0):
    """Two charts that meet in 3D and stay apart in UV. Optional non-manifold fins."""
    def panel(origin, u0, u1):
        vertices, uv, faces = [], [], []
        for y in range(n + 1):
            for x in range(n + 1):
                vertices.append((origin + x, y, 0.0))
                uv.append((u0 + (u1 - u0) * x / n, 0.05 + 0.90 * y / n))
        def index(x, y):
            return y * (n + 1) + x
        for y in range(n):
            for x in range(n):
                a, b, c, d = index(x, y), index(x + 1, y), index(x + 1, y + 1), index(x, y + 1)
                faces.append((a, b, c))
                faces.append((a, c, d))
        return vertices, uv, faces
    left_v, left_uv, left_f = panel(0, 0.05, 0.40)
    right_v, right_uv, right_f = panel(n, 0.60, 0.95)
    offset = len(left_v)
    vertices = np.array(left_v + right_v, dtype=float)
    uv = np.array(left_uv + right_uv, dtype=float)
    faces = np.array(left_f + [(a + offset, b + offset, c + offset) for a, b, c in right_f], dtype=int)
    if fins:
        extra_v, extra_uv, extra_f = [], [], []
        used = set()
        for face in left_f:
            if len(extra_f) >= fins:
                break
            a, b = int(face[0]), int(face[1])
            if not (1 <= vertices[a, 0] <= n - 2 and 1 <= vertices[a, 1] <= n - 2):
                continue
            if not (1 <= vertices[b, 1] <= n - 2):
                continue
            key = (a, b) if a < b else (b, a)
            if key in used or key[0] == key[1]:
                continue
            used.add(key)
            midpoint = (vertices[a] + vertices[b]) / 2 + np.array([0.0, 0.0, 0.05])
            extra_v.append(midpoint)
            extra_uv.append((uv[a] + uv[b]) / 2)
            extra_f.append((a, b, len(vertices) + len(extra_v) - 1))
        if len(extra_f) < fins:
            raise RuntimeError('not enough interior edges for non-manifold fins')
        vertices = np.vstack([vertices, np.array(extra_v, dtype=float)])
        uv = np.vstack([uv, np.array(extra_uv, dtype=float)])
        faces = np.vstack([faces, np.array(extra_f, dtype=int)])
    mesh = trimesh.Trimesh(vertices, faces, process=False)
    mesh.visual = trimesh.visual.TextureVisuals(
        uv=uv, material=trimesh.visual.material.PBRMaterial(roughnessFactor=0.8, metallicFactor=0.0))
    return mesh


if __name__ == '__main__':
    unittest.main()
