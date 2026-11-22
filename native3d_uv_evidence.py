"""Bound external neural partitions to the exact file and face order submitted for UV."""
import hashlib
import json
import re


def read_face_labels(encoded, source_sha256, face_count):
    if not isinstance(encoded, str) or len(encoded.encode('utf-8')) > 48000:
        raise ValueError('Segmentation evidence exceeds bounded JSON size')
    try:
        value = json.loads(encoded)
    except (ValueError, RecursionError) as exc:
        raise ValueError('Invalid segmentation evidence JSON') from exc
    required = {'sourceSha256', 'method', 'labels', 'faceOrderVerified'}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError('Segmentation evidence fields invalid')
    if not re.fullmatch('[a-f0-9]{64}', str(source_sha256)) or value['sourceSha256'] != source_sha256:
        raise ValueError('Segmentation source SHA256 mismatch')
    if value['method'] not in ('partfield', 'samesh') or value['faceOrderVerified'] is not True:
        raise ValueError('Segmentation needs an identified method and verified exact source face order')
    labels = value['labels']
    if not isinstance(labels, list) or len(labels) != face_count or not 1 <= face_count <= 20000:
        raise ValueError('Segmentation face count mismatch')
    if any(type(label) is not int or not 0 <= label < 20000 for label in labels):
        raise ValueError('Segmentation labels must be bounded nonnegative integers')
    return labels, {'method': value['method'], 'sourceSha256': source_sha256,
                    'faceOrderVerified': True, 'faceCount': face_count, 'parts': len(set(labels)),
                    'labelsSha256': hashlib.sha256(json.dumps(labels, separators=(',', ':')).encode()).hexdigest(),
                    'scope': 'Externally computed local neural partition; not inferred by UV unwrap'}


def read_high_guided_evidence(encoded, target_sha256, high_sha256, face_count):
    """Validate bounded external high-surface evidence against both actual files.

    Hash bindings establish input identity, not automatic verification of the
    external neural/AO computation. Preserve that distinction in the receipt.
    """
    import math
    if not isinstance(encoded,str) or len(encoded.encode('utf8'))>28000:
        raise ValueError('High guided evidence exceeds bounded JSON size')
    try:value=json.loads(encoded)
    except (ValueError,RecursionError) as exc:raise ValueError('Invalid high guided evidence JSON') from exc
    required={'version','method','highSourceSha256','targetSourceSha256','faceOrderVerified','highFaceCount','queryCount','queryCacheSha256','queryLabelsSha256','checkpointSha256','raySamples','raysCast','labels','confidence','darkness'}
    if not isinstance(value,dict) or set(value)!=required:raise ValueError('High guided evidence fields invalid')
    for field,actual in [('targetSourceSha256',target_sha256),('highSourceSha256',high_sha256)]:
        if not isinstance(actual,str) or not re.fullmatch('[a-f0-9]{64}',actual) or value[field]!=actual:raise ValueError('High guided source SHA256 mismatch')
    for field in ('queryCacheSha256','queryLabelsSha256','checkpointSha256'):
        if not isinstance(value[field],str) or not re.fullmatch('[a-f0-9]{64}',value[field]):raise ValueError('Invalid high guided provenance hash')
    if type(value['version']) is not int or value['version']!=1 or value['method']!='partfield_high_surface_ao' or value['faceOrderVerified'] is not True:raise ValueError('High guided method/order invalid')
    for key,low,high in [('highFaceCount',1,3000000),('queryCount',1,100000),('raySamples',8,128)]:
        if type(value[key]) is not int or not low<=value[key]<=high:raise ValueError('High guided sampling budget invalid')
    if type(value['raysCast']) is not int or value['raysCast']!=value['queryCount']*value['raySamples']:raise ValueError('High guided ray count mismatch')
    if type(face_count) is not int or not 1<=face_count<=20000:raise ValueError('Invalid high guided target face count')
    for key in ('labels','confidence','darkness'):
        if not isinstance(value[key],list) or len(value[key])!=face_count:raise ValueError('High guided target face count mismatch')
    value['supported']=[label>=0 if type(label) is int else False for label in value['labels']]
    for label,confidence,dark,supported in zip(value['labels'],value['confidence'],value['darkness'],value['supported']):
        if type(label) is not int or not -1<=label<20000 or type(supported) is not bool:raise ValueError('Invalid high guided labels/support')
        if any(type(x) not in (int,float) or not math.isfinite(x) or not 0<=x<=1 for x in (confidence,dark)):raise ValueError('Invalid high guided confidence/AO')
        if supported and (label<0 or confidence<.65):raise ValueError('High guided supported face lacks confident label')
        if not supported and label!=-1:raise ValueError('Unsupported high guided faces must remain unassigned')
    receipt={key:value[key] for key in required if key not in ('labels','confidence','darkness','supported')}
    receipt.update({'targetFaceCount':face_count,'supportedTargetFaces':sum(value['supported']),'evidenceSha256':hashlib.sha256(encoded.encode('utf8')).hexdigest(),'trust':'external_evidence_not_recomputed_by_uv','scope':'External payload claims high-surface PartField samples and sampled CPU AO projected to target. Validator checks bounded structure and actual file identity; it does not independently verify AI/AO execution.'})
    return value,receipt
