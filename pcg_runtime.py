"""Identity-bound diagnostic and isolated saved-graph tasks with immutable exports."""
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
import time

from project_store import StoreError

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
        self.geometry_slot = threading.BoundedSemaphore(1)
        from pcg_graph import GraphCache
        from pcg_assets import GeometryAssetBroker
        self.cache = GraphCache()
        self.assets = GeometryAssetBroker(store)
        self.latest = {}

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
        if descriptor['id'] not in {'refmuse.pcg.diagnostic', 'refmuse.pcg.geometry_stub'}:
            return self._prepare_graph(identity, document, descriptor, permit_unavailable)
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

    @staticmethod
    def _isolation():
        try:
            from pcg_isolation import preflight
            return preflight()
        except (ImportError, OSError):
            return {'available': False, 'code': 'ISOLATION_UNAVAILABLE', 'message': 'Required OS boundary is unavailable.'}

    def _prepare_graph(self, identity, document, descriptor, permit_unavailable):
        from pcg_graph import plan_graph
        plan, descriptors = plan_graph(document, identity['nodeId'], self.registry, permit_unavailable)
        if not permit_unavailable:
            require(self._isolation()['available'], 'Required OS isolation is unavailable.', 'ISOLATION_UNAVAILABLE', 409)
        input_hash = content_hash({'identity': {k: v for k, v in identity.items() if k != 'runId'}, 'plan': plan})
        with self.lock: cache = self.cache.snapshot(identity['projectId'])
        request = {'protocolVersion': 2, 'projectId': identity['projectId'], 'inputHash': input_hash, 'plan': plan, 'cache': cache}
        # Cache reuse is optional; drop the oldest snapshot entries to bound IPC.
        while cache and len(canonical(request)) > 32 * 1024 * 1024: cache.pop(next(iter(cache)))
        require(len(canonical(request)) <= 32 * 1024 * 1024, 'Graph worker input exceeds budget.', 'BUDGET_EXCEEDED')
        return descriptor, request, input_hash

    def preflight(self, identity):
        validate_identity(identity)
        with self.store._guard(self.store._project_path(identity['projectId'])):
            descriptor, _, input_hash = self._prepare(identity)
            result = {'ok': True, 'identity': dict(identity), 'descriptorId': descriptor['id'], 'inputHash': input_hash, 'readiness': descriptor['readiness']}
            if _['protocolVersion'] == 2:
                from pcg_graph import dirty_nodes
                result.update(dirty_nodes(_['plan'], _['cache']))
                result['executionOrder'] = [n['nodeId'] for n in _['plan']['nodes']]
                result['isolation'] = self._isolation()
            return result

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
                return self._public(task, self.latest.get((task['projectId'], task['nodeId'])) != task['jobId'])
            require(len(self.tasks) < 256, 'Retained task capacity reached; restart host after reviewing tasks.', 'TASK_CAPACITY', 503)
            require(self.slots.acquire(blocking=False), 'Four PCG tasks are already active.', 'TASK_CAPACITY', 503)
            task = {**identity, 'jobId': 'pcg_' + uuid.uuid4().hex, 'inputHash': input_hash, 'descriptorId': descriptor['id'], 'status': 'queued', 'progress': 0, 'result': None, 'resultHash': None, 'error': None, '_event': threading.Event(), '_process': None, '_thread': None, '_cancel': threading.Event(), '_outputs': None, '_created': time.monotonic()}
            self.tasks[task['jobId']] = task; self.runs[key] = task['jobId']
            self.latest[(task['projectId'], task['nodeId'])] = task['jobId']
            if descriptor['readiness']['state'] != 'ready' or (request['protocolVersion'] == 2 and not self._isolation()['available']):
                task.update(status='failed', error={'code': descriptor['readiness']['code'] if descriptor['readiness']['state'] != 'ready' else 'ISOLATION_UNAVAILABLE', 'message': 'Geometry executor or required OS isolation is unavailable.'})
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
        if request['protocolVersion'] == 2:
            return self._execute_graph(task, request, descriptor)
        try:
            with tempfile.TemporaryDirectory(prefix='refmuse-pcg-') as working:
                environment = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR') if k in os.environ}
                environment.update({'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'})
                with self.lock:
                    require(not self.closed and not task['_cancel'].is_set(), 'Host closed or task cancelled before worker started.', 'WORKER_CANCELLED', 409)
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
                    require(not self.closed and not task['_cancel'].is_set(), 'Host closed or task cancelled during worker run.', 'WORKER_CANCELLED', 409)
                    task.update(status='succeeded', progress=1, result=result, resultHash=content_hash(result))
        except PCGError as exc:
            code = 'WORKER_PROTOCOL' if exc.code == 'INVALID_CONTRACT' else exc.code
            with self.lock: task.update(status='cancelled' if task['_cancel'].is_set() else 'failed', error={'code': 'WORKER_CANCELLED' if task['_cancel'].is_set() else code, 'message': exc.message})
        except (OSError, ValueError, TypeError, KeyError) as exc:
            with self.lock: task.update(status='failed', error={'code': 'WORKER_CRASH', 'message': 'Diagnostic worker could not complete.'})
        finally:
            task['_event'].set(); self.slots.release()

    def _execute_graph(self, task, request, descriptor):
        started = time.perf_counter()
        geometry_owned = False
        try:
            from pcg_isolation import execute, IsolationError
            from pcg_graph import computation_key
            from pcg_geometry import summarize
            from pcg_contracts import validate_engine_value
            while not self.geometry_slot.acquire(timeout=0.05):
                require(not self.closed and not task['_cancel'].is_set(), 'Queued task cancelled.', 'WORKER_CANCELLED', 409)
            geometry_owned = True
            queue_wait_ms = (time.perf_counter() - started) * 1000
            with self.lock:
                require(not self.closed and not task['_cancel'].is_set(), 'Task cancelled.', 'WORKER_CANCELLED', 409)
                task['status'] = 'running'
            try:
                stdout = execute(canonical(request), cancelled=lambda: self.closed or task['_cancel'].is_set(),
                                 timeout=descriptor['budget']['timeoutMs'] / 1000,
                                 memory_bytes=512 * 1024 * 1024, max_output_bytes=64 * 1024 * 1024)
            except IsolationError as exc:
                mapping = {'CANCELLED': 'WORKER_CANCELLED', 'TIMEOUT': 'WORKER_TIMEOUT', 'WORKER_FAILED': 'WORKER_CRASH'}
                raise PCGError(mapping.get(exc.code, exc.code), str(exc), 409) from exc
            require(isinstance(stdout, bytes) and 0 < len(stdout) <= 64 * 1024 * 1024, 'Graph response exceeds budget.', 'WORKER_PROTOCOL')
            response = parse_json(stdout)
            require(isinstance(response, dict), 'Malformed graph response.', 'WORKER_PROTOCOL')
            exact(response, {'ok', 'result'} if response.get('ok') is True else {'ok', 'error'})
            if response.get('ok') is not True:
                exact(response['error'], {'code', 'message'})
                raise PCGError(response['error']['code'], response['error']['message'], 409)
            result = response['result']; exact(result, {'outputs', 'records', 'computedNodes', 'cacheHits', 'inputHash'})
            require(result['inputHash'] == task['inputHash'] and isinstance(result['records'], list) and len(result['records']) == len(request['plan']['nodes']), 'Graph identity differs.', 'WORKER_PROTOCOL')
            values, accepted, computed, hits, timings, geometries = {}, [], [], [], [], {}
            for node, record in zip(request['plan']['nodes'], result['records']):
                exact(record, {'nodeId', 'key', 'outputs', 'outputHash', 'cacheHit', 'elapsedMs'})
                require(record['nodeId'] == node['nodeId'] and type(record['cacheHit']) is bool and type(record['elapsedMs']) in (float, int) and 0 <= record['elapsedMs'] <= 60000, 'Invalid node trace.', 'WORKER_PROTOCOL')
                inputs = {name: values[ref['nodeId']][ref['port']] for name, ref in node['inputs'].items()}
                key = computation_key(node, inputs)
                require(key == record['key'] and content_hash(record['outputs']) == record['outputHash'], 'Node hash differs.', 'WORKER_PROTOCOL')
                d = find_descriptor(self.registry, node['descriptorId']); ports = {p['name']: p for p in d['outputs']}
                exact(record['outputs'], {p['name'] for p in d['outputs'] if p['required']}, ports)
                require(len(canonical(inputs)) <= d['budget']['maxInputBytes'] and len(canonical(record['outputs'])) <= d['budget']['maxOutputBytes'], 'Node byte budget exceeded.', 'BUDGET_EXCEEDED')
                from pcg_fields import binding, validate_field
                for name, value in record['outputs'].items():
                    validate_engine_value(value, ports[name]['type'])
                    if value.get('type') in {'Mesh', 'PointSet', 'InstanceSet'}: geometries[content_hash(binding(value))] = value
                for value in record['outputs'].values():
                    if value.get('type') in {'Field', 'Selection'}:
                        source = geometries.get(content_hash(value['binding']))
                        require(source is not None, 'Field has no evaluated source geometry.', 'FIELD_BINDING_MISMATCH')
                        validate_field(value, source)
                        expected = [binding(v) if v.get('type') in {'Mesh', 'PointSet', 'InstanceSet'} else v.get('binding') for v in inputs.values() if v.get('type') in {'Mesh', 'PointSet', 'InstanceSet', 'Field', 'Selection'}]
                        require(value['binding'] in expected, 'Field binding differs from node inputs.', 'FIELD_BINDING_MISMATCH')
                    if value.get('type') == 'DiagnosticReport':
                        source = geometries.get(content_hash(value.get('binding')))
                        require(source is not None and value == summarize(source), 'Geometry report differs from evaluated geometry.', 'WORKER_PROTOCOL')
                if record['cacheHit']:
                    require(key in request['cache'] and record['outputs'] == request['cache'][key], 'Worker cache claim differs.', 'WORKER_PROTOCOL'); hits.append(node['nodeId'])
                else: computed.append(node['nodeId'])
                values[node['nodeId']] = record['outputs']; accepted.append((key, record['outputs']))
                timings.append({'nodeId': node['nodeId'], 'elapsedMs': record['elapsedMs'], 'cacheHit': record['cacheHit'], 'outputBytes': len(canonical(record['outputs']))})
            require(result['computedNodes'] == computed and result['cacheHits'] == hits and result['outputs'] == values[request['plan']['target']], 'Execution set differs.', 'WORKER_PROTOCOL')
            from pcg_preview import render_preview_svg
            stage_bodies, preview_bytes = {}, 0
            for record in result['records']:
                for port, value in record['outputs'].items():
                    if value.get('type') in {'Mesh', 'PointSet', 'InstanceSet'}:
                        body = render_preview_svg(value); preview_bytes += len(body)
                        require(preview_bytes <= 16 * 1024 * 1024, 'Stage previews exceed the aggregate byte budget.', 'BUDGET_EXCEEDED')
                        stage_bodies[(record['nodeId'], port)] = body
            with self.store._guard(self.store._project_path(task['projectId'])):
                self._project(task['projectId'], task['revision'])
                with self.lock:
                    require(not self.closed and not task['_cancel'].is_set(), 'Task cancelled.', 'WORKER_CANCELLED', 409)
                    require(self.latest.get((task['projectId'], task['nodeId'])) == task['jobId'], 'Newer run superseded this task.', 'STALE_RUN', 409)
                    outputs = result['outputs']; summaries = {}; artifacts = []; stages = []
                    retained = sum(len(canonical(t['_outputs'])) for t in self.tasks.values() if t['_outputs'] is not None)
                    require(retained + len(canonical(outputs)) <= 64 * 1024 * 1024, 'Retained geometry capacity reached.', 'TASK_CAPACITY', 503)
                    for name, value in outputs.items():
                        if value.get('type') in {'Mesh', 'PointSet', 'InstanceSet'}:
                            summaries[name] = summarize(value)
                            artifacts.append(self.assets.publish(task, name, value, 'glb'))
                            artifacts.append(self.assets.publish(task, name, value, 'json'))
                            artifacts.append(self.assets.publish(task, name, value, 'svg'))
                        elif value.get('type') == 'DiagnosticReport': summaries[name] = copy.deepcopy(value)
                        else:
                            summaries[name] = {k: copy.deepcopy(v) for k, v in value.items() if k not in {'values', 'pixels'}}
                            items = value.get('values', value.get('pixels', []))
                            summaries[name].update(count=len(items), sample=copy.deepcopy(items[:64]))
                    for record in result['records']:
                        stage = {'nodeId': record['nodeId'], 'runId': task['runId'], 'jobId': task['jobId'], 'inputHash': task['inputHash'], 'outputHash': record['outputHash'], 'cacheHit': record['cacheHit'], 'elapsedMs': record['elapsedMs'], 'outputs': {}, 'assets': []}
                        for port, value in record['outputs'].items():
                            if value.get('type') in {'Mesh', 'PointSet', 'InstanceSet'}:
                                stage['outputs'][port] = summarize(value)
                                stage['assets'].append(self.assets.publish(task, port, value, 'svg', producer_node_id=record['nodeId'], prepared_body=stage_bodies[(record['nodeId'], port)]))
                            elif value.get('type') == 'DiagnosticReport': stage['outputs'][port] = copy.deepcopy(value)
                            else:
                                stage['outputs'][port] = {k: copy.deepcopy(v) for k, v in value.items() if k not in {'values', 'pixels'}}
                                items = value.get('values', value.get('pixels', []))
                                stage['outputs'][port].update(count=len(items), sample=copy.deepcopy(items[:64]))
                        stages.append(stage)
                    public = {'stagePreviews': stages, 'outputs': summaries, 'assets': artifacts, 'report': {'contractVersion': 1, 'type': 'DiagnosticReport', 'operation': descriptor['id'], 'inputHash': task['inputHash'], 'outputHash': content_hash(outputs), 'computedNodes': computed, 'cacheHits': hits, 'timings': timings, 'queueWaitMs': queue_wait_ms, 'workerElapsedMs': sum(t['elapsedMs'] for t in timings), 'elapsedMs': (time.perf_counter() - started) * 1000}}
                    task.update(status='succeeded', progress=1, result=public, resultHash=content_hash(public), _outputs=outputs)
                    for key, value in accepted: self.cache.put(task['projectId'], key, value)
        except PCGError as exc:
            with self.lock: task.update(status='cancelled' if task['_cancel'].is_set() else 'failed', error={'code': 'WORKER_CANCELLED' if task['_cancel'].is_set() else exc.code, 'message': exc.message})
        except StoreError as exc:
            with self.lock: task.update(status='failed', error={'code': exc.code, 'message': exc.message})
        except (OSError, ValueError, TypeError, KeyError, ImportError, RecursionError):
            with self.lock: task.update(status='failed', error={'code': 'WORKER_PROTOCOL', 'message': 'Geometry worker response could not be validated.'})
        finally:
            if geometry_owned: self.geometry_slot.release()
            self.slots.release(); task['_event'].set()

    def cancel(self, handle):
        validate_identity(handle, handle=True)
        with self.store._guard(self.store._project_path(handle['projectId'])):
            task, stale = self._owned(handle)
            require(not stale, 'Cannot mutate a stale task.', 'REVISION_CONFLICT', 409)
            with self.lock:
                if task['status'] in {'queued', 'running'}:
                    task['_cancel'].set()
                    process = task['_process']
                    if process is not None and process.poll() is None: process.kill()
                return {'task': self._public(task)}

    def cancel_obsolete(self, handle):
        """Cancel only this host's exact task, even after its saved graph changed.

        Viewport invalidation can race the save or remove the original node. The
        complete runtime-owned handle remains the cancellation capability; it
        grants no result validation, artifact reads, or execution at an old revision.
        """
        validate_identity(handle, handle=True)
        with self.store._guard(self.store._project_path(handle['projectId'])):
            task, stale = self._owned(handle)
            with self.lock:
                if task['status'] in {'queued', 'running'}:
                    task['_cancel'].set()
                    process = task['_process']
                    if process is not None and process.poll() is None: process.kill()
                return {'task': self._public(task, stale)}

    def export(self, payload):
        validate_identity(payload, handle=True, optional={'format', 'port'})
        handle = {k: payload[k] for k in HANDLE}
        with self.store._guard(self.store._project_path(handle['projectId'])):
            self._verify_locked(handle)
            task, _ = self._owned(handle)
            require(task['_outputs'] is not None, 'Diagnostic reports cannot export geometry.', 'RESULT_UNAVAILABLE', 409)
            candidates = [name for name, value in task['_outputs'].items() if value.get('type') in {'Mesh', 'PointSet', 'InstanceSet'}]
            port = payload.get('port', candidates[0] if candidates else None)
            require(isinstance(port, str) and port in candidates, 'No geometry output on this port.', 'PORT_UNKNOWN')
            require(payload.get('format', 'glb') in {'glb', 'json'}, 'Unsupported export format.', 'FORMAT_UNSUPPORTED')
            artifact = self.assets.publish(task, port, task['_outputs'][port], payload.get('format', 'glb'))
            return {'ok': True, 'artifact': artifact}

    def download(self, handle, artifact_id):
        validate_identity(handle, handle=True)
        with self.store._guard(self.store._project_path(handle['projectId'])):
            task, stale = self._owned(handle)
            require(not stale and task['status'] == 'succeeded', 'Artifact belongs to a stale or unsuccessful task.', 'REVISION_CONFLICT', 409)
            return self.assets.read(task, artifact_id)

    def _owned(self, handle):
        validate_identity(handle, handle=True)
        document = self._project(handle['projectId'])
        with self.lock:
            task = self.tasks.get(handle['jobId'])
            require(task is not None, 'Task not found in this host.', 'TASK_NOT_FOUND', 404)
            require(all(task[k] == handle[k] for k in HANDLE), 'Task handle identity differs.', 'TASK_IDENTITY_MISMATCH', 409)
            return task, document['revision'] != task['revision'] or self.latest.get((task['projectId'], task['nodeId'])) != task['jobId']

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
            require(task['resultHash'] == content_hash(task['result']), 'Result identity changed.', 'RESULT_HASH_MISMATCH', 409)
            if task['_outputs'] is None:
                require(task['result']['report']['inputHash'] == task['inputHash'], 'Report identity changed.', 'RESULT_HASH_MISMATCH', 409)
            else:
                _, _, current_hash = self._prepare({k: task[k] for k in IDENTITY})
                require(current_hash == task['inputHash'], 'Saved graph inputs changed.', 'RESULT_HASH_MISMATCH', 409)
                require(content_hash(task['_outputs']) == task['result']['report']['outputHash'], 'Internal geometry changed.', 'RESULT_HASH_MISMATCH', 409)
                for artifact in task['result']['assets']: self.assets.read(task, artifact['artifactId'])
                for stage in task['result'].get('stagePreviews', []):
                    for artifact in stage['assets']: self.assets.read(task, artifact['artifactId'])
            return {'ok': True, 'verified': True, 'jobId': task['jobId'], 'inputHash': task['inputHash'], 'resultHash': task['resultHash']}

    def list_tasks(self, project_id, node_id):
        token(project_id); token(node_id)
        document = self._project(project_id)
        self._node(document, node_id)
        with self.lock:
            return {'tasks': [self._public(t, document['revision'] != t['revision'] or self.latest.get((t['projectId'], t['nodeId'])) != t['jobId']) for t in reversed(list(self.tasks.values())) if t['projectId'] == project_id and t['nodeId'] == node_id]}

    def active_count(self):
        with self.lock:
            return sum(t['status'] in {'queued', 'running'} for t in self.tasks.values())

    def close(self):
        with self.lock:
            self.closed = True
            tasks = list(self.tasks.values())
            for task in tasks:
                task['_cancel'].set()
                process = task['_process']
                if process and process.poll() is None: process.kill()
        for task in tasks:
            thread = task['_thread']
            if thread: thread.join(timeout=6)
