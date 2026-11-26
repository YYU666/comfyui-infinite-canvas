"""Bounded sub-texel high-surface normal sampling, no image-space blur."""
import numpy as np
from native3d_bake_basis import unit


def interpolate_high_normals(vertex_normals,faces,primitive_ids,primitive_uvs,geometric_normals=None,report=None):
    primitive_ids=np.asarray(primitive_ids,dtype=np.int64)
    weights=np.column_stack([1-np.asarray(primitive_uvs).sum(axis=1),primitive_uvs])
    raw=np.einsum('ni,nij->nj',weights,np.asarray(vertex_normals)[np.asarray(faces)[primitive_ids]])
    if geometric_normals is None:return unit(raw)
    geometric=np.asarray(geometric_normals,dtype=float)
    lengths=np.linalg.norm(geometric,axis=1,keepdims=True)
    if geometric.shape!=raw.shape or not np.isfinite(geometric).all() or np.any(lengths<1e-12):
        raise ValueError('High shading-normal validation needs finite nonzero actual geometric normals')
    geometric=geometric/lengths
    raw_lengths=np.linalg.norm(raw,axis=1,keepdims=True)
    unusable=~np.isfinite(raw).all(axis=1)|(raw_lengths[:,0]<1e-12)
    shading=np.divide(raw,raw_lengths,out=np.zeros_like(raw),where=np.isfinite(raw_lengths)&(raw_lengths>=1e-12))
    opposing=(~unusable)&(np.sum(shading*geometric,axis=1)<0)
    shading[unusable|opposing]=geometric[unusable|opposing]
    if report is not None:
        for key,value in [('highNormalUnnormalizableFallbacks',unusable.sum()),('highNormalOpposingOwnGeometryFallbacks',opposing.sum())]:
            report[key]=report.get(key,0)+int(value)
    return shading


def filtered_high_normals(xy,tex,xyz,high_faces,high_vertex_normals,cage,query,low_corner_normals=None,center_normals=None,center_valid=None):
    xy=np.asarray(xy);matrix=np.column_stack([tex[1]-tex[0],tex[2]-tex[0]])
    inv=np.linalg.inv(matrix);total=np.zeros((len(xy),3));counts=np.zeros(len(xy),dtype=np.int32)
    inside_counts=np.zeros(len(xy),dtype=np.int32);tap_normals=np.zeros((4,len(xy),3));tap_valid=np.zeros((4,len(xy)),bool)
    report={'insideFaceTaps':0,'outsideFaceTaps':0,'validTaps':0,'cageRejectedTaps':0,'centerOnlySubpixelTexels':0,
        'highNormalUnnormalizableFallbacks':0,'highNormalOpposingOwnGeometryFallbacks':0,
        'strongOpposingTapPairs':0,'texelsWithStrongOpposingTaps':0}
    for tap_index,(dx,dy) in enumerate([(.25,.25),(.75,.25),(.25,.75),(.75,.75)]):
        bary2=(xy+[dx,dy]-tex[0])@inv.T
        inside=(bary2>=-1e-10).all(axis=1)&(bary2.sum(axis=1)<=1+1e-10)
        inside_counts+=inside
        report['insideFaceTaps']+=int(inside.sum());report['outsideFaceTaps']+=int((~inside).sum())
        ids=np.flatnonzero(inside)
        if not len(ids):continue
        points=xyz[0]+bary2[ids]@(xyz[1:]-xyz[0])
        if low_corner_normals is None:
            found=query(points)
        else:
            weights=np.column_stack([1-bary2[ids].sum(1),bary2[ids]])
            found=query(points,unit(weights@np.asarray(low_corner_normals)))
        nearest=np.asarray(found['points'])
        valid=np.isfinite(nearest).all(axis=1)&(np.asarray(found['valid'],dtype=bool) if 'valid' in found else np.linalg.norm(nearest-points,axis=1)<=cage)
        report['validTaps']+=int(valid.sum());report['cageRejectedTaps']+=int((~valid).sum())
        if not valid.any():continue
        geometric=np.asarray(found['primitive_normals'])[valid] if 'primitive_normals' in found else None
        normals=interpolate_high_normals(high_vertex_normals,high_faces,np.asarray(found['primitive_ids'])[valid],np.asarray(found['primitive_uvs'])[valid],geometric,report)
        tap_normals[tap_index,ids[valid]]=normals;tap_valid[tap_index,ids[valid]]=True
        total[ids[valid]]+=normals;counts[ids[valid]]+=1
    risk=np.zeros(len(xy),bool)
    for i in range(4):
        for j in range(i+1,4):
            opposing=tap_valid[i]&tap_valid[j]&(np.sum(tap_normals[i]*tap_normals[j],axis=1)<-.5)
            risk|=opposing;report['strongOpposingTapPairs']+=int(opposing.sum())
    report['texelsWithStrongOpposingTaps']=int(risk.sum())
    if center_normals is not None and center_valid is not None:
        center_bary=(xy+.5-tex[0])@inv.T
        center_inside=(center_bary>=1e-7).all(axis=1)&(center_bary.sum(axis=1)<=1-1e-7)
        single=(inside_counts==0)&center_inside&np.asarray(center_valid,dtype=bool)
        total[single]=np.asarray(center_normals)[single];counts[single]=1
        report['centerOnlySubpixelTexels']=int(single.sum())
    usable=(counts>0)&(np.linalg.norm(total,axis=1)>1e-8)
    output=np.zeros_like(total);output[usable]=unit(total[usable])
    report['texelsWithoutValidTaps']=int(np.count_nonzero(counts==0));report['cancelledNormalTexels']=int(np.count_nonzero((counts>0)&~usable))
    return output,usable,report
