"""Independent CPU geometry stages; immutable arrays and explicit review gates.

Numerical intersection/QEM/guarded fit adapted from local TopoForge research
artifacts meshanything_ai_lod_v1/mesh_ops.py and
meshanything_ai_lod_fit_v1/fit_core_attempt2.py (2026-11-03).
No bpy/mathutils/ComfyUI imports, asset paths, global flips or inferred hole caps.
Intersection tests ignore isolated point contact; tolerances are scale relative.
"""
import collections
import hashlib
import json
from pathlib import Path
import numpy as np
import trimesh
MAX_AUDIT_FACES = 10000

class GeometryBlocked(ValueError):
    """Inspectable candidate cannot enter production downstream stages."""


def mesh_hash(v, f):
    h = hashlib.sha256()
    for array, dtype in ((v, '<f8'), (f, '<i8')):
        data = np.asarray(array, dtype=dtype)
        h.update(np.asarray(data.shape, dtype='<i8').tobytes())
        h.update(data.tobytes())
    return h.hexdigest()


def validate_arrays(v, f):
    v, f = np.asarray(v, dtype=float), np.asarray(f)
    if v.ndim != 2 or v.shape[1] != 3 or f.ndim != 2 or f.shape[1] != 3:
        raise ValueError('Expected triangle mesh arrays')
    if not len(v) or not len(f) or not np.isfinite(v).all():
        raise ValueError('Empty or nonfinite mesh')
    if not np.issubdtype(f.dtype, np.integer) or f.min() < 0 or f.max() >= len(v):
        raise ValueError('Invalid triangle indices')
    return v.copy(), f.astype(np.int64, copy=True)


def diagnose(v, f):
    v, f = validate_arrays(v, f)
    if len(f)>MAX_AUDIT_FACES:
        raise GeometryBlocked('Exact geometry audit limit is 10000 triangles')
    edges = topology(f)
    n, area = normals(v, f)
    eps = max(float(np.linalg.norm(np.ptp(v, axis=0))) * 1e-8, 1e-12)
    tri = v[f]; lo = tri.min(1); hi = tri.max(1)
    crossings = []
    for i, t in enumerate(tri):
        ids = np.flatnonzero(np.all(hi[i+1:] >= lo[i]-eps, axis=1) & np.all(lo[i+1:] <= hi[i]+eps, axis=1)) + i+1
        for j in ids:
            hit = triangle_intersection_3d(t, tri[j], eps)
            if hit and not (hit[0] == 'segment' and len(set(f[i]) & set(f[j])) >= 2):
                crossings.append([i, int(j)])
    winding = 0
    for (a,b), owners in edges.items():
        if len(owners) == 2:
            winding += sum(any(int(x)==a and int(y)==b for x,y in zip(f[k],np.roll(f[k],-1))) for k in owners) != 1
    boundaries = loops(f)
    nonmanifold_vertices=[]
    owners=collections.defaultdict(set)
    for fi,t in enumerate(f):
        for x in t:owners[int(x)].add(fi)
    for x,ids in owners.items():
        adjacency={i:set() for i in ids}
        for y in set(int(k) for i in ids for k in f[i] if k!=x):
            ring=edges[tuple(sorted((x,y)))]
            for a in ring:adjacency[a].update(ring)
        seen=set();stack=[next(iter(ids))]
        while stack:
            i=stack.pop()
            if i in seen:continue
            seen.add(i);stack.extend(adjacency[i]-seen)
        if seen!=ids:nonmanifold_vertices.append(x)
    return {'vertices':len(v), 'triangles':len(f), 'mesh_hash':mesh_hash(v,f),
            'nonmanifold_vertices':nonmanifold_vertices,
            'nonmanifold_edges':[list(e) for e,x in edges.items() if len(x)>2],
            'boundary_edges':sum(len(x['edges']) for x in boundaries),
            'boundary_components':[{'vertices':x['vertices'],'edges':[list(e) for e in x['edges']]} for x in boundaries],
            'inconsistent_winding_edges':int(winding), 'degenerate_faces':np.flatnonzero(area <= eps**2).tolist(),
            'duplicate_faces':len(f)-len(np.unique(np.sort(f,axis=1),axis=0)),
            'intersection_pairs':crossings,
            'intersection_method':'double precision coplanar clipping and plane segments; isolated points ignored'}


def require_clean(report, allow_boundaries=False):
    reasons = [k for k in ('nonmanifold_edges','nonmanifold_vertices','degenerate_faces','duplicate_faces','intersection_pairs','inconsistent_winding_edges') if report[k]]
    if report['boundary_edges'] and not allow_boundaries:
        reasons.append('boundary_intent_not_reviewed')
    if reasons:
        raise GeometryBlocked('Geometry gate: ' + ', '.join(reasons))


def repair_local(v, f):
    """Only exact existing boundary T-junction splitting; never infer a cap."""
    v, f = validate_arrays(v, f)
    before = diagnose(v,f)
    candidate, operations = split_t_junctions(v,f)
    after = diagnose(v,candidate)
    if after['intersection_pairs'] and operations:
        candidate = f; operations = []; after = before
    return v, candidate, {'before':before,'after':after,'operations':operations,
                          'unresolved_openings':after['boundary_components'], 'automatic_hole_caps':0,
                          'status':'needs_review' if after['boundary_edges'] or after['nonmanifold_edges'] or after['intersection_pairs'] else 'repaired'}


def apply_reviewed_repair_plan(v, f, text, source_mesh_hash):
    """Apply only hash-bound, explicitly nominated triangulations to a copy."""
    if not isinstance(text,str) or len(text.encode('utf-8'))>16384:
        raise ValueError('reviewedRepairPlan must be a JSON string of at most 16KiB')
    try:plan=json.loads(text)
    except (ValueError,TypeError,RecursionError) as exc:raise ValueError('Invalid reviewedRepairPlan JSON') from exc
    if not isinstance(plan,dict) or set(plan)!={'version','sourceMeshHash','patches','remainingBoundaryEdges'} or type(plan['version']) is not int or plan['version']!=1 or plan['sourceMeshHash']!=source_mesh_hash:
        raise ValueError('Unknown repair plan version/keys or sourceMeshHash mismatch')
    v,f=validate_arrays(v,f);result=f.copy();records=[]
    if not isinstance(plan['patches'],list) or len(plan['patches'])>64:
        raise ValueError('Repair plan patches must be a bounded list')
    def edge(a,b):return tuple(sorted((int(a),int(b))))
    for patch in plan['patches']:
        if not isinstance(patch,dict) or set(patch)!={'label','boundaryCycle','faces'} or not isinstance(patch['label'],str) or not 1<=len(patch['label'])<=256:
            raise ValueError('Invalid reviewed patch descriptor')
        cycle=patch['boundaryCycle'];triangles=patch['faces']
        if not isinstance(cycle,list) or not 3<=len(cycle)<=256 or any(type(x) is not int or not 0<=x<len(v) for x in cycle) or len(set(cycle))!=len(cycle):
            raise ValueError('Invalid reviewed boundary cycle')
        boundary={edge(a,b) for a,b in zip(cycle,cycle[1:]+cycle[:1])}
        existing=topology(result)
        components=loops(result)
        if not any({tuple(e) for e in c['edges']}==boundary for c in components):
            raise ValueError('Reviewed patch must nominate an entire existing boundary cycle')
        degree=collections.Counter(x for e in boundary for x in e)
        if any(degree[x]!=2 for x in cycle):raise ValueError('Boundary cycle is not simple')
        if not isinstance(triangles,list) or len(triangles)!=len(cycle)-2 or any(not isinstance(t,list) or len(t)!=3 or any(type(x) is not int or x not in cycle for x in t) or len(set(t))!=3 for t in triangles):
            raise ValueError('Reviewed patch requires n-2 triangles using existing cycle vertices only')
        new=np.asarray(triangles,dtype=np.int64);new_edges=topology(new)
        if {e for e,owners in new_edges.items() if len(owners)==1}!=boundary or any(len(owners)>2 for owners in new_edges.values()):
            raise ValueError('Reviewed patch edge coverage is not a triangulated disk')
        for a,b in boundary:
            old=result[existing[(a,b)][0]]
            tri=new[new_edges[(a,b)][0]]
            direction=lambda t:any(int(x)==a and int(y)==b for x,y in zip(t,np.roll(t,-1)))
            if direction(old)==direction(tri):raise ValueError('Reviewed patch boundary winding conflicts with existing faces')
        _,areas=normals(v,new)
        eps=max(float(np.linalg.norm(np.ptp(v,axis=0)))*1e-8,1e-12)
        if np.any(areas<=eps**2):raise ValueError('Reviewed patch has zero area')
        candidate=np.concatenate((result,new))
        audit=diagnose(v,candidate);require_clean(audit,allow_boundaries=True)
        records.append({'label':patch['label'],'assumption':'Explicit reviewed topology hypothesis, not recovered ground truth',
                        'boundaryCycle':cycle,'added_faces':triangles,'area':float(areas.sum()),
                        'coordinate_displacement':0,'before_mesh_hash':mesh_hash(v,result),'after_mesh_hash':mesh_hash(v,candidate)})
        result=candidate
    remaining=plan['remainingBoundaryEdges']
    if not isinstance(remaining,list) or any(not isinstance(e,list) or len(e)!=2 or any(type(x) is not int or not 0<=x<len(v) for x in e) or e[0]==e[1] for e in remaining):
        raise ValueError('Invalid remainingBoundaryEdges')
    nominated=[edge(*e) for e in remaining]
    actual={e for e,owners in topology(result).items() if len(owners)==1}
    if len(set(nominated))!=len(nominated) or actual!=set(nominated):
        raise ValueError('Final boundary differs from explicitly reviewed remainingBoundaryEdges')
    audit=diagnose(v,result);require_clean(audit,allow_boundaries=True)
    return v,result,{'version':1,'sourceMeshHash':source_mesh_hash,'planSha256':hashlib.sha256(text.encode()).hexdigest(),
                     'patches':records,'remainingBoundaryEdges':[list(e) for e in sorted(actual)],
                     'existing_vertices_unchanged':True,'existing_faces_unchanged':bool(np.array_equal(result[:len(f)],f)),
                     'after':audit}


class ReferenceScene:
    """Open3D CPU correspondence wrapper; reference never supplies topology."""
    def __init__(self, v, f):
        import open3d as o3d
        self.o3d = o3d
        self.scene = o3d.t.geometry.RaycastingScene()
        self.scene.add_triangles(o3d.core.Tensor(np.asarray(v,dtype=np.float32)), o3d.core.Tensor(np.asarray(f,dtype=np.uint32)))

    def ray_cast(self, origin, direction, maximum):
        hit = self.scene.cast_rays(self.o3d.core.Tensor(np.r_[origin,direction][None].astype(np.float32)))
        distance = float(hit['t_hit'].numpy()[0])
        if not np.isfinite(distance) or distance > maximum:
            return None, None, None, None
        return origin+direction*distance, hit['primitive_normals'].numpy()[0], int(hit['primitive_ids'].numpy()[0]), distance

    def find_nearest(self, p):
        hit = self.scene.compute_closest_points(self.o3d.core.Tensor(np.asarray(p,dtype=np.float32)[None]))
        pos = hit['points'].numpy()[0].astype(float)
        return pos, hit['primitive_normals'].numpy()[0], int(hit['primitive_ids'].numpy()[0]), float(np.linalg.norm(pos-p))


def process(mesh, high, out, params):
    """Engine adapter. Blocked results remain diagnostic and never enter UV/bake.

    Returns (selected Trimesh, JSON metadata, artifact dicts with path/role).
    The caller must enforce metadata['status']=='accepted' before downstream.
    No boundary intent is inferred from topology or asset names. Explicit reviewed
    boundary coordinates must match the candidate hash to authorize openings.
    """
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    artifacts=[];metadata={'status':'blocked','stages':[],'algorithm':'CPU exact local repair / signed orientation / bounded fit / progressive constrained QEM'}
    v,inv=np.unique(np.asarray(mesh.vertices),axis=0,return_inverse=True)
    f=inv[np.asarray(mesh.faces)]
    original_hash=mesh_hash(v,f)
    allowed=params.get('reviewedBoundaryMeshHash')==original_hash
    selected=trimesh.Trimesh(v,f,process=False)
    def save(name,v,f,receipt,parent):
        path=out/(name+'.glb')
        if path.exists():raise FileExistsError(path)
        result=trimesh.Trimesh(v,f,process=False);result.export(path)
        artifacts.append({'path':str(path),'role':'export'})
        metadata['stages'].append({'stage':name,'parent_mesh_hash':parent,'mesh_hash':mesh_hash(v,f),'receipt':receipt,'filename':path.name})
        return result
    try:
        selected=save('raw_ai',v,f,{'triangles':len(f),'audit':'pending'},None)
        if len(f)>MAX_AUDIT_FACES:
            raise GeometryBlocked('Exact geometry audit limit is 10000 triangles; raw diagnostic preserved')
        metadata['stages'][-1]['receipt']=diagnose(v,f)
        rv,rf,receipt=repair_local(v,f)
        if 'reviewedRepairPlan' in params:
            rv,rf,review=apply_reviewed_repair_plan(rv,rf,params['reviewedRepairPlan'],original_hash)
            receipt['reviewedRepairPlan']=review;receipt['after']=review['after']
        selected=save('repair',rv,rf,receipt,original_hash)
        # Topology faults cannot be fixed by projecting vertices or flipping normals.
        pre=diagnose(rv,rf)
        faults=[k for k in ('nonmanifold_edges','nonmanifold_vertices','degenerate_faces','duplicate_faces','intersection_pairs') if pre[k]]
        if faults:raise GeometryBlocked('Local repair unresolved: '+', '.join(faults))
        reference=ReferenceScene(high.vertices,high.faces)
        ov,of,orientation=orient_components(rv,rf,reference)
        selected=save('orientation',ov,of,orientation,mesh_hash(rv,rf))
        if orientation['ambiguous_components']:raise GeometryBlocked('Ambiguous component orientation against reference')
        fv,ff,fit=constrained_fit(ov,of,reference,allowed,params.get('fitBoundaryMode','fixed'))
        selected=save('fit',fv,ff,fit,mesh_hash(ov,of))
        targets=[params.get('lod'+str(i),default) for i,default in enumerate((1200,800,500,300),1)]
        selected_target=params.get('selectedLod',800)
        if selected_target not in targets:raise ValueError('selectedLod must match an enabled budget')
        def delivery(index,total,record):
            data=np.load(out/(record['stage']+'.npz'))
            nonlocal selected
            stage=save(record['stage'],data['vertices'],data['faces'],record,record['parent_mesh_hash'])
            if targets[index-1]==selected_target:selected=stage
        _,_,records=continuous_lod(fv,ff,targets,out,delivery,allowed)
        if len(records)!=len(targets) or any(r['receipt']['stopped_above_target'] for r in records):
            raise GeometryBlocked('Constrained LOD stopped above budget; inspect preserved actual counts')
        metadata['status']='accepted';metadata['selectedLod']=selected_target
    except (GeometryBlocked,ValueError) as exc:
        metadata['blocker']=str(exc)
    metadata['source_mesh_hash']=original_hash
    report=out/'report.json'
    report.write_text(json.dumps(metadata,indent=2),encoding='utf-8')
    artifacts.append({'path':str(report),'role':'report'})
    return selected,metadata,artifacts


def orientation_evidence(dots, face_areas):
    """Decide global sign from area-weighted confident samples, not fidelity.

    Oblique samples abstain; they must not vote against either orientation.
    This decision does not relax the independent per-vertex fit dot>=0.5 gate.
    """
    dots=np.asarray(dots,dtype=float);area=np.asarray(face_areas,dtype=float)
    if dots.ndim!=2 or dots.shape[1]==0 or area.shape!=(len(dots),) or not np.isfinite(dots).all() or not np.isfinite(area).all() or np.any(area<0):
        raise ValueError('Invalid orientation samples')
    total=float(area.sum())
    weights=np.broadcast_to(area[:,None]/dots.shape[1],dots.shape)
    positive=float(weights[dots>.5].sum()/total) if total>0 else 0.
    negative=float(weights[dots<-.5].sum()/total) if total>0 else 0.
    confident=positive+negative
    dominance=max(positive,negative)/confident if confident>0 else 0.
    ambiguous=confident<.5 or dominance<.95 or min(positive,negative)>.025
    return {'positive_area_fraction':positive,'negative_area_fraction':negative,
            'uncertain_area_fraction':max(0.,1-confident),'confident_area_fraction':confident,
            'dominant_confident_fraction':dominance,'ambiguous':ambiguous,
            'flipped':bool(not ambiguous and negative>positive),
            'rule':{'signed_dot_threshold':.5,'minimum_confident_area_fraction':.5,
                    'minimum_dominant_confident_fraction':.95,'maximum_opposite_area_fraction':.025}}


def orient_components(v, f, reference):
    """Consistent component winding, then area-weighted multi-sample sign evidence."""
    v,f = validate_arrays(v,f)
    mesh = trimesh.Trimesh(v,f,process=False)
    trimesh.repair.fix_winding(mesh)
    faces = np.asarray(mesh.faces).copy()
    records=[]
    for component in trimesh.graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(f)), min_len=1):
        ids=np.asarray(component);nn,area=normals(v,faces[ids]);tri=v[faces[ids]]
        barycentric=((1/3,1/3,1/3),(.6,.2,.2),(.2,.6,.2),(.2,.2,.6))
        dots=np.asarray([[np.dot(n,reference.find_nearest(p)[1]) for n,p in zip(nn,np.einsum('k,fkj->fj',bary,tri))] for bary in barycentric]).T
        evidence=orientation_evidence(dots,area)
        if evidence['flipped']:faces[ids]=faces[ids][:,[0,2,1]]
        records.append({'faces':ids.tolist(),'face_areas':area.tolist(),'sample_barycentric':barycentric,
                        'sample_signed_dots':dots.tolist(),**evidence})
    return v,faces,{'components':records,'ambiguous_components':sum(r['ambiguous'] for r in records)}


def constrained_fit(v, f, reference, boundary_intent_reviewed=False, fit_boundary_mode='fixed'):
    if fit_boundary_mode not in ('fixed','reviewed_bounded'):
        raise ValueError('Unknown fitBoundaryMode')
    if fit_boundary_mode=='reviewed_bounded' and not boundary_intent_reviewed:
        raise GeometryBlocked('Bounded boundary movement requires matching reviewedBoundaryMeshHash')
    require_clean(diagnose(v,f), boundary_intent_reviewed)
    result, receipt = fit_vertices(*validate_arrays(v,f), reference, move_boundary=fit_boundary_mode=='reviewed_bounded')
    receipt['fitBoundaryMode']=fit_boundary_mode
    after=diagnose(result,f);require_clean(after,boundary_intent_reviewed)
    receipt['after']=after
    return result, np.asarray(f).copy(), receipt


def continuous_lod(v, f, targets, output=None, callback=None, boundary_intent_reviewed=False):
    """Each QEM pass consumes the immediately preceding accepted arrays."""
    v,f=validate_arrays(v,f); targets=list(targets)
    previous=len(f)
    for target in targets:
        if isinstance(target,bool) or not isinstance(target,(int,np.integer)) or not 0<target<previous:
            raise ValueError('LOD budgets must be positive strictly decreasing integers below the base')
        previous=target
    require_clean(diagnose(v,f),boundary_intent_reviewed)
    records=[]
    for index,target in enumerate(targets):
        parent=mesh_hash(v,f)
        nv,nf,receipt=simplify(v,f,int(target))
        report=diagnose(nv,nf);require_clean(report,boundary_intent_reviewed)
        record={'stage':'lod_'+str(target),'parent_mesh_hash':parent,'mesh_hash':mesh_hash(nv,nf), 'receipt':receipt,'geometry':report}
        if output is not None:
            folder=Path(output);folder.mkdir(parents=True,exist_ok=True)
            path=folder/(record['stage']+'.npz')
            if path.exists():raise FileExistsError(path)
            np.savez_compressed(path,vertices=nv,faces=nf)
            record['file_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
            (folder/(record['stage']+'.json')).write_text(json.dumps(record,indent=2),encoding='utf-8')
        records.append(record);v,f=nv,nf
        if callback is not None:callback(index+1,len(targets),record)
        if receipt['stopped_above_target']:
            break
    return v,f,records

def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

def _signed_area(points):
    return sum(p[0] * q[1] - p[1] * q[0]
               for p, q in zip(points, points[1:] + points[:1])) * 0.5

def triangle_intersection_2d(first, second):
    """Convex clipping in double precision; returns positive-area polygon."""
    subject = [tuple(p) for p in first]
    clip = [tuple(p) for p in second]
    if _signed_area(clip) < 0:
        clip.reverse()
    for a, b in zip(clip, clip[1:] + clip[:1]):
        output = []
        if not subject:
            break
        previous = subject[-1]
        dp = _cross(a, b, previous)
        for current in subject:
            dc = _cross(a, b, current)
            if (dc >= 0) != (dp >= 0):
                t = dp / (dp - dc)
                output.append((previous[0] + t * (current[0] - previous[0]),
                               previous[1] + t * (current[1] - previous[1])))
            if dc >= 0:
                output.append(current)
            previous, dp = current, dc
        subject = output
    return subject

def _plane_cut(points, origin, normal, epsilon):
    distance = [(p - origin).dot(normal) for p in points]
    result = []
    for i, point in enumerate(points):
        j = (i + 1) % 3
        if abs(distance[i]) <= epsilon:
            result.append(point)
        if distance[i] * distance[j] < 0:
            t = distance[i] / (distance[i] - distance[j])
            result.append(point + t * (points[j] - point))
    return result

def triangle_intersection_3d(first, second, epsilon):
    """Return ('area',polygon) or ('segment',endpoints); mere point contact ignored."""
    first = [np.asarray(p, dtype=np.float64) for p in first]
    second = [np.asarray(p, dtype=np.float64) for p in second]
    na = np.cross(first[1] - first[0], first[2] - first[0])
    nb = np.cross(second[1] - second[0], second[2] - second[0])
    if np.linalg.norm(na) == 0 or np.linalg.norm(nb) == 0:
        return None
    na /= np.linalg.norm(na)
    nb /= np.linalg.norm(nb)
    da = [(p - first[0]).dot(na) for p in second]
    db = [(p - second[0]).dot(nb) for p in first]
    if min(da) > epsilon or max(da) < -epsilon or min(db) > epsilon or max(db) < -epsilon:
        return None
    direction = np.cross(na, nb)
    if np.linalg.norm(direction) <= 1e-8:
        if max(abs(d) for d in da) > epsilon:
            return None
        drop = max(range(3), key=lambda k: abs(na[k]))
        keep = [k for k in range(3) if k != drop]
        clip = triangle_intersection_2d([[p[k] for k in keep] for p in first],
                                        [[p[k] for k in keep] for p in second])
        if len(clip) < 3 or abs(_signed_area(clip)) <= epsilon * epsilon:
            return None
        points = []
        for point in clip:
            xyz = [0.0, 0.0, 0.0]
            for k, value in zip(keep, point):
                xyz[k] = value
            xyz[drop] = first[0][drop] - sum(na[k] * (xyz[k] - first[0][k]) for k in keep) / na[drop]
            points.append(np.asarray(xyz, dtype=np.float64))
        return 'area', points
    direction /= np.linalg.norm(direction)
    ca, cb = _plane_cut(first, second[0], nb, epsilon), _plane_cut(second, first[0], na, epsilon)
    if len(ca) < 2 or len(cb) < 2:
        return None
    ca.sort(key=lambda p: p.dot(direction))
    cb.sort(key=lambda p: p.dot(direction))
    low = max(ca[0].dot(direction), cb[0].dot(direction))
    high = min(ca[-1].dot(direction), cb[-1].dot(direction))
    if high - low <= epsilon:
        return None
    anchor = ca[0]
    return 'segment', [anchor + direction * (low - anchor.dot(direction)),
                        anchor + direction * (high - anchor.dot(direction))]

def topology(f):
    edges=collections.defaultdict(list)
    for i,t in enumerate(f):
        for a,b in zip(t,np.roll(t,-1)): edges[tuple(sorted((int(a),int(b))))].append(i)
    return edges

def loops(f):
    edges=topology(f); left={e for e,x in edges.items() if len(x)==1}; result=[]
    while left:
        e=left.pop(); vs=set(e); es=[e]; change=True
        while change:
            change=False
            for x in list(left):
                if vs.intersection(x):left.remove(x);vs.update(x);es.append(x);change=True
        result.append({'vertices':sorted(vs),'edges':es})
    return sorted(result,key=lambda x:len(x['edges']),reverse=True)

def normals(v,f):
    t=v[f]; n=np.cross(t[:,1]-t[:,0],t[:,2]-t[:,0]); a=np.linalg.norm(n,axis=1)
    return n/np.maximum(a[:,None],1e-30),a*.5

def split_t_junctions(v,f):
    f=f.copy(); log=[]
    for loop in loops(f):
        if len(loop['edges'])!=3:continue
        vs=loop['vertices']; p=v[vs]; diameter=max(np.linalg.norm(a-b) for a in p for b in p)
        for a,b in loop['edges']:
            c=next(x for x in vs if x not in (a,b)); d=v[b]-v[a]; t=np.dot(v[c]-v[a],d)/np.dot(d,d)
            if not 1e-7<t<1-1e-7 or np.linalg.norm(v[a]+t*d-v[c])>diameter*1e-8:continue
            owners=topology(f)[tuple(sorted((a,b)))]; assert len(owners)==1
            index=owners[0]; old=f[index].copy(); k=next(j for j in range(3) if {int(old[j]),int(old[(j+1)%3])}=={a,b})
            x,y,z=int(old[k]),int(old[(k+1)%3]),int(old[(k+2)%3])
            new=np.array([[x,c,z],[c,y,z]],dtype=np.int64)
            f=np.concatenate((f[:index],f[index+1:],new))
            log.append({'operation':'split_existing_long_edge_at_exact_existing_boundary_vertex','removed_face_index':index,'removed_face':old.tolist(),'added_faces':new.tolist(),'vertex':c,'segment_parameter':float(t),'coordinate_displacement':0})
            break
    return f,log

def simplify(v,f,target):
    """QEM with fixed boundary, weighted creases, link/normal/exact crossing checks."""
    v=v.copy(); f=f.copy(); original_n,areas=normals(v,f); edges=topology(f)
    q=np.zeros((len(v),4,4)); plane=np.c_[original_n,-np.einsum('ij,ij->i',original_n,v[f[:,0]])]
    faceq=plane[:,:,None]*plane[:,None,:]*areas[:,None,None]
    for k in range(3):np.add.at(q,f[:,k],faceq)
    fixed={a for e,x in edges.items() if len(x)==1 for a in e}; sharp_count=0
    for (a,b),owners in edges.items():
        if len(owners)!=2:continue
        dot=np.dot(original_n[owners[0]],original_n[owners[1]])
        if dot>np.cos(np.deg2rad(30)):continue
        sharp_count+=1; axis=v[b]-v[a];length=np.linalg.norm(axis);axis/=length
        for fi in owners:
            n=np.cross(axis,original_n[fi]);n/=max(np.linalg.norm(n),1e-30);p=np.r_[n,-np.dot(n,v[a])]
            extra=np.outer(p,p)*length*10*(1-dot);q[a]+=extra;q[b]+=extra
    eps=max(np.linalg.norm(np.ptp(v,axis=0))*1e-8,1e-9); history=[]; rejected=collections.Counter();blocked=set()
    while len(f)>target:
        edges=topology(f); neighbors=collections.defaultdict(set)
        for a,b in edges:neighbors[a].add(b);neighbors[b].add(a)
        pairs=np.array([e for e,x in edges.items() if len(x)==2 and e not in blocked and not (e[0] in fixed and e[1] in fixed)],dtype=np.int64)
        if not len(pairs):break
        qq=q[pairs[:,0]]+q[pairs[:,1]];aa=qq[:,:3,:3];bb=-qq[:,:3,3];opt=(v[pairs[:,0]]+v[pairs[:,1]])*.5
        good=np.abs(np.linalg.det(aa))>1e-12
        opt[good]=np.linalg.solve(aa[good],bb[good,:,None])[:,:,0]
        choices=np.stack((v[pairs[:,0]],v[pairs[:,1]],opt),axis=1);h=np.concatenate((choices,np.ones((*choices.shape[:2],1))),axis=2)
        costs=np.einsum('nki,nij,nkj->nk',h,qq,h);which=costs.argmin(axis=1);positions=choices[np.arange(len(pairs)),which]
        for i,(a,b) in enumerate(pairs):
            if a in fixed:positions[i]=v[a]
            elif b in fixed:positions[i]=v[b]
        positions=positions.astype(np.float32).astype(np.float64);h=np.c_[positions,np.ones(len(positions))];cost=np.einsum('ni,nij,nj->n',h,qq,h)
        oldn,olda=normals(v,f);tri=v[f];lo=tri.min(axis=1);hi=tri.max(axis=1);accepted=False
        for ci in np.argsort(cost):
            a,b=map(int,pairs[ci]);p=positions[ci];edge=(a,b)
            if a not in fixed and b in fixed:a,b=b,a
            common=neighbors[a]&neighbors[b];opposites={int(x) for k in edges[edge] for x in f[k] if x not in (a,b)}
            if common!=opposites:blocked.add(edge);rejected['link_condition']+=1;continue
            affected=np.flatnonzero(np.any((f==a)|(f==b),axis=1)); local=f[affected].copy();local[local==b]=a
            keep=np.array([len(set(t))==3 for t in local]); local=local[keep]; oldids=affected[keep]
            tempv=v.copy();tempv[a]=p;nn,ar=normals(tempv,local)
            if np.any(ar<=eps**2) or np.any(np.einsum('ij,ij->i',nn,oldn[oldids])<np.cos(np.deg2rad(35))):blocked.add(edge);rejected['area_or_normal']+=1;continue
            bad=False; changed=tempv[local];others=np.ones(len(f),dtype=bool);others[affected]=False
            for k,t in enumerate(changed):
                candidates=np.flatnonzero(others & np.all(hi>=t.min(axis=0)-eps,axis=1)&np.all(lo<=t.max(axis=0)+eps,axis=1))
                for j in candidates:
                    hit=triangle_intersection_3d(t,tri[j],eps)
                    if hit and not(hit[0]=='segment' and len(set(local[k])&set(f[j]))>=2):bad=True;break
                if bad:break
                for j in range(k):
                    hit=triangle_intersection_3d(t,changed[j],eps)
                    if hit and not(hit[0]=='segment' and len(set(local[k])&set(local[j]))>=2):bad=True;break
                if bad:break
            if bad:blocked.add(edge);rejected['exact_intersection']+=1;continue
            v[a]=p;q[a]+=q[b];f=np.concatenate((f[others],local));touched=neighbors[a]|neighbors[b]|{a,b}
            blocked={e for e in blocked if not set(e)&touched}
            history.append({'keep':a,'remove':b,'position':p.tolist(),'quadric_cost':float(cost[ci]),'removed_face_count':int(len(affected)-len(local))});accepted=True;break
        if not accepted:break
    used=np.unique(f);remap=np.full(len(v),-1,dtype=np.int64);remap[used]=np.arange(len(used))
    return v[used],remap[f],{'method':'accumulated_area_QEM_fixed_all_boundary_vertices_crease_plane_weight10_at30deg','requested_triangles':target,'actual_triangles':len(f),'normal_rotation_limit_degrees_per_collapse':35,'initial_crease_edges':sharp_count,'fixed_boundary_vertices':len(fixed),'collapses':history,'rejections':dict(rejected),'stopped_above_target':len(f)>target,'no_scan_inputs':True,'no_projection':True,'no_global_weld_or_smoothing':True}

def vertex_normals(v,f):
    n,a=normals(v,f);result=np.zeros_like(v)
    for k in range(3):np.add.at(result,f[:,k],n*a[:,None])
    return result/np.maximum(np.linalg.norm(result,axis=1)[:,None],1e-20)

def fit_vertices(v,f,tree,move_boundary=False):
    start=v.copy();v=v.copy();D=float(np.linalg.norm(np.ptp(v,axis=0)));eps=D*1e-8
    start_n,_=normals(start,f);edges=topology(f);neighbors=[set() for _ in v];owners=[[] for _ in v]
    for a,b in edges:neighbors[a].add(b);neighbors[b].add(a)
    for fi,t in enumerate(f):
        for x in t:owners[int(x)].append(fi)
    boundary={a for e,x in edges.items() if len(x)==1 for a in e};records=[]
    for iteration in range(2):
        vn=vertex_normals(v,f);tri=v[f];lo=tri.min(axis=1);hi=tri.max(axis=1)
        for i in range(len(v)):
            p=v[i].copy();n=vn[i];edge_scale=float(np.mean([np.linalg.norm(v[j]-p) for j in neighbors[i]]));step=min(D*.006,edge_scale*.3)
            rec={'pass':iteration+1,'vertex':i,'before':p.tolist(),'normal':n.tolist(),'step_limit':step,'boundary':i in boundary,'candidates':[],'accepted':False}

            if i in boundary and not move_boundary:
                rec['reason']='preserved_boundary';records.append(rec);continue
            candidates=[];rayrange=.03*D
            for sign in (1,-1):
                origin=p+n*sign*rayrange;direction=-n*sign;hit=tree.ray_cast(origin,direction,rayrange*2)
                if hit[0] is not None:
                    pos=np.asarray(hit[0]);dot=float(np.dot(n,np.asarray(hit[1])));distance=float(np.linalg.norm(pos-p));rec['candidates'].append({'kind':'normal_ray','sign':sign,'distance':distance,'signed_normal_dot':dot,'source_face':int(hit[2])})
                    if dot>=.5 and distance<=rayrange:candidates.append((distance,pos,'normal_ray',dot,int(hit[2])))
            nearest=tree.find_nearest(p);distance=float(nearest[3]);dot=float(np.dot(n,np.asarray(nearest[1])));pos=np.asarray(nearest[0]);tangent=pos-p-n*np.dot(pos-p,n)
            rec['candidates'].append({'kind':'nearest','distance':distance,'signed_normal_dot':dot,'tangent_displacement':float(np.linalg.norm(tangent)),'source_face':int(nearest[2])})
            if not candidates and dot>=.5 and distance<=rayrange and np.linalg.norm(tangent)<=edge_scale*.25:candidates.append((distance,pos,'nearest_fallback',dot,int(nearest[2])))
            if not candidates:rec['reason']='no_signed_normal_compatible_bounded_correspondence';records.append(rec);continue
            distance,dest,kind,dot,source_face=min(candidates,key=lambda x:x[0]);offset=dest-p
            if distance<eps:rec['reason']='already_on_reference';records.append(rec);continue
            proposed=p+offset*min(1,step/distance);cumulative=proposed-start[i]
            if np.linalg.norm(cumulative)>.012*D:proposed=start[i]+cumulative*(.012*D/np.linalg.norm(cumulative))
            proposed=proposed.astype(np.float32).astype(np.float64);ids=np.asarray(owners[i]);oldn,_=normals(v,f[ids]);candidate=v.copy();candidate[i]=proposed;nn,area=normals(candidate,f[ids])
            rec.update(correspondence=dest.tolist(),kind=kind,signed_normal_dot=dot,source_face=source_face,proposed=proposed.tolist(),cumulative_displacement=float(np.linalg.norm(proposed-start[i])))
            if np.any(area<=eps**2) or np.any(np.einsum('ij,ij->i',oldn,nn)<np.cos(np.deg2rad(25))) or np.any(np.einsum('ij,ij->i',start_n[ids],nn)<np.cos(np.deg2rad(45))):
                rec['reason']='area_or_step25deg_or_total45deg_normal_guard';records.append(rec);continue
            ct=candidate[f[ids]];other=np.ones(len(f),dtype=bool);other[ids]=False;bad=False
            for k,t in enumerate(ct):
                test=np.flatnonzero(other & np.all(hi>=t.min(axis=0)-eps,axis=1)&np.all(lo<=t.max(axis=0)+eps,axis=1))
                for j in test:
                    hit=triangle_intersection_3d(t,tri[j],eps)
                    if hit and not(hit[0]=='segment' and len(set(f[ids[k]])&set(f[j]))>=2):bad=True;break
                if bad:break
                for j in range(k):
                    hit=triangle_intersection_3d(t,ct[j],eps)
                    if hit and not(hit[0]=='segment' and len(set(f[ids[k]])&set(f[ids[j]]))>=2):bad=True;break
                if bad:break
            if bad:rec['reason']='exact_local_intersection_guard';records.append(rec);continue
            v[i]=proposed;tri[ids]=ct;lo[ids]=ct.min(axis=1);hi[ids]=ct.max(axis=1);rec['accepted']=True;rec['reason']='accepted';records.append(rec)
    newn,newa=normals(v,f);_,oldarea=normals(start,f);angle=np.degrees(np.arccos(np.clip(np.einsum('ij,ij->i',newn,start_n),-1,1)));displacement=np.linalg.norm(v-start,axis=1)
    def stats(x):return {'min':float(np.min(x)),'median':float(np.median(x)),'p95':float(np.percentile(x,95)),'max':float(np.max(x))} if len(x) else {'samples':0}
    return v,{'passes':2,'AI_diagonal':D,'source_reference_only':True,'face_connectivity_unchanged':True,'signed_normal_dot_minimum':.5,'max_correspondence_distance_D':.03,'step_maximum_D':.006,'cumulative_displacement_maximum_D':.012,'per_step_face_rotation_limit_deg':25,'cumulative_face_rotation_limit_deg':45,'records':records,'accepted_moves':sum(x['accepted'] for x in records),'displacement_world':stats(displacement),'boundary_vertex_drift_world':stats(displacement[sorted(boundary)]),'face_normal_rotation_degrees':stats(angle),'face_area_ratio':stats(newa/oldarea),'warning':'Distance and signed-normal bounds cannot certify matching semantic terrace/layer; rejected and unmodified vertices remain explicit.'}
