from __future__ import annotations

import copy
import json
import os
import stat
import subprocess
from pathlib import Path

from workbench_lifecycle import atomic_write_json, runtime_dir

RATIOS = {"16:9", "9:16", "1:1", "4:3", "3:4", "21:9"}
RESOLUTIONS = {"480P", "720P", "1080P"}
LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR"}


class SettingsError(Exception):
    def __init__(self, message, status=400, code="BAD_REQUEST"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def _optional_keyring():
    try:
        import keyring
        return keyring
    except ImportError:
        return None


def _key_file(workbench_root=None):
    candidates = [Path.home() / ".h3" / "deepseek.key"]
    if workbench_root:
        candidates.append(Path(workbench_root) / "deepseek.key")
    return candidates


def read_deepseek_key(workbench_root=None):
    configured = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if configured:
        return configured, "environment"
    manager = _optional_keyring()
    if manager:
        try:
            configured = (manager.get_password("H3Workbench", "DeepSeek") or "").strip()
            if configured:
                return configured, "keyring"
        except Exception:
            pass
    for path in _key_file(workbench_root):
        try:
            if path.is_file():
                configured = path.read_text(encoding="utf-8-sig").strip()
                if configured:
                    return configured, "file"
        except OSError:
            continue
    return None, "none"


def deepseek_status(workbench_root=None):
    _, source = read_deepseek_key(workbench_root)
    return {
        "configured": source != "none", "source": source,
        "warning": "当前使用文件存储；请确认密钥文件仅当前用户可读。" if source == "file" else None,
    }


def _restrict_key_file(path):
    if os.name != "nt":
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
        return
    domain = os.environ.get("USERDOMAIN", "")
    user = os.environ.get("USERNAME", "")
    account = f"{domain}\\{user}" if domain and user else user
    if not account:
        raise RuntimeError("无法确认当前 Windows 用户，未保存密钥。")
    result = subprocess.run(
        ["icacls", str(path), "/inheritance:r", "/grant:r", f"{account}:(F)"],
        capture_output=True, text=True, encoding="mbcs", errors="replace", timeout=10, check=False,
    )
    if result.returncode:
        raise RuntimeError("无法限制密钥文件权限，已删除未受保护的文件。")


def save_deepseek_key(value):
    key = str(value or "").strip()
    if not 8 <= len(key) <= 512 or any(character.isspace() for character in key):
        raise SettingsError("DeepSeek Key 格式无效；不会回显或写入配置 JSON。")
    manager = _optional_keyring()
    if manager:
        try:
            manager.set_password("H3Workbench", "DeepSeek", key)
            return deepseek_status()
        except Exception:
            pass
    path = Path.home() / ".h3" / "deepseek.key"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".deepseek-{os.getpid()}.tmp")
    try:
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(key + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        try:
            _restrict_key_file(path)
        except Exception:
            path.unlink(missing_ok=True)
            raise
    finally:
        temporary.unlink(missing_ok=True)
    return deepseek_status()


def _absolute_path(value, label):
    if not isinstance(value, str) or not value.strip():
        raise SettingsError(f"{label}不能为空。")
    path = Path(value.strip()).expanduser()
    if not path.is_absolute():
        raise SettingsError(f"{label}必须使用绝对路径。")
    return str(path.resolve())


class WorkbenchSettings:
    def __init__(self, path=None, comfy_root=None, projects_root=None):
        self.path = Path(path).resolve() if path else runtime_dir() / "config.json"
        default_comfy = comfy_root or os.environ.get("H3_COMFY_ROOT") or str(Path(__file__).resolve().parent.parent)
        default_projects = projects_root or os.environ.get("H3_PROJECTS_ROOT") or str(Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Documents" / "H3 Workbench")
        self.defaults = {
            "projectsRoot": str(Path(default_projects).resolve()),
            "comfyRoot": str(Path(default_comfy).resolve()),
            "modelRoots": [],
            "queue": {"concurrency": 1},
            "defaults": {"ratio": "16:9", "resolution": "480P", "duration": 5},
            "notifications": True,
            "updates": {"autoCheck": True},
            "logLevel": "INFO",
            "language": "zh-CN",
        }
        self.data = copy.deepcopy(self.defaults)

    def load(self):
        try:
            stored = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.data = copy.deepcopy(self.defaults)
            return self.public()
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"config.json 无法读取，未覆盖原配置：{exc}") from exc
        if not isinstance(stored, dict):
            raise RuntimeError("config.json 必须是 JSON 对象，未覆盖原配置。")
        self.data = self._validated(self._merge(self.defaults, stored))
        return self.public()

    @staticmethod
    def _merge(base, updates):
        result = copy.deepcopy(base)
        for key, value in updates.items():
            if key in result and isinstance(result[key], dict) and isinstance(value, dict):
                result[key].update(value)
            elif key in result:
                result[key] = value
        return result

    def _validated(self, candidate):
        candidate = copy.deepcopy(candidate)
        candidate["projectsRoot"] = _absolute_path(candidate.get("projectsRoot"), "项目根目录")
        candidate["comfyRoot"] = _absolute_path(candidate.get("comfyRoot"), "ComfyUI 根目录")
        roots = candidate.get("modelRoots")
        if not isinstance(roots, list) or len(roots) > 16:
            raise SettingsError("模型根目录必须是最多 16 项的路径列表。")
        candidate["modelRoots"] = list(dict.fromkeys(_absolute_path(path, "模型根目录") for path in roots))
        try:
            concurrency = candidate["queue"]["concurrency"]
            duration = candidate["defaults"]["duration"]
        except (KeyError, TypeError) as exc:
            raise SettingsError("队列或默认生成参数不完整。") from exc
        if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency not in (1, 2):
            raise SettingsError("队列并发只能设置为 1 或 2。")
        if isinstance(duration, bool) or not isinstance(duration, int) or not 4 <= duration <= 15:
            raise SettingsError("默认时长必须是 4–15 秒的整数。")
        if candidate["defaults"].get("ratio") not in RATIOS:
            raise SettingsError("默认画面比例不受支持。")
        if candidate["defaults"].get("resolution") not in RESOLUTIONS:
            raise SettingsError("默认分辨率不受支持。")
        if not isinstance(candidate.get("notifications"), bool):
            raise SettingsError("通知开关必须是布尔值。")
        if not isinstance(candidate.get("updates"), dict) or not isinstance(candidate["updates"].get("autoCheck"), bool):
            raise SettingsError("启动时检查更新开关必须是布尔值。")
        if candidate.get("logLevel") not in LOG_LEVELS:
            raise SettingsError("日志级别不受支持。")
        candidate["language"] = "zh-CN"
        return candidate

    def public(self):
        result = copy.deepcopy(self.data)
        result["deepseek"] = deepseek_status()
        return result

    def update(self, payload, before_save=None):
        if not isinstance(payload, dict):
            raise SettingsError("设置请求必须是 JSON 对象。")
        candidate = self._validated(self._merge(self.data, payload))
        comfy = Path(candidate["comfyRoot"])
        if not (comfy / "ComfyUI" / "main.py").is_file():
            raise SettingsError("ComfyUI 根目录中未找到 ComfyUI/main.py。")
        if before_save:
            before_save(candidate)
        if "deepseekKey" in payload:
            save_deepseek_key(payload["deepseekKey"])
        atomic_write_json(self.path, candidate)
        self.data = candidate
        return self.public()
