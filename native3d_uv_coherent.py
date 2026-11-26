"""Frozen-plan SLIM or legacy xatlas, world-up orientation and bounded packing.

No geometry edits or automatic hole repair. Reported stretch is measured; legacy
xatlas chart merge cost is a preference rather than a guaranteed bound.
"""
from pathlib import Path
import hashlib
import json
import numpy as np
import trimesh


def _pack_trial(extents,resolution,padding,order_mode=0,allow_rotation=False):
    def pack(scale):
        sizes=np.ceil(extents*scale).astype(int)+2*padding
        order=sorted(range(len(sizes)),key=lambda i: ((-int(max(sizes[i])),-int(np.prod(sizes[i])),i) if order_mode==0 else (-int(np.prod(sizes[i])),-int(max(sizes[i])),i)))
        free=[(0,0,resolution,resolution)];positions=np.zeros((len(sizes),2),dtype=int);rotations=np.zeros(len(sizes),dtype=bool)
        for i in order:
            width,height=map(int,sizes[i])
            if width>resolution or height>resolution:return None
            choices=[(min(w-a,h-b),max(w-a,h-b),rot,y,x,index,a,b) for rot,a,b in [(False,width,height)]+([(True,height,width)] if allow_rotation else []) for index,(x,y,w,h) in enumerate(free) if a<=w and b<=h]
            if not choices:return None
            _,_,rot,y,x,_,width,height=min(choices);positions[i]=[x,y];rotations[i]=rot;new=[]
            for fx,fy,fw,fh in free:
                if x>=fx+fw or x+width<=fx or y>=fy+fh or y+height<=fy:new.append((fx,fy,fw,fh));continue
                if x>fx:new.append((fx,fy,x-fx,fh))
                if x+width<fx+fw:new.append((x+width,fy,fx+fw-x-width,fh))
                if y>fy:new.append((fx,fy,fw,y-fy))
                if y+height<fy+fh:new.append((fx,y+height,fw,fy+fh-y-height))
            new=sorted(set(new));free=[]
            for j,r in enumerate(new):
                rx,ry,rw,rh=r
                if any(k!=j and rx>=q[0] and ry>=q[1] and rx+rw<=q[0]+q[2] and ry+rh<=q[1]+q[3] for k,q in enumerate(new)):continue
                free.append(r)
        return positions,rotations
    low=0.;high=resolution/max(float(extents.max()),1e-30)
    if pack(0.) is None:raise ValueError('Too many charts to preserve requested padding')
    for _ in range(40):
        middle=(low+high)/2
        if pack(middle) is None:high=middle
        else:low=middle
    positions,rotations=pack(low)
    return low,positions,rotations


def _pack_rectangles(extents,resolution,padding):
    """Legacy fixed-direction MaxRects retained for exact comparison."""
    scale,positions,_=_pack_trial(extents,resolution,padding)
    return scale,positions


def _pack_efficient(extents,resolution,padding):
    """Deterministic bounded heuristic search; one common scale, rigid quarter turns.

    Keep legacy as a candidate, so sampled alternatives cannot lower utilization.
    Favor fewer quarter turns when scales tie. No optimal-packing claim.
    """
    candidates=[_pack_trial(extents,resolution,padding,mode,rotate)
                for mode,rotate in ((0,False),(1,False),(0,True),(1,True))]
    return max(candidates,key=lambda c:(c[0],-int(c[2].sum())))


def _pack_contours(mesh, charts, resolution, padding, allow_rotation=True):
    """Bounded conservative contour raster search; final geometry is checked.

    Rasterization only chooses positions. Output is rigid chart transforms with
    one shared scale, never raster-deformed UVs. No native UV repacker required.
    """
    if len(charts)>256:raise ValueError('Contour search limited to 256 islands')
    from PIL import Image, ImageDraw
    from scipy.ndimage import binary_dilation
    from scipy.signal import fftconvolve
    grid=512;unit=resolution/grid;border=int(np.ceil(padding/(2*unit)))+1
    chart_faces=[]
    for used,local,_ in charts:
        inverse=np.full(len(mesh.vertices),-1,dtype=int);inverse[used]=np.arange(len(used))
        mask=np.all(np.isin(mesh.faces,used),axis=1);chart_faces.append(inverse[mesh.faces[mask]])
    order=sorted(range(len(charts)),key=lambda i:(-float(np.prod(charts[i][2])),-len(chart_faces[i]),i))
    def attempt(scale,order):
        occupied=np.zeros((grid,grid),bool);placed=[]
        outer=max(0,int(np.ceil(padding/unit))-border)
        if outer:occupied[:outer]=True;occupied[-outer:]=True;occupied[:,:outer]=True;occupied[:,-outer:]=True
        for i in order:
            used,local,extent=charts[i];choices=[]
            for turn in ((0,1) if allow_rotation else (0,)):
                points=local.copy()
                if turn:points=np.column_stack((-points[:,1],points[:,0]));points-=points.min(0)
                points*=scale/unit
                size=np.ceil(np.ptp(points,axis=0)).astype(int)+2*border+1
                if np.any(size>grid):continue
                image=Image.new('1',tuple(size));draw=ImageDraw.Draw(image)
                for face in chart_faces[i]:draw.polygon([tuple(v) for v in points[face]+border],fill=1)
                shape=binary_dilation(np.asarray(image,dtype=bool),iterations=border)
                collision=fftconvolve(occupied.astype(float),shape[::-1,::-1].astype(float),mode='valid')
                ys,xs=np.nonzero(collision<.5)
                if len(xs):
                    # Bottom-left placement; tie prefers original mean direction.
                    j=np.argmin(ys*grid+xs);choices.append((int(ys[j]),int(xs[j]),turn,shape,points))
            if not choices:return None
            y,x,turn,shape,points=min(choices,key=lambda c:(c[0],c[1],c[2]))
            h,w=shape.shape;occupied[y:y+h,x:x+w]|=shape
            placed.append((i,points,np.array([x,y])+border,turn))
        output=np.zeros((len(mesh.vertices),2),float)
        for i,points,position,turn in placed:output[charts[i][0]]=(points+position)*unit/resolution
        return output
    best=None;best_scale=0.
    orders=[order,sorted(range(len(charts)),key=lambda i:(-float(max(charts[i][2])),-float(np.prod(charts[i][2])),i)),sorted(range(len(charts)),key=lambda i:(-float(np.sum(mesh.area_faces[np.all(np.isin(mesh.faces,charts[i][0]),axis=1)])),i))]
    for trial_order in orders:
        low=0.;high=resolution/np.sqrt(max(float(mesh.area),1e-30))
        for _ in range(9):
            middle=(low+high)/2;candidate=attempt(middle,trial_order)
            if candidate is None:high=middle
            else:
                low=middle
                if middle>best_scale:best_scale=middle;best=candidate
    if best is None:raise ValueError('Contour raster packing could not fit requested padding')
    return best


def _chart_up(mesh,face_ids,uv):
    """Area-weighted UV derivative of tangent-projected world +Y."""
    triangles=np.asarray(mesh.vertices)[mesh.faces[face_ids]];tex=uv[mesh.faces[face_ids]]
    edge=triangles[:,1:]-triangles[:,:1];target=tex[:,1:]-tex[:,:1]
    gram=np.einsum('fki,fli->fkl',edge,edge)
    area=np.asarray(mesh.area_faces)[face_ids]
    answers=[]
    for axis in (np.array([0.,1.,0.]),np.array([0.,0.,1.]),np.array([1.,0.,0.])):
        rhs=np.einsum('fki,i->fk',edge,axis);coeff=np.linalg.solve(gram,rhs[...,None])[...,0]
        direction=np.einsum('fk,fki->fi',coeff,target)
        projected=np.einsum('fk,fki->fi',coeff,edge);strength=np.linalg.norm(projected,axis=1)
        direction/=np.maximum(np.linalg.norm(direction,axis=1)[:,None],1e-30)
        weights=area*strength;vector=(direction*weights[:,None]).sum(0)
        confidence=float(np.linalg.norm(vector)/max(weights.sum(),1e-30))
        support=float(np.sum(area*(strength>.2))/max(area.sum(),1e-30))
        answers.append((vector,confidence,support,axis.tolist()))
    # World-up degeneracy on horizontal surfaces is explicit, never fake Y evidence.
    if answers[0][2]>.2 and answers[0][1]>.1:return answers[0]
    return max(answers[1:],key=lambda answer:answer[1]*answer[2])


def direction_metrics(mesh,uv):
    triangles=np.asarray(mesh.vertices)[mesh.faces];tex=uv[mesh.faces]
    edge=triangles[:,1:]-triangles[:,:1];target=tex[:,1:]-tex[:,:1]
    gram=np.einsum('fki,fli->fkl',edge,edge);rhs=edge[:,:,1]
    coeff=np.linalg.solve(gram,rhs[...,None])[...,0]
    projected=np.einsum('fk,fki->fi',coeff,edge);direction=np.einsum('fk,fki->fi',coeff,target)
    supported=np.linalg.norm(projected,axis=1)>.2
    area=np.asarray(mesh.area_faces);weights=area[supported]
    if not len(weights):return {'worldUpSupportedAreaFraction':0.,'worldUpAngleP95Degrees':None,'worldUpOppositeAreaFraction':None}
    vectors=direction[supported];angles=np.degrees(np.arccos(np.clip(vectors[:,1]/np.maximum(np.linalg.norm(vectors,axis=1),1e-30),-1,1)))
    order=np.argsort(angles);cumulative=np.cumsum(weights[order])/weights.sum()
    return {'worldUpSupportedAreaFraction':float(weights.sum()/area.sum()),
        'worldUpAngleP50Degrees':float(np.interp(.5,cumulative,angles[order])),
        'worldUpAngleP95Degrees':float(np.interp(.95,cumulative,angles[order])),
        'worldUpAngleMaxDegrees':float(angles.max()),
        'worldUpOppositeAreaFraction':float(weights[angles>90].sum()/weights.sum())}


def coherent_unwrap(mesh,params,face_labels=None,high_guided_evidence=None,_overlap_state=None,_frozen_plan=None,progress=None):
    from native3d_uv import structural_edges,groups_from_edges,uv_metrics,uv_geometry_metrics
    from native3d_uv_ao import label_boundaries
    from native3d_uv_perf import ExactGeometryMetrics,UVStageTimer
    timer=UVStageTimer(progress);timer.enter('uv_prepare')
    geometry_checks=ExactGeometryMetrics(uv_geometry_metrics)
    tolerance=float(params.get('chartMergeCost',8.));alignment=params.get('alignDirection','world_up')
    resolution=params.get('resolution',1024);padding=params.get('padding',8)
    if alignment not in ('world_up','none') or (_frozen_plan is None and not 2<=tolerance<=20):raise ValueError('Invalid coherent chartMergeCost/alignDirection')
    if resolution not in (1024,2048,4096) or type(padding) is not int or not 1<=padding<=32:raise ValueError('Invalid coherent resolution/padding')
    limit=100000 if _frozen_plan is not None else 20000
    if not 1<=len(mesh.faces)<=limit or not np.isfinite(mesh.vertices).all() or not mesh.nondegenerate_faces().all():raise ValueError('Coherent UV requires1..'+str(limit)+' finite nondegenerate triangles')
    _,counts=np.unique(mesh.edges_sorted,axis=0,return_counts=True)
    if np.any(counts>2):raise ValueError('Coherent UV rejects nonmanifold edges')
    _,_,reasons=structural_edges(mesh,{**params,'concaveAngleDegrees':180.,'sharpAngleDegrees':180.})
    high_report=None
    if _frozen_plan is not None:
        reasons=dict(_frozen_plan['reasons']);groups=[np.asarray(group,dtype=np.int64) for group in _frozen_plan['groups']]
        high_report={'planSha256':_frozen_plan['planSha256'],'scope':'Frozen reviewed partition and seam constraints; no PartField/AO recomputation in unwrap'}
    elif high_guided_evidence is not None:
        if face_labels is not None:raise ValueError('Choose either low-source labels or high-guided evidence')
        from native3d_uv_ao import high_guided_seams
        high_reasons,high_report=high_guided_seams(mesh,params,high_guided_evidence)
        reasons.update(high_reasons)
    elif face_labels is not None:reasons.update(label_boundaries(mesh,face_labels))
    if _frozen_plan is not None:
        pass
    elif high_guided_evidence is not None:
        labels=np.asarray(high_guided_evidence['labels']);groups=groups_from_edges(mesh,reasons,partition_labels=labels)
        owner=np.zeros(len(mesh.faces),int)
        for index,group in enumerate(groups):owner[group]=index
        guard=0;topology_guard=0
        for pair,edge in zip(mesh.face_adjacency,mesh.face_adjacency_edges):
            key=tuple(sorted(map(int,edge)))
            if owner[pair[0]]!=owner[pair[1]] and key not in reasons:
                if labels[pair[0]]<0 or labels[pair[1]]<0:reasons[key]='high_surface_uncertain_group_guard';guard+=1
                else:reasons[key]='coherent_constrained_group_boundary';topology_guard+=1
        high_report.update({'uncertainBridgeGuardEdges':guard,'additionalConstrainedTopologyBoundaryEdges':topology_guard,'totalAdditionalGroupBoundaryEdges':guard+topology_guard,'groupsWithMixedSupportedLabels':sum(len(set(labels[g][labels[g]>=0]))>1 for g in groups),'unknownGroupingPolicy':'Unknown faces may attach topologically to at most one supported region through deterministic constrained unions; their label remains-1 and they never gain AO support. Distinct supported regions cannot merge through unknown bridges.','groupsContainingUnknownFaces':sum(bool(np.any(labels[g]<0)) for g in groups)})
    else:groups=groups_from_edges(mesh,reasons)
    # Retry only with additional source-face boundary cuts. Original geometry,
    # face order and neural/AO labels remain untouched across every attempt.
    state=_overlap_state or {'isolated':set(),'rounds':[]}
    isolated=state['isolated']
    if isolated:
        split=[]
        for group in groups:
            remaining=group[~np.isin(group,list(isolated))]
            if len(remaining):split.append(remaining)
            split.extend(np.asarray([face],dtype=np.int64) for face in sorted(set(map(int,group))&isolated))
        groups=split
    timer.enter('uv_parameterization')
    parameterization=None
    if _frozen_plan is not None:
        if isolated or state['rounds']:raise ValueError('Frozen SLIM does not permit face-isolation overlap repair')
        if _frozen_plan.get('parameterizationBackend')=='ai_coarse_harmonic_v3':
            from native3d_uv_xatlas_coarse import parameterize_coarse_harmonic as parameterize_groups
        elif _frozen_plan.get('parameterizationBackend')=='macro_natural1':
            from native3d_uv_macro import parameterize_groups
        elif _frozen_plan.get('parameterizationBackend')=='macro_uvatlas1':
            from native3d_uv_uvatlas import parameterize_groups
        else:
            from native3d_uv_slim import parameterize_groups
        result,uv,source,face_sources,parameterization=parameterize_groups(mesh,groups,reasons,params.get('diagnosticsDirectory'))
        uv=np.asarray(uv,dtype=float).copy();source=np.asarray(source,dtype=np.int64);face_sources=np.asarray(face_sources,dtype=np.int64)
        if (source.shape!=(len(result.vertices),) or face_sources.shape!=(len(result.faces),) or
            uv.shape!=(len(result.vertices),2) or not np.isfinite(uv).all() or
            np.any(source<0) or np.any(source>=len(mesh.vertices)) or
            not np.array_equal(np.sort(face_sources),np.arange(len(mesh.faces))) or
            not np.array_equal(result.vertices,np.asarray(mesh.vertices)[source]) or
            not np.array_equal(source[result.faces],np.asarray(mesh.faces)[face_sources])):
            raise ValueError('Frozen SLIM exact source geometry/triangle mapping mismatch')
        # Every reviewed cut must survive as a real split edge (original boundary
        # edges already are seams); extra topological disk cuts are permitted.
        output_edges=np.unique(np.sort(np.asarray(result.edges),axis=1),axis=0)
        mapped_edges=np.sort(source[output_edges],axis=1)
        original,counts=np.unique(mesh.edges_sorted,axis=0,return_counts=True)
        boundaries={tuple(map(int,e)) for e in original[counts==1]}
        keys,counts=np.unique(mapped_edges,axis=0,return_counts=True)
        splits={tuple(map(int,e)) for e in keys[counts>1]}|boundaries
        missing=set(reasons)-splits
        if missing:raise ValueError('Frozen SLIM missing reviewed UV seams: '+str(len(missing)))
        # SLIM returns unit-extent charts translated into disjoint two-unit
        # slots. Preserve that local scale for the 1e-12 intersection tolerance.
        initial_uv=uv
    else:
        import xatlas
        atlas=xatlas.Atlas();sources=[]
        for group in groups:
            source,inverse=np.unique(np.asarray(mesh.faces)[group].reshape(-1),return_inverse=True)
            atlas.add_mesh(np.asarray(mesh.vertices[source],np.float32),inverse.reshape(-1,3).astype(np.uint32));sources.append(source)
        chart=xatlas.ChartOptions();chart.max_cost=tolerance;chart.normal_deviation_weight=.1;chart.normal_seam_weight=0.;chart.texture_seam_weight=0.;chart.roundness_weight=.01;chart.straightness_weight=0.;chart.max_iterations=4
        pack=xatlas.PackOptions();pack.resolution=resolution;pack.padding=padding;pack.rotate_charts=False;pack.rotate_charts_to_axis=False
        atlas.generate(chart_options=chart,pack_options=pack)
        if atlas.atlas_count!=1:raise ValueError('Coherent initial atlas produced multiple tiles')
        vertices=[];faces=[];uvs=[];xrefs=[];face_sources=[];offset=0
        for index,group in enumerate(groups):
            xref,triangles,uv=atlas[index];source=sources[index][np.asarray(xref)]
            if not np.array_equal(source[triangles],np.asarray(mesh.faces)[group]):raise ValueError('Coherent source triangle mapping mismatch')
            vertices.append(np.asarray(mesh.vertices)[source]);faces.append(triangles+offset);uvs.append(np.asarray(uv)*[atlas.width,atlas.height]);xrefs.append(source);face_sources.extend(group.tolist());offset+=len(source)
        result=trimesh.Trimesh(np.concatenate(vertices),np.concatenate(faces),process=False);uv=np.concatenate(uvs);source=np.concatenate(xrefs);face_sources=np.asarray(face_sources)
        initial_uv=uv/np.array([atlas.width,atlas.height])
    def save_rejected_slim_diagnostic(reason, conflicts=None):
        if not params.get('diagnosticsDirectory'):return
        from PIL import Image,ImageDraw
        folder=Path(params['diagnosticsDirectory']);folder.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(folder/'uv-rejected-diagnostic.npz',vertices=result.vertices,faces=result.faces,
                            uv=initial_uv,sourceVertex=source,sourceFace=face_sources)
        # Display each existing chart in a grid without changing the solver UV.
        # This review layout is never exported as accepted model coordinates.
        charts=trimesh.graph.connected_components(result.face_adjacency,nodes=np.arange(len(result.faces)),min_len=1)
        side=int(np.ceil(np.sqrt(len(charts))));size=2048;cell=size/side
        image=Image.new('RGB',(size,size),(25,25,25));draw=ImageDraw.Draw(image)
        for index,chart in enumerate(charts):
            ids=np.asarray(chart);points=initial_uv[result.faces[ids]];lo=points.min(axis=(0,1));extent=float(np.ptp(points,axis=(0,1)).max())
            if not np.isfinite(extent) or extent<=0:continue
            points=(points-lo)/extent*(cell*.9)+[index%side*cell+cell*.05,index//side*cell+cell*.05]
            for triangle in points:draw.polygon([tuple(p) for p in triangle],outline=(240,180,70))
        image.save(folder/'uv-rejected-layout.png')
        diagnostic={'status':'rejected_needs_review','acceptedUV':False,'bakeAllowed':False,
                    'reason':reason,'overlapPairs':None if conflicts is None else len(conflicts),
                    'conflictSamples':[] if conflicts is None else [list(map(int,p)) for p in conflicts[:64]],
                    'parameterization':parameterization,'layoutMeaning':'Separate chart review grid; original solver UV retained in NPZ; not an accepted packed atlas'}
        (folder/'uv-rejected-report.json').write_text(json.dumps(diagnostic,indent=2),encoding='utf-8')
    from native3d_uv_overlap import overlap_pairs,conflict_cover
    timer.enter('uv_overlap')
    try:conflicts=overlap_pairs(result,initial_uv)
    except ValueError as error:
        if _frozen_plan is not None:
            save_rejected_slim_diagnostic(str(error))
            raise ValueError('Frozen SLIM parameterization rejected: UV overlap; face-isolation repair disabled') from error
        raise
    if conflicts:
        if _frozen_plan is not None:
            save_rejected_slim_diagnostic('UV overlap',conflicts)
            raise ValueError('Frozen SLIM parameterization rejected: '+str(len(conflicts))+' UV overlap pairs; face-isolation repair disabled')
        selected=set(conflict_cover([(face_sources[a],face_sources[b]) for a,b in conflicts]))
        added=selected-isolated
        budget=min(64,max(2,int(np.ceil(len(mesh.faces)*.02))))
        # Preserve bounded evidence before rejecting a repair budget. These are
        # diagnostic triangle areas, not an overlap-area or quality exemption.
        normalized=uv/np.array([atlas.width,atlas.height])
        samples=[]
        for a,b in conflicts[:64]:
            triangle=normalized[result.faces[[a,b]]]
            edge=triangle[:,1:]-triangle[:,:1]
            signed=(edge[:,0,0]*edge[:,1,1]-edge[:,0,1]*edge[:,1,0])*.5
            sa,sb=map(int,face_sources[[a,b]])
            samples.append({'atlasFaces':[int(a),int(b)],'sourceFaces':[sa,sb],
                'triangleSignedUVAreas':signed.tolist(),
                'sharedSourceVertices':len(set(mesh.faces[sa])&set(mesh.faces[sb])),
                'oppositeOrientation':bool(signed[0]*signed[1]<0)})
        print(json.dumps({'stage':'uv_overlap_diagnostic','overlapPairs':len(conflicts),
            'repairRound':len(state['rounds']),'isolatedFaces':len(isolated),'newCoverFaces':len(added),
            'faceBudget':budget,'sampleLimit':64,'conflictSamples':samples}),flush=True)
        if not added or len(state['rounds'])>=3 or len(isolated|added)>budget:
            raise ValueError('Coherent UV overlap repair blocked: bounded face/round budget exhausted')
        next_state={'isolated':isolated|added,'rounds':state['rounds']+[{'overlapPairs':len(conflicts),'isolatedSourceFaces':sorted(added)}]}
        timer.finish()
        retried,retry_report=coherent_unwrap(mesh,params,face_labels,high_guided_evidence,next_state,_frozen_plan,progress=progress)
        totals=retry_report.setdefault('stageTimingsSeconds',{})
        for stage,seconds in timer.seconds.items():totals[stage]=totals.get(stage,0.)+seconds
        return retried,retry_report
    timer.enter('uv_orient_pack')
    components=trimesh.graph.connected_components(result.face_adjacency,nodes=np.arange(len(result.faces)),min_len=1)
    if isolated and len(components)>256:
        raise ValueError('Coherent UV overlap repair blocked: 256-island budget exceeded')
    charts=[];chart_records=[];total_area=float(result.area)
    for component in components:
        ids=np.asarray(component);used=np.unique(result.faces[ids]);vector,confidence,support,axis=_chart_up(result,ids,uv)
        theta=np.pi/2-np.arctan2(vector[1],vector[0]) if alignment=='world_up' else 0.
        rotation=np.array([[np.cos(theta),-np.sin(theta)],[np.sin(theta),np.cos(theta)]])
        aligned_vector=rotation@vector
        residual=float(abs(np.degrees(np.arctan2(aligned_vector[0],aligned_vector[1]))))
        local=uv[used]@rotation.T;local-=local.min(0)
        tex=uv[result.faces[ids]];edges=tex[:,1:]-tex[:,:1]
        uv_area=float((np.abs(edges[:,0,0]*edges[:,1,1]-edges[:,0,1]*edges[:,1,0])*.5).sum())
        source_area=float(result.area_faces[ids].sum())
        if uv_area<=1e-20:raise ValueError('Coherent chart has zero UV area')
        density_scale=float(np.sqrt(source_area/uv_area))
        local*=density_scale;extent=np.ptp(local,axis=0)
        charts.append((used,local,extent));chart_records.append({'triangles':len(ids),'sourceAreaFraction':float(result.area_faces[ids].sum()/total_area),
            'referenceAxis':axis,'directionConfidence':confidence,'axisSupportAreaFraction':support,
            'densityNormalizationScale':density_scale,'sourceArea':source_area,'initialUVArea':uv_area,
            'rotationDegrees':float(np.degrees(theta)),'worldUpResidualDegrees':residual if axis==[0.,1.,0.] else None})
    annular_plan = _frozen_plan is not None and _frozen_plan.get('parameterizationBackend') == 'annular_main_seams'
    packing=params.get('packingMode','efficient')
    if packing not in ('efficient','legacy_fixed'):raise ValueError('Invalid coherent packingMode')
    extents=np.asarray([c[2] for c in charts])
    macro_pack=_frozen_plan is not None and _frozen_plan.get('parameterizationBackend') in ('macro_natural1','macro_uvatlas1')
    pack_receipt=None
    if macro_pack:
        from native3d_uv_pack import pack_natural_charts
        uv,pack_receipt=pack_natural_charts(result,charts,resolution,padding)
        scale=pack_receipt['scale']
        for record in chart_records:record['packingRotationDegrees']=0
    else:
        if packing=='legacy_fixed':
            scale,positions=_pack_rectangles(extents,resolution,padding);rotations=np.zeros(len(charts),dtype=bool)
        else:scale,positions,rotations=_pack_efficient(extents,resolution,padding)
        for index,((used,local,_),position,rotated) in enumerate(zip(charts,positions,rotations)):
            if rotated:local=np.column_stack((-local[:,1],local[:,0]));local-=local.min(0)
            uv[used]=(local*scale+position+padding)/resolution
            chart_records[index]['packingRotationDegrees']=90 if rotated else 0
    contour_status='pack_only_preserves_natural_shapes' if macro_pack else 'not_requested';packing_backend='xatlas_uv_only' if macro_pack else 'rectangles'
    if not macro_pack and packing=='efficient' and len(charts)>256:
        contour_status='skipped: contour search limited to 256 islands'
    if not macro_pack and packing=='efficient' and len(charts)<=256:
        # Compare real triangle area. A contour candidate may not silently trade
        # density, chart continuity, overlap or requested geometric spacing.
        try:
            timer.enter('uv_contour_pack')
            candidate=_pack_contours(result,charts,resolution,padding)
            timer.enter('uv_contour_geometry')
            candidate_metrics=geometry_checks.evaluate(result,candidate,resolution,padding)
            current_area=float(result.area)*scale*scale/(resolution*resolution)
            valid=(candidate_metrics['geometricOverlapPairs']==0 and candidate_metrics['geometricPaddingViolationPairs']==0
                   and candidate_metrics['geometricOutOfBoundsTriangles']==0 and candidate_metrics['geometricTileMarginPixels']>=padding-1e-4)
            if valid and candidate_metrics['triangleUVAreaSumRatio']>current_area*(1+1e-6):
                uv=candidate;packing_backend='contours';contour_status='selected'
                for record,(used,local,_) in zip(chart_records,charts):
                    edge=local-local.mean(0);target=uv[used]-uv[used].mean(0)
                    angle=float(np.degrees(np.arctan2(np.sum(edge[:,0]*target[:,1]-edge[:,1]*target[:,0]),np.sum(edge*target))))
                    record['packingRotationDegrees']=angle
            else:contour_status='rejected_geometry_or_no_area_gain'
        except (ValueError,RuntimeError) as error:contour_status='rejected: '+str(error)
    timer.enter('uv_output_prepare')
    result.visual=trimesh.visual.TextureVisuals(uv=uv)
    if hasattr(mesh.visual,'material'):result.visual.material=mesh.visual.material.copy()
    if getattr(mesh.visual,'face_materials',None) is not None:result.visual.face_materials=np.asarray(mesh.visual.face_materials)[face_sources]
    result.vertex_normals=np.asarray(mesh.vertex_normals)[source]
    result.vertex_attributes={k:np.asarray(v)[source].copy() for k,v in mesh.vertex_attributes.items()};result.face_attributes={k:np.asarray(v)[face_sources].copy() for k,v in mesh.face_attributes.items()}
    result.metadata=dict(mesh.metadata);result.metadata.update({'nativeSourceUV':True,'uvSourceVertex':source.tolist(),'uvSourceFace':face_sources.tolist()})
    if params.get('diagnosticsDirectory'):
        folder=Path(params['diagnosticsDirectory']);folder.mkdir(parents=True,exist_ok=True)
        np.savez_compressed(folder/'packed-uv-unchecked.npz',vertices=result.vertices,faces=result.faces,
                            uv=uv,sourceVertex=source,sourceFace=face_sources)
    timer.enter('uv_raster')
    metrics,_=uv_metrics(result,uv,resolution,padding)
    timer.enter('uv_final_geometry')
    metrics.update(geometry_checks.evaluate(result,uv,resolution,padding))
    if macro_pack or annular_plan:
        exported_uv=uv.astype('f4').astype(float)
        float_metrics=geometry_checks.evaluate(result,exported_uv,resolution,padding)
        float_raster,_=uv_metrics(result,exported_uv,resolution,padding)
        tex=exported_uv[np.asarray(result.faces)];edge=tex[:,1:]-tex[:,:1]
        signed=edge[:,0,0]*edge[:,1,1]-edge[:,0,1]*edge[:,1,0]
        if (np.any(signed<=0) or float_metrics['geometricOverlapPairs'] or float_metrics['geometricPaddingViolationPairs']
                or float_metrics['geometricOutOfBoundsTriangles'] or float_raster['overlapInteriorPixels']):
            raise ValueError('Natural UV float32 export geometry/spacing failed')
        if pack_receipt is not None:
            pack_receipt['float32Geometry']=float_metrics
            pack_receipt['float32Raster']=float_raster
            pack_receipt['float32NonpositiveTriangles']=int(np.sum(signed<=0))
    if annular_plan and (len(charts) != 4 or parameterization['extraCutCount']):
        raise ValueError('Annular UV requires exactly four islands with no additional cuts')
    timer.enter('uv_finalize')
    if metrics['geometricOverlapPairs'] or metrics['overlapInteriorPixels']:
        raise ValueError('Coherent UV blocked: final geometric/raster overlap gate failed')
    for record in chart_records:
        if record['worldUpResidualDegrees'] is not None:record['worldUpMeanAfterPackingDegrees']=abs((record['packingRotationDegrees']+180)%360-180)
    direction=direction_metrics(result,uv)
    verified=metrics['paddingCollisionPixels']==0 and metrics['tileEdgeMarginPixels']>=padding-1e-7
    report={'backend':'xatlas0.0.11 relaxed charts + bounded contour raster / MaxRects search','packingMode':packing,'packingBackend':packing_backend,'contourPackingCandidate':contour_status,'contourSearchGrid':512,'contourSearchMaxIslands':256,'contourSearchOrders':3,'contourSearchScaleSteps':9,'packingQuarterTurnCount':sum(abs(c['packingRotationDegrees'])>45 for c in chart_records),'packingScale':float(np.sqrt(metrics['triangleUVAreaSumRatio']*resolution*resolution/result.area)),'seamStrategy':'coherent','status':'needs_review',
        'overlapRepair':{'rounds':state['rounds'],'isolatedSourceFaces':sorted(isolated),'maxRounds':3,'maxIsolatedFaces':min(64,max(2,int(np.ceil(len(mesh.faces)*.02)))),'maxRepairIslands':256,'policy':'deterministic maximum-conflict-degree cover; additional face-boundary cuts and fresh xatlas; no geometry or evidence edits'},
        'densityNormalization':'Per-chart isotropic sqrt(3D triangle area / UV triangle area), then one shared packing scale; stretch and UV handedness unchanged',
        'initialChartMeanDensityMaxMin':float(max(np.sqrt(c['initialUVArea']/c['sourceArea']) for c in chart_records)/min(np.sqrt(c['initialUVArea']/c['sourceArea']) for c in chart_records)),
        'chartMergeCost':tolerance,'chartMergeCostMeaning':'xatlas max_cost preference; actual stretch is measured separately, not guaranteed',
        'alignDirection':alignment,'structuralGroups':len(groups),'requestedSeams':len(reasons),'exactTriangleMapping':True,
        'geometrySha256':hashlib.sha256(np.asarray(mesh.vertices).tobytes()+np.asarray(mesh.faces).tobytes()).hexdigest(),
        'resolution':resolution,'packingOrientation':'Area-weighted projected world +Y before packing; optional rigid 90 degree turns recorded per chart and final face direction measured',
        'smallIslandAreaThresholdFraction':.005,'smallIslandCount':sum(c['sourceAreaFraction']<.005 for c in chart_records),
        'smallIslandTotalAreaFraction':sum(c['sourceAreaFraction'] for c in chart_records if c['sourceAreaFraction']<.005),
        'chartDirections':chart_records,'paddingVerifiedAtPixelCenters':verified,**metrics,**direction,
        'limitations':['Relaxed charts can trade fewer islands for stretch; never accepted by island count alone.','World +Y projection is undefined on horizontal surfaces; explicit +Z/+X fallback is reported.','A single rigid chart rotation aligns mean direction, not every curved surface tangent.','512-cell contour raster / rectangle search is a bounded heuristic, not an optimal packing guarantee; quarter turns trade exact world-up alignment for utilization.','Pixel-center overlap checks are not exhaustive subpixel proofs.']}
    if pack_receipt is not None:report['naturalPacking']=pack_receipt
    if parameterization is not None:
        report.update(backend=parameterization.get('backend','libigl SLIM fixed20')+' + bounded contour raster / MaxRects search',parameterization=parameterization,
                      overlapRepair={'enabled':False,'rounds':[],'isolatedSourceFaces':[],'policy':'SLIM overlap rejects; no face-isolation repair'},
                      frozenPlanUnchanged=True,reviewedSeamsVerified=True,
                      stretchPolicy=parameterization.get('stretchPolicy'),
                      stretchWarningIslandCount=parameterization.get('stretchWarningIslandCount',0),
                      additionalSeamPolicy='Topology disk cutgraph seams added by parameterization; frozen reviewed groups/reasons remain unchanged')
        report.pop('chartMergeCost',None);report.pop('chartMergeCostMeaning',None)
        report['limitations'][0]='Necessary topology disk cuts can add seams; actual stretch is measured and may be large.'
        if macro_pack:
            report['backend']=parameterization['backend']+' + xatlas UV pack-only'
            report['overlapRepair']={'enabled':True,'isolatedSourceFaces':[],'policy':'Measured fold patches of at least8 faces, bounded local xatlas rechart, or verified neighbor merge; no deliberate single-face isolation'}
            report['additionalSeamPolicy']='Raw xatlas chart boundaries and measured fold repairs; all frozen macro hard seams preserved'
            report['packingOrientation']='World-up chart alignment preserved; packing rotations disabled'
            report['limitations'][3]='xatlas pack-only preserves natural chart shapes and common density; no optimal occupancy guarantee.'
            if _frozen_plan.get('parameterizationBackend')=='macro_uvatlas1':
                report['overlapRepair']={'enabled':False,'isolatedSourceFaces':[],'policy':'UVAtlas partitioning; independent overlap rejection; no deliberate single-face isolation'}
                report['additionalSeamPolicy']='UVAtlas chart boundaries; all frozen macro hard seams explicitly verified'
        if _frozen_plan.get('parameterizationBackend')=='ai_coarse_harmonic_v3':
            report['overlapRepair']['policy']='Fixed convex boundary positive harmonic; global overlap rejects; no face isolation'
            report['densityPolicy']=parameterization['densityPolicy']
            report['structurePolicy']=parameterization['structurePolicy']
            if (metrics['degenerateUVTriangles'] or metrics['mixedOrientationTriangles'] or metrics['geometricPaddingViolationPairs'] or metrics['geometricOutOfBoundsTriangles'] or not verified):
                raise ValueError('Coarse harmonic final geometry/spacing/orientation gate failed')
    if annular_plan:
        report['float32Geometry'] = float_metrics
        report['additionalSeamPolicy'] = 'Four annular regions and one opening cut per region; additional cuts rejected'
        report['seamReasons'] = {'%d:%d'%edge: reason for edge, reason in reasons.items()}
    elif high_report is not None:
        report['highGuidedUV']=high_report
        report['seamReasons']={'%d:%d'%edge:reason for edge,reason in reasons.items()}
    if high_guided_evidence is not None:
        darkness=np.asarray(high_guided_evidence['darkness'],dtype='<f8')
        supported=np.asarray(high_guided_evidence['supported']).tolist()
        report['aoGeometry']={'backend':'Open3D CPU high-surface samples projected to target','referenceUsed':True,'highSourceSha256':high_guided_evidence['highSourceSha256'],'targetSourceSha256':high_guided_evidence['targetSourceSha256'],'raySamplesPerFace':None,'raySamplesPerHighSurfacePoint':high_guided_evidence['raySamples'],'queryCount':high_guided_evidence['queryCount'],'raysCast':high_guided_evidence['raysCast'],'faceDarkness':darkness.tolist(),'darknessSha256':hashlib.sha256(darkness.tobytes()).hexdigest(),'referenceSupportedFaces':supported,'supported':supported,'scope':'Per-target-face AO is a gated projection of original high-surface samples, not target-face raycasting.'}
        report['seamReasons']={'%d:%d'%edge:reason for edge,reason in reasons.items()}
    report['qualityFlags']={'exactGeometry':True,'rasterOverlapFree':metrics['overlapInteriorPixels']==0,'nondegenerateUV':metrics['degenerateUVTriangles']==0,'noMixedFlip':metrics['mixedOrientationTriangles']==0,'paddingPixelCenters':verified,
        'worldUpFaceConsistency':direction.get('worldUpAngleP95Degrees') is not None and direction['worldUpAngleP95Degrees']<=60 and direction['worldUpOppositeAreaFraction']<=.025,
        'geometricOverlapFree':metrics['geometricOverlapPairs']==0,'geometricPadding':metrics['geometricPaddingViolationPairs']==0,'geometricBounds':metrics['geometricOutOfBoundsTriangles']==0,'requiresVisualReview':True}
    if params.get('diagnosticsDirectory'):
        from PIL import Image,ImageDraw
        folder=Path(params['diagnosticsDirectory']);folder.mkdir(parents=True,exist_ok=True);image=Image.new('RGB',(resolution,resolution),(25,25,25));draw=ImageDraw.Draw(image)
        from native3d_bake_basis import uv_raster_coordinates
        raster_uv = uv_raster_coordinates(uv, resolution)
        for face in result.faces:draw.polygon([tuple(p) for p in raster_uv[face]],outline=(220,220,220))
        image.save(folder/'uv-layout.png');y,x=np.indices((resolution,resolution));checker=(((x//32+y//32)%2)*120+70).astype(np.uint8);Image.fromarray(np.repeat(checker[:,:,None],3,axis=2)).save(folder/'uv-checker.png')
        report['checkerDiagnostic']='Pattern only; use model surface checker renderer for visual distortion review';report['diagnostics']=['uv-layout.png','uv-checker.png']
    timer.finish()
    report['stageTimingsSeconds']=dict(timer.seconds)
    report['geometryCheckReuse']={'computed':geometry_checks.calls,'reused':geometry_checks.hits,'scope':'this unwrap call only; exact UV, source positions, faces, resolution and padding match'}
    return result,report


