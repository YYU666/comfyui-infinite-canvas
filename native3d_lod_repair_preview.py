"""Read-only official local-repair comparison; no high mesh or quality rerun."""
import argparse
import hashlib
import json
import re
from pathlib import Path

VERSION=1


def official_evidence(job,stage,digest):
    records=[r for r in job.get('result',{}).get('metadata',{}).get('geometry',{}).get('stages',[]) if r.get('stage')==stage]
    if job.get('operation')!='source_lod' or job.get('status')!='succeeded' or len(records)!=1:
        raise ValueError('No registered completed source LOD stage')
    record=records[0];detail=record.get('receipt',{});geometry=detail.get('geometry',{})
    if record.get('status')!='accepted' or record.get('eligibleForDownstream') is not True or record.get('visible') is not True or record.get('filename')!=stage+'.glb' or record.get('file_sha256')!=digest:
        raise ValueError('Not an accepted registered canonical stage file')
    if geometry.get('status')!='accepted' or geometry.get('intersectionComplete') is not True or geometry.get('intersection_pairs_count')!=0 or geometry.get('mesh_hash')!=record.get('mesh_hash') or not detail.get('fidelity',{}).get('accepted'):
        raise ValueError('Accepted final geometry/fidelity evidence missing')
    child=detail.get('childFallback',{}).get('receipt',{})
    repair=child.get('boundaryRetopology')
    if child.get('status')!='complete' or not isinstance(repair,dict) or repair.get('status')!='complete' or repair.get('profile')!='local-boundary-retopology-v1':
        raise ValueError('No supported official completed local repair')
    choices=repair.get('candidates');index=repair.get('selectedCandidate')
    if not isinstance(choices,list) or not 1<=len(choices)<=2 or type(index) is not int or not 0<=index<len(choices):
        raise ValueError('Invalid selected repair candidate')
    chosen=choices[index]
    after=record['mesh_hash'];before=repair.get('beforeMeshHash')
    if not all(isinstance(h,str) and re.fullmatch('[a-f0-9]{64}',h) for h in (before,after)):
        raise ValueError('Invalid before/after identities')
    if chosen.get('status')!='complete' or repair.get('afterMeshHash')!=after or chosen.get('afterMeshHash')!=after or child.get('candidateMeshHash')!=after or chosen.get('geometry',{}).get('mesh_hash')!=after:
        raise ValueError('Final repair belongs to another candidate')
    if repair.get('beforeGeometry',{}).get('mesh_hash')!=before or repair.get('localization',{}).get('meshHash')!=before:
        raise ValueError('Before repair evidence identity mismatch')
    if not all(chosen.get(k,{}).get('accepted') is True for k in ('localFidelity','sourceNormalQuality','boundaryPreservation','fidelity')):
        raise ValueError('Incomplete repair acceptance evidence')
    if chosen.get('geometry',{}).get('status')!='accepted' or chosen['geometry'].get('intersectionComplete') is not True or chosen['geometry'].get('intersection_pairs_count')!=0 or chosen['boundaryPreservation'].get('candidateMeshHash')!=after or chosen.get('allOldVerticesExact') is not True or chosen.get('outsideFacesExact') is not True:
        raise ValueError('Incomplete exact repair evidence')
    count=geometry.get('triangles')
    if type(count) is not int or not 2<=count<=100000 or repair.get('beforeTriangles')!=count-1:
        raise ValueError('Repair face budget mismatch')
    return {'version':VERSION,'jobId':job['id'],'stage':stage,'finalFileSha256':digest,
            'beforeMeshHash':before,'afterMeshHash':after,'faceCount':count,
            'beforeGeometry':repair['beforeGeometry'],'localization':repair['localization'],'selected':chosen}


def reconstruct(source,evidence):
    import numpy as np
    import trimesh
    from native3d_engine import read_mesh
    from native3d_geometry import mesh_hash
    source=Path(source)
    if not source.is_file() or source.stat().st_size>16*1024**2:raise ValueError('Model exceeds16MiB budget')
    if hashlib.sha256(source.read_bytes()).hexdigest()!=evidence['finalFileSha256']:raise ValueError('Final file changed')
    after=read_mesh(source.resolve());v=np.asarray(after.vertices);f=np.asarray(after.faces)
    if not 2<=len(f)<=100000 or len(f)!=evidence['faceCount'] or mesh_hash(v,f)!=evidence['afterMeshHash']:
        raise ValueError('Final mesh evidence mismatch')
    row=evidence['selected'];mapping=row['patchMap'];removed=mapping['removedFaceId'];newids=mapping['newFaceIds'];old=mapping['removedFaceVertices']
    if type(removed) is not int or not 0<=removed<len(f)-1 or newids!=[len(f)-2,len(f)-1] or mapping['newVertexId']!=len(v)-1:
        raise ValueError('Invalid reversible repair indices')
    if not isinstance(old,list) or len(old)!=3 or any(type(i) is not int or not 0<=i<len(v)-1 for i in old) or len(set(old))!=3:
        raise ValueError('Invalid original triangle')
    if not np.array_equal(f[-2:],mapping['newFaces']) or not np.array_equal(v[-1],row['newVertexPosition']):
        raise ValueError('Final patch differs from receipt')
    before_faces=np.insert(f[:-2],removed,old,axis=0);before_vertices=v[:-1]
    if before_faces.max()>=len(before_vertices) or mesh_hash(before_vertices,before_faces)!=evidence['beforeMeshHash']:
        raise ValueError('Reconstructed before mesh hash mismatch')
    before=trimesh.Trimesh(vertices=before_vertices.copy(),faces=before_faces,process=False)
    return before,after


def summary(evidence):
    row=evidence['selected'];mapping=row['patchMap']
    markers=evidence['localization'].get('markers',[])
    classes={m.get('classification') for m in markers}
    before_class='confirmed_issue' if 'confirmed_issue' in classes else 'certification_incomplete'
    return {'version':VERSION,'jobId':evidence['jobId'],'stage':evidence['stage'],
            'finalFileSha256':evidence['finalFileSha256'],'beforeMeshHash':evidence['beforeMeshHash'],
            'afterMeshHash':evidence['afterMeshHash'],'beforeFaceCount':evidence['faceCount']-1,'afterFaceCount':evidence['faceCount'],
            'beforeFaceIds':[mapping['removedFaceId']],'afterFaceIds':mapping['newFaceIds'],
            'beforeClassification':before_class,'afterClassification':'accepted_repair',
            'algorithm':'传统算法局部边界重拓扑，不是 AI；一个面拆成两个面。',
            'summary':'自动局部修复已通过原质量检查；以下为正式记录重建的前后对照。',
            'localSurfaceDisplacementUpperMeters':row['analyticLocalHausdorffUpperMeters'],
            'checkedGates':['完整零交叉','原始边界认证','局部误差','原高模保真','原高模法线'],
            'staticImage':True,'aspectRatio':'4:3','sameLocalCamera':True,
            'limitations':['只读静态对照，不重新计算高模或质量认证。','修复前橙色表示认证未完成，不等同于确认超限。','局部着色为穿透定位叠加；面编号分别属于各自网格。']}


def render(source,evidence_path,output,summary_path):
    import numpy as np
    from PIL import Image,ImageDraw
    from native3d_report import camera_for_bounds,rasterize,project_vertices,_font,BG
    path=Path(evidence_path)
    if path.stat().st_size>2*1024**2:raise ValueError('Evidence budget exceeded')
    evidence=json.loads(path.read_text(encoding='utf-8'));before,after=reconstruct(source,evidence);data=summary(evidence)
    row=evidence['selected'];mapping=row['patchMap'];oldid=mapping['removedFaceId'];newids=mapping['newFaceIds']
    points=np.concatenate([before.vertices[before.faces[[oldid]]].reshape(-1,3),after.vertices[after.faces[newids]].reshape(-1,3)])
    lo=points.min(0);hi=points.max(0);margin=max(float(np.max(hi-lo))*.25,1e-5)
    camera=camera_for_bounds(np.array([lo-margin,hi+margin]),570,420)
    # Face-oriented orthographic camera is shared exactly by both local tiles.
    tri=before.vertices[before.faces[oldid]];right=tri[1]-tri[0];right/=np.linalg.norm(right)
    toward=np.cross(tri[1]-tri[0],tri[2]-tri[0]);toward/=np.linalg.norm(toward);up=np.cross(toward,right)
    camera.update(right=right.tolist(),up=up.tolist(),toward=toward.tolist(),view='shared original-face plane')
    board=Image.new('RGB',(1200,900),BG);draw=ImageDraw.Draw(board)
    draw.text((24,15),data['stage'].upper()+' · 正式局部修复对照',font=_font(28),fill='white')
    draw.text((24,54),data['algorithm'],font=_font(21),fill=(195,210,225))
    def tile(mesh,cam,ids,color):
        image=rasterize(mesh,cam,max_faces=100000,smooth=True).convert('RGBA');layer=Image.new('RGBA',image.size);d=ImageDraw.Draw(layer);xy=project_vertices(mesh.vertices,cam)[:,:2]
        for face in ids:d.polygon([tuple(p) for p in xy[mesh.faces[face]]],fill=color+(95,),outline=color+(255,),width=3)
        return Image.alpha_composite(image,layer).convert('RGB')
    overall=camera_for_bounds(after.bounds,420,250,'front')
    overview=tile(after,overall,newids,(65,215,165));locator=ImageDraw.Draw(overview)
    patch_center=after.vertices[after.faces[newids]].reshape(-1,3).mean(0)
    projected=project_vertices(np.asarray([patch_center]),overall)[0,:2]
    # Keep the fixed-size locator inside its tile even for silhouette patches.
    radius=14;cx=float(np.clip(projected[0],radius+3,420-radius-3));cy=float(np.clip(projected[1],radius+3,250-radius-3))
    green=(65,235,170);locator.ellipse((cx-radius,cy-radius,cx+radius,cy+radius),outline=green,width=3)
    label_x=cx+28 if cx<270 else cx-116;label_y=float(np.clip(cy-32,5,220))
    locator.line([(cx,cy),(label_x+8,label_y+12)],fill=green,width=2)
    locator.text((label_x,label_y),'修复位置',font=_font(20),fill=green,stroke_width=1,stroke_fill=(15,30,35))
    board.paste(overview,(24,90))
    draw.text((475,110),'整体位置：绿色标记为修复区域',font=_font(22),fill='white')
    draw.text((475,150),f"面数 {data['beforeFaceCount']} → {data['afterFaceCount']}，仅增加 1 面",font=_font(22),fill='white')
    draw.text((475,190),f"局部表面改变量上界 {data['localSurfaceDisplacementUpperMeters']*1000:.3f} mm",font=_font(21),fill='white')
    draw.text((475,230),'旧顶点和未修改区域保持不变；原验收门全部通过。',font=_font(19),fill=(180,210,205))
    beforecolor=(255,90,90) if data['beforeClassification']=='confirmed_issue' else (255,184,65)
    board.paste(tile(before,camera,[oldid],beforecolor),(20,385));board.paste(tile(after,camera,newids,(65,215,165)),(610,385))
    draw.text((24,350),f'修复前 · 面 {oldid} · '+('已确认问题' if data['beforeClassification']=='confirmed_issue' else '边界认证未完成'),font=_font(21),fill=beforecolor)
    draw.text((614,350),f'修复后 · 面 {newids[0]}, {newids[1]} · 已通过',font=_font(21),fill=(65,215,165))
    draw.text((24,820),'同一局部相机与比例 · 着色为穿透定位叠加 · 面编号分别绑定前后网格',font=_font(20),fill='white')
    draw.text((24,854),'只读正式记录；未重新生成模型、读取高模或重跑质量认证。',font=_font(20),fill=(185,200,215))
    board.save(output);data['imageSha256']=hashlib.sha256(Path(output).read_bytes()).hexdigest()
    Path(summary_path).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')


if __name__=='__main__':
    p=argparse.ArgumentParser()
    for name in ('source','evidence','output','summary'):p.add_argument('--'+name,required=True)
    a=p.parse_args();render(a.source,a.evidence,a.output,a.summary)
