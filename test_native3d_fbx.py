"""Real binary FBX regressions; require locally provisioned pinned converter."""
import io
import json
from pathlib import Path
import struct
import tempfile
import unittest

import numpy as np
from PIL import Image
import trimesh
from trimesh.visual.material import PBRMaterial

import native3d_fbx as fbx


def glb_json(data):
    size, kind = struct.unpack_from('<II', data, 12)
    assert kind == 0x4E4F534A
    return json.loads(data[20:20 + size])


def rewrite_json(data, mutate):
    size, _ = struct.unpack_from('<II', data, 12)
    doc = glb_json(data)
    mutate(doc)
    chunk = json.dumps(doc, separators=(',', ':')).encode()
    chunk += b' ' * (-len(chunk) % 4)
    tail = data[20 + size:]
    return struct.pack('<4sII', b'glTF', 2, 20 + len(chunk) + len(tail)) + struct.pack('<II', len(chunk), 0x4E4F534A) + chunk + tail


def source_scene(texture=False, normal_map=False):
    # Unshared corner vertices force UV seams and sharp, per-corner normals.
    base = trimesh.creation.box(extents=[.37, 1.13, 2.71])
    vertices = base.vertices[base.faces].reshape((-1, 3))
    mesh = trimesh.Trimesh(vertices, np.arange(len(vertices)).reshape((-1, 3)), process=False)
    mesh.vertex_normals = np.repeat(base.face_normals, 3, axis=0)
    uv = np.tile([[.03, .14], [.85, .27], [.39, .96]], (len(base.faces), 1))
    pixels = np.array([[[251, 3, 21], [5, 241, 32]], [[16, 27, 239], [213, 197, 17]]], dtype=np.uint8)
    image = Image.fromarray(pixels) if texture else None
    material = PBRMaterial(baseColorFactor=[173, 99, 27, 255], baseColorTexture=image,
                           normalTexture=Image.fromarray(np.full((2, 2, 3), [128, 128, 255], dtype=np.uint8)) if normal_map else None,
                           metallicFactor=0, roughnessFactor=.7)
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
    transform = trimesh.transformations.rotation_matrix(.63, [1, 2, 3])
    transform = transform @ np.diag([1.3, .8, 1.7, 1])
    transform[:3, 3] = [2.7, -.35, 4.2]
    scene = trimesh.Scene()
    scene.add_geometry(mesh, transform=transform)
    return scene


class FbxDependencyTests(unittest.TestCase):
    def test_ready_requires_matching_fixed_digests(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temporary:
            location = Path(temporary)
            executable = location/'native3d_fbx_tool.exe'
            dll = location/'assimp-vc143-mt.dll'
            executable.write_bytes(b'fixture executable')
            dll.write_bytes(b'fixture library')
            with patch.dict('os.environ', {'NATIVE3D_FBX_CONVERTER': str(executable)}):
                self.assertFalse(fbx.capabilities()['available'])
                (location/'receipt.json').write_text(json.dumps({
                    'sourceURL': fbx.SOURCE_URL, 'sourceSHA256': fbx.SOURCE_SHA256,
                    'version': '5.4.3', 'license': 'BSD-3-Clause', 'adapterSourceSHA256': fbx.ADAPTER_SOURCE_SHA256,
                    'binaries': {path.name: fbx._binary_digest(path) for path in (executable,dll)}
                }), encoding='utf-8')
                self.assertTrue(fbx.capabilities()['available'])
                dll.write_bytes(b'modified library')
                self.assertFalse(fbx.capabilities()['available'])
                with self.assertRaisesRegex(RuntimeError, 'dependency digest mismatch'):
                    fbx.verified_converter()


@unittest.skipUnless(fbx.converter_path().is_file(), 'Pinned Assimp converter is not provisioned')
class FbxRoundtripTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def roundtrip(self, texture=False, normal_map=False):
        scene = source_scene(texture, normal_map)
        source, target, back = [self.root / n for n in ['source.glb', 'result.fbx', 'back.glb']]
        source.write_bytes(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
        original = source.read_bytes()
        exported = fbx.export_fbx(source, target, material_policy='allow_lossy')
        self.assertEqual(exported['materialSemanticStatus'], 'lossy_unverified')
        self.assertFalse(exported['fullMaterialFidelity'])
        imported = fbx.import_fbx(target, back)
        self.assertTrue(target.read_bytes().startswith(b'Kaydara FBX Binary  \x00\x1a\x00'))
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(exported['unitMeters'], .01)
        self.assertEqual(imported['unitMeters'], .01)
        self.assertTrue(exported['hasNormals'])
        self.assertTrue(imported['hasUV'])
        before = trimesh.load(source, force='mesh', process=False)
        after = trimesh.load(back, force='mesh', process=False)
        self.assertEqual(len(before.faces), len(after.faces))
        np.testing.assert_allclose(before.bounds, after.bounds, atol=2e-6)
        # Compare corner attributes by world coordinate + UV, not vertex ordering.
        def records(mesh):
            rows = np.column_stack([mesh.vertices, mesh.visual.uv, mesh.vertex_normals])
            rows = rows[np.asarray(mesh.faces).ravel()]
            return rows[np.lexsort(np.round(rows, 5).T[::-1])]
        np.testing.assert_allclose(records(before), records(after), atol=3e-6)
        return source, target, back, before, after

    def test_asymmetric_geometry_transforms_uv_normals_units(self):
        self.roundtrip()

    def test_embedded_basecolor_pixels_survive(self):
        _, _, back, before, after = self.roundtrip(texture=True)
        np.testing.assert_array_equal(np.asarray(before.visual.material.baseColorTexture), np.asarray(after.visual.material.baseColorTexture))
        doc = glb_json(back.read_bytes())
        self.assertTrue(doc['images'])
        self.assertTrue(all('uri' not in i for i in doc['images']))

    def test_embedded_normal_pixels_survive(self):
        _, _, _, before, after = self.roundtrip(texture=True, normal_map=True)
        np.testing.assert_array_equal(np.asarray(before.visual.material.normalTexture), np.asarray(after.visual.material.normalTexture))

    def test_reject_multiple_meshes(self):
        scene = source_scene()
        scene.add_geometry(trimesh.creation.icosphere(subdivisions=0), node_name='extra')
        source = self.root / 'multi.glb'
        source.write_bytes(trimesh.exchange.gltf.export_glb(scene))
        with self.assertRaisesRegex(ValueError, 'single mesh'):
            fbx.export_fbx(source, self.root / 'out.fbx', material_policy='allow_lossy')
        self.assertFalse((self.root / 'out.fbx').exists())

    def test_official_centimetre_fixture(self):
        # Independent upstream sample, not generated by this adapter.
        fixture = fbx.CACHE / 'source/assimp-5.4.3/test/models/FBX/phong_cube.fbx'
        self.assertTrue(fixture.is_file(), 'Provision pinned source archive with reference fixtures')
        converted = self.root / 'centimetres.glb'
        info = fbx.import_fbx(fixture, converted)
        self.assertEqual(info['unitMeters'], .01)
        mesh = trimesh.load(converted, force='mesh', process=False)
        np.testing.assert_allclose(mesh.extents, [.01, .01, .01], atol=1e-8)
        fbx.export_fbx(converted, self.root / 'metres.geometry-only.fbx', material_policy='geometry_only')
        fbx.import_fbx(self.root / 'metres.geometry-only.fbx', self.root / 'back.glb')
        restored = trimesh.load(self.root / 'back.glb', force='mesh', process=False)
        np.testing.assert_allclose(mesh.bounds, restored.bounds, atol=1e-8)

    def test_reject_external_texture_without_loading_it(self):
        data = trimesh.exchange.gltf.export_glb(source_scene(texture=True))
        def external(doc):
            doc['images'] = [{'uri': 'file:///C:/private-never-read.png'}]
        source = self.root / 'external.glb'
        source.write_bytes(rewrite_json(data, external))
        with self.assertRaisesRegex(ValueError, 'External texture'):
            fbx.export_fbx(source, self.root / 'out.fbx', material_policy='allow_lossy')

    def test_material_scalars_never_silently_claim_parity(self):
        scene = source_scene(texture=True)
        material = next(iter(scene.geometry.values())).visual.material
        material.metallicFactor = .37
        material.roughnessFactor = .71
        source = self.root / 'pbr.glb'
        source.write_bytes(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
        original = source.read_bytes()
        with self.assertRaisesRegex(ValueError, 'material semantic preservation'):
            fbx.export_fbx(source, self.root / 'complete.fbx')
        self.assertFalse((self.root / 'complete.fbx').exists())
        receipt = fbx.export_fbx(source, self.root / 'diagnostic.fbx', material_policy='allow_lossy')
        self.assertEqual(receipt['materialSemanticStatus'], 'lossy_unverified')
        self.assertFalse(receipt['fullMaterialFidelity'])
        self.assertAlmostEqual(receipt['sourceMaterialScalars'][0]['metallicFactor'], .37)
        self.assertAlmostEqual(receipt['sourceMaterialScalars'][0]['roughnessFactor'], .71)
        imported = fbx.import_fbx(self.root / 'diagnostic.fbx', self.root / 'diagnostic.glb')
        self.assertEqual(imported['materialSemanticStatus'], 'mapped_unverified')
        mapped = trimesh.load(self.root / 'diagnostic.glb', force='mesh', process=False).visual.material
        self.assertNotAlmostEqual(mapped.metallicFactor, .37, places=4)
        self.assertNotAlmostEqual(mapped.roughnessFactor, .71, places=4)
        with self.assertRaisesRegex(ValueError, 'geometry-only.fbx'):
            fbx.export_fbx(source, self.root / 'ambiguous.fbx', material_policy='geometry_only')
        geometry = self.root / 'pbr.geometry-only.fbx'
        receipt = fbx.export_fbx(source, geometry, material_policy='geometry_only')
        self.assertEqual(receipt['materialSemanticStatus'], 'stripped_geometry_only')
        self.assertTrue(receipt['materialWarnings'])
        fbx.import_fbx(geometry, self.root / 'geometry.glb')
        doc = glb_json((self.root / 'geometry.glb').read_bytes())
        self.assertFalse(doc.get('images'))
        self.assertFalse(doc.get('textures'))
        self.assertEqual(source.read_bytes(), original)

    def test_materialless_geometry_exports_by_default(self):
        data = trimesh.exchange.gltf.export_glb(source_scene(), include_normals=True)
        def remove_materials(doc):
            doc.pop('materials', None)
            for mesh in doc['meshes']:
                for primitive in mesh['primitives']:
                    primitive.pop('material', None)
        source = self.root / 'geometry.glb'
        source.write_bytes(rewrite_json(data, remove_materials))
        receipt = fbx.export_fbx(source, self.root / 'geometry.fbx')
        self.assertEqual(receipt['materialSemanticStatus'], 'not_applicable')
        self.assertEqual(receipt['materialWarnings'], [])

    def test_unicode_source_destination_and_staging_preserve_geometry_uv(self):
        from unittest.mock import patch
        folder=self.root/'中文 路径 · 导出';folder.mkdir()
        source=folder/'原始 模型.glb';target=folder/'结果.geometry-only.fbx';back=folder/'返回.glb'
        source.write_bytes(trimesh.exchange.gltf.export_glb(source_scene(),include_normals=True));original=source.read_bytes()
        with patch('tempfile.tempdir',str(folder)):
            receipt=fbx.export_fbx(source,target,material_policy='geometry_only')
            fbx.import_fbx(target,back)
        self.assertIn('ASCII relative',receipt['pathHandling']);self.assertEqual(source.read_bytes(),original)
        a=trimesh.load(source,force='mesh',process=False);b=trimesh.load(back,force='mesh',process=False)
        def corners(mesh):
            values=np.column_stack([mesh.vertices,mesh.visual.uv,mesh.vertex_normals])[mesh.faces.ravel()]
            return values[np.lexsort(np.round(values,5).T[::-1])]
        np.testing.assert_allclose(corners(a),corners(b),atol=3e-6)
        self.assertFalse(list(folder.glob('.native3d-fbx-*')))

    def test_racing_destination_is_never_overwritten_or_deleted(self):
        from unittest.mock import patch
        source=self.root/'source.glb';destination=self.root/'race.geometry-only.fbx'
        source.write_bytes(trimesh.exchange.gltf.export_glb(source_scene(),include_normals=True))
        original_run=fbx.subprocess.run
        def racing_run(*args,**kwargs):
            result=original_run(*args,**kwargs);destination.write_bytes(b'concurrent owner');return result
        with patch.object(fbx.subprocess,'run',side_effect=racing_run):
            with self.assertRaises(FileExistsError):fbx.export_fbx(source,destination,material_policy='geometry_only')
        self.assertEqual(destination.read_bytes(),b'concurrent owner')
        self.assertFalse(list(self.root.glob('.native3d-fbx-*')))

    def test_no_overwrite_and_malformed_input(self):
        source = self.root / 'bad.fbx'
        source.write_bytes(b'not an fbx file')
        dest = self.root / 'out.glb'
        dest.write_bytes(b'keep')
        with self.assertRaisesRegex(ValueError, 'new destination'):
            fbx.import_fbx(source, dest)
        self.assertEqual(dest.read_bytes(), b'keep')
        dest.unlink()
        with self.assertRaisesRegex(ValueError, 'rejected'):
            fbx.import_fbx(source, dest)
        self.assertFalse(dest.exists())


if __name__ == '__main__':
    unittest.main()
