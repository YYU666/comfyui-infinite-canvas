"""Offline page-channel publication contracts; no browser, upload or service."""
import unittest

from canvas_page_bridge import CanvasPageBridge, TOOLS
from project_store import StoreError


class PublicationPageBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = CanvasPageBridge()
        self.page = {"sessionId": "page_one", "projectId": "prj_one", "visible": True}
        self.bridge.heartbeat(self.page)
        self.args = {"requestId": "publish_one", "digest": "a" * 64, "packageId": "user/package", "version": "0.2.0"}

    def submit(self, args, tool="canvas_publish_extension", op="publication"):
        return self.bridge.submit({**self.bridge.current(), "opId": op, "tool": tool, "args": args})

    def test_dispatch_default_mode_exact_replay_and_status(self):
        self.assertEqual(self.submit(self.args)["status"], "queued")
        command = self.bridge.heartbeat(self.page)["command"]
        self.assertEqual(command["args"], {**self.args, "mode": "update"})
        self.bridge.complete({**command, "result": {"ok": True, "status": "submitted"}})
        self.assertEqual(self.submit(self.args)["status"], "done")
        self.assertEqual(self.submit({**self.args, "mode": "update"})["status"], "done")
        self.assertIsNone(self.bridge.heartbeat(self.page)["command"])
        self.submit({"requestId": "publish_one"}, "canvas_get_extension_publish_status", "status")
        self.assertEqual(self.bridge.heartbeat(self.page)["command"]["args"], {"requestId": "publish_one"})
        self.assertIn("canvas_wait_for_node", TOOLS)
        self.assertIn("canvas_cancel_node", TOOLS)
        self.assertIn("canvas_native3d_capabilities", TOOLS)
        self.assertFalse(any("pcg" in tool for tool in TOOLS))

    def test_invalid_fields_types_and_identities_never_queue(self):
        invalid = [{**self.args, "path": "archive.zip"}, {**self.args, "digest": "bad"},
                   {**self.args, "mode": "replace"}, {**self.args, "mode": []},
                   {**self.args, "version": "latest"}, {**self.args, "version": 2},
                   {**self.args, "packageId": "../package"}, {**self.args, "packageId": []},
                   {**self.args, "requestId": "../publish"}, {**self.args, "digest": None},
                   {key: value for key, value in self.args.items() if key != "version"}]
        for args in invalid:
            with self.subTest(args=args), self.assertRaises(StoreError) as caught:
                self.submit(args)
            self.assertEqual(caught.exception.code, "BAD_REQUEST")
        for args in ({"requestId": "publish_one", "mode": "update"}, {}, {"requestId": []}):
            with self.subTest(args=args), self.assertRaises(StoreError):
                self.submit(args, "canvas_get_extension_publish_status")
        self.assertEqual(self.bridge.commands, {})

    def test_hidden_page_and_launcher_cannot_publish(self):
        active = self.bridge.current()
        self.bridge.heartbeat({**self.page, "visible": False})
        with self.assertRaises(StoreError):
            self.bridge.submit({**active, "opId": "hidden", "tool": "canvas_publish_extension", "args": self.args})
        self.bridge.release({"sessionId": self.page["sessionId"]})
        self.bridge.heartbeat({**self.page, "projectId": "launcher"})
        with self.assertRaises(StoreError):
            self.submit(self.args)
        self.assertEqual(self.bridge.commands, {})


if __name__ == '__main__':
    unittest.main()
