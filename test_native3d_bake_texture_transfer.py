"""Real textured high-source bake with distant uncovered receiver geometry."""
import tempfile,unittest
from pathlib import Path
import numpy as np
import trimesh
from PIL import Image
from native3d_engine import bake,read_mesh

class TexturedMissIntegrationTests(unittest.TestCase):
 def test_real_basecolor_mr_hit_and_far_miss_are_not_uintmax_indexed(self):
  with tempfile.TemporaryDirectory() as temporary:
   root=Path(temporary)
   high=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]],process=False)
   base=np.tile(np.array([255,128,64],np.uint8),(4,4,1));mr=np.tile(np.array([0,200,100],np.uint8),(4,4,1))
   high.visual=trimesh.visual.TextureVisuals(uv=[[0,0],[1,0],[0,1]],material=trimesh.visual.material.PBRMaterial(baseColorTexture=Image.fromarray(base),metallicRoughnessTexture=Image.fromarray(mr),baseColorFactor=[.25,.5,1,1],roughnessFactor=.5,metallicFactor=.25))
   high.export(root/'actual-textured-high.glb');high=read_mesh(root/'actual-textured-high.glb')
   low=trimesh.Trimesh([[.1,.1,.01],[.3,.1,.01],[.1,.3,.01],[100,100,0],[100.2,100,0],[100,100.2,0]],[[0,1,2],[3,4,5]],process=False)
   low.visual=trimesh.visual.TextureVisuals(uv=[[.05,.05],[.15,.05],[.05,.15],[.7,.7],[.8,.7],[.7,.8]])
   low.metadata['nativeSourceUV']=True;before=low.vertices[low.faces].copy();beforeuv=low.visual.uv[low.faces].copy();output=root/'output';output.mkdir()
   result=bake(low,high,output,{'resolution':1024,'aoSamples':8,'rayDistance':.02})
   # Analytic sRGB transfer: red linear1*.25 ->137, green sRGB128
   # converted to linear then multiplied by.5 ->92, blue unchanged64.
   hit=np.array(Image.open(output/'hits.png'))>0;coverage=np.array(Image.open(output/'coverage.png'))>0;missing=coverage&~hit
   color=np.array(Image.open(output/'basecolor.png'));rough=np.array(Image.open(output/'roughness.png'));metal=np.array(Image.open(output/'metallic.png'))
   self.assertGreater(int(hit.sum()),1000);self.assertGreater(int(missing.sum()),1000)
   np.testing.assert_allclose(np.median(color[hit],axis=0),[137,92,64],atol=2)
   np.testing.assert_allclose(np.median(rough[hit]),100,atol=1);np.testing.assert_allclose(np.median(metal[hit]),25,atol=1)
   self.assertEqual(result['hitSamples'],int(hit.sum()));self.assertEqual(result['missSamples'],int(missing.sum()))
   self.assertFalse(result['projectionQuality']['completeProjection']);self.assertFalse(result['projectionQuality']['automaticAcceptance']);self.assertEqual(result['projectionQuality']['status'],'needs_review')
   # Geometric receiver far beyond any bounded fallback remains a miss. Texture
   # read fallback must neither crash onUINT_MAX nor copy a valid high color.
   self.assertEqual(int(hit[:350,650:].sum()),0)
   np.testing.assert_array_equal(low.vertices[low.faces],before);np.testing.assert_array_equal(low.visual.uv[low.faces],beforeuv)

if __name__=='__main__':unittest.main()
