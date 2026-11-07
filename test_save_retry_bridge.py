import unittest
from canvas_page_bridge import CanvasPageBridge


class SaveRetryBridgeTests(unittest.TestCase):
    def test_retry_dispatch_is_page_bound_and_deduplicated(self):
        bridge = CanvasPageBridge()
        page = {"sessionId": "page_one", "projectId": "prj_one", "visible": True, "busy": False}
        bridge.heartbeat(page)
        request = {**bridge.current(), "opId": "save_retry", "tool": "canvas_retry_save", "args": {}}
        self.assertEqual(bridge.submit(request)["status"], "queued")
        command = bridge.heartbeat(page)["command"]
        self.assertEqual(command["tool"], "canvas_retry_save")
        bridge.complete({**command, "result": {"ok": True, "saved": True}})
        self.assertEqual(bridge.submit(request)["status"], "done")
        self.assertIsNone(bridge.heartbeat(page)["command"])


if __name__ == '__main__':
    unittest.main()
