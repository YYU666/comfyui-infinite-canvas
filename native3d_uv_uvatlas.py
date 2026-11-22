"""UVAtlas macro-group parameterization with exact source mapping and checkpoints."""
import hashlib
import json
import os
import time
from pathlib import Path
import numpy as np
import trimesh
from native3d_uv_slim import _distortion,_fans
from native3d_uv_overlap import overlap_pairs

def group_cache_identity(mesh,groups,reasons):
    owner=np.empty(len(mesh.faces),np.int64)
    for i,group in enumerate(groups):owner[group]=i
    # Reason labels are review provenance; only actual hard-edge topology is
    # an input to UVAtlas. Label-only changes must not invalidate geometry.
    return hashlib.sha256(np.asarray(mesh.vertices,dtype='<f8').tobytes()+np.asarray(mesh.faces,dtype='<i8').tobytes()+owner.astype('<i8').tobytes()+json.dumps(sorted(list(k) for k in reasons)).encode()+b'uvatlas1-commit3a7eaedb-stretch.3-maxcharts0').hexdigest()

def group_cache_root():
    configured=os.environ.get('NATIVE3D_UVATLAS_GROUP_CACHE')
    return Path(configured).expanduser().resolve() if configured else Path(__file__).resolve().parent/'.cache/native3d/uvatlas-group-cache'

def parameterize_groups(mesh,groups,reasons,diagnostics_directory=None):
    from native3d_uv_uvatlas_runtime import unwrap_patch
    start=time.perf_counter();vertices=np.asarray(mesh.vertices);faces=np.asarray(mesh.faces)
    owner=np.empty(len(faces),np.int64)
    for i,group in enumerate(groups):owner[group]=i
    fingerprint=group_cache_identity(mesh,groups,reasons)
    cache=group_cache_root()/fingerprint;cache.mkdir(parents=True,exist_ok=True)
    outputs=[];receipts=[];reused=0
    for i,group in enumerate(groups):
        source,inv=np.unique(faces[group],return_inverse=True);local_faces=inv.reshape(-1,3)
        global_to_local={int(v):j for j,v in enumerate(source)}
        present=set(map(tuple,np.sort(np.concatenate((local_faces[:,[0,1]],local_faces[:,[1,2]],local_faces[:,[2,0]])),axis=1)))
        hard={tuple(sorted((global_to_local[a],global_to_local[b]))) for a,b in reasons if a in global_to_local and b in global_to_local}
        hard&=present
        checkpoint=cache/('group-'+str(i)+'.npz') if cache else None
        meta=checkpoint.with_suffix('.json') if checkpoint else None
        if checkpoint and checkpoint.is_file() and meta.is_file():
            receipt=json.loads(meta.read_text());raw=np.load(checkpoint,allow_pickle=False)
            if hashlib.sha256(checkpoint.read_bytes()).hexdigest()!=receipt['sha256']:raise ValueError('UVAtlas group checkpoint changed')
            uv,ff,remap,partition=(raw[k] for k in ('uv','faces','sourceVertex','partition'));reused+=1
        else:
            uv,ff,remap,partition,receipt=unwrap_patch(vertices[source],local_faces,hard,cache_directory=cache/('runtime-'+str(i)) if cache else None)
        raw_cache=(uv,ff,remap,partition)
        s=source[np.asarray(remap,int)];v=vertices[s];ff=np.asarray(ff,int);uv=np.asarray(uv,float)
        if not np.array_equal(s[ff],faces[group]):raise ValueError('UVAtlas changed source face corners')
        v,ff,fan=_fans(v,ff,np.arange(len(v)));s=s[fan];uv=uv[fan]
        chart_mesh=trimesh.Trimesh(v,ff,process=False)
        joined={tuple(sorted(map(int,s[e]))) for e in chart_mesh.face_adjacency_edges}
        if joined&set(reasons):raise ValueError('UVAtlas failed to preserve hard seams')
        parts=trimesh.graph.connected_components(chart_mesh.face_adjacency,nodes=np.arange(len(ff)),min_len=1)
        for ids in parts:
            ids=np.sort(ids);used,inv=np.unique(ff[ids],return_inverse=True);f=inv.reshape(-1,3);u=uv[used];extent=np.ptp(u,axis=0).max()
            if extent<=0:raise ValueError('UVAtlas zero-extent chart')
            u=(u-u.min(0))/extent;metric=_distortion(v[used],f,u)
            if metric['nonpositiveTriangles']==len(ids):u[:,0]*=-1;metric=_distortion(v[used],f,u)
            conflicts=overlap_pairs(trimesh.Trimesh(v[used],f,process=False),u)
            if metric['nonpositiveTriangles'] or conflicts:raise ValueError('UVAtlas local chart orientation/overlap failed')
            outputs.append((v[used],f,s[used],np.asarray(group)[ids],u,metric))
        if checkpoint and not checkpoint.is_file():
            raw_uv,raw_faces,raw_remap,raw_partition=raw_cache
            np.savez_compressed(checkpoint,uv=raw_uv,faces=raw_faces,sourceVertex=raw_remap,partition=raw_partition)
            receipt={**receipt,'sha256':hashlib.sha256(checkpoint.read_bytes()).hexdigest()};meta.write_text(json.dumps(receipt,indent=2),encoding='utf-8')
        receipts.append(receipt)
        print(json.dumps({'stage':'uvatlas_macro_groups','complete':i+1,'total':len(groups),'charts':len(outputs),'reusedGroups':reused}),flush=True)
    vs=[];fs=[];uvs=[];sv=[];sf=[];metrics=[];offset=0
    for i,(v,f,s,ids,u,metric) in enumerate(outputs):
        u=u.copy();u[:,0]+=i*2;vs.append(v);fs.append(f+offset);uvs.append(u);sv.append(s);sf.append(ids);offset+=len(v);metrics.append({'faces':len(f),**metric})
    result=trimesh.Trimesh(np.concatenate(vs),np.concatenate(fs),process=False);uv=np.concatenate(uvs);source=np.concatenate(sv);face=np.concatenate(sf)
    if not np.array_equal(np.sort(face),np.arange(len(faces))) or not np.array_equal(source[result.faces],faces[face]):raise ValueError('UVAtlas missing/reordered source triangles')
    joined={tuple(sorted(map(int,source[e]))) for e in result.face_adjacency_edges};interior={tuple(sorted(map(int,e))) for e in mesh.face_adjacency_edges}
    missing=(set(reasons)&interior)&joined
    if missing:raise ValueError('UVAtlas failed to preserve hard seams: '+str(len(missing)))
    receipt={'backend':'Microsoft UVAtlas macro groups','islands':len(outputs),'reusedGroups':reused,'runtimeGroups':receipts,'islandMetrics':metrics,'hardConstraintEdges':len(reasons),'missingHardConstraintEdges':0,
        'stretchPolicy':'warn_only','stretchWarningIslandCount':sum(p['areaWeightedStretchP95']>2 for p in metrics),'seconds':time.perf_counter()-start,'globalOverlapChecked':False,'circleBoundaryUsed':False,'faceIsolationUsed':False}
    if diagnostics_directory:
        out=Path(diagnostics_directory);np.savez_compressed(out/'macro-parameterized.npz',vertices=result.vertices,faces=result.faces,uv=uv,sourceVertex=source,sourceFace=face)
        (out/'macro-parameterized.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    return result,uv,source,face,receipt
