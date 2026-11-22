import copy
import json
import queue
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

from outfit_queue import SHEET_PANELS, SHEET_STABLE_PANELS, SHEET_PREP_PANELS, SHEET_PANEL_INPUT, initial_state, stage_transfer, stage_workflow, validate_plan, sheet_stage_label
from test_outfit_queue import FakeOutfitAdapter
from test_workbench_queue import wait_for
from workbench_queue import QueueManager


class SheetAdapter(FakeOutfitAdapter):
    def __init__(self):
        super().__init__()
        self.completed = 0
        self.failed = None
        self.cancelled = []
        self.active = set()
        self.maximum = 0
        self.download_started = threading.Event()
        self.release_download = threading.Event()
        self.block_download = False
        self.bad_size = False

    def submit(self, workflow, client_id):
        prompt = super().submit(workflow, client_id)
        self.active.add(prompt)
        self.maximum = max(self.maximum, len(self.active))
        file = self.results[prompt]['save']['images'][0]
        final = workflow['save']['inputs']['filename_prefix'] == 'image/H3_CharacterSheet'
        width, height = (2304, 4096) if final else (1152, 2048)
        file['metadata'].update(width=1 if self.bad_size else width, height=height)
        return prompt

    def poll(self, prompt_id):
        number = int(prompt_id.split('-')[-1])
        if number == self.failed:
            self.active.discard(prompt_id)
            return {'status': 'error', 'error': {'message': 'sampling failed'}}
        if number > self.completed:
            return {'status': 'running', 'progress': 40}
        self.active.discard(prompt_id)
        return super().poll(prompt_id)

    def download(self, file):
        self.download_started.set()
        if self.block_download:
            if not self.release_download.wait(3):
                raise TimeoutError('test transfer was not released')
        return super().download(file)

    def cancel(self, prompt_id):
        self.cancelled.append(prompt_id)
        self.active.discard(prompt_id)


class CharacterSheetQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Exercise the actual browser plan contract, not a separate Python mock.
        script = """
          globalThis.window = {location: {hostname: '127.0.0.1'}};
          const {buildCharacterSheetQueuePlan} = await import('./src/workbench-api.js');
          console.log(JSON.stringify(buildCharacterSheetQueuePlan({prompt:'male test', seed:281306,
            qwenSteps:40, qwenRefResolution:1536, references:[{kind:'image',slot:'guide',name:'male.png'}]})));
        """
        cls.plan = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], cwd=Path(__file__).resolve().parent, text=True, encoding='utf-8'))
        cls.browser_plan = copy.deepcopy(cls.plan)
        prep_script = "import {CHARACTER_SHEET_RECIPE_VERSION} from './src/character-sheet-recipe.js';\n" + script.replace(
            "{prompt:'male test'", "{characterSheetRecipeVersion:CHARACTER_SHEET_RECIPE_VERSION,characterSheetPortraitCrop:{x:0,y:0,width:512,height:512},prompt:'male test'")
        cls.prepared_browser_plan = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', prep_script], cwd=Path(__file__).resolve().parent, text=True, encoding='utf-8'))
        # Keep legacy four-panel queue regression coverage when browser defaults evolve.
        if cls.plan['panels'][0]['id'] == 'portrait_reference':
            cls.plan['panels'].pop(0)
            cls.plan['panels'][0]['dependsOn'] = []
            for node in cls.plan['panels'][0]['single'].values():
                if node['class_type'] == 'LoadImage':
                    node['inputs']['image'] = 'male.png'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'queue.json'
        self.adapter = SheetAdapter()
        self.manager = QueueManager(self.path, self.adapter, poll_interval=0.01)

    def tearDown(self):
        self.adapter.release_download.set()
        self.manager.stop()
        self.temp.cleanup()

    def start_job(self):
        job = self.manager.enqueue({'plan': self.plan, 'projectId': 'test', 'nodeId': 'sheet', 'clientId': 'test-sheet'})
        self.manager.start()
        wait_for(lambda: len(self.adapter.submitted) >= 1)
        return job['id']

    def test_sequential_inputs_outputs_persistence_and_final_completion(self):
        listener = self.manager.subscribe()
        job_id = self.start_job()
        for count in range(1, 5):
            self.adapter.completed = count
            wait_for(lambda: len(self.adapter.submitted) == count + 1)
            job = self.manager.get(job_id)
            self.assertEqual(job['status'], 'running')
            self.assertLess(job['progress'], 100)
            self.assertIsNone(job['history'])
            self.assertEqual(len(job['planState']['images']), count)
            stored = json.loads(self.path.read_text(encoding='utf-8'))['jobs'][0]
            self.assertEqual(len(stored['planState']['panelOutputs']), count)
        angle = self.adapter.submitted[1]['workflow']
        self.assertEqual(angle['angle_source']['inputs']['image'], 'workbench/H3_CharacterSheetPanel_front_portrait_00001_.png')
        stitch = self.adapter.submitted[-1]['workflow']
        for panel in SHEET_PANELS:
            self.assertEqual(stitch[f'{panel}_load']['inputs']['image'], f'workbench/H3_CharacterSheetPanel_{panel}_00001_.png')
        self.adapter.completed = 5
        wait_for(lambda: self.manager.get(job_id)['status'] == 'done')
        job = self.manager.get(job_id)
        self.assertEqual(job['comfyPromptId'], 'prompt-5')
        self.assertEqual(job['progress'], 100)
        self.assertEqual(job['planState']['promptIds'], [f'prompt-{i}' for i in range(1, 6)])
        self.assertEqual(job['history']['outputs']['save']['images'][0]['filename'], 'H3_CharacterSheet_00001_.png')
        self.assertEqual(self.adapter.maximum, 1)
        self.assertEqual(self.adapter.free_calls, 0)
        self.assertEqual(len(self.adapter.uploads), 4)
        events = []
        while True:
            try:
                events.append(listener.get_nowait())
            except queue.Empty:
                break
        done = [event for event in events if event['job'] and event['job']['status'] == 'done']
        self.assertEqual(len(done), 1)
        self.assertEqual(done[0]['job']['comfyPromptId'], 'prompt-5')
        self.assertTrue(all(event['job']['progress'] < 100 for event in events if event['job'] and event['job']['status'] != 'done'))
        progress = [event['job']['progress'] for event in events if event['job']]
        self.assertEqual(progress, sorted(progress))

    def test_restart_after_saved_front_keeps_dependency_without_duplicate(self):
        job_id = self.start_job()
        self.adapter.completed = 1
        wait_for(lambda: len(self.adapter.submitted) == 2)
        self.manager.stop()
        self.manager = QueueManager(self.path, self.adapter, poll_interval=0.01)
        self.adapter.completed = 5
        self.manager.start()
        wait_for(lambda: self.manager.get(job_id)['status'] == 'done')
        self.assertEqual(len(self.adapter.submitted), 5)
        self.assertEqual(self.adapter.maximum, 1)
        self.assertEqual(len(self.manager.get(job_id)['planState']['panelOutputs']), 4)

    def test_cancel_during_sampling_stops_chain(self):
        job_id = self.start_job()
        self.manager.cancel(job_id)
        self.adapter.completed = 5
        self.manager.stop()
        self.assertEqual(self.manager.get(job_id)['status'], 'cancelled')
        self.assertEqual(self.adapter.cancelled, ['prompt-1'])
        self.assertEqual(len(self.adapter.submitted), 1)

    def test_cancel_during_transfer_cannot_submit_next_panel(self):
        self.adapter.block_download = True
        self.adapter.completed = 5
        job_id = self.start_job()
        self.assertTrue(self.adapter.download_started.wait(2))
        self.manager.cancel(job_id)
        self.adapter.release_download.set()
        self.manager.stop()
        self.assertEqual(self.manager.get(job_id)['status'], 'cancelled')
        self.assertEqual(len(self.adapter.submitted), 1)

    def test_sampling_failure_retains_prior_panel_and_stops_chain(self):
        self.adapter.failed = 2
        self.adapter.completed = 5
        job_id = self.start_job()
        wait_for(lambda: self.manager.get(job_id)['status'] == 'error')
        self.assertEqual(len(self.adapter.submitted), 2)
        self.assertEqual(list(self.manager.get(job_id)['planState']['images']), ['front_portrait'])

    def test_bad_output_dimensions_fail_instead_of_advancing(self):
        self.adapter.bad_size = True
        self.adapter.completed = 5
        job_id = self.start_job()
        wait_for(lambda: self.manager.get(job_id)['status'] == 'error')
        self.assertEqual(self.manager.get(job_id)['error']['code'], 'CHARACTER_SHEET_STAGE_FAILED')
        self.assertEqual(len(self.adapter.submitted), 1)
        self.assertEqual(self.adapter.uploads, [])

    def test_manual_retry_restarts_whole_plan_with_same_recipe(self):
        self.adapter.failed = 2
        self.adapter.completed = 5
        job_id = self.start_job()
        wait_for(lambda: self.manager.get(job_id)['status'] == 'error')
        self.manager.stop()
        prior = self.manager.get(job_id)
        self.assertEqual(len(prior['planState']['images']), 1)
        retried = self.manager.retry(job_id)
        self.assertEqual(retried['planState'], initial_state())
        self.assertEqual(retried['attempts'], 2)
        self.adapter.failed = None
        self.adapter.completed = 7
        self.manager.start()
        wait_for(lambda: self.manager.get(job_id)['status'] == 'done')
        self.assertEqual(len(self.adapter.submitted), 7)
        self.assertEqual(self.adapter.submitted[2]['workflow'], self.adapter.submitted[0]['workflow'])
        self.assertEqual(self.manager.get(job_id)['planState']['promptIds'], [f'prompt-{i}' for i in range(3, 8)])

    def test_missing_output_fails_instead_of_advancing(self):
        job_id = self.start_job()
        self.adapter.results['prompt-1'] = {}
        self.adapter.completed = 5
        wait_for(lambda: self.manager.get(job_id)['status'] == 'error')
        self.assertEqual(len(self.adapter.submitted), 1)

    def test_missing_final_output_never_completes(self):
        job_id = self.start_job()
        self.adapter.completed = 4
        wait_for(lambda: len(self.adapter.submitted) == 5)
        self.adapter.results['prompt-5'] = {}
        self.adapter.completed = 5
        wait_for(lambda: self.manager.get(job_id)['status'] == 'error')
        self.assertEqual(len(self.manager.get(job_id)['planState']['panelOutputs']), 4)
        self.assertLess(self.manager.get(job_id)['progress'], 100)

    def test_plan_validation_and_missing_dependencies(self):
        normalized = validate_plan(self.plan)
        self.assertEqual(normalized['memoryPolicy'], 'preserve')
        mutations = [
            lambda plan: plan['panels'].reverse(),
            lambda plan: plan['panels'][1].update(dependsOn=[]),
            lambda plan: plan['panels'][1]['single']['angle_source']['inputs'].update(image='original.png'),
            lambda plan: plan['stitch']['front_body_load']['inputs'].update(image='original.png'),
            lambda plan: plan['stitch'].update(extra={'class_type': 'KSampler', 'inputs': {}}),
            lambda plan: plan.update(memoryPolicy='unload'),
            lambda plan: plan['panels'][0]['single']['save']['inputs'].update(filename_prefix='wrong'),
            lambda plan: plan['stitch']['front_body_load'].update(inputs=None),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(self.plan)
            mutate(candidate)
            with self.assertRaises(ValueError):
                validate_plan(candidate)
        for state in [{**initial_state(), 'panelIndex': 1}, {**initial_state(), 'phase': 'stitch'}]:
            with self.assertRaisesRegex(ValueError, '依赖图片'):
                stage_workflow({'plan': normalized, 'planState': state})

    def plan_for_order(self, order):
        # Model persisted legacy plans independently of the current browser default.
        panels = {panel['id']: copy.deepcopy(panel) for panel in self.plan['panels']}
        back = panels['back_body']
        stable = order == SHEET_STABLE_PANELS
        back['dependsOn'] = ['front_body'] if stable else []
        for node in back['single'].values():
            if node['class_type'] == 'LoadImage':
                node['inputs']['image'] = SHEET_PANEL_INPUT.format(panel_id='front_body') if stable else 'male.png'
        return {**copy.deepcopy(self.plan), 'panels': [panels[key] for key in order]}

    def test_delivery_crop_is_validated_and_legacy_stitch_is_accepted(self):
        validate_plan(self.plan)
        legacy = copy.deepcopy(self.plan)
        for key in ("front_body", "back_body"):
            del legacy["stitch"][f"{key}_delivery_crop"]
            del legacy["stitch"][f"{key}_delivery_pad"]
        legacy["stitch"]["bottom_row"]["inputs"].update(image1=["back_body_load", 0], image2=["front_body_load", 0])
        validate_plan(legacy)
        mutations = [
            lambda p: p["stitch"]["front_body_delivery_crop"]["inputs"].update(image=["front_portrait_load", 0]),
            lambda p: p["stitch"]["front_body_delivery_crop"]["inputs"].update(x=-1),
            lambda p: p["stitch"]["front_body_delivery_crop"]["inputs"].update(width=1153),
            lambda p: p["stitch"]["front_body_delivery_crop"]["inputs"].update(y=True),
            lambda p: p["stitch"]["front_body_delivery_pad"]["inputs"].update(target_width=1000),
            lambda p: p["stitch"]["top_row"]["inputs"].update(image1=["front_body_delivery_pad", 0]),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(self.plan)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate_plan(invalid)

    def test_legacy_and_stable_orders_transfer_correct_panel_identities(self):
        for order in (SHEET_PANELS, SHEET_STABLE_PANELS):
            with self.subTest(order=order):
                plan = validate_plan(self.plan_for_order(order))
                state = initial_state()
                adapter = SheetAdapter()
                for index, panel_id in enumerate(order):
                    job = {'plan': plan, 'planState': state}
                    workflow = stage_workflow(job)
                    if panel_id == 'three_quarter_portrait' or (order == SHEET_STABLE_PANELS and panel_id == 'back_body'):
                        source = 'front_portrait' if panel_id == 'three_quarter_portrait' else 'front_body'
                        self.assertEqual([node['inputs']['image'] for node in workflow.values() if node['class_type'] == 'LoadImage'],
                                         [state['images'][source]])
                    prompt = adapter.submit(workflow, 'test')
                    job['outputs'] = adapter.results[prompt]
                    state = stage_transfer(job, adapter)['planState']
                    self.assertEqual(list(state['images']), list(order[:index + 1]))
                    self.assertEqual(state['panelOutputs'][panel_id]['filename'], f'H3_CharacterSheetPanel_{panel_id}_00001_.png')
                    # Persist/reload after every transfer, including before back-body.
                    state = json.loads(json.dumps(state))
                self.assertEqual(state['phase'], 'stitch')
                job = {'plan': plan, 'planState': state}
                prompt = adapter.submit(stage_workflow(job), 'test')
                job['outputs'] = adapter.results[prompt]
                self.assertEqual(stage_transfer(job, adapter)['status'], 'done')
                self.assertEqual(adapter.free_calls, 0)

    def test_stable_back_dependency_and_placeholder_are_strict(self):
        plan = self.plan_for_order(SHEET_STABLE_PANELS)
        back = plan['panels'][3]
        source_id = next(key for key, node in back['single'].items() if node['class_type'] == 'LoadImage')
        mutations = [
            lambda p: p['panels'][3].update(dependsOn=[]),
            lambda p: p['panels'][3].update(dependsOn=['front_portrait']),
            lambda p: p['panels'][3]['single'][source_id]['inputs'].update(image='male.png'),
            lambda p: p['panels'][3]['single'][source_id]['inputs'].update(image=SHEET_PANEL_INPUT.format(panel_id='front_portrait')),
            lambda p: p['panels'][3]['single'].update(extra={'class_type': 'LoadImage', 'inputs': {'image': 'male.png'}}),
        ]
        for mutate in mutations:
            candidate = copy.deepcopy(plan)
            mutate(candidate)
            with self.assertRaises(ValueError):
                validate_plan(candidate)
        with self.assertRaisesRegex(ValueError, '依赖图片'):
            stage_workflow({'plan': validate_plan(plan), 'planState': {**initial_state(), 'panelIndex': 3, 'images': {'front_portrait': 'portrait.png'}}})
        legacy = self.plan_for_order(SHEET_PANELS)
        legacy['panels'][2]['dependsOn'] = ['front_body']
        with self.assertRaises(ValueError):
            validate_plan(legacy)

    def prep_plan(self):
        return copy.deepcopy(self.prepared_browser_plan)

    def test_prep_restart_and_six_stage_inspection(self):
        self.plan = self.prep_plan()
        self.assertEqual(tuple(panel['id'] for panel in validate_plan(self.plan)['panels']), SHEET_PREP_PANELS)
        self.assertIn('预处理', sheet_stage_label(initial_state(), self.plan))
        self.assertIn('1/4', sheet_stage_label({**initial_state(), 'panelIndex': 1}, self.plan))
        self.assertIn('4/4', sheet_stage_label({**initial_state(), 'panelIndex': 4}, self.plan))
        job_id = self.start_job()
        self.adapter.completed = 1
        wait_for(lambda: len(self.adapter.submitted) == 2)
        self.manager.stop()
        self.assertEqual(list(self.manager.get(job_id)['planState']['images']), ['portrait_reference'])
        self.manager = QueueManager(self.path, self.adapter, poll_interval=0.01)
        self.adapter.completed = 6
        self.manager.start()
        wait_for(lambda: self.manager.get(job_id)['status'] == 'done')
        self.assertEqual(len(self.adapter.submitted), 6, 'restart cannot resubmit saved preprocessing')
        for index, dependency in ((1, 'portrait_reference'), (2, 'front_portrait'), (4, 'front_body')):
            loads = [node['inputs']['image'] for node in self.adapter.submitted[index]['workflow'].values() if node['class_type'] == 'LoadImage']
            self.assertEqual(loads, [f'workbench/H3_CharacterSheetPanel_{dependency}_00001_.png'])
        job = self.manager.get(job_id)
        self.assertEqual(list(job['planState']['images']), list(SHEET_PREP_PANELS))
        self.assertEqual(len(job['planState']['panelOutputs']), 5)
        self.assertEqual(self.adapter.free_calls, 0)
        inspection = self.manager.inspect_workflow(project_id='test', node_id='sheet', job_id=job_id)
        self.assertEqual([stage['id'] for stage in inspection['stages']], [*SHEET_PREP_PANELS, 'stitch'])
        self.assertEqual(inspection['stages'][-1]['promptId'], 'prompt-6')
        self.assertTrue(inspection['stages'][-1]['executed'])

    def test_prep_rejects_non_deterministic_invalid_dag_and_bad_crop(self):
        plan = self.prep_plan()
        mutations = [
            lambda p: p['panels'][0]['single'].update(model={'class_type': 'KSampler', 'inputs': {}}),
            lambda p: p['panels'][0]['single']['crop'].update(class_type='KSampler'),
            lambda p: p['panels'][0]['single']['crop']['inputs'].update(image=['pad', 0]),
            lambda p: p['panels'][0]['single']['crop']['inputs'].update(x=-1),
            lambda p: p['panels'][0]['single']['crop']['inputs'].update(width=0),
            lambda p: p['panels'][0]['single']['crop']['inputs'].update(height=True),
            lambda p: p['panels'][0]['single']['crop']['inputs'].update(x=16384),
            lambda p: p['panels'][0]['single']['pad']['inputs'].update(target_height=1024),
            lambda p: p['panels'][0]['single']['save']['inputs'].update(images=['crop', 0]),
            lambda p: p['panels'][0]['single']['source']['inputs'].update(image='../secret.png'),
            lambda p: p['panels'][0]['single']['source']['inputs'].update(image='__H3_CHARACTER_SHEET_PANEL_front_body__'),
            lambda p: p['panels'][1].update(dependsOn=[]),
        ]
        for mutate in mutations:
            invalid = copy.deepcopy(plan)
            mutate(invalid)
            with self.assertRaises(ValueError):
                validate_plan(invalid)
        with self.assertRaisesRegex(ValueError, '依赖图片'):
            stage_workflow({'plan': validate_plan(plan), 'planState': {**initial_state(), 'panelIndex': 1}})


if __name__ == '__main__':
    unittest.main()
