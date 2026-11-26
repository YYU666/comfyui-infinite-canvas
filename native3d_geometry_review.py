"""Explicit diagnostic-only continuation of a measured boundary deviation.

This grants execution permission; it never upgrades geometric quality.
"""
import hashlib

PROFILE='reviewed-boundary-deviation-v1'


def freeze_boundary_review(manager, project_id, source, params, operation=None):
    from native3d_jobs import fail
    def reject(message):fail(message,409,'GEOMETRY_REVIEW_STALE')
    job_id=params['reviewedBoundaryJobId'];stage=params['reviewedBoundaryStage']
    prior=manager.jobs.get(job_id)
    if not prior or prior.get('projectId')!=project_id or prior.get('operation')!='source_lod' or prior.get('status')!='succeeded':
        reject('Boundary review requires a completed same-project LOD job')
    geometry=prior.get('result',{}).get('metadata',{}).get('geometry',{})
    rows=[r for r in geometry.get('stages',[]) if r.get('stage')==stage]
    if len(rows)!=1:reject('Boundary review requires one canonical final stage')
    row=rows[0];name='blocked_'+stage+'.glb';audit=row.get('receipt',{}).get('geometry',{})
    if row.get('status')!='blocked' or row.get('eligibleForDownstream') is not False or row.get('diagnosticFilename')!=name:
        reject('Boundary review requires a blocked final diagnostic')
    if (audit.get('status')!='accepted' or audit.get('intersectionComplete') is not True or
            audit.get('intersection_pairs_count')!=0 or not row.get('mesh_hash') or audit.get('mesh_hash')!=row['mesh_hash']):
        reject('Boundary review cannot bypass invalid or incomplete geometry/intersection checks')
    blocker=geometry.get('blocker','')
    prefix='Original boundary distance exceeds independent shape budget:'
    # Original execution raises at this measured-distance gate. A final
    # fallback must independently identify the same final rejection category.
    fallback=row.get('receipt',{}).get('childFallback',{})
    final_blocker=fallback.get('receipt',{}).get('blocker') if fallback.get('attempted') else blocker
    if not blocker.startswith(prefix) or not isinstance(final_blocker,str) or not final_blocker.startswith(prefix):
        reject('Only a confirmed final boundary-distance deviation is reviewable')
    original=(geometry.get('retry',{}).get('originalSourceSha256') or geometry.get('sourceFileSha256'))
    alternate=(operation=='bake' and params.get('reviewedBoundaryBakeHighSha256')==source.get('highSha256') and bool(source.get('highSha256')))
    if not original or (source.get('highSha256')!=original and not alternate):reject('Reviewed original high identity changed; separate bake material high requires explicit hash binding')
    files=[f for f in prior.get('result',{}).get('files',[]) if f.get('name')==name and f.get('role')=='export']
    if len(files)!=1:reject('Reviewed diagnostic is not uniquely registered')
    path=manager.output_file(job_id,name)
    if path.stat().st_size>16*1024**2:reject('Reviewed candidate exceeds 16 MiB')
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    if digest!=row.get('diagnosticFileSha256') or digest!=files[0].get('sha256'):
        reject('Reviewed diagnostic file changed')
    receipt={'profile':PROFILE,'status':'experimental_reviewed','geometryStatus':'blocked',
             'reviewedBoundaryJobId':job_id,'reviewedBoundaryStage':stage,
             'diagnosticFileSha256':digest,'diagnosticMeshHash':row['mesh_hash'],
             'originalSourceSha256':original,'originalBlocker':final_blocker,
             'intersectionComplete':True,'intersectionCount':0,
             'scope':'UV planning, UV and baking for visual inspection only; boundary quality remains failed',
             'sourceSha256':source['sha256']}
    if alternate:
        receipt.update(bakeHighSha256=source['highSha256'],bakeHighRole='explicit_material_reference')
    if source['sha256']!=digest:
        found=[]
        for derived in manager.jobs.values():
            if derived.get('projectId')!=project_id or derived.get('status')!='succeeded' or derived.get('operation') not in ('uv','bake'):
                continue
            evidence=derived.get('result',{}).get('metadata',{}).get('geometryReview',{})
            if any(evidence.get(k)!=receipt[k] for k in ('profile','status','geometryStatus','reviewedBoundaryJobId','reviewedBoundaryStage','diagnosticFileSha256','diagnosticMeshHash','originalSourceSha256')):
                continue
            if derived.get('source',{}).get('highSha256')!=(evidence.get('bakeHighSha256') or original):continue
            for file in derived.get('result',{}).get('files',[]):
                if file.get('role')=='model' and file.get('name')=='model.glb' and file.get('sha256')==source['sha256']:
                    model=manager.output_file(derived['id'],'model.glb')
                    if hashlib.sha256(model.read_bytes()).hexdigest()!=source['sha256']:reject('Reviewed downstream model changed')
                    found.append(derived['id'])
        if not found:reject('Source is not the reviewed diagnostic or its recorded UV/bake derivative')
        receipt['derivedFromJobId']=sorted(found)[0]
    return receipt


def apply_review_metadata(metadata, warnings, review):
    if not review:return
    metadata['geometryReview']=dict(review)
    warnings.append('EXPERIMENTAL REVIEWED GEOMETRY: original boundary distance remains blocked; UV/bake execution was explicitly requested for visual inspection. '+review['originalBlocker'])
