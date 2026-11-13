import unittest

from canvas_page_bridge import CanvasPageBridge
from project_store import StoreError


class CanvasPageBridgeTests(unittest.TestCase):
    def setUp(self):
        self.time = 0
        self.bridge = CanvasPageBridge(now=lambda: self.time, ttl=10, capacity=3)
        self.page = {"sessionId": "page_one", "projectId": "prj_one", "visible": True, "busy": False}

    def submit(self, op="op_one", **extra):
        payload = {**self.bridge.current("prj_one"), "opId": op, "tool": "canvas_generate_node", "args": {"nodeId": "g1", "wait": False}}
        return self.bridge.submit({**payload, **extra})

    def assert_code(self, code, callback):
        with self.assertRaises(StoreError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_no_page_hidden_ambiguous_and_project_binding(self):
        self.assert_code("NO_VISIBLE_CANVAS", self.bridge.current)
        self.bridge.heartbeat({**self.page, "visible": False})
        self.assert_code("NO_VISIBLE_CANVAS", self.bridge.current)
        self.bridge.heartbeat(self.page)
        self.assertEqual(self.bridge.current()["projectId"], "prj_one")
        self.assert_code("NO_VISIBLE_CANVAS", lambda: self.bridge.current("prj_other"))
        self.bridge.heartbeat({**self.page, "sessionId": "page_two"})
        self.assert_code("AMBIGUOUS_CANVAS", self.bridge.current)
        self.assert_code("CANVAS_SESSION_CHANGED", lambda: self.bridge.heartbeat({**self.page, "projectId": "prj_other"}))
        self.bridge.release({"sessionId": "page_two"})
        self.assertEqual(self.bridge.current()["sessionId"], "page_one")

    def test_dedup_never_redelivers_dispatched_generate(self):
        self.bridge.heartbeat(self.page)
        self.assertEqual(self.submit()["status"], "queued")
        self.assertEqual(self.submit()["status"], "queued")
        self.assertIsNone(self.bridge.heartbeat({**self.page, "busy": True})["command"])
        dispatched = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual(dispatched["opId"], "op_one")
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        self.assertEqual(self.submit()["status"], "dispatched")
        self.assert_code("CANVAS_OP_CONFLICT", lambda: self.submit(args={"nodeId": "another"}))
        self.time = 11
        self.assertEqual(self.bridge.get("op_one")["status"], "unknown")
        self.bridge.heartbeat(self.page)
        self.assertEqual(self.submit()["status"], "unknown")
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        result = {**dispatched, "result": {"ok": True, "node": {"queueJobId": "job_one"}}}
        self.assert_code("CANVAS_SESSION_CHANGED", lambda: self.bridge.complete({**result, "sessionId": "wrong"}))
        self.assertEqual(self.bridge.complete(result)["result"]["node"]["queueJobId"], "job_one")
        self.assertEqual(self.bridge.complete(result)["status"], "done")
        self.assert_code("CANVAS_OP_CONFLICT", lambda: self.bridge.complete({**result, "result": {"ok": False}}))

    def test_expiry_epoch_bounds_and_tools(self):
        self.bridge.heartbeat(self.page)
        self.submit()
        self.time = 11
        self.assertEqual(self.bridge.get("op_one")["status"], "expired")
        self.bridge.heartbeat(self.page)
        self.assert_code("CANVAS_EPOCH_CHANGED", lambda: self.submit(epoch="old_instance"))
        self.assert_code("BAD_REQUEST", lambda: self.submit("bad_tool", tool="evaluate_javascript"))
        self.assert_code("BAD_REQUEST", lambda: self.submit("bad_wait", args={"nodeId": "g1", "wait": True}))
        self.assert_code("BAD_REQUEST", lambda: self.submit("too_big", args={"nodeId": "g1", "prompt": "x" * 33000}))
        self.submit("op_two")
        self.submit("op_three")
        self.assert_code("CANVAS_CAPACITY", lambda: self.submit("op_four"))
        self.assertEqual(self.submit()["status"], "expired", 'capacity must not destroy dedup history')

    def test_launcher_can_create_or_open_projects_but_cannot_generate(self):
        page = {**self.page, "projectId": "launcher"}
        self.bridge.heartbeat(page)
        active = self.bridge.current()
        self.assertEqual(active["projectId"], "launcher")
        request = {**active, "opId": "create_project", "tool": "canvas_create_project", "args": {"name": "Comparison"}}
        self.assertEqual(self.bridge.submit(request)["status"], "queued")
        command = self.bridge.heartbeat(page)["command"]
        self.assertEqual(command["tool"], "canvas_create_project")
        self.bridge.complete({**command, "result": {"ok": True, "project": {"id": "prj_new"}}})
        self.assertEqual(self.bridge.submit(request)["status"], "done")
        self.assert_code("BAD_REQUEST", lambda: self.bridge.submit({**active, "opId": "not_a_canvas",
                         "tool": "canvas_generate_node", "args": {"nodeId": "g1", "wait": False}}))
        self.assert_code("BAD_REQUEST", lambda: self.bridge.heartbeat({**page, "sessionId": "bad_page", "projectId": "other"}))

    def test_open_project_command_stays_bound_to_original_page(self):
        self.bridge.heartbeat(self.page)
        request = {**self.bridge.current(), "opId": "open_project", "tool": "canvas_open_project", "args": {"projectId": "prj_two"}}
        self.bridge.submit(request)
        command = self.bridge.heartbeat(self.page)["command"]
        self.assert_code("CANVAS_SESSION_CHANGED", lambda: self.bridge.complete({**command,
                         "projectId": "prj_two", "result": {"ok": True}}))
        self.assertEqual(self.bridge.complete({**command, "result": {"ok": True}})["status"], "done")

    def test_reference_library_dispatches_without_claiming_remote_load(self):
        self.bridge.heartbeat(self.page)
        self.submit('gallery', tool='canvas_open_reference_library', args={'library': 'pose'})
        command = self.bridge.heartbeat(self.page)['command']
        self.assertEqual(command['tool'], 'canvas_open_reference_library')
        result = self.bridge.complete({**command, 'result': {'ok': True, 'opened': True, 'remoteContentVerified': False}})
        self.assertFalse(result['result']['remoteContentVerified'])

    def test_inspect_node_dispatches_and_returns_only_confirmed_ack(self):
        self.bridge.heartbeat(self.page)
        self.submit('extension', tool='canvas_create_extension', args={'digest': 'a' * 64, 'nodeDefinitionId': 'three-image'})
        command = self.bridge.heartbeat(self.page)['command']
        self.assertEqual(command['tool'], 'canvas_create_extension')
        self.bridge.complete({**command, 'result': {'ok': True, 'node': {'id': 'generator-test'}}})

    def test_inspection_confirmed_ack(self):
        self.bridge.heartbeat(self.page)
        result = self.submit('inspect', tool='canvas_inspect_node', args={'nodeId': 'g1', 'stage': 'three_quarter_portrait'})
        self.assertEqual(result['status'], 'queued')
        command = self.bridge.heartbeat(self.page)['command']
        self.assertEqual(command['tool'], 'canvas_inspect_node')
        self.assertEqual(self.bridge.get('inspect')['status'], 'dispatched')
        result = self.bridge.complete({**command, 'result': {'ok': True, 'opened': True, 'nodeCount': 10, 'linkCount': 12}})
        self.assertEqual(result['result']['nodeCount'], 10)
        self.assertIsNone(self.bridge.heartbeat(self.page)['command'])

    def test_wait_for_node_is_bounded_and_not_redelivered(self):
        self.bridge.heartbeat(self.page)
        queued = self.submit('wait_node', tool='canvas_wait_for_node', args={'nodeId': 'g1'})
        self.assertEqual(queued['status'], 'queued')
        command = self.bridge.heartbeat(self.page)['command']
        self.assertEqual(command['tool'], 'canvas_wait_for_node')
        self.assertEqual(command['args']['timeoutMs'], 20000)
        self.assertIsNone(self.bridge.heartbeat(self.page)['command'])
        self.assertEqual(self.submit('wait_node', tool='canvas_wait_for_node', args={'nodeId': 'g1'})['status'], 'dispatched')
        self.assert_code('BAD_REQUEST', lambda: self.submit('wait_long', tool='canvas_wait_for_node', args={'nodeId': 'g1', 'timeoutMs': 300000}))
        self.assert_code('BAD_REQUEST', lambda: self.submit('wait_bool', tool='canvas_wait_for_node', args={'nodeId': 'g1', 'timeoutMs': True}))
        self.assert_code('BAD_REQUEST', lambda: self.submit('generate_wait', tool='canvas_generate_node', args={'nodeId': 'g1', 'wait': True}))
        self.bridge.complete({**command, 'result': {'ok': True, 'pending': True, 'node': {'status': 'running'}}})
        self.assertEqual(self.bridge.get('wait_node')['status'], 'done')

    def test_cancel_node_is_whitelisted_and_launcher_cannot_use_it(self):
        self.bridge.heartbeat(self.page)
        self.submit('cancel_node', tool='canvas_cancel_node', args={'nodeId': 'g1'})
        command = self.bridge.heartbeat(self.page)['command']
        self.assertEqual(command['tool'], 'canvas_cancel_node')
        self.assertIsNone(self.bridge.heartbeat(self.page)['command'])
        page = {**self.page, 'sessionId': 'launcher_page', 'projectId': 'launcher'}
        self.bridge.heartbeat(page)
        active = self.bridge.current('launcher')
        self.assert_code('BAD_REQUEST', lambda: self.bridge.submit({**active, 'opId': 'launcher_cancel', 'tool': 'canvas_cancel_node', 'args': {'nodeId': 'g1'}}))
        self.assert_code('BAD_REQUEST', lambda: self.bridge.submit({**active, 'opId': 'launcher_wait', 'tool': 'canvas_wait_for_node', 'args': {'nodeId': 'g1'}}))


if __name__ == '__main__':
    unittest.main()
