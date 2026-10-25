from __future__ import annotations

import functools
import ipaddress
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import imageio_ffmpeg

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
COMFY_URL = "http://127.0.0.1:8188"
WEB_URL = "http://127.0.0.1:8790"
MAX_VIDEO_BYTES = 250 * 1024 * 1024


def api_status():
    request = urllib.request.Request(COMFY_URL + "/system_stats", headers={"Origin": WEB_URL})
    with urllib.request.urlopen(request, timeout=2) as response:
        return response.headers.get("Access-Control-Allow-Origin"), json.load(response)


def wait_for_comfy(process, timeout=180):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if process and process.poll() is not None:
            raise RuntimeError("ComfyUI 启动失败，请查看 comfyui_workbench.log。")
        try:
            cors, _ = api_status()
            if cors == WEB_URL:
                return
            if not process:
                raise RuntimeError("检测到旧版启动方式运行的 ComfyUI。请先关闭原 ComfyUI 窗口，再双击视频工作台启动器。")
        except urllib.error.URLError:
            pass
        time.sleep(2)
    raise RuntimeError("等待 ComfyUI 启动超时，请查看 comfyui_workbench.log。")


def validate_video_url(value):
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("请输入有效的 HTTP 或 HTTPS 视频链接。")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise ValueError("无法解析这个视频网站的地址。") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError("为保护本机安全，不能加载内网或本机地址。")
    return value


def import_video(url):
    validate_video_url(url)
    output_dir = ROOT / "ComfyUI" / "input" / "workbench"
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"web_{time.strftime('%Y%m%d')}_{uuid.uuid4().hex[:12]}"
    command = [
        str(ROOT / "python_embeded" / "python.exe"), "-m", "yt_dlp",
        "--no-playlist", "--no-warnings", "--socket-timeout", "20", "--retries", "2",
        "--max-filesize", str(MAX_VIDEO_BYTES), "--merge-output-format", "mp4",
        "--ffmpeg-location", imageio_ffmpeg.get_ffmpeg_exe(),
        "-f", "bv*[height<=720]+ba/b[height<=720]/b",
        "-o", str(output_dir / f"{stem}.%(ext)s"),
        "--print", "%(title)s", "--print", "after_move:filepath", url,
    ]
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("视频加载超时，请换较短的视频，或下载后手动上传。") from exc
    if result.returncode:
        lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
        detail = lines[-1][:350] if lines else "网站未返回可下载的视频"
        raise RuntimeError(f"无法加载这个视频链接。请确认视频公开可访问；也可以下载后手动上传。\n{detail}")
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("下载完成，但没有找到视频文件。")
    file_path = Path(lines[-1]).resolve()
    if output_dir.resolve() not in file_path.parents or not file_path.is_file():
        raise RuntimeError("下载完成，但视频文件位置无效。")
    if file_path.stat().st_size > MAX_VIDEO_BYTES:
        file_path.unlink(missing_ok=True)
        raise RuntimeError("视频超过 250 MB，请下载并剪辑后再上传。")
    title = lines[0] if len(lines) > 1 else file_path.stem
    return {"name": file_path.name, "subfolder": "workbench", "title": title[:120], "size": file_path.stat().st_size}


class WorkbenchHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/import-video":
            self.send_json(404, {"error": "接口不存在"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 16384:
                raise ValueError("请求内容无效。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            url = str(payload.get("url", "")).strip()
            result = import_video(url)
            self.send_json(200, result)
        except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            print(f"视频链接导入失败：{exc}", file=sys.stderr)
            self.send_json(500, {"error": "本地视频导入失败，请稍后重试或手动上传。"})


def main():
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    comfy_process = None
    log = None
    try:
        try:
            cors, _ = api_status()
            if cors != WEB_URL:
                raise RuntimeError("ComfyUI 已在运行，但缺少工作台跨域权限。请关闭原 ComfyUI 窗口后，再用本启动器重新打开。")
            print("检测到已配置好的 ComfyUI，直接连接。")
        except urllib.error.URLError:
            command = [
                str(ROOT / "python_embeded" / "python.exe"), "-s", str(ROOT / "ComfyUI" / "main.py"),
                "--windows-standalone-build", "--output-directory", r"D:\ComfyUI_Output",
                "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch",
                "--enable-cors-header", WEB_URL,
            ]
            log = (HERE / "comfyui_workbench.log").open("a", encoding="utf-8")
            comfy_process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
            print("正在启动本地 H3 模型服务，首次加载需要一点时间……")

        wait_for_comfy(comfy_process)
        handler = functools.partial(WorkbenchHandler, directory=str(HERE))
        server = ThreadingHTTPServer(("127.0.0.1", 8790), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"视频工作台已就绪：{WEB_URL}")
        print("生成期间请保持此窗口开启；关闭窗口会停止本次启动的服务。")
        if not os.environ.get("H3_WORKBENCH_NO_BROWSER"):
            webbrowser.open(WEB_URL)
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        input("按回车键关闭……")
    finally:
        if comfy_process and comfy_process.poll() is None:
            comfy_process.terminate()
            try:
                comfy_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                comfy_process.kill()
        if log:
            log.close()


if __name__ == "__main__":
    main()
