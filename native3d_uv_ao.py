"""Deterministic CPU AO evidence and broad geometry UV grouping.

AO is a finite local visibility estimate, not a semantic segmenter or a bake.
Input positions/topology remain untouched. Reference supplies visibility only.
"""
from pathlib import Path
import hashlib
import numpy as np
import trimesh


def label_boundaries(mesh, labels):
    labels=np.asarray(labels)
    if labels.shape!=(len(mesh.faces),) or not np.issubdtype(labels.dtype,np.integer):
        raise ValueError('face_labels must contain exactly one integer per source face')
    return {tuple(sorted(map(int,e))):'provided_face_groups' for pair,e in zip(mesh.face_adjacency,mesh.face_adjacency_edges) if labels[pair[0]]!=labels[pair[1]]}


def face_ao(mesh, params, reference_mesh=None):
    import open3d as o3d
    count=params.get('aoRaySamples',32);radius=params.get('aoRadiusFraction',.08)
    if type(count) is not int or not 8<=count<=128 or not isinstance(radius,(int,float)) or not .01<=radius<=.3:
        raise ValueError('AO requires8..128 rays and radius fraction .01..3')
    if not 1<=len(mesh.faces)<=20000 or not np.isfinite(mesh.vertices).all():raise ValueError('AO candidate limit is20000 finite triangles')
    reference=mesh if reference_mesh is None else reference_mesh
    if not 1<=len(reference.faces)<=3000000 or not np.isfinite(reference.vertices).all():raise ValueError('AO reference limit is3000000 finite triangles')
    diagonal=float(np.linalg.norm(mesh.extents))
    if diagonal<=0:raise ValueError('AO requires positive spatial extent')
    scene=o3d.t.geometry.RaycastingScene()
    scene.add_triangles(o3d.core.Tensor(np.asarray(reference.vertices,np.float32)),o3d.core.Tensor(np.asarray(reference.faces,np.uint32)))
    normals=np.asarray(mesh.face_normals);centers=np.asarray(mesh.triangles_center).copy()
    supported=np.ones(len(mesh.faces),dtype=bool)
    if reference_mesh is not None:
        hit=scene.compute_closest_points(o3d.core.Tensor(centers.astype(np.float32)))
        points=hit['points'].numpy().astype(float);nn=hit['primitive_normals'].numpy().astype(float)
        supported=(np.linalg.norm(points-centers,axis=1)<=diagonal*.03)&(np.einsum('ij,ij->i',nn,normals)>=.5)
        centers[supported]=points[supported];normals=normals.copy();normals[supported]=nn[supported]
    # Fixed cosine-weighted Fibonacci hemisphere; rays are batched on CPU.
    u=(np.arange(count)+.5)/count;phi=np.arange(count)*np.pi*(3-np.sqrt(5))
    local=np.column_stack((np.sqrt(u)*np.cos(phi),np.sqrt(u)*np.sin(phi),np.sqrt(1-u)))
    axes=np.tile([0.,0.,1.],(len(normals),1));axes[np.abs(normals[:,2])>.9]=[0.,1.,0.]
    tangent=np.cross(axes,normals);tangent/=np.maximum(np.linalg.norm(tangent,axis=1)[:,None],1e-30)
    bitangent=np.cross(normals,tangent);darkness=np.zeros(len(mesh.faces))
    for start in range(0,len(mesh.faces),256):
        sl=slice(start,start+256);n=normals[sl]
        directions=local[None,:,0,None]*tangent[sl,None]+local[None,:,1,None]*bitangent[sl,None]+local[None,:,2,None]*n[:,None]
        origins=np.broadcast_to((centers[sl]+n*diagonal*1e-5)[:,None],directions.shape)
        rays=np.concatenate((origins,directions),axis=2).reshape(-1,6).astype(np.float32)
        distances=scene.cast_rays(o3d.core.Tensor(rays))['t_hit'].numpy().reshape(-1,count)
        darkness[sl]=np.mean((distances>diagonal*1e-6)&(distances<radius*diagonal),axis=1)
    return darkness,supported,{'backend':'Open3D CPU deterministic cosine hemisphere','raySamplesPerFace':count,
        'surfaceSamplesPerFace':1,'raysCast':len(mesh.faces)*count,'radiusFraction':radius,
        'radiusWorld':radius*diagonal,'normalOffsetFraction':1e-5,'referenceUsed':reference_mesh is not None,
        'supportedFaceFraction':float(supported.mean()),'darknessMin':float(darkness.min()),
        'supportedDarknessMean':float(darkness[supported].mean()) if supported.any() else None,
        'darknessMean':float(np.mean(darkness)),'darknessAreaWeightedMean':float(np.average(darkness,weights=mesh.area_faces)),
        'darknessP95':float(np.percentile(darkness,95)),'darknessMax':float(darkness.max()),
        'limitations':['One centroid per face can miss narrow cavities.','Local finite rays do not establish semantic part identity.','Unsupported reference correspondence cannot nominate AO seams.']}


def diagnostic_views(mesh, darkness, reasons, folder, ray_samples=None):
    """Show the actual input AO signal and cut reasons with shared depth camera."""
    from native3d_uv_preview import render_ao_mesh
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    evidence={'geometrySha256':hashlib.sha256(np.asarray(mesh.vertices).tobytes()+np.asarray(mesh.faces).tobytes()).hexdigest(),
        'aoGeometry':{'raySamplesPerFace':ray_samples,'faceDarkness':darkness.tolist(),'darknessSha256':hashlib.sha256(darkness.astype('<f8').tobytes()).hexdigest()},
        'seamReasons':{'%d:%d'%edge:reason for edge,reason in reasons.items()}}
    render_ao_mesh(mesh,evidence,'ao').save(folder/'ao-view.png')
    render_ao_mesh(mesh,evidence,'ao-seams').save(folder/'seam-view.png')


def ao_geometry_groups(mesh, params, reference_mesh=None, face_labels=None):
    from native3d_uv import structural_edges,groups_from_edges
    # Reuse orientation validation, but do not inherit all low-threshold hard cuts.
    _,_,manual=structural_edges(mesh,{**params,'concaveAngleDegrees':180.,'sharpAngleDegrees':180.})
    darkness,supported,report=face_ao(mesh,params,reference_mesh)
    coarse=float(params.get('coarseAngleDegrees',65.));concave=float(params.get('aoConcaveAngleDegrees',35.));threshold=float(params.get('aoDarknessThreshold',.2))
    if not 20<=coarse<=100 or not 5<=concave<=120 or not 0<=threshold<=1:raise ValueError('Invalid AO geometry grouping parameters')
    adjacency=[[] for _ in mesh.faces]
    reasons=dict(manual)
    angles=np.degrees(mesh.face_adjacency_angles)
    for pair,edge,angle,convex in zip(mesh.face_adjacency,mesh.face_adjacency_edges,angles,mesh.face_adjacency_convex):
        a,b=map(int,pair);key=tuple(sorted(map(int,edge)))
        if not convex and angle>=concave and supported[a] and supported[b] and (darkness[a]+darkness[b])/2>=threshold:
            reasons.setdefault(key,'ao_supported_signed_concave')
        if angle>=120:reasons.setdefault(key,'required_extreme_angle')
        adjacency[a].append((b,key));adjacency[b].append((a,key))
    if face_labels is not None:
        reasons.update(label_boundaries(mesh,face_labels));coarse_groups=None
    else:
        labels=np.full(len(mesh.faces),-1,dtype=np.int64);normals=np.asarray(mesh.face_normals);label=0
        for seed in np.argsort(-mesh.area_faces,kind='stable'):
            if labels[seed]>=0:continue
            labels[seed]=label;stack=[int(seed)]
            while stack:
                a=stack.pop()
                for b,edge in adjacency[a]:
                    if labels[b]<0 and edge not in reasons and np.dot(normals[seed],normals[b])>=np.cos(np.deg2rad(coarse)):
                        labels[b]=label;stack.append(b)
            label+=1
        coarse_groups=label
        for edge,reason in label_boundaries(mesh,labels).items():reasons.setdefault(edge,'coarse_normal_block')
    groups=groups_from_edges(mesh,reasons)
    report.update({'coarseAngleDegrees':coarse,'concaveAngleDegrees':concave,'darknessThreshold':threshold,
        'coarseGroups':coarse_groups,'providedFaceGroups':face_labels is not None,'finalGroups':len(groups),
        'aoSeams':sum(x=='ao_supported_signed_concave' for x in reasons.values()),
        'darknessSha256':hashlib.sha256(darkness.astype('<f8').tobytes()).hexdigest(),
        'faceDarkness':darkness.tolist(),'referenceSupportedFaces':supported.tolist(),
        'diagnosticProjection':'Shared front +Z orthographic camera; triangle depth-tested original AO signal and reason-colored candidate cuts; final atlas seams may differ'})
    if params.get('diagnosticsDirectory'):diagnostic_views(mesh,darkness,reasons,params['diagnosticsDirectory'],report['raySamplesPerFace'])
    return groups,reasons,report


def high_guided_seams(mesh,params,evidence):
    """Use supported high-source regions and AO only on signed concave edges.

    Unsupported target faces never nominate neural boundaries or AO cuts.
    Coherent charting still chooses additional topology-required seams.
    """
    labels=np.asarray(evidence['labels']);supported=np.asarray(evidence.get('supported',labels>=0),bool)
    confidence=np.asarray(evidence['confidence']);darkness=np.asarray(evidence['darkness'])
    if any(x.shape!=(len(mesh.faces),) for x in (labels,supported,confidence,darkness)):raise ValueError('High guided target evidence shape mismatch')
    supported=supported&(labels>=0)&(confidence>=.65)
    concave=float(params.get('aoConcaveAngleDegrees',35.));threshold=float(params.get('aoDarknessThreshold',.2))
    if not 5<=concave<=120 or not 0<=threshold<=1:raise ValueError('Invalid high guided AO seam thresholds')
    reasons={}
    for pair,edge,angle,convex in zip(mesh.face_adjacency,mesh.face_adjacency_edges,np.degrees(mesh.face_adjacency_angles),mesh.face_adjacency_convex):
        a,b=map(int,pair)
        if not(supported[a] and supported[b]):continue
        key=tuple(sorted(map(int,edge)))
        if labels[a]!=labels[b]:reasons[key]='high_surface_region_boundary'
        if not convex and angle>=concave and (darkness[a]+darkness[b])*.5>=threshold:reasons[key]='ao_supported_signed_concave'
    area=np.asarray(mesh.area_faces)
    provenance={key:evidence[key] for key in ('method','highSourceSha256','targetSourceSha256','highFaceCount','queryCount','queryCacheSha256','queryLabelsSha256','checkpointSha256','raySamples','raysCast')}
    return reasons,{**provenance,'supportedTargetFaces':int(supported.sum()),'unsupportedTargetFaces':int((~supported).sum()),'unsupportedTargetAreaFraction':float(area[~supported].sum()/area.sum()),'minimumMappingConfidence':.65,'neuralBoundaryEdges':sum(x=='high_surface_region_boundary' for x in reasons.values()),'aoConcaveEdges':sum(x=='ao_supported_signed_concave' for x in reasons.values()),'aoConcaveAngleDegrees':concave,'aoDarknessThreshold':threshold,'aoHardCutPolicy':'Disabled except fully occluded eligible edges; AO retained as mapped reference/diagnostic' if threshold==1 else 'Supported signed concave edges above darkness threshold are hard seam constraints','targetFaceDarkness':darkness.tolist(),'targetSupported':supported.tolist(),'scope':f"External high-surface regions and{evidence['raySamples']}-ray AO values projected to target; not recomputed or neural-inferred on low faces by UV.",'limitations':['Finite high-surface sampling and gated region projection, not neural inference or AO at every high face.','Unassigned target faces do not nominate evidence seams.','AO only adds cuts at supported signed-concave target edges; convex darkness alone does not cut.']}
