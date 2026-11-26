import unittest
import numpy as np
import trimesh
from native3d_uv_structure import structural_stages,MODE,_macro_turn,_chains,connected_open_seam_groups
from native3d_uv_plan import settings,candidate_plan,DEFAULTS,LEGACY_REASONS,REASONS


def sheet(x,y,height):
    xx,yy=np.meshgrid(x,y);v=np.column_stack((xx.ravel(),yy.ravel(),height(xx,yy).ravel()))
    n=len(x);a=(np.arange(len(y)-1)[:,None]*n+np.arange(n-1)[None,:]).ravel()
    f=np.vstack((np.column_stack((a,a+1,a+n+1)),np.column_stack((a,a+n+1,a+n))))
    return trimesh.Trimesh(v,f,process=False)


def fold(degrees=90,concave=False):
    return sheet(np.linspace(-.5,.5,11),np.linspace(-1,1,25),
        lambda x,y:abs(x)*np.tan(np.radians(degrees/2))*(1 if concave else -1))


class StructureTests(unittest.TestCase):
    def signals(self,mesh,darkness=.8,supported=True):
        n=len(mesh.faces);return np.ones(n),np.full(n,supported,bool),np.full(n,darkness)

    def params(self):return settings({'seamPlanningMode':MODE,'orientationConfirmed':True})

    def test_true_convex_fold_and_concave_groove_have_distinct_reasons(self):
        for concave,reason in [(False,'convex_structural'),(True,'concave_structural')]:
            mesh=fold(concave=concave);before=mesh.vertices.copy()
            result,report=structural_stages(mesh,self.params(),*self.signals(mesh))
            self.assertGreater(len(result[reason]),10)
            opposite='convex_structural' if concave else 'concave_structural'
            self.assertEqual(result[opposite],set());np.testing.assert_array_equal(mesh.vertices,before)
            self.assertGreater(next(x for x in report['stages'] if x['reason']==reason)['retainedChains'],0)

    def test_ao_only_supplements_supported_real_moderate_concavity(self):
        mesh=fold(40,concave=True)
        result,_=structural_stages(mesh,self.params(),*self.signals(mesh))
        self.assertEqual(result['concave_structural'],set())
        self.assertGreater(len(result['ao_supported_signed_concave']),10)
        for darkness,supported in [(.1,True),(.8,False)]:
            result,_=structural_stages(mesh,self.params(),*self.signals(mesh,darkness,supported))
            self.assertEqual(result['ao_supported_signed_concave'],set())

    def test_flat_shadow_and_dark_convex_do_not_gain_ao_seams(self):
        plane=sheet(np.linspace(-1,1,15),np.linspace(-1,1,15),lambda x,y:np.zeros_like(x))
        result,_=structural_stages(plane,self.params(),*self.signals(plane,.99))
        self.assertTrue(all(not edges for edges in result.values()))
        mesh=fold();result,_=structural_stages(mesh,self.params(),*self.signals(mesh,.99))
        self.assertEqual(result['ao_supported_signed_concave'],set())

    def test_small_scale_rock_noise_is_not_cut_at_every_large_local_angle(self):
        # Grain period is below the declared physical structure radius and the
        # radius spans several edges, matching the actual 100k source scale.
        axis=np.linspace(-.3,.3,121)
        mesh=sheet(axis,axis,lambda x,y:.002*np.cos(np.pi*x/.005)*np.cos(np.pi*y/.005))
        result,report=structural_stages(mesh,self.params(),*self.signals(mesh))
        raw=sum(x['rawAngleEdges'] for x in report['stages'][:2]);kept=sum(len(value) for value in result.values())
        self.assertGreater(raw,1000)
        self.assertLess(kept,raw*.05)

    def test_near_disconnected_shell_cannot_supply_macro_support(self):
        v=np.array([[-.01,0,0],[.01,0,0],[0,.01,.01],[0,-.01,.01]])
        f=np.array([[0,1,2],[1,0,3]])
        tiny=trimesh.Trimesh(v,f,process=False)
        _,before=_macro_turn(tiny,np.array([0]),.1)
        other=trimesh.Trimesh(v*3+[0,0,.002],f,process=False)
        combined=trimesh.util.concatenate((tiny,other))
        key=np.flatnonzero(np.all(combined.face_adjacency_edges==[0,1],axis=1))[0]
        _,after=_macro_turn(combined,np.array([key]),.1)
        self.assertFalse(before[0]);self.assertFalse(after[key])

    def varying_fold(self):
        return sheet(np.linspace(-.5,.5,11),np.linspace(-1,1,41),
            lambda x,y:-abs(x)*np.where(y<0,np.tan(np.radians(30)),np.tan(np.radians(15))))

    def test_hysteresis_extends_real_weak_ridge_only_from_strong_seed(self):
        mesh=self.varying_fold();result,report=structural_stages(mesh,self.params(),*self.signals(mesh))
        edges=np.asarray(sorted(result['convex_structural']),np.int64)
        midpoint=mesh.vertices[edges].mean(axis=1)
        self.assertTrue(np.any((abs(midpoint[:,0])<1e-12)&(midpoint[:,1]>.25)))
        record=next(x for x in report['stages'] if x['reason']=='convex_structural')
        self.assertGreater(record['retainedStrongEdges'],0);self.assertGreater(record['retainedContinuationEdges'],0)
        self.assertEqual(record['continuationAngleDegrees'],22.5)
        lookup={tuple(sorted(map(int,e))):bool(c) for e,c in zip(mesh.face_adjacency_edges,mesh.face_adjacency_convex)}
        for edge in result['convex_structural']:self.assertTrue(lookup[edge])
        for edge in result['concave_structural']:self.assertFalse(lookup[edge])
        pure=fold(30)
        result,report=structural_stages(pure,self.params(),*self.signals(pure))
        self.assertTrue(all(not value for value in result.values()))
        self.assertTrue(all(row['strongSeedEdges']==0 for row in report['stages']))

    def test_seed_chain_does_not_cross_ai_or_unknown_partition(self):
        mesh=self.varying_fold();confidence,supported,darkness=self.signals(mesh)
        for unknown in (False,True):
            labels=np.where(mesh.triangles_center[:,1]>0,-1 if unknown else 1,0).astype(np.int32)
            mask=supported.copy()
            if unknown:mask[labels<0]=False
            protected={tuple(sorted(map(int,e))) for pair,e in zip(mesh.face_adjacency,mesh.face_adjacency_edges) if labels[pair[0]]!=labels[pair[1]]}
            result,_=structural_stages(mesh,self.params(),confidence,mask,darkness,protected_edges=protected,region_labels=labels)
            edges=np.asarray(sorted(result['convex_structural']),np.int64).reshape(-1,2)
            midpoint=mesh.vertices[edges].mean(axis=1)
            self.assertFalse(np.any((abs(midpoint[:,0])<1e-12)&(midpoint[:,1]>.25)))
            self.assertFalse(set(result['convex_structural'])&protected)

    def test_excluded_bridge_cannot_connect_seedless_weak_component(self):
        mesh=fold();all_edges=mesh.face_adjacency_edges
        line=np.flatnonzero(np.all(abs(mesh.vertices[all_edges][:,:,0])<1e-12,axis=1))
        order=np.argsort(mesh.vertices[all_edges[line]].mean(axis=1)[:,1]);line=line[order]
        selected=np.delete(line,len(line)//2)
        retained,report=_chains(mesh,selected,.04,.02,seeds=line[:1])
        self.assertTrue(set(retained).issubset(set(line[:len(line)//2])))
        self.assertGreater(len(retained),0);self.assertEqual(report['seededChains'],1)

    def test_open_internal_seam_remains_same_group_and_is_really_cut_by_parameterizer(self):
        from native3d_uv_slim import parameterize_groups
        mesh=sheet(np.linspace(-1,1,5),np.linspace(-1,1,5),lambda x,y:np.zeros_like(x))
        reasons={(6,7):'convex_structural'};before=dict(reasons)
        groups,receipt=connected_open_seam_groups(mesh,[np.arange(len(mesh.faces))],reasons)
        self.assertEqual(len(groups),1);self.assertEqual(receipt['openInternalReasonEdges'],1)
        self.assertEqual(reasons,before)
        result,uv,source,sf,_=parameterize_groups(mesh,groups,reasons)
        np.testing.assert_array_equal(source[result.faces],mesh.faces[sf])
        lookup=np.argsort(sf);corners=[]
        for fi,face in enumerate(mesh.faces):
            if {6,7}.issubset(face):corners.append({int(result.faces[lookup[fi],int(np.flatnonzero(face==v)[0])]) for v in (6,7)})
        # An open slit may retain one shared tip vertex. The actual edge must
        # split, rather than requiring an artificial second endpoint cut.
        self.assertEqual(len(corners),2);self.assertNotEqual(corners[0],corners[1])
        self.assertFalse(any(set(source[e])=={6,7} for e in result.face_adjacency_edges))

    def test_closed_real_seam_splits_components_without_inventing_edges(self):
        mesh=sheet(np.linspace(-1,1,5),np.linspace(-1,1,5),lambda x,y:np.zeros_like(x))
        reasons={edge:'concave_structural' for edge in ((6,7),(7,12),(11,12),(6,11))}
        groups,receipt=connected_open_seam_groups(mesh,[np.arange(len(mesh.faces))],reasons)
        self.assertEqual(len(groups),2);self.assertEqual(sorted(map(len,groups)),[2,30])
        self.assertEqual(receipt['separatingReasonEdges'],4)
        self.assertEqual(len(reasons),4)

    def test_ai_base_partition_keeps_unknown_bridge_protected(self):
        from native3d_uv import groups_from_edges
        mesh=sheet(np.linspace(-1,1,7),np.linspace(-1,1,5),lambda x,y:np.zeros_like(x))
        center=mesh.triangles_center[:,0];labels=np.where(center<-.2,0,np.where(center>.2,1,-1))
        base=groups_from_edges(mesh,{},partition_labels=labels)
        groups,receipt=connected_open_seam_groups(mesh,base,{})
        self.assertEqual(len(groups),len(base))
        base_owner=np.empty(len(mesh.faces),int)
        for i,group in enumerate(base):base_owner[group]=i
        for group in groups:
            self.assertEqual(len(np.unique(base_owner[group])),1)
            self.assertLessEqual(len(set(labels[group][labels[group]>=0])),1)
        self.assertGreater(receipt['crossBaseAdjacencyProtected'],0)

    def test_ai_boundary_priority_and_legacy_defaults(self):
        mesh=fold(concave=True);confidence,supported,darkness=self.signals(mesh)
        labels=(mesh.triangles_center[:,0]>0).astype(np.int32)
        reasons,groups,report=candidate_plan(mesh,self.params(),labels,confidence,supported,darkness,return_statistics=True)
        self.assertGreater(report['aiBoundaryEdges'],0)
        for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
            if labels[pair[0]]!=labels[pair[1]]:self.assertEqual(reasons[tuple(sorted(map(int,edge)))],'high_surface_region_boundary')
        self.assertEqual(settings({}),DEFAULTS)
        self.assertEqual(settings({})['aoDarknessThreshold'],1.)
        self.assertNotIn('seamPlanningMode',settings({}))
        self.assertEqual(REASONS[:5],LEGACY_REASONS)
        self.assertEqual(self.params()['aoDarknessThreshold'],.2)
        self.assertEqual(self.params()['concaveAngleDegrees'],45.)
        with self.assertRaises(ValueError):settings({'convexAngleDegrees':45})

    def test_inconsistent_and_inward_winding_are_rejected(self):
        mesh=fold();mesh.faces[0]=mesh.faces[0,::-1]
        with self.assertRaisesRegex(ValueError,'winding'):structural_stages(mesh,self.params(),*self.signals(mesh))
        mesh=trimesh.creation.box();mesh.invert()
        with self.assertRaisesRegex(ValueError,'outward|inward'):structural_stages(mesh,self.params(),*self.signals(mesh))


if __name__=='__main__':unittest.main()
