from contextlib import ExitStack
import importlib
import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock

from project_store import StoreError
from video_job_submission import VIDEO_JOB_FIELDS


class VideoSubmissionAdmissionTests(TestCase):
    def test_saved_intent_is_required_and_same_receipt_replays_with_no_work(self):
        cases = (
            ('edit', 'Edit', 'videoEdit', 'ved', {'inputs': {'v1': 'synthetic'}, 'document': {}}),
            ('rhythm', 'Rhythm', 'videoSpeed', 'vry', {'operation': 'speed', 'input': 'synthetic', 'settings': {}}),
            ('rhythm', 'Rhythm', 'videoTimeRemap', 'vry', {'operation': 'remap', 'input': 'synthetic', 'settings': {}}),
            ('chroma', 'Chroma', 'videoChromaKey', 'vck', {'foreground': 'fg', 'background': 'bg', 'settings': {}}),
            ('plate', 'Plate', 'videoWhitePlate', 'vwp', {'video': 'synthetic', 'settings': {}}),
            ('repair', 'Repair', 'videoLocalRepair', 'vrp', {'source': 'synthetic', 'settings': {}}),
        )
        for feature, name, node_type, prefix, fields in cases:
            module_name = f'video_{feature}_jobs'
            if importlib.util.find_spec(module_name) is None:
                continue
            with self.subTest(feature=feature), TemporaryDirectory() as directory, ExitStack() as stack:
                module = importlib.import_module(module_name)
                store = mock.Mock()
                node = {'id': 'edit', 'type': node_type, 'data': {}}
                store.get.return_value = {'canvas': {'nodes': [node]}}
                manager = getattr(module, f'Video{name}Jobs')(directory, store)
                request_id = '3' * 32
                expected = f'{prefix}_{request_id}'
                intent = {'projectId': 'prj_fixture', 'nodeId': 'edit', **fields}
                payload = {**intent, 'requestId': request_id}
                if feature == 'repair':
                    stack.enter_context(mock.patch.object(manager, '_request', return_value=({}, Path('synthetic'), {})))
                    stack.enter_context(mock.patch.object(manager, '_capacity'))
                    executor = stack.enter_context(mock.patch.object(manager.pool, 'submit'))
                else:
                    if feature == 'edit':
                        stack.enter_context(mock.patch.object(module, 'normalize_document', return_value={
                            'clips': [{'inputSlot': 'v1'}], 'outputProfile': {'audio': 'clips'},
                        }))
                    elif feature == 'rhythm':
                        stack.enter_context(mock.patch.object(manager, '_document', return_value={'operation': fields['operation']}))
                    else:
                        stack.enter_context(mock.patch.object(manager, '_settings', return_value={}))
                    if feature == 'chroma':
                        stack.enter_context(mock.patch.object(manager, '_sources', return_value=(Path('fg'), Path('bg'), True)))
                    else:
                        stack.enter_context(mock.patch.object(manager, '_asset', return_value=Path('synthetic')))
                    executor = stack.enter_context(mock.patch.object(module.threading, 'Thread'))
                with self.assertRaises(StoreError) as legacy:
                    manager.submit(intent)
                self.assertEqual(legacy.exception.code, 'VIDEO_PREPARATION_REQUIRED')
                with self.assertRaises(StoreError) as unprepared:
                    manager.submit(payload)
                self.assertEqual(unprepared.exception.code, 'VIDEO_PREPARATION_REQUIRED')
                executor.assert_not_called()
                self.assertEqual(manager.jobs, {})
                node['data']['videoSubmission'] = {'id': expected, 'phase': 'prepared', 'intent': intent, 'requestId': request_id}
                with self.assertRaises(StoreError) as no_visible_id:
                    manager.submit(payload)
                self.assertEqual(no_visible_id.exception.code, 'VIDEO_PREPARATION_REQUIRED')
                node['data'][VIDEO_JOB_FIELDS[prefix]] = expected
                page = {"epoch": "original", "sessionId": "saved-page"}
                node['data']['videoSubmission']['page'] = page
                with self.assertRaises(StoreError) as mismatched_page:
                    manager.submit(payload, page={**page, "sessionId": "other-page"})
                self.assertEqual(mismatched_page.exception.code, 'VIDEO_PREPARATION_REQUIRED')
                accepted = manager.submit(payload, page=page)
                self.assertEqual(accepted['id'], expected)
                self.assertEqual(accepted['projectId'], 'prj_fixture')
                self.assertNotIn('_submission', accepted)
                self.assertEqual(manager.submit(payload), accepted)
                self.assertEqual(manager.get(expected), accepted)
                executor.assert_called_once()
                updated = {**payload, 'nodeId': 'another'}
                with self.assertRaises(StoreError) as conflict:
                    manager.submit(updated)
                self.assertEqual(conflict.exception.code, 'VIDEO_SUBMISSION_CONFLICT')
                self.assertEqual(list(manager.jobs), [expected])
