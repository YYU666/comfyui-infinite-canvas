"""Bounded local geometry candidates for the optional protected LOD0 route.

No asset IDs, source mutations, hole filling, or acceptance exemptions.
"""
import collections
import numpy as np
from native3d_geometry import mesh_hash
from native3d_geometry_audit import _intersection_flags


def intersection_clusters(vertices, faces, pairs):
    affected=np.unique(pairs);parent={int(x):int(x) for x in affected}
    def root(x):
        while parent[x]!=x:parent[x]=parent[parent[x]];x=parent[x]
        return x
    def union(a,b):parent[root(int(a))]=root(int(b))
    for a,b in pairs:union(a,b)
    owners={}
    for face in affected:
        for vertex in faces[face]:
            if int(vertex) in owners:union(face,owners[int(vertex)])
            else:owners[int(vertex)]=int(face)
    groups={}
    for face in affected:groups.setdefault(root(int(face)),[]).append(int(face))
    def extent(ids):return float(np.linalg.norm(np.ptp(vertices[np.unique(faces[ids])],axis=0)))
    return sorted(groups.values(),key=lambda ids:(-len(ids),-extent(ids),min(ids)))


def disk_cut(faces):
    owners={}
    for face in faces:
        for a,b in zip(face,np.roll(face,-1)):
            owners.setdefault(tuple(sorted((int(a),int(b)))),[]).append((int(a),int(b)))
    if any(len(x)>2 for x in owners.values()) or len(np.unique(faces))-len(owners)+len(faces)!=1:
        raise ValueError('Protected local patch is not a manifold Euler-one disk')
    if any(x[0]!=x[1][::-1] for x in owners.values() if len(x)==2):
        raise ValueError('Protected local patch winding is inconsistent')
    cut=[x[0] for x in owners.values() if len(x)==1];successor=dict(cut)
    if not cut or len(successor)!=len(cut) or len(set(successor.values()))!=len(cut):
        raise ValueError('Protected local patch cut is not a simple directed cycle')
    current=min(successor);seen=set()
    while current not in seen:
        seen.add(current);current=successor[current]
    if current!=min(successor) or len(seen)!=len(cut):raise ValueError('Protected patch has multiple boundary cycles')
    return sorted(cut)


def patch_intersections(vertices,faces,patch,check):
    check();tri=vertices[faces];cross=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]);length=np.linalg.norm(cross,axis=1)
    epsilon=max(float(np.linalg.norm(np.ptp(vertices,axis=0)))*1e-8,1e-12)
    if np.any(length[patch]*.5<=epsilon**2):raise ValueError('Protected candidate contains degenerate patch faces')
    normals=cross/np.maximum(length[:,None],1e-300);lo=tri.min(1);hi=tri.max(1);pairs=set()
    for a in patch:
        check();neighbors=np.flatnonzero(np.all(lo[a]<=hi+epsilon,axis=1)&np.all(hi[a]>=lo-epsilon,axis=1))
        pairs.update((min(int(a),int(b)),max(int(a),int(b))) for b in neighbors if a!=b)
        if len(pairs)>200000:raise ValueError('Protected local intersection pair budget exhausted')
    pairs=np.array(sorted(pairs),np.int64).reshape(-1,2);hits=[]
    for offset in range(0,len(pairs),8192):
        check();a,b=pairs[offset:offset+8192].T
        flags=_intersection_flags(tri,faces,normals,a,b,epsilon,check)
        hits.extend(np.column_stack((a[flags],b[flags])).tolist())
    return hits


class SourceQuality:
    def __init__(self,source,diagonal,check):
        from native3d_lod_source import _Reference
        self.reference=_Reference(source.vertices,source.faces);self.diagonal=diagonal;self.check=check
        self.vertices=np.asarray(source.vertices);self.faces=np.asarray(source.faces)
        self.normals=np.asarray(source.vertex_normals)
        self.normal_source=source.metadata.get('nativeNormalSource','unverified')
        if self.normal_source!='verified loader-retained source NORMAL/vn':
            raise ValueError('Protected local repair requires verified original imported smooth normals')
        if not np.isfinite(self.normals).all():raise ValueError('Nonfinite original smooth normals')
        self.neighborhood_cache={}

    def smooth(self,v,f,count=8192):
        from native3d_lod_source import _sample
        self.check();points,normals=_sample(v,f,count,923)
        found=self.reference.scene.compute_closest_points(self.reference.o3d.core.Tensor(np.asarray(points,np.float32)))
        ids=found['primitive_ids'].numpy();uv=found['primitive_uvs'].numpy()
        weights=np.column_stack((1-uv.sum(1),uv));smooth=np.einsum('ni,nij->nj',weights,self.normals[self.faces[ids]])
        lengths=np.linalg.norm(smooth,axis=1)
        if not np.isfinite(smooth).all() or np.any(lengths<=1e-12):raise ValueError('Original smooth normal interpolation is undefined')
        smooth/=lengths[:,None];dot=np.einsum('ij,ij->i',normals,smooth)
        return {'samples':count,'seed':923,'oppositeFraction':float(np.mean(dot<0)),
                'strongOppositeFraction':float(np.mean(dot<-.5)),'normalDotP05':float(np.percentile(dot,5))},(points,normals,ids,dot)

    def neighborhood_support(self,data):
        points,normals,ids,dot=data;negative=dot<0;unique,counts=np.unique(ids[negative],return_counts=True)
        if len(unique)>32:raise ValueError('Protected source normal neighborhood budget exceeds32 faces')
        evidence=[];weighted=0.;total=0
        for face_id,count in zip(unique,counts):
            self.check();face_id=int(face_id)
            if face_id not in self.neighborhood_cache:
                neighbors=np.flatnonzero(np.any(np.isin(self.faces,self.faces[face_id]),axis=1))
                if len(neighbors)>256:raise ValueError('Protected source normal one-ring exceeds256 faces')
                tri=self.vertices[self.faces[neighbors]];summed=np.cross(tri[:,1]-tri[:,0],tri[:,2]-tri[:,0]).sum(0)
                size=float(np.linalg.norm(summed))
                if size<=1e-12:raise ValueError('Source neighborhood orientation undefined')
                self.neighborhood_cache[face_id]=(summed/size,neighbors.tolist())
            normal,neighbors=self.neighborhood_cache[face_id];mask=negative&(ids==face_id);mean=float(np.mean(normals[mask]@normal))
            weighted+=mean*int(count);total+=int(count)
            evidence.append({'sourceFaceId':face_id,'negativeSamples':int(count),'oneRingFaces':len(neighbors),
                             'oneRingFaceIds':neighbors,'areaWeightedSupportDot':mean})
        return {'negativeSampleCount':total,'meanSupportDot':weighted/total if total else 1.,'sourceFaces':evidence,
                'scope':'evidence about nearest-source correspondence only; original normals and baking source unchanged'}

    def candidate(self,v,faces,oldv,oldfaces,patch):
        from native3d_lod_source import _sample
        points,normals=_sample(v,faces[patch],4096,923);new=self.reference.compare(points,normals,self.diagonal)
        points,normals=_sample(oldv,oldfaces[patch],4096,923);old=self.reference.compare(points,normals,self.diagonal)
        receipt={'oldPatchToOriginalHigh':old,'newPatchToOriginalHigh':new,'sourceNormals':self.normal_source,
                 'severeFacePolicy':'reject changed face with >50% samples dot<-0.5 if either fraction or strongly-opposed area increases;8192fixed samples. Any other strongly-opposed area increase requires positive original-neighborhood evidence',
                 'changedFaces':[],'warnings':[]}
        if new['distanceP95Fraction']>.005 or new['sampledMaxDistanceFraction']>.02 or new['oppositeNormalFraction']>.25:
            return False,receipt
        for face_id in patch:
            if np.array_equal(v[faces[face_id]],oldv[oldfaces[face_id]]):continue
            before,_=self.smooth(oldv,oldfaces[[face_id]]);after,data=self.smooth(v,faces[[face_id]])
            oldtri=oldv[oldfaces[face_id]];newtri=v[faces[face_id]]
            oldarea=float(np.linalg.norm(np.cross(oldtri[1]-oldtri[0],oldtri[2]-oldtri[0]))*.5)
            newarea=float(np.linalg.norm(np.cross(newtri[1]-newtri[0],newtri[2]-newtri[0]))*.5)
            before.update(faceArea=oldarea,stronglyOpposedArea=oldarea*before['strongOppositeFraction'])
            after.update(faceArea=newarea,stronglyOpposedArea=newarea*after['strongOppositeFraction'])
            row={'faceId':int(face_id),'old':before,'new':after};receipt['changedFaces'].append(row)
            worsens=(after['strongOppositeFraction']>before['strongOppositeFraction'] or
                     after['stronglyOpposedArea']>before['stronglyOpposedArea'])
            if after['strongOppositeFraction']>.5 and worsens:
                row['rejected']='new severe smooth-normal backfacing face';return False,receipt
            if worsens:
                support=self.neighborhood_support(data);row['sourceNeighborhood']=support
                if support['meanSupportDot']<=0:
                    row['rejected']='increased strong opposition unsupported by original source neighborhood';return False,receipt
                receipt['warnings'].append('Local nearest-source normal disagreement increased; original one-ring area orientation supports candidate. Source correspondence is imperfect, not silently corrected.')
        receipt['oldStronglyOpposedChangedArea']=sum(x['old']['stronglyOpposedArea'] for x in receipt['changedFaces'])
        receipt['newStronglyOpposedChangedArea']=sum(x['new']['stronglyOpposedArea'] for x in receipt['changedFaces'])
        return True,receipt


def repair_candidates(vertices,faces,source,boundary,census,check,progress=None):
    from native3d_lod_source import _Reference,_sample,_local_repair_face_ids
    v=np.asarray(vertices).copy();f=np.asarray(faces).copy();original_v=v.copy();original_f=f.copy()
    pairs=census['intersection_pairs'];clusters=intersection_clusters(v,f,pairs)
    if len(clusters)>7:raise ValueError('Protected repair exceeds7 preplanned intersection clusters')
    quality=SourceQuality(source,boundary.diagonal,check);plans=[];used=set();total=0
    for group in clusters:
        group=set(group);cluster_pairs=[p for p in pairs if p[0] in group]
        patch,_=_local_repair_face_ids(original_f,{},cluster_pairs);vertices_used=set(np.unique(original_f[patch]).tolist())
        diameter=float(np.linalg.norm(np.ptp(original_v[list(vertices_used)],axis=0)))
        if len(patch)>32 or diameter>boundary.diagonal*.02 or total+len(patch)>128:
            raise ValueError('Protected local patch exceeds32face/2percent/128total budget')
        if vertices_used&used:raise ValueError('Protected preplanned patches overlap')
        cut=disk_cut(original_f[patch]);plans.append((patch,cut,diameter));used.update(vertices_used);total+=len(patch)
    receipt={'profile':'protected-local-v1','maxClusters':7,'maxFacesPerPatch':32,'totalPlannedFaces':total,
             'maxCandidateFlipsPerCluster':64,'maxFlipsPerCluster':4,'localDistanceLimitFraction':.002,
             'relocationFractions':[.125,.25,.5,1.],'relocationMaxDisplacementFraction':.002,'clusters':[]}
    for index,(patch,cut,diameter) in enumerate(plans,1):
        check()
        if progress:progress('局部交叉修复 '+str(index)+'/'+str(len(plans)),55+index*4)
        oldpatch=original_f[patch];oldref=_Reference(original_v,oldpatch);oldpoints,oldnormals=_sample(original_v,oldpatch,4096,923)
        initial=patch_intersections(v,f,patch,check);patchset=set(patch.tolist());outside_initial={tuple(p) for p in initial if any(i not in patchset for i in p)}
        row={'index':index,'patchFaceIds':patch.tolist(),'cut':cut,'diameter':diameter,'initialPairs':initial,'candidateCount':0,'flips':[],'rejections':{}}
        receipt['clusters'].append(row)
        def reject(reason):row['rejections'][reason]=row['rejections'].get(reason,0)+1
        def local_fidelity(cv,cf):
            points,normals=_sample(cv,cf[patch],4096,923);forward=oldref.compare(points,normals,boundary.diagonal)
            backward=_Reference(cv,cf[patch]).compare(oldpoints,oldnormals,boundary.diagonal)
            distance=max(forward['sampledMaxDistanceFraction'],backward['sampledMaxDistanceFraction'])
            return distance,{'newToOriginalPatch':forward,'originalPatchToNew':backward}
        keep=np.ones(len(f),bool);keep[patch]=False
        outside_edges={tuple(x) for x in np.unique(np.sort(np.concatenate((f[keep][:,[0,1]],f[keep][:,[1,2]],f[keep][:,[2,0]])),axis=1),axis=0).tolist()}
        def key(state):return tuple(sorted(tuple(np.roll(t,-int(np.argmin(t)))) for t in state))
        queue=collections.deque([(f[patch].copy(),[],initial)]);seen={key(f[patch])};best=None
        # Strict improvements are ranked first; bounded BFS also permits neutral steps.
        while queue and row['candidateCount']<64:
            state,path,current=queue.popleft()
            if len(path)>=4:continue
            owners={}
            for offset,t in enumerate(state):
                for k in range(3):
                    a,b,c=map(int,[t[k],t[(k+1)%3],t[(k+2)%3]])
                    owners.setdefault(tuple(sorted((a,b))),[]).append((offset,a,b,c))
            existing=outside_edges|set(owners);hitfaces=set(np.asarray(current).ravel().tolist())
            edges=[(edge,owner) for edge,owner in owners.items() if len(owner)==2]
            edges.sort(key=lambda x:(-sum(int(patch[item[0]]) in hitfaces for item in x[1]),x[0]));solved=[]
            for edge,owner in edges:
                check()
                if row['candidateCount']>=64:break
                row['candidateCount']+=1;(i,a,b,c),(j,bb,aa,d)=owner
                if a!=aa or b!=bb or len({a,b,c,d})!=4 or tuple(sorted((c,d))) in existing:
                    reject('invalid oriented quad or existing diagonal');continue
                replacement=np.array([[c,a,d],[c,d,b]],np.int64);nextstate=state.copy();nextstate[[i,j]]=replacement
                state_key=key(nextstate)
                if state_key in seen:reject('visited');continue
                seen.add(state_key);candidate=f.copy();candidate[patch]=nextstate
                if disk_cut(candidate[patch])!=cut:reject('cut changed');continue
                try:remaining=patch_intersections(v,candidate,patch,check)
                except ValueError as error:
                    if 'degenerate' not in str(error):raise
                    reject('degenerate');continue
                if len(remaining)>len(current):reject('intersection increase');continue
                if not {tuple(p) for p in remaining if any(i not in patchset for i in p)}<=outside_initial:
                    reject('new external crossing');continue
                distance,fidelity=local_fidelity(v,candidate)
                if distance>.002:reject('local fidelity');continue
                step={'oldEdge':list(edge),'newEdge':[c,d],'faceIds':[int(patch[i]),int(patch[j])],
                      'oldFaces':state[[i,j]].tolist(),'newFaces':replacement.tolist(),'beforePairs':current,'afterPairs':remaining,'fidelity':fidelity}
                newpath=path+[step]
                if not remaining:
                    eligible,normal=quality.candidate(v,candidate,original_v,original_f,patch)
                    step['originalSourceQuality']=normal
                    if not eligible:reject('original smooth normal quality');continue
                    solved.append(((len(newpath),distance,normal['newPatchToOriginalHigh']['sampledMaxDistanceFraction'],edge),candidate,newpath))
                    # One-flip improvements use best shape preservation. Once
                    # BFS needs a neutral predecessor, preserve deterministic
                    # breadth-first first-solution order (no parameter search).
                    if path:break
                else:queue.append((nextstate,newpath,remaining))
            if solved:best=min(solved,key=lambda x:x[0]);break
        if best is not None:
            _,f,row['flips']=best;row['status']='locally_clean';continue
        # A single interior vertex may move toward its fixed boundary-neighbor mean.
        cut_vertices=np.unique(cut);inside=np.setdiff1d(np.unique(f[patch]),cut_vertices)
        if len(inside)!=1:row['status']='unsupported';continue
        vertex=int(inside[0]);neighbors=np.unique(f[patch][np.any(f[patch]==vertex,axis=1)]);neighbors=neighbors[neighbors!=vertex]
        if not set(neighbors)<=set(cut_vertices):row['status']='unsupported';continue
        target=v[neighbors].mean(0);row['relocationTrials']=[]
        for fraction in (.125,.25,.5,1.):
            check();cv=v.copy();cv[vertex]=v[vertex]+fraction*(target-v[vertex]);displacement=float(np.linalg.norm(cv[vertex]-original_v[vertex]))
            trial={'fraction':fraction,'vertex':vertex,'oldPosition':original_v[vertex].tolist(),'newPosition':cv[vertex].tolist(),'displacementMeters':displacement}
            row['relocationTrials'].append(trial)
            if displacement>boundary.diagonal*.002:trial['rejected']='displacement';continue
            distance,fidelity=local_fidelity(cv,f);trial['fidelity']=fidelity
            if distance>.002:trial['rejected']='local fidelity';continue
            remaining=patch_intersections(cv,f,patch,check);trial['remainingPairs']=remaining
            if remaining:trial['rejected']='intersection remains';continue
            eligible,normal=quality.candidate(cv,f,original_v,original_f,patch);trial['originalSourceQuality']=normal
            if not eligible:trial['rejected']='original smooth normal quality';continue
            v=cv;row['relocation']=trial;row['status']='locally_clean';break
        row.setdefault('status','unsupported')
    receipt['status']='complete' if all(x['status']=='locally_clean' for x in receipt['clusters']) else 'blocked'
    receipt['candidateMeshHash']=mesh_hash(v,f)
    return v,f,receipt


def relocate_fixed_topology(vertices, faces, source, boundary, census, check, progress=None):
    """Bounded deformation of complete stars; no connectivity-changing repairs.

    Unlike flips, star footprint is not a deformation bound. Every trial is
    canonicalized and measured from the immutable pre-repair vertex positions.
    The caller must still run a complete canonical whole-mesh census.
    """
    from native3d_lod_source import _Reference, _sample, _local_repair_face_ids
    v=np.asarray(vertices).copy();f=np.asarray(faces).copy();original=v.copy()
    if not np.array_equal(v,v.astype(np.float32).astype(v.dtype)):
        raise ValueError('Fixed-topology repair requires canonical input')
    if not census.get('intersectionComplete'):
        raise ValueError('Fixed-topology repair requires complete census')
    groups=intersection_clusters(v,f,census['intersection_pairs'])
    if len(groups)>7:raise ValueError('Fixed-topology repair exceeds7 clusters')
    plans=[];used=set();total=0
    for group in groups:
        check();pairs=[p for p in census['intersection_pairs'] if p[0] in group]
        patch,shared=_local_repair_face_ids(f,{},pairs);cut=disk_cut(f[patch])
        vertices_used=set(np.unique(f[patch]).tolist());inside=vertices_used-set(np.unique(cut).tolist())
        if len(patch)>32 or total+len(patch)>128 or vertices_used&used:
            raise ValueError('Fixed-topology repair exceeds disjoint32face/128total scope')
        if len(inside)!=1:raise ValueError('Fixed-topology repair needs one interior vertex')
        vertex=next(iter(inside))
        incident=np.flatnonzero(np.any(f==vertex,axis=1))
        if vertex not in shared or not np.array_equal(incident,patch):
            raise ValueError('Fixed-topology patch must be the complete crossing-vertex star')
        plans.append((patch,cut,vertex));used.update(vertices_used);total+=len(patch)
    quality=SourceQuality(source,boundary.diagonal,check)
    receipt={'profile':'fixed-topology-relocation-v1','clusters':[], 'maxClusters':7,
             'maxFacesPerPatch':32,'maxTotalFaces':128,'totalPlannedFaces':total,
             'fractions':[.125,.25,.5,1.],'maximumCumulativeDisplacementFraction':.002,
             'footprintPolicy':'diagnostic only for unchanged connectivity; flip limits unchanged'}
    for patch,cut,vertex in plans:
        check();neighbors=np.setdiff1d(np.unique(f[patch]),[vertex]);target=original[neighbors].mean(0)
        oldref=_Reference(original,f[patch]);oldpoints,oldnormals=_sample(original,f[patch],4096,923)
        row={'patchFaceIds':patch.tolist(),'vertex':vertex,'cut':cut,
             'diameter':float(np.linalg.norm(np.ptp(original[np.unique(f[patch])],axis=0))),
             'trials':[],'status':'blocked'};receipt['clusters'].append(row)
        if progress:progress('固定拓扑局部修复',65)
        for fraction in (.125,.25,.5,1.):
            check();cv=v.copy();cv[vertex]=np.asarray(original[vertex]+fraction*(target-original[vertex]),np.float32)
            displacement=float(np.linalg.norm(cv-original,axis=1).max())
            trial={'fraction':fraction,'cumulativeCanonicalDisplacementMeters':displacement,
                   'analyticBidirectionalHausdorffUpperBoundMeters':displacement,
                   'analyticBound':'fixed connectivity and matching barycentric coordinates',
                   'newPosition':cv[vertex].tolist()};row['trials'].append(trial)
            if displacement>boundary.diagonal*.002:trial['rejected']='displacement';continue
            points,normals=_sample(cv,f[patch],4096,923)
            forward=oldref.compare(points,normals,boundary.diagonal)
            backward=_Reference(cv,f[patch]).compare(oldpoints,oldnormals,boundary.diagonal)
            trial['localFidelity']={'newToOld':forward,'oldToNew':backward}
            if max(forward['sampledMaxDistanceFraction'],backward['sampledMaxDistanceFraction'])>.002:
                trial['rejected']='local fidelity';continue
            try:remaining=patch_intersections(cv,f,patch,check)
            except ValueError as error:
                if 'degenerate' not in str(error):raise
                trial['rejected']='degenerate';continue
            trial['remainingPairs']=remaining
            if remaining:trial['rejected']='intersection remains';continue
            eligible,normal=quality.candidate(cv,f,original,f,patch)
            trial['originalSourceQuality']=normal
            if not eligible:trial['rejected']='original smooth normal quality';continue
            v=cv;row.update(status='locally_clean',relocation=trial);break
    movable=[vertex for _,_,vertex in plans];outside=np.ones(len(v),bool);outside[movable]=False
    if not np.array_equal(v[outside],original[outside]) or not np.array_equal(f,faces):
        raise ValueError('Fixed-topology repair mutated fixed geometry')
    receipt.update(status='complete' if all(x['status']=='locally_clean' for x in receipt['clusters']) else 'blocked',
                   candidateMeshHash=mesh_hash(v,f),fixedVerticesExact=True,connectivityExact=True)
    return v,f,receipt
