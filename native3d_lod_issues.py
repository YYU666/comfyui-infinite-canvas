"""Bounded read-only LOD issue summary. Never reruns quality certification."""
import argparse,hashlib,json
from pathlib import Path

def issue_summary(job,stage,record,digest):
    detail=record.get('receipt',{}).get('geometry',{})
    if detail.get('mesh_hash')!=record.get('mesh_hash'):raise ValueError('Final geometry evidence identity mismatch')
    count=detail.get('intersection_pairs_count');complete=detail.get('intersectionComplete') is True
    blocker=job.get('result',{}).get('metadata',{}).get('geometry',{}).get('blocker','')
    boundary='boundary' in blocker.lower()
    confirmed_boundary=any(text in blocker for text in ('Original boundary distance exceeds independent shape budget','Original boundary perimeter changed by more than5percent','Boundary proof changed connected-component count','Original boundary component Euler characteristic or loop count changed','Boundary proof requires manifold edges','Boundary proof requires disjoint simple cycles','Boundary cycle branches','Zero-length boundary edge'))
    items=[]
    if isinstance(count,int) and count>0:items.append({'kind':'intersection','classification':'confirmed_issue','label':f'已确认相交：{count} 对（仅当前网格）'})
    if not complete:items.append({'kind':'intersection','classification':'certification_incomplete','label':'相交检查未完成，不能视为零相交'})
    if boundary:items.append({'kind':'boundary','classification':'confirmed_issue' if confirmed_boundary else 'certification_incomplete','label':'已确认边界距离、周长或拓扑不符合要求；位置需进一步核对' if confirmed_boundary else '边界认证未完成，不代表已经确认超限'})
    if not items:items.append({'kind':'other','classification':'certification_incomplete','label':'此候选未通过其他质量门，请查看阶段报告；尚无可定位证据'})
    result={'version':1,'jobId':job['id'],'stage':stage,'diagnosticFileSha256':digest,'meshHash':record['mesh_hash'],'faceCount':detail.get('triangles'),'intersectionComplete':complete,'intersectionCount':count,'summary':('边界认证未完成，当前候选不能用于下一步。' if boundary else '几何检查未通过；请核对当前候选的问题。'),'items':items,'staticImage':True,'localization':'recorded_final_faces' if detail.get('intersection_pairs') else 'unlocalized','limitations':['静态定位图，不是交互式3D。','只显示当前文件的证据，不混用历史候选。','未重新运行完整认证；无最坏点证据时只显示概览，不标问题位置。']}
    marker_record=record.get('receipt',{}).get('boundaryIssueMarkers')
    if marker_record is None:
        fallback=record.get('receipt',{}).get('childFallback',{}).get('receipt',{})
        if fallback.get('boundaryIssueMarkers'):
            nested=fallback['boundaryIssueMarkers']
            if fallback.get('geometry',{}).get('mesh_hash')!=result['meshHash'] or nested.get('meshHash')!=result['meshHash'] or nested.get('faceCount',result['faceCount'])!=result['faceCount']:
                result['limitations'].append('历史修复前标记不属于当前网格，已忽略；未据此标位置。')
                result['historicalMarkersOmitted']=True
            else:marker_record=nested
    if marker_record:
        if marker_record.get('meshHash')!=result['meshHash']:raise ValueError('Boundary marker belongs to another candidate')
        if any(k in marker_record and marker_record[k]!=result[k] for k in ('jobId','stage','diagnosticFileSha256','faceCount')):raise ValueError('Marker identity mismatch')
        bound={**marker_record,**{k:result[k] for k in ('jobId','stage','diagnosticFileSha256','faceCount')}}
        markers=[m for m in validate_markers(bound,result,detail.get('vertices',0)) if m['classification']!='certified']
        result['markers']=markers
        if markers:
            result['localization']='recorded_markers'
            result['items']=[i for i in result['items'] if i['kind']!='boundary']
            for marker in markers:
                label='边界已确认超限' if marker['classification']=='confirmed_issue' else '边界待认证：采样范围不能证明完全达标'
                result['items'].append({'kind':'boundary','classification':marker['classification'],'label':label})
    if confirmed_boundary or any(m.get('classification')=='confirmed_issue' for m in result.get('markers',[])):
        result['summary']='已确认边界不符合要求，当前候选不能用于下一步。'
        if not any(i['kind']=='boundary' and i['classification']=='confirmed_issue' for i in result['items']):
            result['items'].append({'kind':'boundary','classification':'confirmed_issue','label':'当前阶段报告已确认边界不符合要求'})
    return result

def validate_markers(value,summary,vertex_count):
    if any(value.get(k)!=summary.get(k) for k in ('jobId','stage','diagnosticFileSha256','meshHash','faceCount')):raise ValueError('Marker identity mismatch')
    markers=value.get('markers',[])
    if not isinstance(markers,list) or len(markers)>64:raise ValueError('Marker budget exceeded')
    for marker in markers:
        if marker.get('classification') not in ('confirmed_issue','certification_incomplete','certified'):raise ValueError('Unknown marker classification')
        for field,limit in [('faceIds',summary['faceCount']),('candidateEdgeVertexIds',vertex_count)]:
            ids=marker.get(field,[])
            if not isinstance(ids,list) or len(ids)>128 or any(type(i)is not int or not 0<=i<limit for i in ids):raise ValueError('Invalid marker index')
    return markers

def render(source,evidence,output):
    import numpy as np
    from PIL import Image,ImageDraw
    from native3d_engine import read_mesh
    from native3d_geometry import mesh_hash
    from native3d_report import camera_for_bounds,rasterize,project_vertices,_font,BG
    raw=Path(source).read_bytes();data=json.loads(Path(evidence).read_text(encoding='utf-8'));summary=data['summary'];detail=data['geometry']
    if hashlib.sha256(raw).hexdigest()!=summary['diagnosticFileSha256']:raise ValueError('Model changed')
    mesh=read_mesh(source)
    if len(mesh.faces)!=summary['faceCount'] or not 1<=len(mesh.faces)<=100000 or mesh_hash(mesh.vertices,mesh.faces)!=summary['meshHash']:raise ValueError('Mesh evidence mismatch')
    pairs=detail.get('intersection_pairs',[])
    if not isinstance(pairs,list) or len(pairs)>64 or any(not isinstance(p,list) or len(p)!=2 or any(type(i)is not int or not 0<=i<len(mesh.faces) for i in p) for p in pairs):raise ValueError('Invalid final face pairs')
    board=Image.new('RGB',(1200,900),BG);draw=ImageDraw.Draw(board)
    draw.text((20,16),summary['stage'].upper()+' · '+summary['summary'],font=_font(25),fill='white')
    markers=summary.get('markers',[])
    if markers:validate_markers({**summary,'markers':markers},summary,len(mesh.vertices))
    for index,view in enumerate(('front','side')):
        bounds=mesh.bounds
        selected=sorted({f for marker in markers for f in marker.get('faceIds',[])} | {f for pair in pairs for f in pair})
        if index==1 and selected:
            points=mesh.vertices[mesh.faces[selected]].reshape(-1,3);lo=points.min(0);hi=points.max(0);margin=max(float(np.max(hi-lo))*.35,1e-5);bounds=np.array([lo-margin,hi+margin]);view='front'
        camera=camera_for_bounds(bounds,580,620,view=view);tile=rasterize(mesh,camera,max_faces=100000,smooth=True).convert('RGBA');overlay=Image.new('RGBA',tile.size);d=ImageDraw.Draw(overlay);xy=project_vertices(mesh.vertices,camera)[:,:2]
        for face in np.unique(pairs).astype(int) if pairs else []:d.polygon([tuple(p) for p in xy[mesh.faces[face]]],fill=(255,65,65,100),outline=(255,90,90,255),width=3)
        for marker in markers:
            color=(255,80,80,255) if marker['classification']=='confirmed_issue' else (255,185,55,255)
            for face in marker.get('faceIds',[]):d.polygon([tuple(p) for p in xy[mesh.faces[face]]],fill=color[:3]+(100,),outline=color,width=3)
            edge=marker.get('candidateEdgeVertexIds',[])
            if len(edge)==2:d.line([tuple(p) for p in xy[edge]],fill=color,width=4)
        board.paste(Image.alpha_composite(tile,overlay).convert('RGB'),(10+600*index,70))
    y=710
    for item in summary['items']:
        draw.text((20,y),item['label'],font=_font(21),fill=(255,110,110) if item['classification']=='confirmed_issue' else (255,195,85));y+=32
    draw.text((20,825),('尚无精确位置证据；仅显示当前网格概览。' if summary['localization']=='unlocalized' else '红色：已确认问题；橙色：待认证位置。穿透叠加仅用于定位。'),font=_font(20),fill='white')
    draw.text((20,855),'静态图 · 未重跑认证 · 历史网格问题不会叠加到当前候选',font=_font(19),fill=(190,200,215))
    board.save(output)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--evidence',required=True);p.add_argument('--output',required=True);a=p.parse_args();render(a.source,a.evidence,a.output)
