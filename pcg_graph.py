"""Saved PCG DAG planning and bounded per-project pure result cache."""
from __future__ import annotations
import copy
from collections import OrderedDict
from pcg_contracts import (canonical, content_hash, exact, find_descriptor, port_types,
                           require, token, validate_parameters)

MAX_GRAPH_NODES = 256
MAX_GRAPH_BYTES = 32 * 1024 * 1024


def plan_graph(document, target, registry, permit_unavailable=False):
    canvas = document['canvas']; nodes = canvas['nodes']; edges = canvas['edges']
    require(len(nodes) <= 4096 and len(edges) <= 4096, 'Graph budget exceeded.', 'BUDGET_EXCEEDED')
    by_id = {}
    for node in nodes:
        require(node.get('id') not in by_id, 'Duplicate node identity.', 'INVALID_GRAPH')
        by_id[node.get('id')] = node
    ordered, active, done, descriptors = [], set(), set(), {}

    def visit(node_id):
        require(node_id not in active, 'PCG graph contains a cycle.', 'GRAPH_CYCLE')
        if node_id in done: return
        node = by_id.get(node_id)
        require(node is not None and node.get('type') == 'pcg', 'PCG dependency not found.', 'NODE_NOT_FOUND', 404)
        token(node_id); data = node.get('data', {})
        descriptor = find_descriptor(registry, data.get('descriptorId'), data.get('descriptorVersion'), data.get('operationVersion'))
        descriptors[node_id] = descriptor
        parameters = validate_parameters(descriptor, data.get('parameters', {}))
        ports = {p['name']: p for p in descriptor['inputs']}; inputs = {}
        active.add(node_id)
        for edge in edges:
            if edge.get('source') == node_id:
                require(edge.get('sourceHandle') in {p['name'] for p in descriptor['outputs']}, 'Unknown source port.', 'PORT_UNKNOWN')
            if edge.get('target') != node_id: continue
            name = edge.get('targetHandle')
            require(isinstance(name, str) and name in ports and name not in inputs, 'Unknown or duplicate input port.', 'PORT_UNKNOWN')
            source = by_id.get(edge.get('source'))
            require(source is not None and source.get('type') == 'pcg', 'PCG dependency not found.', 'NODE_NOT_FOUND', 404)
            sd = source.get('data', {})
            source_descriptor = find_descriptor(registry, sd.get('descriptorId'), sd.get('descriptorVersion'), sd.get('operationVersion'))
            output = next((p for p in source_descriptor['outputs'] if p['name'] == edge.get('sourceHandle')), None)
            require(output is not None, 'Unknown output port.', 'PORT_UNKNOWN')
            require(bool(port_types(output['type']) & port_types(ports[name]['type'])), 'Connected port types differ.', 'PORT_TYPE_MISMATCH')
            edge_data = edge.get('data') or {}
            require(isinstance(edge_data, dict) and ('pcgType' not in edge_data or bool(port_types(edge_data['pcgType']) & port_types(output['type']))), 'Edge type differs.', 'PORT_TYPE_MISMATCH')
            inputs[name] = {'nodeId': source['id'], 'port': output['name']}
            visit(source['id'])
        for name, port in ports.items():
            require(not port['required'] or name in inputs, 'Required input is missing.', 'INPUT_UNAVAILABLE', 409)
        if not permit_unavailable:
            require(descriptor['readiness']['state'] == 'ready', 'Geometry executor is unavailable.', descriptor['readiness']['code'] or 'EXECUTOR_UNAVAILABLE', 409)
        active.remove(node_id); done.add(node_id)
        ordered.append({'nodeId': node_id, 'descriptorId': descriptor['id'], 'descriptorVersion': descriptor['descriptorVersion'], 'operationVersion': descriptor['operationVersion'], 'parameters': parameters, 'inputs': inputs})
        require(len(ordered) <= MAX_GRAPH_NODES, 'Dependency graph exceeds node budget.', 'BUDGET_EXCEEDED')
    visit(target)
    plan = {'target': target, 'nodes': ordered}
    require(len(canonical(plan)) <= MAX_GRAPH_BYTES, 'Graph exceeds byte budget.', 'BUDGET_EXCEEDED')
    return plan, descriptors


def computation_key(node, inputs):
    # Explicit values include Field source/content/topology/domain bindings.
    return content_hash({'operation': node['descriptorId'], 'operationVersion': node['operationVersion'],
                         'parameters': node['parameters'], 'inputs': inputs})


class GraphCache:
    """LRU owned by one runtime instance; keys also isolate project identities."""
    def __init__(self, max_bytes=32 * 1024 * 1024, max_entries=256):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.entries, self.bytes = OrderedDict(), 0

    def get(self, project, key):
        identity = (project, key)
        entry = self.entries.get(identity)
        if entry is None: return None
        self.entries.move_to_end(identity)
        return copy.deepcopy(entry[0])

    def put(self, project, key, value):
        size = len(canonical(value)); identity = (project, key)
        if size > self.max_bytes: return
        previous = self.entries.pop(identity, None)
        if previous: self.bytes -= previous[1]
        self.entries[identity] = (copy.deepcopy(value), size); self.bytes += size
        while self.bytes > self.max_bytes or len(self.entries) > self.max_entries:
            _, (_, old_size) = self.entries.popitem(last=False); self.bytes -= old_size

    def snapshot(self, project):
        return {key: copy.deepcopy(value) for (pid, key), (value, _) in self.entries.items() if pid == project}


def dirty_nodes(plan, cache):
    values, dirty, hits = {}, [], []
    for node in plan['nodes']:
        if any(ref['nodeId'] not in values for ref in node['inputs'].values()):
            dirty.append(node['nodeId']); continue
        inputs = {name: values[ref['nodeId']][ref['port']] for name, ref in node['inputs'].items()}
        key = computation_key(node, inputs)
        if key not in cache: dirty.append(node['nodeId'])
        else: values[node['nodeId']] = cache[key]; hits.append(node['nodeId'])
    return {'dirtyNodes': dirty, 'cacheHits': hits}
