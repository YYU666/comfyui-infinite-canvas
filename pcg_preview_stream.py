"""Bounded byte-patch previews of validated, immutable demo-owned GLBs.

Only equal-length GLBs with identical decoded layout and topology qualify.
The target hash authenticates reconstruction; transport hashes cover canonical JSON.
"""
from __future__ import annotations
import base64
import copy
import hashlib
import struct

from pcg_contracts import canonical, parse_json, require

MAX_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_CHANGES = 65536
COALESCE_GAP = 16


def _parts(body):
    size = struct.unpack_from('<I', body, 12)[0]
    document = parse_json(body[20:20 + size])
    return document, 28 + size, body[28 + size:]


def _mesh_ranges(document, binary_start):
    allowed = []
    for mesh in document.get('meshes', []):
        for primitive in mesh['primitives']:
            for name, index in primitive['attributes'].items():
                if name not in ('POSITION', 'NORMAL'): continue
                item = document['accessors'][index]; view = document['bufferViews'][item['bufferView']]
                start = binary_start + view.get('byteOffset', 0) + item.get('byteOffset', 0)
                allowed.append((start, start + item['count'] * 12))
    return sorted(allowed)


def _immutable_accessor_ranges(document, binary_start):
    mutable = set()
    for mesh in document.get('meshes', []):
        for primitive in mesh['primitives']:
            mutable.update(index for name, index in primitive['attributes'].items() if name in ('POSITION', 'NORMAL'))
    protected = []
    for index, item in enumerate(document.get('accessors', [])):
        if index in mutable: continue
        view = document['bufferViews'][item['bufferView']]
        start = binary_start + view.get('byteOffset', 0) + item.get('byteOffset', 0)
        width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[item['type']]
        protected.append((start, start + item['count'] * width * 4))
    return protected


def _without_bounds(document):
    result = copy.deepcopy(document)
    for mesh in result.get('meshes', []):
        for primitive in mesh['primitives']:
            for name, index in primitive['attributes'].items():
                if name == 'POSITION':
                    result['accessors'][index].pop('min', None); result['accessors'][index].pop('max', None)
    return result


def _without_transforms(document):
    result = copy.deepcopy(document)
    for node in result.get('nodes', []):
        for name in ('translation', 'rotation', 'scale'): node.pop(name, None)
    return result


def _eligible(base, target):
    if len(base) != len(target): return None, 'byte-length-mismatch'
    left, left_start, left_bin = _parts(base); right, right_start, right_bin = _parts(target)
    if left_start != right_start: return None, 'layout-mismatch'
    # Instance transforms live in JSON nodes in the existing M2 glTF writer.
    if left_bin == right_bin and _without_transforms(left) == _without_transforms(right):
        if any('translation' in node for node in right.get('nodes', [])):
            return 'instance-delta', None
    if _without_bounds(left) != _without_bounds(right): return None, 'topology-or-layout-mismatch'
    allowed = _mesh_ranges(left, left_start)
    if not allowed: return None, 'unsupported-geometry'
    # Imported validated GLBs may alias views; immutable UV/index bytes stay protected even then.
    for start, end in _immutable_accessor_ranges(left, left_start):
        if base[start:end] != target[start:end]: return None, 'immutable-buffer-mismatch'
    cursor = left_start
    for start, end in allowed:
        if start < cursor: return None, 'overlapping-accessors'
        if base[cursor:start] != target[cursor:start]: return None, 'immutable-buffer-mismatch'
        cursor = end
    if base[cursor:] != target[cursor:]: return None, 'immutable-buffer-mismatch'
    return 'mesh-delta', None


def _changes(base, target):
    ranges = []; start = None; last = None
    for index, (old, new) in enumerate(zip(base, target)):
        if old == new: continue
        if start is None: start = index
        elif index - last > COALESCE_GAP + 1:
            ranges.append((start, last + 1)); start = index
            if len(ranges) > MAX_CHANGES: return None
        last = index
    if start is not None: ranges.append((start, last + 1))
    if len(ranges) > MAX_CHANGES: return None
    return [{'offset': start, 'base64': base64.b64encode(target[start:end]).decode('ascii')} for start, end in ranges]


def build_preview(target, target_metadata, base=None, base_metadata=None):
    """Return (small descriptor, optional immutable canonical patch bytes)."""
    from pcg_demo_session import _glb_summary
    _glb_summary(target)
    target_sha = hashlib.sha256(target).hexdigest()
    require(target_metadata['sha256'] == target_sha and target_metadata['bytes'] == len(target),
            'Preview target identity differs.', 'ASSET_HASH_MISMATCH')
    base_sha = None
    if base is not None:
        _glb_summary(base); base_sha = hashlib.sha256(base).hexdigest()
        require(base_metadata is not None and base_metadata['sha256'] == base_sha and base_metadata['bytes'] == len(base),
                'Preview base identity differs.', 'ASSET_HASH_MISMATCH')
    descriptor = {'contractVersion': 1, 'kind': 'snapshot', 'targetAssetId': target_metadata['assetId'],
                  'baseAssetId': base_metadata['assetId'] if base_metadata else None, 'baseSha256': base_sha,
                  'targetSha256': target_sha, 'targetBytes': len(target), 'bytes': len(target), 'sha256': target_sha,
                  'url': target_metadata['url']}
    kind, reason = ((None, 'identical-content') if base == target else _eligible(base, target)) if base is not None else (None, 'base-unavailable')
    if kind is not None:
        changes = _changes(base, target)
        if changes is None: reason = 'patch-range-budget'
        elif not changes: reason = 'identical-content'
        else:
            payload = canonical({'contractVersion': 1, 'kind': kind, 'baseSha256': base_sha,
                                 'targetSha256': target_sha, 'targetBytes': len(target), 'changes': changes})
            if len(payload) < len(target) and len(payload) <= MAX_PREVIEW_BYTES:
                sha = hashlib.sha256(payload).hexdigest()
                descriptor.update(kind=kind, bytes=len(payload), sha256=sha, url='/api/previews/' + sha + '.json')
                return descriptor, payload
            reason = 'patch-byte-budget' if len(payload) > MAX_PREVIEW_BYTES else 'patch-not-smaller'
    descriptor['reason'] = reason
    return descriptor, None
