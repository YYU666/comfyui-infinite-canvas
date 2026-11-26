"""CPU structural xatlas UVs with explicit seam constraints and measured diagnostics.

Caller owns orientation against the source reference. No service or project writes.
"""
import hashlib
from pathlib import Path
import numpy as np
import trimesh


def structural_edges(mesh, params):
    if not mesh.is_winding_consistent:
        raise ValueError('Structural UV requires consistent face winding')
    if not mesh.is_watertight and not params.get('orientationConfirmed', False):
        raise ValueError('Open structural UV requires reference orientationConfirmed')
    if mesh.is_watertight:
        # Signed concavity requires outward orientation for every closed shell.
        # A positive aggregate volume can conceal an inward disconnected shell.
        for component in mesh.split(only_watertight=False):
            scale=max(float(np.linalg.norm(component.extents)),1e-30)
            if not component.is_watertight or component.volume <= scale**3*1e-12:
                raise ValueError('Closed structural UV requires positive outward shell volume; inward or ambiguous orientation must be corrected against reference')
    adjacent = np.asarray(mesh.face_adjacency)
    edges = np.asarray(mesh.face_adjacency_edges)
    angles = np.degrees(mesh.face_adjacency_angles)
    convex = np.asarray(mesh.face_adjacency_convex)
    concave_angle = float(params.get('concaveAngleDegrees', 25.))
    sharp_angle = float(params.get('sharpAngleDegrees', 80.))
    if not 0 < concave_angle <= 180 or not 0 < sharp_angle <= 180:
        raise ValueError('Invalid structural seam angle')
    reasons = {}
    for edge, angle, is_convex in zip(edges, angles, convex):
        if angle >= concave_angle and not is_convex:
            reasons[tuple(sorted(map(int, edge)))] = 'signed_concave'
        elif angle >= sharp_angle:
            reasons[tuple(sorted(map(int, edge)))] = 'required_sharp'
    for edge in params.get('seamEdges', []):
        if len(edge) != 2 or min(edge) < 0 or max(edge) >= len(mesh.vertices):
            raise ValueError('Invalid manual seam edge')
        reasons[tuple(sorted(map(int, edge)))] = 'manual_locked'
    all_edges = {tuple(e) for e in np.asarray(mesh.edges_sorted)}
    if not set(reasons).issubset(all_edges):
        raise ValueError('Manual seam does not exist in source topology')
    return adjacent, edges, reasons


def structural_groups(mesh, params):
    adjacent, edges, reasons = structural_edges(mesh, params)
    return groups_from_edges(mesh, reasons), reasons


def groups_from_edges(mesh, reasons, partition_labels=None):
    adjacent=np.asarray(mesh.face_adjacency);edges=np.asarray(mesh.face_adjacency_edges)
    n = len(mesh.faces)
    parent = list(range(n)); members = [{i} for i in range(n)]
    labels=None if partition_labels is None else np.asarray(partition_labels)
    if labels is not None and labels.shape!=(n,):raise ValueError('Partition guard labels must match source faces')
    region=[set() if labels is None or labels[i]<0 else {int(labels[i])} for i in range(n)]
    forbidden = [set() for _ in range(n)]
    for pair, edge in zip(adjacent, edges):
        if tuple(sorted(map(int, edge))) in reasons:
            a, b = map(int, pair); forbidden[a].add(b); forbidden[b].add(a)
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    # Deterministic constrained unions. A hard seam cannot reconnect by another path.
    for a, b in adjacent:
        a, b = root(int(a)), root(int(b))
        if a == b or members[a] & forbidden[b] or members[b] & forbidden[a] or (region[a] and region[b] and region[a]!=region[b]):
            continue
        if len(members[a]) < len(members[b]): a, b = b, a
        parent[b] = a; members[a].update(members[b]); forbidden[a].update(forbidden[b]);region[a].update(region[b])
        members[b].clear(); forbidden[b].clear()
    groups = {}
    for i in range(n): groups.setdefault(root(i), []).append(i)
    return [np.asarray(v, dtype=np.int64) for v in groups.values()]


def uv_geometry_metrics(mesh, uv, resolution, padding):
    """Float64 triangle clipping and segment distances, independent of raster centers.

    Triangle area sum is occupancy only when interiors do not overlap. Pairwise
    overlap area is diagnostic (triple intersections can be counted repeatedly).
    """
    tri=np.asarray(uv,dtype=np.float64)[mesh.faces]
    cross=lambda a,b: a[...,0]*b[...,1]-a[...,1]*b[...,0]
    signed=cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0])
    triangles=tri.copy();triangles[signed<0]=triangles[signed<0,::-1]
    area=float(np.abs(signed).sum()*.5)
    low=tri.min(1);high=tri.max(1);pad=padding/resolution
    labels=np.zeros(len(tri),dtype=int)
    for label,faces in enumerate(trimesh.graph.connected_components(mesh.face_adjacency,nodes=np.arange(len(mesh.faces)),min_len=1)):
        labels[faces]=label
    overlap=0.;pairs=0;gap_pairs=0;minimum=None
    def intersection(a,b):
        poly=list(a)
        for k in range(3):
            start=b[k];edge=b[(k+1)%3]-start;out=[]
            if not poly:break
            prev=poly[-1];dp=float(cross(edge,prev-start))
            for point in poly:
                dc=float(cross(edge,point-start))
                if (dc>=0)!=(dp>=0):out.append(prev+(point-prev)*(dp/(dp-dc)))
                if dc>=0:out.append(point)
                prev=point;dp=dc
            poly=out
        if len(poly)<3:return 0.
        poly=np.asarray(poly);return float(abs(np.sum(cross(poly,np.roll(poly,-1,axis=0))))*.5)
    def distance(a,b):
        # Segment crossings are already excluded by positive-area intersection;
        # touching/crossing boundary segments still require explicit detection.
        best=float('inf')
        for i in range(3):
            p=a[i];r=a[(i+1)%3]-p
            for j in range(3):
                q=b[j];t=b[(j+1)%3]-q;den=float(cross(r,t))
                if abs(den)>1e-30:
                    u=float(cross(q-p,t)/den);v=float(cross(q-p,r)/den)
                    if 0<=u<=1 and 0<=v<=1:return 0.
                for point,start,edge in ((p,q,t),(p+r,q,t),(q,p,r),(q+t,p,r)):
                    alpha=np.clip(np.dot(point-start,edge)/max(np.dot(edge,edge),1e-30),0,1)
                    best=min(best,float(np.linalg.norm(point-start-alpha*edge)))
        return best
    from native3d_uv_overlap import _aabb_candidates
    # Expand both boxes by half the search distance, then retain the exact
    # Euclidean box-distance predicate. This changes only the broad phase.
    expansion=(pad+1e-12)*.5
    for i,candidates in _aabb_candidates(low-expansion,high+expansion):
        delta=np.maximum(np.maximum(low[candidates]-high[i],low[i]-high[candidates]),0.)
        keep=np.linalg.norm(delta,axis=1)<=pad+1e-12
        for j,separation in zip(candidates[keep],delta[keep]):
            intersect=intersection(triangles[i],triangles[j]) if not np.any(separation>0) else 0.
            if intersect>1e-12:overlap+=intersect;pairs+=1
            if labels[i]!=labels[j]:
                gap=0. if intersect>1e-12 else distance(triangles[i],triangles[j])
                minimum=gap if minimum is None else min(minimum,gap)
                if gap<pad-1e-10:gap_pairs+=1
    margin=float(min(np.asarray(uv).min(),1-np.asarray(uv).max())*resolution)
    return {'triangleUVAreaSumRatio':area,'triangleAreaOccupancyRatio':area if pairs==0 else None,
        'geometricOverlapPairs':pairs,'geometricPairwiseOverlapArea':overlap,
        'geometricPaddingViolationPairs':gap_pairs,'geometricInterIslandGapWithinSearchPixels':None if minimum is None else minimum*resolution,
        'geometricOutOfBoundsTriangles':int(np.count_nonzero(np.any(low< -1e-12,axis=1)|np.any(high>1+1e-12,axis=1))),
        'geometricTileMarginPixels':margin,'geometricToleranceUVArea':1e-12,
        'geometricCheckLimit':'Float64 clipping; intersections below 1e-12 UV squared ignored; distance search limited to requested padding.'}


def uv_metrics(mesh, uv, resolution, padding):
    """Full-resolution interior raster checks; no downsampled acceptance claim."""
    from scipy.ndimage import distance_transform_edt
    components = trimesh.graph.connected_components(mesh.face_adjacency, nodes=np.arange(len(mesh.faces)))
    labels = np.zeros(len(mesh.faces), dtype=np.int32)
    for i, faces in enumerate(components): labels[faces] = i + 1
    owner = np.zeros((resolution, resolution), np.int32)
    overlap = 0; stretches = []; densities = []; density_weights = []; signed = []; degenerate = 0
    positions=np.asarray(mesh.vertices);surface_areas=np.asarray(mesh.area_faces)
    for fi, face in enumerate(np.asarray(mesh.faces)):
        tri = np.asarray(uv)[face] * resolution
        a, b = positions[face][1:] - positions[face][0]
        axis = a / max(np.linalg.norm(a), 1e-30)
        geo = np.array([[np.linalg.norm(a), np.dot(b, axis)], [0., np.linalg.norm(np.cross(axis, b))]])
        target = (tri[1:] - tri[0]).T
        determinant = float(np.linalg.det(target)); signed.append(determinant)
        if abs(determinant) < 1e-12 or abs(np.linalg.det(geo)) < 1e-20:
            degenerate += 1; continue
        singular = np.linalg.svd(target @ np.linalg.inv(geo), compute_uv=False)
        stretches.append(float(singular[0] / max(singular[-1], 1e-30)))
        densities.append(float(np.sqrt(abs(determinant / np.linalg.det(geo)))))
        density_weights.append(float(surface_areas[fi]))
        lo = np.maximum(np.floor(tri.min(0)).astype(int), 0)
        hi = np.minimum(np.ceil(tri.max(0)).astype(int), resolution - 1)
        if np.any(hi < lo): continue
        xx, yy = np.meshgrid(np.arange(lo[0], hi[0]+1)+.5, np.arange(lo[1], hi[1]+1)+.5)
        points = np.stack([xx-tri[0,0], yy-tri[0,1]], axis=-1)
        bary = points @ np.linalg.inv(target).T
        inside = (bary[...,0] > 1e-7) & (bary[...,1] > 1e-7) & (bary.sum(-1) < 1-1e-7)
        patch = owner[lo[1]:hi[1]+1, lo[0]:hi[0]+1]
        overlap += int(np.count_nonzero(inside & (patch != 0)))
        patch[inside] = labels[fi]
    signed = np.asarray(signed)
    mixed = 0
    for faces in components:
        values = signed[faces]; mixed += min(int((values>0).sum()), int((values<0).sum()))
    # Measure Euclidean center-to-center distance to every different island.
    # Bounded island boxes preserve exact distances relevant to the requested gap.
    # This remains raster evidence, not a claim about subpixel polygon separation.
    collision = np.zeros_like(owner, dtype=bool)
    radius = padding+1
    minimum_gap = None
    from scipy.ndimage import find_objects
    for label, region in enumerate(find_objects(owner), 1):
        if region is None: continue
        region = tuple(slice(max(0,s.start-radius),min(resolution,s.stop+radius)) for s in region)
        local=owner[region]
        distances=distance_transform_edt(local != label)
        others=(local != 0) & (local != label)
        if np.any(others):
            gap=float(distances[others].min())
            minimum_gap=gap if minimum_gap is None else min(minimum_gap,gap)
        collision[region] |= others & (distances < padding)
    edge_margin = float(min(np.asarray(uv).min(), 1 - np.asarray(uv).max()) * resolution)
    weighted_density_ratio=None
    if densities:
        order=np.argsort(densities);ordered=np.asarray(densities)[order]
        cumulative=np.cumsum(np.asarray(density_weights)[order]);cumulative/=cumulative[-1]
        p05,p95=np.interp([.05,.95],cumulative,ordered)
        weighted_density_ratio=float(p95/max(p05,1e-30))
    return {'islands': len(components), 'overlapInteriorPixels': overlap,
        'mixedOrientationTriangles': mixed, 'negativeUVTriangles': int((signed < 0).sum()),
        'degenerateUVTriangles': degenerate, 'nonfiniteUVValues': int((~np.isfinite(uv)).sum()),
        'stretchRatioP50': float(np.median(stretches)) if stretches else None,
        'stretchRatioP95': float(np.percentile(stretches,95)) if stretches else None,
        'stretchRatioMax': float(np.max(stretches)) if stretches else None,
        'texelsPerSourceUnitP50': float(np.median(densities)) if densities else None,
        'texelDensityP95P05Ratio': float(np.percentile(densities,95)/max(np.percentile(densities,5),1e-30)) if densities else None,
        'texelDensityAreaWeightedP95P05Ratio':weighted_density_ratio,
        'interiorCoverageRatio': float(np.count_nonzero(owner)/owner.size),
        'requestedPaddingPixels': padding, 'paddingCollisionPixels': int(collision.sum()),
        'interIslandPixelCenterGapWithinSearchPixels':minimum_gap,
        'paddingDistanceMetric':'Euclidean pixel-center distance; search limited to requested padding plus one pixel around each island bounding box',
        'tileEdgeMarginPixels': edge_margin, 'rasterResolution': resolution,
        'rasterLimit': 'Pixel-center interiors; subpixel intersections not exhaustively excluded'}, owner


def unwrap(mesh, params, reference_mesh=None, face_labels=None, high_guided_evidence=None):
    if high_guided_evidence is not None and params.get('seamStrategy')!='coherent':raise ValueError('High guided evidence requires coherent UV')
    if params.get('seamStrategy')=='coherent':
        from native3d_uv_coherent import coherent_unwrap
        return coherent_unwrap(mesh,params,face_labels,high_guided_evidence)
    import xatlas
    if not len(mesh.faces) or len(mesh.faces) > 20000:
        raise ValueError('Structural UV supports1..20000 triangles')
    resolution = int(params.get('resolution',2048)); padding = int(params.get('padding',8))
    if resolution not in (1024,2048,4096) or not 1 <= padding <= 32:
        raise ValueError('Unsupported structural UV resolution/padding')
    if not np.isfinite(mesh.vertices).all() or not mesh.nondegenerate_faces().all():
        raise ValueError('Structural UV requires finite nondegenerate geometry')
    _, counts = np.unique(mesh.edges_sorted, axis=0, return_counts=True)
    if np.any(counts > 2): raise ValueError('Structural UV rejects nonmanifold edges')
    strategy=params.get('seamStrategy','structural')
    ao_report=None
    if strategy=='structural':
        if face_labels is not None:
            from native3d_uv_ao import label_boundaries
            _,_,reasons=structural_edges(mesh,params)
            reasons.update(label_boundaries(mesh,face_labels))
            groups=groups_from_edges(mesh,reasons)
        else:groups,reasons=structural_groups(mesh,params)
    elif strategy=='ao_geometry':
        from native3d_uv_ao import ao_geometry_groups
        groups,reasons,ao_report=ao_geometry_groups(mesh,params,reference_mesh,face_labels)
    else:raise ValueError('Unknown seamStrategy')
    if len(mesh.faces) > 8 and all(len(g)==1 for g in groups):
        raise ValueError('Structural seams would create triangle-per-island layout; review required')
    atlas = xatlas.Atlas(); local_sources = []
    for group in groups:
        source, inverse = np.unique(np.asarray(mesh.faces)[group].reshape(-1),return_inverse=True)
        atlas.add_mesh(np.asarray(mesh.vertices[source],np.float32),inverse.reshape(-1,3).astype(np.uint32))
        local_sources.append(source)
    chart=xatlas.ChartOptions(); chart.roundness_weight=1.; chart.straightness_weight=6.
    pack=xatlas.PackOptions(); pack.resolution=resolution; pack.padding=padding
    pack.rotate_charts_to_axis=True; pack.rotate_charts=True; pack.bilinear=True
    atlas.generate(chart_options=chart,pack_options=pack)
    # Requested resolution is an estimate in xatlas, not its actual dimensions.
    # Repack with enough native texels for the final square's requested gap.
    for _ in range(3):
        required=int(np.ceil(padding*max(atlas.width,atlas.height)/(resolution-2*padding)))+2
        if pack.padding >= required: break
        pack.padding=required
        atlas.generate(chart_options=chart,pack_options=pack)
    if atlas.atlas_count != 1: raise ValueError('Structural UV produced multiple atlas tiles')
    out_vertices=[]; out_faces=[]; out_uv=[]; xrefs=[]; face_sources=[]; offset=0
    for i,group in enumerate(groups):
        xref,faces,uv=atlas[i]; source=local_sources[i][np.asarray(xref)]
        if not np.array_equal(source[faces],np.asarray(mesh.faces)[group]):
            raise RuntimeError('Structural UV triangle/xref lineage mismatch')
        out_vertices.append(np.asarray(mesh.vertices)[source]); out_faces.append(faces+offset)
        out_uv.append(uv); xrefs.append(source);face_sources.extend(group.tolist());offset+=len(source)
    source=np.concatenate(xrefs); uv=np.concatenate(out_uv)
    # xatlas fixed texels/unit can return a non-square atlas. Embed isotropically
    # into a square output without stretching; preserve actual requested pixel padding.
    width,height=int(atlas.width),int(atlas.height)
    uv=uv*np.array([width,height])/max(width,height)
    uv=uv*(resolution-2*padding)/resolution+padding/resolution
    faces=np.concatenate(out_faces)
    result=trimesh.Trimesh(np.concatenate(out_vertices),faces,process=False)
    result.vertex_normals=np.asarray(mesh.vertex_normals)[source]
    result.visual=trimesh.visual.TextureVisuals(uv=uv)
    if hasattr(mesh.visual,'material'): result.visual.material=mesh.visual.material.copy()
    if getattr(mesh.visual,'face_materials',None) is not None:
        result.visual.face_materials=np.asarray(mesh.visual.face_materials)[face_sources]
    result.vertex_attributes={key:np.asarray(value)[source].copy() for key,value in mesh.vertex_attributes.items()}
    result.face_attributes={key:np.asarray(value)[face_sources].copy() for key,value in mesh.face_attributes.items()}
    result.metadata=dict(mesh.metadata)
    result.metadata.update({'nativeSourceUV':True,'uvSourceVertex':source.tolist(),'uvSourceFace':face_sources})
    # Verify each hard seam was actually split at both corners in exported topology.
    edge_faces={}
    for fi,face in enumerate(mesh.faces):
        for j in range(3): edge_faces.setdefault(tuple(sorted((int(face[j]),int(face[(j+1)%3])))),[]).append(fi)
    output_face={original:i for i,original in enumerate(face_sources)}
    enforced=0
    for edge in reasons:
        adjacent=edge_faces[edge]
        if len(adjacent)!=2: continue
        pairs=[]
        for original in adjacent:
            outface=faces[output_face[original]]
            pairs.append(tuple(int(outface[list(np.asarray(mesh.faces)[original]).index(v)]) for v in edge))
        if set(pairs[0]) & set(pairs[1]): raise RuntimeError('Requested seam not enforced')
        enforced+=1
    metrics,owner=uv_metrics(result,uv,resolution,padding)
    report={'backend':'xatlas structural groups','conditioning':'signed concavity after confirmed orientation',
        'structuralGroups':len(groups),'requestedSeams':len(reasons),'enforcedInteriorSeams':enforced,
        'seamReasons':{'%d:%d'%edge:reason for edge,reason in reasons.items()},
        'exactTriangleMapping':True,'geometrySha256':hashlib.sha256(np.asarray(mesh.vertices).tobytes()+np.asarray(mesh.faces).tobytes()).hexdigest(),
        'resolution':resolution,'atlasNativeSize':[width,height],
        'nativePackPaddingPixels':int(pack.padding),
        'effectiveOutputPackPaddingPixels':pack.padding*(resolution-2*padding)/max(width,height),
        'packingOrientation':'xatlas axis-aligned chart rotation; rigid/isotropic square embedding; rectangles are a preference',
        'status':'needs_review', **metrics,
        'limitations':['Auxiliary cuts may be added to enforce nonseparating seams.','Global open-surface orientation must be supplied by caller.','No exhaustive subpixel overlap/self-intersection proof.']}
    report['paddingVerifiedAtPixelCenters']=(metrics['paddingCollisionPixels']==0
        and metrics['tileEdgeMarginPixels'] >= padding
        and report['effectiveOutputPackPaddingPixels'] >= padding)
    report['seamStrategy']=strategy
    if ao_report is not None:report['aoGeometry']=ao_report
    report['qualityFlags']={'exactGeometry':True,'rasterOverlapFree':metrics['overlapInteriorPixels']==0,
        'nondegenerateUV':metrics['degenerateUVTriangles']==0,'paddingPixelCenters':report['paddingVerifiedAtPixelCenters'],
        'requiresVisualReview':True}
    diagnostics=params.get('diagnosticsDirectory')
    if diagnostics:
        from PIL import Image,ImageDraw
        folder=Path(diagnostics);folder.mkdir(parents=True,exist_ok=True)
        image=Image.new('RGB',(resolution,resolution),(25,25,25));draw=ImageDraw.Draw(image)
        from native3d_bake_basis import uv_raster_coordinates
        raster_uv = uv_raster_coordinates(uv, resolution)
        for face in faces: draw.polygon([tuple(p) for p in raster_uv[face]],outline=(210,210,210))
        image.save(folder/'uv-layout.png')
        y,x=np.indices((resolution,resolution)); checker=(((x//32+y//32)%2)*120+70).astype(np.uint8)
        Image.fromarray(np.repeat(checker[:,:,None],3,axis=2)).save(folder/'uv-checker.png')
        np.savez_compressed(folder/'seams-3d.npz',segments=np.asarray([mesh.vertices[list(e)] for e in reasons]),sourceVertex=source,sourceFace=np.asarray(face_sources))
        report['diagnostics']=['uv-layout.png','uv-checker.png','seams-3d.npz']
        report['checkerDiagnostic']='Texture pattern only; not applied to a rendered mesh and does not verify surface distortion'
        if ao_report is not None:report['diagnostics']+=['ao-view.png','seam-view.png']
    return result,report

