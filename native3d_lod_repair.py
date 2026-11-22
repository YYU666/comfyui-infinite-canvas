"""Explicit bounded repair of a frozen final diagnostic; never rerun QEM."""
import copy
import hashlib
import json
import time
from pathlib import Path

from native3d_geometry import mesh_hash


def freeze_repair_context(manager, job, directory):
    from native3d_jobs import fail
    def reject(message):
        fail(message, 409, 'LOD_REPAIR_STALE')
    params=job['parameters']; prior=manager.jobs.get(params['localRepairJobId'])
    if not prior or prior.get('projectId')!=job['projectId'] or prior.get('operation')!='source_lod' or prior.get('status')!='succeeded':
        reject('Local repair requires a completed same-project source LOD job')
    geometry=prior.get('result',{}).get('metadata',{}).get('geometry',{})
    stage=params['localRepairStage']; rows=[r for r in geometry.get('stages',[]) if r.get('stage')==stage]
    if len(rows)!=1:reject('Local repair requires one exact final stage')
    record=rows[0]; name='blocked_'+stage+'.glb'
    if record.get('status')!='blocked' or record.get('eligibleForDownstream') is not False or record.get('diagnosticFilename')!=name:
        reject('Local repair requires the final blocked diagnostic candidate')
    files=[f for f in prior.get('result',{}).get('files',[]) if f.get('name')==name and f.get('role')=='export']
    if len(files)!=1:reject('Final diagnostic export is not uniquely registered')
    source=manager.output_file(prior['id'],name)
    if source.stat().st_size>16*1024**2:reject('Local repair candidate exceeds 16 MiB budget')
    raw=source.read_bytes(); digest=hashlib.sha256(raw).hexdigest()
    if digest!=record.get('diagnosticFileSha256') or digest!=files[0].get('sha256'):
        reject('Final diagnostic file hash changed')
    audit=record.get('receipt',{}).get('geometry',{})
    if not record.get('mesh_hash') or audit.get('mesh_hash')!=record['mesh_hash']:
        reject('Final diagnostic geometry evidence identity mismatch')
    original=(geometry.get('localRepair',{}).get('originalSourceSha256') or geometry.get('retry',{}).get('originalSourceSha256') or geometry.get('sourceFileSha256'))
    if not original or job['source'].get('highSha256')!=original:
        reject('Local repair requires the exact original high source')
    if job['source'].get('sha256') not in (digest,original):
        reject('Local repair input must match exact diagnostic or original high')
    target=record.get('plan',{}).get('effectiveTargetTriangles')
    count=audit.get('triangles'); parent=record.get('receipt',{}).get('parentTriangles')
    parent=parent or geometry.get('targetPolicy',{}).get('parentTriangleLimit')
    explicit=record.get('plan',{}).get('faceCap')
    if type(target) is not int or type(count) is not int or not 1<=count<=100000 or type(parent) is not int or parent<=count:
        reject('Original target, candidate count or parent triangle bound unavailable')
    if explicit is not None and (type(explicit) is not int or explicit<=0):
        reject('Original explicit face cap invalid')
    repair_settings={key:params.get(key,default) for key,default in (('localRepairMaxPatches',4),('localRepairDisplacementFraction',.002),('localRepairCorrectionFraction',.375))}
    cap=min(count+repair_settings['localRepairMaxPatches'],parent-1,explicit or 100000,100000)
    snapshot=Path(directory).resolve()/'local-repair-candidate.glb'
    with snapshot.open('xb') as stream:stream.write(raw)
    return {'localRepairJobId':prior['id'],'localRepairStage':stage,'candidatePath':str(snapshot),
            'candidateFileSha256':digest,'candidateMeshHash':record['mesh_hash'],
            'originalSourceSha256':original,'hardCap':cap,'repairSettings':repair_settings,'plan':copy.deepcopy(record['plan']),
            'targetPolicy':{'requestedTargetTriangles':target,'candidateTriangles':count,
                'maximumPatchGrowthTriangles':repair_settings['localRepairMaxPatches'],'frozenFaceCap':explicit,'parentTriangleLimit':parent,
                'effectiveRepairHardCap':cap,'policy':'manual local repair permits at most four added triangles; explicit cap and strict parent reduction remain mandatory'},
            'lod0Triangles':geometry.get('retry',{}).get('lod0Triangles') or geometry.get('localRepair',{}).get('lod0Triangles') or next((r.get('triangles') for r in geometry.get('logicalLevels',[]) if r.get('lodLevel')==0),None),
            'settings':copy.deepcopy(geometry.get('settings',{})),
            'inputRole':'blocked_candidate' if job['source']['sha256']==digest else 'original_high_with_frozen_candidate',
            'sourceUnchanged':True}


def run_local_repair(candidate, high, output, params, context, progress=None):
    from native3d_geometry_audit import audit_geometry
    from native3d_lod_boundary import OriginalBoundaryReference
    from native3d_lod_boundary_retopo import repair_boundary_measured, locate_boundary_issue
    from native3d_lod_source import normalize_source_geometry, _save_mesh, _prove_selected_result
    started=time.monotonic(); deadline=started+240
    stage=params['localRepairStage']; level=int(stage[3:]); folder=Path(output);folder.mkdir(parents=True,exist_ok=True)
    if (context['localRepairStage']!=stage or context['localRepairJobId']!=params['localRepairJobId'] or
            mesh_hash(candidate.vertices,candidate.faces)!=context['candidateMeshHash']):
        raise ValueError('Local repair frozen candidate lineage mismatch')
    if len(candidate.faces)>100000:raise ValueError('Local repair candidate triangle budget exceeded')
    repair_settings={key:params.get(key,default) for key,default in (('localRepairMaxPatches',4),('localRepairDisplacementFraction',.002),('localRepairCorrectionFraction',.375))}
    if context.get('repairSettings',repair_settings)!=repair_settings:raise ValueError('Frozen manual repair settings changed')
    if progress:progress('source_lod_local_repair_'+stage,12)
    census=audit_geometry(candidate.vertices,candidate.faces,allow_boundaries=True,collect_all_intersections=True,max_seconds=60)
    result=candidate; boundary=None
    try:
        v,f,_=normalize_source_geometry(high.vertices,high.faces)
        boundary=OriginalBoundaryReference(v,f)
        result,repair=repair_boundary_measured(candidate,high,boundary,census,context['hardCap'],deadline,progress,
            max_patches=repair_settings['localRepairMaxPatches'],displacement_fraction=repair_settings['localRepairDisplacementFraction'],
            correction_fraction=repair_settings['localRepairCorrectionFraction'])
    except (ValueError,RuntimeError) as error:
        repair={'status':'blocked','blocker':str(error),'profile':'local-boundary-measured-v1'}
    accepted=repair['status']=='complete'
    receipt={'localBoundaryRepair':repair,'geometry':census,'actual_triangles':len(result.faces),
             'parentTriangles':context.get('targetPolicy',{}).get('parentTriangleLimit')}
    if accepted:
        row=repair['candidates'][repair['selectedCandidate']]
        receipt.update({key:row[key] for key in ('geometry','fidelity','boundaryPreservation')})
    else:
        # Rejected intermediate trials are evidence only. The returned model is
        # exactly the original diagnostic, with markers bound to that model.
        result=candidate
        if boundary is not None and time.monotonic()<deadline:
            try:receipt['boundaryIssueMarkers']=locate_boundary_issue(candidate.vertices,candidate.faces,boundary,deadline)
            except (ValueError,RuntimeError) as error:receipt['localizationBlocker']=str(error)
    entry={'stage':stage,'lodLevel':level,'visible':True,'eligibleForDownstream':accepted,
           'status':'accepted' if accepted else 'blocked','plan':context['plan'],'receipt':receipt,
           'mesh_hash':mesh_hash(result.vertices,result.faces),'filename':stage+'.glb' if accepted else None}
    manifest={'status':entry['status'],'mode':'source_high','algorithm':'bounded traditional local boundary repair; no QEM',
              'settings':context['settings'],'sourceFileSha256':context['originalSourceSha256'],
              'source_mesh_hash':mesh_hash(high.vertices,high.faces),'sourceTriangles':len(high.faces),
              'localRepair':{k:v for k,v in context.items() if k!='candidatePath'},
              'selectedLodLevel':level,'chainComplete':False,'chainStatus':entry['status'],
              'sourceUnchanged':True,'stages':[entry],'logicalLevels':[],
              'acceptanceScope':'single_locally_repaired_stage','attributePolicy':'geometry_only_requires_uv_and_bake'}
    manifest['targetPolicy']=context.get('targetPolicy',{})
    if boundary is not None:manifest['boundaryReferenceMeshHash']=boundary.mesh_hash
    path=folder/(stage+'.glb' if accepted else 'blocked_'+stage+'.glb'); digest=_save_mesh(result,path)
    if accepted:
        entry['file_sha256']=digest
        manifest.update(selectedStage=stage,selectedMeshHash=entry['mesh_hash'],selectedLod=len(result.faces),returnedMeshRole='accepted_selected_logical_level')
        manifest['logicalLevels']=[{'lodLevel':level,'stage':stage,'filename':path.name,'triangles':len(result.faces),'mesh_hash':entry['mesh_hash'],'plan':context['plan']}]
        _prove_selected_result(result,manifest,folder)
    else:
        entry.update(diagnosticFilename=path.name,diagnosticFileSha256=digest)
        blocker='Local boundary repair blocked: '+repair.get('blocker','all original gates must pass')
        manifest.update(blocker=blocker,chainBlocker=blocker,returnedMeshRole='blocked_diagnostic_candidate',returnedDiagnosticStage=stage,returnedDiagnosticMeshHash=entry['mesh_hash'])
        manifest['nextAction']='Current candidate retained. Review marked boundary; use an explicitly revised LOD target or manual mesh editing.'
    manifest['wallSeconds']=time.monotonic()-started
    (folder/'source-lod-report.json').write_text(json.dumps(manifest,indent=2,allow_nan=False),encoding='utf-8')
    return result,manifest,[{'path':str(path),'role':'export','diagnostic':not accepted}]
