from __future__ import annotations

import ast
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from workbench_lifecycle import APP_VERSION, atomic_write_json, runtime_dir, utc_now

LOGGER = logging.getLogger("h3-workbench.update")
REPOSITORY = "YYU666/comfyui-infinite-canvas"
RELEASE_API = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
RELEASE_PAGE = f"https://github.com/{REPOSITORY}/releases"
MAX_RELEASE_BYTES = 2 * 1024 * 1024
MAX_PACKAGE_BYTES = 128 * 1024 * 1024
MAX_UNPACKED_BYTES = 256 * 1024 * 1024
MAX_PACKAGE_FILES = 2500
VERSION_PATTERN = re.compile(r"^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
ACTIVE_PHASES = {"preparing", "restarting"}


class UpdateError(Exception):
    def __init__(self, message, status=400, code="UPDATE_ERROR"):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def parse_version(value):
    if not isinstance(value, str):
        raise UpdateError("Release 版本号无效。", code="INVALID_RELEASE")
    match = VERSION_PATTERN.fullmatch(value.strip())
    if not match:
        raise UpdateError("Release 必须使用语义化版本号，例如 v1.1.0。", code="INVALID_RELEASE")
    prerelease = []
    if match.group(4):
        for item in match.group(4).split("."):
            if not item or (item.isdigit() and len(item) > 1 and item.startswith("0")):
                raise UpdateError("Release 预发布版本号无效。", code="INVALID_RELEASE")
            prerelease.append(int(item) if item.isdigit() else item)
    return tuple(int(match.group(index)) for index in (1, 2, 3)), prerelease


def compare_versions(left, right):
    left_core, left_pre = parse_version(left)
    right_core, right_pre = parse_version(right)
    if left_core != right_core:
        return (left_core > right_core) - (left_core < right_core)
    if not left_pre or not right_pre:
        if not left_pre and not right_pre:
            return 0
        return -1 if left_pre else 1
    for left_item, right_item in zip(left_pre, right_pre):
        if left_item == right_item:
            continue
        if isinstance(left_item, int) != isinstance(right_item, int):
            return -1 if isinstance(left_item, int) else 1
        return (left_item > right_item) - (left_item < right_item)
    return (len(left_pre) > len(right_pre)) - (len(left_pre) < len(right_pre))


def asset_name(tag):
    return f"refmuse-update-{tag}.zip"


def _safe_relative_path(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise UpdateError("更新包包含无效路径。", code="UNSAFE_PACKAGE")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts) or re.match(r"^[A-Za-z]:", value):
        raise UpdateError("更新包包含越界路径，已停止升级。", code="UNSAFE_PACKAGE")
    return path


def _read_limited(response, limit):
    data = response.read(limit + 1)
    if len(data) > limit:
        raise UpdateError("远程响应超过安全大小限制。", status=502, code="INVALID_RELEASE")
    return data


class WorkbenchUpdateManager:
    def __init__(self, root, preflight, opener=None, runner=None, process_launcher=None, update_root=None):
        self.root = Path(root).resolve()
        self.preflight = preflight
        self.opener = opener or urllib.request.urlopen
        self.runner = runner or subprocess.run
        self.process_launcher = process_launcher or subprocess.Popen
        self.update_root = Path(update_root).resolve() if update_root else runtime_dir() / "updates"
        self.status_path = self.update_root / "status.json"
        self.installation_root = os.path.normcase(str(self.root))
        installation_id = hashlib.sha256(self.installation_root.encode("utf-8")).hexdigest()[:24]
        self.installed_manifest_path = self.update_root / "installations" / installation_id / "installed-files.json"
        self._lock = threading.Lock()
        self._state = {"phase": "idle", "message": ""}
        self._last_check = None

    def _set_state(self, phase, message="", **extra):
        with self._lock:
            self._state = {"phase": phase, "message": message, "updatedAt": utc_now(), **extra}
        if phase in {"error", "success"}:
            try:
                atomic_write_json(self.status_path, self._state)
            except OSError:
                LOGGER.exception("无法写入更新状态。")

    def status(self):
        with self._lock:
            result = dict(self._state)
        result["currentVersion"] = APP_VERSION
        if result["phase"] == "idle":
            try:
                persisted = json.loads(self.status_path.read_text(encoding="utf-8"))
                if isinstance(persisted, dict):
                    result["lastResult"] = persisted
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass
        if self._last_check:
            result["check"] = self._last_check
        return result

    def _open(self, request, timeout):
        return self.opener(request, timeout=timeout)

    def _fetch_release(self):
        request = urllib.request.Request(RELEASE_API, headers={
            "Accept": "application/vnd.github+json", "User-Agent": "Refmuse-Local-Workbench",
            "X-GitHub-Api-Version": "2022-11-28",
        })
        try:
            with self._open(request, 10) as response:
                release = json.loads(_read_limited(response, MAX_RELEASE_BYTES).decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise UpdateError("官方仓库尚未发布可用的正式版本。代码提交不会直接触发更新通知。", status=404, code="NO_RELEASE") from exc
            raise UpdateError("暂时无法连接 GitHub Release，请稍后重试。", status=503, code="UPDATE_UNAVAILABLE") from exc
        except (OSError, urllib.error.URLError, TimeoutError, UnicodeError, json.JSONDecodeError) as exc:
            raise UpdateError("暂时无法连接 GitHub Release，请稍后重试。", status=503, code="UPDATE_UNAVAILABLE") from exc
        if not isinstance(release, dict) or release.get("draft") is True:
            raise UpdateError("GitHub 返回了无效的 Release。", status=502, code="INVALID_RELEASE")
        tag = release.get("tag_name")
        parse_version(tag)
        assets = release.get("assets")
        if not isinstance(assets, list):
            raise UpdateError("Release 资源清单无效。", status=502, code="INVALID_RELEASE")
        package = next((item for item in assets if isinstance(item, dict) and item.get("name") == asset_name(tag)), None)
        checksum = next((item for item in assets if isinstance(item, dict) and item.get("name") == asset_name(tag) + ".sha256"), None)
        return {
            "currentVersion": APP_VERSION,
            "version": tag,
            "name": str(release.get("name") or tag)[:160],
            "notes": str(release.get("body") or "")[:30000],
            "url": str(release.get("html_url") or RELEASE_PAGE),
            "publishedAt": release.get("published_at"),
            "updateAvailable": compare_versions(tag, APP_VERSION) > 0,
            "canApply": bool(package and checksum),
            "package": package,
            "checksum": checksum,
        }

    def check(self):
        if os.environ.get("H3_WORKBENCH_TEST_MODE") == "1" and self.opener is urllib.request.urlopen:
            return {"currentVersion": APP_VERSION, "status": "unavailable", "updateAvailable": False, "message": "隔离测试模式不访问 GitHub。"}
        try:
            release = self._fetch_release()
        except UpdateError as exc:
            result = {"currentVersion": APP_VERSION, "status": "no_release" if exc.code == "NO_RELEASE" else "unavailable",
                      "updateAvailable": False, "message": exc.message}
            self._last_check = result
            return result
        package = release.pop("package")
        checksum = release.pop("checksum")
        if release["updateAvailable"] and not release["canApply"]:
            release["message"] = "此 Release 缺少安全升级包或校验文件，请使用 Release 页面手动更新。"
        result = {**release, "status": "ready", "packageName": package.get("name") if package else None, "checksumName": checksum.get("name") if checksum else None}
        self._last_check = result
        return result

    def _download(self, asset, destination, limit):
        if not isinstance(asset, dict):
            raise UpdateError("此 Release 没有安全升级所需的资源。", code="PACKAGE_MISSING")
        url = asset.get("browser_download_url")
        parsed = urllib.parse.urlparse(url if isinstance(url, str) else "")
        if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username or parsed.password:
            raise UpdateError("升级包下载地址不受信任。", status=502, code="INVALID_RELEASE")
        request = urllib.request.Request(url, headers={"Accept": "application/octet-stream", "User-Agent": "Refmuse-Local-Workbench"})
        try:
            with self._open(request, 30) as response, destination.open("wb") as handle:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    handle.write(chunk)
                    if handle.tell() > limit:
                        raise UpdateError("升级包超过安全大小限制。", code="PACKAGE_TOO_LARGE")
        except UpdateError:
            destination.unlink(missing_ok=True)
            raise
        except (OSError, urllib.error.URLError, TimeoutError) as exc:
            destination.unlink(missing_ok=True)
            raise UpdateError("升级包下载失败，请检查网络后重试。", status=503, code="DOWNLOAD_FAILED") from exc

    def _verify_package(self, archive, checksum_path, tag, destination):
        try:
            checksum_text = checksum_path.read_text(encoding="ascii")
        except (OSError, UnicodeError) as exc:
            raise UpdateError("升级包校验文件无法读取。", code="CHECKSUM_INVALID") from exc
        match = re.match(r"^([0-9a-fA-F]{64})(?:\s|$)", checksum_text.strip())
        if not match:
            raise UpdateError("升级包 SHA256 文件格式无效。", code="CHECKSUM_INVALID")
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if digest != match.group(1).lower():
            raise UpdateError("升级包 SHA256 不匹配，已删除下载内容。", code="CHECKSUM_MISMATCH")
        try:
            with zipfile.ZipFile(archive) as package:
                infos = package.infolist()
                if len(infos) > MAX_PACKAGE_FILES:
                    raise UpdateError("升级包文件数量异常。", code="UNSAFE_PACKAGE")
                total = 0
                for info in infos:
                    _safe_relative_path(info.filename)
                    if info.is_dir():
                        continue
                    if ((info.external_attr >> 16) & 0o170000) == 0o120000:
                        raise UpdateError("升级包不允许包含符号链接。", code="UNSAFE_PACKAGE")
                    total += info.file_size
                    if total > MAX_UNPACKED_BYTES or info.file_size > MAX_UNPACKED_BYTES:
                        raise UpdateError("升级包解压后超过安全大小限制。", code="UNSAFE_PACKAGE")
                manifest_info = next((info for info in infos if info.filename == "release-files.json"), None)
                if manifest_info is None or manifest_info.file_size > MAX_RELEASE_BYTES:
                    raise UpdateError("升级包缺少有效文件清单。", code="PACKAGE_INVALID")
                manifest = json.loads(package.read(manifest_info).decode("utf-8"))
                self._validate_manifest(manifest, tag)
                expected = {item["path"]: item["sha256"] for item in manifest["files"]}
                actual = {info.filename for info in infos if not info.is_dir() and info.filename != "release-files.json"}
                if actual != set(expected):
                    raise UpdateError("升级包内容与文件清单不一致。", code="PACKAGE_INVALID")
                for info in infos:
                    if info.is_dir() or info.filename == "release-files.json":
                        continue
                    target = destination.joinpath(*PurePosixPath(info.filename).parts)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    hasher = hashlib.sha256()
                    with package.open(info) as source, target.open("wb") as output:
                        while True:
                            chunk = source.read(1024 * 1024)
                            if not chunk:
                                break
                            output.write(chunk)
                            hasher.update(chunk)
                    if hasher.hexdigest() != expected[info.filename]:
                        raise UpdateError("升级包文件哈希不匹配。", code="PACKAGE_INVALID")
        except UpdateError:
            raise
        except (OSError, KeyError, UnicodeError, json.JSONDecodeError, zipfile.BadZipFile, NotImplementedError) as exc:
            raise UpdateError("升级包损坏或格式不受支持。", code="PACKAGE_INVALID") from exc
        self._validate_staged_version(destination, tag)
        atomic_write_json(destination / ".package-manifest.json", manifest)
        return destination / ".package-manifest.json"

    @staticmethod
    def _validate_manifest(manifest, tag):
        if not isinstance(manifest, dict) or manifest.get("version") != tag or not isinstance(manifest.get("files"), list):
            raise UpdateError("升级包清单版本不一致。", code="PACKAGE_INVALID")
        if not manifest["files"] or len(manifest["files"]) > MAX_PACKAGE_FILES:
            raise UpdateError("升级包文件清单为空或过大。", code="PACKAGE_INVALID")
        seen = set()
        for item in manifest["files"]:
            if not isinstance(item, dict):
                raise UpdateError("升级包文件清单无效。", code="PACKAGE_INVALID")
            path = str(_safe_relative_path(item.get("path")))
            if path in seen or not re.fullmatch(r"[0-9a-f]{64}", item.get("sha256", "")):
                raise UpdateError("升级包文件清单包含重复路径或无效哈希。", code="PACKAGE_INVALID")
            seen.add(path)
        required = {"video_workbench_launcher.py", "workbench_update.py", "workbench_update_helper.py", "workbench_lifecycle.py", "package.json", "package-lock.json", "requirements.lock"}
        if not required.issubset(seen):
            raise UpdateError("升级包缺少工作台必需程序文件。", code="PACKAGE_INVALID")

    @staticmethod
    def _validate_staged_version(source, tag):
        expected = parse_version(tag)
        try:
            package = json.loads((source / "package.json").read_text(encoding="utf-8"))
            tree = ast.parse((source / "workbench_lifecycle.py").read_text(encoding="utf-8"))
            version = next((ast.literal_eval(node.value) for node in tree.body if isinstance(node, ast.Assign)
                            and any(isinstance(target, ast.Name) and target.id == "APP_VERSION" for target in node.targets)), None)
        except (OSError, UnicodeError, json.JSONDecodeError, SyntaxError, ValueError, StopIteration) as exc:
            raise UpdateError("无法验证升级包程序版本。", code="PACKAGE_INVALID") from exc
        if package.get("version") != tag.lstrip("v") or parse_version(version) != expected:
            raise UpdateError("升级包程序版本与 Release 标签不一致。", code="PACKAGE_INVALID")

    def _git_clean(self):
        installed = None
        if self.installed_manifest_path.exists():
            try:
                installed = json.loads(self.installed_manifest_path.read_text(encoding="utf-8"))
                if installed.get("installationRoot") != self.installation_root:
                    raise ValueError("different installation")
                self._validate_manifest(installed, installed.get("version"))
                from workbench_update_helper import safe_path
                for item in installed["files"]:
                    path = safe_path(self.root, item["path"])
                    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                        raise ValueError("locally modified installed file")
            except (OSError, ValueError, TypeError, AttributeError, RuntimeError, UpdateError) as exc:
                raise UpdateError("已安装程序与本机更新记录不一致。请先备份本地修改，再升级。", status=409, code="LOCAL_CHANGES") from exc
        if not (self.root / ".git").exists():
            return
        git = shutil.which("git")
        if not git:
            raise UpdateError("无法检查本地代码修改，已停止升级。", code="LOCAL_CHANGES")
        result = self.runner([git, "-C", str(self.root), "status", "--porcelain", "-z", "--untracked-files=no"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, check=False)
        if result.returncode:
            raise UpdateError("无法确认本地代码状态，已停止升级。", code="LOCAL_CHANGES")
        if result.stdout.strip():
            owned = {item["path"] for item in installed["files"]} if installed else set()
            # An updater replaces files without rewriting the user's Git index.
            # Only exact installed hashes and known removed paths are eligible.
            changes = result.stdout.rstrip("\0").split("\0")
            for change in changes:
                kind, path = change[:3], change[3:]
                if installed and ((kind == " M " and path in owned)
                                  or (kind == " D " and path not in owned and not self.root.joinpath(path).exists())):
                    continue
                raise UpdateError("工作台程序有本地代码修改。请先备份或提交修改，再升级。", status=409, code="LOCAL_CHANGES")

    def _run_stage(self, command, timeout, label):
        try:
            result = self.runner(command, cwd=self.root, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise UpdateError(f"{label}失败，旧版尚未替换。", status=503, code="PREPARE_FAILED") from exc
        if result.returncode:
            LOGGER.error("更新准备失败（%s）：%s", label, (result.stderr or result.stdout or "")[-3000:])
            raise UpdateError(f"{label}失败，旧版尚未替换。请查看运行日志。", status=503, code="PREPARE_FAILED")

    def _prepare_frontend(self, source):
        npm = shutil.which("npm")
        if not npm:
            raise UpdateError("没有找到 Node.js／npm，无法准备新版画布。", status=503, code="PREPARE_FAILED")
        original_root = self.root
        try:
            self.root = source
            self._set_state("preparing", "正在安装新版画布依赖…")
            self._run_stage([npm, "ci", "--no-audit", "--no-fund"], 900, "画布依赖安装")
            self._set_state("preparing", "正在构建新版画布…")
            self._run_stage([npm, "run", "build"], 300, "新版画布构建")
        finally:
            self.root = original_root
        if not (source / "dist" / "index.html").is_file():
            raise UpdateError("新版画布构建结果不完整。", code="PREPARE_FAILED")

    def apply(self, tag):
        with self._lock:
            if self._state["phase"] in ACTIVE_PHASES:
                raise UpdateError("已经有一个升级操作正在进行。", status=409, code="UPDATE_BUSY")
            # Reserve the entire preparation, including slow preflight/network IO.
            self._state = {"phase": "preparing", "message": "正在检查升级条件…", "version": tag, "updatedAt": utc_now()}
        try:
            return self._prepare_update(tag)
        except Exception as exc:
            if self.status()["phase"] != "error":
                self._set_state("error", exc.message if isinstance(exc, UpdateError) else "更新准备失败，旧版尚未替换。", version=tag)
            if isinstance(exc, UpdateError):
                raise
            LOGGER.exception("更新准备失败：%s", exc)
            raise UpdateError("更新准备失败，旧版尚未替换。", status=500, code="PREPARE_FAILED") from exc

    def _prepare_update(self, tag):
        self.preflight()
        self._git_clean()
        checked = self.check()
        if not checked.get("updateAvailable") or checked.get("version") != tag or not checked.get("canApply"):
            raise UpdateError("Release 已变化或没有可安全升级的新版，请重新检查。", status=409, code="RELEASE_CHANGED")
        # Re-fetch the authenticated release metadata used for the actual download; do not trust client URLs.
        release = self._fetch_release()
        if release["version"] != tag or not release["package"] or not release["checksum"]:
            raise UpdateError("Release 升级资源已变化，请重新检查。", status=409, code="RELEASE_CHANGED")
        self.update_root.mkdir(parents=True, exist_ok=True)
        workspace = Path(tempfile.mkdtemp(prefix="prepare-", dir=self.update_root))
        archive = workspace / "update.zip"
        checksum = workspace / "update.sha256"
        source = workspace / "source"
        source.mkdir()
        try:
            self._set_state("preparing", "正在下载并校验更新包…", version=tag)
            self._download(release["package"], archive, MAX_PACKAGE_BYTES)
            self._download(release["checksum"], checksum, 4096)
            manifest = self._verify_package(archive, checksum, tag, source)
            archive.unlink(missing_ok=True)
            checksum.unlink(missing_ok=True)
            self._prepare_frontend(source)
            self.preflight()
            self._git_clean()
            helper = workspace / "workbench_update_helper.py"
            shutil.copy2(Path(__file__).with_name("workbench_update_helper.py"), helper)
            backup = workspace / "backup"
            request_path = workspace / "request.json"
            atomic_write_json(request_path, {
                "root": str(self.root), "source": str(source), "backup": str(backup),
                "runtimeDir": str(runtime_dir()), "expectedPid": os.getpid(), "targetVersion": tag,
                "manifest": str(manifest), "installedManifest": str(self.installed_manifest_path),
                "status": str(self.status_path), "python": str(Path(sys.executable).resolve()),
            })
            self._set_state("restarting", "更新已准备好，工作台即将重启…", version=tag)
            flags = (subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == "nt" else 0
            process = self.process_launcher([str(Path(sys.executable).resolve()), "-s", str(helper), "--request", str(request_path)],
                                            cwd=workspace, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                            close_fds=True, creationflags=flags, start_new_session=os.name != "nt")
            return {"accepted": True, "version": tag, "helperPid": process.pid, "message": "更新已准备好，工作台将重启并自动恢复。"}
        except Exception as exc:
            shutil.rmtree(workspace, ignore_errors=True)
            self._set_state("error", exc.message if isinstance(exc, UpdateError) else "更新准备失败，旧版尚未替换。", version=tag)
            if isinstance(exc, UpdateError):
                raise
            LOGGER.exception("更新准备失败：%s", exc)
            raise UpdateError("更新准备失败，旧版尚未替换。", status=500, code="PREPARE_FAILED") from exc


def validate_update_request(payload):
    if not isinstance(payload, dict) or set(payload) != {"tag"} or not isinstance(payload.get("tag"), str) or len(payload["tag"]) > 80:
        raise UpdateError("升级请求必须只包含本次确认的 Release 标签。", code="BAD_REQUEST")
    parse_version(payload["tag"])
    return payload["tag"]
