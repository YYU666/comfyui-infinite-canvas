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


class FidelitySheetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        script = """
          globalThis.window={location:{hostname:'127.0.0.1'}};
          const {buildCharacterSheetQueuePlan}=await import('./src/workbench-api.js');
          const cases=[];
          for(const body of [false,true])for(const back of [false,true])for(const crop of [false,true]){
            const options={characterSheetIdentityMode:'source-anchored-v1',prompt:'',seed:42,qwenSteps:40,qwenRefResolution:1536,qwenCacheDevice:'cpu',imageLora:'none',
              references:[{kind:'image',slot:'guide',name:'identity.png'},...(body?[{kind:'image',slot:'body_reference',name:'body.png'}]:[]),...(back?[{kind:'image',slot:'back_reference',name:'back.png'}]:[])],
              ...(crop?{characterSheetPortraitCrop:{x:20,y:10,width:600,height:700}}:{})};
            cases.push({body,back,crop,plan:buildCharacterSheetQueuePlan(options)});
          }
          console.log(JSON.stringify(cases));
        """
        cls.cases = json.loads(subprocess.check_output(['node','--input-type=module','-e',script],cwd=Path(__file__).resolve().parent,text=True,encoding='utf-8'))
        cls.info = {}
        for case in cls.cases:
            plan = case['plan']
            for graph in [p['single'] for p in plan['panels']] + [p['withoutBackSingle'] for p in plan['panels'] if 'withoutBackSingle' in p] + [plan['stitch']]:
                for node in graph.values():
                    fields = cls.info.setdefault(node['class_type'], {'input':{'required':{}},'output':['*']*5})['input']['required']
                    for field,value in node['inputs'].items():
                        fields[field] = ['*' if isinstance(value,list) else {str:'STRING',int:'INT',float:'FLOAT',bool:'BOOLEAN'}[type(value)]]
        for metadata in cls.info.values():
            fields = metadata['input']['required']
            if 'images.image_2' in fields:
                metadata['input']['optional'] = {'images.image_2':fields.pop('images.image_2')}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = ExtensionStore(Path(self.temp.name)/'extensions')

    def share(self, plan):
        return share_extension(self.store,{'plan':plan,'name':'原图身份锚定四视图','packageId':'artist/fidelity','version':'0.5.0','includePrompts':True},self.info)

    def test_eight_variants_export_prepare_keep_source_anchor_cover_and_optional_branches(self):
        for case in self.cases:
            with self.subTest(case={k:v for k,v in case.items() if k!='plan'}):
                shared = self.share(case['plan'])
                definition = shared['nodes'][0]['definition']
                self.assertEqual(definition['execution']['version'],5)
                imported = self.store.import_bytes(self.store.download(shared['digest']),'fidelity.h3pack')
                inputs = {'image_identity':'new-identity.png',**({'image_body':'new-body.png'} if case['body'] else {}),**({'image_back':'new-back.png'} if case['back'] else {})}
                prepared = self.store.prepare(imported['digest'],{'nodeDefinitionId':'workflow','inputs':inputs},self.info)
                expected = validate_plan(case['plan'])
                for panel in expected['panels']:
                    for key,role in panel['inputRoles'].items():
                        panel['single'][key]['inputs']['image'] = inputs['image_'+role]
                self.assertEqual(prepared['plan'],expected)
                for panel in prepared['plan']['panels'][:2]:
                    self.assertEqual(panel['single']['source']['inputs']['image'],'new-identity.png')
                    fit = panel['single']['portrait_reference']
                    self.assertEqual(fit['class_type'],'ImageScale')
                    self.assertEqual(fit['inputs']['crop'],'center')
                    self.assertNotIn('padding_color',fit['inputs'])
                fallback = self.store.prepare(imported['digest'],{'nodeDefinitionId':'workflow','inputs':{'image_identity':'only.png'}},self.info)['plan']
                self.assertEqual(fallback['fidelityMode'],'sourceAnchored')
                self.assertNotIn('back_source',fallback['panels'][3]['single'])
                for panel in fallback['panels']:
                    for key in panel['inputRoles']:
                        self.assertEqual(panel['single'][key]['inputs']['image'],'only.png')

    def test_queue_angle_loads_saved_front_and_original_not_a_second_front_edit(self):
        shared = self.share(self.cases[-1]['plan'])
        prepared = self.store.prepare(shared['digest'],{'nodeDefinitionId':'workflow','inputs':{'image_identity':'original.png'}},self.info)
        adapter = StageAdapter()
        manager = QueueManager(Path(self.temp.name)/'queue.json',adapter,poll_interval=0.01)
        self.addCleanup(manager.stop)
        job = manager.enqueue({'plan':prepared['plan'],'projectId':'test','nodeId':'fidelity','clientId':'test'})
        manager.start()
        wait_for(lambda: manager.get(job['id'])['status'] in ('done','error'))
        self.assertEqual(manager.get(job['id'])['status'],'done')
        self.assertEqual(len(adapter.submitted),5)
        angle = adapter.submitted[1]['workflow']
        self.assertEqual(angle['angle_source']['inputs']['image'],adapter.uploads[0]['name'])
        self.assertEqual(angle['source']['inputs']['image'],'original.png')
        self.assertEqual(angle['three_quarter_portrait_encode']['inputs']['images.image_1'],['angle_source',0])
        self.assertEqual(angle['three_quarter_portrait_encode']['inputs']['images.image_2'],['portrait_reference',0])
        self.assertEqual(adapter.free_calls,0)

    def test_reject_white_padding_swapped_roles_missing_original_and_legacy_reinterpretation(self):
        plan = self.cases[1]['plan']
        mutations = [
            lambda p:p.pop('fidelityMode'),
            lambda p:p.update(fidelityMode='unknown'),
            lambda p:p['panels'][0]['single']['portrait_reference'].update(class_type='ResizeAndPadImage'),
            lambda p:p['panels'][1]['single']['portrait_reference']['inputs'].update(crop='disabled'),
            lambda p:p['panels'][1]['single']['source']['inputs'].update(image='different.png'),
            lambda p:p['panels'][1]['inputRoles'].update(source='body'),
            lambda p:p['panels'][1]['single']['three_quarter_portrait_encode']['inputs'].update({'images.image_2':['angle_source',0]}),
            lambda p:p['panels'][0]['single']['portrait_crop']['inputs'].update(width=0),
            lambda p:p['panels'][1]['single']['portrait_reference']['inputs'].update(image=['angle_source',0]),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(plan)
            mutate(invalid)
            with self.assertRaises(ValueError):validate_plan(invalid)
        chosen = flatten_plan(plan)
        definition = copy.deepcopy(chosen['definition'])
        definition['execution']['version'] = 4
        with self.assertRaises(ExtensionError):validate_definition(definition,chosen['workflow'],'workflow')
