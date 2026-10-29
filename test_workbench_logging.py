from __future__ import annotations

import io
import logging
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_logging import (
    RotatingTextLog,
    cleanup_legacy_comfy_logs,
    configure_application_logging,
    pump_text_log,
)


class WorkbenchLoggingTests(unittest.TestCase):
    def test_application_log_rotates_and_redacts_formatted_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = logging.getLogger()
            old_handlers = root.handlers[:]
            old_level = root.level
            try:
                log_dir = configure_application_logging(runtime=temporary)
                logging.getLogger("logging-test").info("Authorization: Bearer secret-value token=%s", "private-token")
                for handler in root.handlers:
                    handler.flush()
                content = (log_dir / "app.log").read_text(encoding="utf-8")
                self.assertNotIn("secret-value", content)
                self.assertNotIn("private-token", content)
                self.assertIn("[REDACTED]", content)
            finally:
                for handler in root.handlers[:]:
                    root.removeHandler(handler)
                    handler.close()
                for handler in old_handlers:
                    root.addHandler(handler)
                root.setLevel(old_level)

    def test_comfy_output_is_bounded_and_old_content_rotates_out(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "comfyui.log"
            sink = RotatingTextLog(path, max_bytes=1024, backup_count=2)
            for index in range(300):
                sink.write(f"line-{index:04d} token=secret-{index:04d} " + "x" * 40)
            sink.close()
            logs = list(Path(temporary).glob("comfyui.log*"))
            self.assertLessEqual(len(logs), 3)
            self.assertLessEqual(sum(item.stat().st_size for item in logs), 3 * 1200)
            combined = "".join(item.read_text(encoding="utf-8") for item in logs)
            self.assertIn("line-0299", combined)
            self.assertNotIn("line-0000", combined)
            self.assertNotIn("secret-0299", combined)

    def test_pipe_pump_drains_all_lines_and_closes_sink(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "comfyui.log"
            sink = RotatingTextLog(path)
            pump_text_log(io.StringIO("first\nsecond\n"), sink)
            content = path.read_text(encoding="utf-8")
            self.assertIn("first", content)
            self.assertIn("second", content)
            self.assertTrue(sink._closed)

    def test_legacy_timestamp_logs_have_retention_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index in range(7):
                path = root / f"comfyui-20261029-00000{index}.log"
                path.write_text(str(index), encoding="utf-8")
            cleanup_legacy_comfy_logs(root, keep=2)
            self.assertEqual(len(list(root.glob("comfyui-2*.log"))), 2)


if __name__ == "__main__":
    unittest.main()
