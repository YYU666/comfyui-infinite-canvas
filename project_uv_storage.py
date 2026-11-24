"""Lossless, self-contained on-disk interning of duplicate Native3D UV plans."""

import copy
import hashlib
import json

STORAGE_KEY = '_refmuseUvPlanStorage'
REFERENCE_KEY = '$uvPlanIndex'
MAX_PROJECT_JSON_BYTES = 128 * 1024 * 1024
MAX_UV_PLANS = 2048


def json_bytes(value, *, sort_keys=False):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False, sort_keys=sort_keys).encode('utf-8')


def plan_slots(document):
    if not isinstance(document, dict):
        return
    canvas = document.get('canvas')
    nodes = canvas.get('nodes') if isinstance(canvas, dict) else None
    if not isinstance(nodes, list):
        return
    for node in nodes:
        if not isinstance(node, dict) or node.get('type') != 'native3d':
            continue
        data = node.get('data')
        if not isinstance(data, dict):
            continue
        records = data.get('nativeOutputRecords')
        values = [data]
        if isinstance(records, list):
            values.extend(record.get('data') for record in records if isinstance(record, dict))
        for value in values:
            if not isinstance(value, dict):
                continue
            if isinstance(value.get('nativeUVPlan'), dict):
                yield value, 'nativeUVPlan'
            metadata = value.get('metadata')
            if isinstance(metadata, dict) and isinstance(metadata.get('uvPlan'), dict):
                yield metadata, 'uvPlan'


def pack_uv_plans(document):
    """Intern only byte-identical values and leave the caller's document alone."""
    if STORAGE_KEY in document:
        raise ValueError('UV-plan storage key is reserved')
    slots = list(plan_slots(document))
    if any(REFERENCE_KEY in container[field] for container, field in slots):
        return document
    fingerprints = []
    candidates = {}
    for container, field in slots:
        value = container[field]
        body = json_bytes(value, sort_keys=True)
        if len(body) < 128:
            fingerprints.append(None)
            continue
        key = hashlib.sha256(body).digest()
        record = candidates.setdefault(key, [value, 0, len(body)])
        if record[0] != value:
            raise ValueError('UV-plan fingerprint collision')
        record[1] += 1
        fingerprints.append(key)
    reusable = {key: record for key, record in candidates.items() if record[1] > 1}
    if not reusable or len(reusable) > MAX_UV_PLANS:
        return document
    if len(json_bytes(document)) > MAX_PROJECT_JSON_BYTES:
        return document
    packed = copy.deepcopy(document)
    index = {key: number for number, key in enumerate(reusable)}
    for (container, field), key in zip(plan_slots(packed), fingerprints):
        if key in index:
            container[field] = {REFERENCE_KEY: index[key]}
    packed[STORAGE_KEY] = {'version': 1, 'plans': [record[0] for record in reusable.values()]}
    return packed


def decode_project_json(raw):
    """Hydrate independent copies and bound expansion before cloning plans."""
    document = json.loads(raw)
    if not isinstance(document, dict) or STORAGE_KEY not in document:
        return document
    storage = document.pop(STORAGE_KEY)
    if not isinstance(storage, dict) or type(storage.get('version')) is not int or storage['version'] != 1:
        raise ValueError('Unsupported UV-plan storage version')
    plans = storage.get('plans')
    if (not isinstance(plans, list) or not 0 < len(plans) <= MAX_UV_PLANS
            or any(not isinstance(plan, dict) or REFERENCE_KEY in plan for plan in plans)):
        raise ValueError('Invalid UV-plan table')
    sizes = [len(json_bytes(plan)) for plan in plans]
    stored_size = len(raw.encode('utf-8') if isinstance(raw, str) else raw)
    expanded = stored_size - len(json_bytes(storage)) - len(json_bytes(STORAGE_KEY)) - 2
    replacements = []
    for container, field in plan_slots(document):
        value = container[field]
        if REFERENCE_KEY not in value:
            continue
        index = value[REFERENCE_KEY]
        if len(value) != 1 or type(index) is not int or not 0 <= index < len(plans):
            raise ValueError('Invalid UV-plan reference')
        expanded += sizes[index] - len(json_bytes(value))
        if expanded > MAX_PROJECT_JSON_BYTES:
            raise ValueError('Expanded UV-plan project exceeds 128 MiB')
        replacements.append((container, field, index))
    if {index for _, _, index in replacements} != set(range(len(plans))):
        raise ValueError('Unused UV-plan table entries')
    for container, field, index in replacements:
        container[field] = copy.deepcopy(plans[index])
    return document
