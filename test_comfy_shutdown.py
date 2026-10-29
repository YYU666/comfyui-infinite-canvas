import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_workbench_launcher import stop_owned_comfy


class OwnedComfyShutdownTests(unittest.TestCase):
    def process(self):
        value = MagicMock()
        value.pid = 12345
        value.poll.return_value = None
        return value

    def test_active_or_pending_queue_preserves_process(self):
        for counts in ((1, 0), (0, 1), (2, 3)):
            process = self.process()
            with self.subTest(counts=counts):
                self.assertEqual(stop_owned_comfy(process, lambda: counts), "preserved-active")
                process.terminate.assert_not_called()
                process.kill.assert_not_called()

    def test_unknown_queue_preserves_process(self):
        process = self.process()
        def unavailable():
            raise OSError("queue unavailable")
        self.assertEqual(stop_owned_comfy(process, unavailable), "preserved-unknown")
        process.terminate.assert_not_called()
        process.kill.assert_not_called()

    def test_idle_owned_process_is_terminated(self):
        process = self.process()
        self.assertEqual(stop_owned_comfy(process, lambda: (0, 0)), "terminated")
        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=15)
        process.kill.assert_not_called()

    def test_already_stopped_process_is_not_touched(self):
        process = self.process()
        process.poll.return_value = 0
        self.assertEqual(stop_owned_comfy(process, lambda: (0, 0)), "already-stopped")
        process.terminate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
