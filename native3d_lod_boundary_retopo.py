"""Bounded traditional local boundary retopology; never AI or whole-mesh QEM.

Only an uncertain distance certificate on one boundary edge is eligible.
Every candidate starts from the same immutable canonical mesh and adds one
vertex/one triangle. A reversible face map preserves the rejected diagnostic.
"""
import time
import numpy as np
from native3d_geometry import mesh_hash
from native3d_geometry_audit import audit_geometry
from native3d_lod_boundary import _boundary_topology


CERTIFICATE_FAILURES=(
    'Boundary distance upper bound could not be certified within budget',
    'Boundary distance proof exceeded bounded work budget',
)


def _check(deadline):
    if time.monotonic()>=deadline:raise ValueError('Local boundary retopology deadline exhausted')


def _closest(points, segments, deadline):
    a=segments[:,0];ab=segments[:,1]-a;den=np.sum(ab*ab,axis=1)
    if np.any(den<=0):raise ValueError('Boundary marker contains zero length edge')
    distances=[];nearest=[];indices=[]
    for offset in range(0,len(points),64):
        _check(deadline);p=points[offset:offset+64];delta=p[:,None,:]-a
        t=np.clip(np.sum(delta*ab,axis=2)/den,0,1);q=a+t[:,:,None]*ab
        d=np.linalg.norm(p[:,None,:]-q,axis=2);ids=d.argmin(1);rows=np.arange(len(p))
        distances.extend(d[rows,ids]);nearest.extend(q[rows,ids]);indices.extend(ids)
    return np.asarray(distances),np.asarray(nearest),np.asarray(indices)


def _trace(source,target,limit,deadline):
    rows=[];evaluations=0;result=None
    for refinement in range(5):
        _check(deadline);steps=np.maximum(1,np.ceil(source['lengths']/(limit/4/2**refinement)).astype(int))
        count=int(sum(steps+1))
        if count>200000 or evaluations+count*len(target['segments'])>100000000:break
        points=np.concatenate([a+np.linspace(0,1,int(n)+1)[:,None]*(b-a)
                               for (a,b),n in zip(source['segments'],steps)])
        distances,nearest,_=_closest(points,target['segments'],deadline);i=int(distances.argmax())
        maximum=float(distances[i]);upper=maximum+float(np.max(source['lengths']/steps))/2
        evaluations+=count*len(target['segments'])
        rows.append({'refinement':refinement,'sampledMaximumMeters':maximum,'certifiedUpperMeters':upper,
                     'samples':count,'distanceEvaluations':evaluations})
        result={'sampledMaximumMeters':maximum,'certifiedUpperMeters':upper,
                'sourcePoint':points[i].tolist(),'targetPoint':nearest[i].tolist(),
                'classification':'confirmed_issue' if maximum>limit else 'certification_incomplete' if upper>limit else 'certified'}
        if maximum>limit or upper<=limit:break
    if result is None:raise ValueError('No bounded boundary localization evidence')
    return {**result,'trace':rows}


def locate_boundary_issue(vertices,faces,boundary,deadline):
    """Reusable marker evidence; caller adds job/attempt/file identity, no re-scan."""
    _check(deadline);v=np.asarray(vertices);f=np.asarray(faces)
    components,_=_boundary_topology(v,f)
    if len(components)!=1 or len(boundary.components)!=1:
        raise ValueError('Local boundary retopology requires one component')
    original=boundary.components[0];child=components[0]
    if original['euler']!=child['euler'] or len(original['loops'])!=1 or len(child['loops'])!=1:
        raise ValueError('Local boundary retopology requires matching single boundary loops')
    source=original['loops'][0];target=child['loops'][0]
    if not .95<=target['perimeter']/source['perimeter']<=1.05:
        raise ValueError('Boundary perimeter failed; not a local certificate repair')
    limit=min(boundary.diagonal*.005,source['perimeter']*.01)
    edges=np.sort(np.concatenate((f[:,[0,1]],f[:,[1,2]],f[:,[2,0]])),axis=1)
    edges,counts=np.unique(edges,axis=0,return_counts=True);edges=edges[counts==1]
    markers=[]
    for direction,a,b in (('originalToCandidate',source,target),('candidateToOriginal',target,source)):
        evidence=_trace(a,b,limit,deadline)
        cp=evidence['targetPoint'] if direction=='originalToCandidate' else evidence['sourcePoint']
        hp=evidence['sourcePoint'] if direction=='originalToCandidate' else evidence['targetPoint']
        _,_,ids=_closest(np.asarray([cp]),v[edges],deadline);edge=edges[int(ids[0])]
        adjacent=np.flatnonzero(np.sum(np.isin(f,edge),axis=1)==2)
        markers.append({'kind':'boundary','direction':direction,'classification':evidence['classification'],
                        'candidateEdgeVertexIds':edge.tolist(),'candidateEdgePositions':v[edge].tolist(),
                        'adjacentFaceIds':adjacent.tolist(),'faceIds':adjacent.tolist(),
                        'candidatePoint':cp,'originalPoint':hp,'limitMeters':limit,
                        'distanceMeters':evidence['sampledMaximumMeters'],
                        'certifiedBracketMeters':[evidence['sampledMaximumMeters'],evidence['certifiedUpperMeters']],
                        'evidence':evidence})
    return {'meshHash':mesh_hash(v,f),'faceCount':len(f),'coordinateSpace':'world geometry meters; zero based IDs',
            'method':'bounded exact point-to-segment samples plus1-Lipschitz certificate',
            'extentPolicy':'worst observed region; not an exhaustive defect extent','markers':markers}


def _split(v,f,face_id,edge,point):
    tri=f[face_id]
    oriented=next(((int(tri[i]),int(tri[(i+1)%3]),int(tri[(i+2)%3])) for i in range(3)
                   if set((int(tri[i]),int(tri[(i+1)%3])))==set(edge)),None)
    if oriented is None:raise ValueError('Localized edge does not belong to patch face')
    a,b,c=oriented;n=len(v);new=np.array([[a,n,c],[n,b,c]],np.int64)
    nv=np.concatenate((v,[np.asarray(point,np.float32).astype(float)]))
    nf=np.concatenate((np.delete(f,face_id,axis=0),new))
    mapping={'removedFaceId':int(face_id),'removedFaceVertices':tri.tolist(),
             'newFaceIds':[len(nf)-2,len(nf)-1],'newFaces':new.tolist(),'newVertexId':n,
             'fixedInternalInterfaceEdges':[[a,c],[c,b]],
             'outsideFaceMap':'old i<removed stays i; old i>removed becomes i-1',
             'restoreBefore':'remove last vertex and last two faces; insert removedFaceVertices at removedFaceId'}
    return nv,nf,mapping


def repair_boundary_certificate(candidate, high, boundary, census, hard_cap, deadline, progress=None):
    from native3d_lod_source import _canonical_mesh,_Reference,_sample
    from native3d_lod_local import SourceQuality
    started=time.monotonic();v=np.asarray(candidate.vertices);f=np.asarray(candidate.faces)
    receipt={'profile':'local-boundary-retopology-v1','algorithm':'traditional local boundary retopology; not AI',
             'status':'blocked','beforeMeshHash':mesh_hash(v,f),'beforeGeometry':census,'beforeTriangles':len(f),
             'hardCap':hard_cap,'maximumCandidates':2,'fractions':[.25,.375],'candidates':[],
             'sourceHighMeshHash':mesh_hash(high.vertices,high.faces),'originalReferenceMeshHash':boundary.mesh_hash}
    result=candidate
    try:
        _check(deadline)
        if type(hard_cap) is not int or len(f)+1>hard_cap:
            raise ValueError('Local boundary split needs one triangle within unchanged effective hard cap')
        if census.get('mesh_hash')!=receipt['beforeMeshHash'] or census.get('status')!='accepted' or not census.get('intersectionComplete') or census.get('intersection_pairs_count')!=0:
            raise ValueError('Local boundary retopology needs bound complete zero-intersection geometry')
        location=locate_boundary_issue(v,f,boundary,min(deadline,time.monotonic()+120));receipt['localization']=location
        markers=location['markers']
        if any(m['classification']=='confirmed_issue' for m in markers):
            raise ValueError('Measured boundary exceedance is not a certificate-only local repair')
        uncertain=[m for m in markers if m['classification']=='certification_incomplete']
        if not uncertain or len({tuple(m['candidateEdgeVertexIds']) for m in uncertain})!=1:
            raise ValueError('Uncertain boundary does not localize to one edge')
        marker=max(uncertain,key=lambda x:x['distanceMeters']);edge=marker['candidateEdgeVertexIds']
        if len(marker['adjacentFaceIds'])!=1:raise ValueError('Boundary edge does not have one adjacent face')
        face_id=marker['adjacentFaceIds'][0];oldtri=f[face_id];point=np.asarray(marker['candidatePoint'])
        delta=np.asarray(marker['originalPoint'])-point
        ab=v[edge[1]]-v[edge[0]];t=float(np.dot(point-v[edge[0]],ab)/np.dot(ab,ab))
        if not 1e-6<t<1-1e-6:raise ValueError('Localized point is not inside boundary edge')
        # Exact parent-face barycentric correspondence bounds surface deformation.
        quality=SourceQuality(high,boundary.diagonal,lambda:_check(deadline))
        oldref=_Reference(v,f[[face_id]]);oldpoints,oldnormals=_sample(v,f[[face_id]],4096,923)
        for fraction in (.25,.375):
            trial_deadline=min(deadline,time.monotonic()+120)
            def check():_check(trial_deadline)
            check();row={'fraction':fraction,'status':'blocked'};receipt['candidates'].append(row)
            nv,nf,mapping=_split(v,f,face_id,edge,point+fraction*delta)
            displacement=float(np.linalg.norm(nv[-1]-point))
            row.update(patchMap=mapping,analyticLocalHausdorffUpperMeters=displacement,newVertexPosition=nv[-1].tolist())
            if displacement>boundary.diagonal*.002:row['blocker']='local deformation exceeds .002D';continue
            trial=_canonical_mesh(nv,nf);nv,nf=np.asarray(trial.vertices),np.asarray(trial.faces)
            if not np.array_equal(nv[:-1],v) or not np.array_equal(nf[:-2],np.delete(f,face_id,axis=0)):
                raise ValueError('Local split mutated fixed geometry')
            row.update(allOldVerticesExact=True,outsideFacesExact=True,afterMeshHash=mesh_hash(nv,nf),triangles=len(nf))
            new=nf[-2:];points,normals=_sample(nv,new,4096,923)
            forward=oldref.compare(points,normals,boundary.diagonal);backward=_Reference(nv,new).compare(oldpoints,oldnormals,boundary.diagonal)
            row['localFidelity']={'newToOld':forward,'oldToNew':backward,'accepted':max(forward['sampledMaxDistanceFraction'],backward['sampledMaxDistanceFraction'])<=.002}
            check();row['geometry']=audit_geometry(nv,nf,allow_boundaries=True,collect_all_intersections=True,max_seconds=min(60.,trial_deadline-time.monotonic()))
            try:row['boundaryPreservation']=boundary.compare(nv,nf)
            except ValueError as error:row['boundaryPreservation']={'accepted':False,'blocker':str(error)}
            check();quality.check=check
            # Both children derive from this one real parent triangle, rather
            # than arbitrary index matching of unrelated retessellated faces.
            eligible,normal=quality.candidate(nv,new,v,np.tile(oldtri,(2,1)),np.array([0,1]))
            row['sourceNormalQuality']={'accepted':eligible,'receipt':normal,
                                       'correspondence':'each split child to the same actual parent triangle'}
            before,_=quality.smooth(v,f[[face_id]]);xyz=v[oldtri]
            oldarea=float(np.linalg.norm(np.cross(xyz[1]-xyz[0],xyz[2]-xyz[0]))*.5)
            row['sourceNormalQuality'].update(oldStrongOpposedAreaOnce=oldarea*before['strongOppositeFraction'],
                newStrongOpposedArea=sum(x['new']['stronglyOpposedArea'] for x in normal['changedFaces']))
            # A split must not count the same parent's area allowance twice.
            # Keep this new profile conservative even when both child faces
            # individually fall below the parent's opposed-area value.
            if row['sourceNormalQuality']['newStrongOpposedArea']>row['sourceNormalQuality']['oldStrongOpposedAreaOnce']:
                eligible=False;row['sourceNormalQuality'].update(accepted=False,blocker='split increased total strongly opposed area')
            check();found=quality.reference.scene.compute_closest_points(
                quality.reference.o3d.core.Tensor(np.asarray([nv[-1]],np.float32)))
            closest=found['points'].numpy()[0]
            row['newVertexDistanceToOriginalHighSurfaceMeters']=float(np.linalg.norm(nv[-1]-closest))
            row['newVertexDistanceToMarkedOriginalBoundaryMeters']=float(np.linalg.norm(nv[-1]-np.asarray(marker['originalPoint'])))
            check();points,normals=_sample(nv,nf,4096,7321);forward=quality.reference.compare(points,normals,boundary.diagonal)
            check();points,normals=_sample(high.vertices,high.faces,4096,7321);backward=_Reference(nv,nf).compare(points,normals,boundary.diagonal)
            row['fidelity']={'childToSource':forward,'sourceToChild':backward,'accepted':all(x['distanceP95Fraction']<=.005 and x['sampledMaxDistanceFraction']<=.02 and x['oppositeNormalFraction']<=.25 for x in (forward,backward))}
            check();g=row['geometry']
            if g['status']=='accepted' and g['intersectionComplete'] and g['intersection_pairs_count']==0 and g['componentCount']==census['componentCount'] and g['signedVolume']*census['signedVolume']>=0 and row['boundaryPreservation']['accepted'] and row['localFidelity']['accepted'] and eligible and row['fidelity']['accepted']:
                row['status']='complete';result=trial;receipt.update(status='complete',afterMeshHash=row['afterMeshHash'],selectedCandidate=len(receipt['candidates'])-1);break
            row['blocker']='unchanged local/source-normal/boundary/full geometry/fidelity gate failed'
        if receipt['status']!='complete':receipt['blocker']='bounded local boundary candidates exhausted'
    except (ValueError,RuntimeError) as error:receipt['blocker']=str(error)
    receipt['wallSeconds']=time.monotonic()-started
    return result,receipt


def repair_boundary_measured(candidate, high, boundary, census, hard_cap, deadline, progress=None, *, max_patches=4, displacement_fraction=.002, correction_fraction=.375):
    from native3d_lod_source import _canonical_mesh,_Reference,_sample
    from native3d_lod_local import SourceQuality
    if type(max_patches) is not int or not 1<=max_patches<=4 or type(displacement_fraction) not in (int,float) or not .0001<=displacement_fraction<=.01 or type(correction_fraction) not in (int,float) or not .1<=correction_fraction<=1:
        raise ValueError('Invalid bounded manual repair settings')
    started=time.monotonic();deadline=min(deadline,started+180);v=np.asarray(candidate.vertices);f=np.asarray(candidate.faces)
    original_v=v.copy();original_f=f.copy();lineage=np.arange(len(f));used=set()
    receipt={'profile':'local-boundary-measured-v1','algorithm':'traditional local boundary retopology; not AI',
             'status':'blocked','beforeMeshHash':mesh_hash(v,f),'beforeGeometry':census,'beforeTriangles':len(f),
             'hardCap':hard_cap,'maximumCandidates':max_patches,'maximumOriginalFacePatches':max_patches,'sharedSeconds':180,
             'localDisplacementLimitFraction':displacement_fraction,'localFidelityLimitFraction':.002,'fractions':[correction_fraction],'candidates':[],
             'sourceHighMeshHash':mesh_hash(high.vertices,high.faces),'originalReferenceMeshHash':boundary.mesh_hash}
    result=candidate
    try:
        _check(deadline)
        if type(hard_cap) is not int or len(f)+1>hard_cap:
            raise ValueError('Local boundary split needs one triangle within unchanged effective hard cap')
        if census.get('mesh_hash')!=receipt['beforeMeshHash'] or census.get('status')!='accepted' or not census.get('intersectionComplete') or census.get('intersection_pairs_count')!=0:
            raise ValueError('Local boundary retopology needs bound complete zero-intersection geometry')
        location=locate_boundary_issue(v,f,boundary,min(deadline,time.monotonic()+120));receipt['localization']=location
        quality=SourceQuality(high,boundary.diagonal,lambda:_check(deadline))
        for patch_index in range(max_patches):
            _check(deadline)
            if len(f)+1>hard_cap:raise ValueError('Local boundary split exceeds unchanged effective hard cap')
            markers=[m for m in location['markers'] if m['classification']!='certified']
            if not markers:raise ValueError('No localized boundary issue to repair')
            marker=max(markers,key=lambda x:x['distanceMeters']);edge=marker['candidateEdgeVertexIds']
            if len(marker['adjacentFaceIds'])!=1:raise ValueError('Boundary edge does not have one adjacent face')
            face_id=marker['adjacentFaceIds'][0];original_face=int(lineage[face_id])
            if original_face<0 or original_face in used:raise ValueError('Local patch would repeat an already modified original face')
            oldtri=f[face_id];point=np.asarray(marker['candidatePoint'])
            delta=np.asarray(marker['originalPoint'])-point
            ab=v[edge[1]]-v[edge[0]];t=float(np.dot(point-v[edge[0]],ab)/np.dot(ab,ab))
            if not 1e-6<t<1-1e-6:raise ValueError('Localized point is not inside boundary edge')
            oldref=_Reference(v,f[[face_id]]);oldpoints,oldnormals=_sample(v,f[[face_id]],4096,923)
            fraction=correction_fraction
            trial_deadline=min(deadline,time.monotonic()+120)
            def check():_check(trial_deadline)
            check();row={'fraction':fraction,'status':'blocked','originalFaceId':original_face,'marker':marker};receipt['candidates'].append(row)
            nv,nf,mapping=_split(v,f,face_id,edge,point+fraction*delta)
            displacement=float(np.linalg.norm(nv[-1]-point))
            row.update(patchMap=mapping,analyticLocalHausdorffUpperMeters=displacement,newVertexPosition=nv[-1].tolist())
            if displacement>boundary.diagonal*displacement_fraction:raise ValueError('Local deformation exceeds configured displacement cap')
            trial=_canonical_mesh(nv,nf);nv,nf=np.asarray(trial.vertices),np.asarray(trial.faces)
            if not np.array_equal(nv[:-1],v) or not np.array_equal(nf[:-2],np.delete(f,face_id,axis=0)):
                raise ValueError('Local split mutated fixed geometry')
            row.update(allOldVerticesExact=True,outsideFacesExact=True,afterMeshHash=mesh_hash(nv,nf),triangles=len(nf))
            new=nf[-2:];points,normals=_sample(nv,new,4096,923)
            forward=oldref.compare(points,normals,boundary.diagonal);backward=_Reference(nv,new).compare(oldpoints,oldnormals,boundary.diagonal)
            row['localFidelity']={'newToOld':forward,'oldToNew':backward,'accepted':max(forward['sampledMaxDistanceFraction'],backward['sampledMaxDistanceFraction'])<=.002}
            check();row['geometry']=audit_geometry(nv,nf,allow_boundaries=True,collect_all_intersections=True,max_seconds=min(60.,trial_deadline-time.monotonic()))
            try:row['boundaryPreservation']=boundary.compare(nv,nf)
            except ValueError as error:row['boundaryPreservation']={'accepted':False,'blocker':str(error)}
            check();quality.check=check
            # Both children derive from this one real parent triangle, rather
            # than arbitrary index matching of unrelated retessellated faces.
            eligible,normal=quality.candidate(nv,new,v,np.tile(oldtri,(2,1)),np.array([0,1]))
            row['sourceNormalQuality']={'accepted':eligible,'receipt':normal,
                                       'correspondence':'each split child to the same actual parent triangle'}
            before,_=quality.smooth(v,f[[face_id]]);xyz=v[oldtri]
            oldarea=float(np.linalg.norm(np.cross(xyz[1]-xyz[0],xyz[2]-xyz[0]))*.5)
            row['sourceNormalQuality'].update(oldStrongOpposedAreaOnce=oldarea*before['strongOppositeFraction'],
                newStrongOpposedArea=sum(x['new']['stronglyOpposedArea'] for x in normal['changedFaces']))
            # A split must not count the same parent's area allowance twice.
            # Keep this new profile conservative even when both child faces
            # individually fall below the parent's opposed-area value.
            if row['sourceNormalQuality']['newStrongOpposedArea']>row['sourceNormalQuality']['oldStrongOpposedAreaOnce']:
                eligible=False;row['sourceNormalQuality'].update(accepted=False,blocker='split increased total strongly opposed area')
            check();found=quality.reference.scene.compute_closest_points(
                quality.reference.o3d.core.Tensor(np.asarray([nv[-1]],np.float32)))
            closest=found['points'].numpy()[0]
            row['newVertexDistanceToOriginalHighSurfaceMeters']=float(np.linalg.norm(nv[-1]-closest))
            row['newVertexDistanceToMarkedOriginalBoundaryMeters']=float(np.linalg.norm(nv[-1]-np.asarray(marker['originalPoint'])))
            check();points,normals=_sample(nv,nf,4096,7321);forward=quality.reference.compare(points,normals,boundary.diagonal)
            check();points,normals=_sample(high.vertices,high.faces,4096,7321);backward=_Reference(nv,nf).compare(points,normals,boundary.diagonal)
            row['fidelity']={'childToSource':forward,'sourceToChild':backward,'accepted':all(x['distanceP95Fraction']<=.005 and x['sampledMaxDistanceFraction']<=.02 and x['oppositeNormalFraction']<=.25 for x in (forward,backward))}
            check();g=row['geometry']
            if g['status']=='accepted' and g['intersectionComplete'] and g['intersection_pairs_count']==0 and g['componentCount']==census['componentCount'] and g['signedVolume']*census['signedVolume']>=0 and row['localFidelity']['accepted'] and eligible and row['fidelity']['accepted']:
                used.add(original_face);lineage=np.concatenate((np.delete(lineage,face_id),[-1,-1]))
                untouched=lineage>=0
                if not np.array_equal(nv[:len(original_v)],original_v) or not np.array_equal(nf[untouched],original_f[lineage[untouched]]):
                    raise ValueError('Local sequence changed unaffected original geometry')
                row.update(allOriginalVerticesExact=True,unmodifiedOriginalFacesExact=True)
                if row['boundaryPreservation']['accepted']:
                    row['status']='complete';result=trial;receipt.update(status='complete',afterMeshHash=row['afterMeshHash'],selectedCandidate=len(receipt['candidates'])-1);break
                next_location=locate_boundary_issue(nv,nf,boundary,deadline)
                before=max(m['distanceMeters'] for m in location['markers']);after=max(m['distanceMeters'] for m in next_location['markers'])
                row.update(remainingLocalization=next_location,previousWorstDistanceMeters=before,remainingWorstDistanceMeters=after,status='intermediate_only')
                if after>=before-1e-9:raise ValueError('Local sequence did not improve worst measured boundary distance')
                v,f=nv,nf;location=next_location
            else:
                raise ValueError('Unchanged local/source-normal/full geometry/fidelity gate failed')
        if receipt['status']!='complete':receipt['blocker']='bounded local boundary candidates exhausted'
    except (ValueError,RuntimeError) as error:receipt['blocker']=str(error)
    receipt['wallSeconds']=time.monotonic()-started
    return result,receipt
