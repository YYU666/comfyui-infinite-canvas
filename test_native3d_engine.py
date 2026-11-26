import json
from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np
import trimesh
from native3d_engine import read_mesh, run, unwrap, bake, simplify, prepare_ai_points, official_mc_mesh, official_surface_sample, ai_shape_gate, repair_winding, face_tangent_basis, export_glb, compact_json


class EngineTest(unittest.TestCase):
    def test_high_guided_uv_rejects_changed_target_or_high_snapshot(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);source=root/'source.glb';source.write_bytes(trimesh.creation.box().export(file_type='glb'))
            digest=hashlib.sha256(source.read_bytes()).hexdigest()
            request={'operation':'uv','sourcePath':str(source),'highSourcePath':str(source),
                'source':{'sha256':'0'*64,'highSha256':digest},
                'parameters':{'seamStrategy':'coherent','highGuidedEvidence':'{}'}}
            with self.assertRaisesRegex(ValueError,'target snapshot SHA256 mismatch'):run(request,root/'target-mismatch')
            request['source']={'sha256':digest,'highSha256':'0'*64}
            with self.assertRaisesRegex(ValueError,'source snapshot SHA256 mismatch'):run(request,root/'high-mismatch')

    def test_compact_report_preserves_all_evidence_below_transport_limit(self):
        record={'keep':1,'remove':2,'position':[.1,.2,.3],'reason':'保留全部证据'}
        report={'metadata':{'collapses':[record]*40000},'quality':{},'warnings':[]}
        self.assertGreater(len(json.dumps(report,ensure_ascii=False,indent=2).encode('utf-8')),4*1024**2)
        encoded=compact_json(report)
        self.assertLess(len(encoded.encode('utf-8')),4*1024**2)
        self.assertEqual(json.loads(encoded),report)

    def test_compact_report_never_truncates_oversize_or_accepts_nan(self):
        report={'evidence':'x'*(4*1024**2+1)}
        encoded=compact_json(report)
        self.assertGreater(len(encoded.encode('utf-8')),4*1024**2)
        self.assertEqual(json.loads(encoded),report)
        with self.assertRaises(ValueError):compact_json({'value':float('nan')})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_analyze_and_real_poster(self):
        source = self.root / 'cube.glb'
        trimesh.creation.box().export(source)
        result = run({'operation': 'analyze', 'sourcePath': str(source)}, self.root / 'job')
        report_bytes=(self.root/'job/report.json').read_text(encoding='utf-8')
        self.assertEqual(report_bytes,compact_json(json.loads(report_bytes)))
        self.assertEqual(result['quality']['triangles'], 12)
        self.assertEqual(trimesh.load(self.root / 'job/model.glb', force='mesh').faces.shape, (12, 3))
        from PIL import Image
        image = Image.open(self.root / 'job/poster.png')
        self.assertEqual(image.size, (640, 640))
        self.assertGreater(len(image.getcolors(640*640)), 1)

    def test_multi_geometry_rejected(self):
        scene = trimesh.Scene([trimesh.creation.box(), trimesh.creation.icosphere()])
        source = self.root / 'multi.glb'; source.write_bytes(scene.export(file_type='glb'))
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            read_mesh(source)

    def test_external_obj_rejected(self):
        source = self.root / 'external.obj'
        source.write_text('mtllib ../secret.mtl\nv 0 0 0\n')
        with self.assertRaisesRegex(ValueError, 'dependencies'):
            read_mesh(source)

    def test_uv_lineage_and_projection_bounds(self):
        mesh = trimesh.creation.box()
        uvmesh, report = unwrap(mesh, {'resolution': 1024})
        self.assertTrue(report['exactTriangleMapping'])
        self.assertEqual(len(uvmesh.faces), len(mesh.faces))
        source = self.root / 'uv.glb'; uvmesh.export(source)
        low = read_mesh(source)
        original_faces = np.asarray(low.faces).copy()
        original_positions = np.asarray(low.vertices).copy()
        original_uv = np.asarray(low.visual.uv).copy()
        original_normals = np.asarray(low.vertex_normals).copy()
        out = self.root / 'bake'; out.mkdir()
        result = bake(low, mesh, out, {'resolution': 1024, 'aoSamples': 8})
        self.assertGreater(result['hitRatio'], .99)
        self.assertTrue((out / 'normal.png').exists())
        exported = out / 'explicit-tangents.glb'
        export_glb(low, exported)
        blob = exported.read_bytes()
        json_size = struct.unpack('<I', blob[12:16])[0]
        doc = json.loads(blob[20:20+json_size])
        attributes = doc['meshes'][0]['primitives'][0]['attributes']
        self.assertIn('TANGENT', attributes)
        self.assertNotIn('_TANGENT', attributes)
        accessor = doc['accessors'][attributes['TANGENT']]
        view = doc['bufferViews'][accessor['bufferView']]
        offset = 20+json_size+8+view.get('byteOffset', 0)+accessor.get('byteOffset', 0)
        stored = np.frombuffer(blob, dtype='<f4', count=accessor['count']*4, offset=offset).reshape(-1,4)
        np.testing.assert_allclose(stored, low.vertex_attributes['_TANGENT'])
        np.testing.assert_allclose(low.vertices[low.faces], original_positions[original_faces])
        np.testing.assert_allclose(low.visual.uv[low.faces], original_uv[original_faces])
        np.testing.assert_allclose(low.vertex_normals[low.faces], original_normals[original_faces], atol=1e-6)
        self.assertEqual(len(low.vertices), len(original_positions)+result['tangentMirrorSplitVertices'])
        moved = mesh.copy(); moved.apply_translation([100, 0, 0])
        with self.assertRaisesRegex(ValueError, 'No valid'):
            bake(low, moved, out, {'resolution': 1024, 'aoSamples': 8})

    def test_simplification_actual_budget(self):
        mesh = trimesh.creation.icosphere(subdivisions=3)
        result = simplify(mesh, 100)
        self.assertLessEqual(len(result.faces), 100)
        self.assertGreater(len(result.faces), 0)

    def test_decoder_inverse_official_half_range(self):
        from native3d_meshanything import decoder_to_source
        np.testing.assert_allclose(decoder_to_source(np.array([[-.5, 0, .5]]), np.array([10, 20, 30]), 4), [[6, 20, 34]])

    def test_ai_translated_small_geometry_preserved(self):
        points = np.array([[-1., 0., 1.], [1., 1., -1.], [0., -1., 0.]])
        normals = np.tile([0., 1., 0.], (3, 1))
        pc, _, radius = prepare_ai_points(points, normals)
        moved, center, moved_radius = prepare_ai_points(points + 10000., normals)
        np.testing.assert_array_equal(pc, moved)
        self.assertEqual(radius, moved_radius)
        np.testing.assert_allclose(center, [10000.] * 3)
        self.assertGreater(float(np.ptp(moved[:, 0])), 1.)

    def test_vertex_colors_import_and_bake_as_linear_rgb(self):
        from PIL import Image
        mesh = trimesh.Trimesh([[.1,.1,0],[.3,.1,0],[.1,.3,0]], [[0,1,2]], process=False)
        rgb = np.array([64, 128, 191])
        mesh.visual.vertex_colors = np.tile([*rgb, 255], (len(mesh.vertices), 1))
        source = self.root / 'colors.glb'
        mesh.export(source)
        high = read_mesh(source)
        self.assertTrue(high.metadata['nativeSourceVertexColor'])
        np.testing.assert_array_equal(high.visual.vertex_colors, mesh.visual.vertex_colors)

        low = trimesh.Trimesh([[.1,.1,.01],[.3,.1,.01],[.1,.3,.01]], [[0,1,2]], process=False)
        low.visual = trimesh.visual.TextureVisuals(uv=[[.05,.05],[.05,.15],[.15,.05]])
        low.metadata['nativeSourceUV'] = True
        result = bake(low, high, self.root, {'resolution':1024,'aoSamples':8,'rayDistance':.02,'padding':8})
        self.assertGreater(result['hitRatio'], .99)
        self.assertIn('linear vertex-color projection', result['pbrTransfer']['baseColor'])
        with Image.open(self.root/'hits.png') as hits, Image.open(self.root/'basecolor.png') as image:
            projected = np.asarray(image)[np.asarray(hits) == 255]
        expected = np.floor((1.055 * (rgb / 255.) ** (1 / 2.4) - .055) * 255)
        np.testing.assert_allclose(projected, np.broadcast_to(expected, projected.shape), atol=1)

    def test_official_mc_shell_and_sampling_repeatable(self):
        coords = np.arange(256) / 256 * 2 - 1
        squared = coords**2
        sdf = (np.sqrt(squared[:, None, None] + squared[None, :, None] + squared[None, None, :]) - .5).astype(np.float32)
        mesh = official_mc_mesh(sdf)
        self.assertGreater(len(mesh.faces), 100)
        self.assertLess(float(np.abs(mesh.bounds).max()), .52)
        first, ids = official_surface_sample(mesh, 8192, 0)
        repeated, repeat_ids = official_surface_sample(mesh, 8192, 0)
        np.testing.assert_array_equal(first, repeated)
        np.testing.assert_array_equal(ids, repeat_ids)

    def test_ai_quality_rejects_collapse_and_duplicate_cleanup(self):
        mesh = trimesh.creation.box()
        accepted = ai_shape_gate(mesh, mesh.copy(), {'removedFraction': 0})
        self.assertEqual(accepted['rejectionReasons'], [])
        moved = mesh.copy(); moved.apply_translation([10, 0, 0])
        rejected = ai_shape_gate(mesh, moved, {'removedFraction': .78})
        self.assertGreaterEqual(len(rejected['rejectionReasons']), 3)

    def test_winding_repair_preserves_exact_seam_vertices(self):
        vertices = np.array([[0, 0, 0], [1, 0, 0], [1, 1, .2], [0, 1, 0]], dtype=float)
        faces = np.array([[0, 1, 2], [0, 3, 2]])
        mesh = trimesh.Trimesh(vertices, faces, process=False)
        mesh.visual = trimesh.visual.TextureVisuals(uv=vertices[:, :2])
        mesh.unmerge_vertices()
        original_vertices = mesh.vertices.copy(); original_uv = mesh.visual.uv.copy()
        fixed, report = repair_winding(mesh)
        np.testing.assert_array_equal(fixed.vertices, original_vertices)
        np.testing.assert_array_equal(fixed.visual.uv, original_uv)
        self.assertEqual(len(fixed.faces), 2)
        self.assertGreater(report['facesFlipped'], 0)
        self.assertGreater(float(fixed.face_normals[0] @ fixed.face_normals[1]), .8)

    def test_exported_tangent_basis_mirrored_uv_and_bent_normals(self):
        xyz = np.array([[0., 0., 0.], [1., 0., 0.], [1., 1., .25]])
        n = np.cross(xyz[1]-xyz[0], xyz[2]-xyz[0]); n /= np.linalg.norm(n)
        for uv in (np.array([[0., 0.], [1., 0.], [1., 1.]]), np.array([[1., 0.], [0., 0.], [0., 1.]])):
            t, b, sign = face_tangent_basis(xyz, uv, n)
            exported = uv.copy(); exported[:, 1] = 1-exported[:, 1]
            derivative = np.linalg.solve((exported[1:]-exported[0]), xyz[1:]-xyz[0])
            self.assertGreater(float(b @ derivative[1]), 0)
            self.assertGreater(float(t @ derivative[0]), 0)
            self.assertAlmostEqual(float(np.linalg.det(np.column_stack([t, b, n]))), sign)
            target = n + .2*t + .3*b; target /= np.linalg.norm(target)
            encoded = np.array([target@t, target@b, target@n])
            np.testing.assert_allclose(encoded[0]*t + encoded[1]*b + encoded[2]*n, target, atol=1e-12)

    def test_high_memory_preflight_precedes_high_parse(self):
        from unittest.mock import patch
        mesh, _ = unwrap(trimesh.creation.box(), {'resolution': 1024})
        source = self.root / 'low.glb'; mesh.export(source)
        high = self.root / 'high.glb'; trimesh.creation.box().export(high)
        with patch('native3d_engine.memory_gate', side_effect=[{}, {}, MemoryError('preflight')]), patch('native3d_engine.read_mesh', wraps=read_mesh) as reader:
            with self.assertRaisesRegex(MemoryError, 'preflight'):
                run({'operation': 'bake', 'sourcePath': str(source), 'highSourcePath': str(high)}, self.root / 'gated')
            self.assertEqual(reader.call_count, 1)
        self.assertFalse((self.root / 'gated/result.json').exists())

    def test_embedded_pbr_transfer_and_dilation(self):
        from PIL import Image
        high, _ = unwrap(trimesh.creation.box(), {'resolution': 1024})
        texture = np.zeros((8, 8, 3), dtype=np.uint8)
        texture[:, :4] = [255, 0, 0]; texture[:, 4:] = [0, 255, 0]
        high.visual.material = trimesh.visual.material.PBRMaterial(baseColorTexture=Image.fromarray(texture), metallicFactor=.2, roughnessFactor=.6)
        source = self.root / 'texture.glb'; high.export(source)
        high = read_mesh(source)
        low, _ = unwrap(trimesh.creation.box(), {'resolution': 1024})
        low.metadata['nativeSourceUV'] = True
        out = self.root / 'textured-bake'; out.mkdir()
        result = bake(low, high, out, {'resolution': 1024, 'aoSamples': 8})
        with Image.open(out / 'basecolor.png') as image:
            pixels = np.asarray(image)
        self.assertGreater(np.count_nonzero((pixels[:, :, 0] > 200) & (pixels[:, :, 1] < 50)), 100)
        self.assertGreater(np.count_nonzero((pixels[:, :, 1] > 200) & (pixels[:, :, 0] < 50)), 100)
        self.assertGreater(result['dilation']['changedTexels'], 0)
        self.assertIn('embedded', result['pbrTransfer']['baseColor'])
        low.export(out / 'baked.glb')
        self.assertTrue(read_mesh(out / 'baked.glb').metadata['nativeSourceUV'])


if __name__ == '__main__':
    unittest.main()
