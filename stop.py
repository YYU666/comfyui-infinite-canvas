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
        print("Refmuse 本地工作台未运行。")
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
    except urllib.error.HTTPError as exc:
        if exc.code == 409:
            try:
                message = json.load(exc).get("message")
            except (OSError, ValueError, AttributeError):
                message = None
            print(message or "工作台正在忙，请等待活动任务完成后再停止。", flush=True)
            return 1
    except (OSError, ValueError, AttributeError):
        pass

    if not stopped:
        print("未能确认工作台已接受关闭请求，请稍后重试。", flush=True)
        return 1

    process = own_process(instance)
    deadline = time.monotonic() + 8
    while process and process.is_running() and time.monotonic() < deadline:
        time.sleep(0.1)
    if process and process.is_running():
        process.terminate()
        try:
            process.wait(timeout=5)
        except psutil.TimeoutExpired:
            process.kill()
    remove_instance(int(instance.get("pid", -1)))
    if probe_health(instance, timeout=0.3):
        print("停止失败：健康检查仍可访问。", flush=True)
        return 1
    print("Refmuse 本地工作台已停止；用户自己启动的 ComfyUI 未受影响。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
