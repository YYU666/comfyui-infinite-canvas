import json
from pathlib import Path
import struct
import tempfile
import unittest
import numpy as np
import trimesh
from native3d_bake_basis import build_bake_basis, repair_source_normal_cones, encode_world_normals, interpolated_basis, unit, uv_raster_coordinates


def curved_fixture():
    uv = np.array([[x, y] for y in np.linspace(0, 1, 3) for x in np.linspace(0, 1, 3)])
    x, y = uv.T
    vertices = np.column_stack([x, y, .6*x*x + .4*x*y + .3*y*y])
    normals = unit(np.column_stack([-(1.2*x+.4*y), -(.4*x+.6*y), np.ones(len(x))]))
    faces = []
    for row in range(2):
        for col in range(2):
            i = row*3+col; faces.extend([[i,i+1,i+4],[i,i+4,i+3]])
    return vertices, np.asarray(faces), uv, normals


def bilinear(image, uv):
    r = len(image); xy = uv_raster_coordinates(uv, r)-.5
    low = np.floor(xy).astype(int); frac = xy-low
    x,y = low.T; x1=np.clip(x+1,0,r-1);y1=np.clip(y+1,0,r-1);x=np.clip(x,0,r-1);y=np.clip(y,0,r-1)
    return (image[y,x]*(1-frac[:,0,None])*(1-frac[:,1,None])+image[y,x1]*frac[:,0,None]*(1-frac[:,1,None])
            +image[y1,x]*(1-frac[:,0,None])*frac[:,1,None]+image[y1,x1]*frac[:,0,None]*frac[:,1,None])


class BakeBasisTests(unittest.TestCase):
    def test_invalid_source_normal_fan_minimal_group_repair_and_infeasible_rejection(self):
        # Two UV-separated triangles share a smooth source-normal group; one
        # face points slightly behind that normal, as in the real source fan.
        v=np.array([[0.,0,0],[1,0,0],[0,1,0],[0,0,0],[0,1,0],[.2,0,1]])
        f=np.array([[0,1,2],[3,4,5]])
        normals=np.array([[0.,0,1],[0,0,1],[0,0,1],[0,0,1],[1,0,-.2],[1,0,-.2]])
        repaired,report=repair_source_normal_cones(v,f,normals)
        self.assertEqual(report['changedGroups'],1);self.assertEqual(report['changedSourceVertexIds'],[0,3]);self.assertEqual(report['invalidCornersAfter'],0)
        np.testing.assert_array_equal(repaired[0],repaired[3]);np.testing.assert_allclose(repaired[[1,2,4,5]],unit(normals)[[1,2,4,5]])
        self.assertGreater(report['maxChangeDegrees'],1);self.assertGreaterEqual(report['minimumIncidentFaceDotAfter'],.0009)
        # A folded fan with exactly opposing incident faces cannot have a
        # common stable hemisphere; reject instead of assigning mixed signs.
        folded=np.array([[0.,0,0],[1,0,0],[0,1,0],[0,0,0],[0,1,0],[1,0,0]])
        with self.assertRaisesRegex(ValueError,'no stable|could not'):
            repair_source_normal_cones(folded,f,np.array([[0.,0,1]]*6))

    def test_infeasible_fan_splits_only_normal_attributes_and_preserves_corners(self):
        v=np.array([[0.,0,0],[1,0,0],[0,1,0],[-1,0,0],[0,1,0]])
        f=np.array([[0,1,2],[0,3,4]])
        uv=np.array([[0.,0],[1,0],[0,1],[-1,0],[0,-1]])
        n=np.array([[0.,0,1],[0,0,1],[0,0,1],[0,0,-1],[0,0,-1]])
        before=(v.copy(),f.copy(),uv.copy(),n.copy())
        result=build_bake_basis(v,f,uv,n);source=result['sourceVertex'];out=result['faces']
        np.testing.assert_array_equal(v[source][out],v[f]);np.testing.assert_array_equal(uv[source][out],uv[f])
        for old,new in zip(before,(v,f,uv,n)):np.testing.assert_array_equal(old,new)
        self.assertNotEqual(out[0,0],out[1,0])
        self.assertTrue(result['normalRepair']['newNormalSeams'])
        self.assertEqual(result['normalRepair']['normalSplitAdditionalVertices'],1)
        np.testing.assert_array_equal(result['normals'][out[0]],np.tile([0.,0,1],(3,1)))
        np.testing.assert_array_equal(result['normals'][out[1]],np.tile([0.,0,-1],(3,1)))
        self.assertTrue(np.all(result['tangents'][out,3]==result['tangents'][out[:,:1],3]))

    def test_feasible_projection_not_rejected_for_solver_status_alone(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        from native3d_bake_basis import _project_normal_cone
        with patch('scipy.optimize.minimize',return_value=SimpleNamespace(success=False,x=np.array([0.,0,1]))):
            np.testing.assert_array_equal(_project_normal_cone(np.array([[0.,0,1]]),np.array([1.,0,0])),[0,0,1])

    def test_inverse_matches_three_nonorthogonal_interpolation(self):
        v,f,uv,n = curved_fixture(); basis=build_bake_basis(v,f,uv,n)
        weights=np.array([[.2,.3,.5],[.1,.8,.1]])
        target=unit(np.tile([.15,-.2,1.],(len(weights),1)))
        frame=interpolated_basis(basis['normals'][basis['faces'][0]],basis['tangents'][basis['faces'][0]],weights)
        encoded=encode_world_normals(target,basis['normals'][basis['faces'][0]],basis['tangents'][basis['faces'][0]],weights)
        np.testing.assert_allclose(unit(np.einsum('nij,nj->ni',frame,encoded)),target,atol=1e-12)
        wrong=unit(np.einsum('nji,nj->ni',frame,target))
        self.assertGreater(np.max(np.linalg.norm(unit(np.einsum('nij,nj->ni',frame,wrong))-target,axis=1)),1e-4)

    def test_mirrored_corners_split_without_changing_positions_uv_or_normals(self):
        v=np.array([[0.,0,0],[1,0,0],[0,1,.2],[0,-1,.2]])
        f=np.array([[0,1,2],[0,3,1]])
        uv=np.array([[0.,0],[1,0],[0,1],[0,1]])
        n=unit(np.array([[0.,0,1]]*4))
        result=build_bake_basis(v,f,uv,n);source=result['sourceVertex'];out=result['faces']
        self.assertEqual(len(source),6)
        np.testing.assert_array_equal(v[source][out],v[f]);np.testing.assert_array_equal(uv[source][out],uv[f])
        np.testing.assert_allclose(result['normals'][out],n[f]);self.assertTrue(np.all(result['tangents'][out[0],3]==-result['tangents'][out[1],3]))

    def test_uv_pixel_centers_exact(self):
        for r in [512,1024]:
            xy=np.array([[0.,0],[r-1,r-1],[12,31]])
            uv=(xy+.5)/r;uv[:,1]=1-uv[:,1]
            np.testing.assert_allclose(uv_raster_coordinates(uv,r),xy+.5,atol=1e-12)

    def test_constant_world_normal_filtered_across_curved_triangles_512_1024(self):
        v,f,uv,n=curved_fixture();result=build_bake_basis(v,f,uv,n)
        np.testing.assert_array_equal(result['faces'],f);np.testing.assert_array_equal(result['sourceVertex'],np.arange(len(v)))
        target=unit(np.array([.12,-.25,1.]));errors=[]
        for r in [512,1024]:
            image=np.zeros((r,r,3));frame_data=[]
            for face in result['faces']:
                tex=uv_raster_coordinates(uv[face],r);matrix=(tex[1:]-tex[0]).T
                lo=np.maximum(np.floor(tex.min(0)).astype(int),0);hi=np.minimum(np.ceil(tex.max(0)).astype(int),r-1)
                xx,yy=np.meshgrid(np.arange(lo[0],hi[0]+1),np.arange(lo[1],hi[1]+1));xy=np.column_stack([xx.ravel(),yy.ravel()])
                b=(xy+.5-tex[0])@np.linalg.inv(matrix).T;w=np.column_stack([1-b.sum(1),b]);inside=np.min(w,axis=1)>=-1e-10;xy=xy[inside];w=w[inside]
                encoded=encode_world_normals(np.tile(target,(len(w),1)),result['normals'][face],result['tangents'][face],w)
                image[xy[:,1],xy[:,0]]=np.clip(np.floor((encoded*.5+.5)*255),0,255)/255*2-1
            # Evaluate either side of every shared edge at sub-texel offsets.
            adj={}
            for fi,face in enumerate(f):
                for a,b in [(0,1),(1,2),(2,0)]: adj.setdefault(tuple(sorted([int(face[a]),int(face[b])])),[]).append(fi)
            for edge,faces in adj.items():
                if len(faces)!=2:continue
                decoded=[]
                for fi in faces:
                    face=f[fi];opposite=next(i for i in face if i not in edge)
                    weights=[]
                    for t in [.15,.35,.5,.65,.85]:
                        w=np.zeros(3);w[np.where(face==edge[0])[0][0]]=(1-t)*(1-.05/r);w[np.where(face==edge[1])[0][0]]=t*(1-.05/r);w[np.where(face==opposite)[0][0]]=.05/r;weights.append(w)
                    weights=np.asarray(weights);sample=bilinear(image,weights@uv[face]);frame=interpolated_basis(result['normals'][face],result['tangents'][face],weights)
                    world=unit(np.einsum('nij,nj->ni',frame,sample));decoded.append(world)
                    errors.extend(np.degrees(np.arccos(np.clip(world@target,-1,1))))
                jump=np.degrees(np.arccos(np.clip(np.einsum('ij,ij->i',*decoded),-1,1)))
                self.assertLess(jump.max(),.15,f'continuous world-normal edge jump at {r}')
        self.assertLess(max(errors),1.0,'8-bit encoded constant world normal must remain accurate across edges')
        print('512/1024 curved continuous-edge fixture max target error degrees:',max(errors))

    def test_glb_exports_same_normal_tangent_and_corner_geometry(self):
        from native3d_engine import export_glb, read_mesh, simplify
        v,f,uv,n=curved_fixture();basis=build_bake_basis(v,f,uv,n);source=basis['sourceVertex']
        mesh=trimesh.Trimesh(vertices=v[source],faces=basis['faces'],process=False,vertex_normals=basis['normals'])
        mesh.visual=trimesh.visual.TextureVisuals(uv=uv[source]);mesh.vertex_attributes['_TANGENT']=basis['tangents']
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'fixture.glb';export_glb(mesh,path);blob=path.read_bytes();size=struct.unpack('<I',blob[12:16])[0];doc=json.loads(blob[20:20+size]);attrs=doc['meshes'][0]['primitives'][0]['attributes']
            def read(key,width):
                accessor=doc['accessors'][attrs[key]];view=doc['bufferViews'][accessor['bufferView']];offset=28+size+view.get('byteOffset',0)+accessor.get('byteOffset',0)
                return np.frombuffer(blob,dtype='<f4',count=accessor['count']*width,offset=offset).reshape(-1,width)
            np.testing.assert_array_equal(read('NORMAL',3),basis['normals']);np.testing.assert_array_equal(read('TANGENT',4),basis['tangents'])
            loaded=trimesh.load(path,force='mesh',process=False);np.testing.assert_allclose(loaded.vertices[loaded.faces],v[f]);np.testing.assert_allclose(loaded.visual.uv[loaded.faces],uv[f])
            imported=read_mesh(path)
            np.testing.assert_allclose(imported.vertex_normals,basis['normals'],atol=1e-7)
            proxy=simplify(mesh,100000)
            np.testing.assert_array_equal(proxy.vertex_normals,mesh.vertex_normals)
            np.testing.assert_array_equal(proxy.vertex_attributes['_TANGENT'],mesh.vertex_attributes['_TANGENT'])
            proxy_path=Path(temporary)/'proxy.glb';export_glb(proxy,proxy_path)
            proxy_loaded=read_mesh(proxy_path)
            np.testing.assert_allclose(proxy_loaded.vertex_normals[proxy_loaded.faces],imported.vertex_normals[imported.faces],atol=1e-7)
            np.testing.assert_array_equal(proxy_loaded.visual.uv[proxy_loaded.faces],imported.visual.uv[imported.faces])
            self.assertEqual(proxy_path.read_bytes(),blob,'unchanged proxy must export identical GLB NORMAL/TANGENT/UV')


if __name__=='__main__':unittest.main()
