import unittest
from pathlib import Path
import tempfile
import hashlib
import threading
from unittest.mock import Mock, patch
import numpy as np
import trimesh
from native3d_uv_preview import uv_edges, render_mesh, SEAM, BOUNDARY
from native3d_jobs import Native3DJobs
from project_store import StoreError


def fixture(discontinuous=False, z=0):
    vertices=[[-1,-1,z],[1,-1,z],[1,1,z],[-1,-1,z],[1,1,z],[-1,1,z]]
    uv=np.array([[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]],float)
    if discontinuous: uv[3:]+=.17
    mesh=trimesh.Trimesh(vertices=vertices,faces=[[0,1,2],[3,4,5]],process=False)
    mesh.visual=trimesh.visual.TextureVisuals(uv=uv)
    return mesh

class UVPreviewTests(unittest.TestCase):
    def test_exact_100k_preview_budget_is_explicit_and_bounded(self):
        from native3d_report import rasterize, camera_for_bounds
        n=224
        x,y=np.meshgrid(np.arange(n+1),np.arange(n+1))
        vertices=np.column_stack((x.ravel(),y.ravel(),np.zeros(x.size)))
        cells=(y[:-1,:-1]*(n+1)+x[:-1,:-1]).ravel()
        faces=np.concatenate((np.column_stack((cells,cells+1,cells+n+2)),
                              np.column_stack((cells,cells+n+2,cells+n+1))))[:100000]
        mesh=trimesh.Trimesh(vertices=vertices,faces=faces,process=False)
        mesh.visual=trimesh.visual.TextureVisuals(uv=vertices[:,:2]/n)
        with self.assertRaises(ValueError):uv_edges(mesh)
        uv,seams,boundaries=uv_edges(mesh,max_faces=100000)
        self.assertEqual(len(mesh.faces),100000)
        self.assertEqual(len(uv),len(vertices));self.assertEqual(seams,[])
        self.assertGreater(len(boundaries),0)
        camera=camera_for_bounds(mesh.bounds,32,32)
        with self.assertRaises(ValueError):rasterize(mesh,camera)
        _,_,owners=rasterize(mesh,camera,max_faces=100000,return_buffers=True)
        self.assertTrue(np.any(owners>=0))
        too_many=mesh.copy();too_many.faces=np.vstack((faces,faces[0]))
        with self.assertRaises(ValueError):uv_edges(too_many,max_faces=100000)
        with self.assertRaises(ValueError):rasterize(too_many,camera,max_faces=100000)
        with self.assertRaises(ValueError):uv_edges(mesh,max_faces=100001)

    def test_duplicated_vertices_and_boundary_classification(self):
        _,seams,boundaries=uv_edges(fixture())
        self.assertEqual((len(seams),len(boundaries)),(0,4))
        _,seams,boundaries=uv_edges(fixture(True))
        self.assertEqual((len(seams),len(boundaries)),(1,4))

    def test_uv_changes_both_real_previews(self):
        for mode in ('seams','checker'):
            a=np.array(render_mesh(fixture(),mode)); b=np.array(render_mesh(fixture(True),mode))
            self.assertGreater(np.count_nonzero(a[40:]!=b[40:]),100)
        pixels=np.array(render_mesh(fixture(True),'seams'))[40:]
        self.assertTrue(np.any(np.all(pixels==SEAM,axis=2)))
        self.assertTrue(np.any(np.all(pixels==BOUNDARY,axis=2)))

    def test_hidden_seam_is_occluded(self):
        rear=fixture(True,z=-.5); front=fixture(False,z=.5)
        mesh=trimesh.util.concatenate([rear,front])
        pixels=np.array(render_mesh(mesh,'seams'))[40:]
        self.assertFalse(np.any(np.all(pixels==SEAM,axis=2)))

    def test_invalid_uv_rejected(self):
        mesh=fixture(); mesh.visual=trimesh.visual.ColorVisuals(mesh)
        with self.assertRaises(ValueError): render_mesh(mesh,'checker')
        mesh=fixture(); mesh.visual.uv[0,0]=np.nan
        with self.assertRaises(ValueError): uv_edges(mesh)

    def test_triangle_budget_and_api_png(self):
        mesh=fixture(); mesh.faces=np.tile(mesh.faces,(10001,1))
        with self.assertRaises(ValueError): uv_edges(mesh)
        from native3d_api import Native3DAPI
        import io
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'preview.png'; path.write_bytes(b'PNG fixture')
            jobs=Mock(); jobs.uv_preview.return_value=path
            handler=Mock(); handler.wfile=io.BytesIO()
            jid='n3d_'+'b'*32
            self.assertTrue(Native3DAPI(jobs).handle_get(handler,f'/api/native3d/jobs/{jid}/uv-preview/checker'))
            jobs.uv_preview.assert_called_once_with(jid,'checker')
            handler.send_header.assert_any_call('Content-Type','image/png')
            self.assertEqual(handler.wfile.getvalue(),b'PNG fixture')

    def test_original_ao_signal_and_reason_colors(self):
        import hashlib
        from native3d_uv_preview import render_ao_mesh
        mesh=fixture()
        dark=np.array([0.,.75])
        evidence={'geometrySha256':hashlib.sha256(np.asarray(mesh.vertices).tobytes()+np.asarray(mesh.faces).tobytes()).hexdigest(),
            'aoGeometry':{'faceDarkness':dark.tolist(),'darknessSha256':hashlib.sha256(dark.astype('<f8').tobytes()).hexdigest()},
            'seamReasons':{'0:2':'ao_supported_signed_concave','0:1':'coarse_normal_block','3:5':'manual_locked'}}
        ao=np.array(render_ao_mesh(mesh,evidence,'ao'))
        cuts=np.array(render_ao_mesh(mesh,evidence,'ao-seams'))
        for color in ((255,103,43),(185,115,255),(245,210,65)):
            self.assertTrue(np.any(np.all(cuts[44:]==color,axis=2)))
        self.assertTrue(np.any(np.all(ao[44:]==[56,56,56],axis=2)))
        moved=mesh.copy(); moved.vertices+=.01
        with self.assertRaises(ValueError): render_ao_mesh(moved,evidence,'ao')
        evidence['aoGeometry']['faceDarkness'][0]=.5
        with self.assertRaises(ValueError): render_ao_mesh(mesh,evidence,'ao')

    def test_ao_service_uses_original_snapshot_and_refuses_non_ao(self):
        import json
        from native3d_engine import read_mesh
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); jid='n3d_'+'c'*32; directory=root/jid; output=directory/'output';output.mkdir(parents=True)
            source=directory/'source.glb'; source.write_bytes(fixture().export(file_type='glb'))
            final=output/'model.glb';final.write_bytes(fixture(True).export(file_type='glb'))
            mesh=read_mesh(source); dark=np.array([0.,.75])
            evidence={'geometrySha256':hashlib.sha256(np.asarray(mesh.vertices).tobytes()+np.asarray(mesh.faces).tobytes()).hexdigest(),
                'aoGeometry':{'backend':'Open3D CPU deterministic cosine hemisphere','faceDarkness':dark.tolist(),'darknessSha256':hashlib.sha256(dark.astype('<f8').tobytes()).hexdigest()},
                'seamReasons':{'0:2':'ao_supported_signed_concave'}}
            job={'operation':'uv','status':'succeeded','parameters':{'seamStrategy':'ao_geometry'},
                'source':{'sha256':hashlib.sha256(source.read_bytes()).hexdigest()},
                'result':{'metadata':{'uv':evidence},'files':[{'name':'model.glb','role':'model','sha256':hashlib.sha256(final.read_bytes()).hexdigest()}]}}
            (directory/'request.json').write_text(json.dumps({**job,'sourcePath':str(source)}),encoding='utf-8')
            service=object.__new__(Native3DJobs);service.root=root;service.preview_lock=threading.Lock();service.get=Mock(return_value=job)
            service.config=Mock(return_value={'pythonExecutable':__import__('sys').executable})
            result=service.uv_preview(jid,'ao');self.assertTrue(result.is_file())
            self.assertEqual(hashlib.sha256(final.read_bytes()).hexdigest(),job['result']['files'][0]['sha256'])
            job['parameters']['seamStrategy']='coherent'
            with self.assertRaises(StoreError) as error: service.uv_preview(jid,'ao')
            self.assertEqual(error.exception.code,'AO_DIAGNOSTIC_UNAVAILABLE')
            job['parameters']['seamStrategy']='ao_geometry';source.write_bytes(b'changed')
            with self.assertRaises(StoreError):service.uv_preview(jid,'ao-seams')

    def test_high_guided_preview_checks_high_snapshot_and_marks_unsupported(self):
        import json
        from native3d_engine import read_mesh
        from native3d_uv_preview import render_ao_mesh
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); jid='n3d_'+'d'*32; directory=root/jid; output=directory/'output';output.mkdir(parents=True)
            source=directory/'source.glb'; source.write_bytes(fixture().export(file_type='glb'))
            high=directory/'high-source.glb'; high.write_bytes(fixture().export(file_type='glb'))
            final=output/'model.glb'; final.write_bytes(fixture(True).export(file_type='glb'))
            mesh=read_mesh(source); dark=np.array([0.,.75]); high_sha=hashlib.sha256(high.read_bytes()).hexdigest()
            evidence={'geometrySha256':hashlib.sha256(np.asarray(mesh.vertices).tobytes()+np.asarray(mesh.faces).tobytes()).hexdigest(),
                'aoGeometry':{'backend':'Open3D CPU high-surface samples projected to target','referenceUsed':True,'referenceSupportedFaces':[True,False],
                    'faceDarkness':dark.tolist(),'darknessSha256':hashlib.sha256(dark.astype('<f8').tobytes()).hexdigest()},
                'seamReasons':{'0:2':'high_surface_region_boundary'}}
            image=np.asarray(render_ao_mesh(mesh,evidence,'ao'))
            self.assertTrue(np.any(np.all(image[44:]==[110,115,125],axis=2)))
            job={'operation':'uv','status':'succeeded','parameters':{'seamStrategy':'coherent','highGuidedEvidence':'validated fixture'},
                'source':{'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'highSha256':high_sha},
                'result':{'metadata':{'uv':evidence,'highSourceSha256':high_sha},'files':[{'name':'model.glb','role':'model','sha256':hashlib.sha256(final.read_bytes()).hexdigest()}]}}
            (directory/'request.json').write_text(json.dumps({**job,'sourcePath':str(source),'highSourcePath':str(high)}),encoding='utf-8')
            service=object.__new__(Native3DJobs);service.root=root;service.preview_lock=threading.Lock();service.get=Mock(return_value=job)
            service.config=Mock(return_value={'pythonExecutable':__import__('sys').executable})
            self.assertTrue(service.uv_preview(jid,'ao').is_file())
            high.write_bytes(b'changed')
            with self.assertRaises(StoreError):service.uv_preview(jid,'ao-seams')

    def test_service_gating_sha_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); jid='n3d_'+'a'*32
            output=root/jid/'output'; output.mkdir(parents=True)
            source=output/'model.glb'; source.write_bytes(fixture(True).export(file_type='glb'))
            digest=hashlib.sha256(source.read_bytes()).hexdigest()
            job={'operation':'uv','status':'succeeded','result':{'files':[{'name':'model.glb','role':'model','sha256':digest}]}}
            service=object.__new__(Native3DJobs); service.root=root; service.preview_lock=threading.Lock()
            service.get=Mock(return_value=job); service.config=Mock(return_value={'pythonExecutable':__import__('sys').executable})
            first=service.uv_preview(jid,'seams')
            self.assertEqual(first.read_bytes()[:8],b'\x89PNG\r\n\x1a\n')
            with patch('native3d_jobs.subprocess.run',side_effect=AssertionError('cache missed')):
                self.assertEqual(first,service.uv_preview(jid,'seams'))
            job['status']='failed'
            with self.assertRaises(StoreError): service.uv_preview(jid,'checker')
            job['status']='succeeded'; job['operation']='repair_lod'
            with self.assertRaises(StoreError): service.uv_preview(jid,'checker')
            job['operation']='uv'; source.write_bytes(b'changed')
            with self.assertRaises(StoreError) as error: service.uv_preview(jid,'checker')
            self.assertEqual(error.exception.code,'SOURCE_CHANGED')

if __name__=='__main__': unittest.main()
