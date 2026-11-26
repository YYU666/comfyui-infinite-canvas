import unittest
from unittest.mock import Mock,patch
import numpy as np
import trimesh
from native3d_uv_perf import ExactGeometryMetrics,UVStageTimer
from native3d_uv import uv_geometry_metrics

class UVPerfTests(unittest.TestCase):
    def setUp(self):
        self.mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]],process=False)
        self.uv=np.array([[.1,.1],[.8,.1],[.1,.8]])
    def test_same_coordinates_one_exact_check_and_identical_result(self):
        checker=Mock(wraps=uv_geometry_metrics);cache=ExactGeometryMetrics(checker)
        first=cache.evaluate(self.mesh,self.uv,1024,8)
        second=cache.evaluate(self.mesh,self.uv.copy(),1024,8)
        self.assertEqual(first,second);self.assertEqual(checker.call_count,1)
        self.assertEqual(second,uv_geometry_metrics(self.mesh,self.uv,1024,8))
        first['geometricOverlapPairs']=999
        self.assertEqual(cache.evaluate(self.mesh,self.uv,1024,8)['geometricOverlapPairs'],0)
    def test_each_input_change_invalidates(self):
        checker=Mock(wraps=uv_geometry_metrics);cache=ExactGeometryMetrics(checker)
        cache.evaluate(self.mesh,self.uv,1024,8)
        self.uv[0,0]=np.nextafter(self.uv[0,0],1.)
        cache.evaluate(self.mesh,self.uv,1024,8)
        cache.evaluate(self.mesh,self.uv,2048,8)
        cache.evaluate(self.mesh,self.uv,2048,9)
        self.mesh.vertices[0,2]=.1
        cache.evaluate(self.mesh,self.uv,2048,9)
        self.mesh.faces[0]=[0,2,1]
        cache.evaluate(self.mesh,self.uv,2048,9)
        self.assertEqual(checker.call_count,6);self.assertEqual(cache.hits,0)
    def test_rejected_candidate_does_not_replace_final_check(self):
        cache=ExactGeometryMetrics(Mock(wraps=uv_geometry_metrics))
        cache.evaluate(self.mesh,self.uv+.3,1024,8)
        final=cache.evaluate(self.mesh,self.uv,1024,8)
        self.assertEqual(cache.calls,2);self.assertEqual(final['geometricOutOfBoundsTriangles'],0)
    def test_coherent_selected_contour_reuses_geometry_but_runs_raster(self):
        from native3d_uv_coherent import coherent_unwrap
        from native3d_uv import uv_metrics
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0]],[[0,1,2]],process=False)
        frozen={'reasons':{},'groups':[np.array([0])],'planSha256':'test','parameterizationBackend':'ai_coarse_harmonic_v3'}
        events=[]
        # A deliberately conservative initial rectangle makes the real valid
        # contour candidate win, without mocking either acceptance checker.
        with patch('native3d_uv_coherent._pack_efficient',return_value=(1.,np.array([[0,0]]),np.array([False]))), \
             patch('native3d_uv.uv_geometry_metrics',wraps=uv_geometry_metrics) as geo, \
             patch('native3d_uv.uv_metrics',wraps=uv_metrics) as raster:
            _,report=coherent_unwrap(mesh,{'resolution':1024,'padding':8,'packingMode':'efficient','alignDirection':'none','orientationConfirmed':True},
                                     _frozen_plan=frozen,progress=lambda *a:events.append(a))
        self.assertEqual(report['contourPackingCandidate'],'selected')
        self.assertEqual(geo.call_count,1);self.assertEqual(raster.call_count,1)
        self.assertEqual(report['geometryCheckReuse']['reused'],1)
        self.assertEqual(report['geometricOverlapPairs'],0)
        self.assertEqual(report['geometricPaddingViolationPairs'],0)
        self.assertIn('uv_final_geometry',report['stageTimingsSeconds'])
        self.assertEqual(len([e for e in events if e[1]=='start']),len([e for e in events if e[1]=='complete']))

    def test_timer_reports_start_complete_and_duration(self):
        events=[]
        with patch('native3d_uv_perf.time.perf_counter',side_effect=[1.,3.,4.,9.]):
            timer=UVStageTimer(lambda *args:events.append(args));timer.enter('a');timer.enter('b');timer.finish()
        self.assertEqual(timer.seconds,{'a':2.,'b':5.})
        self.assertEqual(events,[('a','start',0.),('a','complete',2.),('b','start',0.),('b','complete',5.)])

if __name__=='__main__':unittest.main()
