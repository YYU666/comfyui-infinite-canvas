"""Local MIT UVAtlas adapter. Native geometry is diagnostic float32 only;
callers reconstruct output geometry from original double vertices[remap].
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import numpy as np

ROOT=Path(__file__).resolve().parent
CACHE=ROOT/'.cache'/'native3d'/'uv-atlas-native-v1'

def runtime_status():
    configured=os.environ.get('NATIVE3D_UVATLAS_EXECUTABLE')
    executable=Path(configured).expanduser().resolve() if configured else CACHE/'runtime-build'/'Release'/'patch.exe'
    if not configured and not executable.is_file():executable=CACHE/'probe-build'/'Release'/'patch.exe'
    return {'ready':executable.is_file(),'executable':str(executable),'backend':'Microsoft UVAtlas 1.9.2',
            'license':'MIT','sourceCommit':'3a7eaedb26dec6c1a5b5321692b6da2a6902cd4c',
            'buildScript':str(ROOT/'scripts'/'build-native3d-uvatlas.ps1')}

def unwrap_patch(vertices,faces,hard_edges,cache_directory=None):
    start=time.monotonic();v=np.asarray(vertices,dtype=np.float64);f=np.asarray(faces)
    if v.ndim!=2 or v.shape[1]!=3 or not np.isfinite(v).all() or f.ndim!=2 or f.shape[1]!=3 or f.dtype.kind not in 'iu':
        raise ValueError('Invalid UVAtlas patch arrays')
    if not 1<=len(f)<=100000 or not 3<=len(v)<=200000 or f.min()<0 or f.max()>=len(v):
        raise ValueError('UVAtlas patch bounds exceeded')
    f=f.astype(np.int64);v32=v.astype('<f4')
    if not np.isfinite(v32).all():raise ValueError('UVAtlas float32 positions overflow')
    # Existing exact duplicate positions (explicit fans) are allowed; new
    # float32 collisions would invent connectivity and are refused.
    if len(np.unique(v32,axis=0))!=len(np.unique(v,axis=0)):
        raise ValueError('UVAtlas float32 conversion merges distinct positions')
    cross=np.cross(v32[f[:,1]]-v32[f[:,0]],v32[f[:,2]]-v32[f[:,0]])
    if np.any(np.linalg.norm(cross.astype(float),axis=1)<=0):
        raise ValueError('UVAtlas float32 input has degenerate faces')
    cuts=set()
    for edge in hard_edges:
        if len(edge)!=2:raise ValueError('Invalid hard edge')
        a,b=map(int,edge)
        if a==b or min(a,b)<0 or max(a,b)>=len(v):raise ValueError('Hard edge index invalid')
        cuts.add(tuple(sorted((a,b))))
    adjacency=np.full(f.shape,2**32-1,dtype='<u4');owners={}
    for i,face in enumerate(f):
        for j in range(3):owners.setdefault(tuple(sorted((int(face[j]),int(face[(j+1)%3])))),[]).append((i,j))
    if cuts-set(owners):raise ValueError('Requested hard edge absent from patch')
    for edge,entries in owners.items():
        if len(entries)>2:raise ValueError('UVAtlas nonmanifold edge')
        if len(entries)==2 and edge not in cuts:
            (a,ai),(b,bi)=entries;adjacency[a,ai]=b;adjacency[b,bi]=a
    state=runtime_status()
    if not state['ready']:raise ValueError('UVAtlas native runtime unavailable; run '+state['buildScript'])
    base=Path(cache_directory) if cache_directory else None
    if base:base.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='uvatlas-',dir=str(base) if base else None) as tmp:
        input_path=Path(tmp)/'input.bin';output_path=Path(tmp)/'output.bin'
        with input_path.open('wb') as stream:
            np.asarray([len(v),len(f)],'<u4').tofile(stream);v32.tofile(stream);f.astype('<u4').tofile(stream);adjacency.tofile(stream)
        try:
            proc=subprocess.run([state['executable'],str(input_path),str(output_path)],capture_output=True,text=True,timeout=210,
                                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        except subprocess.TimeoutExpired as exc:raise ValueError('UVAtlas patch exceeded210 seconds') from exc
        if proc.returncode or not output_path.is_file():raise ValueError('UVAtlas native failed: '+(proc.stdout+proc.stderr)[-2000:])
        with output_path.open('rb') as stream:
            header=np.fromfile(stream,'<u4',3)
            if len(header)!=3:raise ValueError('UVAtlas truncated header')
            nv,nf,ncharts=map(int,header)
            if nf!=len(f) or not 3<=nv<=3*nf or not 1<=ncharts<=nf:raise ValueError('UVAtlas invalid output counts')
            expected=16+nv*8+nf*12+nv*4+nf*4
            if output_path.stat().st_size!=expected:raise ValueError('UVAtlas output byte length mismatch')
            stretch=float(np.fromfile(stream,'<f4',1)[0]);uv=np.fromfile(stream,'<f4',nv*2).reshape(-1,2).astype(float)
            result=np.fromfile(stream,'<u4',nf*3).reshape(-1,3).astype(np.int64)
            remap=np.fromfile(stream,'<u4',nv).astype(np.int64);partition=np.fromfile(stream,'<u4',nf).astype(np.int64)
    if result.max()>=len(remap) or remap.max()>=len(v) or not np.array_equal(remap[result],f):
        raise ValueError('UVAtlas source face corner mapping mismatch')
    if not np.isfinite(uv).all() or not np.isfinite(stretch) or len(np.unique(partition))!=ncharts:
        raise ValueError('UVAtlas output invalid')
    # Verify actual UV discontinuity across every two-owner requested edge.
    for edge in cuts:
        entries=owners[edge]
        if len(entries)!=2:continue
        points=[]
        for face_id,_ in entries:
            points.append([uv[result[face_id,int(np.flatnonzero(f[face_id]==vertex)[0])]] for vertex in edge])
        if np.array_equal(points[0],points[1]):raise ValueError('UVAtlas reconnected required hard seam')
    receipt={**state,'maxStretchRequested':.3,'nativeStretch':stretch,'charts':ncharts,'triangles':len(f),
             'hardEdgesRequested':len(cuts),'hardSeamsVerified':True,'sourceFaceCornersExact':True,
             'sourcePositionPolicy':'original float64 vertices indexed by sourceVertex; no native positions applied',
             'maxInputFloat32PositionError':float(np.max(np.linalg.norm(v-v32.astype(float),axis=1))),
             'nativeUVFloat32':True,'wallSeconds':time.monotonic()-start,'independentQualityGateRequired':True,
             'executableSha256':hashlib.sha256(Path(state['executable']).read_bytes()).hexdigest()}
    return uv,result,remap,partition,receipt
