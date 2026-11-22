"""Bounded structural-seam network connection; no source-position changes."""
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

def connected_constraint_cuts(vertices,faces,source,reasons):
    from native3d_uv_slim import _boundary
    edges,count,loops=_boundary(faces)
    required={tuple(map(int,e)) for e,n in zip(edges,count) if n==2 and tuple(sorted(map(int,source[e]))) in reasons}
    if not required:return required
    neighbors={}
    for a,b in required:neighbors.setdefault(a,set()).add(b);neighbors.setdefault(b,set()).add(a)
    remaining=set(neighbors);networks=[]
    while remaining:
        seed=min(remaining);seen={seed};stack=[seed]
        while stack:
            for vertex in neighbors[stack.pop()]-seen:seen.add(vertex);stack.append(vertex)
        remaining-=seen;networks.append(seen)
    lengths=np.linalg.norm(vertices[edges[:,0]]-vertices[edges[:,1]],axis=1)
    graph=coo_matrix((np.r_[lengths,lengths],(np.r_[edges[:,0],edges[:,1]],np.r_[edges[:,1],edges[:,0]])),shape=(len(vertices),len(vertices))).tocsr()
    boundary=set(map(int,np.concatenate(loops)));distance,previous,_=dijkstra(graph,directed=False,indices=np.array(sorted(boundary)),min_only=True,return_predecessors=True)
    cuts=set(required)
    # A connected seam network needs one route to the existing boundary.
    # Already attached networks gain no spokes. Disk validation still follows.
    for network in networks:
        if network&boundary:continue
        current=min(network,key=lambda v:(distance[v],v));steps=0
        while current not in boundary:
            following=int(previous[current]);steps+=1
            if following<0 or steps>len(vertices):raise ValueError('Constraint network has no path to boundary')
            cuts.add(tuple(sorted((current,following))));current=following
    return cuts

def natural_lscm_slim(igl,vertices,faces,loop):
    """One deterministic two-pin LSCM initial guess and free SLIM20 solve.

    Experimental local candidate. Positive triangles and full overlap validation
    are required by the caller; LSCM/free SLIM do not guarantee injectivity.
    """
    from native3d_uv_slim import _distortion
    start=int(loop[0]);other=int(loop[np.argmax(np.linalg.norm(vertices[loop]-vertices[start],axis=1))])
    pins=np.array([start,other],np.int32);targets=np.array([[0.,0.],[np.linalg.norm(vertices[other]-vertices[start]),0.]])
    solved=igl.lscm(np.asarray(vertices,float),np.asarray(faces,np.int32),pins,targets)
    uv=np.asarray(solved[0] if isinstance(solved,tuple) else solved,float)
    before=_distortion(vertices,faces,uv)
    if before['nonpositiveTriangles']==len(faces):uv[:,1]*=-1;before=_distortion(vertices,faces,uv)
    if not np.isfinite(uv).all() or before['nonpositiveTriangles']:raise ValueError('Natural LSCM initial embedding has flips: '+str(before['nonpositiveTriangles']))
    state=igl.slim_precompute(np.asfortranarray(vertices,np.float64),np.asfortranarray(faces,np.int32),np.asfortranarray(uv),igl.MappingEnergyType.SYMMETRIC_DIRICHLET,np.empty(0,np.int32),np.empty((0,2),np.float64,order='F'),0.)
    uv=np.asarray(igl.slim_solve(state,20));metrics=_distortion(vertices,faces,uv)
    if not np.isfinite(uv).all() or metrics['nonpositiveTriangles']:raise ValueError('Natural SLIM returned flipped/nonfinite UV')
    extent=float(np.ptp(uv,axis=0).max())
    if extent<=0:raise ValueError('Natural SLIM empty chart')
    return (uv-uv.min(0))/extent,metrics
