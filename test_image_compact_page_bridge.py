import unittest

from canvas_page_bridge import CanvasPageBridge, TOOLS
from project_store import StoreError


class ImageCompactBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = CanvasPageBridge()
        self.page = {"sessionId": "page_one", "projectId": "prj_one", "visible": True}
        self.bridge.heartbeat(self.page)

    def submit(self, args, **extra):
        return self.bridge.submit({**self.bridge.current(), "opId": "compact", "tool": "canvas_image_compact", "args": args, **extra})

    def test_default_dryrun_and_dedup(self):
        self.submit({"nodeIds": ["g1"]})
        # Omitted default and explicit true are the same command identity.
        self.submit({"nodeIds": ["g1"], "dryRun": True})
        command = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual(command["args"], {"nodeIds": ["g1"], "dryRun": True})
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        self.bridge.complete({**command, "result": {"ok": True, "dryRun": True}})
        self.assertEqual(self.submit({"nodeIds": ["g1"]})["status"], "done")
        with self.assertRaises(StoreError) as caught:
            self.submit({"nodeIds": ["g1"], "dryRun": False})
        self.assertEqual(caught.exception.code, "CANVAS_OP_CONFLICT")

    def test_strict_args(self):
        for args in ({}, {"nodeIds": []}, {"nodeIds": ["a/b"]}, {"nodeIds": [True]},
                     {"nodeIds": ["x"] * 101}, {"nodeIds": ["x"], "dryRun": None},
                     {"nodeIds": ["x"], "dryRun": 0}, {"nodeIds": ["x"], "extra": "no"}):
            with self.subTest(args=args), self.assertRaises(StoreError) as caught:
                self.submit(args)
            self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_hidden_stale_session_and_launcher_rejected(self):
        active = self.bridge.current()
        self.bridge.heartbeat({**self.page, "visible": False})
        with self.assertRaises(StoreError) as caught:
            self.bridge.submit({**active, "opId": "hidden", "tool": "canvas_image_compact", "args": {"nodeIds": ["g1"]}})
        self.assertEqual(caught.exception.code, "NO_VISIBLE_CANVAS")
        self.bridge.heartbeat(self.page)
        with self.assertRaises(StoreError) as caught:
            self.submit({"nodeIds": ["g1"]}, sessionId="old_page")
        self.assertEqual(caught.exception.code, "CANVAS_SESSION_CHANGED")
        self.bridge.release({"sessionId": self.page["sessionId"]})
        self.bridge.heartbeat({**self.page, "projectId": "launcher"})
        with self.assertRaises(StoreError) as caught:
            self.submit({"nodeIds": ["g1"]})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")

    def test_existing_wait_cancel_preserved(self):
        self.assertTrue({"canvas_wait_for_node", "canvas_cancel_node"} <= TOOLS)


if __name__ == "__main__":
    unittest.main()
