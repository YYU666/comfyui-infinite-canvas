from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def wait_for_instance(path, process, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"后台提前退出，代码 {process.returncode}")
        try:
            instance = json.loads(path.read_text(encoding="utf-8"))
            with urllib.request.urlopen(f"http://127.0.0.1:{instance['port']}/api/health", timeout=0.5) as response:
                return instance, json.load(response)
        except (OSError, ValueError, KeyError, json.JSONDecodeError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError("等待后台健康检查超时")


def main():
    python = Path(sys.executable)
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied, tempfile.TemporaryDirectory(prefix="h3-lifecycle-") as temporary:
        occupied.bind(("127.0.0.1", 8790))
        occupied.listen(1)
        environment = os.environ.copy()
        environment.update(H3_WORKBENCH_RUNTIME_DIR=temporary, H3_WORKBENCH_NO_BROWSER="1")
        instance_path = Path(temporary) / "instance.json"
        process = subprocess.Popen([str(python), str(ROOT / "video_workbench_launcher.py")], cwd=ROOT, env=environment)
        try:
            instance, health = wait_for_instance(instance_path, process)
            assert health["ok"] and health["pid"] == instance["pid"]
            assert instance["port"] == 8791, "8790 被占用时未自动切换端口"
            duplicate = subprocess.run([str(python), str(ROOT / "video_workbench_launcher.py")], cwd=ROOT, env=environment, timeout=10)
            assert duplicate.returncode == 0, "重复启动返回错误"
            again = json.loads(instance_path.read_text(encoding="utf-8"))
            assert again["pid"] == instance["pid"] and again["port"] == instance["port"], "重复启动创建了新实例"
            request = urllib.request.Request(f"http://127.0.0.1:{instance['port']}/api/shutdown", data=b"{}", method="POST", headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(request, timeout=2)
                raise AssertionError("无令牌停止请求未被拒绝")
            except urllib.error.HTTPError as error:
                assert error.code == 401
            stopped = subprocess.run([str(python), str(ROOT / "stop.py")], cwd=ROOT, env=environment, timeout=15)
            assert stopped.returncode == 0, "停止脚本失败"
            assert process.wait(timeout=10) == 0, "后台未正常退出"
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{instance['port']}/api/health", timeout=0.5)
                raise AssertionError("停止后端口仍响应")
            except urllib.error.URLError:
                pass
            print(json.dumps({"ok": True, "portReleased": instance["port"], "duplicateReused": True, "unauthorizedShutdown": 401}, ensure_ascii=False))
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


if __name__ == "__main__":
    main()
