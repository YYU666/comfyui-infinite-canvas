"""Synthetic role/fallback contracts; no canvas, services or source images."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from extension_sharing import share_extension
from workflow_extensions import ExtensionStore


class GenericCharacterSheetTests(unittest.TestCase):
    def test_dual_back_staged_roundtrip_and_optional_fallback(self):
        script = """
          const {buildCharacterSheetQueuePlan} = await import('./src/workbench-api.js');
          console.log(JSON.stringify(buildCharacterSheetQueuePlan({seed:7,
            characterSheetIdentityMode:'source-anchored-v1',references:[
              {kind:'image',slot:'guide',name:'identity.png'},
              {kind:'image',slot:'body_reference',name:'body.png'},
              {kind:'image',slot:'back_reference',name:'rear.png'}]})));
        """
        plan = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script],
                          cwd=Path(__file__).resolve().parent, text=True, encoding='utf-8'))
        graphs = [p['single'] for p in plan['panels']] + [plan['stitch']]
        graphs.extend(p['withoutBackSingle'] for p in plan['panels'] if 'withoutBackSingle' in p)
        info = {}
        for graph in graphs:
            for node in graph.values():
                fields = info.setdefault(node['class_type'], {'input': {'required': {}}, 'output': ['*'] * 5})['input']['required']
                for key, value in node['inputs'].items():
                    fields[key] = ['*' if isinstance(value, list) else
                                   {str: 'STRING', int: 'INT', float: 'FLOAT', bool: 'BOOLEAN'}[type(value)]]
        encoder = info['TextEncodeQwenImage21']['input']
        encoder['optional'] = {'images.image_2': encoder['required'].pop('images.image_2')}
        with tempfile.TemporaryDirectory() as directory:
            store = ExtensionStore(Path(directory) / 'extensions')
            shared = share_extension(store, {'plan': plan, 'name': 'Generic character sheet',
                                     'packageId': 'example/generic-sheet', 'version': '1.0.0',
                                     'includePrompts': True}, info)
            definition = shared['nodes'][0]['definition']
            self.assertEqual(definition['execution']['version'], 5)
            self.assertEqual([p['id'] for p in definition['inputs']], ['image_identity', 'image_body', 'image_back'])
            prepared = store.prepare(shared['digest'], {'nodeDefinitionId': 'workflow', 'inputs': {
                'image_identity': 'new-id.png', 'image_body': 'new-body.png', 'image_back': 'new-rear.png'}}, info)
            self.assertEqual(prepared['outputs'][0]['nodeId'], 'save')
            self.assertEqual(prepared['plan']['referenceMode'], 'identityBodyBack')
            fallback = store.prepare(shared['digest'], {'nodeDefinitionId': 'workflow',
                                     'inputs': {'image_identity': 'new-id.png'}}, info)['plan']
            self.assertEqual(fallback['referenceMode'], 'identityBody')
            self.assertEqual(fallback['panels'][2]['single']['body_source']['inputs']['image'], 'new-id.png')
            self.assertNotIn('back_source', fallback['panels'][3]['single'])
            self.assertEqual(fallback['stitch']['front_body_delivery_crop']['class_type'], 'ImageCrop')
            self.assertEqual(fallback['stitch']['back_body_delivery_crop']['class_type'], 'ImageCrop')


if __name__ == '__main__':
    unittest.main()
