"""glTF 2.0 binary writer for bounded geometry, no filesystem or dependencies."""
from __future__ import annotations
import json
import struct
from pcg_geometry import validate_geometry, recompute_normals, cross, sub, dot
from pcg_fields import check

MAX_GLB_BYTES = 64 * 1024 * 1024

def export_glb(value):
    validate_geometry(value)
    document={'asset':{'version':'2.0','generator':'Refmuse PCG stdlib M2'},'scene':0,'scenes':[{'nodes':[]}],'nodes':[],'meshes':[],'buffers':[{'byteLength':0}],'bufferViews':[],'accessors':[],'extras':{'unit':'meter','up':'Y','handedness':'right'}}
    binary=bytearray()
    def accessor(values,width,component_type,target,bounds=False):
        while len(binary)%4: binary.append(0)
        start=len(binary);fmt='f' if component_type == 5126 else 'I'
        flat=[x for value in values for x in value] if width>1 else values
        data=struct.pack('<'+str(len(flat))+fmt,*flat)
        check(len(binary)+len(data) <= MAX_GLB_BYTES,'GLB exceeds byte budget.','BUDGET_EXCEEDED')
        binary.extend(data)
        view=len(document['bufferViews']);document['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(data),'target':target})
        item={'bufferView':view,'byteOffset':0,'componentType':component_type,'count':len(values),'type':{1:'SCALAR',2:'VEC2',3:'VEC3'}[width]}
        if bounds:
            actual=struct.unpack('<'+str(len(flat))+fmt,data)
            item['min']=[min(actual[i::width]) for i in range(width)]
            item['max']=[max(actual[i::width]) for i in range(width)]
        index=len(document['accessors']);document['accessors'].append(item)
        return index
    def add_mesh(geometry):
        if geometry['type'] == 'PointSet' or not geometry['triangles']:
            if not geometry['positions']: return None
            attrs={'POSITION':accessor(geometry['positions'],3,5126,34962,True)}
            primitive={'attributes':attrs,'mode':0}
        else:
            source=geometry if geometry['normals'] else recompute_normals(geometry)
            positions=[];normals=[];uvs=[];indices=[];vertices={}
            # Indexed corners share a GLB vertex only when every exported attribute agrees.
            for corner,index in enumerate(i for tri in source['triangles'] for i in tri):
                normal=source['normals'][corner];uv=source['uvs'][corner] if source['uvs'] else None
                key=(index,tuple(normal),tuple(uv) if uv else None)
                if key not in vertices:
                    vertices[key]=len(positions);positions.append(source['positions'][index]);normals.append(normal)
                    if uv is not None: uvs.append(uv)
                indices.append(vertices[key])
            used={i for tri in source['triangles'] for i in tri}
            for i,p in enumerate(source['positions']):
                if i not in used:
                    positions.append(p);normals.append([0,1,0])
                    if source['uvs']:uvs.append([0,0])
            rounded=[list(struct.unpack('<3f',struct.pack('<3f',*p))) for p in positions]
            for i in range(0,len(indices),3):
                a,b,c=[rounded[k] for k in indices[i:i+3]]
                n=cross(sub(b,a),sub(c,a))
                check(dot(n,n)>1e-30,'Float32 export would collapse a triangle.','EXPORT_PRECISION_LOSS')
            attrs={'POSITION':accessor(positions,3,5126,34962,True),'NORMAL':accessor(normals,3,5126,34962)}
            if uvs: attrs['TEXCOORD_0']=accessor(uvs,2,5126,34962)
            primitive={'attributes':attrs,'indices':accessor(indices,1,5125,34963),'mode':4}
        index=len(document['meshes']);document['meshes'].append({'primitives':[primitive]})
        return index
    if value['type'] == 'InstanceSet':
        index=add_mesh(value['prototype'])
        if index is not None:
            # One immutable mesh, many nodes. Never realize instances during export.
            for item in value['instances']:
                node={'name':item['id'],'mesh':index,'translation':item['translation'],'rotation':item['rotation'],'scale':item['scale']}
                document['scenes'][0]['nodes'].append(len(document['nodes']));document['nodes'].append(node)
    else:
        index=add_mesh(value)
        if index is not None:
            document['scenes'][0]['nodes']=[0];document['nodes'].append({'mesh':index})
    if not document['nodes']:
        document.pop('nodes');document['scenes'][0].pop('nodes')
    document['buffers'][0]['byteLength']=len(binary)
    if not binary:
        for key in ('buffers','bufferViews','accessors','meshes'): document.pop(key)
    json_data=json.dumps(document,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')
    json_data+=b' '*((-len(json_data))%4)
    binary.extend(b'\x00'*((-len(binary))%4))
    size=12+8+len(json_data)+(8+len(binary) if binary else 0)
    check(size <= MAX_GLB_BYTES,'GLB exceeds byte budget.','BUDGET_EXCEEDED')
    result=struct.pack('<4sII',b'glTF',2,size)+struct.pack('<I4s',len(json_data),b'JSON')+json_data
    if binary: result+=struct.pack('<I4s',len(binary),b'BIN\x00')+binary
    return result
