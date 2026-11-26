"""Natural xatlas chart seeds, local fold-patch repair and verified tiny-chart merging.
No circles, deleted faces, positional repair, or deliberate single-face isolation.
"""
import json,time,hashlib
from pathlib import Path
import numpy as np
import trimesh
from native3d_uv_slim import _fans,_boundary,_distortion
from native3d_uv_natural import natural_lscm_slim
from native3d_uv_overlap import overlap_pairs,conflict_cover

def _natural(mesh,ids):
    import igl
    s,inv=np.unique(np.asarray(mesh.faces)[ids],return_inverse=True)
    v,f,s=_fans(np.asarray(mesh.vertices)[s],inv.reshape(-1,3),s)
    _,_,loops=_boundary(f)
    uv,metrics=natural_lscm_slim(igl,v,f,max(loops,key=len))
    conflicts=overlap_pairs(trimesh.Trimesh(v,f,process=False),uv)
    return (v,f,s,np.asarray(ids),uv,metrics),conflicts

def _fold_split(mesh,ids,conflicts):
    from collections import deque
    ids=np.asarray(ids);owner=np.full(len(mesh.faces),-1,int);owner[ids]=np.arange(len(ids))
    adj=np.asarray(mesh.face_adjacency);pairs=owner[adj[np.all(owner[adj]>=0,axis=1)]]
    neighbors=[set() for _ in ids]
    for a,b in pairs:neighbors[a].add(int(b));neighbors[b].add(int(a))
    if conflicts:
        degree=np.bincount(np.array(conflicts).ravel(),minlength=len(ids));seed=int(np.argmax(degree))
    else:raise ValueError('Natural initial flips need a supported chart split; no arbitrary isolation')
    patch={seed};queue=deque([seed])
    while queue and len(patch)<8:
        current=queue.popleft()
        for n in sorted(neighbors[current]):
            if n not in patch:patch.add(n);queue.append(n)
            if len(patch)>=8:break
    labels=np.zeros(len(ids),bool);labels[list(patch)]=True
    remain=np.flatnonzero(~labels);links=pairs[~labels[pairs].any(1)]
    components=trimesh.graph.connected_components(links,nodes=remain,min_len=1)
    for c in components:
        if len(c)<8:patch.update(map(int,c))
    children=[ids[np.array(sorted(patch))]]+[ids[np.sort(c)] for c in components if len(c)>=8]
    if len(children)<2 or min(map(len,children))<8:raise ValueError('Fold patch cannot split without tiny/isolated faces')
    return children

def _local_rechart(mesh,ids):
    """Mature chart segmentation for a persistently folded multi-face patch."""
    import xatlas
    s,inv=np.unique(np.asarray(mesh.faces)[ids],return_inverse=True);v,f,s=_fans(np.asarray(mesh.vertices)[s],inv.reshape(-1,3),s)
    atlas=xatlas.Atlas();atlas.add_mesh(v.astype('f4'),f.astype('u4'))
    chart=xatlas.ChartOptions();chart.max_cost=2.;chart.max_iterations=4
    pack=xatlas.PackOptions();pack.resolution=4096;pack.padding=16
    atlas.generate(chart_options=chart,pack_options=pack);xref,f,u=atlas[0];s=s[xref];v=np.asarray(mesh.vertices)[s]
    if not np.array_equal(s[f],np.asarray(mesh.faces)[ids]):raise ValueError('Local rechart source changed')
    v,f,fan=_fans(v,f,np.arange(len(v)));s=s[fan];u=np.asarray(u[fan],float)*[atlas.width,atlas.height]
    parts=trimesh.graph.connected_components(trimesh.Trimesh(v,f,process=False).face_adjacency,nodes=np.arange(len(f)),min_len=1)
    result=[]
    for faces in parts:
        faces=np.sort(faces);used,inv=np.unique(f[faces],return_inverse=True);ff=inv.reshape(-1,3);uv=u[used];uv=(uv-uv.min(0))/np.ptp(uv,axis=0).max();metric=_distortion(v[used],ff,uv)
        if metric['nonpositiveTriangles']==len(faces):uv[:,0]*=-1;metric=_distortion(v[used],ff,uv)
        result.append((v[used],ff,s[used],np.asarray(ids)[faces],uv,metric))
    return result

def parameterize_groups(mesh,groups,reasons,diagnostics_directory=None):
    import xatlas
    start=time.perf_counter();owner=np.empty(len(mesh.faces),int)
    for i,g in enumerate(groups):owner[g]=i
    for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
        if tuple(sorted(map(int,edge))) in reasons and owner[pair[0]]==owner[pair[1]]:
            raise ValueError('Macro natural plan has an intra-group hard slit; explicitly replan instead of rewelding it')
    cache=None
    if diagnostics_directory:
        fingerprint=hashlib.sha256(np.asarray(mesh.vertices,dtype='<f8').tobytes()+np.asarray(mesh.faces,dtype='<i8').tobytes()+owner.astype('<i8').tobytes()+json.dumps(sorted((list(k),v) for k,v in reasons.items())).encode()+b'macro-natural1-raw12-normal0.1-round0.01-iter4-fold8-depth3-merge32-p953').hexdigest()
        cache=Path(diagnostics_directory)/'macro-group-cache'/fingerprint;cache.mkdir(parents=True,exist_ok=True)
    seed_count=0;reused_groups=0
    outputs=[];records=[];raw_records=[];repairs=0;seed_single=0;pending=[]
    def solve(ids,group_id,depth=0,seedpart=None,repair_pass=0):
        nonlocal repairs
        if seedpart is not None:
            part=seedpart
            conflicts=overlap_pairs(trimesh.Trimesh(part[0],part[1],process=False),part[4])
            raw_records.append({'faces':len(ids),'overlapPairs':len(conflicts),'nonpositiveTriangles':part[5]['nonpositiveTriangles']})
            if conflicts or part[5]['nonpositiveTriangles']:
                part,conflicts=_natural(mesh,ids)
        else:part,conflicts=_natural(mesh,ids)
        if not conflicts:outputs.append((group_id,part));return
        if depth>=3:
            if repair_pass<2 and len(ids)>=16:
                parts=_local_rechart(mesh,ids)
                if len(parts)>1:
                    records.append({'reason':'persistent_overlap_local_xatlas_rechart','sourceFaces':list(map(int,ids)),'childrenFaces':[len(p[3]) for p in parts],'maxCost':2.})
                    for p in parts:solve(p[3],group_id,seedpart=p,repair_pass=repair_pass+1)
                    return
            pending.append((group_id,np.asarray(ids)));return
        try:children=_fold_split(mesh,ids,conflicts)
        except ValueError:
            if diagnostics_directory:
                np.savez_compressed(Path(diagnostics_directory)/'failed-fold.npz',sourceFace=ids,vertices=part[0],faces=part[1],uv=part[4],conflicts=np.asarray(conflicts))
            pending.append((group_id,np.asarray(ids)));return
        repairs+=1
        records.append({'reason':'measured_global_overlap_fold_patch','sourceFaces':list(map(int,ids)),'overlapPairs':len(conflicts),'childrenFaces':list(map(len,children)),'minimumNewChildFaces':8})
        for child in children:solve(child,group_id,depth+1,repair_pass=repair_pass)
    for i,group in enumerate(groups):
        checkpoint=cache/('group-'+str(i)+'.npz') if cache else None
        receipt_path=checkpoint.with_suffix('.json') if checkpoint else None
        if checkpoint and checkpoint.is_file() and receipt_path.is_file():
            meta=json.loads(receipt_path.read_text());data=np.load(checkpoint,allow_pickle=False)
            if meta['sha256']!=hashlib.sha256(checkpoint.read_bytes()).hexdigest():raise ValueError('Macro group cache changed')
            for j,metric in enumerate(meta['metrics']):
                part=tuple(data[str(j)+'_'+key] for key in ('vertices','faces','sourceVertex','sourceFace','uv'))+(metric,)
                if not np.array_equal(part[2][part[1]],np.asarray(mesh.faces)[part[3]]):raise ValueError('Macro group cache source mapping changed')
                outputs.append((i,part))
            records.extend(meta['repairs']);raw_records.extend(meta['raw']);repairs+=len(meta['repairs']);seed_single+=meta['seedSingle'];seed_count+=meta['seedCount'];reused_groups+=1
            print(json.dumps({'stage':'macro_group_restored','group':i,'charts':len(meta['metrics'])}),flush=True)
            continue
        output_start=len(outputs);record_start=len(records);raw_start=len(raw_records);single_start=seed_single
        seed_path=cache/('seed-'+str(i)+'.npz') if cache else None
        if seed_path and seed_path.is_file():
            data=np.load(seed_path,allow_pickle=False);v,f,s,u=(data[k] for k in ('vertices','faces','sourceVertex','uv'));group_seed_count=int(data['seedCount'])
        else:
            atlas=xatlas.Atlas();s,inv=np.unique(np.asarray(mesh.faces)[group],return_inverse=True);v,f,s=_fans(np.asarray(mesh.vertices)[s],inv.reshape(-1,3),s)
            atlas.add_mesh(v.astype('f4'),f.astype('u4'))
            chart=xatlas.ChartOptions();chart.max_cost=12.;chart.normal_deviation_weight=.1;chart.normal_seam_weight=0.;chart.texture_seam_weight=0.;chart.roundness_weight=.01;chart.straightness_weight=0.;chart.max_iterations=4
            pack=xatlas.PackOptions();pack.resolution=4096;pack.padding=16
            atlas.generate(chart_options=chart,pack_options=pack)
            xref,f,u=atlas[0];s=s[xref];v=np.asarray(mesh.vertices)[s];u=np.asarray(u,float)*[atlas.width,atlas.height];group_seed_count=int(atlas.chart_count)
            if seed_path:np.savez_compressed(seed_path,vertices=v,faces=f,sourceVertex=s,uv=u,seedCount=group_seed_count)
        if not np.array_equal(s[f],np.asarray(mesh.faces)[group]):raise ValueError('xatlas source triangle order changed')
        seed_count+=group_seed_count
        v,f,fan=_fans(v,f,np.arange(len(v)));s=s[fan];u=u[fan]
        parts=trimesh.graph.connected_components(trimesh.Trimesh(v,f,process=False).face_adjacency,nodes=np.arange(len(f)),min_len=1)
        for ids in parts:
            ids=np.sort(ids);used,inv=np.unique(f[ids],return_inverse=True);faces=inv.reshape(-1,3);uv=np.asarray(u[used],float)
            uv=(uv-uv.min(0))/np.ptp(uv,axis=0).max();metric=_distortion(v[used],faces,uv)
            if metric['nonpositiveTriangles']==len(ids):uv[:,0]*=-1;metric=_distortion(v[used],faces,uv)
            seed_single+=len(ids)==1;solve(np.asarray(group)[ids],i,seedpart=(v[used],faces,s[used],np.asarray(group)[ids],uv,metric))
        # A folded small patch cannot be split into single faces. Try joining
        # a real adjacent chart inside its hard group, then verify the new map.
        for pending_group,ids in pending:
            if pending_group!=i:raise ValueError('Unresolved fold from earlier hard group')
            adjacent=np.asarray(mesh.face_adjacency)
            near=set(map(int,adjacent[np.any(np.isin(adjacent,ids),axis=1)].ravel()))-set(map(int,ids))
            options=[j for j,(gid,p) in enumerate(outputs) if gid==i and near.intersection(map(int,p[3]))]
            options.sort(key=lambda j:(len(outputs[j][1][3]),j));accepted=False
            for j in options[:16]:
                combined=np.sort(np.r_[ids,outputs[j][1][3]])
                try:part,conflicts=_natural(mesh,combined)
                except (ValueError,RuntimeError):continue
                if conflicts or part[5]['nonpositiveTriangles']:continue
                outputs[j]=(i,part);accepted=True
                records.append({'reason':'small_fold_patch_merged_to_adjacent_chart','sourceFaces':list(map(int,ids)),'mergedFaces':len(combined),'overlapPairs':0})
                break
            if not accepted:
                if diagnostics_directory:np.savez_compressed(Path(diagnostics_directory)/'unresolved-patch.npz',vertices=mesh.vertices,faces=mesh.faces,sourceFace=ids,hardGroup=group)
                raise ValueError('Natural fold patch cannot merge without overlap: '+str(len(ids))+' faces')
        pending.clear()
        if checkpoint:
            arrays={str(j)+'_'+key:value for j,(_,part) in enumerate(outputs[output_start:]) for key,value in zip(('vertices','faces','sourceVertex','sourceFace','uv'),part[:5])}
            np.savez_compressed(checkpoint,**arrays)
            receipt_path.write_text(json.dumps({'sha256':hashlib.sha256(checkpoint.read_bytes()).hexdigest(),'metrics':[p[5] for _,p in outputs[output_start:]],'repairs':records[record_start:],'raw':raw_records[raw_start:],'seedSingle':seed_single-single_start,'seedCount':group_seed_count}),encoding='utf-8')
        print(json.dumps({'stage':'macro_natural_groups','complete':i+1,'total':len(groups),'charts':len(outputs),'foldRepairs':repairs}),flush=True)
    # One bounded deterministic merge pass, only within the same hard plan group.
    charts={i:p for i,p in enumerate(outputs)};face_owner=np.empty(len(mesh.faces),int)
    for i,(_,p) in charts.items():face_owner[p[3]]=i
    adj=np.asarray(mesh.face_adjacency);merge_attempts=0;merged=0
    for ci in sorted(charts,key=lambda i:(len(charts[i][1][3]),i)):
        if ci not in charts or len(charts[ci][1][3])>=32:continue
        group_id,p=charts[ci];ids=p[3];neighbor_faces=adj[np.any(np.isin(adj,ids),axis=1)].ravel();others=set(map(int,face_owner[neighbor_faces]))-{ci}
        options=[j for j in others if j in charts and charts[j][0]==group_id]
        options.sort(key=lambda j:(-len(charts[j][1][3]),j))
        for cj in options[:2]:
            if merge_attempts>=4096:break
            merge_attempts+=1;combined=np.sort(np.r_[ids,charts[cj][1][3]])
            try:part,conflicts=_natural(mesh,combined)
            except (ValueError,RuntimeError):continue
            if conflicts or part[5]['areaWeightedStretchP95']>3.:continue
            charts[cj]=(group_id,part);del charts[ci];face_owner[combined]=cj;merged+=1;break
    vs=[];fs=[];uvs=[];sv=[];sf=[];metrics=[];offset=0
    for index,(_,part) in enumerate(charts.values()):
        v,f,s,faces,u,metric=part;u=u.copy();u[:,0]+=index*2
        vs.append(v);fs.append(f+offset);uvs.append(u);sv.append(s);sf.append(faces);offset+=len(v);metrics.append({'faces':len(f),**metric})
    result=trimesh.Trimesh(np.concatenate(vs),np.concatenate(fs),process=False);uv=np.concatenate(uvs);vertex=np.concatenate(sv);face=np.concatenate(sf)
    if not np.array_equal(vertex[result.faces],np.asarray(mesh.faces)[face]) or not np.array_equal(np.sort(face),np.arange(len(mesh.faces))):raise ValueError('Macro natural lost source triangles')
    receipt={'backend':'xatlas chart seeds + natural two-pin LSCM/SLIM20 + bounded fold patches','islands':len(charts),'xatlasSeedCharts':seed_count,'reusedGroups':reused_groups,'xatlasSingleFaceSeeds':int(seed_single),'rawChartChecks':raw_records,'foldRepairs':repairs,'foldRepairRecords':records,'tinyMergeAttempts':merge_attempts,'tinyChartsMerged':merged,'islandMetrics':metrics,'stretchPolicy':'warn_only','stretchWarningIslandCount':sum(p['areaWeightedStretchP95']>2 for p in metrics),'seconds':time.perf_counter()-start,'globalOverlapChecked':False,'circleBoundaryUsed':False,'faceIsolationUsed':False}
    if diagnostics_directory:
        out=Path(diagnostics_directory);out.mkdir(parents=True,exist_ok=True);np.savez_compressed(out/'macro-parameterized.npz',vertices=result.vertices,faces=result.faces,uv=uv,sourceVertex=vertex,sourceFace=face)
        (out/'macro-parameterized.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    return result,uv,vertex,face,receipt
