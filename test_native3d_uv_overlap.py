import unittest
from unittest.mock import patch
import numpy as np
import trimesh
from native3d_uv_overlap import overlap_pairs, conflict_cover, _aabb_candidates
from native3d_uv import unwrap


def _reference_overlap_pairs(mesh,uv):
    """Frozen original quadratic broad phase and exact clipping for parity."""
    tri=np.asarray(uv,dtype=np.float64)[mesh.faces].copy()
    cross=lambda a,b:a[...,0]*b[...,1]-a[...,1]*b[...,0]
    signed=cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0])
    tri[signed<0]=tri[signed<0,::-1]
    low,high=tri.min(1),tri.max(1)
    owner=np.zeros(len(tri),dtype=int)
    for label,faces in enumerate(trimesh.graph.connected_components(mesh.face_adjacency,nodes=np.arange(len(tri)),min_len=1)):
        owner[faces]=label
    pairs=[]
    for i in range(len(tri)):
        candidates=np.flatnonzero(np.all(low[:i]<=high[i],axis=1)&np.all(high[:i]>=low[i],axis=1))
        for j in candidates:
            poly=list(tri[i])
            for k in range(3):
                start=tri[j,k];edge=tri[j,(k+1)%3]-start;output=[]
                if not poly:break
                previous=poly[-1];dp=float(cross(edge,previous-start))
                for point in poly:
                    dc=float(cross(edge,point-start))
                    if (dc>=0)!=(dp>=0):output.append(previous+(point-previous)*(dp/(dp-dc)))
                    if dc>=0:output.append(point)
                    previous,dp=point,dc
                poly=output
            if len(poly)<3:continue
            poly=np.asarray(poly)
            area=float(abs(np.sum(cross(poly,np.roll(poly,-1,axis=0))))*.5)
            if area>1e-12:
                if owner[i]!=owner[j]:raise ValueError('Initial xatlas has inter-chart overlap; bounded intra-chart repair refused')
                pairs.append((int(i),int(j)))
    return pairs


class OverlapIndexTests(unittest.TestCase):
    """Pure cached/array tests; these do not generate an atlas or unwrap UV."""
    def test_random_boxes_complete_with_touches_zero_extents_and_large_offsets(self):
        rng=np.random.default_rng(91)
        for offset in (0.,1e12):
            low=rng.uniform(-1,1,(256,2))+offset
            high=low+rng.uniform(0,.15,(256,2))
            high[::7]=low[::7]
            low[1]=high[0];high[1]=low[1]+.1
            expected={(i,int(j)) for i in range(len(low)) for j in np.flatnonzero(
                np.all(low[:i]<=high[i],axis=1)&np.all(high[:i]>=low[i],axis=1))}
            actual=[(i,int(j)) for i,ids in _aabb_candidates(low,high) for j in ids]
            self.assertEqual(set(actual),expected)
            self.assertEqual(len(actual),len(set(actual)))

    def test_random_connected_meshes_match_original_full_ordered_pair_list(self):
        rng=np.random.default_rng(783)
        count=48
        mesh=trimesh.Trimesh(np.column_stack((np.arange(count+2),np.zeros((count+2,2)))),
                            [[0,i,i+1] for i in range(1,count+1)],process=False)
        for _ in range(5):
            uv=rng.random((count+2,2))
            uv[::9]*=1e-5
            np.testing.assert_array_equal(overlap_pairs(mesh,uv),_reference_overlap_pairs(mesh,uv))

    def test_adjacent_edge_point_touch_and_original_positive_area_threshold(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[0,1,2],[0,2,3]],process=False)
        uv=np.array([[0.,0],[1,0],[1,1],[0,1]])
        self.assertEqual(overlap_pairs(mesh,uv),[])
        for scale,expected in ((1e-6,[]),(2e-6,[(1,0)])):
            uv=np.array([[0.,0],[scale,0],[0,scale],[scale,0]])
            self.assertEqual(overlap_pairs(mesh,uv),expected)
            self.assertEqual(overlap_pairs(mesh,uv),_reference_overlap_pairs(mesh,uv))

    def test_inter_chart_overlap_is_still_rejected(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[0,1,0],[0,0,1],[1,0,1],[0,1,1]],
                            [[0,1,2],[3,4,5]],process=False)
        uv=np.tile([[0.,0],[1,0],[0,1]],(2,1))
        for function in (overlap_pairs,_reference_overlap_pairs):
            with self.assertRaisesRegex(ValueError,'inter-chart overlap'):function(mesh,uv)

    def test_dense_index_has_no_pair_limit(self):
        count=150
        low=np.zeros((count,2));high=np.ones((count,2))
        pairs=[(i,int(j)) for i,ids in _aabb_candidates(low,high) for j in ids]
        self.assertEqual(len(pairs),count*(count-1)//2)


class OverlapRepairTests(unittest.TestCase):
    def test_positive_area_not_shared_edge_and_star_cover(self):
        mesh=trimesh.Trimesh([[0,0,0],[1,0,0],[1,1,0],[0,1,0]],[[0,1,2],[0,2,3]],process=False)
        self.assertEqual(overlap_pairs(mesh,np.array([[.1,.1],[.9,.1],[.9,.9],[.1,.9]])),[])
        self.assertEqual(overlap_pairs(mesh,np.array([[.1,.1],[.9,.1],[.1,.9],[.2,.2]])),[(1,0)])
        pairs=[(10,1),(10,2),(10,3),(20,4),(20,5),(20,6)]
        self.assertEqual(conflict_cover(pairs),[10,20])
        self.assertEqual(conflict_cover(list(reversed(pairs))),[10,20])

    def test_unaffected_input_repeat_is_exact_and_deterministic(self):
        mesh=trimesh.creation.box()
        params={'seamStrategy':'coherent','resolution':1024,'packingMode':'legacy_fixed'}
        a,ra=unwrap(mesh,params);b,rb=unwrap(mesh,params)
        self.assertEqual(ra['overlapRepair']['rounds'],[])
        self.assertEqual(rb['overlapRepair']['rounds'],[])
        np.testing.assert_array_equal(a.vertices,b.vertices)
        np.testing.assert_array_equal(a.faces,b.faces)
        np.testing.assert_array_equal(a.visual.uv,b.visual.uv)

    def test_retry_cuts_conflict_cover_and_preserves_source_mapping(self):
        mesh=trimesh.creation.box();calls=[]
        def initial_conflict(result,uv):
            calls.append(True)
            return [(0,1),(0,2)] if len(calls)==1 else overlap_pairs(result,uv)
        with patch('native3d_uv_overlap.overlap_pairs',side_effect=initial_conflict):
            result,report=unwrap(mesh,{'seamStrategy':'coherent','resolution':1024,'packingMode':'legacy_fixed'})
        self.assertEqual(len(report['overlapRepair']['rounds']),1)
        self.assertEqual(len(report['overlapRepair']['isolatedSourceFaces']),1)
        source=np.asarray(result.metadata['uvSourceVertex']);faces=np.asarray(result.metadata['uvSourceFace'])
        np.testing.assert_array_equal(result.vertices,mesh.vertices[source])
        np.testing.assert_array_equal(source[result.faces],mesh.faces[faces])
        self.assertEqual(report['geometricOverlapPairs'],0)
        self.assertEqual(report['overlapInteriorPixels'],0)

    def test_unresolved_conflict_blocks_instead_of_unbounded_fragmentation(self):
        import io,json
        from contextlib import redirect_stdout
        log=io.StringIO()
        with patch('native3d_uv_overlap.overlap_pairs',return_value=[(0,1)]),redirect_stdout(log):
            with self.assertRaisesRegex(ValueError,'bounded face/round budget'):
                unwrap(trimesh.creation.box(),{'seamStrategy':'coherent','resolution':1024})
        records=[json.loads(line) for line in log.getvalue().splitlines()]
        self.assertTrue(records)
        self.assertEqual(records[-1]['stage'],'uv_overlap_diagnostic')
        self.assertEqual(records[-1]['overlapPairs'],1)
        self.assertEqual(len(records[-1]['conflictSamples']),1)
        self.assertIn('triangleSignedUVAreas',records[-1]['conflictSamples'][0])
        self.assertIn('sourceFaces',records[-1]['conflictSamples'][0])

    def test_final_raster_gate_cannot_be_bypassed_by_geometric_repair(self):
        from native3d_uv import uv_metrics
        def raster_conflict(*args,**kwargs):
            metrics,owner=uv_metrics(*args,**kwargs)
            metrics['overlapInteriorPixels']=1
            return metrics,owner
        with patch('native3d_uv.uv_metrics',side_effect=raster_conflict):
            with self.assertRaisesRegex(ValueError,'final geometric/raster overlap gate'):
                unwrap(trimesh.creation.box(),{'seamStrategy':'coherent','resolution':1024,'packingMode':'legacy_fixed'})


if __name__=='__main__':unittest.main()
