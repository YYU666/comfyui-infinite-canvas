import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parent))

from video_workbench_launcher import start_owned_comfy, stop_owned_comfy

ROOT = Path(__file__).resolve().parent


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

    def test_preserved_comfy_can_write_after_parent_exits(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "finished.txt"
            log = root / "comfyui.log"
            child = (
                "import sys,time; from pathlib import Path; "
                "time.sleep(0.6); print('COMFY_SURVIVED_PARENT 中文 🎉', flush=True); "
                f"Path({str(marker)!r}).write_text('done', encoding='utf-8')"
            )
            parent = (
                "import json,sys; from pathlib import Path; "
                f"sys.path.insert(0, {str(ROOT)!r}); "
                "from video_workbench_launcher import start_owned_comfy; "
                f"comfy,logger=start_owned_comfy([sys.executable, '-u', '-c', {child!r}], Path({str(ROOT)!r}), Path({str(log)!r})); "
                "print(json.dumps({'comfyPid': comfy.pid, 'loggerPid': logger.pid}), flush=True)"
            )
            env = os.environ.copy()
            env["H3_WORKBENCH_DATA_DIR"] = str(root / "data")
            env["H3_WORKBENCH_RUNTIME_DIR"] = str(root / "runtime")
            env.update(PYTHONUTF8="0", PYTHONIOENCODING="gbk")
            processes = []
            alive = []
            try:
                result = subprocess.run(
                    [sys.executable, "-c", parent], cwd=ROOT, env=env,
                    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                process_info = json.loads(result.stdout.strip().splitlines()[-1])
                processes = [psutil.Process(process_info[name]) for name in ("comfyPid", "loggerPid")]
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and not marker.exists():
                    time.sleep(0.05)
                self.assertEqual(marker.read_text(encoding="utf-8"), "done")
                while time.monotonic() < deadline and (not log.exists() or "COMFY_SURVIVED_PARENT" not in log.read_text(encoding="utf-8")):
                    time.sleep(0.05)
                self.assertIn("COMFY_SURVIVED_PARENT 中文 🎉", log.read_text(encoding="utf-8"))
            finally:
                if processes:
                    _, alive = psutil.wait_procs(processes, timeout=10)
                    for process in alive:
                        process.terminate()
                    if alive:
                        psutil.wait_procs(alive, timeout=5)
            self.assertEqual(alive, [], "ComfyUI and its logger should exit without holding the log file")


if __name__ == "__main__":
    unittest.main()
