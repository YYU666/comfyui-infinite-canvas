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


if __name__ == '__main__':
    unittest.main()
