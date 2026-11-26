import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import trimesh
import numpy as np
from native3d_jobs import Native3DJobs
from native3d_api import Native3DAPI
from project_store import StoreError


class PreviewTests(unittest.TestCase):
    def test_stage_renderer_explicit_100k_budget(self):
        from native3d_preview import render
        from PIL import Image
        mesh=trimesh.creation.box()
        mesh.faces=np.tile(mesh.faces,(8334,1))[:100000]
        with tempfile.TemporaryDirectory() as tmp,patch('native3d_preview.read_mesh',return_value=mesh):
            target=Path(tmp)/'poster.png'
            with self.assertRaises(ValueError):render('fixture.glb',target)
            with patch('native3d_preview.rasterize',return_value=Image.new('RGB',(480,360))) as renderer:
                render('fixture.glb',target,max_faces=100000)
                self.assertEqual(renderer.call_args.kwargs['max_faces'],100000)
                self.assertTrue(target.is_file())
            mesh.faces=np.vstack((mesh.faces,mesh.faces[0]))
            with self.assertRaises(ValueError):render('fixture.glb',target,max_faces=100000)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        config = self.root/'config.json'
        config.write_text(json.dumps({'pythonExecutable':sys.executable}))
        self.jobs = Native3DJobs(self.root/'jobs', Mock(), config, autostart=False)
        self.id = 'n3d_'+'a'*32
        out = self.root/'jobs'/self.id/'output'
        out.mkdir(parents=True)
        self.source = out/'fit.glb'
        trimesh.creation.box().export(self.source)
        self.sha = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.job = {'id':self.id,'status':'succeeded','operation':'repair_lod','result':{'metadata':{'geometry':{
            'status':'accepted','stages':[{'stage':'fit','filename':'fit.glb','mesh_hash':'f'*64}]}},
            'files':[{'name':'fit.glb','role':'export','sha256':self.sha}]}}
        self.jobs.jobs[self.id] = self.job

    def tearDown(self):
        self.jobs.close()
        self.temp.cleanup()

    def test_real_poster_cached_without_source_or_project_write(self):
        poster = self.jobs.stage_preview(self.id,'fit')
        self.assertEqual(poster.read_bytes()[:8],b'\x89PNG\r\n\x1a\n')
        with patch('native3d_jobs.subprocess.run',side_effect=AssertionError('cache should avoid rendering')):
            self.assertEqual(self.jobs.stage_preview(self.id,'fit'),poster)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(),self.sha)
        self.assertEqual(self.jobs.store.mock_calls,[])

    def test_truncated_cache_is_regenerated(self):
        poster = self.jobs.stage_preview(self.id,'fit')
        poster.write_bytes(b'\x89PNG\r\n\x1a\n')
        repaired = self.jobs.stage_preview(self.id,'fit')
        self.assertGreater(repaired.stat().st_size,67)
        self.assertTrue(repaired.read_bytes().endswith(b'\x00\x00\x00\x00IEND\xaeB`\x82'))

    def test_invalid_unaccepted_or_changed_source_rejected(self):
        for stage in ['raw_ai','repair','../fit','lod_1200']:
            with self.assertRaises(StoreError): self.jobs.stage_preview(self.id,stage)
        self.job['result']['metadata']['geometry']['status']='blocked'
        with self.assertRaises(StoreError):self.jobs.stage_preview(self.id,'fit')
        self.job['result']['metadata']['geometry']['status']='accepted'
        self.source.write_bytes(b'changed')
        with self.assertRaises(StoreError) as ctx:self.jobs.stage_preview(self.id,'fit')
        self.assertEqual(ctx.exception.code,'SOURCE_CHANGED')

    def test_diagnostic_binds_file_and_loaded_triangle_order(self):
        from native3d_preview import render
        from native3d_engine import read_mesh
        from native3d_geometry import mesh_hash
        from PIL import Image
        mesh=read_mesh(self.source)
        evidence={'meshSha256':self.sha,'geometryHash':mesh_hash(mesh.vertices,mesh.faces),
                  'stage':'lod3','triangles':len(mesh.faces),'intersection_pairs':[[0,1]],
                  'intersectionComplete':False}
        path=self.root/'evidence.json';target=self.root/'diagnostic.png'
        path.write_text(json.dumps(evidence))
        with patch('native3d_lod_diagnostic.render_diagnostic',return_value=Image.new('RGB',(20,20))) as renderer:
            render(self.source,target,diagnostic=path)
            renderer.assert_called_once()
            self.assertEqual(renderer.call_args.args[1],evidence)
        target.unlink()
        reordered=mesh.copy();reordered.faces=np.asarray(mesh.faces)[::-1].copy()
        with patch('native3d_preview.read_mesh',return_value=reordered),patch('native3d_lod_diagnostic.render_diagnostic') as renderer:
            with self.assertRaisesRegex(ValueError,'triangle order/geometry'):
                render(self.source,target,diagnostic=path)
            renderer.assert_not_called()
            self.assertFalse(target.exists())
        evidence['meshSha256']='0'*64;path.write_text(json.dumps(evidence))
        with self.assertRaisesRegex(ValueError,'mesh identity'):
            render(self.source,target,diagnostic=path)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(),self.sha)

    def test_api_serves_verified_png(self):
        file=self.root/'poster.png';file.write_bytes(b'\x89PNG\r\n\x1a\n')
        with patch.object(self.jobs,'stage_preview',return_value=file) as render:
            handler=Mock();handler.wfile=io.BytesIO();handler.path=f'/api/native3d/jobs/{self.id}/stage-preview/fit'
            self.assertTrue(Native3DAPI(self.jobs).handle_get(handler,f'/api/native3d/jobs/{self.id}/stage-preview/fit'))
            render.assert_called_once_with(self.id,'fit',diagnostic=False)
            self.assertEqual(handler.wfile.getvalue(),file.read_bytes())


if __name__=='__main__':unittest.main()
