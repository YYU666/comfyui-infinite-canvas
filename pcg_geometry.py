"""Deterministic bounded geometry evaluator. All operations consume finite JSON only."""
from __future__ import annotations
import bisect
import copy
import math
import random
import re
from pcg_fields import (binding, canonical, check, compare, counts, exact, field,
                        field_math, noise_field, number, sample_texture, validate_field, vector)

MAX_TRIANGLES = 100000
MAX_VERTICES = 60000
MAX_POINTS = 10000
MAX_INSTANCES = 10000

def add(a,b): return [x+y for x,y in zip(a,b)]
def sub(a,b): return [x-y for x,y in zip(a,b)]
def mul(a,s): return [x*s for x in a]
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def unit(v):
    length=math.sqrt(dot(v,v))
    check(length > 1e-20, 'Zero length direction or degenerate triangle.')
    return mul(v,1/length)

def budget(vertices=0,triangles=0,points=0,instances=0):
    check(vertices <= MAX_VERTICES and triangles <= MAX_TRIANGLES and points <= MAX_POINTS and instances <= MAX_INSTANCES, 'Geometry exceeds item budget.', 'BUDGET_EXCEEDED')

def mesh(positions,triangles,normals=None,uvs=None):
    return {'contractVersion':1,'type':'Mesh','positions':positions,'triangles':triangles,'normals':normals or [],'uvs':uvs or []}

def validate_geometry(value):
    check(type(value) is dict and value.get('type') in ('Mesh','PointSet','InstanceSet'), 'Expected geometry data.')
    kind=value['type']
    if kind == 'Mesh':
        exact(value, ('contractVersion','type','positions','triangles','normals','uvs'))
        check(type(value['positions']) is list and type(value['triangles']) is list, 'Invalid mesh arrays.')
        budget(vertices=len(value['positions']),triangles=len(value['triangles']))
        for point in value['positions']: vector(point)
        for tri in value['triangles']:
            check(type(tri) is list and len(tri) == 3 and all(type(i) is int and 0 <= i < len(value['positions']) for i in tri) and len(set(tri)) == 3, 'Invalid triangle indices.')
            a,b,c=[value['positions'][i] for i in tri]
            normal=cross(sub(b,a),sub(c,a))
            check(dot(normal,normal) > 1e-30, 'Degenerate triangle.')
        for name,size in (('normals',3),('uvs',2)):
            check(type(value[name]) is list and len(value[name]) in (0,len(value['triangles'])*3), 'Corner attribute count mismatch.')
            for item in value[name]:
                vector(item,size)
                if name == 'normals': check(abs(dot(item,item)-1) < 1e-4, 'Normals must be unit vectors.')
    elif kind == 'PointSet':
        exact(value, ('contractVersion','type','positions'))
        check(type(value['positions']) is list, 'Invalid point array.')
        budget(points=len(value['positions']))
        for point in value['positions']: vector(point)
    else:
        exact(value, ('contractVersion','type','prototype','instances'))
        check(type(value['prototype']) is dict and value['prototype'].get('type') == 'Mesh', 'Instance prototype must be Mesh.')
        validate_geometry(value['prototype'])
        check(type(value['instances']) is list, 'Invalid instance array.')
        budget(instances=len(value['instances']))
        ids=set()
        for item in value['instances']:
            exact(item, ('id','translation','rotation','scale'))
            check(type(item['id']) is str and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',item['id']) is not None and item['id'] not in ids, 'Invalid or duplicate instance ID.')
            ids.add(item['id']); vector(item['translation']); vector(item['scale']); vector(item['rotation'],4)
            check(all(abs(x) >= 1e-8 for x in item['scale']), 'Scale cannot be zero.')
            check(abs(dot(item['rotation'],item['rotation'])-1) < 1e-6, 'Rotation must be a unit quaternion.')
    check(type(value['contractVersion']) is int and value['contractVersion'] == 1, 'Unsupported geometry version.')
    canonical(value)
    return value

def recompute_normals(value, mode='smooth'):
    check(value['type'] == 'Mesh', 'Normals require Mesh.')
    result=copy.deepcopy(value)
    faces=[cross(sub(value['positions'][b],value['positions'][a]),sub(value['positions'][c],value['positions'][a])) for a,b,c in value['triangles']]
    if mode == 'flat': result['normals']=[unit(n) for n in faces for _ in range(3)]
    else:
        vertex_normals=[[0.,0.,0.] for _ in value['positions']]
        for tri,n in zip(value['triangles'],faces):
            for i in tri: vertex_normals[i]=add(vertex_normals[i],n)
        # Isolated points have no normals; only referenced vertices need normalization.
        result['normals']=[unit(vertex_normals[i]) for tri in value['triangles'] for i in tri]
    return result

def primitive(kind,size,levels):
    check(all(x > 0 for x in size), 'Primitive size must be positive.')
    if kind == 'box':
        positions=[[x*size[0]/2,y*size[1]/2,z*size[2]/2] for x,y,z in ((-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1))]
        quads=((0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5))
        triangles=[];uvs=[]
        for a,b,c,d in quads:
            triangles.extend([[a,b,c],[a,c,d]])
            uvs.extend([[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]])
        return recompute_normals(subdivide(mesh(positions,triangles,uvs=uvs),levels),'flat')
    if kind == 'plane':
        value=mesh([[-size[0]/2,0,-size[2]/2],[size[0]/2,0,-size[2]/2],[size[0]/2,0,size[2]/2],[-size[0]/2,0,size[2]/2]],[[0,2,1],[0,3,2]],uvs=[[0,0],[1,1],[1,0],[0,0],[0,1],[1,1]])
        return recompute_normals(subdivide(value,levels),'flat')
    if kind == 'cylinder':
        segments=8*2**levels
        budget(vertices=segments*2+2,triangles=segments*4)
        positions=[[math.cos(i*2*math.pi/segments)*size[0]/2,y*size[1]/2,math.sin(i*2*math.pi/segments)*size[2]/2] for y in (-1,1) for i in range(segments)]
        positions.extend([[0,-size[1]/2,0],[0,size[1]/2,0]])
        triangles=[];uvs=[]
        for i in range(segments):
            j=(i+1)%segments
            triangles.extend([[i,segments+i,segments+j],[i,segments+j,j],[2*segments,j,i],[2*segments+1,segments+i,segments+j]])
            u0,u1=i/segments,(i+1)/segments
            uvs.extend([[u0,0],[u0,1],[u1,1],[u0,0],[u1,1],[u1,0]])
            for tri in triangles[-2:]:
                uvs.extend([[positions[k][0]/size[0]+.5,positions[k][2]/size[2]+.5] for k in tri])
        # Winding corrections must carry each face's Corner UVs with its vertices.
        # Retain side u=1 at the seam and disk-projected UVs on both cap rims.
        for face,tri in enumerate(triangles):
            a,b,c=[positions[k] for k in tri]
            n=cross(sub(b,a),sub(c,a));center=mul(add(add(a,b),c),1/3)
            outward=[center[0],0,center[2]] if len(set(k//segments for k in tri if k < 2*segments)) > 1 else [0,center[1],0]
            if dot(n,outward)<0:
                tri[1],tri[2]=tri[2],tri[1]
                corner=face*3
                uvs[corner+1],uvs[corner+2]=uvs[corner+2],uvs[corner+1]
        return recompute_normals(mesh(positions,triangles,uvs=uvs),'flat')
    positions=[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    triangles=[[2,0,4],[2,4,1],[2,1,5],[2,5,0],[3,4,0],[3,1,4],[3,5,1],[3,0,5]]
    triangles=[[a,c,b] for a,b,c in triangles]
    value=subdivide(mesh(positions,triangles),levels)
    value['positions']=[[x*s/2 for x,s in zip(unit(p),size)] for p in value['positions']]
    # Longitude UVs live on corners, allowing a seam across one shared point.
    for tri in value['triangles']:
        uv=[[math.atan2(value['positions'][i][2]/size[2],value['positions'][i][0]/size[0])/(2*math.pi)+.5, math.asin(max(-1,min(1,2*value['positions'][i][1]/size[1])))/math.pi+.5] for i in tri]
        if max(p[0] for p in uv)-min(p[0] for p in uv) > .5:
            uv=[[u+1 if u < .5 else u,v] for u,v in uv]
        value['uvs'].extend(uv)
    return recompute_normals(value)

def subdivide(value,levels):
    check(value['type'] == 'Mesh', 'Subdivision requires Mesh.')
    # Shared edge midpoint allocation preserves indexed connectivity.
    budget(vertices=len(value['positions'])+len(value['triangles'])*(4**levels-1), triangles=len(value['triangles'])*4**levels)
    result=copy.deepcopy(value)
    for _ in range(levels):
        positions=list(result['positions']); triangles=[]; normals=[]; uvs=[]; edges={}
        def midpoint(a,b):
            key=tuple(sorted((a,b)))
            if key not in edges:
                edges[key]=len(positions);positions.append(mul(add(positions[a],positions[b]),.5))
            return edges[key]
        for face,(a,b,c) in enumerate(result['triangles']):
            ab,bc,ca=midpoint(a,b),midpoint(b,c),midpoint(c,a)
            triangles.extend([[a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca]])
            for name,target in (('normals',normals),('uvs',uvs)):
                if result[name]:
                    va,vb,vc=result[name][face*3:face*3+3]
                    vab,vbc,vca=mul(add(va,vb),.5),mul(add(vb,vc),.5),mul(add(vc,va),.5)
                    items=[va,vab,vca,vab,vb,vbc,vca,vbc,vc,vab,vbc,vca]
                    target.extend([unit(v) for v in items] if name == 'normals' else items)
        result=mesh(positions,triangles,normals,uvs)
    return result

def quaternion(euler):
    x,y,z=[v/2 for v in euler];cx,cy,cz=math.cos(x),math.cos(y),math.cos(z);sx,sy,sz=math.sin(x),math.sin(y),math.sin(z)
    return [sx*cy*cz-cx*sy*sz,cx*sy*cz+sx*cy*sz,cx*cy*sz-sx*sy*cz,cx*cy*cz+sx*sy*sz]

def qmul(a,b):
    x,y,z,w=a; X,Y,Z,W=b
    return [w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z]

def rotate(p,q):
    qv=q[:3];t=mul(cross(qv,p),2)
    return add(p,add(mul(t,q[3]),cross(qv,t)))

def transform_point(p,translation,rotation,scale): return add(translation,rotate([x*s for x,s in zip(p,scale)],rotation))

def transform(value,translation,euler,scale):
    q=quaternion(euler)
    if value['type'] == 'InstanceSet':
        # A nonuniform parent scale plus child rotation creates shear, outside TRS.
        check(scale[0] == scale[1] == scale[2], 'Instance parent transform requires uniform scale; realize explicitly for nonuniform geometry transform.')
        result=copy.deepcopy(value)
        for item in result['instances']:
            item['translation']=transform_point(item['translation'],translation,q,scale)
            item['rotation']=qmul(q,item['rotation']);item['scale']=[x*s for x,s in zip(item['scale'],scale)]
        return result
    result=copy.deepcopy(value)
    result['positions']=[transform_point(p,translation,q,scale) for p in value['positions']]
    if value['type'] == 'Mesh':
        result['normals']=[unit(rotate([x/s for x,s in zip(n,scale)],q)) for n in value['normals']]
        if scale[0]*scale[1]*scale[2] < 0:
            result['triangles']=[[a,c,b] for a,b,c in value['triangles']]
            for name in ('normals','uvs'):
                if result[name]: result[name]=[result[name][i+j] for i in range(0,len(result[name]),3) for j in (0,2,1)]
    return result

def join(a,b):
    check(a['type'] == b['type'] and a['type'] in ('Mesh','PointSet'), 'Join requires two Mesh values or two PointSets.')
    if a['type'] == 'PointSet':
        budget(points=len(a['positions'])+len(b['positions']))
        return {'contractVersion':1,'type':'PointSet','positions':copy.deepcopy(a['positions']+b['positions'])}
    budget(vertices=len(a['positions'])+len(b['positions']), triangles=len(a['triangles'])+len(b['triangles']))
    offset=len(a['positions'])
    aa,bb=a,b
    if bool(a['normals']) != bool(b['normals']): aa,bb=recompute_normals(a),recompute_normals(b)
    check(bool(a['uvs']) == bool(b['uvs']), 'Join cannot silently drop a Corner UV set.')
    return mesh(copy.deepcopy(a['positions']+b['positions']),copy.deepcopy(a['triangles'])+[[i+offset for i in t] for t in b['triangles']],copy.deepcopy(aa['normals']+bb['normals']),copy.deepcopy(a['uvs']+b['uvs']))

def scatter(value,count,seed,min_distance=0,max_slope=90,min_height=-1e6,max_height=1e6):
    check(value['type'] == 'Mesh' and bool(value['triangles']), 'Scatter requires triangle Mesh.')
    budget(points=count)
    check(min_height <= max_height,'Scatter minimum height exceeds maximum.')
    rng=random.Random(seed);cumulative=[];eligible=[];total=0.
    threshold=math.cos(math.radians(max_slope))
    for tri in value['triangles']:
        a,b,c=[value['positions'][i] for i in tri]
        n=cross(sub(b,a),sub(c,a));length=math.sqrt(dot(n,n))
        if n[1]/length+1e-12 < threshold or max(a[1],b[1],c[1]) < min_height or min(a[1],b[1],c[1]) > max_height: continue
        total+=length/2;cumulative.append(total);eligible.append(tri)
    check(bool(eligible) or count==0,'No surface satisfies placement constraints.','INSUFFICIENT_PLACEMENT')
    positions=[];grid={};attempts=max(1000,count*100)
    for _ in range(attempts):
        if len(positions)==count: break
        tri=eligible[min(bisect.bisect_right(cumulative,rng.random()*total),len(cumulative)-1)]
        a,b,c=[value['positions'][i] for i in tri];r=math.sqrt(rng.random());u=rng.random()
        p=add(mul(a,1-r),add(mul(b,r*(1-u)),mul(c,r*u)))
        if not min_height <= p[1] <= max_height: continue
        if min_distance:
            cell=tuple(math.floor(x/min_distance) for x in p);blocked=False
            for z in (-1,0,1):
                for y in (-1,0,1):
                    for x in (-1,0,1):
                        for q in grid.get((cell[0]+x,cell[1]+y,cell[2]+z),()):
                            if dot(sub(p,q),sub(p,q)) < min_distance*min_distance: blocked=True;break
                        if blocked: break
                    if blocked: break
                if blocked: break
            if blocked: continue
            grid.setdefault(cell,[]).append(p)
        positions.append(p)
    check(len(positions)==count,'Requested placement count cannot be satisfied within the deterministic attempt budget.','INSUFFICIENT_PLACEMENT')
    return {'contractVersion':1,'type':'PointSet','positions':positions}

def realize(value):
    check(value['type'] == 'InstanceSet', 'Realization requires InstanceSet.')
    prototype=value['prototype'];items=value['instances']
    budget(vertices=len(prototype['positions'])*len(items),triangles=len(prototype['triangles'])*len(items))
    result=mesh([],[])
    for item in items:
        current=copy.deepcopy(prototype)
        current['positions']=[transform_point(p,item['translation'],item['rotation'],item['scale']) for p in prototype['positions']]
        current['normals']=[unit(rotate([x/s for x,s in zip(n,item['scale'])],item['rotation'])) for n in prototype['normals']]
        if math.prod(item['scale']) < 0:
            current['triangles']=[[a,c,b] for a,b,c in prototype['triangles']]
            for name in ('normals','uvs'):
                if current[name]: current[name]=[current[name][i+j] for i in range(0,len(current[name]),3) for j in (0,2,1)]
        offset=len(result['positions'])
        result['positions'].extend(current['positions'])
        result['triangles'].extend([[i+offset for i in tri] for tri in current['triangles']])
        result['normals'].extend(current['normals']);result['uvs'].extend(current['uvs'])
    return result

def summarize(value):
    validate_geometry(value)
    if value['type'] == 'InstanceSet':
        prototype=value['prototype'];p=prototype['positions']
        if p:
            low=[min(x[i] for x in p) for i in range(3)];high=[max(x[i] for x in p) for i in range(3)]
            corners=[[x,y,z] for x in (low[0],high[0]) for y in (low[1],high[1]) for z in (low[2],high[2])]
            positions=[transform_point(p,item['translation'],item['rotation'],item['scale']) for item in value['instances'] for p in corners]
        else: positions=[]
        source=value['instances']
    else: positions=value['positions'];source=positions
    bounds={'min':[min(p[i] for p in positions) if positions else 0 for i in range(3)],'max':[max(p[i] for p in positions) if positions else 0 for i in range(3)]}
    size=len(source);sample_count=min(64,size)
    indices=[i*(size-1)//(sample_count-1) for i in range(sample_count)] if sample_count>1 else [0] if size else []
    return {'contractVersion':1,'type':'DiagnosticReport','geometryType':value['type'],'binding':binding(value),'counts':counts(value),'bounds':bounds,'boundsKind':'conservative' if value['type']=='InstanceSet' else 'exact','coordinates':{'unit':'meter','up':'Y','handedness':'right'},'attributes':{'normalDomain':'Corner' if value['type']=='Mesh' and value['normals'] else None,'uvDomain':'Corner' if value['type']=='Mesh' and value['uvs'] else None},'samples':copy.deepcopy([source[i] for i in indices])}

# Closed parameter table doubles as the evaluator's normalization contract.
# Spec values: default plus scalar/enum/vector discriminator and numeric bounds.
V=lambda default: (default,'vector',None,None)
N=lambda default,low,high: (default,'number',low,high)
I=lambda default,low,high: (default,'integer',low,high)
E=lambda default,choices: (default,choices,None,None)
TRS={'translation':V([0,0,0]),'rotation':V([0,0,0]),'scale':V([1,1,1])}
SCATTER={'count':I(100,0,10000),'seed':I(0,0,2147483647),'minDistance':N(0,0,1e6),'maxSlope':N(90,0,90),'minHeight':N(-1e6,-1e6,1e6),'maxHeight':N(1e6,-1e6,1e6)}
SPECS={
 'primitive':{'kind':E('box',('box','sphere','cylinder','plane')),'size':V([1,1,1]),'subdivisions':I(0,0,6)},
 'transform':TRS,'join_geometry':{},'subdivide':{'levels':I(1,0,6)},
 'attribute_read':{'name':E('position',('position','normal'))},
 'noise_field':{'seed':I(0,0,2147483647),'amplitude':N(.1,0,1000),'frequency':N(1,.0001,1000),'output':E('vector3',('scalar','vector3'))},
 'field_math':{'operation':E('multiply',('add','multiply','component_x','component_y','component_z','length','normalize')),'value':N(1,-1000,1000)},
 'compare':{'operation':E('greater',('greater','less','equal')),'value':N(0,-1e12,1e12)},
 'selection':{'domain':E('Point',('Point','Face','Corner','Instance','Detail')),'mode':E('all',('all','none','every_n','and','or','not')),'every':I(2,1,10000)},
 'set_position':{},'recompute_normals':{'mode':E('smooth',('flat','smooth'))},
 'sample_texture':{'interpolation':E('bilinear',('nearest','bilinear')),'mapping':E('uv',('uv','xy','xz','yz')),'channel':E('rgb',('rgb','r','g','b')),'color':V([.5,.5,.5])},
 'scatter_points':SCATTER,
 'instance_on_points':{'scale':V([1,1,1])},'instance_transform':TRS,'realize_instances':{},'inspect_geometry':{},'publish_geometry':{},
 'shape':{'kind':E('box',('box','sphere','cylinder','plane')),'size':V([1,1,1]),'subdivisions':I(0,0,6)},
 'rock':{'seed':I(0,0,2147483647),'subdivisions':I(2,0,6),'size':V([1,1,1]),'roughness':N(.2,0,.4)},
 'scatter':dict(SCATTER,scale=V([1,1,1])),'compose':{}}
PORTS={
 'primitive':((),()),'transform':(('geometry',),()),'join_geometry':(('a','b'),()),'subdivide':(('geometry',),()),'attribute_read':(('geometry',),()),
 'noise_field':(('geometry',),('position',)),'field_math':(('a',),('b',)),'compare':(('field',),()),'selection':(('geometry',),('a','b')),'set_position':(('geometry','offset'),('selection',)),
 'recompute_normals':(('geometry',),()),'sample_texture':(('geometry',),('image',)),'scatter_points':(('geometry',),()),'instance_on_points':(('points','prototype'),()),
 'instance_transform':(('instances',),()),'realize_instances':(('instances',),()),'inspect_geometry':(('geometry',),()),'publish_geometry':(('geometry',),()),
 'shape':((),()),'rock':((),()),'scatter':(('geometry','prototype'),()),'compose':(('a','b'),())}

def parameters(operation, supplied):
    exact(supplied, (), SPECS[operation])
    result={}
    for key,(default,kind,low,high) in SPECS[operation].items():
        value=supplied.get(key,copy.deepcopy(default))
        if kind == 'vector': vector(value)
        elif kind == 'number': number(value,low,high)
        elif kind == 'integer': check(type(value) is int and low <= value <= high, 'Integer parameter exceeds bounds.')
        else: check(type(value) is str and value in kind, 'Unknown enum parameter.')
        if key == 'scale': check(all(abs(x) >= 1e-8 for x in value), 'Scale cannot be zero.')
        result[key]=value
    return result

def evaluate(operation, supplied, inputs):
    check(type(operation) is str, 'Operation must be a string.')
    operation=operation.removeprefix('refmuse.pcg.')
    check(operation in SPECS, 'Operation is unavailable in M2.', 'EXECUTOR_UNAVAILABLE')
    p=parameters(operation,supplied);exact(inputs,*PORTS[operation])
    for port,value in inputs.items():
        if port in ('image',): continue
        if port in ('a','b') and operation in ('field_math','selection') or port in ('field','offset','selection','position'):
            validate_field(value)
        else: validate_geometry(value)
    g=inputs.get('geometry')
    if operation in ('shape','rock','scatter','compose'):
        if operation == 'shape': return evaluate('primitive',p,{})
        if operation == 'rock':
            value=evaluate('primitive',{'kind':'sphere','size':p['size'],'subdivisions':p['subdivisions']},{})['geometry']
            positions=evaluate('attribute_read',{}, {'geometry':value})['field']
            noise=evaluate('noise_field',{'seed':p['seed'],'amplitude':p['roughness'],'frequency':2,'output':'scalar'},{'geometry':value})['field']
            displacement=evaluate('field_math',{'operation':'multiply'},{'a':positions,'b':noise})['field']
            value=evaluate('set_position',{}, {'geometry':value,'offset':displacement})['geometry']
            return evaluate('recompute_normals',{}, {'geometry':value})
        if operation == 'compose': return evaluate('join_geometry',{},inputs)
        points=evaluate('scatter_points',{key:p[key] for key in SCATTER},{'geometry':g})['points']
        return evaluate('instance_on_points',{'scale':p['scale']},{'points':points,'prototype':inputs['prototype']})
    if operation == 'primitive': result=primitive(p['kind'],p['size'],p['subdivisions'])
    elif operation in ('transform','instance_transform'):
        g=g if g is not None else inputs['instances']
        if operation == 'instance_transform': check(g['type'] == 'InstanceSet', 'Expected InstanceSet.')
        result=transform(g,p['translation'],p['rotation'],p['scale'])
    elif operation == 'join_geometry': result=join(inputs['a'],inputs['b'])
    elif operation == 'subdivide': result=subdivide(g,p['levels'])
    elif operation == 'attribute_read':
        if p['name']=='position':
            check('positions' in g,'Position requires Point domain.')
            return {'field':field(g,'Point','vector3',copy.deepcopy(g['positions']))}
        check(g['type']=='Mesh' and bool(g['normals']),'Normal requires Corner normals.')
        return {'field':field(g,'Corner','vector3',copy.deepcopy(g['normals']))}
    elif operation == 'noise_field': return {'field':noise_field(g,p['seed'],p['amplitude'],p['frequency'],inputs.get('position'),'float' if p['output']=='scalar' else 'vector3')}
    elif operation == 'field_math': return {'field':field_math(inputs['a'],inputs.get('b'),p['operation'],p['value'])}
    elif operation == 'compare': return {'selection':compare(inputs['field'],p['operation'],p['value'])}
    elif operation == 'selection':
        check(p['domain'] in counts(g),'Domain unavailable on geometry.','FIELD_DOMAIN_MISMATCH')
        if p['mode'] in ('and','or','not'):
            check('a' in inputs and (p['mode']=='not' or 'b' in inputs),'Boolean selection inputs are missing.')
            for name in ('a','b'):
                if name in inputs:
                    operand=validate_field(inputs[name],g)
                    check(operand['type']=='Selection' and operand['domain']==p['domain'],'Selection domain mismatch.','FIELD_DOMAIN_MISMATCH')
            a=inputs['a']['values'];b=inputs.get('b',{}).get('values',[])
            values=[not x if p['mode']=='not' else x and b[i] if p['mode']=='and' else x or b[i] for i,x in enumerate(a)]
        else:
            check('a' not in inputs and 'b' not in inputs,'Selection source inputs only apply to boolean combination modes.')
            values=[p['mode']=='all' or p['mode']=='every_n' and i%p['every']==0 for i in range(counts(g)[p['domain']])]
        return {'selection':field(g,p['domain'],'boolean',values,True)}
    elif operation == 'set_position':
        check('positions' in g,'Set position requires Mesh or PointSet.')
        offset=validate_field(inputs['offset'],g)
        check(offset['type']=='Field' and offset['domain']=='Point' and offset['valueType']=='vector3','Position offset must be Point vector3 Field.','FIELD_DOMAIN_MISMATCH')
        selected=inputs.get('selection')
        if selected is not None:
            validate_field(selected,g)
            check(selected['type']=='Selection' and selected['domain']=='Point','Position selection must be Point Selection.','FIELD_DOMAIN_MISMATCH')
        result=copy.deepcopy(g)
        result['positions']=[add(v,offset['values'][i]) if selected is None or selected['values'][i] else list(v) for i,v in enumerate(g['positions'])]
        if result['type']=='Mesh': result['normals']=[]
    elif operation == 'recompute_normals': result=recompute_normals(g,p['mode'])
    elif operation == 'sample_texture':
        for component in p['color']: number(component,0,1)
        image=inputs.get('image',{'contractVersion':1,'type':'Image','width':1,'height':1,'pixels':[p['color']]})
        return {'field':sample_texture(g,image,p['interpolation'],p['mapping'],p['channel'])}
    elif operation == 'scatter_points': result=scatter(g,p['count'],p['seed'],p['minDistance'],p['maxSlope'],p['minHeight'],p['maxHeight'])
    elif operation == 'instance_on_points':
        points,prototype=inputs['points'],inputs['prototype']
        check(points['type']=='PointSet' and prototype['type']=='Mesh','Instances require PointSet and Mesh prototype.')
        result={'contractVersion':1,'type':'InstanceSet','prototype':copy.deepcopy(prototype),'instances':[{'id':f'point:{i}','translation':list(point),'rotation':[0,0,0,1],'scale':list(p['scale'])} for i,point in enumerate(points['positions'])]}
    elif operation == 'realize_instances': result=realize(inputs['instances'])
    elif operation == 'inspect_geometry': return {'report':summarize(g),'geometry':copy.deepcopy(g)}
    else: result=copy.deepcopy(g)
    validate_geometry(result)
    return {'instances' if operation in ('instance_on_points','instance_transform') else 'points' if operation=='scatter_points' else 'geometry':result}


def validate_value(value, geometry=None):
    """Validate an internal output; source binding may additionally be checked."""
    from pcg_fields import validate_image
    check(type(value) is dict, 'Expected typed value.')
    if value.get('type') in ('Mesh','PointSet','InstanceSet'): return validate_geometry(value)
    if value.get('type') in ('Field','Selection'): return validate_field(value,geometry)
    if value.get('type') == 'Image': return validate_image(value)
    if value.get('type') == 'DiagnosticReport':
        exact(value, ('contractVersion','type','geometryType','binding','counts','bounds','boundsKind','coordinates','attributes','samples'))
        check(type(value['contractVersion']) is int and value['contractVersion']==1 and value['geometryType'] in ('Mesh','PointSet','InstanceSet'),'Invalid report type/version.')
        exact(value['binding'],('contentHash','topologyHash'))
        for h in value['binding'].values(): check(type(h) is str and len(h)==64 and all(c in '0123456789abcdef' for c in h),'Invalid report binding.')
        expected={'Point','Face','Corner','Detail'} if value['geometryType']=='Mesh' else {'Point','Detail'} if value['geometryType']=='PointSet' else {'Instance','Detail'}
        exact(value['counts'],expected)
        for n in value['counts'].values(): check(type(n) is int and 0<=n<=300000,'Invalid report counts.')
        check(value['counts']['Detail']==1,'Invalid detail count.')
        exact(value['bounds'],('min','max'))
        for v in value['bounds'].values():vector(v)
        check(all(a<=b for a,b in zip(value['bounds']['min'],value['bounds']['max'])),'Invalid bounds ordering.')
        check(value['boundsKind']==('conservative' if value['geometryType']=='InstanceSet' else 'exact'),'Invalid bounds kind.')
        check(value['coordinates']=={'unit':'meter','up':'Y','handedness':'right'},'Invalid report coordinates.')
        exact(value['attributes'],('normalDomain','uvDomain'))
        check(all(v in (None,'Corner') for v in value['attributes'].values()),'Invalid report attribute domains.')
        check(type(value['samples']) is list and len(value['samples'])<=64,'Invalid geometry report samples.')
        for item in value['samples']:
            if value['geometryType']=='InstanceSet':
                exact(item,('id','translation','rotation','scale'))
                check(type(item['id']) is str and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',item['id']) is not None,'Invalid report instance identity.')
                vector(item['translation']);vector(item['rotation'],4);vector(item['scale'])
                check(abs(dot(item['rotation'],item['rotation'])-1)<1e-6 and all(abs(v)>=1e-8 for v in item['scale']),'Invalid report transform.')
            else:vector(item)
        canonical(value)
        return value
    check(False,'Unknown internal value type.')
