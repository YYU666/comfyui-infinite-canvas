"""Immutable single logical LOD retry with seeded QEM input ordering."""
import copy
import hashlib
import json
import math
import re
import time
from pathlib import Path


def validate_retry_context(manager, job):
    from native3d_jobs import accepted_source_lod_stage, fail
    params=job['parameters']; prior=manager.jobs.get(params['retryJobId'])
    def reject(message):
        fail(message,409,'LOD_RETRY_STALE')
    if not prior or prior.get('projectId')!=job['projectId'] or prior.get('operation')!='source_lod' or prior.get('status')!='succeeded':
        reject('Retry requires a completed same-project source LOD job')
    geometry=prior.get('result',{}).get('metadata',{}).get('geometry',{})
    level=int(params['retryStage'][3:]); parent='lod'+str(level-1)
    records=[r for r in geometry.get('stages',[]) if r.get('stage')==parent]
    if len(records)!=1 or not accepted_source_lod_stage(records[0]):
        reject('Retry requires an individually accepted direct parent LOD')
    record=records[0]; filename=record.get('filename','')
    if Path(filename).name!=filename or not filename.endswith('.glb'):
        reject('Parent canonical filename invalid')
    file=manager._safe_file(prior['id'],filename)
    hasher = hashlib.sha256()
    with file.open('rb') as stream:
        while chunk := stream.read(1024 * 1024):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    if digest!=record.get('file_sha256') or digest!=job['source']['sha256']:
        reject('Retry source must exactly match accepted parent file hash')
    # The exact accepted GLB is now bound to the job. The worker independently
    # verifies its decoded geometry hash in the mesh runtime before running QEM.
    if not re.fullmatch(r'[0-9a-f]{64}', str(record.get('mesh_hash') or '')):
        reject('Parent mesh hash missing or invalid')
    original_sha=geometry.get('retry',{}).get('originalSourceSha256') or geometry.get('sourceFileSha256')
    if not original_sha or job['source'].get('highSha256')!=original_sha:
        reject('Retry requires the exact original high source identity')
    lod0=next((r for r in geometry.get('logicalLevels',[]) if r.get('lodLevel')==0),None)
    lod0_faces=(lod0 or {}).get('triangles') or geometry.get('retry',{}).get('lod0Triangles') or geometry.get('localRepair',{}).get('lod0Triangles')
    if type(lod0_faces) is not int or lod0_faces<4 or not geometry.get('settings'):
        reject('Original LOD0 count/settings unavailable')
    if prior.get('parameters',{}).get('seed')==params['seed']:
        reject('Retry seed must differ from previous attempt')
    return {'retryJobId':prior['id'],'retryStage':params['retryStage'],'parentStage':parent,
            'parentMeshHash':record['mesh_hash'],'parentFileSha256':digest,
            'originalSourceSha256':original_sha,'lod0Triangles':lod0_faces,
            'settings':copy.deepcopy(geometry['settings'])}


def seeded_order(vertices, faces, seed):
    import numpy as np

    if type(seed) is not int or not 0<=seed<=4294967295:
        raise ValueError('seed must be uint32')
    rng=np.random.Generator(np.random.PCG64(seed))
    order=rng.permutation(len(vertices)); face_order=rng.permutation(len(faces))
    inverse=np.empty(len(order),dtype=np.int64); inverse[order]=np.arange(len(order))
    v=np.asarray(vertices)[order].copy(); f=inverse[np.asarray(faces)[face_order]].copy()
    if not np.array_equal(v[f],np.asarray(vertices)[np.asarray(faces)[face_order]]):
        raise ValueError('Seed ordering altered triangle coordinates')
    receipt={'strategy':'PCG64 vertex and face traversal permutation before QEM; no coordinate perturbation',
             'seed':seed,'permutationSha256':hashlib.sha256(order.astype('<i8').tobytes()+face_order.astype('<i8').tobytes()).hexdigest(),
             'allTriangleCoordinatesExact':True}
    return v,f,receipt


def resolve_retry_target(params, context, source_faces, parent_faces):
    """Only the no-default retry field expresses an explicit target override.

    Public lodNKeepPercent fields are default-filled before reaching the worker
    and must never be interpreted as explicit changes to frozen retry settings.
    """
    from native3d_lod_source import logical_target

    stage=params.get('retryStage')
    if stage not in ('lod1','lod2','lod3','lod4') or not params.get('retryJobId') or 'seed' not in params:
        raise ValueError('Retry target requires complete retry context')
    level=int(stage[3:]);settings=copy.deepcopy(context['settings']);settings['selectedLodLevel']=level
    previous=logical_target(level,source_faces,context['lod0Triangles'],parent_faces,settings)
    explicit='retryKeepPercent' in params
    if explicit:
        value=params['retryKeepPercent']
        if type(value) not in (int,float) or not math.isfinite(value) or not .001<=value<=100:
            raise ValueError('retryKeepPercent must be a finite number within0.001..100')
        settings['lodKeepPercents'][level]=float(value)
    plan=logical_target(level,source_faces,context['lod0Triangles'],parent_faces,settings)
    policy={'mode':'explicit_single_stage_override' if explicit else 'frozen_single_stage_target',
            'parameter':'retryKeepPercent' if explicit else None,'retryStage':stage,
            'percentageReference':plan['percentageReference'],'percentageBaseTriangles':plan['percentageBaseTriangles'],
            'previousKeepPercent':previous['requestedKeepPercent'],'requestedKeepPercent':plan['requestedKeepPercent'],
            'previousEffectiveTargetTriangles':previous['effectiveTargetTriangles'],
            'percentageTargetTriangles':plan['percentageTargetTriangles'],'effectiveTargetTriangles':plan['effectiveTargetTriangles'],
            'frozenFaceCap':plan['faceCap'],'budgetClampedPercentage':plan['budgetClampedPercentage'],
            'parentTriangleLimit':parent_faces,'otherStagesUnchanged':True,
            'automaticRatioSearch':False,'acceptancePolicy':'existing effective target remains the bound; no automatic cap relaxation'}
    return settings,plan,policy


def run_retry(parent, high, output, params, context, progress=None):
    import numpy as np
    import open3d as o3d
    from native3d_geometry import mesh_hash
    from native3d_geometry_audit import audit_geometry, require_audited
    from native3d_lod_source import _canonical_mesh, _save_mesh, _Reference, _sample

    start=time.monotonic(); deadline=start+900; folder=Path(output); folder.mkdir(parents=True,exist_ok=True)
    level=int(params['retryStage'][3:]); stage=params['retryStage']; seed=params['seed']
    if not 1<=level<=4 or context['parentStage']!='lod'+str(level-1) or context['retryStage']!=stage or context['retryJobId']!=params['retryJobId'] or mesh_hash(parent.vertices,parent.faces)!=context['parentMeshHash']:
        raise ValueError('Retry frozen lineage mismatch')
    settings,plan,target_policy=resolve_retry_target(params,context,len(high.faces),len(parent.faces))
    target=plan['effectiveTargetTriangles']; candidate=None; artifacts=[]
    manifest={'status':'blocked','mode':'source_high','backend':'open3d','backendVersion':o3d.__version__,
              'algorithm':'CPU open3d QEM seeded traversal; not AI','settings':settings,
              'sourceFileSha256':context['originalSourceSha256'],'sourceTriangles':len(high.faces),
              'source_mesh_hash':mesh_hash(high.vertices,high.faces),'retry':{**context,'seed':seed},
              'selectedLodLevel':level,'chainComplete':False,'chainStatus':'blocked',
              'acceptanceScope':'single_retried_logical_stage','stages':[],'logicalLevels':[],
              'open3dParameters':{'boundary_weight':1e12},'targetPolicy':target_policy,
              'sourceUnchanged':True,'attributePolicy':'geometry_only_requires_uv_and_bake'}
    entry={'stage':stage,'lodLevel':level,'parentStage':context['parentStage'],
           'parent_mesh_hash':context['parentMeshHash'],'visible':True,'eligibleForDownstream':False,
           'status':'blocked','filename':stage+'.glb','plan':plan,'receipt':{'seed':seed,'traversals':[]}}
    manifest['stages'].append(entry)
    def audit(v,f):
        remaining=deadline-time.monotonic()
        if remaining<=0:raise ValueError('Retry wall budget exhausted')
        return audit_geometry(v,f,max_seconds=min(120,remaining),allow_boundaries=bool(parent_audit.get('boundary_edges')),collect_all_intersections=True)
    parent_audit= audit_geometry(parent.vertices,parent.faces,max_seconds=120,allow_boundaries=True)
    require_audited(parent_audit)
    boundary_reference=None
    if parent_audit.get('boundary_edges'):
        from native3d_lod_boundary import OriginalBoundaryReference
        from native3d_lod_source import normalize_source_geometry
        original_v,original_f,_=normalize_source_geometry(high.vertices,high.faces)
        boundary_reference=OriginalBoundaryReference(original_v,original_f)
        boundary_reference.compare(parent.vertices,parent.faces)
    def check():
        if time.monotonic()>=deadline:raise ValueError('Retry wall budget exhausted')
    def validate_candidate(candidate):
        check()
        if len(candidate.faces)>target:raise ValueError('Retry candidate exceeds effective target')
        report=audit(candidate.vertices,candidate.faces);entry['receipt']['geometry']=report
        require_audited(report)
        if boundary_reference is not None:
            entry['receipt']['boundaryPreservation']=boundary_reference.compare(candidate.vertices,candidate.faces)
        boundary_changed=boundary_reference is None and report['boundaryPositionHash']!=parent_audit['boundaryPositionHash']
        if boundary_changed or report['componentCount']!=parent_audit['componentCount'] or report['signedVolume']*parent_audit['signedVolume']<0:
            raise ValueError('Retry changed boundary/components/orientation')
        diagonal=float(np.linalg.norm(np.ptp(high.vertices,axis=0)))
        if diagonal<=0:raise ValueError('High source extent invalid')
        points,normals=_sample(candidate.vertices,candidate.faces,4096,7321)
        forward=_Reference(high.vertices,high.faces).compare(points,normals,diagonal)
        points,normals=_sample(high.vertices,high.faces,4096,7321)
        backward=_Reference(candidate.vertices,candidate.faces).compare(points,normals,diagonal)
        fidelity={'method':'bidirectional original-high surface samples','seed':7321,'childToSource':forward,'sourceToChild':backward,
                  'p95LimitFraction':.005,'sampledMaxLimitFraction':.02,'oppositeNormalFractionLimit':.25}
        fidelity['accepted']=all(r['distanceP95Fraction']<=.005 and r['sampledMaxDistanceFraction']<=.02 and r['oppositeNormalFraction']<=.25 for r in (forward,backward))
        entry['receipt']['fidelity']=fidelity
        if not fidelity['accepted']:raise ValueError('Retry original-high fidelity gate failed')
        check()
    v,f=np.asarray(parent.vertices),np.asarray(parent.faces)
    try:
        passes=0
        while len(f)>target:
            check();passes+=1
            if passes>32:raise ValueError('Retry pass budget exhausted')
            if progress:progress('source_lod_retry_'+stage,10+min(60,passes*10))
            v,f,ordering=seeded_order(v,f,(seed+passes-1)%4294967296)
            entry['receipt']['traversals'].append(ordering)
            before=len(f);requested=max(target,int(math.ceil(before*.5)))
            # Seeded first-pass budget changes QEM recomputation history on
            # meshes whose strictly ordered collapse costs ignore traversal.
            # This never moves input positions or changes the final target.
            if passes==1 and before-target>=8:
                fraction=float(np.random.Generator(np.random.PCG64(seed)).uniform(.55,.9))
                requested=max(requested,min(before-2,int(math.ceil(before*fraction))))
            ordering.update(requestedTriangles=requested,parentTriangles=before,
                            budgetStrategy='seeded first-pass keep fraction [0.55,0.9); subsequent bounded target QEM')
            reduced=o3d.geometry.TriangleMesh(o3d.utility.Vector3dVector(v),o3d.utility.Vector3iVector(f)).simplify_quadric_decimation(requested,boundary_weight=1e12)
            candidate=_canonical_mesh(np.asarray(reduced.vertices),np.asarray(reduced.triangles))
            if not max(1,math.ceil(before*.5)-1)<=len(candidate.faces)<=requested or len(candidate.faces)>=before:
                raise ValueError('Retry QEM violated bounded reduction or stalled')
            v,f=np.asarray(candidate.vertices),np.asarray(candidate.faces)
        candidate=candidate if candidate is not None else _canonical_mesh(v,f)
        validate_candidate(candidate)
        entry.update(status='accepted',eligibleForDownstream=True)
        manifest.update(status='accepted',chainStatus='accepted',selectedStage=stage,
                        returnedMeshRole='accepted_selected_logical_level')
    except (ValueError, RuntimeError) as error:
        from native3d_lod_protected import child_runtime_available, solve_child
        first_error=str(error)
        fallback={'attempted':False,'originalBlocker':first_error}
        entry['receipt']['childFallback']=fallback
        if child_runtime_available() and time.monotonic()<deadline:
            fallback.update(attempted=True,maximumAttempts=1,sharedDeadlineSeconds=900,
                            originalAttempt=copy.deepcopy({k:v for k,v in entry['receipt'].items() if k!='childFallback'}))
            if candidate is not None:
                first_path=folder/('blocked_open3d_'+stage+'.glb')
                first_sha=_save_mesh(candidate,first_path)
                fallback['originalArtifact']={'filename':first_path.name,'fileSha256':first_sha,
                                              'meshHash':mesh_hash(candidate.vertices,candidate.faces),'diagnostic':True}
            following,child_receipt=solve_child(parent,high,target,seed,deadline,progress)
            fallback['receipt']=child_receipt
            if following is not None:
                candidate=_canonical_mesh(following.vertices,following.faces)
                manifest.update(backend='pymeshlab',backendVersion=child_receipt.get('runtime',{}).get('version'),
                                algorithm=child_receipt.get('algorithm','PyMeshLab quadric edge collapse; not AI'))
                # Do not attach the rejected Open3D mesh's audit to another mesh.
                for key in ('geometry','boundaryPreservation','fidelity'):entry['receipt'].pop(key,None)
                for key in ('geometry','boundaryPreservation','fidelity'):
                    if key in child_receipt:entry['receipt'][key]=child_receipt[key]
            if child_receipt['status']=='complete' and following is not None:
                try:
                    # Recheck the helper's canonical result at the export boundary.
                    validate_candidate(candidate)
                    entry.update(status='accepted',eligibleForDownstream=True)
                    manifest.update(status='accepted',chainStatus='accepted',selectedStage=stage,
                                    returnedMeshRole='accepted_selected_logical_level',backend='pymeshlab',
                                    backendVersion=child_receipt['runtime']['version'],algorithm=child_receipt['algorithm'])
                except ValueError as final_error:
                    fallback['finalValidationBlocker']=str(final_error)
            if entry['status']!='accepted':first_error=fallback.get('finalValidationBlocker') or child_receipt.get('blocker') or first_error
        else:fallback['skipReason']='optional runtime disabled/unavailable or shared deadline exhausted'
        if entry['status']!='accepted':
            if candidate is None:raise ValueError(first_error) from error
            entry['filename']=None
            manifest.update(blocker=first_error,chainBlocker=first_error,returnedMeshRole='blocked_diagnostic_candidate',returnedDiagnosticStage=stage)
    entry['mesh_hash']=mesh_hash(candidate.vertices,candidate.faces)
    entry['receipt'].update(actual_triangles=len(candidate.faces),parentTriangles=len(parent.faces),reductionPerformed=len(candidate.faces)<len(parent.faces))
    path=folder/(stage+'.glb' if entry['status']=='accepted' else 'blocked_'+stage+'.glb')
    digest=_save_mesh(candidate,path)
    if entry['status']=='accepted':
        entry['file_sha256']=digest;manifest.update(selectedMeshHash=entry['mesh_hash'],selectedLod=len(candidate.faces))
        manifest['logicalLevels'].append({'lodLevel':level,'stage':stage,'filename':path.name,'triangles':len(candidate.faces),'mesh_hash':entry['mesh_hash'],'plan':plan})
    else:
        entry.update(diagnosticFilename=path.name,diagnosticFileSha256=digest)
        manifest['returnedDiagnosticMeshHash']=entry['mesh_hash']
    artifacts.append({'path':str(path),'role':'export','diagnostic':entry['status']!='accepted'})
    fallback=entry['receipt'].get('childFallback',{})
    if fallback.get('originalArtifact'):
        artifacts.append({'path':str(folder/fallback['originalArtifact']['filename']),'role':'export','diagnostic':True})
    manifest['wallSeconds']=time.monotonic()-start
    with (folder/'source-lod-report.json').open('x',encoding='utf-8') as stream:json.dump(manifest,stream,indent=2,allow_nan=False)
    return candidate,manifest,artifacts
