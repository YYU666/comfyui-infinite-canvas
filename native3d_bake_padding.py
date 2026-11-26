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
        curvature = entries.get('curvature.png', {}).get('sha256')
        if prior['result']['metadata']['bake'].get('curvature') and not curvature:
            continue  # A modern receipt must retain its declared curvature or run a fresh bake.
        names = FILES + (('curvature.png',) if curvature else ())
        paths={name:manager._safe_file(prior['id'],name) for name in names}
        if any(digest(paths[n])!=entries[n]['sha256'] for n in names):raise ValueError('Prior bake artifact changed; padding reuse refused')
        folder=Path(directory)/'bake-padding-source';folder.mkdir()
        files={}
        for name in names:
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
    for name in FILES + (('curvature.png',) if 'curvature.png' in context['files'] else ()):
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

def _material_image_replacements(document, slot_bytes):
    # A glTF texture/image can be shared by several material slots. Preserve
    # unmodified slots and clone only when those sharing it need different bytes.
    material, = document['materials']
    pbr = material['pbrMetallicRoughness']
    slots = {'baseColorTexture': pbr.get('baseColorTexture'),
             'metallicRoughnessTexture': pbr.get('metallicRoughnessTexture'),
             'occlusionTexture': material.get('occlusionTexture'),
             'normalTexture': material.get('normalTexture'),
             'emissiveTexture': material.get('emissiveTexture')}
    if any(name not in slots or not isinstance(slots[name], dict) for name in slot_bytes):
        raise ValueError('Cached bake PBR channel missing')
    textures, images = document['textures'], document['images']
    groups = {}
    for name, texture in slots.items():
        if isinstance(texture, dict):
            index = texture['index']
            image = textures[index]['source']
            groups.setdefault(image, {}).setdefault(slot_bytes.get(name), []).append((texture,index))
    replacements = {}
    for image, data_groups in groups.items():
        for number, data in enumerate(sorted(data_groups, key=lambda blob: blob is not None)):
            destination = image
            if number:
                destination = len(images)
                images.append(dict(images[image]))
                texture_ids = {}
                for info, original in data_groups[data]:
                    replacement = texture_ids.get(original)
                    if replacement is None:
                        replacement = texture_ids[original] = len(textures)
                        textures.append({**textures[original], 'source': destination})
                    info['index'] = replacement
            if data is not None:
                replacements[destination] = data
    return replacements


def replace_glb_images(source,target,replacements=None,*,material_slots=None):
    """Repack embedded images without changing any original non-image accessor data."""
    raw=Path(source).read_bytes()
    if raw[:4]!=b'glTF' or struct.unpack_from('<I',raw,4)[0]!=2:raise ValueError('Expected GLB2')
    jslen,jstype=struct.unpack_from('<II',raw,12);doc=json.loads(raw[20:20+jslen]);offset=20+jslen
    binlen,bintype=struct.unpack_from('<II',raw,offset)
    if jstype!=0x4e4f534a or bintype!=0x004e4942 or len(doc.get('buffers',[]))!=1:raise ValueError('Unsupported cached GLB chunks')
    binary=raw[offset+8:offset+8+binlen];views=doc.get('bufferViews',[]);replace_views={}
    if material_slots is not None:
        if replacements is not None:
            raise ValueError('Use either material slots or image indices')
        replacements = _material_image_replacements(doc, material_slots)
    images = doc.get('images', [])
    original_views = set()
    for index in replacements:
        if 'bufferView' not in images[index]:
            raise ValueError('Cached image is not embedded')
        original_views.add(images[index]['bufferView'])
    if any(accessor.get('bufferView') in original_views for accessor in doc.get('accessors', [])):
        raise ValueError('Image buffer aliases geometry')

    groups = {}
    for index, image in enumerate(images):
        view = image.get('bufferView')
        if view in original_views:
            groups.setdefault(view, {}).setdefault(replacements.get(index), []).append(image)
    for view, data_groups in groups.items():
        for number, data in enumerate(sorted(data_groups, key=lambda blob: blob is not None)):
            target_view = view
            if number:
                target_view = len(views)
                views.append(dict(views[view]))
            if data is not None:
                replace_views[target_view] = data
            for image in data_groups[data]:
                image['bufferView'] = target_view
                if data is not None:
                    image['mimeType'] = 'image/png'
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
    channels={n:pixels(n) for n in CHANNELS + (('curvature',) if 'curvature.png' in context['files'] else ())};masks={n:pixels(n) for n in MASKS}
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
    from native3d_material_atlas import shares_orm_storage, write_packed_maps
    from native3d_glb_layout import read_glb_document
    write_packed_maps(out, channels['ao'], channels['roughness'], channels['metallic'])
    source = Path(context['files']['model.glb']['path'])
    doc = read_glb_document(source)
    material, = doc['materials']
    combined = shares_orm_storage(doc, material)
    names = {'baseColorTexture':'basecolor', 'normalTexture':'normal',
             'occlusionTexture':'orm' if combined else 'ao',
             'metallicRoughnessTexture':'orm' if combined else 'metallic-roughness'}
    outputs = {name: (out / (name+'.png')).read_bytes() for name in set(names.values())}
    proof = replace_glb_images(source, out/'model.glb', material_slots={slot: outputs[name] for slot, name in names.items()})
    shutil.copyfile(out/'model.glb',out/'proxy.glb')
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
