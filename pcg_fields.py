"""Finite, source-bound fields and managed image sampling; standard library only."""
from __future__ import annotations
import hashlib
import json
import math
from pcg_contracts import PCGError

MAX_BYTES = 32 * 1024 * 1024
DOMAINS = ('Point', 'Face', 'Corner', 'Instance', 'Detail')

def check(ok, message, code='INVALID_CONTRACT'):
    if not ok:
        raise PCGError(code, message)

def exact(value, keys, optional=()):
    check(type(value) is dict and set(keys) <= set(value) <= set(keys) | set(optional), 'Unknown or missing fields.')

def number(value, low=-1e6, high=1e6):
    check(type(value) in (int, float) and math.isfinite(value) and low <= value <= high, 'Number is not finite or exceeds bounds.')
    return value

def vector(value, size=3):
    check(type(value) is list and len(value) == size, 'Invalid vector dimensions.')
    for x in value: number(x)
    return value

def canonical(value):
    try:
        result = json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, RecursionError) as exc:
        raise PCGError('INVALID_CONTRACT', 'Expected finite JSON.') from exc
    check(len(result) <= MAX_BYTES, 'Value exceeds byte budget.', 'BUDGET_EXCEEDED')
    return result

def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()

def counts(geometry):
    kind = geometry['type']
    if kind == 'Mesh':
        return {'Point': len(geometry['positions']), 'Face': len(geometry['triangles']), 'Corner': len(geometry['triangles']) * 3, 'Detail': 1}
    if kind == 'PointSet':
        return {'Point': len(geometry['positions']), 'Detail': 1}
    return {'Instance': len(geometry['instances']), 'Detail': 1}

def binding(geometry):
    kind = geometry['type']
    topology = {'type': kind, 'counts': counts(geometry)}
    if kind == 'Mesh': topology['triangles'] = geometry['triangles']
    if kind == 'InstanceSet': topology['ids'] = [item['id'] for item in geometry['instances']]; topology['prototype'] = binding(geometry['prototype'])['topologyHash']
    return {'contentHash': digest(geometry), 'topologyHash': digest(topology)}

def validate_field(value, geometry=None):
    exact(value, ('contractVersion', 'type', 'binding', 'domain', 'valueType', 'values'))
    check(type(value['contractVersion']) is int and value['contractVersion'] == 1 and value['type'] in ('Field', 'Selection'), 'Invalid field version or type.')
    exact(value['binding'], ('contentHash', 'topologyHash'))
    for h in value['binding'].values(): check(type(h) is str and len(h) == 64 and all(c in '0123456789abcdef' for c in h), 'Invalid field binding.')
    check(value['domain'] in DOMAINS and value['valueType'] in ('float', 'integer', 'boolean', 'vector3'), 'Invalid field domain or type.')
    check(type(value['values']) is list and len(value['values']) <= 300000, 'Field exceeds item budget.', 'BUDGET_EXCEEDED')
    if value['type'] == 'Selection': check(value['valueType'] == 'boolean', 'Selection must be boolean.')
    for item in value['values']:
        if value['valueType'] == 'vector3': vector(item)
        elif value['valueType'] == 'boolean': check(type(item) is bool, 'Expected boolean field.')
        elif value['valueType'] == 'integer': check(type(item) is int and abs(item) <= 2**31-1, 'Expected integer field.')
        else: number(item, -1e12, 1e12)
    if geometry is not None:
        check(value['binding'] == binding(geometry), 'Field source content or topology changed.', 'FIELD_BINDING_MISMATCH')
        check(value['domain'] in counts(geometry) and len(value['values']) == counts(geometry)[value['domain']], 'Field domain count does not match source.', 'FIELD_DOMAIN_MISMATCH')
    canonical(value)
    return value

def field(geometry, domain, value_type, values, selection=False):
    result = {'contractVersion': 1, 'type': 'Selection' if selection else 'Field', 'binding': binding(geometry), 'domain': domain, 'valueType': value_type, 'values': values}
    return validate_field(result, geometry)

def _hash_noise(x, y, z, seed):
    # Integer mixing gives stable lattice values without interpreter RNG state.
    v = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) & 0xffffffff
    v = ((v ^ (v >> 13)) * 1274126177) & 0xffffffff
    return ((v ^ (v >> 16)) & 0xffffffff) / 2147483647.5 - 1.0

def noise(point, seed):
    base = [math.floor(v) for v in point]
    t = [v - a for v, a in zip(point, base)]
    t = [v*v*(3-2*v) for v in t]
    value = 0.0
    for z in range(2):
        for y in range(2):
            for x in range(2):
                weight = (t[0] if x else 1-t[0]) * (t[1] if y else 1-t[1]) * (t[2] if z else 1-t[2])
                value += weight * _hash_noise(base[0]+x, base[1]+y, base[2]+z, seed)
    return value

def noise_field(geometry, seed, amplitude, frequency, position=None, output="vector3"):
    check('positions' in geometry, 'Noise requires Point geometry.')
    if position is not None:
        validate_field(position, geometry)
        check(position['type'] == 'Field' and position['domain'] == 'Point' and position['valueType'] == 'vector3', 'Noise position must be Point vector3.', 'FIELD_DOMAIN_MISMATCH')
    positions = position['values'] if position is not None else geometry['positions']
    values = [[amplitude * noise([v * frequency for v in p], seed + axis*1013) for axis in range(3)] for p in positions]
    return field(geometry, 'Point', output, values if output == 'vector3' else [v[0] for v in values])

def field_math(a, b, operation, constant):
    validate_field(a)
    check(a['type'] == 'Field' and a['valueType'] in ('float', 'integer', 'vector3'), 'Math requires a numeric field.')
    if operation in ('component_x','component_y','component_z','length','normalize'):
        check(a['valueType'] == 'vector3' and b is None, 'Vector conversion requires one vector3 Field.')
        if operation == 'normalize':
            values = []
            for item in a['values']:
                length = math.sqrt(sum(x*x for x in item))
                check(length > 1e-20, 'Cannot normalize zero field vector.')
                values.append([x/length for x in item])
        elif operation == 'length': values = [math.sqrt(sum(x*x for x in item)) for item in a['values']]
        else: values = [item[{'component_x':0,'component_y':1,'component_z':2}[operation]] for item in a['values']]
        return validate_field(dict(a, values=values, valueType='vector3' if operation == 'normalize' else 'float'))
    if b is not None:
        validate_field(b)
        check(all(a[k] == b[k] for k in ('binding', 'domain')) and len(a['values']) == len(b['values']) and b['type'] == 'Field' and b['valueType'] in ('float','integer','vector3'), 'Fields have incompatible binding/domain/type.', 'FIELD_BINDING_MISMATCH')
    values = []
    for index, item in enumerate(a['values']):
        rhs = b['values'][index] if b is not None else constant
        if type(item) is list or type(rhs) is list:
            left = item if type(item) is list else [item]*3
            right = rhs if type(rhs) is list else [rhs]*3
            values.append([x+y if operation == 'add' else x*y for x,y in zip(left, right)])
        else:
            values.append(item+rhs if operation == 'add' else item*rhs)
    vector_result = a['valueType'] == 'vector3' or b is not None and b['valueType'] == 'vector3'
    result = dict(a, values=values, valueType='vector3' if vector_result else 'float')
    return validate_field(result)

def compare(source, operation, value):
    validate_field(source)
    check(source['type'] == 'Field' and source['valueType'] in ('float','integer'), 'Compare requires scalar numeric Field.')
    result = [(x > value if operation == 'greater' else x < value if operation == 'less' else x == value) for x in source['values']]
    return validate_field(dict(source, type='Selection', valueType='boolean', values=result))

def validate_image(image):
    exact(image, ('contractVersion','type','width','height','pixels'))
    check(type(image['contractVersion']) is int and image['contractVersion'] == 1 and image['type'] == 'Image', 'Invalid managed image.')
    for k in ('width','height'): check(type(image[k]) is int and 1 <= image[k] <= 1024, 'Image dimensions exceed budget.', 'BUDGET_EXCEEDED')
    check(type(image['pixels']) is list and len(image['pixels']) == image['width']*image['height'], 'Image pixel count mismatch.')
    for rgb in image['pixels']:
        vector(rgb)
        for component in rgb: number(component, 0, 1)
    canonical(image)
    return image

def sample_texture(geometry, image, interpolation, mapping, channel):
    validate_image(image)
    check(geometry['type'] == 'Mesh' if mapping == 'uv' else 'positions' in geometry, 'Texture mapping requires compatible geometry.')
    if mapping == 'uv':
        check(len(geometry['uvs']) == len(geometry['triangles'])*3 and bool(geometry['uvs']), 'UV sampling requires Corner UVs.')
        coordinates, domain = geometry['uvs'], 'Corner'
    else:
        axes = {'xy': (0,1), 'xz': (0,2), 'yz': (1,2)}[mapping]
        coordinates, domain = [[p[axes[0]],p[axes[1]]] for p in geometry['positions']], 'Point'
    width, height = image['width'], image['height']
    def pixel(x,y): return image['pixels'][y*width+x]
    values=[]
    for u,v in coordinates:
        x,y = max(0,min(1,u))*(width-1), max(0,min(1,v))*(height-1)
        if interpolation == 'nearest': rgb = list(pixel(int(math.floor(x+.5)), int(math.floor(y+.5))))
        else:
            x0,y0 = math.floor(x),math.floor(y)
            x1,y1 = min(x0+1,width-1),min(y0+1,height-1)
            fx,fy=x-x0,y-y0
            rgb=[(pixel(x0,y0)[c]*(1-fx)+pixel(x1,y0)[c]*fx)*(1-fy)+(pixel(x0,y1)[c]*(1-fx)+pixel(x1,y1)[c]*fx)*fy for c in range(3)]
        values.append(rgb if channel == 'rgb' else rgb[{'r':0,'g':1,'b':2}[channel]])
    return field(geometry, domain, 'vector3' if channel == 'rgb' else 'float', values)
