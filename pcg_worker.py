"""Fixed single-request stdio diagnostic worker. No executable or file inputs."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

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


def main():
    try:
        raw = sys.stdin.buffer.read(MAX_VALUE_BYTES + 1)
        require(0 < len(raw) <= MAX_VALUE_BYTES, 'Worker input exceeds budget.', 'BUDGET_EXCEEDED')
        result = diagnose(parse_json(raw))
        output = {'ok': True, 'result': result}
    except PCGError as exc:
        output = {'ok': False, 'error': {'code': exc.code, 'message': exc.message}}
    except (ValueError, TypeError, RecursionError, KeyError):
        output = {'ok': False, 'error': {'code': 'INVALID_CONTRACT', 'message': 'Invalid worker contract.'}}
    sys.stdout.buffer.write(canonical(output) + b'\n')
    sys.stdout.buffer.flush()


if __name__ == '__main__':
    main()
