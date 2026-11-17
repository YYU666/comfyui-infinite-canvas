"""Immutable, job-bound geometry exports. Only the host writes managed outputs."""
from __future__ import annotations
import hashlib
import copy
import os
from pathlib import Path
import stat
import urllib.parse
from pcg_contracts import PCGError, canonical, require, safe_components, token

MAX_ASSET_BYTES = 64 * 1024 * 1024


class GeometryAssetBroker:
    def __init__(self, store):
        self.store = store
        self.records = {}

    @staticmethod
    def _handle(task):
        from pcg_runtime import HANDLE
        return {k: task[k] for k in HANDLE}

    def publish(self, task, port, value, format, producer_node_id=None, prepared_body=None):
        from pcg_geometry import validate_geometry, summarize
        from pcg_export import export_glb
        validate_geometry(value)
        producer_node_id = producer_node_id or task['nodeId']; token(producer_node_id)
        token(port, 32)
        require(format in {'glb', 'json', 'svg'}, 'Unsupported export format.', 'FORMAT_UNSUPPORTED')
        if format == 'svg':
            from pcg_preview import render_preview_svg
            body = render_preview_svg(value) if prepared_body is None else prepared_body
        else: body = export_glb(value) if format == 'glb' else canonical(value)
        require(isinstance(body, bytes) and 0 < len(body) <= MAX_ASSET_BYTES, 'Export exceeds byte budget.', 'BUDGET_EXCEEDED')
        if format == 'glb':
            import struct
            require(len(body) >= 20 and body[:4] == b'glTF' and struct.unpack_from('<II', body, 4) == (2, len(body)), 'Exporter returned an invalid GLB.', 'WORKER_PROTOCOL')
        sha = hashlib.sha256(body).hexdigest()
        # Unique ID binds run+port+format even when immutable bytes are shared.
        artifact_id = 'pcga_' + hashlib.sha256(canonical({'handle': self._handle(task), 'producerNodeId': producer_node_id, 'port': port, 'format': format, 'sha256': sha})).hexdigest()
        existing = self.records.get(artifact_id)
        if existing:
            self.read(task, artifact_id); return copy.deepcopy(existing['public'])
        project = self.store._project_path(task['projectId']); safe_components(project)
        directory = project.parent / 'outputs' / 'pcg'
        outputs = project.parent / 'outputs'; safe_components(outputs)
        directory.mkdir(exist_ok=True); safe_components(directory)
        directory = directory / task['jobId']; directory.mkdir(exist_ok=True); safe_components(directory)
        target = directory / (sha + '.' + format)
        if os.path.lexists(target):
            safe_components(target)
            require(target.is_file() and target.stat().st_nlink == 1 and target.read_bytes() == body, 'Managed output differs.', 'ASSET_HASH_MISMATCH')
        else:
            temporary = directory / ('.' + artifact_id + '.tmp')
            try:
                with temporary.open('xb') as stream:
                    stream.write(body); stream.flush(); os.fsync(stream.fileno())
                os.replace(temporary, target)
            finally:
                if temporary.exists(): temporary.unlink()
        query = urllib.parse.urlencode(self._handle(task))
        public = {'artifactId': artifact_id, 'sha256': sha, 'bytes': len(body), 'format': format,
                  'mime': {'glb': 'model/gltf-binary', 'json': 'application/json', 'svg': 'image/svg+xml'}[format],
                  'role': {'glb': 'model', 'json': 'data', 'svg': 'preview'}[format],
                  'producerNodeId': producer_node_id, 'port': port, 'jobId': task['jobId'], 'runId': task['runId'], 'inputHash': task['inputHash'],
                  'projectId': task['projectId'], 'revision': task['revision'], 'summary': summarize(value),
                  'url': '/api/pcg/artifacts/' + artifact_id + '?' + query}
        self.records[artifact_id] = {'public': public, 'handle': self._handle(task), 'path': target}
        return copy.deepcopy(public)

    def read(self, task, artifact_id):
        token(artifact_id)
        record = self.records.get(artifact_id)
        require(record is not None and record['handle'] == self._handle(task), 'Artifact is not owned by this task.', 'ASSET_UNMANAGED', 404)
        target = record['path']; safe_components(target); info = target.stat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == record['public']['bytes'] and info.st_size <= MAX_ASSET_BYTES, 'Unsafe managed output.', 'ASSET_PATH_FORBIDDEN')
        with target.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            require((opened.st_dev, opened.st_ino) == (info.st_dev, info.st_ino) and opened.st_nlink == 1, 'Output changed during open.', 'ASSET_CHANGED')
            body = stream.read(MAX_ASSET_BYTES + 1)
        safe_components(target)
        require(hashlib.sha256(body).hexdigest() == record['public']['sha256'], 'Export hash differs.', 'ASSET_HASH_MISMATCH')
        return body, copy.deepcopy(record['public'])
