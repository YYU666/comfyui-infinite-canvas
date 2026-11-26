"""Exact-source, bounded disk cuts and one positive harmonic/SLIM solve per island."""
import numpy as np
import trimesh
from scipy.sparse import coo_matrix, diags
from scipy.sparse.linalg import spsolve
from scipy.sparse.csgraph import dijkstra


def _edges(faces):
    edges=np.sort(faces[:,[[0,1],[1,2],[2,0]]].reshape(-1,2),axis=1)
    unique,inverse,count=np.unique(edges,axis=0,return_inverse=True,return_counts=True)
    if np.any(count>2):raise ValueError('SLIM requires edge-manifold source groups')
    return unique,inverse.reshape(-1,3),count


def _fans(vertices,faces,source):
    """Split disconnected vertex links by corner indices, never move positions."""
    _,inverse,count=_edges(faces);order=np.argsort(inverse.ravel());starts=np.r_[0,np.cumsum(count)]
    parent=np.arange(faces.size)
    def root(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=parent[i]
        return i
    for edge in np.flatnonzero(count==2):
        a,b=order[starts[edge]:starts[edge+1]];fa,fb=int(a//3),int(b//3)
        for v in set(faces[fa])&set(faces[fb]):
            ca=fa*3+int(np.flatnonzero(faces[fa]==v)[0]);cb=fb*3+int(np.flatnonzero(faces[fb]==v)[0]);ra,rb=root(ca),root(cb)
            if ra!=rb:parent[rb]=ra
    roots=np.fromiter((root(i) for i in range(faces.size)),np.int64,count=faces.size)
    _,first,new=np.unique(roots,return_index=True,return_inverse=True)
    selected=faces.ravel()[first]
    return vertices[selected].copy(),new.reshape(-1,3),source[selected]


def _components(vertices,faces,source,source_faces):
    mesh=trimesh.Trimesh(vertices,faces,process=False)
    groups=trimesh.graph.connected_components(mesh.face_adjacency,nodes=np.arange(len(faces)),min_len=1)
    result=[]
    for group in sorted(groups,key=lambda x:int(np.min(x))):
        ids=np.sort(group);used,inverse=np.unique(faces[ids],return_inverse=True)
        result.append((vertices[used].copy(),inverse.reshape(-1,3),source[used],source_faces[ids]))
    return result


def _boundary(faces):
    edges,_,count=_edges(faces);boundary=edges[count==1]
    vertices,degree=np.unique(boundary,return_counts=True)
    if not len(vertices):raise ValueError('SLIM closed component requires an explicit supported cut; no automatic hole deletion')
    if np.any(degree!=2):raise ValueError('SLIM boundary vertex link is not a manifold loop')
    neighbors={}
    for a,b in boundary:neighbors.setdefault(int(a),[]).append(int(b));neighbors.setdefault(int(b),[]).append(int(a))
    loops=[];remaining=set(neighbors)
    while remaining:
        loop=[min(remaining)];visited={loop[0]};previous=None
        while True:
            current=loop[-1];following=min(v for v in neighbors[current] if v!=previous)
            if following==loop[0]:break
            if following in visited:raise ValueError('SLIM boundary loop repeats a vertex')
            loop.append(following);visited.add(following);previous=current
        remaining.difference_update(loop);loops.append(np.asarray(loop,np.int64))
    return edges,count,loops


def _cut(igl,vertices,faces,source,cut_edges):
    flags=np.zeros(faces.shape,bool)
    for fi,face in enumerate(faces):
        for k in range(3):flags[fi,k]=tuple(sorted((int(face[k]),int(face[(k+1)%3])))) in cut_edges
    if not flags.any():return vertices,faces,source
    v,f,index=igl.cut_mesh(vertices,np.asarray(faces,np.int64),flags)
    index=np.asarray(index,np.int64)
    if not np.array_equal(v,vertices[index]) or not np.array_equal(index[f],faces):raise ValueError('SLIM cut_mesh source lineage mismatch')
    return np.asarray(v),np.asarray(f,np.int64),source[index]


def _constrained_cuts(vertices,faces,source,reasons):
    # Connect each complete seam network only once. Attaching every seam vertex
    # independently makes redundant spokes and fragments the reviewed regions.
    # All reviewed edges remain mandatory, followed by the existing disk proof.
    from native3d_uv_natural import connected_constraint_cuts
    return connected_constraint_cuts(vertices,faces,source,reasons)


def _disk_parts(igl,vertices,faces,source,source_faces,reasons):
    cuts=_constrained_cuts(vertices,faces,source,reasons)
    vertices,faces,source=_cut(igl,vertices,faces,source,cuts)
    result=[]
    for v,f,s,sf in _components(vertices,faces,source,source_faces):
        edges,count,loops=_boundary(f)
        if len(loops)!=1 or len(v)-len(edges)+len(f)!=1:
            paths=igl.cut_to_disk(np.asarray(f,np.int64));extra=set()
            for path in paths:
                extra.update(tuple(sorted((int(a),int(b)))) for a,b in zip(path,path[1:]))
            if len(extra)>len(edges):raise ValueError('SLIM disk cut exceeded source-edge budget')
            v,f,s=_cut(igl,v,f,s,extra)
        for vv,ff,ss,ssf in _components(v,f,s,sf):
            ee,cc,ll=_boundary(ff)
            if len(ll)!=1 or len(vv)-len(ee)+len(ff)!=1:raise ValueError('SLIM one-pass cut graph did not produce a topological disk')
            # A post-cut corner-fan proof guards pinches not detected by Euler.
            fan_v,_,_=_fans(vv,ff,ss)
            if len(fan_v)!=len(vv):raise ValueError('SLIM disk retains a pinched vertex')
            result.append((vv,ff,ss,ssf,ll[0]))
    return result


def _distortion(vertices,faces,uv):
    xyz=vertices[faces];tex=uv[faces];a=xyz[:,1]-xyz[:,0];b=xyz[:,2]-xyz[:,0]
    length=np.linalg.norm(a,axis=1);bx=np.sum(a*b,axis=1)/length;by=np.sqrt(np.maximum(np.sum(b*b,axis=1)-bx*bx,0))
    basis=np.zeros((len(faces),2,2));basis[:,0,0]=length;basis[:,0,1]=bx;basis[:,1,1]=by
    delta=np.transpose(tex[:,1:]-tex[:,:1],(0,2,1));signed=np.linalg.det(delta)*.5
    singular=np.linalg.svd(delta@np.linalg.inv(basis),compute_uv=False)
    ratio=singular[:,0]/np.maximum(singular[:,1],1e-30);area=length*by*.5
    order=np.argsort(ratio);cumulative=np.cumsum(area[order])/area.sum()
    return {'areaWeightedStretchP95':float(ratio[order[np.searchsorted(cumulative,.95)]]),
        'areaFractionStretchOver3':float(area[ratio>3].sum()/area.sum()),'stretchMax':float(ratio.max()),
        'positiveTriangles':int((signed>0).sum()),'nonpositiveTriangles':int((signed<=0).sum())}


def _solve(igl,vertices,faces,loop):
    edges,_,_=_edges(faces);length=np.linalg.norm(vertices[np.roll(loop,-1)]-vertices[loop],axis=1)
    angles=2*np.pi*np.r_[0,np.cumsum(length[:-1])]/length.sum()
    uv=np.zeros((len(vertices),2));uv[loop]=np.column_stack((np.cos(angles),np.sin(angles)))
    row=np.r_[edges[:,0],edges[:,1]];col=np.r_[edges[:,1],edges[:,0]]
    weights=coo_matrix((np.ones(len(row)),(row,col)),shape=(len(vertices),len(vertices))).tocsr()
    interior=np.setdiff1d(np.arange(len(vertices)),loop)
    laplacian=diags(np.asarray(weights.sum(axis=1)).ravel())-weights
    if len(interior):uv[interior]=spsolve(laplacian[interior][:,interior],-laplacian[interior][:,loop]@uv[loop])
    triangle=uv[faces];edge=triangle[:,1:]-triangle[:,:1];signed=(edge[:,0,0]*edge[:,1,1]-edge[:,0,1]*edge[:,1,0])*.5
    if np.all(signed<0):uv[:,0]*=-1;signed=-signed
    if not np.isfinite(uv).all() or np.any(signed<=0):raise ValueError('SLIM harmonic initial embedding is not strictly positive')
    mesh=trimesh.Trimesh(vertices,faces,process=False);uv*=np.sqrt(mesh.area/signed.sum())
    state=igl.slim_precompute(np.asfortranarray(vertices,np.float64),np.asfortranarray(faces,np.int32),np.asfortranarray(uv),
        igl.MappingEnergyType.SYMMETRIC_DIRICHLET,np.empty(0,np.int32),np.empty((0,2),np.float64,order='F'),0.)
    uv=np.asarray(igl.slim_solve(state,20))
    if uv.shape!=(len(vertices),2) or not np.isfinite(uv).all():raise ValueError('SLIM returned invalid coordinates')
    metrics=_distortion(vertices,faces,uv)
    if not all(np.isfinite(value) for value in metrics.values()):raise ValueError('SLIM returned nonfinite distortion metrics')
    if metrics['nonpositiveTriangles']:
        raise ValueError('SLIM orientation gate failed: '+str(metrics))
    metrics['stretchWarnings']=[name for name,value,limit in (
        ('areaWeightedStretchP95',metrics['areaWeightedStretchP95'],2),
        ('areaFractionStretchOver3',metrics['areaFractionStretchOver3'],.01)) if value>limit]
    extent=float(np.ptp(uv,axis=0).max())
    if not np.isfinite(extent) or extent<=0:raise ValueError('SLIM empty UV extent')
    return (uv-uv.min(axis=0))/extent,metrics


def parameterize_groups(mesh,groups,reasons,diagnostics_directory=None):
    """Return mesh, temporary unit-cell UV, source vertex/face maps and receipt.

    No packing, inference, file writes, geometry modification or repair retries.
    Caller must run the existing strict global geometric/raster overlap gates.
    """
    import igl
    vertices=np.asarray(mesh.vertices);faces=np.asarray(mesh.faces)
    if not 1<=len(faces)<=100000 or faces.ndim!=2 or faces.shape[1]!=3 or not np.isfinite(vertices).all() or not mesh.nondegenerate_faces().all():raise ValueError('SLIM requires 1..100000 finite nondegenerate source triangles')
    if not groups:raise ValueError('SLIM requires a complete source-face partition')
    partitions=[]
    for group in groups:
        value=np.asarray(group)
        if value.ndim!=1 or not np.issubdtype(value.dtype,np.integer) or not len(value):raise ValueError('SLIM invalid source-face partition')
        partitions.append(value.astype(np.int64))
    joined=np.concatenate(partitions)
    if not np.array_equal(np.sort(joined),np.arange(len(faces))):raise ValueError('SLIM groups must cover source faces exactly once')
    source_edges=set(map(tuple,np.asarray(mesh.edges_sorted)))
    for edge in reasons:
        if not isinstance(edge,tuple) or len(edge)!=2 or any(isinstance(v,(bool,np.bool_)) or not isinstance(v,(int,np.integer)) for v in edge) or edge[0]>=edge[1] or edge not in source_edges:raise ValueError('SLIM reason edge is not a canonical source edge')
    _edges(faces)
    out_v=[];out_f=[];out_uv=[];out_source=[];out_face=[];records=[];offset=0
    for group_index,group in enumerate(partitions):
        used,inverse=np.unique(faces[group],return_inverse=True)
        v,f,s=_fans(vertices[used],inverse.reshape(-1,3),used)
        for vv,ff,ss,sf in _components(v,f,s,group):
            for vvv,fff,sss,sff,loop in _disk_parts(igl,vv,ff,ss,sf,reasons):
                try:uv,metrics=_solve(igl,vvv,fff,loop)
                except ValueError as error:raise ValueError('SLIM group '+str(group_index)+' disk '+str(len(records))+': '+str(error)) from error
                island=len(records);uv[:,0]+=2*island
                out_v.append(vvv);out_f.append(fff+offset);out_uv.append(uv);out_source.append(sss);out_face.append(sff);offset+=len(vvv)
                records.append({'island':island,'group':group_index,'faces':len(fff),'vertices':len(vvv),'boundaryVertices':len(loop),**metrics})
    result=trimesh.Trimesh(np.concatenate(out_v),np.concatenate(out_f),process=False);uv=np.concatenate(out_uv);source=np.concatenate(out_source);source_face=np.concatenate(out_face)
    if not np.array_equal(result.vertices,vertices[source]) or not np.array_equal(source[result.faces],faces[source_face]):raise ValueError('SLIM final exact source mapping mismatch')
    # Compare each source edge's exported corners. Frozen reasons must be full
    # seams; additional topological cuts are all explicitly recorded.
    edge_faces={}
    for fi,face in enumerate(faces):
        for k in range(3):edge_faces.setdefault(tuple(sorted((int(face[k]),int(face[(k+1)%3])))),[]).append(fi)
    lookup=np.argsort(source_face);cut_edges=[];missing=[];shared_tip_seams=0
    for edge,adjacent in edge_faces.items():
        if len(adjacent)!=2:continue
        corners=[]
        for fi in adjacent:
            out=lookup[fi];corners.append({int(result.faces[out,int(np.flatnonzero(faces[fi]==v)[0])]) for v in edge})
        # A slit tip may legitimately share one endpoint. A seam is cut
        # precisely when its two exported edges differ, not when every
        # endpoint has been duplicated.
        split=corners[0]!=corners[1]
        if edge in reasons:
            if not split:missing.append({'edge':list(edge),'sourceFaces':adjacent,'outputEdges':[sorted(c) for c in corners]})
            elif corners[0]&corners[1]:shared_tip_seams+=1
        # Partial cut tips also change UV topology and belong in the receipt.
        if corners[0]!=corners[1]:cut_edges.append(edge)
    if missing:
        if diagnostics_directory is not None:
            _save_seam_rejection(diagnostics_directory,result,uv,source,source_face,missing,records)
        raise ValueError('SLIM frozen seam was not fully preserved: '+str(len(missing))+' unchanged exported edges')
    extra=[list(edge) for edge in sorted(set(cut_edges)-set(reasons))]
    receipt={'backend':'libigl positive harmonic + SLIM symmetric Dirichlet','iterationsPerIsland':20,'groups':len(groups),'islands':len(records),
        'exactGeometry':True,'exactSourceFaceMapping':True,'sharedTipSeams':shared_tip_seams,'seamVerification':'distinct exported edges; shared slit endpoint allowed','frozenReasonEdges':len(reasons),'extraCutEdges':extra,'extraCutCount':len(extra),
        'constraintConnectionPolicy':'one shortest boundary connection per disconnected reviewed seam network; already-attached networks add no spokes','closedComponentPolicy':'reject; no invented hole','temporaryLayout':'isotropic unit extent, x offset 2*island index; caller repacks',
        'stretchPolicy':{'version':'experimental-stretch-review-v1','action':'warn_only','areaWeightedP95WarningAbove':2,'areaFractionStretchOver3WarningAbove':.01},
        'status':'needs_review','requiresVisualReview':True,
        'stretchWarningIslandCount':sum(bool(r['stretchWarnings']) for r in records),
        'worstAreaWeightedStretchP95':max(r['areaWeightedStretchP95'] for r in records),
        'worstAreaFractionStretchOver3':max(r['areaFractionStretchOver3'] for r in records),
        'worstStretchMax':max(r['stretchMax'] for r in records),'islandMetrics':records,'globalOverlapChecked':False}
    return result,uv,source,source_face,receipt


def _save_seam_rejection(directory,mesh,uv,source,source_face,missing,records):
    """Preserve actual rejected solver output without claiming accepted UV."""
    import json
    from pathlib import Path
    from PIL import Image,ImageDraw
    folder=Path(directory);folder.mkdir(parents=True,exist_ok=True)
    np.savez_compressed(folder/'uv-rejected-diagnostic.npz',vertices=mesh.vertices,faces=mesh.faces,
                        uv=uv,sourceVertex=source,sourceFace=source_face)
    charts=trimesh.graph.connected_components(mesh.face_adjacency,nodes=np.arange(len(mesh.faces)),min_len=1)
    side=int(np.ceil(np.sqrt(len(charts))));size=2048;cell=size/side
    image=Image.new('RGB',(size,size),(25,25,25));draw=ImageDraw.Draw(image)
    for index,chart in enumerate(charts):
        points=uv[mesh.faces[np.asarray(chart)]];lo=points.min(axis=(0,1));extent=float(np.ptp(points,axis=(0,1)).max())
        if not np.isfinite(extent) or extent<=0:continue
        points=(points-lo)/extent*(cell*.9)+[index%side*cell+cell*.05,index//side*cell+cell*.05]
        for triangle in points:draw.polygon([tuple(p) for p in triangle],outline=(240,180,70))
    image.save(folder/'uv-rejected-layout.png')
    report={'status':'rejected_needs_review','acceptedUV':False,'bakeAllowed':False,
            'reason':'frozen seam unchanged exported edge','missingSeamCount':len(missing),
            'missingSeamSamples':missing[:64],'islandMetrics':records,
            'layoutMeaning':'Separate chart review grid; actual solver UV retained in NPZ; not accepted packed atlas'}
    (folder/'uv-rejected-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
