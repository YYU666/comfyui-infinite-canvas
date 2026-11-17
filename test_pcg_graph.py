"""Pure saved-graph planning, schema and bounded cache fixtures."""
import copy
import unittest
from pcg_contracts import PCGError, validate_parameters, validate_schema
from pcg_graph import GraphCache, computation_key, dirty_nodes, plan_graph


def descriptor(name, inputs=(), outputs=('geometry',)):
    return {'id': 'refmuse.pcg.' + name, 'descriptorVersion': 1, 'operationVersion': 1,
            'parameters': {'type': 'object', 'additionalProperties': False, 'properties': {}, 'required': []},
            'inputs': [{'name': p, 'type': 'Geometry', 'required': True} for p in inputs],
            'outputs': [{'name': p, 'type': 'Geometry', 'required': True} for p in outputs],
            'readiness': {'state': 'ready', 'code': None}}


def node(id, operation):
    return {'id': id, 'type': 'pcg', 'data': {'descriptorId': 'refmuse.pcg.' + operation, 'descriptorVersion': 1, 'operationVersion': 1, 'parameters': {}}}


def edge(source, target, port='geometry'):
    return {'source': source, 'target': target, 'sourceHandle': 'geometry', 'targetHandle': port}


class GraphTests(unittest.TestCase):
    def setUp(self):
        self.registry = {'nodes': [descriptor('primitive'), descriptor('transform', ['geometry']), descriptor('join_geometry', ['a', 'b'])]}
        self.document = {'canvas': {'nodes': [node('a', 'primitive'), node('b', 'transform'), node('c', 'primitive'), node('join', 'join_geometry')],
                                    'edges': [edge('a', 'b'), edge('b', 'join', 'a'), edge('c', 'join', 'b')]}}

    def test_dependency_order_and_disconnected_nodes(self):
        plan, _ = plan_graph(self.document, 'b', self.registry)
        self.assertEqual([n['nodeId'] for n in plan['nodes']], ['a', 'b'])
        plan, _ = plan_graph(self.document, 'join', self.registry)
        self.assertEqual([n['nodeId'] for n in plan['nodes']], ['a', 'b', 'c', 'join'])

    def test_cycles_missing_duplicate_unknown_and_wrong_type(self):
        for changes, code in [([edge('b', 'a')], 'INPUT_UNAVAILABLE'), ([edge('a', 'b'), edge('c', 'b')], 'PORT_UNKNOWN')]:
            doc = copy.deepcopy(self.document); doc['canvas']['edges'] = changes
            with self.assertRaises(PCGError) as caught: plan_graph(doc, 'b', self.registry)
            self.assertEqual(caught.exception.code, code)
        doc = {'canvas': {'nodes': [node('a', 'transform'), node('b', 'transform')], 'edges': [edge('a', 'b'), edge('b', 'a')]}}
        with self.assertRaises(PCGError) as caught: plan_graph(doc, 'b', self.registry)
        self.assertEqual(caught.exception.code, 'GRAPH_CYCLE')
        doc['canvas']['edges'] = []
        with self.assertRaises(PCGError) as caught: plan_graph(doc, 'b', self.registry)
        self.assertEqual(caught.exception.code, 'INPUT_UNAVAILABLE')

    def test_cache_content_keys_revision_independent_lru_project_instance(self):
        plan, _ = plan_graph(self.document, 'b', self.registry)
        cache = GraphCache(max_bytes=1024, max_entries=2)
        root = plan['nodes'][0]; k = computation_key(root, {})
        cache.put('project-a', k, {'geometry': {'fixture': [1, 2]}})
        self.assertIsNone(cache.get('project-b', k)); self.assertIsNone(GraphCache().get('project-a', k))
        value = cache.get('project-a', k); value['geometry']['fixture'].append(3)
        self.assertEqual(cache.get('project-a', k)['geometry']['fixture'], [1, 2])
        state = dirty_nodes(plan, cache.snapshot('project-a'))
        self.assertEqual(state, {'dirtyNodes': ['b'], 'cacheHits': ['a']})
        self.assertNotEqual(k, computation_key({**root, 'parameters': {'seed': 2}}, {}))
        cache.put('project-a', 'two', {'x': 2}); cache.get('project-a', k); cache.put('project-a', 'three', {'x': 3})
        self.assertIsNone(cache.get('project-a', 'two')); self.assertLessEqual(cache.bytes, 1024)
        field = {'binding': {'topologyHash': 'a', 'contentHash': 'b'}, 'values': [1]}
        self.assertNotEqual(computation_key(root, {'field': field}), computation_key(root, {'field': {**field, 'binding': {'topologyHash': 'c', 'contentHash': 'b'}}}))

    def test_worker_error_names_actual_upstream_stage_and_missing_port(self):
        from pcg_contracts import load_registry
        from pcg_worker import evaluate_graph
        ground = node('ground', 'primitive'); ground['data']['parameters'] = {'kind': 'plane'}
        scatter = node('scatter-stage', 'scatter_points')
        scatter['data']['parameters'] = {'count': 20, 'minDistance': 1000}
        final = node('result', 'instance_on_points')
        point_edge = {**edge('scatter-stage', 'result', 'points'), 'sourceHandle': 'points'}
        document = {'canvas': {'nodes': [ground, scatter, final], 'edges': [edge('ground', 'scatter-stage'), point_edge, edge('ground', 'result', 'prototype')]}}
        registry = load_registry()
        plan, _ = plan_graph(document, 'result', registry)
        with self.assertRaises(PCGError) as caught:
            evaluate_graph({'protocolVersion': 2, 'projectId': 'prj_fixture', 'inputHash': 'a' * 64, 'plan': plan, 'cache': {}})
        self.assertEqual(caught.exception.code, 'INSUFFICIENT_PLACEMENT')
        self.assertIn('scatter-stage (refmuse.pcg.scatter_points)', caught.exception.message)
        document['canvas']['edges'] = []
        with self.assertRaises(PCGError) as caught:
            plan_graph(document, 'scatter-stage', registry)
        self.assertIn('geometry', caught.exception.message)
        self.assertIn('scatter-stage', caught.exception.message)

    def test_strict_schema_defaults_numbers_arrays_objects_enums(self):
        schema = {'type': 'object', 'additionalProperties': False, 'required': [], 'properties': {
            'vector': {'type': 'array', 'items': {'type': 'number', 'minimum': -5, 'maximum': 5}, 'minItems': 3, 'maxItems': 3, 'default': [1, 2, 3]},
            'mode': {'type': 'string', 'enum': ['one', 'two'], 'default': 'one'},
            'count': {'type': 'integer', 'minimum': 0, 'maximum': 5, 'default': 1},
            'enabled': {'type': 'boolean', 'default': True}}}
        validate_schema(schema); descriptor = {'parameters': schema}
        self.assertEqual(validate_parameters(descriptor, {})['vector'], [1, 2, 3])
        for value in ({'count': True}, {'count': 6}, {'mode': 'bad'}, {'vector': [1, 2]}, {'vector': [1, 2, float('inf')]}, {'script': 'x'}):
            with self.assertRaises(PCGError): validate_parameters(descriptor, value)
        with self.assertRaises(PCGError): validate_schema({'type': 'object', 'properties': {}, 'required': [], 'additionalProperties': True})


if __name__ == '__main__': unittest.main()
