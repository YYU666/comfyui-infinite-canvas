"""Immutable pre-unwrap surface partition/AO/edge plans. Never calls xatlas."""
from pathlib import Path
import hashlib
import json
import re
import numpy as np
from native3d_partfield import canonical,sha,high_evidence,cluster_features,feature_cache_path,COMMIT,CHECKPOINT_SHA,LICENSE
from native3d_uv_structure import MODE as STRUCTURE_MODE, DEFAULTS as STRUCTURE_DEFAULTS
from native3d_uv_macro_plan import PLANNER_VERSION as STRUCTURE_PLANNER_VERSION
COARSE_MODE='ai_coarse_harmonic_v3'
COARSE_PLANNER_VERSION='ai-coarse-fixed-convex-harmonic-v3'

VERSION=1
DEFAULTS={'partitionCount':8,'aoRaySamples':32,'aoRadiusFraction':.08,'aoConcaveAngleDegrees':35.,'aoDarknessThreshold':1.,
 'regionMinAreaFraction':.002,'regionMergeAngleDegrees':35.,'orientationConfirmed':False,'resolution':4096,'padding':16,
 'chartMergeCost':12.,'packingMode':'efficient','alignDirection':'world_up'}
LEGACY_REASONS=['high_surface_region_boundary','ao_supported_signed_concave','high_surface_uncertain_group_guard','coherent_constrained_group_boundary','manual_locked']
REASONS=LEGACY_REASONS+['convex_structural','concave_structural']

def settings(values):
    if not isinstance(values,dict):raise ValueError('Unknown uv_plan parameters')
    modern='seamPlanningMode' in values
    if modern and values['seamPlanningMode'] not in (STRUCTURE_MODE,COARSE_MODE):raise ValueError('Unknown uv_plan seamPlanningMode')
    defaults={**DEFAULTS,**STRUCTURE_DEFAULTS} if modern else DEFAULTS
    review_keys={'reviewedBoundaryJobId','reviewedBoundaryStage'}
    if set(values)-set(defaults)-review_keys:raise ValueError('Unknown uv_plan parameters')
    if any(k in values for k in review_keys):
        if not all(k in values for k in review_keys) or not isinstance(values['reviewedBoundaryJobId'],str) or not re.fullmatch(r'n3d_[a-f0-9]{32}',values['reviewedBoundaryJobId']) or values['reviewedBoundaryStage'] not in ('lod0','lod1','lod2','lod3','lod4'):
            raise ValueError('Invalid paired boundary review identity')
    p={**defaults,**values}
    checks=[type(p['partitionCount']) is int and p['partitionCount'] in (4,8,12),type(p['aoRaySamples']) is int and 8<=p['aoRaySamples']<=128,
        type(p['orientationConfirmed']) is bool,type(p['resolution']) is int and p['resolution'] in (1024,2048,4096),
        type(p['padding']) is int and 1<=p['padding']<=32,p['packingMode'] in ('efficient','legacy_fixed'),p['alignDirection'] in ('world_up','none')]
    for key,lo,hi in [('aoRadiusFraction',.01,.3),('aoConcaveAngleDegrees',5,120),('aoDarknessThreshold',0,1),
                       ('regionMinAreaFraction',0,.02),('regionMergeAngleDegrees',0,60),('chartMergeCost',2,20)]:
        checks.append(type(p[key]) in (int,float) and np.isfinite(p[key]) and lo<=p[key]<=hi)
        if type(p[key]) in (int,float):p[key]=float(p[key])
    if modern:
        for key,lo,hi in [('convexAngleDegrees',5,120),('concaveAngleDegrees',5,90),('structureScaleFraction',.001,.1),('structureMinChainLengthFraction',.001,.3)]:
            checks.append(type(p[key]) in (int,float) and np.isfinite(p[key]) and lo<=p[key]<=hi)
            if type(p[key]) in (int,float):p[key]=float(p[key])
    if not all(checks):raise ValueError('Invalid uv_plan parameter')
    return p

def digest(value):return hashlib.sha256(canonical(value).encode()).hexdigest()

def geometry_sha(mesh):return hashlib.sha256(np.asarray(mesh.vertices,dtype='<f8').tobytes()+np.asarray(mesh.faces,dtype='<i8').tobytes()).hexdigest()

def validate_mesh(mesh,orientation_confirmed):
    if not 1<=len(mesh.faces)<=120000 or not np.isfinite(mesh.vertices).all() or not mesh.nondegenerate_faces().all():raise ValueError('uv_plan requires 1..120000 finite nondegenerate low triangles')
    _,counts=np.unique(mesh.edges_sorted,axis=0,return_counts=True)
    if np.any(counts>2):raise ValueError('uv_plan rejects nonmanifold edges')
    from native3d_uv import structural_edges
    structural_edges(mesh,{'orientationConfirmed':orientation_confirmed,'concaveAngleDegrees':180.,'sharpAngleDegrees':180.})

def merge_regions(mesh,raw_labels,confidence,supported,min_fraction=.002,max_angle=35,max_merges=64):
    """Explicit topology preference over neural labels, never relabel unknowns.

    Connected same-label components first; bounded tiny-region merges only over
    real shared edges whose dihedral meets the surface-continuity threshold.
    Original neural labels remain a separate immutable evidence array.
    """
    n=len(mesh.faces);labels=np.asarray(raw_labels,dtype=np.int32);supported=np.asarray(supported,bool)
    parent=np.arange(n);area=np.asarray(mesh.area_faces);adj=np.asarray(mesh.face_adjacency)
    def root(i):
        while parent[i]!=i:parent[i]=parent[parent[i]];i=int(parent[i])
        return int(i)
    def join(a,b):
        a,b=root(a),root(b)
        if a!=b:parent[max(a,b)]=min(a,b)
    for a,b in adj:
        if supported[a] and supported[b] and labels[a]==labels[b]:join(int(a),int(b))
    regions=np.array([root(i) if supported[i] else -1 for i in range(n)],dtype=np.int32)
    merges=[];total=float(area.sum());angles=np.degrees(mesh.face_adjacency_angles)
    for _ in range(max_merges):
        valid=regions>=0;ids=np.unique(regions[valid]);mass=np.bincount(regions[valid],weights=area[valid],minlength=n)
        sizes={int(k):float(mass[k]) for k in ids}
        small=sorted((k for k in sizes if sizes[k]<total*min_fraction),key=lambda k:(sizes[k],k))
        small_set=set(small);boundary={}
        for (a,b),edge,angle in zip(adj,mesh.face_adjacency_edges,angles):
            ra,rb=int(regions[a]),int(regions[b])
            if min(ra,rb)<0 or ra==rb or angle>max_angle:continue
            length=float(np.linalg.norm(mesh.vertices[edge[0]]-mesh.vertices[edge[1]]))
            for current,other in ((ra,rb),(rb,ra)):
                if current in small_set:
                    neighbors=boundary.setdefault(current,{})
                    neighbors[other]=neighbors.get(other,0.)+length
        choice=None
        for region in small:
            neighbors=boundary.get(region,{})
            if neighbors:
                target=min(neighbors,key=lambda k:(-neighbors[k],-sizes[k],k));choice=(region,target);break
        if choice is None:break
        region,target=choice;members=np.flatnonzero(regions==region)
        merges.append({'from':int(region),'to':int(target),'faces':len(members),'areaFraction':sizes[region]/total,
                       'rawLabels':sorted(set(map(int,labels[members]))),'reason':'tiny connected region, shared-edge surface continuity'})
        regions[members]=target
    ids=sorted(set(map(int,regions[regions>=0])));mapping={old:new for new,old in enumerate(ids)}
    output=np.array([mapping[int(k)] if k>=0 else -1 for k in regions],dtype=np.int32)
    return output,{'merges':merges,'maximumMerges':max_merges,'minimumAreaFraction':min_fraction,'maximumBoundaryAngleDegrees':max_angle,
        'rawLabelCount':len(set(map(int,labels[supported]))),'connectedRegionsAfter':len(ids),'unknownFaces':int((~supported).sum()),
        'policy':'surface-continuity region preference; raw PartField labels retained; unsupported never assigned'}

def _high_ao(high,data,p):
    import open3d as o3d
    count=p['aoRaySamples'];points=data['query'].astype(float)/float(data['scale'])+data['center'];normal=data['queryNormal'].astype(float)
    normal/=np.linalg.norm(normal,axis=1)[:,None];diagonal=float(np.linalg.norm(high.extents))
    scene=o3d.t.geometry.RaycastingScene(nthreads=8);scene.add_triangles(o3d.core.Tensor(np.asarray(high.vertices,np.float32)),o3d.core.Tensor(np.asarray(high.faces,np.uint32)))
    u=(np.arange(count)+.5)/count;phi=np.arange(count)*np.pi*(3-np.sqrt(5));local=np.column_stack((np.sqrt(u)*np.cos(phi),np.sqrt(u)*np.sin(phi),np.sqrt(1-u)))
    axes=np.tile([0.,0.,1.],(len(points),1));axes[np.abs(normal[:,2])>.9]=[0,1,0]
    tangent=np.cross(axes,normal);tangent/=np.linalg.norm(tangent,axis=1)[:,None];bitangent=np.cross(normal,tangent);dark=np.zeros(len(points))
    for start in range(0,len(points),512):
        stop=min(start+512,len(points));n=normal[start:stop]
        directions=local[None,:,0,None]*tangent[start:stop,None]+local[None,:,1,None]*bitangent[start:stop,None]+local[None,:,2,None]*n[:,None]
        origins=np.broadcast_to((points[start:stop]+n*diagonal*1e-5)[:,None],directions.shape)
        hit=scene.cast_rays(o3d.core.Tensor(np.concatenate((origins,directions),axis=2).reshape(-1,6).astype('f4')))['t_hit'].numpy().reshape(-1,count)
        dark[start:stop]=np.mean((hit>diagonal*1e-6)&(hit<p['aoRadiusFraction']*diagonal),axis=1)
    return points,normal,dark

def _map(low,data,high_labels,dark):
    from scipy.spatial import cKDTree
    normal=data['queryNormal'].astype(float);normal/=np.linalg.norm(normal,axis=1)[:,None];tree=cKDTree(data['query'])
    d,near=tree.query(data['query'],k=16,workers=8);dot=np.einsum('ni,nki->nk',normal,normal[near])
    w=np.where((high_labels[:,None]==high_labels[near])&(dot>=.8)&(d<=.015),1/np.maximum(d,.002),0.)
    smooth=np.sum(dark[near]*w,axis=1)/w.sum(axis=1)
    bary=np.array([[1/3,1/3,1/3],[.6,.2,.2],[.2,.6,.2],[.2,.2,.6],[.45,.45,.1],[.45,.1,.45],[.1,.45,.45]])
    count=len(low.faces);labels=np.full(count,-1,np.int32);confidence=np.zeros(count);supported=np.zeros(count,bool);darkness=np.zeros(count)
    parts=int(high_labels.max())+1
    for start in range(0,count,2048):
        stop=min(start+2048,count);positions=np.einsum('si,fij->fsj',bary,np.asarray(low.vertices)[low.faces[start:stop]])
        d,near=tree.query(((positions-data['center'])*float(data['scale'])).reshape(-1,3),k=16,workers=8)
        dot=np.einsum('ni,nki->nk',np.repeat(np.asarray(low.face_normals)[start:stop],7,axis=0),normal[near]);valid=(d<=.03)&(dot>=.5)
        w=np.where(valid,1/np.maximum(d,.002),0.);w/=np.maximum(w.sum(axis=1,keepdims=True),1e-30)
        votes=np.stack([np.sum(w*(high_labels[near]==k),axis=1) for k in range(parts)],axis=1).reshape(-1,7,parts)
        sample_support=valid.any(axis=1).reshape(-1,7);combined=votes.sum(axis=1)/np.maximum(sample_support.sum(axis=1)[:,None],1)
        winner=combined.argmax(axis=1);conf=np.clip(combined.max(axis=1),0.,1.);support=(sample_support.sum(axis=1)>=5)&(conf>=.65)
        ww=w*(high_labels[near]==np.repeat(winner,7)[:,None]);den=ww.reshape(-1,7,16).sum(axis=(1,2))
        mapped=(ww*smooth[near]).reshape(-1,7,16).sum(axis=(1,2))/np.maximum(den,1e-30);support&=den>0
        labels[start:stop]=np.where(support,winner,-1);confidence[start:stop]=conf;supported[start:stop]=support;darkness[start:stop]=np.where(support,np.clip(mapped,0.,1.),0)
    return labels,confidence,supported,darkness

def candidate_plan(mesh,p,labels,confidence,supported,darkness,*,return_statistics=False,diagnostics=False):
    from native3d_uv import structural_edges,groups_from_edges
    from native3d_uv_ao import high_guided_seams
    _,_,reasons=structural_edges(mesh,{**p,'concaveAngleDegrees':180.,'sharpAngleDegrees':180.})
    stage_statistics=None
    evidence={'labels':labels,'confidence':confidence,'supported':supported,'darkness':darkness,
        **dict.fromkeys(('method','highSourceSha256','targetSourceSha256','highFaceCount','queryCount','queryCacheSha256','queryLabelsSha256','checkpointSha256','raySamples','raysCast'),None)}
    evidence['raySamples']=p['aoRaySamples']
    if p.get('seamPlanningMode')==COARSE_MODE:
        for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
            a,b=pair
            if supported[a] and supported[b] and confidence[a]>=.65 and confidence[b]>=.65 and labels[a]!=labels[b]:
                reasons.setdefault(tuple(sorted(map(int,edge))),'high_surface_region_boundary')
        groups=groups_from_edges(mesh,reasons,partition_labels=labels)
        owner=np.empty(len(mesh.faces),np.int32)
        for i,group in enumerate(groups):owner[group]=i
        for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
            if owner[pair[0]]!=owner[pair[1]]:
                reasons.setdefault(tuple(sorted(map(int,edge))),'high_surface_uncertain_group_guard' if min(labels[pair[0]],labels[pair[1]])<0 else 'coherent_constrained_group_boundary')
        statistics={'mode':COARSE_MODE,'finalConstrainedGroups':len(groups),'structureChainsImposed':False,
                    'policy':'Preserve coarse AI regions; necessary disk topology seams during fixed-convex harmonic unwrap. Angle/AO chains not imposed.',
                    'finalReasonCounts':{reason:sum(value==reason for value in reasons.values()) for reason in REASONS}}
        return (reasons,groups,statistics) if return_statistics else (reasons,groups)
    if p.get('seamPlanningMode')==STRUCTURE_MODE:
        # AI boundaries have priority. Geometry then adds supported convex and
        # concave turns; AO only supplements the remaining real concave edges.
        adjacent=np.asarray(mesh.face_adjacency)
        for pair,edge in zip(adjacent,mesh.face_adjacency_edges):
            a,b=pair
            if supported[a] and supported[b] and confidence[a]>=.65 and confidence[b]>=.65 and labels[a]!=labels[b]:
                reasons.setdefault(tuple(sorted(map(int,edge))),'high_surface_region_boundary')
        ai_count=sum(value=='high_surface_region_boundary' for value in reasons.values())
        base_ai_groups=groups_from_edges(mesh,reasons,partition_labels=labels)
        from native3d_uv_structure import structural_stages
        stages,stage_statistics=structural_stages(mesh,p,confidence,supported,darkness,protected_edges=reasons,diagnostics=diagnostics,region_labels=labels)
        for record in stage_statistics['stages']:
            reason=record['reason'];added=0
            for edge in sorted(stages[reason]):
                if edge not in reasons:reasons[edge]=reason;added+=1
            record['newEdges']=added
        stage_statistics['aiBoundaryEdges']=ai_count
        stage_statistics['priority']=['high_surface_region_boundary','convex_structural','concave_structural','ao_supported_signed_concave']
    else:
        more,_=high_guided_seams(mesh,p,evidence);reasons.update(more)
    if stage_statistics is not None:
        from native3d_uv_structure import connected_open_seam_groups
        groups,grouping=connected_open_seam_groups(mesh,base_ai_groups,reasons)
        stage_statistics['grouping']=grouping
        from native3d_uv_macro_plan import macro_groups
        reasons,groups,macro=macro_groups(mesh,base_ai_groups,groups,reasons)
        stage_statistics['macroPolicy']=macro
    else:groups=groups_from_edges(mesh,reasons,partition_labels=labels)
    owner=np.empty(len(mesh.faces),np.int32)
    for i,group in enumerate(groups):owner[group]=i
    for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
        key=tuple(sorted(map(int,edge)))
        if owner[pair[0]]!=owner[pair[1]] and key not in reasons:
            reasons[key]='high_surface_uncertain_group_guard' if min(labels[pair[0]],labels[pair[1]])<0 else 'coherent_constrained_group_boundary'
    if stage_statistics is not None:
        stage_statistics['finalConstrainedGroups']=len(groups)
        stage_statistics['finalReasonCounts']={reason:sum(value==reason for value in reasons.values()) for reason in REASONS}
    return (reasons,groups,stage_statistics) if return_statistics else (reasons,groups)

def _binary(path,arrays):
    descriptions={};offset=0
    with path.open('wb') as stream:
        for name,value in arrays.items():
            padding=(-offset)%4;stream.write(b'\0'*padding);offset+=padding
            value=np.ascontiguousarray(value);blob=value.tobytes();stream.write(blob)
            descriptions[name]={'offset':offset,'byteLength':len(blob),'dtype':value.dtype.name,'count':len(value),'itemSize':1 if value.ndim==1 else value.shape[1]};offset+=len(blob)
    if offset>64*1024**2:raise ValueError('UV plan overlay exceeds 64MiB')
    return {'name':path.name,'sha256':sha(path),'byteLength':offset,'arrays':descriptions}

def build_plan(low,high,out,parameters,*,low_sha256,high_sha256,config=None,progress=None,worker_lease=None):
    config=config or {};p=settings(parameters);validate_mesh(low,p['orientationConfirmed'])
    out=Path(out);out.mkdir(parents=True,exist_ok=True)
    if not all(isinstance(h,str) and len(h)==64 and all(c in '0123456789abcdef' for c in h) for h in (low_sha256,high_sha256)):raise ValueError('Source SHA256 required')
    if progress:progress('verify_sources',5)
    cache_root=Path(config.get('cacheRoot',out.parent/'uv-plan-cache'))
    cache=feature_cache_path(cache_root, high_sha256)
    data,features,receipt=high_evidence(high,high_sha256,cache,gpu_authorized=config.get('gpuAuthorized') is True,
        verified_cache=config.get('verifiedHighCache'),progress=progress,config=config,worker_lease=worker_lease)
    if progress:progress('cluster_high_queries',45)
    # CPU estimator runs in its configured independent runtime; native3D's
    # environment does not need sklearn or the GPU runtime's torch imports.
    cluster_key=digest({'features':receipt['featuresSha256'],'parts':p['partitionCount'],'estimator':'normalized-minibatch-kmeans-v1'})
    cluster_path=cache/(cluster_key+'.npy');cluster_receipt=cache/(cluster_key+'.json')
    if cluster_path.is_file() and cluster_receipt.is_file():
        cr=json.loads(cluster_receipt.read_text())
        if cr.get('key')!=cluster_key or cr.get('sha256')!=sha(cluster_path):raise ValueError('High cluster cache changed')
        high_labels=np.load(cluster_path,allow_pickle=False)
    else:
        high_labels=cluster_features(cache/'high-query-features.npy',cluster_path,p['partitionCount'],config)
        cluster_receipt.write_text(canonical({'key':cluster_key,'sha256':sha(cluster_path)}))
    if high_labels.shape!=(32768,) or not np.issubdtype(high_labels.dtype,np.integer) or high_labels.min()<0 or high_labels.max()>=p['partitionCount']:raise ValueError('Invalid high label cache')
    ao_key=digest({'samples':receipt['sampleCacheSha256'],'rays':p['aoRaySamples'],'radius':p['aoRadiusFraction'],'version':1})
    ao_path=cache/(ao_key+'.npz');ao_receipt=cache/(ao_key+'.json')
    if progress:progress('high_surface_AO',55)
    ao_reused=False
    if ao_path.is_file() and ao_receipt.is_file():
        ar=json.loads(ao_receipt.read_text())
        if ar.get('sha256')!=sha(ao_path) or ar.get('key')!=ao_key:raise ValueError('High AO cache changed')
        raw=np.load(ao_path,allow_pickle=False);points,normal,dark=raw['points'],raw['normal'],raw['darkness'];ao_reused=True
    else:
        points,normal,dark=_high_ao(high,data,p);np.savez_compressed(ao_path,points=points,normal=normal,darkness=dark)
        ao_receipt.write_text(canonical({'key':ao_key,'sha256':sha(ao_path)}))
    if dark.shape!=(32768,) or not np.isfinite(dark).all() or np.any((dark<0)|(dark>1)):raise ValueError('Invalid sampled high AO')
    if progress:progress('map_to_target',70)
    raw_labels,confidence,supported,darkness=_map(low,data,high_labels,dark)
    regions,merge=merge_regions(low,raw_labels,confidence,supported,p['regionMinAreaFraction'],p['regionMergeAngleDegrees'])
    if progress:progress('candidate_edges',85)
    reasons,groups,structure=candidate_plan(low,p,regions,confidence,supported,darkness,return_statistics=True)
    reason_dictionary=REASONS if p.get('seamPlanningMode')==STRUCTURE_MODE else LEGACY_REASONS
    edge_values=sorted(reasons);edge_array=np.asarray(edge_values,dtype='<u4').reshape(-1,2)
    overlay=_binary(out/'uv-plan-overlay.bin',{'positions':np.asarray(low.vertices,dtype='<f4'),'faces':np.asarray(low.faces,dtype='<u4'),
        'regions':regions.astype('<i4'),'darkness':darkness.astype('<f4'),'confidence':confidence.astype('<f4'),'supported':supported.astype('u1'),
        'edges':edge_array,'edgeReason':np.array([reason_dictionary.index(reasons[e]) for e in edge_values],dtype='u1'),
        'highPoints':points.astype('<f4'),'highRegions':high_labels.astype('<i4'),'highDarkness':dark.astype('<f4')})
    # Group membership is explicit and hashed; avoids recomputing a different
    # unknown-bridge partition when the user finally clicks Unwrap.
    owner=np.empty(len(low.faces),np.int32)
    for i,group in enumerate(groups):owner[group]=i
    np.savez_compressed(out/'uv-plan-evidence.npz',regions=regions,rawRegions=raw_labels,confidence=confidence,supported=supported,darkness=darkness,groupOwner=owner,highLabels=high_labels)
    evidence={'name':'uv-plan-evidence.npz','sha256':sha(out/'uv-plan-evidence.npz'),'byteLength':(out/'uv-plan-evidence.npz').stat().st_size}
    area=np.asarray(low.area_faces);total=float(area.sum())
    statistics={'lowFaces':len(low.faces),'highFaces':len(high.faces),'queryCount':32768,'partitionCount':p['partitionCount'],
        'regionCount':len(set(map(int,regions[regions>=0]))),'constrainedGroups':len(groups),'candidateEdgeCount':len(reasons),
        'supportedFaces':int(supported.sum()),'unsupportedAreaFraction':float(area[~supported].sum()/total),'regionMerging':merge,
        'aoRays':32768*p['aoRaySamples'],'aoCacheReused':ao_reused,'featureCacheReused':receipt['cacheReused'],'unwrapExecuted':False}
    if structure is not None:statistics['structureStages']=structure
    plan={'version':VERSION,'kind':'native3d_uv_plan','plannerVersion':COARSE_PLANNER_VERSION if p.get('seamPlanningMode')==COARSE_MODE else STRUCTURE_PLANNER_VERSION if structure is not None else 'sampled-high-regions-v1','source':{'lowSha256':low_sha256,'highSha256':high_sha256,'lowGeometrySha256':geometry_sha(low)},
        'settings':p,'settingsSha256':digest(p),'runtime':receipt,'statistics':statistics,'candidateEdges':[{'vertices':list(e),'reason':reasons[e]} for e in edge_values],
        'edgeReasons':reason_dictionary,'overlay':overlay,'evidence':evidence,'limitations':['PartField/AO sampled at 32768 original high-surface points; not every-face inference.',
            'Candidate constraints only; UV charting and overlap repair may require additional seams.','Region continuity merging is an explicit topology preference; raw neural labels retained.',LICENSE]}
    plan['planSha256']=digest(plan);(out/'uv-plan.json').write_text(canonical(plan),encoding='utf-8')
    files=[{'name':'uv-plan.json','role':'plan','mime':'application/json'},{'name':overlay['name'],'role':'plan','mime':'application/octet-stream'},
           {'name':evidence['name'],'role':'evidence','mime':'application/octet-stream'}]
    if progress:progress('finalize_plan',100)
    # Large edge arrays live in hashed artifacts, not the durable job manifest.
    summary={key:value for key,value in plan.items() if key!='candidateEdges'}
    return {'plan':plan,'metadata':{'uvPlan':summary},'files':files}

def load_plan(path,*,low_sha256,high_sha256,parameters=None,plan_sha256=None):
    path=Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size>32*1024**2:raise ValueError('UV_PLAN_STALE: invalid plan file')
    plan=json.loads(path.read_text(encoding='utf-8'));without={k:v for k,v in plan.items() if k!='planSha256'}
    if plan.get('kind')!='native3d_uv_plan' or plan.get('version')!=VERSION or digest(without)!=plan.get('planSha256') or (plan_sha256 and plan['planSha256']!=plan_sha256):raise ValueError('UV_PLAN_STALE: plan digest/version changed')
    if plan['source']['lowSha256']!=low_sha256 or plan['source']['highSha256']!=high_sha256:raise ValueError('UV_PLAN_STALE: source changed')
    if digest(plan['settings'])!=plan['settingsSha256'] or settings(plan['settings'])!=plan['settings'] or (parameters is not None and settings(parameters)!=plan['settings']):raise ValueError('UV_PLAN_STALE: settings changed')
    for key in ('overlay','evidence'):
        descriptor=plan[key];name=descriptor['name'];artifact=path.parent/name
        if Path(name).name!=name or artifact.is_symlink() or not artifact.is_file() or artifact.stat().st_size!=descriptor['byteLength'] or sha(artifact)!=descriptor['sha256']:raise ValueError('UV_PLAN_STALE: artifact changed')
    plan['_directory']=str(path.parent.resolve())
    return plan

def consume_plan(mesh,plan):
    if digest({k:v for k,v in plan.items() if k not in ('planSha256','_directory')})!=plan['planSha256']:raise ValueError('UV_PLAN_STALE: in-memory plan changed')
    if geometry_sha(mesh)!=plan['source']['lowGeometrySha256']:raise ValueError('UV_PLAN_STALE: topology changed')
    directory=Path(plan['_directory']);artifact=directory/plan['evidence']['name']
    if artifact.is_symlink() or sha(artifact)!=plan['evidence']['sha256']:raise ValueError('UV_PLAN_STALE: evidence changed before consume')
    data=np.load(artifact,allow_pickle=False)
    n=len(mesh.faces);fields=('regions','rawRegions','confidence','supported','darkness','groupOwner')
    if any(data[key].shape!=(n,) for key in fields):raise ValueError('UV_PLAN_STALE: evidence shape')
    if not all(np.isfinite(data[key]).all() for key in fields):raise ValueError('UV_PLAN_STALE: evidence nonfinite')
    # Historical v1 plans stored unrounded float64 weighted probabilities.
    # A normalized vote may exceed one by a few arithmetic ULPs. Accept only
    # that bounded roundoff, never a materially out-of-range probability.
    tolerance=8*np.finfo(np.float64).eps
    if any(not np.issubdtype(data[key].dtype,np.floating) or np.any((data[key]<-tolerance)|(data[key]>1+tolerance)) for key in ('confidence','darkness')) or data['supported'].dtype!=np.dtype(bool):raise ValueError('UV_PLAN_STALE: invalid mapping support')
    if not np.array_equal(data['regions']>=0,data['supported']):raise ValueError('UV_PLAN_STALE: unknown region support changed')
    if np.any(data['supported']&(data['confidence']<.65)):raise ValueError('UV_PLAN_STALE: supported mapping confidence changed')
    if not all(np.issubdtype(data[key].dtype,np.integer) for key in ('regions','rawRegions','groupOwner')):raise ValueError('UV_PLAN_STALE: invalid region/group indices')
    all_edges=set(map(tuple,np.asarray(mesh.edges_sorted)));reasons={}
    for item in plan['candidateEdges']:
        a,b=item['vertices'];key=(a,b)
        if type(a) is not int or type(b) is not int or a>=b or key not in all_edges or key in reasons or item['reason'] not in REASONS:raise ValueError('UV_PLAN_STALE: invalid edge topology')
        reasons[key]=item['reason']
    owner=data['groupOwner'];groups=[np.flatnonzero(owner==i) for i in sorted(set(map(int,owner)))]
    if owner.min()<0 or not groups:raise ValueError('UV_PLAN_STALE: invalid groups')
    for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
        if owner[pair[0]]!=owner[pair[1]] and tuple(sorted(map(int,edge))) not in reasons:raise ValueError('UV_PLAN_STALE: unplanned group boundary')
    evidence={key:data[key].copy() for key in fields}
    for key in ('confidence','darkness'):np.clip(evidence[key],0.,1.,out=evidence[key])
    backend='macro_uvatlas1' if plan.get('plannerVersion')==STRUCTURE_PLANNER_VERSION else 'macro_natural1' if plan.get('plannerVersion')=='ai-structural-ao-v2-macro-natural1' else COARSE_MODE if plan['settings'].get('seamPlanningMode')==COARSE_MODE else 'slim'
    return {'reasons':reasons,'groups':groups,'evidence':evidence,'planSha256':plan['planSha256'],'parameterizationBackend':backend}

def unwrap_plan(mesh,plan,params=None,output=None,*,progress=None,checkpoint_root=None):
    """Unwrap only a load_plan-validated snapshot, honoring frozen constraints."""
    frozen=consume_plan(mesh,plan);p=dict(plan['settings'])
    if params is not None:
        allowed=set(plan['settings'])|{'planJobId','planSha256','externalGeometryReviewed','seamStrategy'}
        if set(params)-allowed:raise ValueError('Unknown frozen-plan unwrap parameters')
        for key in set(params)&set(plan['settings']):
            if params[key]!=p[key]:raise ValueError('UV_PLAN_STALE: unwrap setting changed: '+key)
        if params.get('planSha256',plan['planSha256'])!=plan['planSha256']:raise ValueError('UV_PLAN_STALE: selected plan changed')
    data=frozen['evidence'];runtime=plan['runtime']
    high_guided={'labels':data['regions'],'confidence':data['confidence'],'darkness':data['darkness'],'supported':data['supported'],
        'method':'partfield_high_surface_ao','highSourceSha256':plan['source']['highSha256'],'targetSourceSha256':plan['source']['lowSha256'],
        'highFaceCount':plan['statistics']['highFaces'],'queryCount':32768,'queryCacheSha256':runtime['sampleCacheSha256'],
        'queryLabelsSha256':plan['evidence']['sha256'],'checkpointSha256':runtime['checkpointSha256'],'raySamples':p['aoRaySamples'],'raysCast':p['aoRaySamples']*32768}
    if output is not None:p['diagnosticsDirectory']=str(output)
    from native3d_uv_coherent import coherent_unwrap
    import time
    stage_started=time.monotonic()
    cached=None;cache_key=None
    if checkpoint_root is not None:
        from native3d_uv_checkpoint import identity,load,save
        cache_key=identity(mesh,plan)
        cached=load(checkpoint_root,cache_key,mesh,plan,output)
    if cached is None:
        result,report=coherent_unwrap(mesh,{**p,'seamStrategy':'coherent'},high_guided_evidence=high_guided,_frozen_plan=frozen,**({'progress':progress} if progress is not None else {}))
    else:
        if progress is not None:progress('uv_restore_verified','start',0.)
        result,report=cached
    vertex=np.asarray(result.metadata['uvSourceVertex']);face=np.asarray(result.metadata['uvSourceFace'])
    np.testing.assert_array_equal(result.vertices,np.asarray(mesh.vertices)[vertex])
    np.testing.assert_array_equal(vertex[result.faces],np.asarray(mesh.faces)[face])
    joined={tuple(sorted(map(int,vertex[edge]))) for edge in result.face_adjacency_edges}
    interior={tuple(sorted(map(int,edge))) for edge in mesh.face_adjacency_edges}
    actual=interior-joined;requested=set(frozen['reasons']);extra=sorted(actual-requested)
    missing=(requested & interior)-actual
    if missing:raise ValueError('UV_PLAN_CONSTRAINT_LOST: reviewed interior seams were joined')
    report['reviewedPlan']={'planSha256':plan['planSha256'],'frozenConstraintEdges':len(requested),'frozenGroups':len(frozen['groups']),
        'missingConstraintEdges':0,
        'actualSeamEdges':len(actual),'additionalSeamEdges':[list(edge) for edge in extra],
        'additionalSeamCount':len(extra),'additionalSeamPolicy':('Necessary disk topology cuts; no angle/AO chain or face-isolation claims' if p.get('seamPlanningMode')==COARSE_MODE else 'xatlas topology and bounded overlap-repair cuts; distinct from reviewed candidate constraints'),
        'inferenceRecomputed':False,'AORecomputed':False}
    if checkpoint_root is not None:
        if cached is None:
            # The original report must serialize before any preview/export work.
            # A cache write problem never discards a successfully computed UV.
            from native3d_uv_checkpoint import packed_json
            packed_json(report)  # Type/nonfinite errors are real report failures.
            try:
                stored=save(checkpoint_root,cache_key,result,report,plan,output)
                cache_status='stored' if stored else 'existing_not_replaced'
            except OSError:
                cache_status='write_unavailable'
            except ValueError:
                # A legacy needs_review result may have warnings/failed flags.
                # Ineligibility for reuse must not introduce a new quality gate.
                cache_status='not_cacheable'
        else:
            cache_status='reused_verified_stage'
            if progress is not None:progress('uv_restore_verified','complete',time.monotonic()-stage_started)
        report['stageReuse']={'status':cache_status,'key':cache_key,
            'currentStageWallSeconds':time.monotonic()-stage_started,
            'qualityAcceptanceChanged':False,
            'timingMeaning':'stageTimingsSeconds describes the original computed UV; currentStageWallSeconds measures this attempt'}
    return result,report
