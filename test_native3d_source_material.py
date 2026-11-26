"""Analytic source-frame, filtering and projection-tap transfer checks."""
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import numpy as np
import trimesh
from PIL import Image
from native3d_source_material import SourceMaterial, bilinear, filtered_source_normals
from native3d_bake_basis import build_bake_basis, encode_world_normals, unit


def source(uv=None):
    mesh = trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]], [[0,1,2]], process=False)
    mesh.vertex_normals = np.tile([0.,0.,1.], (3,1))
    mesh.visual = trimesh.visual.TextureVisuals(uv=uv if uv is not None else [[0,0],[1,0],[0,1]],
        material=trimesh.visual.material.PBRMaterial(
            normalTexture=Image.fromarray(np.tile(np.array([204,179,217],np.uint8),(2,2,1))),
            occlusionTexture=Image.fromarray(np.tile(np.array([64,64,64],np.uint8),(2,2,1)))))
    mesh.metadata.update(nativeSourceUV=True,nativeMaterials=[{'normalTexture':{},'occlusionTexture':{'strength':.5}}])
    return mesh


class SourceMaterialTests(unittest.TestCase):
    def test_degenerate_source_face_keeps_other_material_channels_and_masks_normal(self):
        from native3d_engine import bake
        mesh=source();vertices=np.vstack([mesh.vertices,np.asarray(mesh.vertices)+[2,0,0]])
        high=trimesh.Trimesh(vertices,[[0,1,2],[3,4,5]],process=False)
        high.vertex_normals=np.tile([0,0,1.],(6,1))
        high.visual=trimesh.visual.TextureVisuals(uv=[[0,0],[1,0],[0,1],[.5,.5],[.5,.5],[.5,.5]],material=mesh.visual.material)
        high.metadata.update(mesh.metadata)
        material=SourceMaterial(high)
        np.testing.assert_array_equal(material.basis['validFaces'],[True,False])
        self.assertEqual(material.report['sourceFrameValidity']['invalidFaceIds'],[1])
        self.assertEqual(material.sample('occlusionTexture',[1],[[.2,.2]])[0,0],64/255)
        with self.assertRaisesRegex(ValueError,'normal frame is invalid'):
            material.world_normals([1],[[.2,.2]])
        low=trimesh.Trimesh([[.1,.1,.01],[.3,.1,.01],[.1,.3,.01],
                            [2.1,.1,.01],[2.3,.1,.01],[2.1,.3,.01]],[[0,1,2],[3,4,5]],process=False)
        low.visual=trimesh.visual.TextureVisuals(uv=[[.05,.05],[.15,.05],[.05,.15],[.5,.5],[.6,.5],[.5,.6]])
        low.metadata['nativeSourceUV']=True
        with tempfile.TemporaryDirectory() as temporary:
            out=Path(temporary)
            report=bake(low,high,out,{'resolution':1024,'aoSamples':8,'rayDistance':.02})
            hits=np.asarray(Image.open(out/'hits.png'))>0
            normals=np.asarray(Image.open(out/'normal-valid.png'))>0
            invalid=hits&~normals
            self.assertGreater(int(invalid.sum()),1000);self.assertGreater(int(normals.sum()),1000)
            np.testing.assert_array_equal(np.asarray(Image.open(out/'normal.png'))[invalid],np.tile([128,128,255],(int(invalid.sum()),1)))
            np.testing.assert_allclose(np.asarray(Image.open(out/'ao.png'))[invalid],159,atol=1)
            self.assertEqual(report['sourceMaterialTransfer']['projectedNormalInvalidTexels'],int(invalid.sum()))
            self.assertFalse(report['sourceMaterialTransfer']['normalComplete'])
            self.assertFalse(report['projectionQuality']['automaticAcceptance'])

    def test_real_bake_changed_uv_uses_source_normal_and_source_only_ao(self):
        from native3d_engine import bake, read_mesh
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); high=source();high.export(root/'source.glb')
            high=read_mesh((root/'source.glb').resolve())
            high.metadata['nativeMaterials'][0]['occlusionTexture']['strength']=.5
            low=trimesh.Trimesh([[.1,.1,.01],[.3,.1,.01],[.1,.3,.01]],[[0,1,2]],process=False)
            low.visual=trimesh.visual.TextureVisuals(uv=[[.05,.05],[.05,.15],[.15,.05]])
            low.metadata['nativeSourceUV']=True;before=high.vertex_normals.copy()
            out=root/'bake';out.mkdir()
            progress_events=[]
            with patch('native3d_bake_ao.sample_high_surface_ao',side_effect=AssertionError('source AO must not multiply geometry AO')):
                report=bake(low,high,out,{'resolution':1024,'aoSamples':8,'rayDistance':.02},
                            progress_callback=lambda stage,percent:progress_events.append((stage,percent)))
            self.assertEqual(progress_events[0],('bake_faces_0_of_1',25))
            self.assertEqual(progress_events[-1],('bake_faces_1_of_1',80))
            hit=np.asarray(Image.open(out/'hits.png'))>0
            self.assertGreater(int(hit.sum()),1000)
            np.testing.assert_allclose(np.median(np.asarray(Image.open(out/'normal.png'))[hit],axis=0),(unit(np.array([[179,204,217]])/255*2-1)[0]*.5+.5)*255,atol=1)
            np.testing.assert_allclose(np.asarray(Image.open(out/'ao.png'))[hit],159,atol=1)
            np.testing.assert_array_equal(high.vertex_normals,before)
            self.assertIn('source-only',report['sourceMaterialTransfer']['ao'])

    def test_srgb_decode_precedes_filter_and_batches_repeat(self):
        pixels=np.array([[[0,0,0],[255,255,255]]],np.uint8)
        coords=np.tile([.5,.5],(4101,1))
        np.testing.assert_allclose(bilinear(pixels,coords,srgb=True),.5)
        np.testing.assert_allclose(bilinear(pixels,coords+1,srgb=True),.5)

    def test_changed_low_uv_rotates_source_normal_instead_of_copying_rgb(self):
        mesh=source();before=mesh.vertex_normals.copy();sample=SourceMaterial(mesh)
        weights=np.array([[.5,.25,.25]])
        world=sample.world_normals([0],[[.25,.25]])
        raw=unit(np.array([[204,179,217]])/255*2-1)
        # Existing reference-derived glTF Mikk worker negates sign once.
        np.testing.assert_allclose(world,raw,atol=1e-6)
        low_uv=np.array([[0,0],[0,1],[1,0]])
        low=build_bake_basis(mesh.vertices,mesh.faces,low_uv,mesh.vertex_normals)
        encoded=encode_world_normals(world,low['normals'][low['faces'][0]],low['tangents'][low['faces'][0]],weights)
        np.testing.assert_allclose(encoded,np.column_stack([raw[:,1],raw[:,0],raw[:,2]]),atol=1e-6)
        np.testing.assert_array_equal(mesh.vertex_normals,before)

    def test_mirrored_source_uv_handedness_and_ao(self):
        sample=SourceMaterial(source([[1,0],[0,0],[1,1]]))
        raw=unit(np.array([[204,179,217]])/255*2-1)
        np.testing.assert_allclose(sample.world_normals([0],[[.2,.3]]),raw*[-1,1,1],atol=1e-6)
        ao=sample.sample('occlusionTexture',[0],[[.2,.3]])[:,0]
        np.testing.assert_allclose(1+sample.ao_strength*(ao-1),.5+.5*64/255)
        self.assertIn('source-only',sample.report['ao'])

    def test_invalid_face_ids_never_sample_last_triangle(self):
        sample=SourceMaterial(source())
        for ids in ([-1],[2],[4294967295]):
            with self.assertRaisesRegex(ValueError,'Invalid source face'):
                sample.world_normals(ids,[[.2,.2]])

    def test_original_grazing_normals_are_preserved_without_low_cone_repair(self):
        mesh=source();mesh.vertex_normals=np.tile(unit([0,1,.01]),(3,1))
        before=mesh.vertex_normals.copy();sample=SourceMaterial(mesh)
        np.testing.assert_allclose(sample.basis['normals'],before,atol=1e-12)
        np.testing.assert_array_equal(mesh.vertex_normals,before)
        mesh.metadata['nativeSourceTangentDeclared']=True
        with self.assertRaisesRegex(ValueError,'TANGENT retention'):
            SourceMaterial(mesh)

    def test_normal_uses_each_valid_aa_projection_tap_and_ignores_misses(self):
        sample=SourceMaterial(source());seen=[]
        original=sample.world_normals
        def track(ids,uv):
            seen.extend(np.asarray(uv).tolist());return original(ids,uv)
        sample.world_normals=track
        calls=[]
        def query(points,normals):
            calls.append(1);valid=np.array([len(calls)!=2])
            return {'points':points,'valid':valid,'primitive_ids':np.array([0 if valid[0] else -1]),
                    'primitive_uvs':points[:,:2], 'primitive_normals':np.tile([0.,0.,1.],(len(points),1))}
        output,valid,report=filtered_source_normals([[1,1]],np.array([[0,0],[4,0],[0,4]]),
            np.array([[0,0,0],[1,0,0],[0,1,0]]),sample.faces,np.tile([0,0,1],(3,1)),.1,query,
            np.tile([0,0,1],(3,1)),source_material=sample)
        self.assertTrue(valid[0]);self.assertEqual(report['validTaps'],3);self.assertEqual(len(seen),3)
        self.assertEqual(len({tuple(x) for x in seen}),3)
        np.testing.assert_allclose(output,original([0],[[.2,.2]]),atol=1e-6)


if __name__ == '__main__':unittest.main()
