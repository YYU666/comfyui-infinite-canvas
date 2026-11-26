"""Coarse constrained xatlas charts with bounded convex harmonic repair.
No face isolation, source geometry changes, or parameter search.
"""
import numpy as np
import trimesh

def _harmonic(vertices,faces,loop):
    from native3d_uv_slim import _edges, _distortion
    from scipy.sparse import coo_matrix,diags
    from scipy.sparse.linalg import spsolve
    edges,_,_=_edges(faces)
    # Uniform angular spacing avoids numerically collapsed short boundary edges.
    angle=np.arange(len(loop))*2*np.pi/len(loop)
    uv=np.zeros((len(vertices),2));uv[loop]=np.column_stack((np.cos(angle),np.sin(angle)))
    row=np.r_[edges[:,0],edges[:,1]];col=np.r_[edges[:,1],edges[:,0]]
    w=coo_matrix((np.ones(len(row)),(row,col)),shape=(len(vertices),len(vertices))).tocsr()
    lap=diags(np.asarray(w.sum(axis=1)).ravel())-w;inside=np.setdiff1d(np.arange(len(vertices)),loop)
    if len(inside):uv[inside]=spsolve(lap[inside][:,inside],-lap[inside][:,loop]@uv[loop])
    edge=uv[faces][:,1:]-uv[faces][:,:1];signed=edge[:,0,0]*edge[:,1,1]-edge[:,0,1]*edge[:,1,0]
    if np.all(signed<0):uv[:,0]*=-1;signed=-signed
    if not np.isfinite(uv).all() or np.any(signed<=0):raise ValueError('Convex harmonic repair has degenerate/flipped UV')
    return uv,_distortion(vertices,faces,uv)

def parameterize_groups(mesh,groups,reasons,diagnostics_directory=None):
    import xatlas,igl
    from native3d_uv_slim import _fans,_components,_disk_parts,_distortion
    from native3d_uv_overlap import overlap_pairs
    covered=np.concatenate(groups)
    if not np.array_equal(np.sort(covered),np.arange(len(mesh.faces))):
        raise ValueError('Coarse charts require an exact source-face partition')
    owner=np.empty(len(mesh.faces),int)
    for i,group in enumerate(groups):owner[group]=i
    for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
        if tuple(sorted(map(int,edge))) in reasons and owner[pair[0]]==owner[pair[1]]:
            raise ValueError('Coarse xatlas cannot consume an intra-group frozen slit; create a new coarse plan')
    atlas=xatlas.Atlas();sources=[]
    for group in groups:
        s,inv=np.unique(mesh.faces[group],return_inverse=True)
        v,f,s=_fans(np.asarray(mesh.vertices)[s],inv.reshape(-1,3),s)
        atlas.add_mesh(np.asarray(v,np.float32),np.asarray(f,np.uint32));sources.append(s)
    chart=xatlas.ChartOptions();chart.max_cost=12.;chart.normal_deviation_weight=.1;chart.normal_seam_weight=0.;chart.texture_seam_weight=0.;chart.roundness_weight=.01;chart.straightness_weight=0.;chart.max_iterations=4
    pack=xatlas.PackOptions();pack.resolution=4096;pack.padding=16
    print("coarse: xatlas begin",flush=True)
    atlas.generate(chart_options=chart,pack_options=pack)
    print("coarse: xatlas charts="+str(atlas.chart_count),flush=True)
    outputs=[];records=[];repairs=0
    for index,group in enumerate(groups):
        print("coarse: group "+str(index)+" / "+str(len(groups))+" repairs="+str(repairs),flush=True)
        xref,f,uv=atlas[index];s=sources[index][xref];v=np.asarray(mesh.vertices)[s]
        if not np.array_equal(s[f],mesh.faces[group]):raise ValueError('xatlas source mapping changed')
        v,f,fan=_fans(v,f,np.arange(len(v)));s=s[fan];uv=uv[fan]
        for vv,ff,ss,sf in _components(v,f,s,np.asarray(group)):
            # Recover component local UV through source face corner identity.
            lookup={int(face):i for i,face in enumerate(group)}
            srcf=np.asarray([lookup[int(face)] for face in sf]);mapping={}
            for a,b in zip(ff.ravel(),f[srcf].ravel()):mapping[int(a)]=int(b)
            local=np.asarray([uv[mapping[i]] for i in range(len(vv))],float)
            extent=float(np.ptp(local,axis=0).max())
            if not np.isfinite(local).all() or not np.isfinite(extent) or extent<=0:
                raise ValueError('xatlas returned invalid or zero-extent chart coordinates')
            local=(local-local.min(0))/extent
            part=trimesh.Trimesh(vv,ff,process=False)
            edge=local[ff][:,1:]-local[ff][:,:1];signed=edge[:,0,0]*edge[:,1,1]-edge[:,0,1]*edge[:,1,0]
            if np.all(signed<0):local[:,0]*=-1;signed=-signed
            bad=np.any(signed<=0) or bool(overlap_pairs(part,local))
            if bad:
                repairs+=1
                for dv,df,ds,dsf,loop in _disk_parts(igl,vv,ff,ss,sf,{}):
                    repaired,metrics=_harmonic(dv,df,loop)
                    outputs.append((dv,df,ds,dsf,repaired));records.append({'repair':'fixed_convex_positive_harmonic',**metrics})
            else:
                outputs.append((vv,ff,ss,sf,local));records.append({'repair':None,**_distortion(vv,ff,local)})
    vertices=[];faces=[];uvs=[];source=[];source_face=[];offset=0
    for i,(v,f,s,sf,uv) in enumerate(outputs):
        uv=(uv-uv.min(0))/np.ptp(uv,axis=0).max();uv[:,0]+=i*2
        vertices.append(v);faces.append(f+offset);uvs.append(uv);source.append(s);source_face.append(sf);offset+=len(v)
    print('coarse: parameterized islands='+str(len(outputs))+' repairs='+str(repairs),flush=True)
    result=trimesh.Trimesh(np.concatenate(vertices),np.concatenate(faces),process=False)
    receipt={'backend':'xatlas relaxed charts + fixed convex positive harmonic repair','xatlasCharts':int(atlas.chart_count),'repairedCharts':repairs,'islands':len(outputs),'islandMetrics':records,'stretchPolicy':'warn_only','faceIsolation':False,'globalOverlapChecked':False}
    final_uv=np.concatenate(uvs);final_source=np.concatenate(source);final_faces=np.concatenate(source_face)
    if diagnostics_directory:
        import json
        from pathlib import Path
        folder=Path(diagnostics_directory);folder.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(folder/'coarse-parameterized.npz',vertices=result.vertices,faces=result.faces,
                            uv=final_uv,sourceVertex=final_source,sourceFace=final_faces)
        (folder/'coarse-parameterized.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    return result,final_uv,final_source,final_faces,receipt


def parameterize_coarse_harmonic(mesh,groups,reasons,diagnostics_directory=None):
    """Explicit coarse-plan fallback: no xatlas subdivision or free boundary solve."""
    import igl,json
    from pathlib import Path
    from native3d_uv_slim import _fans,_components,_disk_parts
    covered=np.concatenate(groups)
    if not np.array_equal(np.sort(covered),np.arange(len(mesh.faces))):raise ValueError('Invalid coarse partition')
    owner=np.empty(len(mesh.faces),int)
    for i,g in enumerate(groups):owner[g]=i
    for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
        if tuple(sorted(map(int,edge))) in reasons and owner[pair[0]]==owner[pair[1]]:raise ValueError('Coarse fallback refuses intra-group frozen slits')
    vs=[];fs=[];ss=[];sfs=[];us=[];records=[];offset=0
    for index,group in enumerate(groups):
        print('harmonic: group '+str(index)+' / '+str(len(groups)),flush=True)
        s,inv=np.unique(mesh.faces[group],return_inverse=True)
        v,f,s=_fans(np.asarray(mesh.vertices)[s],inv.reshape(-1,3),s)
        for vv,ff,sss,sf in _components(v,f,s,np.asarray(group)):
            for dv,df,ds,dsf,loop in _disk_parts(igl,vv,ff,sss,sf,{}):
                uv,metrics=_harmonic(dv,df,loop);uv=(uv-uv.min(0))/np.ptp(uv,axis=0).max();uv[:,0]+=2*len(records)
                vs.append(dv);fs.append(df+offset);ss.append(ds);sfs.append(dsf);us.append(uv);offset+=len(dv)
                records.append({'group':index,'faces':len(df),**metrics})
    result=trimesh.Trimesh(np.concatenate(vs),np.concatenate(fs),process=False);uv=np.concatenate(us);source=np.concatenate(ss);face=np.concatenate(sfs)
    for record in records:
        record['stretchWarnings']=[name for name,value,limit in (
            ('areaWeightedStretchP95',record['areaWeightedStretchP95'],2.),
            ('areaFractionStretchOver3',record['areaFractionStretchOver3'],.01)) if value>limit]
    receipt={'backend':'coarse fixed convex positive harmonic','groups':len(groups),'islands':len(records),'islandMetrics':records,
             'stretchPolicy':'warn_only','faceIsolation':False,'globalOverlapChecked':False,
             'stretchWarningIslandCount':sum(bool(r['stretchWarnings']) for r in records),
             'worstAreaWeightedStretchP95':max(r['areaWeightedStretchP95'] for r in records),
             'boundaryPolicy':'fixed uniformly-spaced convex circle; positive uniform harmonic weights',
             'densityPolicy':'one common average UV-area / surface-area ratio across islands; face density varies with stretch',
             'structurePolicy':'AI coarse regions and necessary topology seams; macro angle/AO chains not imposed'}
    if diagnostics_directory:
        folder=Path(diagnostics_directory);folder.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(folder/'harmonic-parameterized.npz',vertices=result.vertices,faces=result.faces,uv=uv,sourceVertex=source,sourceFace=face)
        (folder/'harmonic-parameterized.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8')
    return result,uv,source,face,receipt
