"""Bounded natural chart refinement driven by measured invalid parameterizations."""
import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from native3d_uv_slim import _fans,_components,_disk_parts,_distortion
from native3d_uv_natural import natural_lscm_slim
from native3d_uv_overlap import overlap_pairs

def split_region(mesh,ids,min_child=8):
    ids=np.asarray(ids,np.int64);lookup=np.full(len(mesh.faces),-1,np.int64);lookup[ids]=np.arange(len(ids))
    adj=np.asarray(mesh.face_adjacency);valid=np.all(lookup[adj]>=0,axis=1);edges=np.asarray(mesh.face_adjacency_edges)[valid];pairs=lookup[adj[valid]]
    center=np.asarray(mesh.triangles_center)[ids];length=np.linalg.norm(center[pairs[:,0]]-center[pairs[:,1]],axis=1)
    graph=coo_matrix((np.r_[length,length],(np.r_[pairs[:,0],pairs[:,1]],np.r_[pairs[:,1],pairs[:,0]])),shape=(len(ids),len(ids))).tocsr()
    first=dijkstra(graph,directed=False,indices=0);a=int(np.argmax(first));da=dijkstra(graph,directed=False,indices=a);b=int(np.argmax(da));db=dijkstra(graph,directed=False,indices=b)
    scalar=da-db
    if not np.isfinite(scalar).all():raise ValueError('Natural refinement requires connected face region')
    n=np.asarray(mesh.face_normals)[ids];edge_length=np.linalg.norm(np.asarray(mesh.vertices)[edges[:,0]]-np.asarray(mesh.vertices)[edges[:,1]],axis=1)
    cost=edge_length*(.15+np.maximum(np.sum(n[pairs[:,0]]*n[pairs[:,1]],axis=1),0.))
    candidates=[]
    for fraction in (.35,.5,.65):
        cut=float(np.quantile(scalar,fraction));labels=(scalar>cut).astype(int)
        comps=trimesh.graph.connected_components(pairs[labels[pairs[:,0]]==labels[pairs[:,1]]],nodes=np.arange(len(ids)),min_len=1)
        if len(comps)!=2 or min(map(len,comps))<min_child:continue
        crossing=labels[pairs[:,0]]!=labels[pairs[:,1]];score=float(cost[crossing].sum()/np.sqrt(min(map(len,comps))))
        candidates.append((score,fraction,[ids[np.sort(c)] for c in comps]))
    if not candidates:raise ValueError('No connected balanced split without tiny/isolated faces')
    _,fraction,children=min(candidates,key=lambda x:(x[0],x[1]));return children,{'split':'surface_geodesic_balanced_cut','balanceQuantile':fraction,'preference':'lower cut cost at real normal turns','childrenFaces':list(map(len,children))}

def refine_group(mesh,group,reasons,*,force_split=False,max_depth=7,max_solves=127):
    import igl,time
    records=[];out=[];solves=0
    def recurse(ids,depth,forced=False):
        nonlocal solves
        start=time.perf_counter();solves+=1
        if solves>max_solves:raise ValueError('Natural refinement solve budget exceeded')
        attempt=[];failure='previous measured self-overlap' if forced else None
        if not forced:
            try:
                source,inv=np.unique(np.asarray(mesh.faces)[ids],return_inverse=True);v,f,source=_fans(np.asarray(mesh.vertices)[source],inv.reshape(-1,3),source)
                for vv,ff,ss,sf in _components(v,f,source,ids):
                    for dv,df,ds,dsf,loop in _disk_parts(igl,vv,ff,ss,sf,reasons):
                        uv,metrics=natural_lscm_slim(igl,dv,df,loop)
                        conflicts=overlap_pairs(trimesh.Trimesh(dv,df,process=False),uv)
                        if conflicts:raise ValueError('global_overlap_pairs='+str(len(conflicts)))
                        attempt.append((dv,df,ds,dsf,uv,metrics))
            except (ValueError,RuntimeError) as error:failure=str(error)
        if failure is None:
            records.append({'depth':depth,'faces':len(ids),'accepted':True,'charts':len(attempt),'seconds':time.perf_counter()-start});out.extend(attempt);return
        record={'depth':depth,'faces':len(ids),'accepted':False,'reason':failure,'seconds':time.perf_counter()-start};records.append(record)
        if depth>=max_depth or len(ids)<16:raise ValueError('Natural chart repair blocked at bounded leaf: '+str(record))
        children,split=split_region(mesh,ids);record.update(split)
        for child in children:recurse(child,depth+1)
    recurse(np.asarray(group,np.int64),0,force_split)
    return out,records
