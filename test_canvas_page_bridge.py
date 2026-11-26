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

    def test_extension_publication_dispatch_and_readonly_status(self):
        self.bridge.heartbeat(self.page)
        args = {"requestId": "publish_one", "digest": "a" * 64, "packageId": "user/package", "version": "0.2.0"}
        self.submit("publish", tool="canvas_publish_extension", args=args)
        command = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual(command["args"], {**args, "mode": "update"})
        self.bridge.complete({**command, "result": {"ok": True, "status": "submitted"}})
        self.assertEqual(self.submit("publish", tool="canvas_publish_extension", args=args)["status"], "done")
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        self.submit("status", tool="canvas_get_extension_publish_status", args={"requestId": "publish_one"})
        self.assertEqual(self.bridge.heartbeat(self.page)["command"]["tool"], "canvas_get_extension_publish_status")
        for invalid in ({**args, "path": "archive.zip"}, {**args, "digest": "bad"}, {**args, "mode": "replace"}, {**args, "version": "latest"}):
            self.assert_code("BAD_REQUEST", lambda: self.submit("invalid", tool="canvas_publish_extension", args=invalid))

    def test_image_compact_default_preview_dispatch_and_replay(self):
        self.bridge.heartbeat(self.page)
        request = {**self.bridge.current(), "opId": "compact", "tool": "canvas_image_compact", "args": {"nodeIds": ["generator-1"]}}
        self.assertEqual(self.bridge.submit(request)["status"], "queued")
        command = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual(command["tool"], "canvas_image_compact")
        self.assertEqual(command["args"], {"nodeIds": ["generator-1"], "dryRun": True})
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        result = {"ok": True, "dryRun": True, "compacted": []}
        self.bridge.complete({**command, "result": result})
        self.assertEqual(self.bridge.submit(request)["result"], result)
        self.assertEqual(self.bridge.submit({**request, "args": {**request["args"], "dryRun": True}})["status"], "done")
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        self.assert_code("CANVAS_OP_CONFLICT", lambda: self.bridge.submit({**request, "args": {**request["args"], "dryRun": False}}))
        self.assertEqual(self.bridge.submit({**request, "opId": "compact_apply", "args": {**request["args"], "dryRun": False}})["status"], "queued")
        self.assertFalse(self.bridge.heartbeat(self.page)["command"]["args"]["dryRun"])

    def test_image_compact_rejects_unsafe_or_unbounded_arguments(self):
        self.bridge.heartbeat(self.page)
        for args in ({}, {"nodeIds": []}, {"nodeIds": ["g"] * 101}, {"nodeIds": "g"}, {"nodeIds": ["../g"]}, {"nodeIds": [1]}, {"nodeIds": ["g"], "dryRun": 1}, {"nodeIds": ["g"], "dryRun": "false"}, {"nodeIds": ["g"], "unknown": True}):
            self.assert_code("BAD_REQUEST", lambda: self.submit("bad_compact", tool="canvas_image_compact", args=args))
        self.assertEqual(self.bridge.commands, {})
        self.bridge.release(self.page)
        self.bridge.heartbeat({**self.page, "projectId": "launcher"})
        self.assert_code("BAD_REQUEST", lambda: self.bridge.submit({**self.bridge.current(), "opId": "launcher_compact", "tool": "canvas_image_compact", "args": {"nodeIds": ["g"]}}))

    def test_native3d_capabilities_readonly_query_dispatches_once(self):
        self.bridge.heartbeat(self.page)
        request = {**self.bridge.current(), "opId":"native_caps", "tool":"canvas_native3d_capabilities", "args":{}}
        self.assertEqual('queued',self.bridge.submit(request)['status'])
        command = self.bridge.heartbeat(self.page)['command']
        self.assertEqual('canvas_native3d_capabilities',command['tool'])
        result = {"ok":True,"operations":{"analyze":{"ready":False,"reason":"Runtime missing"}}}
        self.assertEqual(result,self.bridge.complete({**command,"result":result})['result'])
        self.assertEqual('done',self.bridge.submit(request)['status'])
        self.assertIsNone(self.bridge.heartbeat(self.page)['command'])
        self.assert_code('BAD_REQUEST',lambda:self.bridge.submit({**request,"opId":"invalid_caps","args":{"command":"x"}}))

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

    def test_native3d_viewer_close_routes_once_and_rejects_arguments(self):
        self.bridge.heartbeat(self.page)
        request = {**self.bridge.current(), "opId": "close_viewer", "tool": "canvas_native3d_viewer_close", "args": {}}
        self.assertEqual("queued", self.bridge.submit(request)["status"])
        command = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual("canvas_native3d_viewer_close", command["tool"])
        self.bridge.complete({**command, "result": {"ok": True, "closed": True}})
        self.assertEqual("done", self.bridge.submit(request)["status"])
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        self.assert_code("BAD_REQUEST", lambda: self.bridge.submit({**request, "opId": "bad_close", "args": {"nodeId": "x"}}))

    def test_stage_retry_routes_once_and_forbids_seed_or_path(self):
        self.bridge.heartbeat(self.page)
        request = {**self.bridge.current(), "opId": "retry_lod", "tool": "canvas_native3d_retry_stage", "args": {"nodeId": "lod3"}}
        self.assertEqual("queued", self.bridge.submit(request)["status"])
        command = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual("canvas_native3d_retry_stage", command["tool"])
        self.bridge.complete({**command, "result": {"ok": True, "nodeId": "retry_processor", "seed": 42}})
        self.assertEqual("done", self.bridge.submit(request)["status"])
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        for args in ({}, {"nodeId": "x", "seed": 1}, {"nodeId": "x", "path": "x"}):
            self.assert_code("BAD_REQUEST", lambda: self.bridge.submit({**request, "opId": "bad_retry", "args": args}))

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


if __name__ == '__main__':
    unittest.main()
