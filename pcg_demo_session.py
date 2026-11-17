"""Independent, bounded read-only demo session over unchanged M2 tasks."""
from __future__ import annotations
import copy
import hashlib
import math
import os
import re
from pathlib import Path
import stat
import struct
import threading
import time
import uuid

from pcg_contracts import (PCGError, canonical, content_hash, digest, integer,
                           parse_json, require, safe_components, token)
from pcg_runtime import HANDLE, PCGRuntime, validate_identity
from project_store import ProjectStore, StoreError

MAX_ASSET_BYTES = 64 * 1024 * 1024
MAX_CACHE_BYTES = 128 * 1024 * 1024
MAX_CATALOG = 512
TERMINAL = {'succeeded', 'failed', 'cancelled'}


def _safe_read(path, maximum):
    safe_components(path); info = path.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= maximum,
            'Managed file violates size/link policy.', 'ASSET_PATH_FORBIDDEN')
    with path.open('rb') as stream:
        opened = os.fstat(stream.fileno())
        require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino) and opened.st_nlink == 1,
                'Managed file changed while opening.', 'ASSET_CHANGED')
        body = stream.read(maximum + 1)
    safe_components(path)
    require(len(body) == info.st_size, 'Managed file size changed.', 'ASSET_CHANGED')
    return body


def _glb_summary(body):
    """Validate the bounded M2 GLB subset without resolving any external resource."""
    require(type(body) is bytes and 20 <= len(body) <= MAX_ASSET_BYTES, 'GLB byte budget exceeded.', 'GLB_INVALID')
    require(struct.unpack_from('<4sII', body) == (b'glTF', 2, len(body)), 'Invalid GLB header.', 'GLB_INVALID')
    cursor = 12; chunks = []
    while cursor < len(body):
        require(cursor + 8 <= len(body), 'Truncated GLB chunk.', 'GLB_INVALID')
        require(len(chunks) < 2, 'GLB chunk count exceeds budget.', 'GLB_INVALID')
        size, kind = struct.unpack_from('<I4s', body, cursor); cursor += 8
        require((not chunks and kind == b'JSON' and size <= 8 * 1024 * 1024) or (len(chunks) == 1 and kind == b'BIN\x00'), 'Unsupported GLB chunk.', 'GLB_INVALID')
        require(size % 4 == 0 and cursor + size <= len(body), 'Invalid GLB chunk length.', 'GLB_INVALID')
        chunks.append((kind, body[cursor:cursor + size])); cursor += size
    require(1 <= len(chunks) <= 2 and chunks[0][0] == b'JSON' and len(chunks[0][1]) <= 8 * 1024 * 1024,
            'Unsupported GLB chunks.', 'GLB_INVALID')
    require(len(chunks) == 1 or chunks[1][0] == b'BIN\x00', 'Unsupported GLB binary chunk.', 'GLB_INVALID')
    document = parse_json(chunks[0][1]); binary = chunks[1][1] if len(chunks) == 2 else b''
    require(isinstance(document, dict) and isinstance(document.get('asset'), dict) and document['asset'].get('version') == '2.0', 'Invalid glTF version.', 'GLB_INVALID')
    def no_resources(value, depth=0):
        require(depth <= 24, 'GLB JSON nesting exceeds budget.', 'GLB_INVALID')
        if isinstance(value, dict):
            require(not any(k in value for k in ('uri', 'extensions', 'extensionsRequired', 'extensionsUsed')),
                    'External resources/extensions are forbidden.', 'GLB_EXTERNAL_RESOURCE')
            for v in value.values(): no_resources(v, depth + 1)
        elif isinstance(value, list):
            for v in value: no_resources(v, depth + 1)
        elif type(value) in (float, int): require(math.isfinite(value) and abs(value) <= 1e12, 'Nonfinite GLB value.', 'GLB_INVALID')
    no_resources(document)
    require(not any(k in document for k in ('images', 'textures', 'skins', 'animations', 'cameras')), 'Unsupported M2 GLB resource.', 'GLB_INVALID')
    meshes = document.get('meshes', []); nodes = document.get('nodes', []); accessors = document.get('accessors', []); views = document.get('bufferViews', [])
    require(isinstance(meshes, list) and len(meshes) <= 1 and isinstance(nodes, list) and len(nodes) <= 10000 and
            isinstance(accessors, list) and len(accessors) <= 8 and isinstance(views, list) and len(views) <= 8,
            'GLB structure exceeds M2 limits.', 'GLB_INVALID')
    buffers = document.get('buffers', [])
    require(isinstance(buffers, list) and len(buffers) <= 1 and bool(buffers) == bool(binary), 'Invalid GLB buffer.', 'GLB_INVALID')
    if buffers:
        require(isinstance(buffers[0], dict) and set(buffers[0]) == {'byteLength'} and type(buffers[0]['byteLength']) is int and
                0 <= buffers[0]['byteLength'] <= len(binary) <= buffers[0]['byteLength'] + 3, 'Invalid GLB buffer size.', 'GLB_INVALID')
    decoded = {}
    for index, accessor in enumerate(accessors):
        require(isinstance(accessor, dict) and not ('sparse' in accessor) and accessor.get('componentType') in (5126, 5125) and
                accessor.get('type') in ('SCALAR', 'VEC2', 'VEC3') and type(accessor.get('count')) is int and 0 < accessor['count'] <= 600000,
                'Unsupported GLB accessor.', 'GLB_INVALID')
        view_index = accessor.get('bufferView'); require(type(view_index) is int and 0 <= view_index < len(views), 'Invalid buffer view index.', 'GLB_INVALID')
        view = views[view_index]; require(isinstance(view, dict) and view.get('buffer') == 0 and 'byteStride' not in view, 'Unsupported GLB view.', 'GLB_INVALID')
        width = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3}[accessor['type']]
        offset = accessor.get('byteOffset', 0); view_offset = view.get('byteOffset', 0); length = view.get('byteLength')
        require(all(type(v) is int and v >= 0 for v in (offset, view_offset, length)) and buffers and
                offset + accessor['count'] * width * 4 <= length and view_offset + length <= buffers[0]['byteLength'], 'Accessor exceeds binary bounds.', 'GLB_INVALID')
        fmt = 'f' if accessor['componentType'] == 5126 else 'I'
        values = struct.unpack_from('<' + str(accessor['count'] * width) + fmt, binary, view_offset + offset)
        require(all(math.isfinite(v) and abs(v) <= 1e12 for v in values), 'Invalid GLB component.', 'GLB_INVALID')
        decoded[index] = [list(values[i:i + width]) for i in range(0, len(values), width)] if width > 1 else list(values)
    primitive = None; positions = []; face_count = 0; mode = 0
    if meshes:
        primitives = meshes[0].get('primitives') if isinstance(meshes[0], dict) else None
        require(isinstance(primitives, list) and len(primitives) == 1, 'Unsupported M2 mesh.', 'GLB_INVALID')
        primitive = primitives[0]; require(isinstance(primitive, dict), 'Invalid GLB primitive.', 'GLB_INVALID'); attrs = primitive.get('attributes', {})
        require(isinstance(attrs, dict) and set(attrs) <= {'POSITION', 'NORMAL', 'TEXCOORD_0'} and 'POSITION' in attrs,
                'Invalid geometry attributes.', 'GLB_INVALID')
        for name, index in attrs.items():
            require(type(index) is int and index in decoded and accessors[index]['componentType'] == 5126 and
                    accessors[index]['type'] == ('VEC2' if name == 'TEXCOORD_0' else 'VEC3'), 'Invalid geometry accessor.', 'GLB_INVALID')
        positions = decoded[attrs['POSITION']]; require(len(positions) <= 300000, 'Vertex budget exceeded.', 'GLB_INVALID')
        for index in attrs.values(): require(accessors[index]['count'] == len(positions), 'Attribute count differs.', 'GLB_INVALID')
        mode = primitive.get('mode', 4); require(mode in (0, 4), 'Unsupported primitive mode.', 'GLB_INVALID')
        if mode == 4:
            index = primitive.get('indices'); require(type(index) is int and index in decoded and accessors[index]['componentType'] == 5125 and accessors[index]['type'] == 'SCALAR', 'Invalid triangle indices.', 'GLB_INVALID')
            indices = decoded[index]; require(len(indices) % 3 == 0 and len(indices) <= 300000 and all(i < len(positions) for i in indices), 'Triangle indices exceed bounds.', 'GLB_INVALID')
            face_count = len(indices) // 3
    require(all(isinstance(n, dict) and type(n.get('mesh')) is int and n['mesh'] == 0 and not ('children' in n or 'matrix' in n) for n in nodes), 'Unsupported GLB node.', 'GLB_INVALID')
    scenes = document.get('scenes'); scene = document.get('scene', 0)
    require(isinstance(scenes, list) and len(scenes) == 1 and scene == 0 and isinstance(scenes[0], dict), 'Invalid GLB scene.', 'GLB_INVALID')
    require(scenes[0].get('nodes', []) == list(range(len(nodes))) and bool(meshes) == bool(nodes), 'Unreferenced GLB scene data.', 'GLB_INVALID')
    low = [min(p[i] for p in positions) for i in range(3)] if positions else [0, 0, 0]
    high = [max(p[i] for p in positions) for i in range(3)] if positions else [0, 0, 0]
    from pcg_geometry import transform_point
    transformed = []
    for node in nodes:
        translation = node.get('translation', [0, 0, 0]); rotation = node.get('rotation', [0, 0, 0, 1]); scale = node.get('scale', [1, 1, 1])
        for values, count in ((translation, 3), (rotation, 4), (scale, 3)):
            require(isinstance(values, list) and len(values) == count and all(type(v) in (int, float) and math.isfinite(v) and abs(v) <= 1e6 for v in values), 'Invalid node transform.', 'GLB_INVALID')
        require(abs(sum(v*v for v in rotation) - 1) <= 1e-5 and all(abs(v) >= 1e-8 for v in scale), 'Invalid node transform normalization.', 'GLB_INVALID')
        for x in (low[0], high[0]):
            for y in (low[1], high[1]):
                for z in (low[2], high[2]): transformed.append(transform_point([x, y, z], translation, rotation, scale))
    bounds = {'min': [min(p[i] for p in transformed) for i in range(3)] if transformed else [0, 0, 0],
              'max': [max(p[i] for p in transformed) for i in range(3)] if transformed else [0, 0, 0]}
    instances = len(nodes) > 1 or bool(nodes and 'translation' in nodes[0])
    kind = 'InstanceSet' if instances else 'Mesh' if mode == 4 else 'PointSet'
    counts = {'Instance': len(nodes), 'Detail': 1} if instances else {'Point': len(positions), 'Detail': 1}
    if kind == 'Mesh': counts.update(Face=face_count, Corner=face_count * 3)
    return {'geometryType': kind, 'counts': counts, 'bounds': bounds, 'boundsKind': 'conservative' if instances else 'exact'}


def _node(node_id, operation, parameters=None):
    return {'id': node_id, 'type': 'pcg', 'position': {'x': 0, 'y': 0},
            'data': {'descriptorId': 'refmuse.pcg.' + operation, 'descriptorVersion': 1,
                     'operationVersion': 1, 'parameters': parameters or {}}}


def _edge(source, target, source_port='geometry', target_port='geometry'):
    return {'id': source + '-' + target + '-' + target_port, 'source': source, 'target': target,
            'sourceHandle': source_port, 'targetHandle': target_port, 'data': {'pcgType': 'Field' if source_port == 'field' else 'Geometry'}}


def _graph(recipe, seed, roughness, count, distance):
    nodes = [_node('sphere', 'primitive', {'kind': 'sphere', 'subdivisions': 2}),
             _node('position', 'attribute_read'), _node('noise', 'noise_field', {'seed': seed, 'amplitude': roughness, 'frequency': 2, 'output': 'scalar'}),
             _node('multiply', 'field_math', {'operation': 'multiply'}), _node('displace', 'set_position'),
             _node('normals', 'recompute_normals'), _node('publish', 'publish_geometry')]
    edges = [_edge('sphere', 'position'), _edge('sphere', 'noise'),
             _edge('position', 'multiply', 'field', 'a'), _edge('noise', 'multiply', 'field', 'b'),
             _edge('sphere', 'displace'), _edge('multiply', 'displace', 'field', 'offset'),
             _edge('displace', 'normals'), _edge('normals', 'publish')]
    if recipe == 'scatter':
        nodes = [_node('ground', 'primitive', {'kind': 'plane', 'size': [8, 1, 8]})] + nodes
        nodes += [_node('points', 'scatter_points', {'seed': seed, 'count': count, 'minDistance': distance}),
                  _node('instances', 'instance_on_points', {'scale': [.35, .35, .35]}),
                  _node('instance-transform', 'instance_transform', {'translation': [0, .3, 0]})]
        edges += [_edge('ground', 'points'), _edge('points', 'instances', 'points', 'points'),
                  _edge('publish', 'instances', 'geometry', 'prototype'),
                  _edge('instances', 'instance-transform', 'instances', 'instances')]
    return {'nodes': nodes, 'edges': edges, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}}


class DemoSession:
    def __init__(self, root: Path, samples_root: Path | None = None):
        require(not str(root).startswith(('\\\\', '//')), 'Network session roots are forbidden.', 'ASSET_PATH_FORBIDDEN')
        self.root = Path(root).absolute(); self.root.mkdir(parents=True, exist_ok=True); safe_components(self.root)
        self.instance_id = 'demo_' + uuid.uuid4().hex
        self.lock = threading.RLock(); self.revision = 1; self.selection_epoch = 0
        self.closed = False; self.auto_follow = True; self.run = None; self.desired = None
        self.catalog = {}; self.records = {}; self.unique_bytes = {}; self.events = []; self.event_sequence = 0
        self.graph = {'nodes': [], 'edges': []}; self._thread = None; self._cancel = threading.Event(); self._last_geometry = None
        cache = self.root / 'cache'; cache.mkdir(exist_ok=True); safe_components(cache); self.cache_root = cache
        for cached in cache.iterdir():
            require(re.fullmatch(r'[a-f0-9]{64}\.glb', cached.name), 'Unrecognized entry in demo-owned cache.', 'ASSET_PATH_FORBIDDEN')
            body = _safe_read(cached, MAX_ASSET_BYTES)
            require(hashlib.sha256(body).hexdigest() == cached.stem, 'Existing cached asset hash differs.', 'ASSET_HASH_MISMATCH')
            _glb_summary(body); self.unique_bytes[cached.stem] = len(body)
            require(len(self.unique_bytes) <= MAX_CATALOG and sum(self.unique_bytes.values()) <= MAX_CACHE_BYTES, 'Existing demo cache exceeds capacity.', 'CATALOG_CAPACITY', 409)
        projects = self.root / 'projects'; projects.mkdir(exist_ok=True); safe_components(projects)
        self.store = ProjectStore(projects / self.instance_id)
        self.document = self.store.create('Independent PCG Demo')
        self.runtime = PCGRuntime(self.store)
        try:
            if samples_root is not None: self._import_samples(Path(samples_root))
        except BaseException:
            self.runtime.close(); self.store.close(); raise

    def _event(self, kind, **details):
        self.event_sequence += 1; self.revision += 1
        self.events.append({'sequence': self.event_sequence, 'kind': kind, 'time': time.time(), **details})
        self.events = self.events[-256:]

    def snapshot(self):
        with self.lock:
            return copy.deepcopy({'contractVersion': 1, 'instanceId': self.instance_id, 'revision': self.revision,
                                  'selectionEpoch': self.selection_epoch, 'autoFollow': self.auto_follow, 'closed': self.closed,
                                  'run': self.run, 'desired': self.desired, 'catalog': list(self.catalog.values()),
                                  'graph': self.graph, 'events': self.events})

    def _choose(self, metadata):
        self.desired = copy.deepcopy(metadata); self.selection_epoch += 1
        self._event('selection', assetId=metadata['assetId'], selectionEpoch=self.selection_epoch)

    def select(self, asset_id):
        token(asset_id)
        with self.lock:
            require(not self.closed, 'Demo session is closed.', 'SESSION_CLOSED', 409)
            require(asset_id in self.catalog, 'Managed demo asset not found.', 'ASSET_NOT_FOUND', 404)
            if self.run and self.run['status'] not in TERMINAL: self.auto_follow = False
            self._choose(self.catalog[asset_id]); return self.snapshot()

    def _register(self, body, summary, source, producer_node, run_id, job_id, input_hash, label):
        token(producer_node); token(run_id, 64); token(job_id, 40); digest(input_hash)
        decoded = _glb_summary(body); sha = hashlib.sha256(body).hexdigest()
        require(isinstance(summary, dict) and summary.get('geometryType') in {'Mesh', 'PointSet', 'InstanceSet'} and
                isinstance(summary.get('counts'), dict) and isinstance(summary.get('bounds'), dict), 'Missing geometry summary.', 'ASSET_INVALID')
        require(summary['geometryType'] == decoded['geometryType'] or not decoded['counts'].get('Point', 1), 'GLB geometry type differs from evidence.', 'ASSET_INVALID')
        domains = {'Mesh': {'Point', 'Face', 'Corner', 'Detail'}, 'PointSet': {'Point', 'Detail'}, 'InstanceSet': {'Instance', 'Detail'}}
        require(set(summary['counts']) == domains[summary['geometryType']] and summary['counts'].get('Detail') == 1 and set(summary['bounds']) == {'min', 'max'} and summary.get('boundsKind', decoded['boundsKind']) in {'exact', 'conservative'}, 'Invalid geometry summary domains.', 'ASSET_INVALID')
        for count in summary['counts'].values(): integer(count, 0, 300000)
        if summary['geometryType'] == 'InstanceSet': require(summary['counts']['Instance'] == decoded['counts'].get('Instance', 0), 'GLB instance count differs.', 'ASSET_INVALID')
        elif summary['geometryType'] == 'PointSet': require(summary['counts']['Point'] == decoded['counts'].get('Point', 0), 'GLB point count differs.', 'ASSET_INVALID')
        else:
            require(summary['counts']['Face'] == decoded['counts'].get('Face', 0) and summary['counts']['Corner'] == 3 * summary['counts']['Face'] and summary['counts']['Point'] <= decoded['counts'].get('Point', 0), 'GLB mesh counts differ.', 'ASSET_INVALID')
        for key in ('min', 'max'):
            vector = summary['bounds'].get(key)
            require(isinstance(vector, list) and len(vector) == 3 and all(type(v) in (int, float) and math.isfinite(v) for v in vector), 'Invalid geometry bounds.', 'ASSET_INVALID')
            require(all(abs(a-b) <= 1e-4 * max(1, abs(a), abs(b)) for a, b in zip(vector, decoded['bounds'][key])), 'GLB bounds differ from source summary.', 'ASSET_INVALID')
        identity = {'sha256': sha, 'sourceIdentity': source, 'producerNodeId': producer_node}
        asset_id = 'demoasset_' + content_hash(identity)
        if asset_id in self.catalog: return self.catalog[asset_id]
        require(len(self.catalog) < MAX_CATALOG, 'Demo catalog capacity reached.', 'CATALOG_CAPACITY', 409)
        require(sum(self.unique_bytes.values()) + (0 if sha in self.unique_bytes else len(body)) <= MAX_CACHE_BYTES, 'Demo cache byte capacity reached.', 'CATALOG_CAPACITY', 409)
        target = self.cache_root / (sha + '.glb')
        if os.path.lexists(target): require(_safe_read(target, MAX_ASSET_BYTES) == body, 'Cached asset hash differs.', 'ASSET_HASH_MISMATCH')
        else:
            temporary = self.cache_root / ('.' + uuid.uuid4().hex + '.tmp')
            try:
                with temporary.open('xb') as stream: stream.write(body); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                if temporary.exists(): temporary.unlink()
        metadata = {'assetId': asset_id, 'sha256': sha, 'bytes': len(body), 'format': 'glb', 'mime': 'model/gltf-binary',
                    'geometryType': summary['geometryType'], 'counts': copy.deepcopy(summary['counts']), 'bounds': copy.deepcopy(summary['bounds']),
                    'boundsKind': summary.get('boundsKind', decoded['boundsKind']), 'producerNodeId': producer_node,
                    'runId': run_id, 'jobId': job_id, 'inputHash': input_hash, 'sourceIdentity': copy.deepcopy(source), 'label': label,
                    'url': '/api/assets/' + asset_id + '.glb'}
        self.catalog[asset_id] = metadata; self.records[asset_id] = target; self.unique_bytes[sha] = len(body)
        self._event('asset-published', assetId=asset_id, producerNodeId=producer_node, runId=run_id, jobId=job_id)
        return metadata

    def _import_samples(self, samples_root):
        require(not str(samples_root).startswith(('\\\\', '//')), 'Network sample roots are forbidden.', 'ASSET_PATH_FORBIDDEN')
        samples_root = samples_root.absolute(); safe_components(samples_root)
        evidence = parse_json(_safe_read(samples_root / 'EVIDENCE.json', 8 * 1024 * 1024))
        require(isinstance(evidence, dict) and isinstance(evidence.get('runs'), list) and len(evidence['runs']) <= 128, 'Invalid approved evidence.', 'EVIDENCE_INVALID')
        for run in evidence['runs']:
            require(isinstance(run, dict) and isinstance(run.get('assetsLocal'), list) and len(run['assetsLocal']) <= 1024, 'Invalid evidence asset list.', 'EVIDENCE_INVALID')
            handle = run.get('handle'); validate_identity(handle, handle=True)
            result = run.get('result'); require(isinstance(result, dict) and isinstance(result.get('assets'), list), 'Missing evidence result.', 'EVIDENCE_INVALID')
            label = run.get('name'); require(isinstance(label, str) and 0 < len(label) <= 200, 'Invalid evidence label.', 'EVIDENCE_INVALID')
            for entry in run['assetsLocal']:
                require(isinstance(entry, dict), 'Invalid evidence asset.', 'EVIDENCE_INVALID')
                if entry.get('format') != 'glb': continue
                digest(entry.get('sha256')); integer(entry.get('bytes'), 1, MAX_ASSET_BYTES)
                path_text = entry.get('path'); require(isinstance(path_text, str) and '\x00' not in path_text, 'Invalid evidence path.', 'ASSET_PATH_FORBIDDEN')
                candidate = Path(path_text)
                require('..' not in candidate.parts, 'Traversal in evidence path.', 'ASSET_PATH_FORBIDDEN')
                if not candidate.is_absolute(): candidate = samples_root / candidate
                try: candidate.relative_to(samples_root)
                except ValueError as exc: raise PCGError('ASSET_PATH_FORBIDDEN', 'Evidence asset escaped the approved root.') from exc
                require(candidate.suffix.lower() == '.glb', 'Evidence file is not a GLB.', 'ASSET_PATH_FORBIDDEN')
                matches = [a for a in result['assets'] if isinstance(a, dict) and a.get('format') == 'glb' and a.get('sha256') == entry['sha256']]
                require(len(matches) == 1, 'Evidence GLB has no unique M2 artifact identity.', 'EVIDENCE_INVALID')
                artifact = matches[0]; token(artifact.get('artifactId'))
                require(artifact.get('bytes', entry['bytes']) == entry['bytes'], 'Evidence artifact byte count differs.', 'EVIDENCE_INVALID')
                require(all(artifact.get(k) == handle[k] for k in ('jobId', 'runId', 'inputHash', 'projectId', 'revision')), 'Evidence artifact task identity differs.', 'EVIDENCE_INVALID')
                body = _safe_read(candidate, MAX_ASSET_BYTES)
                require(len(body) == entry['bytes'] and hashlib.sha256(body).hexdigest() == entry['sha256'], 'Evidence asset hash differs.', 'ASSET_HASH_MISMATCH')
                metadata = self._register(body, artifact.get('summary'), {'kind': 'm2-evidence', 'handle': handle, 'artifactId': artifact.get('artifactId'), 'evidenceRun': label},
                                          artifact.get('producerNodeId'), handle['runId'], handle['jobId'], handle['inputHash'], label)
                if self.desired is None: self._choose(metadata)

    def read_asset(self, asset_id):
        token(asset_id)
        with self.lock:
            require(asset_id in self.catalog, 'Managed demo asset not found.', 'ASSET_NOT_FOUND', 404)
            metadata = copy.deepcopy(self.catalog[asset_id]); target = self.records[asset_id]
            body = _safe_read(target, MAX_ASSET_BYTES)
            require(len(body) == metadata['bytes'] and hashlib.sha256(body).hexdigest() == metadata['sha256'], 'Demo asset hash differs.', 'ASSET_HASH_MISMATCH')
            return body, metadata

    def start(self, recipe='rock', seed=0, roughness=.2, count=100, minDistance=0):
        require(type(recipe) is str and recipe in {'rock', 'scatter'}, 'Unknown demo recipe.', 'INVALID_RECIPE')
        integer(seed, 0, 2**31 - 1); integer(count, 0, 10000)
        require(type(roughness) in (int, float) and math.isfinite(roughness) and 0 <= roughness <= .9, 'Roughness must be 0 through .9.')
        require(type(minDistance) in (int, float) and math.isfinite(minDistance) and 0 <= minDistance <= 1e6, 'Invalid minimum distance.')
        with self.lock:
            require(not self.closed, 'Demo session is closed.', 'SESSION_CLOSED', 409)
            require(self.run is None or self.run['status'] in TERMINAL, 'Cancel and wait for the current demo run.', 'SESSION_BUSY', 409)
            canvas = _graph(recipe, seed, roughness, count, minDistance)
            document = self.store.get(self.document['id']); document['canvas'] = canvas
            self.document = self.store.save(document['id'], document, document['revision'])
            self.graph = {'nodes': copy.deepcopy(canvas['nodes']), 'edges': copy.deepcopy(canvas['edges'])}
            run_id = 'demorun_' + uuid.uuid4().hex; self._cancel = threading.Event(); self.auto_follow = True; self.selection_epoch += 1
            self.run = {'runId': run_id, 'recipe': recipe, 'parameters': {'seed': seed, 'roughness': roughness, 'count': count, 'minDistance': minDistance},
                        'status': 'running', 'stageIndex': 0, 'stageCount': len(canvas['nodes']), 'currentNodeId': None, 'currentTask': None,
                        'completedStages': [], 'error': None, 'projectId': document['id'], 'projectRevision': self.document['revision'], 'graphHash': content_hash(self.graph)}
            self._event('run-started', runId=run_id, recipe=recipe)
            self._thread = threading.Thread(target=self._execute, args=(run_id, canvas['nodes']), daemon=True, name='pcg-demo-session')
            self._thread.start(); return self.snapshot()

    def cancel(self, run_id):
        token(run_id)
        with self.lock:
            require(self.run is not None and self.run['runId'] == run_id, 'Run identity is stale.', 'STALE_RUN', 409)
            if self.run['status'] in TERMINAL: return self.snapshot()
            self._cancel.set(); self.run['status'] = 'cancelling'; handle = copy.deepcopy(self.run['currentTask'])
            self._event('cancellation-requested', runId=run_id)
        if handle:
            try: self.runtime.cancel(handle)
            except (PCGError, StoreError): pass  # Thread retains the authoritative task failure.
        return self.snapshot()

    def _execute(self, run_id, nodes):
        try:
            for index, node in enumerate(nodes):
                with self.lock:
                    require(self.run['runId'] == run_id and not self._cancel.is_set() and not self.closed, 'Demo run cancelled.', 'WORKER_CANCELLED', 409)
                    self.run.update(stageIndex=index + 1, currentNodeId=node['id'], currentTask=None)
                    self._event('stage-started', runId=run_id, nodeId=node['id'], stageIndex=index + 1)
                    identity = {'projectId': self.document['id'], 'nodeId': node['id'], 'revision': self.document['revision'], 'descriptorVersion': 1, 'operationVersion': 1, 'runId': run_id + '-' + str(index)}
                task = self.runtime.run(identity); handle = {k: task[k] for k in HANDLE}
                with self.lock:
                    self.run['currentTask'] = handle; self._event('task-admitted', runId=run_id, nodeId=node['id'], jobId=task['jobId'])
                while task['status'] not in TERMINAL:
                    if self._cancel.is_set() or self.closed:
                        try: self.runtime.cancel(handle)
                        except (PCGError, StoreError): pass
                    task = self.runtime.wait({**handle, 'timeoutMs': 100})['task']
                error = task.get('error') or {}
                require(task['status'] == 'succeeded', error.get('message', 'M2 stage failed.'), error.get('code', 'STAGE_FAILED'), 409)
                self.runtime.verify(handle)
                models = [a for a in task['result']['assets'] if a['format'] == 'glb']
                exported = [(a, self.runtime.download(handle, a['artifactId'])[0]) for a in models]
                with self.lock:
                    require(self.run['runId'] == run_id and not self._cancel.is_set() and not self.closed, 'Demo run cancelled.', 'WORKER_CANCELLED', 409)
                    stage_assets = []
                    for artifact, body in exported:
                        metadata = self._register(body, artifact['summary'], {'kind': 'm2-demo-stage', 'sessionRunId': run_id, 'handle': handle, 'artifactId': artifact['artifactId']},
                                                  node['id'], run_id, task['jobId'], task['inputHash'], node['id'])
                        stage_assets.append(metadata['assetId']); self._last_geometry = metadata['assetId']
                        if self.auto_follow: self._choose(metadata)
                    self.run['completedStages'].append({'nodeId': node['id'], 'stageIndex': index + 1, 'handle': handle, 'outputs': copy.deepcopy(task['result']['outputs']),
                                                       'assetIds': stage_assets, 'associatedAssetId': self._last_geometry,
                                                       'computedNodes': task['result']['report']['computedNodes'], 'cacheHits': task['result']['report']['cacheHits']})
                    self._event('stage-completed', runId=run_id, nodeId=node['id'], assetIds=stage_assets, stageIndex=index + 1)
            with self.lock:
                require(not self._cancel.is_set() and not self.closed, 'Demo run cancelled.', 'WORKER_CANCELLED', 409)
                self.run['status'] = 'succeeded'; self._event('run-succeeded', runId=run_id)
        except (PCGError, StoreError) as exc:
            with self.lock:
                if self.run and self.run['runId'] == run_id:
                    cancelled = self._cancel.is_set() or self.closed or exc.code == 'WORKER_CANCELLED'
                    self.run.update(status='cancelled' if cancelled else 'failed', error={'code': 'WORKER_CANCELLED' if cancelled else exc.code, 'message': exc.message})
                    self._event('run-cancelled' if cancelled else 'run-failed', runId=run_id, nodeId=self.run['currentNodeId'], code=self.run['error']['code'])
        except (OSError, ValueError, TypeError, KeyError, AttributeError, RecursionError):
            with self.lock:
                if self.run and self.run['runId'] == run_id:
                    self.run.update(status='failed', error={'code': 'SESSION_FAILED', 'message': 'Demo stage could not complete safely.'})
                    self._event('run-failed', runId=run_id, nodeId=self.run['currentNodeId'], code='SESSION_FAILED')

    def close(self):
        with self.lock:
            if self.closed: return
            self.closed = True; self._cancel.set(); self._event('session-closed')
        self.runtime.close()
        thread = self._thread
        if thread: thread.join(timeout=15)
        self.store.close()
