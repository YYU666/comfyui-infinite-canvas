"""Independent GLB decoder fixtures: bytes/layout/accessors/corner seams/instances."""
import json
import math
import struct
import unittest
from pcg_contracts import PCGError
from pcg_geometry import evaluate, mesh
from pcg_export import export_glb


def decode(data):
    magic,version,total=struct.unpack_from('<4sII',data)
    assert magic==b'glTF' and version==2 and total==len(data)
    offset=12;parts={}
    while offset<len(data):
        length,kind=struct.unpack_from('<I4s',data,offset);offset+=8
        assert length%4==0 and offset+length<=len(data)
        parts[kind]=data[offset:offset+length];offset+=length
    doc=json.loads(parts[b'JSON']);binary=parts.get(b'BIN\x00',b'')
    if 'buffers' in doc:assert len(binary)-3<=doc['buffers'][0]['byteLength']<=len(binary)
    decoded=[]
    for a in doc.get('accessors',[]):
        view=doc['bufferViews'][a['bufferView']];start=view.get('byteOffset',0)+a.get('byteOffset',0)
        width={'SCALAR':1,'VEC2':2,'VEC3':3}[a['type']];fmt={5126:'f',5125:'I'}[a['componentType']]
        assert start%4==0
        assert start+a['count']*width*4<=view.get('byteOffset',0)+view['byteLength']<=len(binary)
        values=struct.unpack_from('<'+str(a['count']*width)+fmt,binary,start)
        rows=[list(values[i:i+width]) for i in range(0,len(values),width)]
        if 'min' in a:
            assert all(abs(min(row[k] for row in rows)-a['min'][k])<1e-5 for k in range(width))
            assert all(abs(max(row[k] for row in rows)-a['max'][k])<1e-5 for k in range(width))
        assert all(math.isfinite(v) for v in values)
        decoded.append(rows)
    return doc,decoded


class ExportTests(unittest.TestCase):
    def test_cube_corner_seams_and_normals_indices(self):
        g=evaluate('primitive',{}, {})['geometry'];raw=export_glb(g)
        self.assertEqual(raw,export_glb(g));doc,arrays=decode(raw)
        primitive=doc['meshes'][0]['primitives'][0];attrs=primitive['attributes']
        positions=arrays[attrs['POSITION']];normals=arrays[attrs['NORMAL']];uvs=arrays[attrs['TEXCOORD_0']]
        indices=[i[0] for i in arrays[primitive['indices']]]
        self.assertEqual(len(positions),24);self.assertEqual(len(uvs),24);self.assertEqual(len(indices),36)
        self.assertEqual(len(set(tuple(p) for p in positions)),8)
        for start in range(0,len(indices),3):
            a,b,c=[positions[i] for i in indices[start:start+3]];normal=normals[indices[start]]
            ab=[b[i]-a[i] for i in range(3)];ac=[c[i]-a[i] for i in range(3)]
            n=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]]
            self.assertGreater(sum(n[i]*normal[i] for i in range(3)),0)
        self.assertEqual(doc['extras'],{'unit':'meter','up':'Y','handedness':'right'})

    def test_corner_uv_split_without_normal_split(self):
        g=mesh([[0,0,0],[1,0,0],[1,0,1],[0,0,1]],[[0,2,1],[0,3,2]],[[0,1,0]]*6,[[0,0],[1,1],[1,0],[.2,.2],[0,1],[1,1]])
        doc,arrays=decode(export_glb(g));a=doc['meshes'][0]['primitives'][0]['attributes']
        self.assertEqual(len(arrays[a['POSITION']]),5)

    def test_decoded_cylinder_uv_seams_and_caps(self):
        size=[4,3,2]
        for levels in (0,2):
            segments=8*2**levels
            g=evaluate('primitive',{'kind':'cylinder','size':size,'subdivisions':levels},{})['geometry']
            doc,arrays=decode(export_glb(g))
            primitive=doc['meshes'][0]['primitives'][0];attributes=primitive['attributes']
            positions=arrays[attributes['POSITION']];uvs=arrays[attributes['TEXCOORD_0']]
            indices=[row[0] for row in arrays[primitive['indices']]]
            for face in range(len(indices)//3):
                corners=indices[face*3:face*3+3];uv=[uvs[i] for i in corners]
                if face%4 < 2:
                    self.assertLessEqual(max(p[0] for p in uv)-min(p[0] for p in uv),1/segments+1e-7)
                    self.assertAlmostEqual(max(p[0] for p in uv)-min(p[0] for p in uv),1/segments,places=6)
                    if face//4==segments-1:self.assertIn(1,[p[0] for p in uv])
                else:
                    for index,corner in zip(corners,uv):
                        self.assertAlmostEqual(corner[0],positions[index][0]/size[0]+.5,places=6)
                        self.assertAlmostEqual(corner[1],positions[index][2]/size[2]+.5,places=6)
                    a,b,c=uv
                    area2=abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))
                    self.assertAlmostEqual(area2,.25*math.sin(2*math.pi/segments),places=6)
                    self.assertGreater(area2,0)

    def test_instances_share_one_mesh_nodes_keep_identity_trs(self):
        prototype=evaluate('primitive',{}, {})['geometry']
        points={'contractVersion':1,'type':'PointSet','positions':[[i,0,0] for i in range(100)]}
        instances=evaluate('instance_on_points',{'scale':[.1,.2,.3]}, {'points':points,'prototype':prototype})['instances']
        raw=export_glb(instances);doc,arrays=decode(raw)
        self.assertEqual(len(doc['meshes']),1);self.assertEqual(len(doc['nodes']),100)
        self.assertEqual({n['mesh'] for n in doc['nodes']},{0})
        self.assertEqual(doc['nodes'][-1]['name'],'point:99');self.assertEqual(doc['nodes'][-1]['translation'],[99,0,0])
        self.assertEqual(doc['nodes'][0]['scale'],[.1,.2,.3])
        real=evaluate('realize_instances',{}, {'instances':instances})['geometry']
        self.assertGreater(len(export_glb(real)),len(raw)*2)

    def test_points_and_empty_scene(self):
        point={'contractVersion':1,'type':'PointSet','positions':[[1,2,3]]}
        doc,arrays=decode(export_glb(point));self.assertEqual(doc['meshes'][0]['primitives'][0]['mode'],0)
        empty={'contractVersion':1,'type':'PointSet','positions':[]}
        doc,arrays=decode(export_glb(empty));self.assertEqual(doc['scenes'],[{}]);self.assertNotIn('buffers',doc)

    def test_unreferenced_points_and_float32_bounds_are_preserved(self):
        g=mesh([[0,0,0],[1,0,0],[0,0,1],[9.123456789,8,7]],[[0,2,1]])
        doc,arrays=decode(export_glb(g));primitive=doc['meshes'][0]['primitives'][0]
        accessor=doc['accessors'][primitive['attributes']['POSITION']]
        self.assertEqual(accessor['max'][0],struct.unpack('<f',struct.pack('<f',9.123456789))[0])
        self.assertEqual(len(arrays[primitive['attributes']['POSITION']]),4)
        doc,arrays=decode(export_glb(mesh([[1,2,3]],[])))
        self.assertEqual(doc['meshes'][0]['primitives'][0]['mode'],0)

    def test_large_translation_precision_collapse_rejected(self):
        g=mesh([[999999,0,0],[999999.001,0,0],[999999,0,.001]],[[0,2,1]])
        with self.assertRaises(PCGError) as caught:export_glb(g)
        self.assertEqual(caught.exception.code,'EXPORT_PRECISION_LOSS')

    def test_four_rocks_export_decode_real_triangles(self):
        outputs=[]
        for seed in (17,31,43,59):
            g=evaluate('rock',{'seed':seed},{})['geometry'];raw=export_glb(g);doc,arrays=decode(raw)
            p=doc['meshes'][0]['primitives'][0]
            self.assertEqual(len(arrays[p['indices']]),len(g['triangles'])*3)
            outputs.append(raw)
        self.assertEqual(len(set(outputs)),4)


if __name__=='__main__':unittest.main()
