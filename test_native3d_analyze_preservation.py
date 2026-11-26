"""Bounded analyze GLB imports preserve baked attributes and node transforms."""
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
import trimesh
import native3d_engine as engine


def fixture(path, faces=1, invalid=None):
    mesh=trimesh.Trimesh([[0.,0,0],[1,0,0],[0,1,0]],np.tile([[0,1,2]],(faces,1)),process=False,
                         vertex_normals=np.tile([0.,0,1],(3,1)))
    mesh.visual=trimesh.visual.TextureVisuals(uv=[[0,0],[1,0],[0,1]])
    mesh.vertex_attributes['_TANGENT']=np.tile([1.,0,0,1],(3,1))
    def tree(doc):
        for primitive in doc['meshes'][0]['primitives']:
            primitive['attributes']['TANGENT']=primitive['attributes'].pop('_TANGENT')
        node=next(n for n in doc['nodes'] if 'mesh' in n)
        node['matrix']=[2,0,0,0, 0,3,0,0, 0,0,4,0, 5,6,7,1]
        if invalid=='uri':doc['buffers'][0]['uri']='external.bin'
        if invalid=='animation':doc['animations']=[{}]
    path.write_bytes(trimesh.exchange.gltf.export_glb(mesh,include_normals=True,tree_postprocessor=tree))


class AnalyzePreservationTests(unittest.TestCase):
    def run_analysis(self, source, output):
        with patch.object(engine,'poster'),patch.object(engine,'memory_gate',return_value={}),patch('native3d_fbx.capabilities',return_value={'available':False}):
            return engine.run({'sourcePath':str(source),'operation':'analyze','parameters':{}},output)

    def test_baked_attributes_nonunit_transform_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.glb';fixture(source);before=source.read_bytes()
            loaded=engine.read_mesh(source)
            np.testing.assert_allclose(loaded.bounds,[[5,6,7],[7,9,7]])
            result=self.run_analysis(source,root/'out')
            self.assertEqual(source.read_bytes(),before)
            for name in ['model.glb','proxy.glb']:
                self.assertEqual((root/'out'/name).read_bytes(),before)
                np.testing.assert_allclose(engine.read_mesh(root/'out'/name).bounds,loaded.bounds)
            self.assertTrue(result['metadata']['glbPreservation']['bytePreserved'])
            self.assertIn('original node transforms',result['metadata']['sourceTransform'])
            with self.assertRaisesRegex(ValueError,'overwrite'):
                self.run_analysis(source,root/'out')

    def test_triangle_threshold_and_non_glb_fallback(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for count in [100000,100001,300000,300001]:
                source=root/f'{count}.glb';fixture(source,count)
                small=trimesh.Trimesh([[0.,0,0],[1,0,0],[0,1,0]],[[0,1,2]],process=False)
                with patch.object(engine,'simplify',return_value=small),patch.object(engine,'quality',return_value={}):
                    result=self.run_analysis(source,root/str(count))
                if count<=300000:
                    self.assertEqual((root/str(count)/'model.glb').read_bytes(),source.read_bytes())
                else:
                    self.assertNotIn('glbPreservation',result['metadata'])
                    self.assertLess(len(engine.read_mesh(root/str(count)/'model.glb').faces),count)
            source=root/'source.obj';source.write_text('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')
            self.assertNotIn('glbPreservation',self.run_analysis(source,root/'obj')['metadata'])

    def test_non_analyze_keeps_export_path(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'source.glb';fixture(source)
            with patch.object(engine,'poster'),patch.object(engine,'memory_gate',return_value={}),patch('native3d_fbx.capabilities',return_value={'available':False}),patch.object(engine,'bake',return_value={'tangentBasis':'fixture','padding':16}) as bake:
                result=engine.run({'sourcePath':str(source),'highSourcePath':str(source),'operation':'bake','parameters':{}},root/'out')
            bake.assert_called_once()
            self.assertNotIn('glbPreservation',result['metadata'])
            self.assertNotEqual((root/'out'/'model.glb').read_bytes(),source.read_bytes())

    def test_restrictions_are_not_bypassed(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for invalid,message in [('uri','URI dependencies'),('animation','Animated/skinned')]:
                source=root/f'{invalid}.glb';fixture(source,invalid=invalid)
                with self.assertRaisesRegex(ValueError,message):self.run_analysis(source,root/invalid)
                self.assertFalse((root/invalid/'model.glb').exists())


if __name__=='__main__':unittest.main()
