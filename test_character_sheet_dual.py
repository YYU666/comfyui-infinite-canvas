import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from extension_sharing import share_extension
from extension_stages import flatten_plan
from outfit_queue import validate_plan, stage_workflow, initial_state
from test_extension_stages import StageAdapter
from test_workbench_queue import wait_for
from workbench_queue import QueueManager
from workflow_extensions import ExtensionStore, ExtensionError, validate_definition


class DualSheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = """
          globalThis.window={location:{hostname:'127.0.0.1'}};
          const {buildCharacterSheetQueuePlan}=await import('./src/workbench-api.js');
          const options={prompt:'',seed:123,qwenSteps:40,qwenRefResolution:1536,
            references:[{kind:'image',slot:'guide',name:'identity.png'},{kind:'image',slot:'body_reference',name:'body.png'}]};
          console.log(JSON.stringify([buildCharacterSheetQueuePlan(options),
            buildCharacterSheetQueuePlan({...options,characterSheetPortraitCrop:{x:210,y:10,width:600,height:700}})]));
        """
        cls.plan, cls.prep = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parent, text=True, encoding='utf-8'))
        cls.info = {}
        for plan in (cls.plan, cls.prep):
            for graph in [p['single'] for p in plan['panels']] + [plan['stitch']]:
                for node in graph.values():
                    fields = cls.info.setdefault(node['class_type'], {'input': {'required': {}}, 'output': ['*'] * 5})['input']['required']
                    for key, value in node['inputs'].items():
                        fields[key] = ['*' if isinstance(value, list) else {str:'STRING', int:'INT', float:'FLOAT', bool:'BOOLEAN'}[type(value)]]
        for metadata in cls.info.values():
            fields = metadata['input']['required']
            if 'images.image_2' in fields:
                metadata['input']['optional'] = {'images.image_2': fields.pop('images.image_2')}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name) / 'extensions')

    def share(self, plan):
        return share_extension(self.store, {'plan': plan, 'name': '双参考／单图兼容四视图', 'packageId': 'artist/dual-sheet', 'version': '0.3.0', 'includePrompts': True}, self.info)

    def test_export_import_prepare_roles_and_optional_body_fallback(self):
        for original in (self.plan, self.prep):
            shared = self.share(original)
            definition = shared['nodes'][0]['definition']
            self.assertEqual(definition['execution']['version'], 3)
            self.assertEqual([port['id'] for port in definition['inputs']], ['image_identity', 'image_body'])
            self.assertTrue(all(port.get('label') for port in definition['inputs']))
            self.assertEqual(definition['inputs'][1]['fallback'], 'image_identity')
            imported_store = ExtensionStore(Path(self.temp.name) / 'imported')
            imported = imported_store.import_bytes(self.store.download(shared['digest']), 'dual.h3pack')
            for supplied in ({'image_identity': 'new-identity.png', 'image_body': 'new-body.png'},
                             {'image_identity': 'same.png', 'image_body': 'same.png'},
                             {'image_identity': 'identity-only.png'}):
                request = {'nodeDefinitionId': 'workflow', 'inputs': supplied}
                frozen = copy.deepcopy(request)
                prepared = imported_store.prepare(imported['digest'], request, self.info)
                self.assertEqual(request, frozen, 'fallback never mutates supplied inputs')
                expected = validate_plan(original)
                for panel in expected['panels']:
                    for key, role in panel['inputRoles'].items():
                        panel['single'][key]['inputs']['image'] = supplied.get('image_' + role, supplied['image_identity'])
                self.assertEqual(prepared['plan'], expected)
                self.assertEqual(prepared['outputs'], [{'id': 'image_sheet', 'type': 'image', 'nodeId': 'save'}])
            for invalid in ({}, {'image_body': 'body.png'}, {'image_identity': 'identity.png', 'image_body': ''},
                            {'image_identity': 'identity.png', 'image_body': None}, {'image_identity': 'identity.png', 'unknown': 'x.png'}):
                with self.assertRaises(ExtensionError):
                    imported_store.prepare(imported['digest'], {'nodeDefinitionId': 'workflow', 'inputs': invalid}, self.info)

    def test_queue_uses_saved_front_identity_and_distinct_body_reference(self):
        shared = self.share(self.plan)
        prepared = self.store.prepare(shared['digest'], {'nodeDefinitionId': 'workflow', 'inputs': {'image_identity': 'portrait-input.png', 'image_body': 'outfit-input.png'}}, self.info)
        adapter = StageAdapter()
        manager = QueueManager(Path(self.temp.name) / 'queue.json', adapter, poll_interval=0.01)
        self.addCleanup(manager.stop)
        job = manager.enqueue({'plan': prepared['plan'], 'projectId': 'fixture', 'nodeId': 'dual', 'clientId': 'fixture'})
        manager.start()
        wait_for(lambda: manager.get(job['id'])['status'] in ('done', 'error'))
        self.assertEqual(manager.get(job['id'])['status'], 'done')
        self.assertEqual(len(adapter.submitted), 5)
        self.assertEqual(adapter.submitted[0]['workflow']['source']['inputs']['image'], 'portrait-input.png')
        body = adapter.submitted[2]['workflow']
        self.assertEqual(body['body_source']['inputs']['image'], 'outfit-input.png')
        self.assertEqual(body['identity_source']['inputs']['image'], adapter.uploads[0]['name'])
        self.assertEqual(body['front_body_encode']['inputs']['images.image_1'], ['body_reference', 0])
        self.assertEqual(body['front_body_encode']['inputs']['images.image_2'], ['identity_source', 0])
        self.assertEqual(adapter.submitted[3]['workflow']['angle_source']['inputs']['image'], adapter.uploads[2]['name'])
        self.assertIn(prepared['outputs'][0]['nodeId'], manager.get(job['id'])['outputs'])

    def test_malformed_roles_dependencies_placeholders_and_cross_stage_rejected(self):
        mutations = [
            lambda p: p['panels'][0]['inputRoles'].update(source='body'),
            lambda p: p['panels'][2].update(inputRoles={}),
            lambda p: p['panels'][2]['inputRoles'].update(identity_source='identity'),
            lambda p: p['panels'][2].update(dependsOn=[]),
            lambda p: p['panels'][2]['single']['identity_source']['inputs'].update(image='identity.png'),
            lambda p: p['panels'][2]['single']['body_source']['inputs'].update(image='__H3_CHARACTER_SHEET_PANEL_back_body__'),
            lambda p: p['panels'][2]['single']['body_reference']['inputs'].update(image=['front_portrait__source', 0]),
            lambda p: p.update(referenceMode='unknown'),
            lambda p: p.pop('referenceMode'),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(self.plan)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate_plan(invalid)
        with self.assertRaisesRegex(ValueError, '依赖图片'):
            stage_workflow({'plan': validate_plan(self.plan), 'planState': {**initial_state(), 'panelIndex': 2}})

    def test_v3_package_rejects_swapped_roles_fallback_and_public_intermediates(self):
        chosen = flatten_plan(self.plan)
        mutations = [
            lambda d, w: d['inputs'][1].update(fallback='image_body'),
            lambda d, w: d['inputs'][0].update(required=False),
            lambda d, w: d['inputs'][1].update(fallback='unknown'),
            lambda d, w: d['execution']['stages'][2]['inputRoles'].update(front_body__body_source='identity'),
            lambda d, w: next(b for b in d['bindings'] if b['sourceId'] == 'image_body').update(sourceId='image_identity'),
            lambda d, w: d['outputs'][0].update(nodeId='front_body__save'),
            lambda d, w: w['front_body__identity_source']['inputs'].update(image='input.png'),
        ]
        for mutate in mutations:
            definition, workflow = copy.deepcopy(chosen['definition']), copy.deepcopy(chosen['workflow'])
            mutate(definition, workflow)
            with self.assertRaises(ExtensionError):
                validate_definition(definition, workflow, 'workflow')
