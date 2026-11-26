"""Source-high CPU QEM LOD; immutable source and measured sequential lineage.

This is an independent geometry route, not MeshAnything or a Nanite builder.
Changed topology is geometry-only and explicitly requires UV/material baking.
"""
import hashlib
import json
import math
import time
from pathlib import Path
import numpy as np
import trimesh
from native3d_geometry import mesh_hash, validate_arrays
from native3d_geometry_audit import audit_geometry, require_audited


def _percent(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, float, np.integer, np.floating)) or not np.isfinite(value) or not 0 < value <= 100:
        raise ValueError(name+' must be a finite keep percentage within(0,100]')
    return float(value)


def _cap(value, name):
    if value is None or (type(value) is int and value == 0):
        return None
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, (int, np.integer)) or not 4 <= value <= 100000:
        raise ValueError(name+' must be0/None or an integer within4..100000')
    return int(value)


def resolve_lod_settings(params=None):
    """Accept internal arrays or the public scalar parameter schema.

    lodKeepPercents is cumulative relative to actual LOD0. The alternate
    previous-level reference is also explicit, never inferred from values.
    """
    params = dict(params or {})
    reference = params.get('lodPercentReference', 'lod0')
    if reference not in ('lod0', 'previous'):
        raise ValueError('lodPercentReference must be lod0 or previous')
    percentages = params.get('lodKeepPercents', [100]+[params.get('lod'+str(i)+'KeepPercent', p)
                                                     for i, p in enumerate((50, 25, 12.5, 6.25), 1)])
    caps = params.get('lodFaceCaps', [params.get('lod0FaceCap', 100000)]+
                      [params.get('lod'+str(i)+'FaceCap', 0) for i in range(1, 5)])
    if not isinstance(percentages, (list, tuple)) or len(percentages) != 5:
        raise ValueError('Exactly five logical LOD keep percentages required')
    if not isinstance(caps, (list, tuple)) or len(caps) != 5:
        raise ValueError('Exactly five logical LOD caps required')
    percentages = [_percent(p, 'LOD'+str(i)+' keep percentage') for i, p in enumerate(percentages)]
    if percentages[0] != 100:
        raise ValueError('LOD0 relative to LOD0 must be100%; original source keep is a separate parameter')
    if reference == 'lod0' and any(a < b for a, b in zip(percentages, percentages[1:])):
        raise ValueError('Cumulative LOD0 percentages must not increase')
    caps = [_cap(c, 'LOD'+str(i)+' face cap') for i, c in enumerate(caps)]
    count = params.get('lodCount', 5)
    if type(count) is not int or not 1 <= count <= 5:
        raise ValueError('lodCount must be an integer within 1..5')
    selected = params.get('selectedLodLevel', 0)
    if type(selected) is not int or not 0 <= selected < count:
        raise ValueError('selectedLodLevel must be below lodCount')
    return {'lod0KeepPercent': _percent(params.get('lod0KeepPercent', 10), 'Original to LOD0 keep'),
            'lodPercentReference': reference, 'lodKeepPercents': percentages,
            'lodFaceCaps': caps, 'selectedLodLevel': selected, **({'lodCount': count} if count != 5 else {})}


def logical_target(level, source_faces, lod0_faces, previous_faces, settings):
    if level == 0:
        base = source_faces
        percent = settings['lod0KeepPercent']
        reference = 'original_source'
    else:
        reference = settings['lodPercentReference']
        base = lod0_faces if reference == 'lod0' else previous_faces
        percent = settings['lodKeepPercents'][level]
    percentage_target = max(4, int(math.floor(base*percent/100)))
    cap = settings['lodFaceCaps'][level]
    effective = min(previous_faces, percentage_target, cap if cap is not None else previous_faces)
    return {'percentageReference': reference, 'percentageBaseTriangles': int(base),
            'requestedKeepPercent': percent, 'percentageTargetTriangles': percentage_target,
            'faceCap': cap, 'effectiveTargetTriangles': int(effective),
            'effectiveTargetKeepPercent': float(effective/base*100),
            'budgetClampedPercentage': bool(cap is not None and cap < percentage_target)}


def _sample(vertices, faces, count, seed):
    tri = np.asarray(vertices)[np.asarray(faces)]
    cross = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
    length = np.linalg.norm(cross, axis=1)
    if not np.isfinite(length).all() or length.sum() <= 0:
        raise ValueError('Invalid source surface for fidelity sampling')
    rng = np.random.default_rng(seed)
    ids = rng.choice(len(faces), size=int(count), p=length/length.sum())
    uv = rng.random((int(count), 2))
    folded = uv.sum(1) > 1
    uv[folded] = 1-uv[folded]
    points = tri[ids, 0]+uv[:, :1]*(tri[ids, 1]-tri[ids, 0])+uv[:, 1:]*(tri[ids, 2]-tri[ids, 0])
    return points, cross[ids]/length[ids, None]


class _Reference:
    def __init__(self, vertices, faces):
        import open3d as o3d
        self.o3d = o3d
        self.scene = o3d.t.geometry.RaycastingScene()
        self.scene.add_triangles(o3d.core.Tensor(np.asarray(vertices, np.float32)),
                                 o3d.core.Tensor(np.asarray(faces, np.uint32)))

    def compare(self, points, normals, diagonal):
        found = self.scene.compute_closest_points(self.o3d.core.Tensor(np.asarray(points, np.float32)))
        q = found['points'].numpy().astype(float)
        n = found['primitive_normals'].numpy().astype(float)
        distance = np.linalg.norm(q-points, axis=1)
        if not np.isfinite(distance).all() or not np.isfinite(n).all():
            raise ValueError('Nonfinite fidelity query')
        dot = np.einsum('ni,ni->n', normals, n)
        return {'samples': len(points), 'distanceP95Fraction': float(np.percentile(distance, 95)/diagonal),
                'sampledMaxDistanceFraction': float(distance.max()/diagonal),
                'normalDotP05': float(np.percentile(dot, 5)),
                'oppositeNormalFraction': float(np.mean(dot < 0))}


def _canonical_mesh(vertices, faces):
    # GLB stores positions as float32. Gate the exact values that will be
    # exported and used by the next pass, not a higher-precision predecessor.
    return trimesh.Trimesh(np.asarray(vertices, np.float32).astype(np.float64),
                           np.asarray(faces, np.int64), process=False)


def normalize_source_geometry(vertices, faces):
    """Join only bit-identical position copies on a geometry-only derivative.

    This removes imported UV/normal seam splits without moving points, dropping
    faces, epsilon welding or altering the original asset/its corner attributes.
    Residual true topology defects remain explicit and must not survive output
    acceptance. The source reference is never claimed to be clean by this step.
    """
    vertices, faces = validate_arrays(vertices, faces)
    unique, inverse = np.unique(vertices, axis=0, return_inverse=True)
    if len(unique) == len(vertices):
        normalized_v, normalized_f = vertices, faces
    else:
        normalized_v, normalized_f = unique, inverse[faces]
    original_positions = hashlib.sha256()
    normalized_positions = hashlib.sha256()
    for offset in range(0, len(faces), 16384):
        original_positions.update(np.asarray(vertices[faces[offset:offset+16384]], '<f8').tobytes())
        normalized_positions.update(np.asarray(normalized_v[normalized_f[offset:offset+16384]], '<f8').tobytes())
    if original_positions.digest() != normalized_positions.digest():
        raise ValueError('Exact-position normalization altered a source triangle')
    return normalized_v, normalized_f, {
        'method': 'geometry-only exact-coordinate vertex identity normalization; no epsilon weld',
        'sourceVertices': len(vertices), 'geometryVertices': len(normalized_v),
        'joinedDuplicatePositionVertices': len(vertices)-len(normalized_v),
        'sourceTriangles': len(faces), 'geometryTriangles': len(normalized_f),
        'sourceTrianglePositionsSha256': original_positions.hexdigest(),
        'normalizedTrianglePositionsSha256': normalized_positions.hexdigest(),
        'faceOrderPreserved': True, 'allTriangleCoordinatesExact': True,
        'sourceAttributesUnchanged': True, 'noAutomaticHoleCaps': True}


def separate_existing_vertex_fans(vertices, faces, report):
    """Split only already disconnected vertex fans, with no surface change.

    Connectivity uses edges with exactly two owners. Ambiguous four-owner
    junctions become explicit open sheet boundaries; no pairing is guessed.
    This is bounded to64 affected vertices/64 contact edges per source.
    """
    bad_vertices = report.get('nonmanifold_vertices', [])
    bad_edges = report.get('nonmanifold_edges', [])
    if report.get('nonmanifold_vertices_count', 0) > 64 or report.get('nonmanifold_edges_count', 0) > 64:
        raise ValueError('Source sheet normalization exceeds64 local vertices/edges')
    v, f = validate_arrays(vertices, faces)
    new_vertices = []
    changes = []
    for vertex in bad_vertices:
        ids = np.flatnonzero(np.any(f == vertex, axis=1))
        if len(ids) > 4096:
            raise ValueError('Source vertex fan exceeds4096 incident faces')
        adjacency = {int(fi):set() for fi in ids}
        edges = {}
        for fi in ids:
            for other in f[fi]:
                if other != vertex:
                    edges.setdefault(int(other), []).append(int(fi))
        for owners in edges.values():
            if len(owners) == 2:
                for fi in owners:
                    adjacency[fi].update(owners)
        seen = set(); groups = []
        for fi in ids:
            if int(fi) in seen:
                continue
            group = []; stack = [int(fi)]
            while stack:
                current = stack.pop()
                if current in seen:
                    continue
                seen.add(current); group.append(current); stack.extend(adjacency[current]-seen)
            groups.append(sorted(group))
        for group in groups[1:]:
            new_index = len(v)+len(new_vertices)
            new_vertices.append(v[vertex].copy())
            for fi in group:
                f[fi, f[fi] == vertex] = new_index
        if len(groups) > 1:
            changes.append({'sourceVertex': int(vertex), 'fanFaceIds': groups,
                            'duplicatedVertices': len(groups)-1})
    result = np.concatenate((v, np.asarray(new_vertices).reshape(-1,3)))
    for begin in range(0,len(f),16384):
        if not np.array_equal(result[f[begin:begin+16384]],np.asarray(vertices)[np.asarray(faces)[begin:begin+16384]]):
            raise ValueError('Source fan separation changed a triangle coordinate/order')
    contacts = np.asarray(vertices)[np.asarray(bad_edges,dtype=int)] if bad_edges else np.empty((0,2,3))
    return result, f, {'method':'existing edge-connected vertex fans separated; no guessed sheet pairing',
                      'changes':changes,'duplicatedVertices':len(new_vertices),
                      'allTriangleCoordinatesExact':True,'faceOrderPreserved':True,
                      'noFacesAddedOrRemoved':True,'permittedContactEdges':contacts.tolist(),
                      'topology':'explicit open source contact sheets; not certified closed'}


def _triangulate_boundary(vertices, cycle):
    """Bounded constrained ear clipping of one simple projected boundary.

    Every boundary vertex and its directed edge is retained. Projection only
    chooses diagonals; output uses the original exact 3D vertices.
    """
    if not 3 <= len(cycle) <= 128 or len(set(cycle)) != len(cycle):
        raise ValueError('Local repair requires one simple3..128vertex cycle')
    xyz = np.asarray(vertices)[cycle]
    _,_,axes = np.linalg.svd(xyz-xyz.mean(0),full_matrices=False)
    p = (xyz-xyz.mean(0))@axes[:2].T
    cross = lambda a,b: float(a[0]*b[1]-a[1]*b[0])
    signed = sum(cross(a,b) for a,b in zip(p,np.roll(p,-1,axis=0)))*.5
    if signed < 0:
        p[:,1] *= -1
    tolerance = max(float(np.ptp(p,axis=0).max())**2*1e-12,1e-24)
    if abs(signed) <= tolerance:
        raise ValueError('Local repair boundary projection has no area')
    # Reject crossed projected boundaries rather than inventing a surface.
    for i in range(len(p)):
        for j in range(i+1,len(p)):
            if j == i+1 or (i == 0 and j == len(p)-1):
                continue
            a,b = p[i],p[(i+1)%len(p)]
            c,d = p[j],p[(j+1)%len(p)]
            x1,x2 = cross(b-a,c-a),cross(b-a,d-a)
            x3,x4 = cross(d-c,a-c),cross(d-c,b-c)
            if x1*x2 < -tolerance**2 and x3*x4 < -tolerance**2:
                raise ValueError('Local repair projected boundary crosses itself')
    left = list(range(len(cycle))); triangles=[]
    while len(left) > 3:
        clipped=False
        for k,middle in enumerate(left):
            a,b,c=left[k-1],middle,left[(k+1)%len(left)]
            if cross(p[b]-p[a],p[c]-p[b]) <= tolerance:
                continue
            inside=False
            for other in left:
                if other in (a,b,c):continue
                q=p[other]
                if min(cross(p[b]-p[a],q-p[a]),cross(p[c]-p[b],q-p[b]),cross(p[a]-p[c],q-p[c])) >= -tolerance:
                    inside=True;break
            if inside:continue
            triangles.append([cycle[a],cycle[b],cycle[c]])
            left.pop(k);clipped=True;break
        if not clipped:
            raise ValueError('Local repair constrained ear clipping stalled')
    if cross(p[left[1]]-p[left[0]],p[left[2]]-p[left[0]]) <= tolerance:
        raise ValueError('Local repair final triangle degenerate in projection')
    triangles.append([cycle[i] for i in left])
    return np.asarray(triangles,dtype=np.int64)


def _triangulate_boundary_3d(vertices, cycle):
    """Minimum-area triangulation of a bounded 3D cyclic polygon by DP.

    A nonplanar boundary can cross its planar projection without crossing in
    3D. This selects a combinatorial disk without requiring that projection.
    It is only a candidate: complete embedded intersection/fidelity gates are
    mandatory afterward; knotted boundaries are never assumed repairable.
    """
    if not 3<=len(cycle)<=128 or len(set(cycle))!=len(cycle):
        raise ValueError('Local3Drepair requires one simple3..128vertex cycle')
    points=np.asarray(vertices)[cycle];count=len(cycle)
    tolerance=max(float(np.linalg.norm(np.ptp(points,axis=0)))**2*1e-12,1e-24)
    costs=np.full((count,count),np.inf);choice=np.full((count,count),-1,dtype=int)
    for i in range(count-1):costs[i,i+1]=0.
    for gap in range(2,count):
        for i in range(count-gap):
            j=i+gap
            for k in range(i+1,j):
                area=float(np.linalg.norm(np.cross(points[k]-points[i],points[j]-points[i]))*.5)
                if area<=tolerance:continue
                value=costs[i,k]+costs[k,j]+area
                if value<costs[i,j]:costs[i,j]=value;choice[i,j]=k
    if not np.isfinite(costs[0,-1]):
        raise ValueError('No nondegenerate bounded3Ddisk triangulation')
    triangles=[];stack=[(0,count-1)]
    while stack:
        i,j=stack.pop()
        if j-i<2:continue
        k=int(choice[i,j])
        if k<0:raise ValueError('Incomplete3Ddisk triangulation')
        triangles.append([cycle[i],cycle[k],cycle[j]])
        stack.extend(((i,k),(k,j)))
    return np.asarray(triangles,dtype=np.int64)


def _local_repair_face_ids(faces, topology_report, pairs):
    """Close only complete stars of vertices shared by proven crossing pairs."""
    f=np.asarray(faces,np.int64)
    shared=sorted({int(vertex) for a,b in pairs for vertex in np.intersect1d(f[a],f[b])})
    seeds=np.unique(np.r_[np.asarray(topology_report.get('nonmanifold_vertices',[]),dtype=np.int64),
                          np.asarray(shared,dtype=np.int64)])
    touched=np.flatnonzero(np.any(np.isin(f,seeds),axis=1)) if len(seeds) else np.empty(0,dtype=np.int64)
    return np.unique(np.r_[touched,np.asarray(pairs,dtype=np.int64).ravel()]),shared


def repair_source_local_patch(vertices, faces, topology_report, intersection_report):
    """Replace one proven tiny folded disk, on a copy, never fill unknown holes.

    At most256 removed faces, one<=128edge cut, diameter<=0.006source diagonal;
    all outside triangles/positions remain exact. Caller MUST run a complete
    full-mesh audit before using this candidate as a simplification input.
    """
    v,f=validate_arrays(vertices,faces)
    pairs=intersection_report.get('intersection_pairs',[])
    if not pairs or intersection_report.get('intersectionStatus') != 'defect_found_search_stopped':
        raise ValueError('Local repair needs proven source intersection pairs')
    if topology_report.get('nonmanifold_vertices_count',0)>64:
        raise ValueError('Local repair source defect scope exceeds64 vertices')
    removed,shared_vertices=_local_repair_face_ids(f,topology_report,pairs)
    if not 1 <= len(removed) <= 256:
        raise ValueError('Local source repair exceeds256 proven affected faces')
    diagonal=float(np.linalg.norm(np.ptp(v,axis=0)))
    patch_points=v[np.unique(f[removed])]
    patch_diagonal=float(np.linalg.norm(np.ptp(patch_points,axis=0)))
    if patch_diagonal > diagonal*.006:
        raise ValueError('Local source repair exceeds0.6% source diagonal')
    local_edges=np.stack((f[removed],np.roll(f[removed],-1,axis=1)),axis=2).reshape(-1,2)
    unique, first, counts=np.unique(np.sort(local_edges,axis=1),axis=0,return_index=True,return_counts=True)
    # A simple outer cycle alone does not exclude a handle or closed component.
    if np.any(counts>2) or len(np.unique(f[removed]))-len(unique)+len(removed)!=1:
        raise ValueError('Local repair requires a manifold Euler-one disk')
    owners={}
    for face_id,triangle in enumerate(f[removed]):
        for a,b in zip(triangle,np.roll(triangle,-1)):
            owners.setdefault(tuple(sorted((int(a),int(b)))),[]).append(face_id)
    neighbors=[set() for _ in removed]
    for adjacent in owners.values():
        if len(adjacent)==2:
            a,b=adjacent;neighbors[a].add(b);neighbors[b].add(a)
    seen=set();stack=[0]
    while stack:
        face_id=stack.pop()
        if face_id in seen:continue
        seen.add(face_id);stack.extend(neighbors[face_id]-seen)
    if len(seen)!=len(removed):raise ValueError('Local repair requires one edge-connected disk')
    directed=local_edges[first[counts==1]]
    if not 3<=len(directed)<=128:
        raise ValueError('Local repair cut must have3..128 boundary edges')
    successor={};incoming={}
    for a,b in directed:
        if int(a) in successor or int(b) in incoming:
            raise ValueError('Local repair boundary branches or has inconsistent orientation')
        successor[int(a)]=int(b);incoming[int(b)]=int(a)
    cycle=[];current=min(successor)
    while current not in cycle:
        cycle.append(current)
        if current not in successor:
            raise ValueError('Local repair boundary is open')
        current=successor[current]
    if current!=cycle[0] or len(cycle)!=len(successor):
        raise ValueError('Local repair requires exactly one boundary loop, never multiple holes')
    triangulation='boundary-constrained PCA ear clipping'
    try:
        replacement=_triangulate_boundary(v,cycle)
    except ValueError:
        replacement=_triangulate_boundary_3d(v,cycle)
        triangulation='bounded minimum-area3Dcyclic-polygon dynamic programming; no planar projection assumption'
    keep=np.ones(len(f),bool);keep[removed]=False
    candidate=np.concatenate((f[keep],replacement))
    if not np.array_equal(candidate[:int(keep.sum())],f[keep]):
        raise ValueError('Local source repair altered outside faces')
    # The local replacement is measured against the actual original folded
    # surface in both directions, not only against its own new flat disk.
    reference=_Reference(v,f[removed]);new_reference=_Reference(v,replacement)
    points,normals=_sample(v,replacement,4096,923)
    forward=reference.compare(points,normals,diagonal)
    points,normals=_sample(v,f[removed],4096,923)
    backward=new_reference.compare(points,normals,diagonal)
    if max(forward['sampledMaxDistanceFraction'],backward['sampledMaxDistanceFraction'])>.002:
        raise ValueError('Local source repair exceeds0.2% source diagonal sampled distance')
    receipt={'method':'single proven intersection disk; '+triangulation+' with exact original3Dvertices',
             'sourceMeshHash':mesh_hash(v,f),'candidateMeshHash':mesh_hash(v,candidate),
             'removedFaceIds':removed.tolist(),'newFaces':replacement.tolist(),
             'selectionPolicy':'proven crossing faces plus complete incident-face stars only at shared crossing vertices and reported nonmanifold vertices; no iterative neighborhood growth',
             'sharedIntersectionVertices':shared_vertices,'patchEulerCharacteristic':1,'patchFaceComponents':1,
             'removedTriangles':len(removed),'newTriangles':len(replacement),
             'sourceTriangles':len(f),'candidateTriangles':len(candidate),
             'boundaryCycle':cycle,'boundaryLoops':1,'patchDiagonal':patch_diagonal,
             'patchDiagonalFraction':patch_diagonal/diagonal,'maximumPatchDiagonalFraction':.006,
             'outsideFaceOrderAndCoordinatesExact':True,'allVertexPositionsExact':True,
             'newToOriginalPatch':forward,'originalPatchToNew':backward,
             'localSampledMaxDistanceLimitFraction':.002,'seed':923,
             'originalAssetUnchanged':True,'geometryChanged':True,
             'completeAuditRequired':True}
    return v,candidate,receipt


def _save_mesh(mesh, path):
    if path.exists():
        raise FileExistsError('Refusing to overwrite source LOD artifact: '+str(path))
    mesh.metadata.update(nativeGeometryRoute='source_high_cpu_qem',
                         nativeAttributePolicy='geometry_only_requires_uv_and_bake',
                         nativeNormalSource='geometry-generated smooth vertex normals; original source unchanged')
    data = trimesh.exchange.gltf.export_glb(mesh, include_normals=True)
    # Exclusive creation protects against concurrent/repeated invocations too.
    with path.open('xb') as stream:
        stream.write(data)
    reloaded = trimesh.load(path, force='mesh', process=False)
    if not np.array_equal(mesh.vertices, reloaded.vertices) or not np.array_equal(mesh.faces, reloaded.faces):
        raise ValueError('Source LOD exported canonical geometry mismatch')
    return hashlib.sha256(data).hexdigest()


def _prove_selected_result(selected, manifest, folder):
    """A partial chain may expose only a separately validated logical result."""
    matches=[entry for entry in manifest['stages']
             if entry.get('stage')==manifest.get('selectedStage')]
    if len(matches)!=1:
        raise ValueError('No unique accepted selected logical stage')
    stage=matches[0]
    geometry=stage.get('receipt',{}).get('geometry',{})
    fidelity=stage.get('receipt',{}).get('fidelity',{})
    if (stage.get('status')!='accepted' or stage.get('visible') is not True or
        stage.get('eligibleForDownstream') is not True or
        geometry.get('status')!='accepted' or geometry.get('intersectionComplete') is not True or
        geometry.get('intersection_pairs_count')!=0 or fidelity.get('accepted') is not True):
        raise ValueError('Selected logical stage lacks strict geometry/fidelity acceptance')
    if manifest.get('boundaryReferenceMeshHash'):
        boundary=stage.get('receipt',{}).get('boundaryPreservation',{})
        if (boundary.get('accepted') is not True or boundary.get('referenceMeshHash')!=manifest['boundaryReferenceMeshHash'] or
            boundary.get('candidateMeshHash')!=stage.get('mesh_hash')):
            raise ValueError('Selected open stage lacks bound original-boundary proof')
    digest=stage.get('mesh_hash')
    if digest!=manifest.get('selectedMeshHash') or mesh_hash(selected.vertices,selected.faces)!=digest:
        raise ValueError('Returned selected mesh hash differs from accepted logical stage')
    path=Path(folder)/stage.get('filename','')
    if path.suffix!='.glb' or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=stage.get('file_sha256'):
        raise ValueError('Selected canonical artifact missing or file hash mismatch')
    reloaded=trimesh.load(path,force='mesh',process=False)
    if mesh_hash(reloaded.vertices,reloaded.faces)!=digest or geometry.get('mesh_hash')!=digest:
        raise ValueError('Selected canonical artifact does not match audited geometry')
    return stage


def _run_source_lod_core(mesh, output, params=None, progress=None, *, protected_lod0=None, deadline=None):
    """Return (selected_mesh, geometry_manifest, artifacts), like legacy process.

    Stages are `lod0`..`lod4` with explicit lodLevel; intermediate `step_NNN`
    entries are invisible but fully audited. Aliased logical levels share an
    existing artifact and are explicitly not counted as new reductions.
    """
    import fast_simplification
    start = time.monotonic()
    params = dict(params or {})
    settings = resolve_lod_settings(params)
    backend = params.get('simplifierBackend','open3d')
    if backend not in ('open3d','fast_simplification'):
        raise ValueError('Source LOD simplifierBackend must be open3d or fast_simplification')
    folder = Path(output)
    folder.mkdir(parents=True, exist_ok=True)
    report_path = folder/'source-lod-report.json'
    if report_path.exists() or any(folder.glob('lod[0-4].glb')) or any(folder.glob('step_*.glb')):
        raise FileExistsError('Source LOD output already contains a chain; use a new job directory')
    original_hash = mesh_hash(mesh.vertices, mesh.faces)
    v, f, normalization = normalize_source_geometry(mesh.vertices, mesh.faces)
    source_count = len(f)
    if source_count > 2_000_000:
        raise ValueError('Source LOD bounded to2000000 source triangles')
    source_uv = getattr(mesh.visual, 'uv', None)
    import open3d as o3d
    manifest = {'status': 'blocked', 'chainStatus':'blocked','chainComplete':False,
                'mode': 'source_high', 'algorithm': 'CPU '+backend+' QEM; not AI',
                'backend': backend, 'backendVersion': o3d.__version__ if backend=='open3d' else getattr(fast_simplification, '__version__', 'unknown'),
                'settings': settings, 'source_mesh_hash': original_hash, 'sourceTriangles': source_count,
                'normalized_source_mesh_hash': mesh_hash(v, f), 'sourceNormalization': normalization,
                'sourceFileSha256': params.get('sourceFileSha256'), 'sourceUnchanged': True,
                'attributePolicy': 'geometry_only_requires_uv_and_bake',
                'returnedMeshRole':'original_source_diagnostic',
                'sourceAttributesPresent': {'uv': source_uv is not None, 'material': bool(mesh.metadata.get('nativeMaterials'))},
                'nanite': {'sameLod0Asset': True, 'built': False, 'note': 'UE Nanite build and performance verification remain external'},
                'normalPolicy': 'geometry-generated smooth vertex normals; source authored normals kept only in original asset',
                'maxReductionFractionPerPass': .5, 'reductionFaceParityTolerance': 1, 'maxPasses': 32,
                'hiddenIntermediatePolicy':'Topology-clean inherited/intermediate intersections may continue only as diagnostic solver state; each visible logical LOD must independently pass complete zero-intersection audit, fidelity and canonical export',
                'stages': [], 'logicalLevels': [], 'limitations': [
                    'CPU QEM does not preserve source UV/material attributes on changed topology.',
                    'Fidelity uses deterministic bidirectional area samples, not an exhaustive Hausdorff proof.',
                    'Intermediate steps constrain reduction size, not an artistic quality guarantee.',
                    'Nanite uses the same LOD0 geometry; no UE Nanite construction or performance test is performed.']}
    artifacts = []
    selected = mesh.copy(include_cache=True)
    pending_candidate=None
    pending_entry=None
    diagonal = float(np.linalg.norm(np.ptp(v, axis=0)))
    if diagonal <= 0:
        raise ValueError('Nonzero source geometry extent required')
    max_seconds = float(params.get('maxSeconds', 900))
    if not np.isfinite(max_seconds) or max_seconds <= 0:
        raise ValueError('Positive finite source LOD wall budget required')
    if deadline is not None:
        max_seconds=min(max_seconds,deadline-time.monotonic())
        if max_seconds<=0:raise ValueError('Shared source LOD wall budget exhausted')
    audit_seconds = min(120., max_seconds)
    sample_count = 4096
    p95_limit = .005
    maximum_limit = .02
    audit_context={'allow_boundaries':False,'contact_edges':None}
    boundary_reference=None

    def event(stage, fraction):
        if time.monotonic()-start > max_seconds:
            raise ValueError('Source LOD wall budget exhausted')
        if progress is not None:
            progress(stage, fraction)

    def audited(a, b):
        remaining = max_seconds-(time.monotonic()-start)
        if remaining <= 0:
            raise ValueError('Source LOD wall budget exhausted')
        report = audit_geometry(a, b, max_seconds=min(audit_seconds, remaining),
                                allow_boundaries=audit_context['allow_boundaries'],
                                permitted_contact_edges=audit_context['contact_edges'])
        return report

    def compare(candidate):
        points, normals = _sample(candidate.vertices, candidate.faces, sample_count, 7321)
        forward = reference.compare(points, normals, diagonal)
        candidate_reference = _Reference(candidate.vertices, candidate.faces)
        backward = candidate_reference.compare(source_points, source_normals, diagonal)
        result = {'method': 'deterministic bidirectional original-source area samples / Open3D closest points',
                  'seed': 7321, 'sourceDiagonal': diagonal, 'childToSource': forward,
                  'sourceToChild': backward, 'p95LimitFraction': p95_limit,
                  'sampledMaxLimitFraction': maximum_limit, 'oppositeNormalFractionLimit': .25}
        result['accepted'] = all(row['distanceP95Fraction'] <= p95_limit and
                                 row['sampledMaxDistanceFraction'] <= maximum_limit and
                                 row['oppositeNormalFraction'] <= .25 for row in (forward, backward))
        return result

    try:
        event('source_lod_audit_original', 5)
        source_audit = audited(v, f)
        manifest['sourceBeforeSheetSeparationAudit'] = source_audit
        if source_audit.get('boundary_edges'):
            from native3d_lod_boundary import OriginalBoundaryReference
            boundary_reference=OriginalBoundaryReference(v,f)
            manifest['boundaryReferenceMeshHash']=boundary_reference.mesh_hash
        manifest['sourceAudit'] = source_audit
        audit_context['allow_boundaries']=bool(source_audit.get('boundary_edges'))
        normalized_base_v,normalized_base_f=v,f
        if source_audit.get('nonmanifold_vertices_count') and not source_audit.get('duplicate_faces') and not source_audit.get('degenerate_faces_count'):
            v,f,separation = separate_existing_vertex_fans(v,f,source_audit)
            manifest['sourceSheetSeparation'] = separation
            audit_context.update(allow_boundaries=True,contact_edges=separation['permittedContactEdges'])
            source_audit = audited(v,f)
            manifest['sourceAudit']=source_audit
            manifest['normalized_source_mesh_hash'] = mesh_hash(v,f)
        if protected_lod0 is None and source_audit.get('intersectionStatus')=='defect_found_search_stopped':
            event('source_lod_repair_proven_local_fold',7)
            v,f,repair=repair_source_local_patch(normalized_base_v,normalized_base_f,
                manifest['sourceBeforeSheetSeparationAudit'],source_audit)
            manifest['sourceLocalRepair']=repair
            if 'sourceSheetSeparation' in manifest:
                manifest['sourceSheetSeparation']['supersededByLocalRepair']=True
                manifest['sourceSheetSeparation']['diagnosticContactEdges']=manifest['sourceSheetSeparation'].pop('permittedContactEdges')
            audit_context.update(allow_boundaries=bool(manifest['sourceBeforeSheetSeparationAudit'].get('boundary_edges')),
                                 contact_edges=None)
            source_audit=audited(v,f)
            manifest['sourceAudit']=source_audit
            repair['geometry']=source_audit
            repair['geometryAuditExecuted']=True
            repair['completeAuditPassed']=source_audit['status']=='accepted' and source_audit['intersectionComplete']
            # Other inherited folds may remain elsewhere in the original.
            # The repaired copy is an explicitly dirty REFERENCE/INPUT, never
            # an accepted production stage. A QEM child must be fully clean;
            # no additional local-repair loop or new contact exemption exists.
            if source_audit['status']!='accepted' and source_audit.get('blocker')!='geometry_intersection':
                require_audited(source_audit)
            repair['remainingSourceDefectsExplicit']=not repair['completeAuditPassed']
            manifest['normalized_source_mesh_hash']=mesh_hash(v,f)
        manifest['sourceAudit'] = source_audit
        # The original is a reference, not a claimed clean production mesh.
        # Known imported defects may disappear through ordinary simplification;
        # every actual candidate still must pass a complete clean output audit.
        if 'componentCount' not in source_audit or 'boundaryPositionHash' not in source_audit:
            raise ValueError('Source topology audit incomplete before simplification')
        manifest['sourceReferenceQuality'] = source_audit['status']
        manifest['workingSourceTriangles']=len(f)
        manifest['sourceOriginalQuality']='not certified clean; immutable original and pre-normalization defect report retained'
        source_points, source_normals = _sample(mesh.vertices, mesh.faces, sample_count, 7321)
        reference = _Reference(mesh.vertices, mesh.faces)
        parent_hash = manifest['normalized_source_mesh_hash']
        parent_stage = 'original_source'
        lod0_count = None
        pass_number = 0
        for level in range(settings.get('lodCount', 5)):
            plan = logical_target(level, source_count, lod0_count, len(f), settings)
            target = plan['effectiveTargetTriangles']
            previous_count = len(f)
            logical_file = None
            if level==0 and protected_lod0 is not None:
                protected_mesh,protected_receipt=protected_lod0
                manifest.update(backend='mixed',backendVersion=None,
                    algorithm='CPU protected PyMeshLab LOD0 followed by Open3D LOD1-4; not AI',
                    backendVersions={'lod0':protected_receipt.get('runtime',{}),
                                     'lod1To4':{'name':backend,'version':o3d.__version__}})
                candidate=_canonical_mesh(protected_mesh.vertices,protected_mesh.faces)
                entry={'stage':'lod0','lodLevel':0,'visible':True,'eligibleForDownstream':False,
                       'parentStage':parent_stage,'parent_mesh_hash':parent_hash,
                       'mesh_hash':mesh_hash(candidate.vertices,candidate.faces),'filename':'lod0.glb','status':'blocked',
                       'receipt':{'method':'optional protected LOD0; actual bounded passes in protectedSolver',
                                  'protectedSolver':protected_receipt,'requested_triangles':target,
                                  'actual_triangles':len(candidate.faces),'parentTriangles':len(f),
                                  'reductionPerformed':len(candidate.faces)<len(f),'quantization':'float32 canonical before all output gates'}}
                manifest['stages'].append(entry);pending_candidate,pending_entry=candidate,entry
                if (protected_receipt.get('status')!='complete' or len(candidate.faces)>target or
                    protected_receipt.get('candidateMeshHash')!=entry['mesh_hash']):
                    raise ValueError('Protected builder did not provide a bound complete target candidate')
                # Every real QEM pass retains its own parent and 50% budget.
                passes=protected_receipt.get('qemPasses',[])
                if len(f)>target and not passes:raise ValueError('Protected builder omitted reduction lineage')
                for step in passes:
                    before=step['parentTriangles'];actual=step['actualTriangles'];requested=step['requestedTriangles']
                    if not max(1,math.ceil(before*.5)-1)<=actual<=requested or actual>=before:
                        raise ValueError('Protected builder reduction lineage violates50% budget')
                report=audited(candidate.vertices,candidate.faces);entry['receipt']['geometry']=report;require_audited(report)
                if boundary_reference is not None:
                    entry['receipt']['boundaryPreservation']=boundary_reference.compare(candidate.vertices,candidate.faces)
                elif report['boundaryPositionHash']!=source_audit['boundaryPositionHash']:
                    raise ValueError('Protected LOD0 changed original closed boundary')
                if report['componentCount']!=source_audit['componentCount'] or source_audit['signedVolume']*report['signedVolume']<0:
                    raise ValueError('Protected LOD0 changed components or orientation')
                fidelity=compare(candidate);entry['receipt']['fidelity']=fidelity
                if not fidelity['accepted']:raise ValueError('Protected LOD0 original source fidelity failed')
                path=folder/'lod0.glb';digest=_save_mesh(candidate,path)
                entry.update(status='accepted',eligibleForDownstream=True,file_sha256=digest)
                artifacts.append({'path':str(path),'name':path.name,'filename':path.name,'sha256':digest,'role':'export'})
                v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces);parent_hash,parent_stage=entry['mesh_hash'],'lod0'
                logical_file=entry;pending_candidate,pending_entry=None,None
            while len(f) > target:
                pass_number += 1
                if pass_number > manifest['maxPasses']:
                    raise ValueError('Source LOD pass budget exhausted')
                event('source_lod_reduce_'+str(level), 10+level*15)
                minimum_faces = int(math.ceil(len(f)*.5))
                requested = max(target, minimum_faces)
                before = len(f)
                # No source attributes are passed to, or overwritten by, QEM.
                if backend == 'fast_simplification':
                    nv, nf = fast_simplification.simplify(v.copy(), f.copy(), target_count=requested,
                                                          preserve_border=True, return_collapses=False)
                else:
                    decimator = o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v),
                                                        o3d.utility.Vector3iVector(f))
                    # High penalty is a preference, NOT a guarantee: the exact
                    # post-export boundary-position hash below is the gate.
                    reduced = decimator.simplify_quadric_decimation(requested, boundary_weight=1e12)
                    nv, nf = np.asarray(reduced.vertices), np.asarray(reduced.triangles)
                actual = len(nf)
                if actual >= before:
                    raise ValueError('Source LOD simplifier stalled before requested budget')
                if actual > requested:
                    raise ValueError('Source LOD simplifier stopped above requested budget')
                if actual < max(1, minimum_faces-1):
                    raise ValueError('Source LOD simplifier exceeded50% bounded reduction (one face parity tolerance)')
                candidate = _canonical_mesh(nv, nf)
                stage_id = 'lod'+str(level) if actual <= target else 'step_'+str(pass_number).zfill(3)
                entry = {'stage': stage_id, 'lodLevel': level if actual <= target else None,
                         'visible': actual <= target, 'eligibleForDownstream':False, 'parentStage': parent_stage,
                         'parent_mesh_hash': parent_hash, 'mesh_hash': mesh_hash(candidate.vertices, candidate.faces),
                         'filename': stage_id+'.glb', 'status': 'blocked',
                         'receipt': {'requested_triangles': requested, 'actual_triangles': actual,
                                     'parentTriangles': before, 'keepPercentOfParent': actual/before*100,
                                     'sourceKeepPercent': actual/source_count*100,
                                     'method': backend+' CPU QEM', 'preserveBorder': backend=='fast_simplification',
                                     'open3dBoundaryWeight':1e12 if backend=='open3d' else None,
                                     'reductionPerformed': True, 'quantization': 'float32 canonical before all output gates',
                                     'maxPositionQuantizationDistance': float(np.linalg.norm(np.asarray(nv)-candidate.vertices, axis=1).max())}}
                manifest['stages'].append(entry)
                pending_candidate,pending_entry=candidate,entry
                report = audited(candidate.vertices, candidate.faces)
                entry['receipt']['geometry'] = report
                topology_clean=all(report.get(key)==0 for key in ('degenerate_faces_count','duplicate_faces',
                    'nonmanifold_edges_count','nonmanifold_vertices_count','inconsistent_winding_edges'))
                diagnostic_intermediate=(not entry['visible'] and report.get('blocker')=='geometry_intersection'
                                         and topology_clean)
                if not diagnostic_intermediate:
                    require_audited(report)
                if boundary_reference is not None:
                    entry['receipt']['boundaryPreservation']=boundary_reference.compare(candidate.vertices,candidate.faces)
                elif report['boundaryPositionHash'] != source_audit['boundaryPositionHash']:
                    raise ValueError('Source LOD created or changed an original open boundary')
                if report['componentCount'] != source_audit['componentCount']:
                    raise ValueError('Source LOD changed source connected-component count')
                if source_audit['signedVolume']*report['signedVolume'] < 0:
                    raise ValueError('Source LOD changed signed orientation')
                event('source_lod_fidelity_'+str(level), 15+level*15)
                fidelity = compare(candidate)
                entry['receipt']['fidelity'] = fidelity
                if not fidelity['accepted']:
                    raise ValueError('Source LOD sampled fidelity gate failed')
                if diagnostic_intermediate:
                    # This is numeric solver state, never an accepted/exported
                    # asset. Keep the actual failed audit and exact parent/hash.
                    # A later visible level cannot inherit acceptance from it.
                    path=folder/('transient_'+stage_id+'.npz')
                    if path.exists():raise FileExistsError(path)
                    with path.open('xb') as stream:
                        np.savez_compressed(stream,vertices=candidate.vertices,faces=candidate.faces)
                    entry.update(status='diagnostic_intermediate',filename=None,
                                 diagnosticFilename=path.name,
                                 diagnosticFileSha256=hashlib.sha256(path.read_bytes()).hexdigest())
                    manifest['hasDiagnosticIntermediates']=True
                    v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
                    parent_hash,parent_stage=entry['mesh_hash'],stage_id
                    pending_candidate,pending_entry=None,None
                    continue
                path = folder/entry['filename']
                digest = _save_mesh(candidate, path)
                entry.update(status='accepted', file_sha256=digest,eligibleForDownstream=entry['visible'])
                artifacts.append({'path': str(path), 'name': path.name, 'filename': path.name,
                                  'sha256': digest, 'role': 'export'})
                pending_candidate,pending_entry=None,None
                v, f = np.asarray(candidate.vertices), np.asarray(candidate.faces)
                parent_hash, parent_stage = entry['mesh_hash'], stage_id
                logical_file = entry if actual <= target else None
            if logical_file is None:
                # Explicit aliases avoid fabricating a reduction for small
                # inputs or percentage/cap combinations with equal counts.
                if not manifest['stages']:
                    candidate = _canonical_mesh(v, f)
                    report = audited(candidate.vertices, candidate.faces)
                    require_audited(report)
                    if report['boundaryPositionHash'] != source_audit['boundaryPositionHash']:
                        raise ValueError('Unchanged source LOD altered an original boundary')
                    fidelity = compare(candidate)
                    if not fidelity['accepted']:
                        raise ValueError('Unchanged LOD canonical export fidelity failed')
                    path = folder/'lod0.glb'
                    digest = _save_mesh(candidate, path)
                    logical_file = {'stage': 'lod0', 'lodLevel': 0, 'visible': True,
                                    'eligibleForDownstream':True,
                                    'parentStage': parent_stage, 'parent_mesh_hash': parent_hash,
                                    'mesh_hash': mesh_hash(candidate.vertices, candidate.faces),
                                    'filename': path.name, 'file_sha256': digest, 'status': 'accepted',
                                    'receipt': {'geometry': report, 'fidelity': fidelity, 'reductionPerformed': False,
                                                'actual_triangles': len(f), 'parentTriangles': len(f),
                                                'keepPercentOfParent': 100., 'quantization': 'float32 canonical export'}}
                    if boundary_reference is not None:
                        logical_file['receipt']['boundaryPreservation']=boundary_reference.compare(candidate.vertices,candidate.faces)
                    manifest['stages'].append(logical_file)
                    artifacts.append({'path': str(path), 'name': path.name, 'filename': path.name,
                                      'sha256': digest, 'role': 'export'})
                    v, f = np.asarray(candidate.vertices), np.asarray(candidate.faces)
                    parent_hash, parent_stage = logical_file['mesh_hash'], 'lod0'
                else:
                    prior = manifest['stages'][-1]
                    logical_file = {'stage': 'lod'+str(level), 'lodLevel': level, 'visible': True,
                                    'eligibleForDownstream':True,
                                    'parentStage': parent_stage, 'parent_mesh_hash': parent_hash,
                                    'mesh_hash': parent_hash, 'filename': prior['filename'],
                                    'file_sha256': prior['file_sha256'], 'status': 'accepted',
                                    'aliasOfStage': prior.get('aliasOfStage', prior['stage']),
                                    'receipt': {**prior['receipt'], 'reductionPerformed': False,
                                                'actual_triangles': len(f), 'parentTriangles': len(f),
                                                'keepPercentOfParent': 100.}}
                    manifest['stages'].append(logical_file)
                    parent_stage = logical_file['stage']
            if level == 0:
                lod0_count = len(f)
            logical_file['plan'] = plan
            logical_file['receipt'].update(lod0KeepPercent=len(f)/lod0_count*100,
                                           sourceKeepPercent=len(f)/source_count*100,
                                           logicalParentTriangles=previous_count)
            manifest['logicalLevels'].append({'lodLevel': level, 'stage': logical_file['stage'],
                                               'filename': logical_file['filename'], 'triangles': len(f),
                                               'mesh_hash': logical_file['mesh_hash'], 'plan': plan,
                                               'lod0KeepPercent': len(f)/lod0_count*100})
            if level == settings['selectedLodLevel']:
                selected = _canonical_mesh(v, f)
                manifest['selectedStage'] = logical_file['stage']
                manifest['selectedMeshHash'] = logical_file['mesh_hash']
                manifest['selectedLod'] = len(f)
        if mesh_hash(mesh.vertices, mesh.faces) != original_hash:
            raise ValueError('Source arrays mutated during source LOD')
        event('source_lod_complete', 95)
        manifest.update(status='accepted', selectedLodLevel=settings['selectedLodLevel'],
                        acceptanceScope='complete_chain',chainStatus='accepted',chainComplete=True,
                        returnedMeshRole='accepted_selected_logical_level',
                        lod0MeshHash=manifest['logicalLevels'][0]['mesh_hash'],
                        naniteLod0File=manifest['logicalLevels'][0]['filename'])
    except ValueError as error:
        manifest['status'] = 'blocked'
        manifest['blocker'] = str(error)
        manifest.update(chainStatus='blocked',chainComplete=False,chainBlocker=str(error))
        if pending_candidate is not None:
            # A failed candidate is inspectable, but the manifest and its
            # explicit diagnostic filename prevent production-stage eligibility.
            path=folder/('blocked_'+pending_entry['stage']+'.glb')
            pending_candidate.metadata['nativeGeometryCandidateStatus']='blocked_diagnostic_only'
            digest=_save_mesh(pending_candidate,path)
            pending_entry.update(diagnosticFilename=path.name,diagnosticFileSha256=digest)
            artifacts.append({'path':str(path),'name':path.name,'filename':path.name,
                              'sha256':digest,'role':'export','diagnostic':True})
            if 'selectedStage' not in manifest:
                selected=pending_candidate
                manifest.update(returnedMeshRole='blocked_diagnostic_candidate',
                                returnedDiagnosticStage=pending_entry['stage'],
                                returnedDiagnosticMeshHash=pending_entry['mesh_hash'])
            else:
                manifest['returnedMeshRole']='validated_selected_level_from_incomplete_chain'
    # Completion of later optional levels cannot invalidate a separately
    # complete selected product. This proof never upgrades a failed candidate,
    # hidden solver state, unexported stage or mismatched returned mesh.
    manifest['sourceUnchanged']=mesh_hash(mesh.vertices,mesh.faces)==original_hash
    try:
        if not manifest['sourceUnchanged']:
            raise ValueError('Original source changed during source LOD')
        selected_stage=_prove_selected_result(selected,manifest,folder)
    except ValueError as error:
        if manifest['status']=='accepted':
            manifest.update(status='blocked',chainStatus='blocked',chainComplete=False,
                            blocker=str(error),chainBlocker=str(error))
    else:
        if not manifest['chainComplete']:
            manifest.update(status='accepted',acceptanceScope='selected_lod_and_recorded_accepted_stages',
                            selectedLodLevel=settings['selectedLodLevel'],
                            returnedMeshRole='accepted_selected_logical_level_from_incomplete_chain')
            manifest.pop('blocker',None)
        manifest['selectedResultProof']={'stage':selected_stage['stage'],
            'mesh_hash':selected_stage['mesh_hash'],'file_sha256':selected_stage['file_sha256'],
            'canonicalFileVerified':True,'returnedMeshVerified':True,
            'completeZeroIntersectionAudit':True,'fidelityAccepted':True}
    manifest['wallSeconds'] = time.monotonic()-start
    with report_path.open('x', encoding='utf-8') as stream:
        json.dump(manifest, stream, indent=2, allow_nan=False)
    artifacts.append({'path': str(report_path), 'name': report_path.name,
                      'filename': report_path.name, 'role': 'report',
                      'sha256': hashlib.sha256(report_path.read_bytes()).hexdigest()})
    return selected, manifest, artifacts


def run_source_lod(mesh, output, params=None, progress=None):
    """Existing route first; one optional same-source LOD0 fallback, never stage retry."""
    from native3d_lod_protected import runtime_available,solve
    params=dict(params or {});started=time.monotonic();deadline=started+float(params.get('maxSeconds',900))
    folder=Path(output);folder.mkdir(parents=True,exist_ok=True);before={p.resolve() for p in folder.iterdir()}
    selected,manifest,artifacts=_run_source_lod_core(mesh,folder,params,progress)
    has_lod0=any(s.get('stage')=='lod0' and s.get('status')=='accepted' and s.get('visible') is True for s in manifest.get('stages',[]))
    if (manifest.get('status')!='blocked' or has_lod0 or params.get('retryJobId') or
        params.get('selectedLodLevel',0)!=0 or params.get('simplifierBackend','open3d')!='open3d' or
        not runtime_available()):
        return selected,manifest,artifacts
    if time.monotonic()>=deadline:
        return selected,manifest,artifacts
    for reserved in ('protected-lod0-report.json','blocked-protected-lod0.glb','open3d-attempt','open3d-attempt-index.json'):
        if (folder/reserved).exists():raise FileExistsError('Protected fallback output already exists: '+reserved)
    settings=resolve_lod_settings(params)
    target=logical_target(0,manifest['sourceTriangles'],None,manifest['sourceTriangles'],settings)['effectiveTargetTriangles']
    candidate,receipt=solve(mesh,target,deadline,progress)
    if receipt.get('status')=='complete' and time.monotonic()>=deadline:
        receipt.update(status='blocked',blocker='Shared source LOD wall budget exhausted before final export gates')
    receipt.update(trigger='blocked existing route with no accepted logical LOD0',attemptCount=1,
                   sharedMaxSeconds=float(params.get('maxSeconds',900)))
    report_path=folder/'protected-lod0-report.json'
    def write_receipt():
        with report_path.open('x',encoding='utf-8') as stream:json.dump(receipt,stream,indent=2,allow_nan=False)
        return {'path':str(report_path),'name':report_path.name,'filename':report_path.name,'role':'report',
                'sha256':hashlib.sha256(report_path.read_bytes()).hexdigest()}
    if receipt.get('status')!='complete':
        # Preserve a real blocked new candidate when it fits the output target;
        # otherwise retain the real original attempt's diagnostic and its files.
        if candidate is not None and len(candidate.faces)<=target:
            selected=_canonical_mesh(candidate.vertices,candidate.faces);path=folder/'blocked-protected-lod0.glb'
            selected.metadata['nativeGeometryCandidateStatus']='blocked_diagnostic_only';digest=_save_mesh(selected,path)
            record={'stage':'protected_lod0_diagnostic','lodLevel':None,'visible':False,'status':'blocked','eligibleForDownstream':False,
                    'mesh_hash':mesh_hash(selected.vertices,selected.faces),'diagnosticFilename':path.name,
                    'diagnosticFileSha256':digest,'receipt':{'protectedSolver':receipt}}
            manifest['stages'].append(record);manifest.update(returnedDiagnosticStage=record['stage'],returnedDiagnosticMeshHash=record['mesh_hash'],returnedMeshRole='blocked_diagnostic_candidate')
            artifacts.append({'path':str(path),'name':path.name,'filename':path.name,'sha256':digest,'role':'export','diagnostic':True})
        manifest['protectedFallback']=receipt;manifest['wallSeconds']=time.monotonic()-started
        artifacts.append(write_receipt())
        main=folder/'source-lod-report.json';main.write_text(json.dumps(manifest,indent=2,allow_nan=False),encoding='utf-8')
        for artifact in artifacts:
            if Path(artifact['path'])==main:artifact['sha256']=hashlib.sha256(main.read_bytes()).hexdigest()
        return selected,manifest,artifacts
    # Archive only files explicitly returned or named by this invocation.
    own={folder/'source-lod-report.json'}
    own.update(Path(a['path']) for a in artifacts)
    for stage in manifest.get('stages',[]):
        # A blocked record retains its intended filename even when only its
        # diagnosticFilename was written. Never archive a merely planned file.
        keys=('filename','diagnosticFilename') if stage.get('status')=='accepted' else ('diagnosticFilename',)
        for key in keys:
            if stage.get(key):own.add(folder/stage[key])
    root=folder.resolve();moves=[]
    for path in own:
        resolved=path.resolve()
        if resolved in before:continue
        if resolved.parent!=root or path.is_symlink() or not path.is_file():
            raise ValueError('Refusing to archive an unowned or non-local attempt artifact')
        moves.append(path)
    archive=folder/'open3d-attempt'
    if archive.exists():raise FileExistsError('Protected fallback attempt already exists')
    archive.mkdir()
    index={'baseDirectory':'open3d-attempt','report':'open3d-attempt/source-lod-report.json',
           'actualArtifactReferencesResolveWithinBase':True,'plannedBlockedFilenamesMayNotExist':True,
           'accessScope':'local evidence paths; nested archived artifacts are not exposed by basename-only job download API','files':[]}
    for path in sorted(moves):
        destination=archive/path.name
        if destination.exists():raise FileExistsError(destination)
        digest=hashlib.sha256(path.read_bytes()).hexdigest();path.rename(destination)
        index['files'].append({'originalName':path.name,'path':'open3d-attempt/'+path.name,'sha256':digest})
    index_path=folder/'open3d-attempt-index.json'
    with index_path.open('x',encoding='utf-8') as stream:json.dump(index,stream,indent=2)
    # Re-enter only the core, never this wrapper. Candidate was freshly solved
    # from the immutable source in this invocation, not imported from scratch.
    try:
        selected,manifest,artifacts=_run_source_lod_core(mesh,folder,params,progress,
                                                       protected_lod0=(candidate,receipt),deadline=deadline)
    except ValueError as error:
        # The core validates its remaining deadline before entering its normal
        # diagnostic catcher. Archiving must not erase the inspectable result
        # if that last validation fails. This is never acceptance or a new budget.
        receipt['exportGateFailure']=str(error)
        manifest.update(status='blocked',chainStatus='blocked',chainComplete=False,blocker=str(error),chainBlocker=str(error))
        for stage in manifest.get('stages',[]):
            for key in ('filename','diagnosticFilename'):
                if stage.get(key):stage[key]='open3d-attempt/'+stage[key]
        selected=_canonical_mesh(candidate.vertices,candidate.faces)
        diagnostic=folder/'blocked-protected-lod0.glb';digest=_save_mesh(selected,diagnostic)
        record={'stage':'protected_lod0_diagnostic','status':'blocked','visible':False,'eligibleForDownstream':False,
                'mesh_hash':mesh_hash(selected.vertices,selected.faces),'diagnosticFilename':diagnostic.name,
                'diagnosticFileSha256':digest,'receipt':{'protectedSolver':receipt}}
        manifest['stages'].append(record)
        manifest.update(returnedMeshRole='blocked_diagnostic_candidate',returnedDiagnosticStage=record['stage'],
                        returnedDiagnosticMeshHash=record['mesh_hash'])
        artifacts=[{'path':str(diagnostic),'name':diagnostic.name,'filename':diagnostic.name,'role':'export','diagnostic':True,'sha256':digest},
                   {'path':str(folder/'source-lod-report.json'),'name':'source-lod-report.json','filename':'source-lod-report.json','role':'report'}]
    manifest['protectedFallback']=receipt;manifest['open3dAttempt']=index;manifest['wallSeconds']=time.monotonic()-started
    artifacts.append(write_receipt());artifacts.append({'path':str(index_path),'name':index_path.name,'filename':index_path.name,'role':'report',
                                                       'sha256':hashlib.sha256(index_path.read_bytes()).hexdigest()})
    main=folder/'source-lod-report.json';main.write_text(json.dumps(manifest,indent=2,allow_nan=False),encoding='utf-8')
    for artifact in artifacts:
        if Path(artifact['path'])==main:artifact['sha256']=hashlib.sha256(main.read_bytes()).hexdigest()
    return selected,manifest,artifacts
