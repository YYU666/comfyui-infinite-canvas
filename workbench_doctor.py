from __future__ import annotations

import io
import json
import os
import platform
import re
import shutil
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

from workbench_lifecycle import APP_VERSION, runtime_dir, utc_now
from workbench_settings import read_deepseek_key

NODE_DIRS = [
    "h3_workbench_refine",
    "h3-relay",
    "ComfyUI-KJNodes",
    "comfyui-krea2edit",
    "ComfyUI-Inpaint-CropAndStitch",
    "Comfyui_Minimax_h3_latent_Upscaler",
    "ComfyUI-Spectrum-MOSS",
]
SECRET_TEXT_PATTERNS = [
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]+=*"),
    re.compile(r"(?i)(authorization\s*[:=]\s*)[^\r\n]+"),
    re.compile(r"(?i)(cookie\s*[:=]\s*)[^\r\n]+"),
    re.compile(r"(?i)([\"']?(?:api[_-]?key|token|deepseek[_-]?key)[\"']?\s*[:=]\s*[\"']?)[^\s,;\"'}]+"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}\b"),
]


def redact_text(value, secrets=()):
    """Remove credentials from diagnostics without retaining them in the report."""
    text = str(value)
    for secret in secrets:
        if secret:
            text = text.replace(str(secret), "[REDACTED]")
    for pattern in SECRET_TEXT_PATTERNS:
        text = pattern.sub(lambda match: (match.group(1) + "[REDACTED]") if match.lastindex else "[REDACTED]", text)
    return text


def redacted_json(report, secrets=()):
    return redact_text(json.dumps(report, ensure_ascii=False, indent=2), secrets)


def _check(check_id, label, status, detail, **data):
    return {"id": check_id, "label": label, "status": status, "detail": detail, **data}


def _safe_relative(value):
    pure = PurePosixPath(str(value))
    if pure.is_absolute() or ".." in pure.parts:
        raise ValueError("模型清单包含无效路径。")
    return Path(*pure.parts)


def _configured_model_roots(comfy_root):
    """Read only base_path entries; never write or normalize the user's YAML."""
    roots = [comfy_root / "ComfyUI" / "models"]
    config = comfy_root / "ComfyUI" / "extra_model_paths.yaml"
    try:
        lines = config.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        lines = []
    for line in lines:
        match = re.match(r"^\s*base_path\s*:\s*(.+?)\s*$", line)
        if not match:
            continue
        value = match.group(1).strip().strip("\"'")
        if value and not value.startswith(("#", "${")):
            roots.append(Path(os.path.expandvars(value)).expanduser())
    normalized = []
    seen = set()
    for root in roots:
        if (root / "models" / "diffusion_models").is_dir():
            root = root / "models"
        key = os.path.normcase(str(root.resolve()))
        if key not in seen:
            normalized.append(root.resolve())
            seen.add(key)
    return normalized


class WorkbenchDoctor:
    def __init__(self, workbench_root, comfy_root, projects_root, comfy_url="http://127.0.0.1:8188",
                 workbench_port=8790, model_roots=None, runtime=None, timeout=3):
        self.workbench_root = Path(workbench_root).resolve()
        self.comfy_root = Path(comfy_root).resolve()
        self.projects_root = Path(projects_root).resolve()
        self.comfy_url = comfy_url.rstrip("/")
        self.workbench_port = int(workbench_port)
        self.model_roots = [Path(path).resolve() for path in model_roots] if model_roots else _configured_model_roots(self.comfy_root)
        self.runtime = Path(runtime).resolve() if runtime else runtime_dir()
        self.timeout = timeout

    def _json_url(self, path, timeout=None):
        with urllib.request.urlopen(self.comfy_url + path, timeout=timeout or self.timeout) as response:
            return json.load(response)

    def _comfy_port(self):
        parsed = urllib.parse.urlsplit(self.comfy_url)
        return parsed.port or (443 if parsed.scheme == "https" else 80)

    @staticmethod
    def _port_listening(port):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            return sock.connect_ex(("127.0.0.1", int(port))) == 0

    def _system_check(self):
        return _check("os", "操作系统", "ok", f"{platform.system()} {platform.release()} · {platform.machine()}", data={
            "platform": platform.platform(), "python": platform.python_version(), "appVersion": APP_VERSION,
        })

    def _disk_checks(self):
        targets = [("项目目录", self.projects_root), ("ComfyUI", self.comfy_root)]
        targets.extend((f"模型目录 {index + 1}", root) for index, root in enumerate(self.model_roots))
        checks = []
        seen = set()
        for label, path in targets:
            anchor = path
            while not anchor.exists() and anchor != anchor.parent:
                anchor = anchor.parent
            key = os.path.normcase(anchor.drive or str(anchor))
            if key in seen:
                continue
            seen.add(key)
            try:
                usage = shutil.disk_usage(anchor)
                free_gib = usage.free / 1024 ** 3
                checks.append(_check("disk", "磁盘空间", "warning" if free_gib < 20 else "ok",
                    f"{anchor.drive or str(anchor)} 可用 {free_gib:.1f} GiB / 共 {usage.total / 1024 ** 3:.1f} GiB",
                    path=str(anchor), freeBytes=usage.free, totalBytes=usage.total, labelPrefix=label))
            except OSError as exc:
                checks.append(_check("disk", "磁盘空间", "error", f"无法读取 {anchor}：{exc}", path=str(anchor)))
        return checks

    def _write_check(self):
        if not self.projects_root.is_dir():
            return _check("write", "项目目录写权限", "error", f"目录不存在：{self.projects_root}", path=str(self.projects_root))
        probe = None
        try:
            with tempfile.NamedTemporaryFile(mode="wb", prefix=".h3-doctor-", suffix=".tmp", dir=self.projects_root, delete=False) as handle:
                probe = Path(handle.name)
                handle.write(b"write-test")
                handle.flush()
                os.fsync(handle.fileno())
            return _check("write", "项目目录写权限", "ok", "临时探针写入并清理成功。", path=str(self.projects_root))
        except OSError as exc:
            return _check("write", "项目目录写权限", "error", f"无法写入：{exc}", path=str(self.projects_root))
        finally:
            if probe:
                probe.unlink(missing_ok=True)

    def _port_check(self, name, port, required=True):
        listening = self._port_listening(port)
        status = "ok" if listening else "error" if required else "warning"
        return _check("port", f"{name} 端口", status,
            f"127.0.0.1:{port} {'正在监听' if listening else '未监听'}", port=port, listening=listening)

    def _comfy_check(self):
        try:
            stats = self._json_url("/system_stats")
            system = stats.get("system", {}) if isinstance(stats, dict) else {}
            version = system.get("comfyui_version") or stats.get("comfyui_version") or "未知"
            return _check("comfy", "ComfyUI", "ok", f"在线 · 版本 {version}", version=str(version)), stats
        except (OSError, ValueError, TypeError, json.JSONDecodeError, urllib.error.URLError) as exc:
            detail = "无法连接；请检查 ComfyUI 是否启动，以及 8188 是否被其他程序占用。"
            return _check("comfy", "ComfyUI", "error", f"{detail}（{type(exc).__name__}）"), None

    def _required_node_types(self):
        try:
            source = (self.workbench_root / "src" / "workbench-api.js").read_text(encoding="utf-8")
        except OSError:
            return set()
        return set(re.findall(r"class_type:\s*['\"]([^'\"]+)", source))

    def _nodes_check(self):
        custom_nodes = self.comfy_root / "ComfyUI" / "custom_nodes"
        missing_directories = [name for name in NODE_DIRS if not (custom_nodes / name).is_dir()]
        required = self._required_node_types()
        registered = set()
        online_error = None
        try:
            registered = set(self._json_url("/object_info", timeout=max(self.timeout, 10)))
        except (OSError, ValueError, TypeError, json.JSONDecodeError, urllib.error.URLError) as exc:
            online_error = type(exc).__name__
        missing_registered = sorted(required - registered) if not online_error else []
        problems = []
        if missing_directories:
            problems.append(f"缺少 {len(missing_directories)} 个节点目录")
        if online_error:
            problems.append("无法读取在线注册信息")
        elif missing_registered:
            problems.append(f"{len(missing_registered)} 个工作流节点未注册")
        status = "error" if problems else "ok"
        detail = "；".join(problems) if problems else f"目录齐全，工作流所需 {len(required)} 个节点均已注册。"
        return _check("nodes", "节点目录与注册", status, detail,
                      requiredCount=len(required), registeredCount=len(required & registered),
                      missingDirectories=missing_directories, missingRegistered=missing_registered,
                      onlineError=online_error)

    def _models_check(self):
        manifest_path = self.workbench_root / "models" / "manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            return _check("models", "模型清单", "error", f"无法读取模型清单：{exc}")
        missing, mismatched = [], []
        found = 0
        for item in manifest.get("files", []):
            try:
                relative = _safe_relative(item["path"])
            except (KeyError, ValueError) as exc:
                mismatched.append({"path": str(item.get("path", "")), "error": str(exc)})
                continue
            candidates = [root / relative for root in self.model_roots]
            files = [path for path in candidates if path.is_file()]
            if not files:
                missing.append(item["path"])
                continue
            if not any(path.stat().st_size == int(item["bytes"]) for path in files):
                mismatched.append({"path": item["path"], "expectedBytes": int(item["bytes"]),
                                   "actualBytes": [path.stat().st_size for path in files]})
                continue
            found += 1
        total = len(manifest.get("files", []))
        problems = []
        if missing:
            problems.append(f"缺失 {len(missing)} 个")
        if mismatched:
            problems.append(f"大小不符 {len(mismatched)} 个")
        return _check("models", "模型与 LoRA", "error" if problems else "ok",
            f"已验证 {found}/{total} 个文件" + (f"；{'；'.join(problems)}" if problems else "。"),
            total=total, found=found, roots=[str(root) for root in self.model_roots],
            missing=missing, mismatched=mismatched)

    def _deepseek_key(self):
        return read_deepseek_key(self.workbench_root)[0]

    def _deepseek_check(self, check_connectivity):
        key = self._deepseek_key()
        if not key:
            return _check("deepseek", "DeepSeek", "warning", "未配置；本地生成不受影响。" if not check_connectivity else "未配置，无法执行连通性测试。", configured=False, connectivity="not_checked")
        if not check_connectivity:
            return _check("deepseek", "DeepSeek", "ok", "已配置；未发起外部请求。", configured=True, connectivity="not_checked")
        request = urllib.request.Request("https://api.deepseek.com/models", headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=min(self.timeout, 10)) as response:
                if 200 <= response.status < 300:
                    return _check("deepseek", "DeepSeek", "ok", "密钥已配置，连通性测试通过。", configured=True, connectivity="ok")
            return _check("deepseek", "DeepSeek", "error", "连通性测试未通过。", configured=True, connectivity="error")
        except urllib.error.HTTPError as exc:
            return _check("deepseek", "DeepSeek", "error", f"服务返回 HTTP {exc.code}；请检查密钥、额度或网络。", configured=True, connectivity="error", httpStatus=exc.code)
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            return _check("deepseek", "DeepSeek", "error", f"连接失败（{type(exc).__name__}）。", configured=True, connectivity="error")

    def run(self, browser=None, check_deepseek=False):
        checks = [self._system_check()]
        checks.extend(self._disk_checks())
        checks.append(self._write_check())
        checks.append(self._port_check("工作台", self.workbench_port))
        checks.append(self._port_check("ComfyUI", self._comfy_port()))
        comfy, _ = self._comfy_check()
        checks.extend([comfy, self._nodes_check(), self._models_check(), self._deepseek_check(bool(check_deepseek))])
        errors = sum(item["status"] == "error" for item in checks)
        warnings = sum(item["status"] == "warning" for item in checks)
        status = "error" if errors else "warning" if warnings else "ok"
        summary = "诊断通过，未发现阻断问题。" if status == "ok" else f"发现 {errors} 项错误、{warnings} 项提醒。"
        safe_browser = {"userAgent": str((browser or {}).get("userAgent") or "未提供")[:500]}
        return {
            "formatVersion": 1, "appVersion": APP_VERSION, "generatedAt": utc_now(), "status": status,
            "summary": summary, "errorCount": errors, "warningCount": warnings, "browser": safe_browser, "checks": checks,
        }

    def create_log_bundle(self, report):
        """Build a credential-redacted ZIP in memory; never include projects or instance.json."""
        key = self._deepseek_key()
        secrets = [key] if key else []
        output = io.BytesIO()
        log_dir = self.runtime / "logs"
        logs = sorted(log_dir.glob("*.log"), key=lambda path: path.stat().st_mtime, reverse=True)[:8] if log_dir.is_dir() else []
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("doctor.json", redacted_json(report, secrets))
            archive.writestr("README.txt", "Refmuse 本地工作台诊断包。仅含脱敏诊断与运行日志，不含项目、素材、模型、Cookie、instance.json 或密钥。\n")
            remaining = 8 * 1024 * 1024
            for path in logs:
                if remaining <= 0:
                    break
                try:
                    with path.open("rb") as handle:
                        handle.seek(0, os.SEEK_END)
                        size = handle.tell()
                        handle.seek(max(0, size - min(2 * 1024 * 1024, remaining)))
                        content = handle.read().decode("utf-8", errors="replace")
                    redacted = redact_text(content, secrets)
                    encoded = redacted.encode("utf-8")[:remaining]
                    archive.writestr(f"logs/{path.name}", encoded)
                    remaining -= len(encoded)
                except OSError:
                    continue
        return output.getvalue()
