from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import psutil

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_lifecycle import probe_health, read_instance, remove_instance


def own_process(instance):
    try:
        process = psutil.Process(int(instance["pid"]))
        recorded = float(instance.get("pidCreatedAt", 0))
        if recorded and abs(process.create_time() - recorded) > 1:
            return None
        command = " ".join(process.cmdline())
        if "video_workbench_launcher.py" not in command:
            return None
        return process
    except (psutil.Error, KeyError, TypeError, ValueError):
        return None


def main():
    instance = read_instance()
    if not instance:
        print("H3 视频工作台未运行。")
        return 0
    port = int(instance.get("port", 0))
    url = f"http://127.0.0.1:{port}/api/shutdown"
    request = urllib.request.Request(
        url,
        data=b"{}",
        method="POST",
        headers={"X-H3-Token": str(instance.get("token", "")), "Content-Type": "application/json"},
    )
    stopped = False
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            stopped = json.load(response).get("ok") is True
    except (OSError, urllib.error.URLError, json.JSONDecodeError):
        pass

    process = own_process(instance)
    deadline = time.monotonic() + 8
    while process and process.is_running() and time.monotonic() < deadline:
        time.sleep(0.1)
    if process and process.is_running():
        if not stopped:
            print("后台停止接口未响应，将只结束已核对身份的工作台进程。")
        process.terminate()
        try:
            process.wait(timeout=5)
        except psutil.TimeoutExpired:
            process.kill()
    remove_instance(int(instance.get("pid", -1)))
    if probe_health(instance, timeout=0.3):
        print("停止失败：健康检查仍可访问。", flush=True)
        return 1
    print("H3 视频工作台已停止；用户自己启动的 ComfyUI 未受影响。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
