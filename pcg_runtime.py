"""Bounded, identity-bound M1 tasks; only the fixed diagnostic worker can run."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import uuid

from pcg_contracts import (AssetBroker, PCGError, canonical, content_hash, digest,
                           exact, find_descriptor, geometry_context, integer,
                           load_registry, parse_json, require, safe_components, token,
                           validate_parameters, validate_value)


IDENTITY = {'projectId', 'nodeId', 'revision', 'descriptorVersion', 'operationVersion', 'runId'}
HANDLE = IDENTITY | {'jobId', 'inputHash'}
WORKER_PATH = Path(__file__).resolve().with_name('pcg_worker.py')


def validate_identity(payload, handle=False, optional=()):
    exact(payload, HANDLE if handle else IDENTITY, optional)
    for name in ('projectId', 'nodeId', 'runId'): token(payload[name], 128 if name != 'runId' else 64)
    integer(payload['revision'], 1, 2**53 - 1)
    for name in ('descriptorVersion', 'operationVersion'):
        require(type(payload[name]) is int and payload[name] == 1, 'Unsupported descriptor/operation version.', 'VERSION_UNSUPPORTED')
    if handle:
        token(payload['jobId'], 40); digest(payload['inputHash'])


class PCGRuntime:
    def __init__(self, store):
        self.store = store
        self.registry = load_registry()
        self.broker = AssetBroker(store)
        self.lock = threading.RLock()
        self.tasks = {}
        self.runs = {}
        self.closed = False
        self.slots = threading.BoundedSemaphore(4)

    def _project(self, project_id, revision=None):
        path = self.store._project_path(project_id)
        safe_components(path)
        self.store._require_writable(path)
        self.store.acquire_lock(path)
        document = self.store._read(path, migrate=False)
        require(document.get('id') == project_id, 'Project identity differs.', 'CROSS_PROJECT')
        if revision is not None:
            require(document['revision'] == revision, 'Saved project revision changed.', 'REVISION_CONFLICT', 409)
        return document

    def _node(self, document, node_id):
        matches = [n for n in document['canvas']['nodes'] if n.get('id') == node_id]
        require(len(matches) == 1 and matches[0].get('type') == 'pcg', 'PCG node not found.', 'NODE_NOT_FOUND', 404)
        node = matches[0]
        data = node.get('data', {})
        # Display and graph metadata may coexist; execution fields are closed.
        require(isinstance(data, dict), 'Invalid PCG node data.')
        descriptor = find_descriptor(self.registry, data.get('descriptorId'), data.get('descriptorVersion'), data.get('operationVersion'))
        parameters = validate_parameters(descriptor, data.get('parameters', {}))
        return node, descriptor, parameters

    def _prepare(self, identity, permit_unavailable=False):
        validate_identity(identity)
        document = self._project(identity['projectId'], identity['revision'])
        node, descriptor, parameters = self._node(document, identity['nodeId'])
        require(descriptor['descriptorVersion'] == identity['descriptorVersion'] and descriptor['operationVersion'] == identity['operationVersion'], 'Node version changed.', 'VERSION_UNSUPPORTED')
        if not permit_unavailable:
            require(descriptor['readiness']['state'] == 'ready', 'Geometry executor is unavailable.', 'EXECUTOR_UNAVAILABLE', 409)
        ports = {p['name']: p for p in descriptor['inputs']}
        inputs, connections = {}, []
        edges = document['canvas']['edges']
        require(len(edges) <= 4096 and len(document['canvas']['nodes']) <= 4096, 'Graph exceeds M1 budget.', 'BUDGET_EXCEEDED')
        # Check all PCG incident edges, including outgoing port declarations.
        for edge in edges:
            if edge.get('source') == node['id']:
                require(edge.get('sourceHandle') in {p['name'] for p in descriptor['outputs']}, 'Unknown source port.', 'PORT_UNKNOWN')
            if edge.get('target') != node['id']: continue
            name = edge.get('targetHandle')
            require(isinstance(name, str) and name in ports and name not in inputs, 'Unknown or duplicate input port.', 'PORT_UNKNOWN')
            source, source_descriptor, _ = self._node(document, edge.get('source'))
            output = next((p for p in source_descriptor['outputs'] if p['name'] == edge.get('sourceHandle')), None)
            require(output is not None, 'Unknown output port.', 'PORT_UNKNOWN')
            require(output['type'] == ports[name]['type'], 'Connected port types differ.', 'PORT_TYPE_MISMATCH')
            edge_data = edge.get('data') or {}
            require(isinstance(edge_data, dict) and edge_data.get('pcgType', output['type']) == output['type'], 'Edge type differs.', 'PORT_TYPE_MISMATCH')
            require(source_descriptor['readiness']['state'] == 'ready', 'Connected geometry executor is unavailable.', 'EXECUTOR_UNAVAILABLE', 409)
            with self.lock:
                candidates = [t for t in self.tasks.values() if t['projectId'] == identity['projectId'] and t['nodeId'] == source['id'] and t['revision'] == identity['revision'] and t['status'] == 'succeeded']
                task = candidates[-1] if candidates else None
            require(task is not None and output['name'] in task['result'], 'Connected input has no successful current output.', 'INPUT_UNAVAILABLE', 409)
            inputs[name] = copy.deepcopy(task['result'][output['name']])
            connections.append({'source': source['id'], 'sourceHandle': output['name'], 'targetHandle': name, 'jobId': task['jobId'], 'resultHash': task['resultHash']})
        for name, port in ports.items():
            require(not port['required'] or name in inputs, 'Required input is missing.', 'INPUT_UNAVAILABLE', 409)
        context = geometry_context(inputs['geometry']) if 'geometry' in inputs else None
        for name, value in inputs.items():
            validate_value(value, ports[name]['type'], identity['projectId'], context)
            if ports[name]['type'] in {'GeometryArtifact', 'InstanceSet'}:
                self.broker.read(identity['projectId'], value)
        input_hash = content_hash({'identity': {k: v for k, v in identity.items() if k != 'runId'}, 'descriptorId': descriptor['id'], 'parameters': parameters, 'inputs': inputs, 'connections': connections})
        request = {'protocolVersion': 1, 'descriptorId': descriptor['id'], 'descriptorVersion': identity['descriptorVersion'], 'operationVersion': identity['operationVersion'], 'projectId': identity['projectId'], 'parameters': parameters, 'inputs': inputs, 'inputHash': input_hash}
        require(len(canonical(request)) <= descriptor['budget']['maxInputBytes'], 'Worker input exceeds budget.', 'BUDGET_EXCEEDED')
        return descriptor, request, input_hash

    def preflight(self, identity):
        validate_identity(identity)
        with self.store._guard(self.store._project_path(identity['projectId'])):
            descriptor, _, input_hash = self._prepare(identity)
            return {'ok': True, 'identity': dict(identity), 'descriptorId': descriptor['id'], 'inputHash': input_hash, 'readiness': descriptor['readiness']}

    def run(self, identity):
        validate_identity(identity)
        with self.store._guard(self.store._project_path(identity['projectId'])):
            return self._run_locked(identity)

    def _run_locked(self, identity):
        descriptor, request, input_hash = self._prepare(identity, permit_unavailable=True)
        key = (identity['projectId'], identity['runId'])
        with self.lock:
            require(not self.closed, 'PCG host is closed.', 'RUNTIME_CLOSED', 503)
            existing = self.runs.get(key)
            if existing:
                task = self.tasks[existing]
                require(all(task[k] == identity[k] for k in IDENTITY) and task['inputHash'] == input_hash, 'runId is already bound to different inputs.', 'IDEMPOTENCY_CONFLICT', 409)
                return self._public(task)
            require(len(self.tasks) < 256, 'Retained task capacity reached; restart host after reviewing tasks.', 'TASK_CAPACITY', 503)
            require(self.slots.acquire(blocking=False), 'Four PCG tasks are already active.', 'TASK_CAPACITY', 503)
            task = {**identity, 'jobId': 'pcg_' + uuid.uuid4().hex, 'inputHash': input_hash, 'descriptorId': descriptor['id'], 'status': 'queued', 'progress': 0, 'result': None, 'resultHash': None, 'error': None, '_event': threading.Event(), '_process': None, '_thread': None}
            self.tasks[task['jobId']] = task; self.runs[key] = task['jobId']
            if descriptor['readiness']['state'] != 'ready':
                task.update(status='failed', error={'code': 'EXECUTOR_UNAVAILABLE', 'message': 'Geometry executor is unavailable.'})
                task['_event'].set(); self.slots.release()
            else:
                thread = threading.Thread(target=self._execute, args=(task, request, descriptor), daemon=True, name='pcg-diagnostic')
                task['_thread'] = thread
                thread.start()
            return self._public(task)

    @staticmethod
    def _public(task, stale=False):
        return {**copy.deepcopy({k: v for k, v in task.items() if not k.startswith('_')}), 'stale': stale}

    def _execute(self, task, request, descriptor):
        try:
            with tempfile.TemporaryDirectory(prefix='refmuse-pcg-') as working:
                environment = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR') if k in os.environ}
                environment.update({'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'})
                with self.lock:
                    require(not self.closed, 'Host closed before worker started.', 'WORKER_CANCELLED', 409)
                    process = subprocess.Popen([sys.executable, '-I', str(WORKER_PATH)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=working, env=environment, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                    task['_process'] = process; task['status'] = 'running'
                try:
                    stdout, stderr = process.communicate(canonical(request), timeout=descriptor['budget']['timeoutMs'] / 1000)
                except subprocess.TimeoutExpired:
                    process.kill(); process.communicate()
                    raise PCGError('WORKER_TIMEOUT', 'Diagnostic worker exceeded its time budget.', 504)
                require(process.returncode == 0, 'Diagnostic worker exited unexpectedly.', 'WORKER_CRASH', 502)
                require(0 < len(stdout) <= descriptor['budget']['maxOutputBytes'] and not stderr, 'Invalid diagnostic worker response.', 'WORKER_PROTOCOL', 502)
                try: response = parse_json(stdout)
                except PCGError as exc: raise PCGError('WORKER_PROTOCOL', 'Malformed worker response.', 502) from exc
                require(isinstance(response, dict), 'Malformed worker response.', 'WORKER_PROTOCOL', 502)
                exact(response, {'ok', 'result'} if response.get('ok') is True else {'ok', 'error'})
                require(response.get('ok') is True, 'Diagnostic worker rejected its contract.', 'WORKER_PROTOCOL', 502)
                result = response['result']
                exact(result, {'report'})
                report = result['report']
                exact(report, {'contractVersion', 'type', 'operation', 'label', 'inputCount', 'inputTypes', 'workerPid', 'inputHash'})
                require(report == {'contractVersion': 1, 'type': 'DiagnosticReport', 'operation': descriptor['id'], 'label': request['parameters']['label'], 'inputCount': len(request['inputs']), 'inputTypes': {name: next(p['type'] for p in descriptor['inputs'] if p['name'] == name) for name in request['inputs']}, 'workerPid': process.pid, 'inputHash': task['inputHash']}, 'Worker report identity differs.', 'WORKER_PROTOCOL', 502)
                with self.lock:
                    require(not self.closed, 'Host closed during worker run.', 'WORKER_CANCELLED', 409)
                    task.update(status='succeeded', progress=1, result=result, resultHash=content_hash(result))
        except PCGError as exc:
            code = 'WORKER_PROTOCOL' if exc.code == 'INVALID_CONTRACT' else exc.code
            with self.lock: task.update(status='failed', error={'code': code, 'message': exc.message})
        except (OSError, ValueError, TypeError, KeyError) as exc:
            with self.lock: task.update(status='failed', error={'code': 'WORKER_CRASH', 'message': 'Diagnostic worker could not complete.'})
        finally:
            task['_event'].set(); self.slots.release()

    def _owned(self, handle):
        validate_identity(handle, handle=True)
        document = self._project(handle['projectId'])
        with self.lock:
            task = self.tasks.get(handle['jobId'])
            require(task is not None, 'Task not found in this host.', 'TASK_NOT_FOUND', 404)
            require(all(task[k] == handle[k] for k in HANDLE), 'Task handle identity differs.', 'TASK_IDENTITY_MISMATCH', 409)
            return task, document['revision'] != task['revision']

    def read(self, handle):
        task, stale = self._owned(handle)
        with self.lock: return {'task': self._public(task, stale)}

    def wait(self, payload):
        validate_identity(payload, handle=True, optional={'timeoutMs'})
        timeout = payload.get('timeoutMs', 1000); integer(timeout, 0, 20000)
        handle = {k: payload[k] for k in HANDLE}
        task, _ = self._owned(handle)
        task['_event'].wait(timeout / 1000)
        return self.read(handle)

    def verify(self, handle):
        validate_identity(handle, handle=True)
        with self.store._guard(self.store._project_path(handle['projectId'])):
            return self._verify_locked(handle)

    def _verify_locked(self, handle):
        task, stale = self._owned(handle)
        require(not stale, 'Result belongs to an old saved revision.', 'REVISION_CONFLICT', 409)
        with self.lock:
            require(task['status'] == 'succeeded', 'Task has no successful report.', 'RESULT_UNAVAILABLE', 409)
            require(task['resultHash'] == content_hash(task['result']) and task['result']['report']['inputHash'] == task['inputHash'], 'Result identity changed.', 'RESULT_HASH_MISMATCH', 409)
            return {'ok': True, 'verified': True, 'jobId': task['jobId'], 'inputHash': task['inputHash'], 'resultHash': task['resultHash']}

    def list_tasks(self, project_id, node_id):
        token(project_id); token(node_id)
        document = self._project(project_id)
        self._node(document, node_id)
        with self.lock:
            return {'tasks': [self._public(t, document['revision'] != t['revision']) for t in reversed(list(self.tasks.values())) if t['projectId'] == project_id and t['nodeId'] == node_id]}

    def active_count(self):
        with self.lock:
            return sum(t['status'] in {'queued', 'running'} for t in self.tasks.values())

    def close(self):
        with self.lock:
            self.closed = True
            tasks = list(self.tasks.values())
            for task in tasks:
                process = task['_process']
                if process and process.poll() is None: process.kill()
        for task in tasks:
            thread = task['_thread']
            if thread: thread.join(timeout=6)
