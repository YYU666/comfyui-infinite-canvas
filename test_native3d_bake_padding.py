import copy
import json
from pathlib import Path
import struct
import tempfile
import unittest
from types import SimpleNamespace
import numpy as np
import trimesh
from PIL import Image
from native3d_bake_padding import compatible,freeze_padding_reuse,derive_padding,digest,validate_context
from native3d_material_atlas import BAKE_TEXTURES
from native3d_engine import bake,export_glb
from test_native3d_source_material import source

class PaddingReuseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.root=Path(cls.temp.name)
        cls.old=cls.root/'old';cls.old.mkdir();cls.fresh=cls.root/'fresh';cls.fresh.mkdir()
        def low():
            mesh=trimesh.Trimesh([[.1,.1,.01],[.3,.1,.01],[.1,.3,.01]],[[0,1,2]],process=False)
            mesh.visual=trimesh.visual.TextureVisuals(uv=[[.05,.05],[.05,.15],[.15,.05]]);mesh.metadata['nativeSourceUV']=True
            return mesh
        cls.params={'resolution':1024,'aoSamples':8,'rayDistance':.02,'padding':8}
        mesh=low();report=bake(mesh,source(),cls.old,cls.params);export_glb(mesh,cls.old/'model.glb')
        bake(low(),source(),cls.fresh,{**cls.params,'padding':64})
        cls.prior={'id':'old','projectId':'p','operation':'bake','status':'succeeded','createdAt':1,
                   'source':{'sha256':'low','highSha256':'high'},'parameters':cls.params,
                   'result':{'metadata':{'bake':report,'sourceSha256':'low','highSourceSha256':'high'},
                             'files':[{'name':n,'sha256':digest(cls.old/n)} for n in ('model.glb', *(name+'.png' for name in BAKE_TEXTURES))]}}
        cls.job={'id':'new','projectId':'p','operation':'bake','source':cls.prior['source'],
                 'parameters':{**cls.params,'padding':64}}
    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()
    def context(self, prior=None):
        directory=Path(tempfile.mkdtemp(dir=self.root));manager=SimpleNamespace(jobs={'old':prior or self.prior},_safe_file=lambda job,name:self.old/name)
        return freeze_padding_reuse(manager,self.job,directory)
    def test_cached_matches_fresh_pixels_and_preserves_attributes(self):
        context=self.context();out=Path(tempfile.mkdtemp(dir=self.root));report=derive_padding(context,self.job,out)
        for path in self.fresh.glob('*.png'):
            np.testing.assert_array_equal(np.asarray(Image.open(path)),np.asarray(Image.open(out/path.name)),err_msg=path.name)
        old=trimesh.load(self.old/'model.glb',force='mesh',process=False);new=trimesh.load(out/'model.glb',force='mesh',process=False)
        np.testing.assert_array_equal(old.vertices,new.vertices);np.testing.assert_array_equal(old.faces,new.faces)
        np.testing.assert_array_equal(old.visual.uv,new.visual.uv);np.testing.assert_array_equal(old.vertex_normals,new.vertex_normals)
        def attributes(path):
            raw=path.read_bytes();n=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+n]);binary=raw[28+n:];attrs=doc['meshes'][0]['primitives'][0]['attributes'];result={}
            for key,index in attrs.items():
                accessor=doc['accessors'][index];view=doc['bufferViews'][accessor['bufferView']];offset=view.get('byteOffset',0);result[key]=binary[offset:offset+view['byteLength']]
            return result
        self.assertEqual(attributes(self.old/'model.glb'),attributes(out/'model.glb'));self.assertIn('TANGENT',attributes(out/'model.glb'))
        self.assertEqual(report['projectionQuality'],self.prior['result']['metadata']['bake']['projectionQuality'])
        self.assertTrue(report['paddingReuse']['allCoveredPixelsExact']);self.assertIsNone(report['paddingReuse']['priorAlgorithmCodeSha256'])
        self.assertEqual(report['bakeSettings']['paddingRequested'],64)
        self.assertEqual(report['dilation'],{**report['dilation'],'pixels':64,'requestedPixels':64,'automatic':False,'changedTexels':report['paddingReuse']['outsideCoveredTexelsDilated']})
        self.assertEqual(report['bakeSettings']['padding'],64)
        from native3d_glb_layout import read_glb_document
        from native3d_material_atlas import shares_orm_storage
        doc = read_glb_document(out/'model.glb')
        self.assertTrue(shares_orm_storage(doc, doc['materials'][0]))
        with Image.open(out/'orm.png') as atlas:
            pixels = np.asarray(atlas)
            for channel, name in enumerate(('ao','roughness','metallic')):
                with Image.open(out/(name+'.png')) as component:
                    np.testing.assert_array_equal(pixels[..., channel], np.asarray(component))

    def test_legacy_receipt_without_curvature_keeps_its_provenance(self):
        prior = copy.deepcopy(self.prior)
        prior['result']['files'] = [entry for entry in prior['result']['files'] if entry['name'] != 'curvature.png']
        prior['result']['metadata']['bake'].pop('curvature')
        context = self.context(prior)
        out = Path(tempfile.mkdtemp(dir=self.root))
        report = derive_padding(context, self.job, out)
        self.assertNotIn('curvature.png', report['paddingReuse']['priorArtifactSha256'])
        self.assertFalse((out/'curvature.png').exists())
        self.assertTrue((out/'orm.png').is_file())

    def test_modern_missing_declared_curvature_requires_fresh_bake(self):
        prior = copy.deepcopy(self.prior)
        prior['result']['files'] = [entry for entry in prior['result']['files'] if entry['name'] != 'curvature.png']
        self.assertIsNone(self.context(prior))

    def test_incompatible_requests_rejected(self):
        for change in ({'projectId':'wrong'},{'source':{'sha256':'different','highSha256':'high'}},{'source':{'sha256':'low','highSha256':'different'}},{'parameters':{**self.job['parameters'],'aoSamples':16}},{'parameters':{**self.job['parameters'],'resolution':2048}},{'parameters':{**self.job['parameters'],'padding':4}}):
            altered={**self.job,**change};self.assertFalse(compatible(self.prior,altered))
            with self.assertRaises(ValueError):validate_context(self.context(),altered)
    def test_tampered_snapshot_rejected(self):
        context=self.context();path=Path(context['files']['ao.png']['path']);path.write_bytes(path.read_bytes()+b'tampered')
        with self.assertRaisesRegex(ValueError,'checksum'):validate_context(context,self.job)
    def test_covered_misses_are_never_filled(self):
        from native3d_bake_padding import repad_arrays
        coverage=np.zeros((8,8),np.uint8);coverage[2:6,2:6]=255;hits=coverage.copy();hits[3,3]=0
        pixels=np.zeros((8,8,3),np.uint8);pixels[hits!=0]=[80,90,100];pixels[3,3]=[128,128,255]
        output,_=repad_arrays({'normal':pixels},coverage,hits,64)
        np.testing.assert_array_equal(output['normal'][coverage!=0],pixels[coverage!=0])
        np.testing.assert_array_equal(output['normal'][0,0],[80,90,100])

if __name__=='__main__':unittest.main()
