"""Synthetic M1 contracts and asset policy tests; no live services or user files."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pcg_contracts import (AssetBroker, PCGError, canonical, find_descriptor,
                           geometry_context, instance_context, load_registry, parse_json, validate_attribute,
                           validate_field, validate_geometry, validate_instances,
                           validate_parameters)
from project_store import ProjectStore


def geometry(project_id='prj_test', sha='a' * 64):
    return {'contractVersion': 1, 'type': 'GeometryArtifact', 'projectId': project_id,
            'artifactId': 'pcg_' + sha, 'sha256': sha, 'assetPath': f'assets/{sha}.pcg.json',
            'format': 'pcg.geometry.json', 'coordinates': {'units': 'm', 'handedness': 'right', 'upAxis': 'Y'},
            'topologyId': 'topology_fixture', 'counts': {'Point': 4, 'Face': 2, 'Corner': 6},
            **artifact_metadata()}


def artifact_metadata():
    return {'bounds': {'min': [0, 0, 0], 'max': [1, 1, 1]},
            'producer': {'pluginId': 'refmuse.pcg', 'pluginVersion': '1.0.0', 'commit': 'a' * 40},
            'provenance': {'nodeId': 'fixture-node', 'jobId': 'fixture-job', 'runId': 'fixture-run', 'revision': 1, 'recipeHash': 'b' * 64, 'inputHashes': []},
            'metadata': {'uvSets': [], 'normalDomain': None, 'materials': [], 'quality': {'state': 'diagnostic-only', 'issues': []}}}


class ContractsTests(unittest.TestCase):
    def setUp(self):
        self.geometry = geometry()
        self.context = geometry_context(self.geometry)
        self.attribute = {'contractVersion': 1, 'type': 'Attribute', 'geometry': self.context['binding'],
                          'domain': 'Corner', 'valueType': 'float', 'values': [0.0] * 6}
        self.field = {'contractVersion': 1, 'type': 'Field', 'geometry': self.context['binding'], 'domain': 'Corner',
                      'valueType': 'float', 'nodes': [{'id': 'constant', 'op': 'constant', 'valueType': 'float', 'value': 2.0}], 'output': 'constant'}

    def rejected(self, callback, code=None):
        with self.assertRaises(PCGError) as caught: callback()
        if code: self.assertEqual(caught.exception.code, code)

    def test_registry_closed_and_versions_permissions_types(self):
        registry = load_registry()
        self.assertEqual(len(registry['nodes']), 25)
        self.assertEqual(find_descriptor(registry, 'refmuse.pcg.geometry_stub')['readiness']['code'], 'EXECUTOR_UNAVAILABLE')
        self.rejected(lambda: find_descriptor(registry, 'not-installed'), 'DESCRIPTOR_UNKNOWN')
        self.rejected(lambda: find_descriptor(registry, registry['nodes'][0]['id'], True), 'VERSION_UNSUPPORTED')
        mutations = [lambda r: r.update(descriptorVersion=2), lambda r: r.update(script='no'),
                     lambda r: r['nodes'][0].update(permissions=['network']),
                     lambda r: r['nodes'][0]['inputs'][0].update(type='Any'),
                     lambda r: r['nodes'][0].update(operationVersion=2),
                     lambda r: r['nodes'][0]['parameters']['properties']['label'].update(type='code')]
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'registry.json'
            for mutate in mutations:
                value = copy.deepcopy(registry); mutate(value); path.write_text(json.dumps(value), encoding='utf-8')
                self.rejected(lambda: load_registry(path))
        descriptor = registry['nodes'][0]
        self.assertEqual(validate_parameters(descriptor, {}), {'label': 'Contract check'})
        for parameters in ({'script': 'x'}, {'label': 'a' * 81}, {'label': 123}, {'label': '\x00'}):
            self.rejected(lambda: validate_parameters(descriptor, parameters))
        for raw in ('{"duplicate":1,"duplicate":2}', '{"number":NaN}', '{"number":Infinity}'):
            self.rejected(lambda: parse_json(raw))

    def test_geometry_fixed_coordinates_version_and_identity(self):
        validate_geometry(self.geometry, 'prj_test')
        for field, value in [('contractVersion', 2), ('format', 'obj'), ('assetPath', '../secret'), ('coordinates', {'units': 'cm', 'handedness': 'left', 'upAxis': 'Z'})]:
            fixture = {**self.geometry, field: value}
            self.rejected(lambda: validate_geometry(fixture, 'prj_test'))
        self.rejected(lambda: validate_geometry(self.geometry, 'prj_other'), 'CROSS_PROJECT')
        self.rejected(lambda: validate_geometry({**self.geometry, 'script': 'code'}, 'prj_test'))

    def test_attribute_preserves_corner_domain_and_topology(self):
        validate_attribute(self.attribute, self.context)
        self.rejected(lambda: validate_attribute({**self.attribute, 'domain': 'Point'}, self.context), 'DOMAIN_MISMATCH')
        binding = {**self.context['binding'], 'topologyId': 'different'}
        self.rejected(lambda: validate_attribute({**self.attribute, 'geometry': binding}, self.context), 'GEOMETRY_MISMATCH')
        self.rejected(lambda: validate_attribute({**self.attribute, 'values': [True] * 6}, self.context))
        selection = {**self.attribute, 'type': 'Selection', 'valueType': 'boolean', 'values': [True] * 6}
        validate_attribute(selection, self.context)
        self.rejected(lambda: validate_attribute({**selection, 'valueType': 'float'}, self.context))

    def test_field_bounded_typed_dag_no_expressions_cycles(self):
        validate_field(self.field, self.context)
        valid = copy.deepcopy(self.field)
        valid['nodes'].append({'id': 'sum', 'op': 'add', 'valueType': 'float', 'inputs': ['constant', 'constant']})
        valid['output'] = 'sum'; validate_field(valid, self.context)
        for op in ('script', 'python', 'eval', 'loop'):
            fixture = copy.deepcopy(self.field); fixture['nodes'][0]['op'] = op
            self.rejected(lambda: validate_field(fixture, self.context))
        cycle = copy.deepcopy(valid); cycle['nodes'][1]['inputs'] = ['sum', 'constant']
        self.rejected(lambda: validate_field(cycle, self.context))
        mismatch = copy.deepcopy(valid); mismatch['nodes'][1]['valueType'] = 'integer'
        self.rejected(lambda: validate_field(mismatch, self.context))
        self.rejected(lambda: validate_field({**self.field, 'nodes': self.field['nodes'] * 65}, self.context))
        nan = copy.deepcopy(self.field); nan['nodes'][0]['value'] = float('nan')
        self.rejected(lambda: validate_field(nan, self.context))

    def test_instances_affine_count_and_cross_project(self):
        instance = {'contractVersion': 1, 'type': 'InstanceSet', 'projectId': 'prj_test', 'artifactId': 'pcg_' + 'b' * 64,
                    'sha256': 'b' * 64, 'assetPath': 'assets/' + 'b' * 64 + '.pcg.json', 'format': 'pcg.instances.json',
                    'geometry': self.context['binding'], 'topologyId': 'instance-order-v1', 'count': 1, 'instanceIds': ['instance-1'],
                    'coordinates': {'units': 'm', 'handedness': 'right', 'upAxis': 'Y'},
                    'transforms': [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]], **artifact_metadata()}
        validate_instances(instance, 'prj_test')
        self.rejected(lambda: validate_instances({**instance, 'count': 2}, 'prj_test'))
        self.rejected(lambda: validate_instances(instance, 'prj_other'), 'CROSS_PROJECT')
        context = instance_context(instance)
        attribute = {'contractVersion': 1, 'type': 'Attribute', 'geometry': context['binding'], 'domain': 'Instance', 'valueType': 'integer', 'values': [7]}
        validate_attribute(attribute, context)
        self.rejected(lambda: validate_attribute({**attribute, 'domain': 'Point'}, context), 'DOMAIN_MISMATCH')
        self.rejected(lambda: validate_instances({**instance, 'instanceIds': ['bad', 'bad'], 'count': 2}, 'prj_test'))

    def test_bounds_provenance_quality_metadata_are_closed(self):
        for mutate in (lambda v: v['bounds'].update(min=[2, 0, 0]),
                       lambda v: v['producer'].update(commit='unknown'),
                       lambda v: v['provenance'].update(recipeHash='bad'),
                       lambda v: v['provenance'].update(script='forbidden'),
                       lambda v: v['metadata']['quality'].update(state='accepted'),
                       lambda v: v['metadata'].update(normalDomain='Face'),
                       lambda v: v.update(artifactId='mutable-name')):
            fixture = copy.deepcopy(self.geometry); mutate(fixture)
            self.rejected(lambda: validate_geometry(fixture, 'prj_test'))
        self.rejected(lambda: geometry_context({'type': 'GeometryArtifact'}))


class AssetBrokerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = ProjectStore(Path(self.temp.name) / 'projects')
        self.document = self.store.create('Synthetic')
        self.project = self.store._project_path(self.document['id'])
        self.body = canonical({'contractVersion': 1, 'format': 'pcg.geometry.json', 'payload': {'fixture': 'synthetic'}})
        self.sha = hashlib.sha256(self.body).hexdigest()
        self.artifact = geometry(self.document['id'], self.sha)
        self.asset = self.project.parent / self.artifact['assetPath']
        self.asset.write_bytes(self.body)
        self.document['assets'] = [{'path': self.artifact['assetPath'], 'sha256': self.sha, 'bytes': len(self.body), 'mime': 'application/json'}]
        self.store.save(self.document['id'], self.document, 1)
        self.broker = AssetBroker(self.store)

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def test_registered_bounded_immutable_asset(self):
        self.assertEqual(self.broker.read(self.document['id'], self.artifact)['payload']['fixture'], 'synthetic')
        self.asset.write_bytes(self.body[:-1] + b' ')
        with self.assertRaises(PCGError) as caught: self.broker.read(self.document['id'], self.artifact)
        self.assertEqual(caught.exception.code, 'ASSET_HASH_MISMATCH')

    def test_unmanaged_cross_project_and_traversal_rejected(self):
        for path in ('../secret', 'assets/../secret', '/absolute', 'assets\\bad', 'assets/a.obj'):
            with self.assertRaises(PCGError): self.broker.read(self.document['id'], {**self.artifact, 'assetPath': path})
        other = self.store.create('Other')
        with self.assertRaises(PCGError) as caught: self.broker.read(other['id'], self.artifact)
        self.assertEqual(caught.exception.code, 'CROSS_PROJECT')
        changed = self.store.get(self.document['id']); changed['assets'] = []
        self.store.save(changed['id'], changed, changed['revision'])
        with self.assertRaises(PCGError) as caught: self.broker.read(self.document['id'], self.artifact)
        self.assertEqual(caught.exception.code, 'ASSET_UNMANAGED')

    def test_hardlink_and_reparse_rejected(self):
        link = Path(self.temp.name) / 'hardlink.json'
        os.link(self.asset, link)
        with self.assertRaises(PCGError): self.broker.read(self.document['id'], self.artifact)
        link.unlink()
        original = Path.lstat
        def reparse(path):
            info = original(path)
            if path == self.asset:
                return mock.Mock(st_mode=info.st_mode, st_file_attributes=0x400)
            return info
        with mock.patch.object(Path, 'lstat', reparse):
            with self.assertRaises(PCGError) as caught: self.broker.read(self.document['id'], self.artifact)
        self.assertEqual(caught.exception.code, 'ASSET_PATH_FORBIDDEN')

    def test_symlink_rejected_when_supported(self):
        original = self.asset.with_suffix('.original')
        self.asset.rename(original)
        try: self.asset.symlink_to(original)
        except OSError:
            original.rename(self.asset)
            self.skipTest('Symlink creation not available to this test user.')
        with self.assertRaises(PCGError) as caught: self.broker.read(self.document['id'], self.artifact)
        self.assertEqual(caught.exception.code, 'ASSET_PATH_FORBIDDEN')


if __name__ == '__main__': unittest.main()
