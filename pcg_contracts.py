"""Closed PCG v1 contracts, registry and project-scoped immutable asset broker."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
import stat


MAX_ITEMS = 1024
MAX_VALUE_BYTES = 1024 * 1024
TYPES = {'GeometryArtifact', 'InstanceSet', 'Field', 'Attribute', 'Selection', 'DiagnosticReport'}
DOMAINS = {'Point', 'Face', 'Corner', 'Instance', 'Detail'}
VALUE_TYPES = {'float', 'integer', 'boolean', 'vector3'}
REGISTRY_PATH = Path(__file__).resolve().parent / 'pcg' / 'registry.json'


class PCGError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


def require(ok, message='PCG contract is invalid.', code='INVALID_CONTRACT', status=400):
    if not ok:
        raise PCGError(code, message, status)


def exact(value, required, optional=()):
    require(isinstance(value, dict), 'Expected an object.')
    require(set(required) <= set(value) <= set(required) | set(optional), 'Unknown or missing contract fields.')


def integer(value, low=0, high=MAX_ITEMS):
    require(type(value) is int and low <= value <= high, 'Integer is outside its bounds.')


def token(value, maximum=128):
    require(isinstance(value, str) and 1 <= len(value) <= maximum and re.fullmatch(r'[A-Za-z0-9_.:-]+', value), 'Invalid identity token.')


def digest(value):
    require(isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value), 'Invalid SHA256 identity.')


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')
    except (ValueError, TypeError, RecursionError) as exc:
        raise PCGError('INVALID_CONTRACT', 'Value is not finite JSON.') from exc


def parse_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON fields are forbidden.')
            result[key] = value
        return result
    def constant(_):
        raise PCGError('INVALID_CONTRACT', 'Non-finite JSON numbers are forbidden.')
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise PCGError('INVALID_CONTRACT', 'Invalid finite JSON document.') from exc


def content_hash(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def finite(value):
    return type(value) in (int, float) and abs(value) <= 1e12 and math.isfinite(value)


def validate_scalar(value, kind):
    require(isinstance(kind, str) and kind in VALUE_TYPES, 'Unknown value type.')
    if kind == 'vector3':
        require(isinstance(value, list) and len(value) == 3 and all(finite(v) for v in value), 'Expected a finite vector3.')
    elif kind == 'boolean':
        require(type(value) is bool, 'Expected a boolean.')
    elif kind == 'integer':
        require(type(value) is int and abs(value) <= 2**31 - 1, 'Expected a bounded integer.')
    else:
        require(finite(value), 'Expected a bounded finite float.')


def validate_binding(value):
    exact(value, {'artifactId', 'sha256', 'topologyId'})
    token(value['artifactId']); digest(value['sha256']); token(value['topologyId'])


def validate_metadata(value):
    exact(value, {'uvSets', 'normalDomain', 'materials', 'quality'})
    require(isinstance(value['uvSets'], list) and len(value['uvSets']) <= 8, 'UV set limit exceeded.')
    require(isinstance(value['materials'], list) and len(value['materials']) <= 64, 'Material limit exceeded.')
    for name in value['uvSets'] + value['materials']: token(name, 64)
    require(len(set(value['uvSets'])) == len(value['uvSets']) and len(set(value['materials'])) == len(value['materials']), 'Duplicate metadata identifiers.')
    require(value['normalDomain'] in ('Point', 'Corner', None), 'Invalid normal domain.')
    exact(value['quality'], {'state', 'issues'})
    require(value['quality']['state'] == 'diagnostic-only' and isinstance(value['quality']['issues'], list) and len(value['quality']['issues']) <= 64, 'M1 quality metadata must remain diagnostic-only.')
    for issue in value['quality']['issues']: token(issue, 64)


def validate_provenance(value):
    exact(value, {'nodeId', 'jobId', 'runId', 'revision', 'recipeHash', 'inputHashes'})
    token(value['nodeId'], 128); token(value['jobId'], 40); token(value['runId'], 64)
    integer(value['revision'], 1, 2**53 - 1); digest(value['recipeHash'])
    require(isinstance(value['inputHashes'], list) and len(value['inputHashes']) <= 16, 'Input provenance limit exceeded.')
    for item in value['inputHashes']: digest(item)


def validate_artifact_metadata(value):
    exact(value['bounds'], {'min', 'max'})
    for point in value['bounds'].values(): validate_scalar(point, 'vector3')
    require(all(a <= b for a, b in zip(value['bounds']['min'], value['bounds']['max'])), 'Invalid bounds ordering.')
    exact(value['producer'], {'pluginId', 'pluginVersion', 'commit'})
    token(value['producer']['pluginId']); token(value['producer']['pluginVersion'], 32)
    require(isinstance(value['producer']['commit'], str) and re.fullmatch('[a-f0-9]{40}', value['producer']['commit']), 'Invalid producer commit.')
    validate_provenance(value['provenance']); validate_metadata(value['metadata'])
    require(value['artifactId'] == 'pcg_' + value['sha256'], 'Artifact identity must bind its immutable content hash.')


def validate_context(value):
    exact(value, {'binding', 'counts'}); validate_binding(value['binding'])
    require(isinstance(value['counts'], dict) and set(value['counts']) <= DOMAINS and value['counts'].get('Detail') == 1, 'Invalid geometry context domains.')
    for count in value['counts'].values(): integer(count)


def _base(value, kind, fields):
    exact(value, {'contractVersion', 'type', *fields})
    require(value['contractVersion'] == 1 and type(value['contractVersion']) is int, 'Unsupported contract version.', 'VERSION_UNSUPPORTED')
    require(value['type'] == kind, 'Port type differs from value contract.')


def validate_geometry(value, project_id):
    _base(value, 'GeometryArtifact', {'projectId', 'artifactId', 'sha256', 'assetPath', 'format', 'coordinates', 'topologyId', 'counts', 'bounds', 'producer', 'provenance', 'metadata'})
    require(value['projectId'] == project_id, 'Artifact belongs to a different project.', 'CROSS_PROJECT')
    require(isinstance(value['projectId'], str) and re.fullmatch(r'prj_[A-Za-z0-9_-]+', value['projectId']), 'Invalid artifact project identity.')
    token(value['artifactId']); digest(value['sha256']); token(value['topologyId'])
    require(value['assetPath'] == f"assets/{value['sha256']}.pcg.json", 'Asset path must be content addressed.')
    require(value['format'] == 'pcg.geometry.json', 'Unsupported geometry format.', 'FORMAT_UNSUPPORTED')
    require(value['coordinates'] == {'units': 'm', 'handedness': 'right', 'upAxis': 'Y'}, 'Coordinates must be metre, right-handed, Y-up.')
    exact(value['counts'], {'Point', 'Face', 'Corner'})
    for count in value['counts'].values(): integer(count)
    require(value['counts']['Corner'] >= value['counts']['Face'], 'Corner and Face counts are inconsistent.')
    validate_artifact_metadata(value)
    return value


def validate_instances(value, project_id):
    _base(value, 'InstanceSet', {'projectId', 'artifactId', 'sha256', 'assetPath', 'format', 'geometry', 'topologyId', 'count', 'instanceIds', 'transforms', 'coordinates', 'bounds', 'producer', 'provenance', 'metadata'})
    require(value['projectId'] == project_id, 'Instance set belongs to a different project.', 'CROSS_PROJECT')
    require(isinstance(value['projectId'], str) and re.fullmatch(r'prj_[A-Za-z0-9_-]+', value['projectId']), 'Invalid instance project identity.')
    token(value['artifactId']); digest(value['sha256'])
    require(value['assetPath'] == f"assets/{value['sha256']}.pcg.json", 'Asset path must be content addressed.')
    require(value['format'] == 'pcg.instances.json', 'Unsupported instance format.', 'FORMAT_UNSUPPORTED')
    validate_binding(value['geometry']); integer(value['count'])
    token(value['topologyId'])
    require(value['coordinates'] == {'units': 'm', 'handedness': 'right', 'upAxis': 'Y'}, 'Coordinates must be metre, right-handed, Y-up.')
    require(isinstance(value['instanceIds'], list) and len(value['instanceIds']) == value['count'], 'Instance identity count differs.')
    for identity in value['instanceIds']: token(identity, 64)
    require(len(set(value['instanceIds'])) == value['count'], 'Instance IDs must be unique and stable.')
    validate_artifact_metadata(value)
    require(isinstance(value['transforms'], list) and len(value['transforms']) == value['count'], 'Instance count mismatch.')
    for transform in value['transforms']:
        require(isinstance(transform, list) and len(transform) == 16 and all(finite(v) for v in transform), 'Invalid instance transform.')
        require(transform[12:] == [0, 0, 0, 1], 'Transform must be row-major affine.')
    return value


def validate_attribute(value, geometry):
    validate_context(geometry)
    kind = value.get('type') if isinstance(value, dict) else None
    require(isinstance(kind, str) and kind in {'Attribute', 'Selection'}, 'Expected Attribute or Selection.')
    _base(value, kind, {'geometry', 'domain', 'valueType', 'values'})
    validate_binding(value['geometry']); validate_binding(geometry['binding'])
    require(value['geometry'] == geometry['binding'], 'Attribute geometry/topology binding differs.', 'GEOMETRY_MISMATCH')
    require(isinstance(value['domain'], str) and value['domain'] in DOMAINS and value['domain'] in geometry['counts'], 'Invalid attribute domain.', 'DOMAIN_MISMATCH')
    require(isinstance(value['valueType'], str) and value['valueType'] in VALUE_TYPES, 'Unknown attribute value type.')
    if kind == 'Selection': require(value['valueType'] == 'boolean', 'Selection must be boolean.')
    values = value['values']
    require(isinstance(values, list) and len(values) <= MAX_ITEMS and len(values) == geometry['counts'][value['domain']], 'Attribute domain count mismatch.', 'DOMAIN_MISMATCH')
    for item in values: validate_scalar(item, value['valueType'])
    return value


def validate_field(value, geometry):
    validate_context(geometry)
    _base(value, 'Field', {'geometry', 'domain', 'valueType', 'nodes', 'output'})
    validate_binding(value['geometry'])
    require(value['geometry'] == geometry['binding'], 'Field geometry/topology binding differs.', 'GEOMETRY_MISMATCH')
    require(isinstance(value['domain'], str) and value['domain'] in DOMAINS and value['domain'] in geometry['counts'], 'Invalid field domain.', 'DOMAIN_MISMATCH')
    require(isinstance(value['valueType'], str) and value['valueType'] in VALUE_TYPES, 'Unknown field value type.')
    nodes = value['nodes']
    require(isinstance(nodes, list) and 1 <= len(nodes) <= 64, 'Field DAG must have 1 through 64 nodes.')
    seen = {}
    for node in nodes:
        require(isinstance(node, dict), 'Invalid field node.')
        op = node.get('op')
        require(isinstance(op, str) and op in {'constant', 'attribute', 'add', 'multiply'}, 'Unknown field operation; expressions are forbidden.')
        fields = {'id', 'op', 'valueType'} | ({'value'} if op == 'constant' else {'attribute'} if op == 'attribute' else {'inputs'})
        exact(node, fields); token(node['id'], 64)
        require(node['id'] not in seen, 'Duplicate field node.')
        require(isinstance(node['valueType'], str) and node['valueType'] in VALUE_TYPES, 'Unknown field value type.')
        if op == 'constant': validate_scalar(node['value'], node['valueType'])
        elif op == 'attribute':
            validate_attribute(node['attribute'], geometry)
            require(node['attribute']['domain'] == value['domain'] and node['attribute']['valueType'] == node['valueType'], 'Field attribute domain/type mismatch.', 'DOMAIN_MISMATCH')
        else:
            refs = node['inputs']
            require(isinstance(refs, list) and len(refs) == 2 and all(isinstance(r, str) and r in seen for r in refs), 'Field references must be earlier DAG nodes.')
            require(node['valueType'] in {'float', 'integer', 'vector3'} and all(seen[r] == node['valueType'] for r in refs), 'Field operand type mismatch.')
        seen[node['id']] = node['valueType']
    require(isinstance(value['output'], str) and seen.get(value['output']) == value['valueType'], 'Field output is missing or mistyped.')
    return value


def geometry_context(geometry):
    validate_geometry(geometry, geometry.get('projectId') if isinstance(geometry, dict) else None)
    return {'binding': {k: geometry[k] for k in ('artifactId', 'sha256', 'topologyId')}, 'counts': {**geometry['counts'], 'Detail': 1}}


def instance_context(instances):
    validate_instances(instances, instances.get('projectId') if isinstance(instances, dict) else None)
    return {'binding': {k: instances[k] for k in ('artifactId', 'sha256', 'topologyId')}, 'counts': {'Instance': instances['count'], 'Detail': 1}}


def validate_value(value, kind, project_id, geometry=None):
    require(len(canonical(value)) <= MAX_VALUE_BYTES, 'Contract value exceeds byte budget.', 'BUDGET_EXCEEDED')
    if kind == 'GeometryArtifact': return validate_geometry(value, project_id)
    if kind == 'InstanceSet': return validate_instances(value, project_id)
    require(geometry is not None, 'Field/attribute needs explicit geometry context.', 'GEOMETRY_MISMATCH')
    if kind in {'Attribute', 'Selection'}: return validate_attribute(value, geometry)
    if kind == 'Field': return validate_field(value, geometry)
    raise PCGError('INVALID_CONTRACT', 'Unknown or unsupported input type.')


def load_registry(path=REGISTRY_PATH):
    value = parse_json(Path(path).read_text(encoding='utf-8'))
    exact(value, {'descriptorVersion', 'namespace', 'pluginVersion', 'nodes'})
    require(type(value['descriptorVersion']) is int and value['descriptorVersion'] == 1, 'Unsupported descriptor version.', 'VERSION_UNSUPPORTED')
    require(value['namespace'] == 'refmuse.pcg' and value['pluginVersion'] == '1.0.0', 'Unsupported plugin version.', 'VERSION_UNSUPPORTED')
    require(isinstance(value['nodes'], list) and 1 <= len(value['nodes']) <= 32, 'Registry node limit exceeded.')
    ids = set()
    for descriptor in value['nodes']:
        exact(descriptor, {'id', 'descriptorVersion', 'pluginVersion', 'operationVersion', 'label', 'category', 'parameters', 'inputs', 'outputs', 'budget', 'permissions', 'readiness', 'examples', 'errors'})
        token(descriptor['id']); require(descriptor['id'] not in ids, 'Duplicate descriptor.')
        ids.add(descriptor['id'])
        require(type(descriptor['descriptorVersion']) is int and descriptor['descriptorVersion'] == 1 and type(descriptor['operationVersion']) is int and descriptor['operationVersion'] == 1 and descriptor['pluginVersion'] == value['pluginVersion'], 'Unsupported operation version.', 'VERSION_UNSUPPORTED')
        require(descriptor['permissions'] == [], 'Unknown permissions are forbidden.', 'PERMISSION_FORBIDDEN')
        exact(descriptor['readiness'], {'state', 'code'})
        require(descriptor['readiness'] in ({'state': 'ready', 'code': None}, {'state': 'unavailable', 'code': 'EXECUTOR_UNAVAILABLE'}), 'Unknown readiness state.')
        for direction in ('inputs', 'outputs'):
            ports = descriptor[direction]
            require(isinstance(ports, list) and len(ports) <= 16, 'Invalid ports.')
            names = set()
            for port in ports:
                exact(port, {'name', 'type', 'required'}); token(port['name'], 32)
                require(port['name'] not in names and isinstance(port['type'], str) and port['type'] in TYPES and type(port['required']) is bool, 'Unknown or duplicate port type/name.')
                names.add(port['name'])
        exact(descriptor['budget'], {'timeoutMs', 'maxInputBytes', 'maxOutputBytes', 'maxItems'})
        integer(descriptor['budget']['timeoutMs'], 1, 5000); integer(descriptor['budget']['maxInputBytes'], 1, MAX_VALUE_BYTES)
        integer(descriptor['budget']['maxOutputBytes'], 1, 65536); integer(descriptor['budget']['maxItems'], 1, MAX_ITEMS)
        schema = descriptor['parameters']
        exact(schema, {'type', 'additionalProperties', 'properties', 'required'})
        require(schema['type'] == 'object' and schema['additionalProperties'] is False and isinstance(schema['properties'], dict) and isinstance(schema['required'], list), 'Invalid closed parameter schema.')
        require(set(schema['required']) <= set(schema['properties']), 'Invalid required parameters.')
        for name, field in schema['properties'].items():
            token(name, 32); exact(field, {'type', 'maxLength', 'default'})
            require(field['type'] == 'string', 'Unknown parameter type.')
            integer(field['maxLength'], 1, 80)
            require(isinstance(field['default'], str) and len(field['default']) <= field['maxLength'], 'Invalid parameter default.')
        require(isinstance(descriptor['label'], str) and len(descriptor['label']) <= 80 and isinstance(descriptor['category'], str) and len(descriptor['category']) <= 32, 'Invalid descriptor display text.')
        require(isinstance(descriptor['examples'], list) and len(descriptor['examples']) <= 8 and isinstance(descriptor['errors'], list) and len(descriptor['errors']) <= 32, 'Invalid examples/errors.')
        for code in descriptor['errors']: token(code, 64)
        for example in descriptor['examples']:
            exact(example, {'parameters'}); validate_parameters(descriptor, example['parameters'])
    return value


def find_descriptor(registry, descriptor_id, descriptor_version=1, operation_version=1):
    require(type(descriptor_version) is int and descriptor_version == 1 and type(operation_version) is int and operation_version == 1, 'Unsupported descriptor/operation version.', 'VERSION_UNSUPPORTED')
    match = next((n for n in registry['nodes'] if n['id'] == descriptor_id), None)
    require(match is not None, 'Unknown PCG descriptor.', 'DESCRIPTOR_UNKNOWN')
    return match


def validate_parameters(descriptor, parameters):
    schema = descriptor['parameters']
    exact(parameters, schema['required'], schema['properties'])
    result = {}
    for name, spec in schema['properties'].items():
        item = parameters.get(name, spec['default'])
        require(isinstance(item, str) and len(item) <= spec['maxLength'] and '\x00' not in item, 'Invalid parameter value.')
        result[name] = item
    return result


def safe_components(path):
    for component in (Path(path), *Path(path).parents):
        info = component.lstat()
        require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)), 'Linked/reparse paths are forbidden.', 'ASSET_PATH_FORBIDDEN')


class AssetBroker:
    """Reads only registered, hashed, flat PCG JSON; returns no physical path."""
    def __init__(self, store):
        self.store = store

    def read(self, project_id, artifact):
        require(isinstance(artifact, dict) and artifact.get('type') in {'GeometryArtifact', 'InstanceSet'}, 'Expected managed artifact.')
        validate_value(artifact, artifact['type'], project_id)
        project = self.store._project_path(project_id)
        relative = artifact['assetPath']
        candidate = project.parent / relative
        try:
            safe_components(project); safe_components(candidate)
            info = candidate.stat()
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= MAX_VALUE_BYTES, 'Asset file exceeds storage policy.', 'ASSET_PATH_FORBIDDEN')
            document = self.store._read(project, migrate=False)
            require(document['id'] == project_id, 'Wrong project identity.', 'CROSS_PROJECT')
            entry = next((a for a in document['assets'] if a.get('path') == relative), None)
            require(entry is not None and entry.get('sha256') == artifact['sha256'] and entry.get('bytes') == info.st_size, 'Asset is not registered with this project.', 'ASSET_UNMANAGED')
            with candidate.open('rb') as stream:
                before = stream.fileno()
                import os
                opened = os.fstat(before)
                require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino) and opened.st_nlink == 1 and stat.S_ISREG(opened.st_mode), 'Asset changed during open.', 'ASSET_CHANGED')
                body = stream.read(MAX_VALUE_BYTES + 1)
            safe_components(candidate)
            require(len(body) <= MAX_VALUE_BYTES and hashlib.sha256(body).hexdigest() == artifact['sha256'], 'Asset content hash changed.', 'ASSET_HASH_MISMATCH')
            value = parse_json(body)
            exact(value, {'contractVersion', 'format', 'payload'})
            require(type(value['contractVersion']) is int and value['contractVersion'] == 1, 'Unsupported asset container version.', 'VERSION_UNSUPPORTED')
            require(value['format'] == artifact['format'] and isinstance(value['payload'], dict), 'Unknown asset container format.', 'FORMAT_UNSUPPORTED')
            return value
        except (OSError, ValueError, RecursionError) as exc:
            raise PCGError('ASSET_INVALID', 'Managed asset could not be read safely.') from exc
