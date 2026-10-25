from __future__ import annotations

import functools
import ipaddress
import json
import os
import re
import shutil
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
import psutil

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
COMFY_URL = "http://127.0.0.1:8188"
WEB_URL = "http://127.0.0.1:8790"
DATA_DIR = Path(os.environ.get("H3_WORKBENCH_DATA_DIR", r"D:\H3_Workbench"))
INPUT_DIR = DATA_DIR / "references"
OUTPUT_DIR = DATA_DIR / "generated"
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


SHARE_URL_PATTERN = re.compile(r"https?://[^\s<>\"'，。！？；、【】（）]+", re.IGNORECASE)


def extract_share_url(value):
    """Accept either a plain URL or the full text copied from a mobile sharing sheet."""
    match = SHARE_URL_PATTERN.search(value.strip())
    if not match:
        raise ValueError("没有检测到视频链接，请粘贴 App 里“复制链接”得到的完整内容。")
    return match.group(0).rstrip(".,!?;，。！？；、)]}")


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


def import_douyin_with_browser(url, output_dir, stem):
    """Resolve public Douyin pages in a clean browser session, without profile cookies."""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("没有找到 Node.js，无法启用抖音公开页面解析。")
    file_path = (output_dir / f"{stem}.mp4").resolve()
    command = [node, str(HERE / "browser_video_import.mjs"), "--url", url, "--output", str(file_path)]
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    except subprocess.TimeoutExpired as exc:
        file_path.unlink(missing_ok=True)
        raise RuntimeError("抖音视频加载超时，请换较短的视频，或下载后手动上传。") from exc
    if result.returncode:
        file_path.unlink(missing_ok=True)
        lines = [line.strip() for line in result.stderr.splitlines() if line.strip()]
        detail = lines[-1][:350] if lines else "公开页面未返回可下载的视频"
        raise RuntimeError(f"无法解析这个抖音公开视频。请确认作品公开且未失效；也可以下载后手动上传。\n{detail}")
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    try:
        metadata = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        file_path.unlink(missing_ok=True)
        raise RuntimeError("抖音视频解析完成，但没有返回有效的文件信息。") from exc
    if output_dir.resolve() not in file_path.parents or not file_path.is_file():
        raise RuntimeError("抖音视频下载完成，但文件位置无效。")
    size = file_path.stat().st_size
    if not size or size > MAX_VIDEO_BYTES or int(metadata.get("size", 0)) != size:
        file_path.unlink(missing_ok=True)
        raise RuntimeError("抖音视频文件不完整或超过 250 MB，请重试或手动上传。")
    title = str(metadata.get("title") or "抖音视频参考")
    return {"name": file_path.name, "subfolder": "workbench", "title": title[:120], "size": size, "sourceUrl": url}


def import_video(share_text):
    url = validate_video_url(extract_share_url(share_text))
    output_dir = INPUT_DIR / "workbench"
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
        host = (urllib.parse.urlparse(url).hostname or "").lower()
        if host == "douyin.com" or host.endswith(".douyin.com"):
            return import_douyin_with_browser(url, output_dir, stem)
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
    return {"name": file_path.name, "subfolder": "workbench", "title": title[:120], "size": file_path.stat().st_size, "sourceUrl": url}


def load_deepseek_key():
    configured = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if configured:
        return configured
    key_file = HERE / "deepseek.key"
    if key_file.is_file():
        return key_file.read_text(encoding="utf-8-sig").strip()
    raise RuntimeError("尚未配置 DeepSeek 密钥，请先完成本机后端配置。")


def optimize_h3_prompt(payload):
    idea = str(payload.get("idea", "")).strip()
    current_prompt = str(payload.get("currentPrompt", "")).strip()
    if not idea and not current_prompt:
        raise ValueError("请先写下想生成的画面，或先在生成节点里输入提示词。")
    if len(idea) > 6000 or len(current_prompt) > 16000:
        raise ValueError("提示词内容过长，请精简后再优化。")
    mode = payload.get("mode") if payload.get("mode") in {"reference", "swap", "text", "frames"} else "reference"
    duration = max(4, min(15, int(payload.get("duration") or 5)))
    ratio = str(payload.get("ratio") or "16:9")[:12]
    references = []
    for item in (payload.get("references") or [])[:15]:
        if not isinstance(item, dict):
            continue
        tag = str(item.get("tag", ""))
        if not re.fullmatch(r"<(?:Picture|Video|Audio) [1-9][0-9]*>", tag):
            continue
        references.append({
            "tag": tag,
            "kind": str(item.get("kind", ""))[:10],
            "slot": str(item.get("slot", ""))[:12],
            "title": str(item.get("title", ""))[:160],
        })
    guide_name = "ref-en.txt" if mode in {"reference", "swap"} else "base-en.txt"
    guide = (HERE / "prompt_guides" / guide_name).read_text(encoding="utf-8")
    structure = (
        "This is Character Swap v1.1, not ordinary Ref2VA and never a face-only or head-only swap. Start with 'body_swap:'. Use exactly three sections: "
        "subject_definitions, summary, detailed_description. Bind only the identity image as <Picture 1> and "
        "<Subject 1>. Copy the entire person as one indivisible identity: exact face, hair, skin, body shape, body proportions, "
        "all visible clothing and accessories. Preserve exact garment types, neckline, straps, sleeves, fit, fabric, colors, "
        "patterns, layers, length, lower-body clothing and footwear. Never beautify, redesign, extend or replace the outfit; "
        "never turn a top into a dress, add a skirt, or copy body or clothing from the guide. Describe only user-supplied visible traits. "
        "The AddGuide source video alone supplies scene, camera, framing, pose, gestures, head motion, gaze, lip "
        "movement and facial expression frame by frame. Preserve the original scene and audio; do not write music."
        if mode == "swap" else
        "Use all six Ref2VA sections in the official order: subject_definitions, summary, "
        "retention_analysis, detailed_description, overall_soundscape, non_diegetic_music."
        if mode == "reference" else
        "Use integrated_multimodal_description, overall_soundscape, and non_diegetic_music "
        "in the official order. Add the required first/last-frame alignment instruction when applicable."
    )
    system = (
        "You rewrite a user's natural-language idea into a production-ready MiniMax H3 prompt. "
        "Follow the official guide below exactly. Return only the final prompt, without Markdown fences, "
        "analysis, prefaces, or notes. Write structural sections in English; preserve user-provided dialogue, "
        "lyrics, and visible scene text in their original language. Keep the requested duration and aspect ratio. "
        "Preserve the user's creative intent and explicit constraints. Resolve contradictory wording conservatively "
        "instead of repeating incompatible instructions. Use observable actions in playback order and do not add "
        "unnecessary cuts, characters, dialogue, or music. Use only supplied reference labels such as <Picture 1>, "
        "<Video 1>, and <Audio 1>; never invent reference numbers or replace them with filenames. "
        "For every image-defined main character, subject_definitions must preserve identity across face, hairstyle, "
        "outfit, colors, and body proportions. Use concrete visible traits only when the user explicitly supplied them; "
        "never invent or change hair color, clothing, location, time of day, or other visual facts that cannot be known "
        "from the text. When no traits were supplied, require the same face, hairstyle, outfit, colors, and proportions "
        "as the bound image instead of guessing. Treat all views in a character sheet as one subject, never as separate people "
        "or a request to reproduce the sheet layout. Bind <Picture N> to <Subject N> only in subject_definitions and "
        "retention_analysis; inside detailed_description use <Subject N> and repeated visual anchors, not <Picture N>. "
        "When a reference video supplies only choreography, camera movement, or timing, explicitly transfer those "
        "attributes to the image-defined subject and do not inherit the source actor's face, body, mask, costume, colors, "
        "green-screen background, or other visual appearance unless the user requests it. Keep motion-reference actors "
        "out of the target scene unless the user explicitly asks them to appear. "
        f"For this request, {structure}\n\nOFFICIAL MINIMAX H3 GUIDE:\n{guide}"
    )
    user = json.dumps({
        "mode": {"reference": "Ref2VA", "swap": "Character Swap v1.1 with AddGuide", "text": "T2VA", "frames": "FL2VA/I2VA according to connected frame slots"}[mode],
        "durationSeconds": duration,
        "aspectRatio": ratio,
        "naturalLanguageIdea": idea,
        "currentPromptToImprove": current_prompt,
        "referencesInConnectionOrder": references,
    }, ensure_ascii=False)
    request = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps({
            "model": os.environ.get("H3_DEEPSEEK_MODEL", "deepseek-flash"),
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "reasoning_effort": "none",
            "temperature": 0.7,
            "max_tokens": 6000,
            "response_format": {"type": "text"},
            "stream": False,
        }).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {load_deepseek_key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=150) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")
        except Exception:
            detail = ""
        raise RuntimeError(f"DeepSeek 请求失败 ({exc.code})：{detail[:260] or '请检查密钥额度或稍后重试。'}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError("无法连接 DeepSeek，请检查网络后重试。") from exc
    optimized = str(result.get("choices", [{}])[0].get("message", {}).get("content", "")).strip()
    optimized = re.sub(r"^```(?:text|markdown)?\s*|\s*```$", "", optimized).strip()
    required = ["body_swap:", "subject_definitions:", "summary:", "detailed_description:"] if mode == "swap" else ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"] if mode == "reference" else ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"]
    if not optimized or any(header not in optimized for header in required):
        raise RuntimeError("AI 返回的 H3 结构不完整，请重试。")
    if mode == "reference":
        detail_start = optimized.find("detailed_description:")
        bindings = re.findall(r"(<Subject [1-9][0-9]*>)[^\n]*?(<Picture [1-9][0-9]*>)", optimized[:detail_start])
        prefix, detail = optimized[:detail_start], optimized[detail_start:]
        for subject, picture in bindings:
            detail = detail.replace(picture, subject)
        optimized = prefix + detail
    return {"prompt": optimized, "model": os.environ.get("H3_DEEPSEEK_MODEL", "deepseek-flash")}


def open_file_location(payload):
    kind = str(payload.get("kind", ""))
    name = str(payload.get("name", "")).replace("\\", "/").strip("/")
    if kind not in {"input", "output"} or not name or name.startswith("../") or "/../" in name:
        raise ValueError("文件位置无效。")
    base = INPUT_DIR if kind == "input" else OUTPUT_DIR
    file_path = (base / name).resolve()
    if base.resolve() not in file_path.parents or not file_path.is_file():
        raise ValueError("文件不存在，或尚未保存到 D 盘。请先上传素材或完成一次生成。")
    if os.name != "nt":
        raise RuntimeError("当前系统不支持自动打开文件位置。")
    subprocess.Popen(["explorer.exe", f"/select,{file_path}"], close_fds=True)
    return {"opened": True, "path": str(file_path)}


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

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/hardware-metrics":
            super().do_GET()
            return
        try:
            memory = psutil.virtual_memory()
            self.send_json(200, {
                "cpuPercent": round(psutil.cpu_percent(interval=None), 1),
                "ramTotal": memory.total,
                "ramUsed": memory.total - memory.available,
                "timestamp": int(time.time() * 1000),
            })
        except Exception as exc:
            print(f"硬件状态读取失败：{exc}", file=sys.stderr)
            self.send_json(500, {"error": "暂时无法读取 CPU 使用率。"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path not in {"/api/import-video", "/api/optimize-prompt", "/api/open-file-location"}:
            self.send_json(404, {"error": "接口不存在"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 65536:
                raise ValueError("请求内容无效。")
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if path == "/api/import-video":
                result = import_video(str(payload.get("url", "")).strip())
            elif path == "/api/open-file-location":
                result = open_file_location(payload)
            else:
                result = optimize_h3_prompt(payload)
            self.send_json(200, result)
        except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            print(f"本地工作台请求失败：{exc}", file=sys.stderr)
            self.send_json(500, {"error": "本地服务暂时无法完成请求，请稍后重试。"})


def main():
    os.environ.setdefault("PYTHONUNBUFFERED", "1")
    (INPUT_DIR / "workbench").mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    comfy_process = None
    log = None
    try:
        try:
            cors, stats = api_status()
            if cors != WEB_URL:
                raise RuntimeError("ComfyUI 已在运行，但缺少工作台跨域权限。请关闭原 ComfyUI 窗口后，再用本启动器重新打开。")
            argv = stats.get("system", {}).get("argv", [])
            if str(INPUT_DIR) not in argv or str(OUTPUT_DIR) not in argv:
                raise RuntimeError(f"当前 ComfyUI 未使用工作台存储目录。请关闭原 ComfyUI 后重新启动，素材应存到 {DATA_DIR}。")
            print("检测到已配置好的 ComfyUI，直接连接。")
        except urllib.error.URLError:
            command = [
                str(ROOT / "python_embeded" / "python.exe"), "-s", str(ROOT / "ComfyUI" / "main.py"),
                "--windows-standalone-build", "--output-directory", str(OUTPUT_DIR), "--input-directory", str(INPUT_DIR),
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
