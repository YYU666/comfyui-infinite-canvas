"""Fixed single-request stdio diagnostic worker. No executable or file inputs."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time

# -I isolates site/user environment; this fixed repository path supplies contracts.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from pcg_contracts import (MAX_VALUE_BYTES, PCGError, canonical, digest, exact,
                           find_descriptor, geometry_context, load_registry,
                           parse_json, require, token, validate_parameters, validate_value)


def diagnose(request):
    exact(request, {'protocolVersion', 'descriptorId', 'descriptorVersion', 'operationVersion', 'parameters', 'inputs', 'projectId', 'inputHash'})
    require(type(request['protocolVersion']) is int and request['protocolVersion'] == 1, 'Unsupported worker protocol.', 'VERSION_UNSUPPORTED')
    registry = load_registry()
    descriptor = find_descriptor(registry, request['descriptorId'], request['descriptorVersion'], request['operationVersion'])
    parameters = validate_parameters(descriptor, request['parameters'])
    digest(request['inputHash']); token(request['projectId'])
    require(descriptor['id'] == 'refmuse.pcg.diagnostic', 'Geometry executor is unavailable.', 'EXECUTOR_UNAVAILABLE', 409)
    inputs = request['inputs']
    ports = {p['name']: p for p in descriptor['inputs']}
    exact(inputs, (), ports)
    context = geometry_context(inputs['geometry']) if 'geometry' in inputs else None
    for name, value in inputs.items():
        validate_value(value, ports[name]['type'], request['projectId'], context)
    return {'report': {'contractVersion': 1, 'type': 'DiagnosticReport', 'operation': descriptor['id'],
                       'label': parameters['label'], 'inputCount': len(inputs),
                       'inputTypes': {name: ports[name]['type'] for name in sorted(inputs)},
                       'workerPid': os.getpid(), 'inputHash': request['inputHash']}}


def evaluate_graph(request):
    from pcg_graph import computation_key, MAX_GRAPH_BYTES
    from pcg_geometry import evaluate, summarize
    from pcg_contracts import validate_engine_value, port_types
    exact(request, {'protocolVersion', 'projectId', 'inputHash', 'plan', 'cache'})
    require(request['protocolVersion'] == 2 and type(request['protocolVersion']) is int, 'Unsupported graph protocol.')
    token(request['projectId']); digest(request['inputHash'])
    plan = request['plan']; exact(plan, {'target', 'nodes'})
    require(isinstance(plan['nodes'], list) and 1 <= len(plan['nodes']) <= 256, 'Invalid graph size.')
    require(isinstance(request['cache'], dict), 'Invalid cache payload.')
    registry = load_registry(); values = {}; records = []; computed = []; hits = []
    for node in plan['nodes']:
        exact(node, {'nodeId', 'descriptorId', 'descriptorVersion', 'operationVersion', 'parameters', 'inputs'})
        token(node['nodeId']); require(node['nodeId'] not in values, 'Duplicate graph node.')
        descriptor = find_descriptor(registry, node['descriptorId'], node['descriptorVersion'], node['operationVersion'])
        require(descriptor['readiness']['state'] == 'ready' and descriptor['id'] not in {'refmuse.pcg.diagnostic', 'refmuse.pcg.geometry_stub'}, 'Graph executor is unavailable.', 'EXECUTOR_UNAVAILABLE')
        parameters = validate_parameters(descriptor, node['parameters'])
        ports = {p['name']: p for p in descriptor['inputs']}; exact(node['inputs'], {p['name'] for p in descriptor['inputs'] if p['required']}, ports)
        inputs = {}
        for name, ref in node['inputs'].items():
            exact(ref, {'nodeId', 'port'})
            require(ref['nodeId'] in values and ref['port'] in values[ref['nodeId']], 'Graph inputs must precede use.', 'INVALID_GRAPH')
            inputs[name] = values[ref['nodeId']][ref['port']]
            validate_engine_value(inputs[name], ports[name]['type'])
        require(len(canonical(inputs)) <= descriptor['budget']['maxInputBytes'], 'Node inputs exceed budget.', 'BUDGET_EXCEEDED')
        key = computation_key(node, inputs); started = time.perf_counter()
        cached = request['cache'].get(key)
        if cached is None:
            try:
                result = evaluate(descriptor['id'], parameters, inputs)
            except PCGError as exc:
                raise PCGError(exc.code, f"Node {node['nodeId']} ({descriptor['id']}): {exc.message}", exc.status) from exc
            computed.append(node['nodeId'])
        else:
            result = cached; hits.append(node['nodeId'])
        outputs = {p['name']: p for p in descriptor['outputs']}; exact(result, {p['name'] for p in descriptor['outputs'] if p['required']}, outputs)
        for name, value in result.items(): validate_engine_value(value, outputs[name]['type'])
        require(len(canonical(result)) <= descriptor['budget']['maxOutputBytes'], 'Node outputs exceed budget.', 'BUDGET_EXCEEDED')
        values[node['nodeId']] = result
        records.append({'nodeId': node['nodeId'], 'key': key, 'outputs': result, 'outputHash': __import__('pcg_contracts').content_hash(result), 'cacheHit': cached is not None, 'elapsedMs': (time.perf_counter() - started) * 1000})
        require(len(canonical(values)) <= MAX_GRAPH_BYTES, 'Graph outputs exceed budget.', 'BUDGET_EXCEEDED')
    require(plan['target'] in values, 'Missing graph target.')
    return {'outputs': values[plan['target']], 'records': records, 'computedNodes': computed, 'cacheHits': hits, 'inputHash': request['inputHash']}


def main():
    try:
        raw = sys.stdin.buffer.read(32 * MAX_VALUE_BYTES + 1)
        require(0 < len(raw) <= 32 * MAX_VALUE_BYTES, 'Worker input exceeds budget.', 'BUDGET_EXCEEDED')
        request = parse_json(raw)
        result = evaluate_graph(request) if isinstance(request, dict) and request.get('protocolVersion') == 2 and 'plan' in request else diagnose(request)
        output = {'ok': True, 'result': result}
    except PCGError as exc:
        output = {'ok': False, 'error': {'code': exc.code, 'message': exc.message}}
    except (ValueError, TypeError, RecursionError, KeyError):
        output = {'ok': False, 'error': {'code': 'INVALID_CONTRACT', 'message': 'Invalid worker contract.'}}
    sys.stdout.buffer.write(canonical(output) + b'\n')
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
