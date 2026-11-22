"""Checksummed padding-only derivatives of immutable successful bake products.
No ray projection, shading recomputation or covered-pixel replacement occurs.
"""
import copy
import hashlib
import json
from pathlib import Path
import shutil
import struct

CHANNELS=('normal','ao','basecolor','roughness','metallic')
MASKS=('coverage','hits','normal-valid')
FILES=('model.glb',)+tuple(n+'.png' for n in CHANNELS+MASKS)

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def evidence_hash(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()

def compatible(prior,job):
    if prior.get('projectId')!=job.get('projectId') or prior.get('operation')!='bake' or prior.get('status')!='succeeded':return False
    if any(not job.get('source',{}).get(k) or prior.get('source',{}).get(k)!=job['source'][k] for k in ('sha256','highSha256')):return False
    a=prior.get('parameters',{});b=job.get('parameters',{})
    if {k:v for k,v in a.items() if k!='padding'}!={k:v for k,v in b.items() if k!='padding'}:return False
    report=prior.get('result',{}).get('metadata',{}).get('bake',{})
    old=report.get('padding');new=b.get('padding')
    if type(old) is not int or type(new) is not int or not 0<=old<new<=64:return False
    # Explicit supported artifact semantics; this is a derivative of OLD
    # shading evidence, not a claim that historical code equals current code.
    return (report.get('resolution')==b.get('resolution') and report.get('concavitySafety',{}).get('version')=='concavity-safety-v1'
            and report.get('rasterConvention')=='UV*resolution; texel centers at integer+.5'
            and report.get('dilation',{}).get('outsideIslandCoverageOnly') is True
            and report.get('dilation',{}).get('pixels')==old
            and report.get('overlapSamples')==0 and report.get('hitSamples',0)>0
            and isinstance(report.get('projectionQuality'),dict) and isinstance(report.get('sourceMaterialTransfer'),dict)
            and str(report.get('tangentBasis','')).startswith('MikkTSpace'))

def freeze_padding_reuse(manager,job,directory):
    candidates=sorted((p for p in manager.jobs.values() if compatible(p,job)),key=lambda p:p.get('createdAt',0),reverse=True)
    for prior in candidates:
        entries={e.get('name'):e for e in prior.get('result',{}).get('files',[])}
        if not all(name in entries and entries[name].get('sha256') for name in FILES):continue
        paths={name:manager._safe_file(prior['id'],name) for name in FILES}
        if any(digest(paths[n])!=entries[n]['sha256'] for n in FILES):raise ValueError('Prior bake artifact changed; padding reuse refused')
        folder=Path(directory)/'bake-padding-source';folder.mkdir()
        files={}
        for name in FILES:
            target=folder/name;shutil.copyfile(paths[name],target)
            if digest(target)!=entries[name]['sha256']:raise ValueError('Padding snapshot checksum mismatch')
            files[name]={'path':str(target.resolve()),'sha256':entries[name]['sha256']}
        metadata=prior['result']['metadata'];report=copy.deepcopy(metadata['bake'])
        return {'priorJobId':prior['id'],'projectId':job['projectId'],'source':copy.deepcopy(job['source']),
                'parameters':copy.deepcopy(job['parameters']),'priorParameters':copy.deepcopy(prior['parameters']),
                'priorBake':report,'priorBakeEvidenceSha256':evidence_hash(report),'files':files,
                'priorSourceSha256':metadata.get('sourceSha256'),'priorHighSha256':metadata.get('highSourceSha256')}
    return None

def validate_context(context,request):
    if context.get('projectId')!=request.get('projectId') or context.get('parameters')!=request.get('parameters'):raise ValueError('Padding reuse project/parameters changed')
    for k in ('sha256','highSha256'):
        if not context.get('source',{}).get(k) or context['source'][k]!=request.get('source',{}).get(k):raise ValueError('Padding reuse source identity changed')
    if context.get('priorSourceSha256')!=context['source']['sha256'] or context.get('priorHighSha256')!=context['source']['highSha256']:raise ValueError('Prior bake metadata source identities mismatch')
    prior={'projectId':context['projectId'],'operation':'bake','status':'succeeded','source':context['source'],
           'parameters':context['priorParameters'],'result':{'metadata':{'bake':context['priorBake']}}}
    if not compatible(prior,request):raise ValueError('Padding reuse recipe incompatible')
    if evidence_hash(context['priorBake'])!=context['priorBakeEvidenceSha256']:raise ValueError('Padding provenance evidence changed')
    for name in FILES:
        item=context.get('files',{}).get(name,{})
        if not item.get('sha256') or digest(item.get('path',''))!=item['sha256']:raise ValueError('Padding source artifact checksum mismatch: '+name)

def repad_arrays(channels,coverage,hits,padding):
    import numpy as np
    from scipy.ndimage import distance_transform_edt
    if coverage.ndim!=2 or hits.shape!=coverage.shape or not hits.any() or np.any((hits!=0)&(coverage==0)):raise ValueError('Invalid padding coverage/hit masks')
    distance,indices=distance_transform_edt(hits==0,return_indices=True)
    changed=(coverage==0)&(distance<=padding);result={}
    for name,pixels in channels.items():
        if pixels.shape[:2]!=coverage.shape:raise ValueError('Padding channel dimensions mismatch')
        out=pixels.copy();out[changed]=pixels[indices[0][changed],indices[1][changed]]
        if not np.array_equal(out[coverage!=0],pixels[coverage!=0]):raise ValueError('Padding changed covered pixels')
        result[name]=out
    return result,int(changed.sum())

def replace_glb_images(source,target,replacements):
    """Repack buffer views; all non-image bytes and all accessor data exact."""
    raw=Path(source).read_bytes()
    if raw[:4]!=b'glTF' or struct.unpack_from('<I',raw,4)[0]!=2:raise ValueError('Expected GLB2')
    jslen,jstype=struct.unpack_from('<II',raw,12);doc=json.loads(raw[20:20+jslen]);offset=20+jslen
    binlen,bintype=struct.unpack_from('<II',raw,offset)
    if jstype!=0x4e4f534a or bintype!=0x004e4942 or len(doc.get('buffers',[]))!=1:raise ValueError('Unsupported cached GLB chunks')
    binary=raw[offset+8:offset+8+binlen];views=doc.get('bufferViews',[]);replace_views={}
    for image_index,data in replacements.items():
        item=doc['images'][image_index]
        if 'bufferView' not in item:raise ValueError('Cached image is not embedded')
        view=int(item['bufferView'])
        if view in replace_views and replace_views[view]!=data:raise ValueError('Conflicting shared image replacements')
        replace_views[view]=data;item['mimeType']='image/png'
    for accessor in doc.get('accessors',[]):
        if accessor.get('bufferView') in replace_views:raise ValueError('Image buffer aliases geometry')
    parts=[];cursor=0;preserved=[]
    for index,view in enumerate(views):
        if view.get('buffer',0)!=0:raise ValueError('External GLB buffer unsupported')
        old=binary[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']]
        if len(old)!=view['byteLength']:raise ValueError('Cached GLB buffer bounds invalid')
        chunk=replace_views.get(index,old);view.update(byteOffset=cursor,byteLength=len(chunk))
        parts.append(chunk);pad=(-len(chunk))%4;parts.append(b'\0'*pad);cursor+=len(chunk)+pad
        if index not in replace_views:preserved.append(hashlib.sha256(old).hexdigest())
    doc['buffers'][0]['byteLength']=cursor;js=json.dumps(doc,separators=(',',':'),ensure_ascii=False).encode();js+=b' '*((-len(js))%4);body=b''.join(parts)
    output=b'glTF'+struct.pack('<II',2,12+8+len(js)+8+len(body))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(body),0x004e4942)+body
    Path(target).write_bytes(output)
    return {'nonImageBufferViewsPreserved':len(preserved),'nonImageBufferViewHashes':preserved,'geometryUVNormalTangentBytesExact':True}

def derive_padding(context,request,output):
    import numpy as np
    from PIL import Image
    validate_context(context,request);out=Path(output);out.mkdir(parents=True,exist_ok=True)
    def pixels(name):
        with Image.open(context['files'][name+'.png']['path']) as image:return np.asarray(image).copy()
    channels={n:pixels(n) for n in CHANNELS};masks={n:pixels(n) for n in MASKS}
    resolution=request['parameters']['resolution']
    if any(a.shape!=(resolution,resolution) or a.dtype!=np.uint8 or not np.isin(a,[0,255]).all() for a in masks.values()):raise ValueError('Padding masks have wrong resolution/encoding')
    for name,array in channels.items():
        expected=(resolution,resolution,3) if name in ('normal','basecolor') else (resolution,resolution)
        if array.shape!=expected or array.dtype!=np.uint8:raise ValueError('Padding channel format mismatch: '+name)
    if np.any((masks['normal-valid']!=0)&(masks['hits']==0)):raise ValueError('Normal-valid pixels outside hit mask')
    prior=context['priorBake'];covered=masks['coverage']!=0;hits=masks['hits']!=0
    if int(covered.sum())!=prior['coveredSamples'] or int(hits.sum())!=prior['hitSamples'] or int((covered&~hits).sum())!=prior['missSamples']:raise ValueError('Padding masks disagree with projection evidence')
    invalid=int((hits&(masks['normal-valid']==0)).sum())
    if invalid!=prior['sourceMaterialTransfer'].get('projectedNormalInvalidTexels'):raise ValueError('Padding normal-valid mask disagrees with shading evidence')
    channels,changed=repad_arrays(channels,masks['coverage'],masks['hits'],request['parameters']['padding'])
    for name,pixel in {**channels,**masks}.items():Image.fromarray(pixel).save(out/(name+'.png'))
    mr=np.zeros((resolution,resolution,3),np.uint8);mr[:,:,1]=channels['roughness'];mr[:,:,2]=channels['metallic'];Image.fromarray(mr).save(out/'metallic-roughness.png')
    raw=Path(context['files']['model.glb']['path']).read_bytes();length=struct.unpack_from('<I',raw,12)[0];doc=json.loads(raw[20:20+length]);materials=doc.get('materials',[])
    if len(materials)!=1:raise ValueError('Padding reuse requires one exported bake PBR material')
    mat=materials[0];mapping={'basecolor':mat.get('pbrMetallicRoughness',{}).get('baseColorTexture'),'metallic-roughness':mat.get('pbrMetallicRoughness',{}).get('metallicRoughnessTexture'),'normal':mat.get('normalTexture'),'ao':mat.get('occlusionTexture')}
    replacements={}
    for name,texture in mapping.items():
        if not isinstance(texture,dict):raise ValueError('Cached bake PBR channel missing')
        index=doc['textures'][texture['index']]['source'];data=(out/(name+'.png')).read_bytes()
        if index in replacements and replacements[index]!=data:raise ValueError('Cached bake shared images are incompatible')
        replacements[index]=data
    proof=replace_glb_images(context['files']['model.glb']['path'],out/'model.glb',replacements);shutil.copyfile(out/'model.glb',out/'proxy.glb')
    report=copy.deepcopy(prior);report['padding']=request['parameters']['padding']
    report['bakeSettings'].update(padding=report['padding'],paddingRequested=report['padding'])
    report['dilation']={**report.get('dilation',{}),'pixels':report['padding'],'requestedPixels':report['padding'],
                        'automatic':False,'changedTexels':changed,'outsideIslandCoverageOnly':True}
    report['paddingReuse']={'mode':'padding-only derivative of prior completed shading output; no current projection/shading execution',
        'priorJobId':context['priorJobId'],'priorBakeEvidenceSha256':context['priorBakeEvidenceSha256'],
        'priorAlgorithmCodeSha256':None,'algorithmProvenance':'historical job did not record source code SHA; original shading evidence retained unchanged',
        'sourceFileSha256':context['source']['sha256'],'highFileSha256':context['source']['highSha256'],
        'priorArtifactSha256':{k:v['sha256'] for k,v in context['files'].items()},'oldPadding':prior['padding'],'newPadding':report['padding'],
        'outsideCoveredTexelsDilated':changed,'allCoveredPixelsExact':True,'masksExact':True,'projectionMetricsUnchanged':True,**proof}
    return report
