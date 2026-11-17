"""Pure geometry fixtures; no services, subprocesses, or managed paths."""
import copy
import math
import unittest
from pcg_contracts import PCGError
from pcg_geometry import (evaluate, validate_geometry, summarize, mesh, cross, sub,
                          dot, add, mul, MAX_TRIANGLES, MAX_POINTS)
from pcg_fields import binding, field


def op(name, parameters=None, **inputs):
    return evaluate(name, parameters or {}, inputs)


def box(): return op('primitive')['geometry']


class GeometryTests(unittest.TestCase):
    def test_primitive_winding_and_manifold(self):
        for kind in ('box','sphere','cylinder'):
            g=op('primitive',{'kind':kind,'subdivisions':2})['geometry']
            edges={}
            for a,b,c in g['triangles']:
                n=cross(sub(g['positions'][b],g['positions'][a]),sub(g['positions'][c],g['positions'][a]))
                center=mul(add(add(g['positions'][a],g['positions'][b]),g['positions'][c]),1/3)
                self.assertGreater(dot(n,center),0,kind)
                for x,y in ((a,b),(b,c),(c,a)):
                    key=tuple(sorted((x,y)));edges.setdefault(key,[]).append((x,y))
            self.assertTrue(all(len(v)==2 and v[0]==tuple(reversed(v[1])) for v in edges.values()),kind)
            self.assertEqual(len(g['normals']),len(g['triangles'])*3)
            validate_geometry(g)

    def test_cylinder_corner_uv_seam_and_cap_projection(self):
        size=[4,3,2]
        for levels in (0,1,3):
            segments=8*2**levels
            g=op('primitive',{'kind':'cylinder','size':size,'subdivisions':levels})['geometry']
            for face,tri in enumerate(g['triangles']):
                uv=g['uvs'][face*3:face*3+3]
                if face%4 < 2:
                    self.assertAlmostEqual(max(p[0] for p in uv)-min(p[0] for p in uv),1/segments)
                    self.assertTrue(all(p[1] in (0,1) for p in uv))
                    if face//4 == segments-1:self.assertIn(1,[p[0] for p in uv])
                else:
                    for index,corner in zip(tri,uv):
                        self.assertEqual(corner,[g['positions'][index][0]/size[0]+.5,g['positions'][index][2]/size[2]+.5])
                    a,b,c=uv
                    area2=abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))
                    self.assertAlmostEqual(area2,.25*math.sin(2*math.pi/segments))
                    self.assertGreater(area2,0)

    def test_plane_normals_and_size(self):
        g=op('primitive',{'kind':'plane','size':[4,1,2],'subdivisions':2})['geometry']
        self.assertEqual(summarize(g)['bounds'],{'min':[-2,0,-1],'max':[2,0,1]})
        self.assertTrue(all(n==[0,1,0] for n in g['normals']))

    def test_four_rocks_deterministic_different_real_geometry(self):
        hashes=[]
        for seed in (17,31,43,59):
            params={'seed':seed,'subdivisions':3}
            g=op('rock',params)['geometry']
            self.assertEqual(g,op('rock',params)['geometry'])
            hashes.append(binding(g)['contentHash'])
            for a,b,c in g['triangles']:
                n=cross(sub(g['positions'][b],g['positions'][a]),sub(g['positions'][c],g['positions'][a]))
                center=mul(add(add(g['positions'][a],g['positions'][b]),g['positions'][c]),1/3)
                self.assertGreater(dot(n,center),0)
        self.assertEqual(len(set(hashes)),4)
        self.assertNotEqual(op('rock',{'seed':17})['geometry']['positions'],op('rock',{'seed':31})['geometry']['positions'])

    def test_high_roughness_rock_keeps_closed_radial_surface(self):
        for seed in (0,5,8,13,23):
            g=op('rock',{'seed':seed,'roughness':.4,'subdivisions':2})['geometry']
            for a,b,c in g['triangles']:
                n=cross(sub(g['positions'][b],g['positions'][a]),sub(g['positions'][c],g['positions'][a]))
                center=mul(add(add(g['positions'][a],g['positions'][b]),g['positions'][c]),1/3)
                self.assertGreater(dot(n,center),0)

    def test_transform_rotation_reflection_normal_winding(self):
        g=op('transform',{'translation':[3,2,1],'rotation':[0,math.pi/2,0],'scale':[-2,1,3]},geometry=box())['geometry']
        for f,(a,b,c) in enumerate(g['triangles']):
            normal=cross(sub(g['positions'][b],g['positions'][a]),sub(g['positions'][c],g['positions'][a]))
            self.assertGreater(dot(normal,g['normals'][f*3]),0)
        bounds=summarize(g)['bounds']
        self.assertAlmostEqual(bounds['min'][0],1.5)
        self.assertAlmostEqual(bounds['max'][2],2)

    def test_subdivide_shared_edges_corner_uv(self):
        g=box();s=op('subdivide',{'levels':1},geometry=g)['geometry']
        self.assertEqual(len(s['positions']),26)
        self.assertEqual(len(s['triangles']),48)
        self.assertEqual(len(s['uvs']),144)
        self.assertNotEqual(binding(g)['topologyHash'],binding(s)['topologyHash'])

    def test_join_offsets_and_uv_loss_rejected(self):
        a=box();b=op('transform',{'translation':[3,0,0]},geometry=a)['geometry']
        joined=op('join_geometry',a=a,b=b)['geometry']
        self.assertEqual(joined['triangles'][12],[i+8 for i in b['triangles'][0]])
        self.assertEqual(op('compose',a=a,b=b)['geometry'],joined)
        b['uvs']=[]
        with self.assertRaises(PCGError): op('join_geometry',a=a,b=b)

    def test_arbitrary_field_graph_not_recipe(self):
        g=op('primitive',{'kind':'plane','subdivisions':2})['geometry']
        positions=op('attribute_read',geometry=g)['field']
        noise=op('noise_field',{'seed':9,'amplitude':.1},geometry=g,position=positions)['field']
        offset=op('field_math',{'operation':'multiply','value':.25},a=noise)['field']
        x=op('field_math',{'operation':'component_x'},a=positions)['field']
        positive=op('compare',{'value':0},field=x)['selection']
        every=op('selection',{'mode':'every_n'},geometry=g)['selection']
        chosen=op('selection',{'mode':'and'},geometry=g,a=positive,b=every)['selection']
        moved=op('set_position',geometry=g,offset=offset,selection=chosen)['geometry']
        for i,p in enumerate(g['positions']):
            self.assertEqual(moved['positions'][i]!=p,chosen['values'][i])
        final=op('recompute_normals',geometry=moved)['geometry']
        inspected=op('inspect_geometry',geometry=final)
        self.assertEqual(op('publish_geometry',geometry=inspected['geometry'])['geometry'],final)
        self.assertEqual(inspected['report']['counts']['Face'],32)

    def test_field_wrong_source_corner_and_topology_rejected(self):
        g=box();offset=op('noise_field',geometry=g)['field']
        other=op('transform',{'translation':[1,0,0]},geometry=g)['geometry']
        for target in (other,op('subdivide',geometry=g)['geometry']):
            with self.assertRaises(PCGError) as caught: op('set_position',geometry=target,offset=offset)
            self.assertEqual(caught.exception.code,'FIELD_BINDING_MISMATCH')
        corner=op('attribute_read',{'name':'normal'},geometry=g)['field']
        with self.assertRaises(PCGError) as caught: op('set_position',geometry=g,offset=corner)
        self.assertEqual(caught.exception.code,'FIELD_DOMAIN_MISMATCH')

    def test_scatter_area_weighted_deterministic(self):
        g=mesh([[0,0,0],[1,0,0],[0,0,1],[10,0,0],[13,0,0],[10,0,3]],[[0,2,1],[3,5,4]])
        result=op('scatter_points',{'count':10000,'seed':42},geometry=g)['points']
        self.assertEqual(result,op('scatter_points',{'count':10000,'seed':42},geometry=g)['points'])
        larger=sum(p[0]>=10 for p in result['positions'])
        self.assertTrue(8800<larger<9200)
        self.assertTrue(all(p[1]==0 for p in result['positions']))
        self.assertNotEqual(result,op('scatter_points',{'count':10000,'seed':43},geometry=g)['points'])

    def test_scatter_spacing_slope_height_constraints(self):
        g=op('primitive',{'kind':'plane','size':[10,1,10]})['geometry']
        params={'count':80,'seed':21,'minDistance':.5,'maxSlope':0,'minHeight':0,'maxHeight':0}
        points=op('scatter_points',params,geometry=g)['points']['positions']
        self.assertEqual(len(points),80)
        for i,p in enumerate(points):
            self.assertEqual(p[1],0)
            for q in points[:i]:self.assertGreaterEqual(dot(sub(p,q),sub(p,q)),.25)
        tilted=op('transform',{'rotation':[math.pi/4,0,0]},geometry=g)['geometry']
        with self.assertRaises(PCGError) as caught:op('scatter_points',{'count':1,'maxSlope':20},geometry=tilted)
        self.assertEqual(caught.exception.code,'INSUFFICIENT_PLACEMENT')
        accepted=op('scatter_points',{'count':40,'seed':2,'maxSlope':50,'minHeight':.1,'maxHeight':1},geometry=tilted)['points']
        self.assertTrue(all(.1<=p[1]<=1 for p in accepted['positions']))
        recipe=op('scatter',dict(params,scale=[.2,.2,.2]),geometry=g,prototype=box())['instances']
        self.assertEqual([x['translation'] for x in recipe['instances']],points)

    def test_scatter_constraints_fail_without_partial_result(self):
        g=op('primitive',{'kind':'plane'})['geometry']
        for params in ({'count':3,'minDistance':10},{'count':1,'minHeight':1},{'count':1,'minHeight':2,'maxHeight':1}):
            with self.assertRaises(PCGError):op('scatter_points',params,geometry=g)
        self.assertEqual(op('scatter_points',{'count':0,'minHeight':1},geometry=g)['points']['positions'],[])

    def test_instance_preservation_transform_and_realize(self):
        points={'contractVersion':1,'type':'PointSet','positions':[[0,0,0],[3,0,0],[6,0,0]]}
        instances=op('instance_on_points',points=points,prototype=box())['instances']
        self.assertEqual(len(instances['prototype']['positions']),8)
        moved=op('instance_transform',{'translation':[0,2,0],'rotation':[0,.5,0],'scale':[2,2,2]},instances=instances)['instances']
        self.assertEqual([x['id'] for x in moved['instances']],['point:0','point:1','point:2'])
        self.assertEqual(moved['instances'][1]['translation'],[3*2*math.cos(.5),2,-3*2*math.sin(.5)])
        real=op('realize_instances',instances=moved)['geometry']
        self.assertEqual(len(real['positions']),24);self.assertEqual(len(real['triangles']),36)
        self.assertEqual(real['triangles'][12],[i+8 for i in box()['triangles'][0]])
        with self.assertRaises(PCGError): op('instance_transform',{'scale':[2,1,1]},instances=instances)

    def test_recipe_uses_same_scatter(self):
        g=box();prototype=op('primitive',{'kind':'sphere'})['geometry']
        recipe=op('scatter',{'count':5,'seed':2},geometry=g,prototype=prototype)['instances']
        pts=op('scatter_points',{'count':5,'seed':2},geometry=g)['points']
        self.assertEqual(recipe,op('instance_on_points',points=pts,prototype=prototype)['instances'])

    def test_budgets_before_explosive_allocations(self):
        with self.assertRaises(PCGError) as caught: op('subdivide',{'levels':6},geometry=op('primitive',{'subdivisions':2})['geometry'])
        self.assertEqual(caught.exception.code,'BUDGET_EXCEEDED')
        points={'contractVersion':1,'type':'PointSet','positions':[[0,0,0]]*9000}
        instances=op('instance_on_points',points=points,prototype=box())['instances']
        with self.assertRaises(PCGError) as caught: op('realize_instances',instances=instances)
        self.assertEqual(caught.exception.code,'BUDGET_EXCEEDED')
        with self.assertRaises(PCGError): op('scatter_points',{'count':MAX_POINTS+1},geometry=box())

    def test_summary_is_bounded_and_immutable(self):
        g=op('primitive',{'subdivisions':3})['geometry'];report=summarize(g)
        self.assertEqual(len(report['samples']),64)
        report['samples'][0][0]=999
        self.assertNotEqual(report['samples'][0],g['positions'][0])
        self.assertEqual(len(summarize(box())['samples']),8)

    def test_malformed_values_and_closed_parameters(self):
        for modification in ('nan','indices','normal','extra','bool'):
            g=box()
            if modification=='nan':g['positions'][0][0]=float('nan')
            if modification=='indices':g['triangles'][0]=[0,1,999]
            if modification=='normal':g['normals'][0]=[0,0,2]
            if modification=='extra':g['path']='arbitrary'
            if modification=='bool':g['triangles'][0][0]=True
            with self.assertRaises(PCGError): validate_geometry(g)
        for params in ({'kind':'code'},{'size':[0,1,1]},{'size':[True,1,1]},{'script':'1+1'}):
            with self.assertRaises(PCGError): op('primitive',params)
        with self.assertRaises(PCGError):op('game_asset')


if __name__ == '__main__': unittest.main()
