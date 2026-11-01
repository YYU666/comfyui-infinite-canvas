import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from extension_sharing import share_extension
from extension_dependencies import dependency_report
from extension_stages import flatten_plan
from outfit_queue import SHEET_PANELS, initial_state, stage_workflow
from test_outfit_queue import FakeOutfitAdapter
from test_workbench_queue import wait_for
from workbench_queue import QueueManager
from workflow_extensions import ExtensionError, ExtensionStore, validate_comfy, validate_definition


class StageAdapter(FakeOutfitAdapter):
    def submit(self, workflow, client_id):
        output = next(k for k, n in workflow.items() if n['class_type'] == 'SaveImage')
        prefix = workflow[output]['inputs']['filename_prefix'].split('/')[-1]
        prompt_id = f'prompt-{len(self.submitted) + 1}'
        final = prefix == 'H3_CharacterSheet'
        file = {'filename': prefix + '_00001_.png', 'subfolder': 'image', 'type': 'output',
                'metadata': {'width': 2304 if final else 1152, 'height': 4096 if final else 2048}}
        self.submitted.append({'id': prompt_id, 'workflow': workflow})
        self.results[prompt_id] = {output: {'images': [file]}}
        return prompt_id


class StagedExtensionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = """
          globalThis.window = {location: {hostname: '127.0.0.1'}};
          const {buildCharacterSheetQueuePlan} = await import('./src/workbench-api.js');
          console.log(JSON.stringify(buildCharacterSheetQueuePlan({prompt:'private character brief',seed:123,
            characterSheetAngleSeed:789, qwenReferenceCache:true,
            references:[{kind:'image',slot:'guide',name:'private-person.png'}]})));
        """
        cls.plan = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parent, text=True, encoding='utf-8'))
        cls.info = {}
        for graph in [p['single'] for p in cls.plan['panels']] + [cls.plan['stitch']]:
            for node in graph.values():
                fields = cls.info.setdefault(node['class_type'], {'input': {'required': {}}, 'output': ['*'] * 5})['input']['required']
                for key, value in node['inputs'].items():
                    fields[key] = ['*' if isinstance(value, list) else {str:'STRING', int:'INT', float:'FLOAT', bool:'BOOLEAN'}[type(value)]]

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name) / 'extensions')
        self.payload = {'plan': self.plan, 'name': '四视图', 'packageId': 'artist/sheet', 'version':'1.0.0', 'includePrompts':True}

    def shared(self):
        return share_extension(self.store, self.payload, self.info)

    def prepared(self, shared):
        return self.store.prepare(shared['digest'], {'nodeDefinitionId':'workflow','inputs':{'image_source':'new-source.png'}}, self.info)

    def test_roundtrip_preserves_stage_prompts_seeds_dependency_and_only_final_output(self):
        shared = self.shared()
        definition = shared['nodes'][0]['definition']
        self.assertEqual([p['id'] for p in definition['inputs']], ['image_source'])
        self.assertEqual(shared['manifest']['compatibility']['workbenchVersion'], '>=1.0.2')
        prepared = self.prepared(shared)
        self.assertNotIn('workflow', prepared)
        self.assertEqual(prepared['outputs'][0]['nodeId'], 'stitch__save')
        plan = prepared['plan']
        self.assertEqual([p['id'] for p in plan['panels']], list(SHEET_PANELS))
        self.assertEqual(plan['memoryPolicy'], 'preserve')
        for original, actual in zip(self.plan['panels'], plan['panels']):
            self.assertEqual([n['inputs']['prompt'] for n in original['single'].values() if 'prompt' in n['inputs']],
                             [n['inputs']['prompt'] for n in actual['single'].values() if 'prompt' in n['inputs']])
            self.assertEqual([n['inputs']['seed'] for n in original['single'].values() if 'seed' in n['inputs']],
                             [n['inputs']['seed'] for n in actual['single'].values() if 'seed' in n['inputs']])
        state = initial_state()
        state.update(panelIndex=1, images={'front_portrait':'saved-front.png'})
        angle = stage_workflow({'plan':plan, 'planState':state})
        self.assertEqual([n['inputs']['image'] for n in angle.values() if n['class_type']=='LoadImage'], ['saved-front.png'])
        self.assertEqual(len(shared['dependencyReport']['models']), 12)

    def test_serial_queue_roundtrip_runs_five_separate_graphs(self):
        prepared = self.prepared(self.shared())
        adapter = StageAdapter()
        manager = QueueManager(Path(self.temp.name)/'queue.json', adapter, poll_interval=0.01)
        self.addCleanup(manager.stop)
        job = manager.enqueue({'plan':prepared['plan'], 'projectId':'test', 'nodeId':'sheet', 'clientId':'test'})
        manager.start()
        wait_for(lambda: manager.get(job['id'])['status'] in ('done','error'))
        self.assertEqual(manager.get(job['id'])['status'], 'done')
        self.assertEqual(len(adapter.submitted), 5)
        self.assertEqual(adapter.free_calls, 0)
        self.assertEqual(len(adapter.uploads), 4)
        angle = adapter.submitted[1]['workflow']
        self.assertEqual([n['inputs']['image'] for n in angle.values() if n['class_type']=='LoadImage'], [adapter.uploads[0]['name']])
        self.assertIn(prepared['outputs'][0]['nodeId'], manager.get(job['id'])['outputs'])

    def test_explicit_text_consent_required_and_media_scrubbed(self):
        with self.assertRaisesRegex(ExtensionError, '勾选包含提示词'):
            share_extension(self.store, {**self.payload, 'includePrompts':False}, self.info)
        shared = self.shared()
        with zipfile.ZipFile(io.BytesIO(self.store.download(shared['digest']))) as archive:
            text = '\n'.join(archive.read(k).decode() for k in archive.namelist())
        self.assertNotIn('private-person.png', text)
        self.assertIn('private character brief', text)
        self.assertIn('__H3_CHARACTER_SHEET_PANEL_front_portrait__', text)
        payload = {k:v for k,v in self.payload.items() if k != 'plan'}
        payload.update(digest=shared['digest'], nodeDefinitionId='workflow')
        again = share_extension(self.store, payload, self.info)
        self.assertEqual(self.prepared(again)['plan'], self.prepared(shared)['plan'])
        with self.assertRaises(ExtensionError):
            share_extension(self.store, {**payload, 'includePrompts':False}, self.info)

    def test_tampered_stage_graph_bindings_prefixes_and_cross_links_rejected(self):
        chosen = flatten_plan(self.plan)
        for mutation in ('cross','prefix','internal_binding','output','coverage','extra_port'):
            definition, workflow = copy.deepcopy(chosen['definition']), copy.deepcopy(chosen['workflow'])
            if mutation == 'cross':
                workflow['stitch__save']['inputs']['images'] = ['front_portrait__save',0]
            elif mutation == 'prefix':
                workflow['stitch__save']['inputs']['filename_prefix'] = '../escape'
            elif mutation == 'internal_binding':
                definition['bindings'].append({'sourceKind':'input','sourceId':'image_source','nodeId':'three_quarter_portrait__angle_source','input':'image'})
            elif mutation == 'output':
                definition['outputs'][0]['nodeId'] = 'front_portrait__save'
            elif mutation == 'extra_port':
                definition['inputs'].append({'id':'image_second','type':'image','required':True})
                next(b for b in definition['bindings'] if b['nodeId']=='back_body__source')['sourceId'] = 'image_second'
            else:
                definition['execution']['stages'][0]['nodeIds'].pop()
            with self.subTest(mutation=mutation), self.assertRaises(ExtensionError):
                validate_definition(definition, workflow, 'workflow')

    def test_old_versions_rejected_and_secret_prompt_not_uploadable(self):
        shared = self.shared()
        with patch('workflow_extensions.APP_VERSION','1.0.1'), self.assertRaises(ExtensionError):
            self.store.get(shared['digest'])
        plan = copy.deepcopy(self.plan)
        node = next(n for n in plan['panels'][0]['single'].values() if 'prompt' in n['inputs'])
        node['inputs']['prompt'] = 'Bearer ' + 'x' * 32
        with self.assertRaises(ExtensionError):
            share_extension(self.store, {**self.payload, 'plan':plan}, self.info)

    def test_malformed_staged_outputs_return_validation_error(self):
        chosen = flatten_plan(self.plan)
        for value in (None, 1, {}, [None], [{'nodeId':[]}], [{'nodeId':{}}]):
            definition = {**chosen['definition'], 'outputs':value}
            with self.subTest(outputs=value), self.assertRaises(ExtensionError):
                validate_definition(definition, chosen['workflow'], 'workflow')

    def test_stage_model_replacement_and_missing_nodes_checked_before_queue(self):
        shared = self.shared()
        definition = shared['nodes'][0]['definition']
        binding = next(b for b in definition['bindings'] if b['nodeId']=='three_quarter_portrait__model' and b['input']=='unet_name')
        parameters = {binding['sourceId']:'replacement.safetensors'}
        report = dependency_report(shared, {'nodeDefinitionId':'workflow','parameters':parameters}, self.info, sources={})
        self.assertTrue(any(m['name']=='replacement.safetensors' and m['nodeId']=='three_quarter_portrait__model' for m in report['models']))
        prepared = self.store.prepare(shared['digest'], {'nodeDefinitionId':'workflow','inputs':{'image_source':'input.png'},'parameters':parameters}, self.info)
        self.assertEqual(prepared['plan']['panels'][1]['single']['three_quarter_portrait__model']['inputs']['unet_name'], 'replacement.safetensors')
        incomplete = copy.deepcopy(self.info)
        incomplete.pop('ImageStitch')
        with self.assertRaisesRegex(ExtensionError, '缺少节点'):
            self.store.prepare(shared['digest'], {'nodeDefinitionId':'workflow','inputs':{'image_source':'input.png'}}, incomplete)

    def test_v3_combo_stitch_options_are_validated_and_multiselect_rejected(self):
        info = copy.deepcopy(self.info)
        fields = info['ImageStitch']['input']['required']
        fields['direction'] = ['COMBO', {'options':['right','down','left','up'], 'multiselect':False}]
        fields['spacing_color'] = ['COMBO', {'options':['white','black','red','green','blue'], 'multiselect':False}]
        shared = share_extension(self.store, self.payload, info)
        request = {'nodeDefinitionId':'workflow', 'inputs':{'image_source':'input.png'}}
        self.store.prepare(shared['digest'], request, info)
        key = next(b['sourceId'] for b in shared['nodes'][0]['definition']['bindings'] if b['nodeId']=='stitch__top_row' and b['input']=='direction')
        with self.assertRaisesRegex(ExtensionError, '模型或选项未安装'):
            self.store.prepare(shared['digest'], {**request,'parameters':{key:'diagonal'}}, info)
        graph = self.store.prepare(shared['digest'], request, info)['plan']['stitch']
        graph['stitch__top_row']['inputs']['direction'] = ['stitch__front_portrait_load',0]
        with self.assertRaisesRegex(ExtensionError, '连接类型不匹配'):
            validate_comfy(graph, info)
        fields['direction'][1]['multiselect'] = True
        with self.assertRaisesRegex(ExtensionError, '多选 COMBO'):
            self.store.prepare(shared['digest'], request, info)

    def test_v3_combo_model_choices_support_dependency_candidates(self):
        shared = self.shared()
        info = copy.deepcopy(self.info)
        original = self.plan['panels'][0]['single']['model']['inputs']['unet_name']
        info['UNETLoader']['input']['required']['unet_name'] = ['COMBO', {'options':[original,'alternate.safetensors']}]
        report = dependency_report(shared, {'nodeDefinitionId':'workflow'}, info, sources={})
        models = [m for m in report['models'] if m['inputName']=='unet_name']
        self.assertEqual(len(models), 4)
        self.assertTrue(all(m['status']=='installed' and m['candidates'][0]['name']=='alternate.safetensors' for m in models))
        info['UNETLoader']['input']['required']['unet_name'][1]['options'] = []
        report = dependency_report(shared, {'nodeDefinitionId':'workflow'}, info, sources={})
        models = [m for m in report['models'] if m['inputName']=='unet_name']
        self.assertTrue(all(m['status']=='missing' and m['candidates']==[] for m in models))


if __name__ == '__main__':
    unittest.main()
