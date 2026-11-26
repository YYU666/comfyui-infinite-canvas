import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from extension_sharing import share_extension
from extension_stages import flatten_plan
from outfit_queue import validate_plan
from test_extension_stages import StageAdapter
from test_workbench_queue import wait_for
from workbench_queue import QueueManager
from workflow_extensions import ExtensionStore, ExtensionError, validate_definition


class BackSheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = """
          globalThis.window={location:{hostname:'127.0.0.1'}};
          const {buildCharacterSheetQueuePlan}=await import('./src/workbench-api.js');
          const {CHARACTER_SHEET_RECIPE_VERSION}=await import('./src/character-sheet-recipe.js');
          const options={characterSheetRecipeVersion:CHARACTER_SHEET_RECIPE_VERSION,characterSheetStage:'all',
            references:[{kind:'image',slot:'guide',name:'identity.png'},{kind:'image',slot:'body_reference',name:'body.png'},{kind:'image',slot:'back_reference',name:'back.png'}]};
          console.log(JSON.stringify([buildCharacterSheetQueuePlan(options),
            buildCharacterSheetQueuePlan({...options,references:options.references.filter(r=>r.slot!=='back_reference')}),
            buildCharacterSheetQueuePlan({...options,references:options.references.filter(r=>r.slot!=='body_reference')})]));
        """
        cls.plan, cls.no_back, cls.back_only = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parent, text=True, encoding='utf-8'))
        cls.info = {}
        for plan in (cls.plan, cls.no_back, cls.back_only):
            graphs = [p['single'] for p in plan['panels']] + [p['withoutBackSingle'] for p in plan['panels'] if 'withoutBackSingle' in p] + [plan['stitch']]
            for graph in graphs:
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

    def share(self, plan=None):
        return share_extension(self.store, {'plan': plan or self.plan, 'name': '背面参考四视图', 'packageId': 'artist/back-sheet', 'version': '0.4.0', 'includePrompts': True}, self.info)

    def prepare(self, shared, inputs, parameters=None):
        return self.store.prepare(shared['digest'], {'nodeDefinitionId': 'workflow', 'inputs': inputs, 'parameters': parameters or {}}, self.info)

    def test_all_optional_combinations_roundtrip_and_execute_only_selected_branch(self):
        shared = self.share()
        self.assertEqual(shared['nodes'][0]['definition']['execution']['version'], 4)
        imported = self.store.import_bytes(self.store.download(shared['digest']), 'back.h3pack')
        for index, optional in enumerate(({}, {'image_body': 'outfit.png'}, {'image_back': 'rear.png'}, {'image_body': 'outfit.png', 'image_back': 'rear.png'}, {'image_body': 'identity.png', 'image_back': 'identity.png'})):
            inputs = {'image_identity': 'identity.png', **optional}
            prepared = self.prepare(imported, inputs)
            expected = validate_plan(self.plan if 'image_back' in inputs else self.no_back)
            for panel in expected['panels']:
                for key, role in panel['inputRoles'].items():
                    panel['single'][key]['inputs']['image'] = inputs.get('image_' + role, inputs['image_identity'])
            self.assertEqual(prepared['plan'], expected)
            adapter = StageAdapter()
            manager = QueueManager(Path(self.temp.name) / f'queue-{index}.json', adapter, poll_interval=0.01)
            self.addCleanup(manager.stop)
            job = manager.enqueue({'plan': prepared['plan'], 'projectId': 'test', 'nodeId': 'back', 'clientId': 'test'})
            manager.start()
            wait_for(lambda: manager.get(job['id'])['status'] in ('done', 'error'))
            self.assertEqual(manager.get(job['id'])['status'], 'done')
            self.assertEqual(len(adapter.submitted), 5)
            back = adapter.submitted[3]['workflow']
            self.assertEqual(back['angle_source']['inputs']['image'], adapter.uploads[2]['name'])
            self.assertEqual(back['back_body_encode']['inputs']['images.image_1'], ['angle_source', 0])
            if 'image_back' in inputs:
                self.assertEqual(back['back_source']['inputs']['image'], inputs['image_back'])
                self.assertEqual(back['back_body_encode']['inputs']['images.image_2'], ['back_reference', 0])
            else:
                self.assertNotIn('back_source', back)
                self.assertNotIn('back_reference', back)
                self.assertNotIn('images.image_2', back['back_body_encode']['inputs'])
                self.assertEqual(back['back_body_encode']['inputs']['prompt'], self.no_back['panels'][3]['single']['back_body_encode']['inputs']['prompt'])
            self.assertIn(prepared['outputs'][0]['nodeId'], manager.get(job['id'])['outputs'])
            manager.stop()

    def test_back_only_five_panels_and_missing_back_preserve_original_branch(self):
        shared = self.share(self.back_only)
        self.assertEqual([port['id'] for port in shared['nodes'][0]['definition']['inputs']], ['image_identity', 'image_back'])
        active = self.prepare(shared, {'image_identity': 'identity.png', 'image_back': 'back.png'})
        self.assertEqual(active['plan'], validate_plan(self.back_only))
        fallback = self.prepare(shared, {'image_identity': 'identity.png'})['plan']
        self.assertNotIn('referenceMode', fallback)
        self.assertEqual(len(fallback['panels']), 5)
        self.assertEqual(fallback['panels'][-1]['single'], self.back_only['panels'][-1]['withoutBackSingle'])

    def test_sampler_seed_and_model_edits_apply_to_both_back_branches(self):
        shared = self.share()
        definition = shared['nodes'][0]['definition']
        bindings = definition['bindings']
        changes = {}
        for node, field, value in (('back_body_sample', 'steps', 24), ('back_body_sample', 'seed', 987), ('model', 'unet_name', 'replacement.safetensors')):
            source = next(b['sourceId'] for b in bindings if b['nodeId'] == 'back_body__' + node and b['input'] == field)
            alternate = next(b['sourceId'] for b in bindings if b['nodeId'] == 'back_body_without_back__' + node and b['input'] == field)
            self.assertEqual(source, alternate)
            changes[source] = value
        for inputs in ({'image_identity': 'identity.png'}, {'image_identity': 'identity.png', 'image_back': 'back.png'}):
            back = self.prepare(shared, inputs, changes)['plan']['panels'][3]['single']
            self.assertEqual(back['back_body_sample']['inputs']['steps'], 24)
            self.assertEqual(back['back_body_sample']['inputs']['seed'], 987)
            self.assertEqual(back['model']['inputs']['unet_name'], 'replacement.safetensors')

    def test_invalid_alternative_roles_and_optional_back_fallback_rejected(self):
        mutations = [
            lambda p: p['panels'][3]['inputRoles'].update(back_source='body'),
            lambda p: p['panels'][3].pop('withoutBackSingle'),
            lambda p: p['panels'][0].update(withoutBackSingle={}),
            lambda p: p['panels'][3]['withoutBackSingle']['angle_source']['inputs'].update(image='private.png'),
            lambda p: p['panels'][3]['withoutBackSingle']['back_body_encode']['inputs'].update({'images.image_2': ['angle_source', 0]}),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(self.plan)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate_plan(invalid)
        chosen = flatten_plan(self.plan)
        mutations = [
            lambda d, w: d['inputs'][-1].update(fallback='image_identity'),
            lambda d, w: d['execution']['stages'][3].update(withoutBackNodeIds=['back_body__save']),
            lambda d, w: w['back_body_without_back__save']['inputs'].update(images=['back_body__back_body_decode', 0]),
            lambda d, w: d['outputs'][0].update(nodeId='back_body_without_back__save'),
            lambda d, w: next(b for b in d['bindings'] if b['nodeId'] == 'back_body_without_back__back_body_sample' and b['input'] == 'steps').update(sourceId='wrong'),
        ]
        for mutate in mutations:
            definition, workflow = copy.deepcopy(chosen['definition']), copy.deepcopy(chosen['workflow'])
            mutate(definition, workflow)
            with self.assertRaises(ExtensionError):
                validate_definition(definition, workflow, 'workflow')
        shared = self.share()
        for back in ('', None, '../bad.png'):
            with self.assertRaises(ExtensionError):
                self.prepare(shared, {'image_identity': 'identity.png', 'image_back': back})
