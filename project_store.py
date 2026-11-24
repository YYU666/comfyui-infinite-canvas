from __future__ import annotations

import datetime as dt
import hashlib
import json
import mimetypes
import os
import re
import shutil
import stat
import threading
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from scripts.validate_project import validate_project
from workbench_lifecycle import APP_VERSION, atomic_write_json, utc_now

MAX_ASSET_BYTES = 2 * 1024 * 1024 * 1024
MAX_PROJECT_MEMBERS = 10000
ASSET_EXTENSIONS = {".glb", ".obj", ".fbx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".tga", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".aac"}
PROJECT_ID = re.compile(r"prj_[A-Za-z0-9_-]+")
INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


class StoreError(Exception):
    def __init__(self, code, message, status=400, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}


class RevisionConflict(StoreError):
    def __init__(self, revision, conflict):
        super().__init__("REVISION_CONFLICT", "项目已被其他窗口更新，修改已保存为冲突副本。", 409, {"revision": revision, "conflict": conflict})


HANDOFF_DEFAULT = {"status": "active", "agent": "", "objective": "", "acceptance": "", "notes": "", "updatedAt": None}
HANDOFF_LIMITS = {"agent": 80, "objective": 2000, "acceptance": 2000, "notes": 4000}


def handoff_state(document):
    stored = document.get("settings", {}).get("handoff", {})
    if not isinstance(stored, dict):
        stored = {}
    return {key: stored.get(key, value) for key, value in HANDOFF_DEFAULT.items()}


def update_handoff(document, changes, default_agent=None):
    if not isinstance(changes, dict):
        raise StoreError("BAD_REQUEST", "接力信息必须是对象。")
    unknown = set(changes) - set(HANDOFF_DEFAULT)
    if unknown:
        raise StoreError("BAD_REQUEST", f"不支持的接力字段：{', '.join(sorted(unknown))}")
    handoff = handoff_state(document)
    for key, limit in HANDOFF_LIMITS.items():
        if key not in changes:
            continue
        value = changes[key]
        if not isinstance(value, str):
            raise StoreError("BAD_REQUEST", f"接力字段 {key} 必须是字符串。")
        value = value.strip()
        if len(value) > limit:
            raise StoreError("BAD_REQUEST", f"接力字段 {key} 不能超过 {limit} 个字符。")
        handoff[key] = value
    if "status" in changes:
        if changes["status"] not in {"active", "paused"}:
            raise StoreError("BAD_REQUEST", "接力状态仅支持 active 或 paused。")
        handoff["status"] = changes["status"]
    if default_agent is not None and "agent" not in changes:
        if not isinstance(default_agent, str):
            raise StoreError("BAD_REQUEST", "agent 必须是字符串。")
        default_agent = default_agent.strip()
        if len(default_agent) > HANDOFF_LIMITS["agent"]:
            raise StoreError("BAD_REQUEST", "agent 不能超过 80 个字符。")
        handoff["agent"] = default_agent
    handoff["updatedAt"] = utc_now()
    document.setdefault("settings", {})["handoff"] = handoff
    return handoff


def default_projects_root():
    configured = os.environ.get("H3_PROJECTS_ROOT")
    if configured:
        return Path(configured)
    return Path(os.environ.get("USERPROFILE", str(Path.home()))) / "Documents" / "H3 Workbench"


def validate_name(name):
    name = str(name or "").strip()
    if not name or len(name) > 80 or INVALID_NAME.search(name) or name.endswith((" ", ".")) or name.split(".")[0].upper() in RESERVED_NAMES:
        raise StoreError("BAD_REQUEST", "项目名称不能为空，且不能包含 Windows 非法字符或以空格、点结尾。")
    return name


def new_document(name, canvas=None, template="blank", defaults=None):
    now = utc_now()
    settings = {"ratio": "16:9", "resolution": "480P", "duration": 5}
    if defaults:
        settings.update({key: defaults[key] for key in ("ratio", "resolution", "duration") if key in defaults})
    settings["template"] = template
    document = {
        "schemaVersion": 3,
        "id": f"prj_{uuid.uuid4().hex}",
        "name": validate_name(name),
        "revision": 1,
        "createdAt": now,
        "updatedAt": now,
        "appVersion": APP_VERSION,
        "settings": settings,
        "characters": [], "outfits": [], "locations": [], "shots": [],
        "canvas": canvas or {"nodes": [], "edges": [], "viewport": {"x": 0, "y": 0, "zoom": 1}},
        "assets": [],
    }
    from agent_handles import ensure_agent_handles
    ensure_agent_handles(document)
    return document


def _validated(document):
    errors = validate_project(document)
    if errors:
        raise StoreError("BAD_REQUEST", "project.json 校验失败，已拒绝打开或保存。", details={"errors": errors})
    return document


def _migrate(document):
    if not isinstance(document, dict):
        raise StoreError("BAD_REQUEST", "project.json 必须是项目对象。")
    if document.get("schemaVersion") == 3:
        from agent_handles import ensure_agent_handles
        _validated(document)
        changed = ensure_agent_handles(document)
        return _validated(document), changed
    if document.get("schemaVersion") not in (None, 1, 2):
        raise StoreError("BAD_REQUEST", "不支持的项目 schema 版本，未修改原文件。")
    canvas = document.get("canvas")
    if not isinstance(canvas, dict) or not isinstance(canvas.get("nodes"), list) or not isinstance(canvas.get("edges", []), list):
        raise StoreError("BAD_REQUEST", "旧项目缺少有效画布，未修改原文件。")
    now = utc_now()
    migrated = {
        "schemaVersion": 3,
        "id": str(document.get("id") or f"prj_{uuid.uuid4().hex}"),
        "name": validate_name(document.get("name") or "导入项目"),
        "revision": max(1, int(document.get("revision") or 0) + 1),
        "createdAt": _iso_time(document.get("createdAt")) or now,
        "updatedAt": now,
        "appVersion": APP_VERSION,
        "settings": {"ratio": "16:9", "resolution": "480P", "duration": 5},
        "characters": [], "outfits": [], "locations": [], "shots": [],
        "canvas": {"nodes": canvas["nodes"], "edges": canvas.get("edges", []), "viewport": canvas.get("viewport", {"x": 0, "y": 0, "zoom": 1})},
        "assets": document.get("assets", []),
    }
    if not migrated["id"].startswith("prj_"):
        migrated["id"] = f"prj_{uuid.uuid4().hex}"
    from agent_handles import ensure_agent_handles
    ensure_agent_handles(migrated)
    return _validated(migrated), True


def _iso_time(value):
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)):
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat()
    return None


def _writer_running(pid):
    if pid == os.getpid():
        return True
    if os.name == "nt":
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x00000102  # WAIT_TIMEOUT
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _process_dead(pid):
    """True only when the pid is confirmed gone. Access denied is not dead."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0 or pid == os.getpid():
        return False
    if os.name == "nt":
        import ctypes
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            return kernel.GetLastError() == 87  # ERROR_INVALID_PARAMETER: no such process
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0  # WAIT_OBJECT_0: exited
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    except OSError as exc:
        return getattr(exc, "errno", None) == 3  # ESRCH
    return False


def _read_project_json(path):
    # Windows can briefly deny a reader while another thread atomically replaces
    # project.json. Retry only that transient sharing violation, never bad JSON.
    for attempt in range(50):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except PermissionError:
            if attempt == 49:
                raise
            time.sleep(0.01)


def _safe_project_file(path):
    path = path.resolve()
    for temporary in path.parent.glob(f".{path.name}.*.tmp"):
        match = re.fullmatch(rf"\.{re.escape(path.name)}\.(\d+)(?:\.[0-9a-f]{{32}})?\.tmp", temporary.name)
        if match and not _writer_running(int(match.group(1))):
            # A killed writer cannot finish os.replace; its committed JSON and
            # backups remain intact, so only the abandoned temporary is removed.
            temporary.unlink(missing_ok=True)
    if not path.is_file():
        raise StoreError("NOT_FOUND", "项目不存在或尚未打开。", 404)
    try:
        document = _read_project_json(path)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise StoreError("BAD_REQUEST", f"project.json 无法读取：{exc}") from exc
    return path, document


class ProjectStore:
    def __init__(self, root=None, owner_id=None, defaults=None):
        self.root = Path(root or default_projects_root()).resolve()
        self.owner_id = owner_id or f"backend-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        self.defaults = dict(defaults or {})
        self._locks = {}
        self._locks_guard = threading.Lock()
        self._held = set()
        self._opened_paths = {}
        self._index_guard = threading.RLock()
        self._index_root = None
        self._index_files = {}
        self._index_paths = {}
        self._read_only = set()
        self._heartbeat_stop = threading.Event()
        self._heartbeat_thread = None

    def _guard(self, path):
        key = str(path.resolve()).lower()
        with self._locks_guard:
            return self._locks.setdefault(key, threading.RLock())

    @staticmethod
    def _index_stamp(path, kind, *, reject_unsafe=False):
        try:
            entry = path.lstat()
        except (FileNotFoundError, NotADirectoryError):
            return None
        # Do not implicitly follow symlinks or Windows directory junctions.
        if stat.S_ISLNK(entry.st_mode) or getattr(entry, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            if reject_unsafe:
                raise StoreError("BAD_REQUEST", "项目路径包含链接或重解析点。")
            return None
        if not kind(entry.st_mode):
            return None
        return entry.st_dev, entry.st_ino, entry.st_size, entry.st_mtime_ns, entry.st_ctime_ns

    @staticmethod
    def _check_project_id(project_id):
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
            raise StoreError("BAD_REQUEST", "项目 ID 无效。")

    def _indexed_project_id(self, path, *, reject_unsafe=False):
        with self._index_guard:
            for _ in range(3):
                parent = self._index_stamp(path.parent, stat.S_ISDIR, reject_unsafe=reject_unsafe)
                stamp = self._index_stamp(path, stat.S_ISREG, reject_unsafe=reject_unsafe) if parent else None
                if stamp is None:
                    self._index_files.pop(path, None)
                    return None
                cached = self._index_files.get(path)
                if cached and cached[0] == stamp:
                    return cached[1]
                try:
                    document = _read_project_json(path)
                except (UnicodeError, json.JSONDecodeError, RecursionError):
                    document = None
                except (FileNotFoundError, NotADirectoryError):
                    continue
                if stamp != self._index_stamp(path, stat.S_ISREG):
                    continue
                project_id = document.get("id") if isinstance(document, dict) else None
                if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
                    project_id = None
                self._index_files[path] = stamp, project_id
                return project_id
            raise StoreError("PROJECT_CHANGED", "项目文件正在变更，请重试。", 409)

    def _refresh_project_index(self, root_stamp):
        paths = {}
        candidates = set(self._opened_paths.values())
        if root_stamp is not None:
            try:
                candidates.update(child / "project.json" for child in self.root.iterdir()
                                  if not child.name.startswith("."))
            except FileNotFoundError:
                pass
        for path in candidates:
            try:
                project_id = self._indexed_project_id(path)
            except OSError:
                continue
            # Explicit external paths are authorized for the ID that was opened.
            if project_id and (path.parent.parent == self.root and not path.parent.name.startswith(".")
                               or self._opened_paths.get(project_id) == path):
                paths.setdefault(project_id, []).append(path)
        self._index_files = {path: entry for path, entry in self._index_files.items() if path in candidates}
        self._index_paths = paths
        self._index_root = root_stamp

    def _project_path(self, project_id, *, refresh=False):
        self._check_project_id(project_id)
        with self._index_guard:
            root_stamp = self._index_stamp(self.root, stat.S_ISDIR, reject_unsafe=True)
            paths = self._index_paths.get(project_id, [])
            current_id = self._indexed_project_id(paths[0], reject_unsafe=True) if len(paths) == 1 else None
            if refresh or root_stamp != self._index_root or current_id != project_id:
                self._refresh_project_index(root_stamp)
                paths = self._index_paths.get(project_id, [])
            if len(paths) > 1:
                raise StoreError("DUPLICATE_PROJECT_ID", "多个项目目录使用同一 ID。", 409)
            if paths:
                return paths[0]
        raise StoreError("NOT_FOUND", "项目不存在或尚未打开。", 404)

    def _require_project_id(self, path, project_id):
        if self._indexed_project_id(path, reject_unsafe=True) != project_id:
            raise StoreError("PROJECT_CHANGED", "项目目录或 ID 已变更，请重试。", 409)

    def native3d_backup_fragment(self, project_id, revision):
        """Read-only recovery source. The current page remains the only writer."""
        if type(revision) is not int or revision < 1:
            raise StoreError('BAD_REQUEST', '备份版本无效。')
        project = self._project_path(project_id).resolve()
        path = project.parent / 'backups' / f'project-r{revision}.json'
        if not path.is_file() or path.resolve().parent != project.parent / 'backups':
            raise StoreError('NOT_FOUND', '项目备份不存在或路径无效。', 404)
        if path.stat().st_size > 32 * 1024 * 1024:
            raise StoreError('BAD_REQUEST', '项目备份过大。')
        document = _read_project_json(path)
        if document.get('id') != project_id or document.get('revision') != revision:
            raise StoreError('BAD_REQUEST', '备份项目或版本不匹配。')
        nodes = [n for n in document.get('canvas', {}).get('nodes', []) if n.get('type') == 'native3d']
        ids = {n['id'] for n in nodes}
        edges = [e for e in document.get('canvas', {}).get('edges', []) if e.get('source') in ids or e.get('target') in ids]
        return {'projectId': project_id, 'nodes': nodes, 'edges': edges, 'backupRevision': revision}

    def _read(self, path, migrate=True):
        # Schema/handle repair can write: serialize the entire read-modify-write,
        # including callers that already hold this project's reentrant guard.
        with self._guard(path):
            path, document = _safe_project_file(path)
            document, changed = _migrate(document) if migrate else (document, False)
            if changed:
                backup = path.parent / "backups" / f"project-r{document['revision'] - 1}-before-v3.json"
                backup.parent.mkdir(parents=True, exist_ok=True)
                if not backup.exists():
                    shutil.copy2(path, backup)
                atomic_write_json(path, document)
            return document

    def _write(self, path, document, expected_revision=None, backup=True):
        with self._guard(path):
            _, current = _safe_project_file(path)
            current_revision = int(current.get("revision", 0))
            if expected_revision is not None and current_revision != expected_revision:
                conflict = path.parent / f".conflict-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.json"
                atomic_write_json(conflict, document)
                raise RevisionConflict(current_revision, conflict.name)
            document = dict(document)
            document["revision"] = current_revision + 1
            document["updatedAt"] = utc_now()
            document["appVersion"] = APP_VERSION
            _validated(document)
            if backup:
                backup_path = path.parent / "backups" / f"project-r{current_revision}.json"
                backup_path.parent.mkdir(parents=True, exist_ok=True)
                atomic_write_json(backup_path, current)
            atomic_write_json(path, document)
            backups = sorted(path.parent.glob("backups/project-r*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
            for old in backups[20:]:
                old.unlink(missing_ok=True)
            return document

    def create(self, name, canvas=None, template="blank", directory=None):
        document = new_document(name, canvas, template, self.defaults)
        path = Path(directory).expanduser() if directory else self.root / document["name"]
        if not path.is_absolute():
            path = self.root / path
        path = path.resolve()
        if path == self.root or path.exists():
            raise StoreError("BAD_REQUEST", "同名项目或目标文件夹已存在，未覆盖任何内容。")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.mkdir()
        for child in ("assets", "backups", "outputs", "exports", ".cache"):
            (path / child).mkdir()
        atomic_write_json(path / "project.json", document)
        return document

    def list(self):
        if not self.root.is_dir():
            return []
        rows = []
        for candidate in self.root.iterdir():
            path = candidate / "project.json"
            if not candidate.is_dir() or candidate.name.startswith(".") or not path.is_file():
                continue
            try:
                document = self._read(path)
                size = sum(item.stat().st_size for item in candidate.rglob("*") if item.is_file() and ".lock" not in item.parts)
                rows.append(self.summary(document, candidate, size))
            except StoreError as exc:
                rows.append({"id": None, "name": candidate.name, "path": str(candidate), "invalid": True, "error": exc.message})
        return sorted(rows, key=lambda item: item.get("updatedAt", ""), reverse=True)

    @staticmethod
    def summary(document, path, size=0):
        cover = next((node.get("data", {}).get("assetPath") for node in document["canvas"]["nodes"]
                      if node.get("type") == "media" and node.get("data", {}).get("kind") == "image"
                      and node.get("data", {}).get("assetPath")), None)
        return {
            "id": document["id"], "name": document["name"], "path": str(path),
            "createdAt": document["createdAt"], "updatedAt": document["updatedAt"], "revision": document["revision"],
            "nodeCount": len(document["canvas"]["nodes"]), "edgeCount": len(document["canvas"]["edges"]),
            "shotCount": len(document["shots"]), "bytes": size,
            "thumbnail": f"/api/projects/{document['id']}/{cover}" if cover else None,
        }

    def get(self, project_id):
        path = self._project_path(project_id)
        with self._guard(path):
            self._require_project_id(path, project_id)
            document = self._read(path)
            if document["id"] != project_id:
                raise StoreError("PROJECT_CHANGED", "项目目录或 ID 已变更，请重试。", 409)
            return document

    def _set_read_only(self, path, project_id, read_only):
        path = Path(path).resolve()
        owns_lock = any(lock_path == path.parent / ".lock" and owner == self.owner_id for lock_path, owner in self._held)
        if read_only and not owns_lock:
            self._read_only.add(project_id)
        elif not read_only:
            self._read_only.discard(project_id)

    def _require_writable(self, path):
        project_id = self._indexed_project_id(Path(path), reject_unsafe=True)
        if project_id is None:
            raise StoreError("PROJECT_CHANGED", "项目目录或 ID 已变更，请重试。", 409)
        if project_id in self._read_only:
            raise StoreError("READ_ONLY", "当前项目以只读方式打开，服务端已拒绝写操作。", 403)

    def open(self, project_id, owner_id=None, read_only=False):
        path = self._project_path(project_id)
        with self._guard(path):
            self._require_project_id(path, project_id)
            if not read_only:
                self.acquire_lock(path, owner_id)
            self._set_read_only(path, project_id, read_only)
            document = self._read(path)
            if document["id"] != project_id:
                raise StoreError("PROJECT_CHANGED", "项目目录或 ID 已变更，请重试。", 409)
            return document

    def open_path(self, directory, owner_id=None, read_only=False):
        path = Path(directory).expanduser().resolve() / "project.json"
        with self._guard(path), self._index_guard:
            if self._index_stamp(path, stat.S_ISREG) is None:
                raise StoreError("NOT_FOUND", "项目不存在或项目文件路径无效。", 404)
            project_id = self._indexed_project_id(path)
            if project_id and self._other_project_path(project_id, path):
                raise StoreError("DUPLICATE_PROJECT_ID", "项目 ID 已指向其他目录。", 409)
            document = self._read(path)
            self._check_project_id(document["id"])
            if document["id"] != project_id and self._other_project_path(document["id"], path):
                raise StoreError("DUPLICATE_PROJECT_ID", "项目 ID 已指向其他目录。", 409)
            project_id = document["id"]
            if not read_only:
                self.acquire_lock(path, owner_id)
            self._set_read_only(path, project_id, read_only)
            self._opened_paths[project_id] = path
            self._index_paths.pop(project_id, None)
            return document

    def _other_project_path(self, project_id, path):
        try:
            found = self._project_path(project_id, refresh=True)
        except StoreError as exc:
            if exc.code != "NOT_FOUND":
                raise
            return False
        return found != path

    def save(self, project_id, document, expected_revision):
        path = self._project_path(project_id)
        with self._guard(path):
            self._require_project_id(path, project_id)
            self._require_writable(path)
            if document.get("id") != project_id or document.get("schemaVersion") != 3:
                raise StoreError("BAD_REQUEST", "项目 ID 或 schema 版本不一致。")
            self.acquire_lock(path)
            return self._write(path, document, int(expected_revision))

    def held_project_details(self):
        """Projects this process still holds. `stale` is true only for a confirmed-dead owner pid."""
        details = []
        for lock_path, owner in list(self._held):
            lock_path = Path(lock_path)
            try:
                lock = json.loads(lock_path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError, json.JSONDecodeError):
                lock = {}
            if not isinstance(lock, dict):
                lock = {}
            try:
                pid = int(lock.get("pid", 0))
            except (TypeError, ValueError):
                pid = 0
            project_id, name = None, None
            try:
                document = json.loads((lock_path.parent / "project.json").read_text(encoding="utf-8"))
                if isinstance(document, dict):
                    project_id, name = document.get("id"), document.get("name")
            except (OSError, UnicodeError, json.JSONDecodeError):
                name = lock_path.parent.name
            details.append({
                "id": project_id, "name": name, "owner": lock.get("owner") or owner,
                "pid": pid or None, "stale": _process_dead(pid), "thisProcess": pid == os.getpid(),
            })
        return details

    def reclaim_dead_locks(self):
        """Drop locks whose owner pid is confirmed dead. Never remove a live process's lock."""
        reclaimed = []
        seen = set()
        candidates = [Path(lock_path) for lock_path, _owner in list(self._held)]
        if self.root.is_dir():
            for child in self.root.iterdir():
                if child.is_dir() and not child.name.startswith("."):
                    candidates.append(child / ".lock")
        for lock_path in candidates:
            key = os.path.normcase(str(lock_path))
            if key in seen:
                continue
            seen.add(key)
            info = self._reclaim_if_dead(lock_path)
            if info:
                reclaimed.append(info)
        return reclaimed

    def _reclaim_if_dead(self, lock_path):
        lock_path = Path(lock_path)
        resolved = lock_path.resolve()
        if not lock_path.is_file():
            self._held = {item for item in self._held if Path(item[0]).resolve() != resolved}
            return None
        project_json = lock_path.parent / "project.json"
        try:
            with self._guard(project_json):
                try:
                    lock = json.loads(lock_path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError, json.JSONDecodeError):
                    return None
                if not isinstance(lock, dict):
                    return None
                try:
                    pid = int(lock.get("pid", 0))
                except (TypeError, ValueError):
                    return None
                if not _process_dead(pid):
                    return None
                project_id, name = None, lock_path.parent.name
                try:
                    document = json.loads(project_json.read_text(encoding="utf-8"))
                    if isinstance(document, dict):
                        project_id, name = document.get("id"), document.get("name") or name
                except (OSError, UnicodeError, json.JSONDecodeError):
                    pass
                lock_path.unlink(missing_ok=True)
                self._held = {item for item in self._held if Path(item[0]).resolve() != resolved}
                return {"id": project_id, "name": name, "pid": pid, "stale": True}
        except StoreError:
            return None

    def release(self, project_id):
        path = self._project_path(project_id)
        lock_path = path.parent / ".lock"
        with self._guard(path):
            for held_path, owner in list(self._held):
                if held_path != lock_path:
                    continue
                try:
                    lock = json.loads(lock_path.read_text(encoding="utf-8"))
                    if lock.get("owner") == owner:
                        lock_path.unlink(missing_ok=True)
                except (OSError, UnicodeError, json.JSONDecodeError):
                    pass
                self._held.discard((held_path, owner))
            self._read_only.discard(project_id)
        return {"closed": True, "id": project_id}

    def acquire_lock(self, path, owner_id=None):
        owner = owner_id or self.owner_id
        path = Path(path).resolve()
        with self._guard(path):
            lock_path = path.parent / ".lock"
            now = time.time()
            created = False
            try:
                lock = json.loads(lock_path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                try:
                    self._create_lock_file(lock_path, owner)
                except FileExistsError:
                    raise StoreError("LOCKED", "项目正由另一个实例编辑，请重试。", 423)
                except FileNotFoundError:
                    raise StoreError("PROJECT_CHANGED", "项目目录已变更，请重试。", 409)
                lock = {"owner": owner}
                created = True
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise StoreError("LOCKED", "项目锁暂不可验证，请重试。", 423) from exc
            if not isinstance(lock, dict) or not lock.get("owner"):
                raise StoreError("LOCKED", "项目锁暂不可验证，请重试。", 423)
            if lock.get("owner") != owner:
                try:
                    lock_pid = int(lock.get("pid", 0))
                except (TypeError, ValueError):
                    lock_pid = 0
                # A dead owner is reclaimed even when its heartbeat timestamp is still fresh.
                if not _process_dead(lock_pid):
                    fresh = now - float(lock.get("heartbeat", 0)) < 30
                    try:
                        owner_alive = _writer_running(lock_pid) if lock_pid else False
                    except (TypeError, ValueError):
                        owner_alive = False
                    if fresh or owner_alive:
                        raise StoreError("LOCKED", "项目正由另一个实例编辑，请以只读方式打开。", 423, {"owner": lock.get("owner")})
            if not created:
                atomic_write_json(lock_path, {"owner": owner, "pid": os.getpid(), "heartbeat": now})
            self._held.add((lock_path, owner))
            if not self._heartbeat_thread or not self._heartbeat_thread.is_alive():
                self._heartbeat_stop.clear()
                self._heartbeat_thread = threading.Thread(target=self._heartbeat, daemon=True)
                self._heartbeat_thread.start()
            return {"owner": owner, "heartbeat": now, "readOnly": False}

    @staticmethod
    def _create_lock_file(path, owner):
        # Publish a complete lock without replacing a concurrent winner.
        temporary = path.with_name(f".lock-{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump({"owner": owner, "pid": os.getpid(), "heartbeat": time.time()}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            if os.name == "nt":
                temporary.rename(path)  # Windows rename fails if the destination exists.
            else:
                os.link(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _heartbeat(self):
        while not self._heartbeat_stop.wait(10):
            for lock_path, owner in list(self._held):
                try:
                    with self._guard(lock_path.parent / "project.json"):
                        lock = json.loads(lock_path.read_text(encoding="utf-8"))
                        if lock.get("owner") == owner:
                            atomic_write_json(lock_path, {**lock, "heartbeat": time.time()})
                except (OSError, UnicodeError, json.JSONDecodeError):
                    continue

    def close(self):
        self._heartbeat_stop.set()
        for lock_path, owner in list(self._held):
            try:
                lock = json.loads(lock_path.read_text(encoding="utf-8"))
                if lock.get("owner") == owner:
                    lock_path.unlink(missing_ok=True)
            except (OSError, UnicodeError, json.JSONDecodeError):
                pass
        self._held.clear()

    def duplicate(self, project_id):
        path = self._project_path(project_id)
        source = path.parent
        temporary = source.parent / f".duplicate-{uuid.uuid4().hex}"
        with self._guard(path):
            self._require_project_id(path, project_id)
            document = self._read(path)
            name = validate_name(document["name"] + " 副本")
            target = source.parent / name
            if target.exists():
                raise StoreError("BAD_REQUEST", "副本文件夹已存在。")
            try:
                shutil.copytree(source, temporary, ignore=shutil.ignore_patterns(".lock", ".conflict-*", "exports"))
                document.update(id=f"prj_{uuid.uuid4().hex}", name=name, revision=1, createdAt=utc_now(), updatedAt=utc_now())
                atomic_write_json(temporary / "project.json", document)
                for backup in (temporary / "backups").glob("*.json"):
                    backup.unlink()
                temporary.rename(target)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        return document

    def delete(self, project_id):
        path = self._project_path(project_id)
        source = path.parent
        with self._guard(path):
            self._require_project_id(path, project_id)
            self._require_writable(path)
            trash = self.root / ".trash"
            trash.mkdir(parents=True, exist_ok=True)
            if self._index_stamp(trash, stat.S_ISDIR) is None:
                raise StoreError("BAD_REQUEST", "回收站路径无效。")
            target = trash / f"{source.name}-{int(time.time())}-{uuid.uuid4().hex[:6]}"
            lock_path = source / ".lock"
            owner = f"delete-{uuid.uuid4().hex}"
            try:
                self._create_lock_file(lock_path, owner)
            except FileExistsError:
                raise StoreError("LOCKED", "请先关闭项目并释放项目锁，再移入回收站。", 423)
            try:
                shutil.move(str(source), str(target))
            finally:
                for lease in (lock_path, target / ".lock"):
                    try:
                        if json.loads(lease.read_text(encoding="utf-8")).get("owner") == owner:
                            lease.unlink()
                    except (OSError, UnicodeError, ValueError, AttributeError):
                        pass
            with self._index_guard:
                self._opened_paths.pop(project_id, None)
                self._index_paths.pop(project_id, None)
                self._index_files.pop(path, None)
        return {"deleted": True, "trashPath": str(target), "restoreAfter": None}

    def restore(self, trash_name):
        if not trash_name or trash_name in {".", ".."} or INVALID_NAME.search(trash_name):
            raise StoreError("BAD_REQUEST", "回收站项目名无效。")
        trash = self.root / ".trash"
        source = trash / trash_name
        path = source / "project.json"
        with self._guard(path):
            if (self._index_stamp(trash, stat.S_ISDIR) is None
                    or self._index_stamp(source, stat.S_ISDIR) is None
                    or self._index_stamp(path, stat.S_ISREG) is None):
                raise StoreError("NOT_FOUND", "回收站项目不存在或路径无效。", 404)
            document = self._read(path)
            target = self.root / validate_name(document["name"])
            with self._index_guard:
                if self._other_project_path(document["id"], path):
                    raise StoreError("DUPLICATE_PROJECT_ID", "已有项目使用相同 ID，未恢复。", 409)
                if target.exists():
                    raise StoreError("BAD_REQUEST", "原位置已有同名项目，未覆盖。")
                source.rename(target)
        return document

    def list_trash(self):
        trash = self.root / ".trash"
        if not trash.is_dir():
            return []
        rows = []
        for candidate in trash.iterdir():
            try:
                document = self._read(candidate / "project.json")
                size = sum(item.stat().st_size for item in candidate.rglob("*") if item.is_file() and ".lock" not in item.parts)
                rows.append({**self.summary(document, candidate, size), "trashName": candidate.name,
                             "deletedAt": dt.datetime.fromtimestamp(candidate.stat().st_mtime, dt.timezone.utc).isoformat()})
            except StoreError:
                continue
        return sorted(rows, key=lambda item: item["deletedAt"], reverse=True)

    def purge_trash(self, days=30):
        cutoff = time.time() - days * 86400
        removed = []
        trash = self.root / ".trash"
        if trash.is_dir():
            for item in trash.iterdir():
                if item.is_dir() and item.stat().st_mtime < cutoff:
                    shutil.rmtree(item)
                    removed.append(item.name)
        return removed

    def put_asset(self, project_id, filename, source, content_type=None, expected_revision=None):
        path = self._project_path(project_id)
        self._require_writable(path)
        self.acquire_lock(path)
        extension = Path(filename).suffix.lower()
        report_upload = extension == ".json" and Path(filename).name == "report.json"
        from native3d_plan_assets import LIMITS as plan_limits, validate as validate_plan_asset
        plan_name=Path(filename).name
        plan_upload=plan_name in plan_limits
        if extension == '.fbx':
            content_type = 'application/octet-stream'
        if extension not in ASSET_EXTENSIONS and not report_upload and not plan_upload:
            raise StoreError("UNSUPPORTED_MEDIA", "素材类型不在白名单内。", 415)
        assets = path.parent / "assets"
        temporary = assets / f".upload-{uuid.uuid4().hex}.tmp"
        assets.mkdir(exist_ok=True)
        digest = hashlib.sha256()
        size = 0
        try:
            with temporary.open("wb") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if extension == '.fbx' and size > 512 * 1024 * 1024:
                        raise StoreError("BAD_REQUEST", "FBX素材不能超过512 MiB。")
                    if report_upload and size > 4 * 1024 * 1024:
                        raise StoreError("BAD_REQUEST", "3D report exceeds 4 MiB.")
                    if plan_upload and size>plan_limits[plan_name]:
                        raise StoreError('BAD_REQUEST','UV plan artifact exceeds bounded limit.')
                    if size > MAX_ASSET_BYTES:
                        raise StoreError("BAD_REQUEST", "单个素材不能超过 2 GB。")
                    digest.update(chunk)
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if plan_upload:
                try:
                    validate_plan_asset(temporary,plan_name)
                except (ValueError,UnicodeError,RecursionError,zipfile.BadZipFile) as exc:
                    raise StoreError('BAD_REQUEST','Invalid UV plan artifact: '+str(exc)[:160]) from exc
                content_type='application/octet-stream'
            if report_upload:
                try:
                    report = json.loads(temporary.read_text(encoding="utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
                except (ValueError, UnicodeError, RecursionError) as exc:
                    raise StoreError("BAD_REQUEST", "3D report must be valid finite JSON.") from exc
                if not isinstance(report, dict) or set(report) != {"metadata", "quality", "warnings"} or not isinstance(report.get("metadata"), dict) or not isinstance(report.get("quality"), dict) or not isinstance(report.get("warnings"), list):
                    raise StoreError("BAD_REQUEST", "Unsupported 3D report structure.")
                content_type = "application/json"
            sha256 = digest.hexdigest()
            relative = f"assets/{sha256}{extension}"
            with self._guard(path):
                document = self._read(path)
                # Check even for deduplicated uploads: returning a newer revision
                # would let a stale browser overwrite changes it has never read.
                if expected_revision is not None and document["revision"] != int(expected_revision):
                    raise StoreError("REVISION_CONFLICT", "项目版本已更新，素材尚未导入；当前画布修改仍保留在本页。", 409,
                                     {"revision": document["revision"]})
                final = path.parent / relative
                if final.exists():
                    temporary.unlink()
                else:
                    os.replace(temporary, final)
                if not any(item["path"] == relative for item in document["assets"]):
                    document["assets"].append({"path": relative, "sha256": sha256, "bytes": size, "mime": content_type or mimetypes.guess_type(filename)[0] or "application/octet-stream"})
                    document = self._write(path, document, document["revision"])
                return {"asset": next(item for item in document["assets"] if item["path"] == relative), "revision": document["revision"]}
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _asset_references(document):
        references = set()

        def walk(value):
            if isinstance(value, dict):
                for child in value.values():
                    walk(child)
            elif isinstance(value, list):
                for child in value:
                    walk(child)
            elif isinstance(value, str):
                match = re.search(r"(?:^|/)(assets/[0-9a-f]{64}\.[a-z0-9]+)(?=$|[?#])", value.replace("\\", "/"), re.IGNORECASE)
                if match:
                    references.add(match.group(1).lower())

        for key, value in document.items():
            # The asset catalogue records uploads, not canvas references.
            if key != "assets":
                walk(value)
        return references

    def collect_orphans(self, project_id, dry_run=True, min_age_days=30):
        try:
            age = float(min_age_days)
        except (TypeError, ValueError) as exc:
            raise StoreError("BAD_REQUEST", "孤儿素材保留天数必须是数字。") from exc
        if not 0 <= age <= 3650:
            raise StoreError("BAD_REQUEST", "孤儿素材保留天数必须在 0–3650 之间。")
        path = self._project_path(project_id)
        with self._guard(path):
            self._require_project_id(path, project_id)
            if not dry_run:
                self._require_writable(path)
                self.acquire_lock(path)
            if dry_run:
                try:
                    document, _ = _migrate(_read_project_json(path))
                except (OSError, UnicodeError, ValueError) as exc:
                    raise StoreError("BAD_REQUEST", "项目文件暂不可读，已中止素材清理预览。") from exc
            else:
                document = self._read(path)
            if not isinstance(document, dict) or document.get("id") != project_id:
                raise StoreError("PROJECT_CHANGED", "项目目录或 ID 已变更，请重试。", 409)
            protected = self._asset_references(document)
            history = list((path.parent / "backups").glob("*.json")) + list(path.parent.glob(".conflict-*.json"))
            for historical in history:
                try:
                    protected.update(self._asset_references(json.loads(historical.read_text(encoding="utf-8"))))
                except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                    raise StoreError("BAD_REQUEST", f"历史副本 {historical.name} 无法读取，已中止素材清理。") from exc
            cutoff = time.time() - age * 86400
            candidates = []
            assets = path.parent / "assets"
            if assets.exists() and self._index_stamp(assets, stat.S_ISDIR) is None:
                raise StoreError("BAD_REQUEST", "素材目录路径无效。")
            for file_path in assets.iterdir() if assets.exists() else ():
                if not re.fullmatch(r"[0-9a-f]{64}\.[a-z0-9]+", file_path.name, re.IGNORECASE):
                    continue
                if file_path.is_symlink() or not file_path.is_file():
                    continue
                relative = f"assets/{file_path.name}".lower()
                if relative in protected:
                    continue
                asset_stat = file_path.stat()
                if asset_stat.st_mtime > cutoff:
                    continue
                candidates.append({"path": f"assets/{file_path.name}", "bytes": asset_stat.st_size})
            candidates.sort(key=lambda item: item["path"])
            result = {
                "dryRun": bool(dry_run), "minAgeDays": age, "protected": len(protected),
                "candidates": candidates, "bytes": sum(item["bytes"] for item in candidates),
                "removed": [], "errors": [], "revision": document["revision"],
            }
            if dry_run or not candidates:
                return result
            removed_paths = set()
            for candidate in candidates:
                try:
                    (path.parent / candidate["path"]).unlink()
                    removed_paths.add(candidate["path"])
                    result["removed"].append(candidate)
                except OSError as exc:
                    result["errors"].append({**candidate, "error": str(exc)})
            if removed_paths:
                document["assets"] = [item for item in document["assets"] if item["path"] not in removed_paths]
                document = self._write(path, document, document["revision"])
                result["revision"] = document["revision"]
            result["bytes"] = sum(item["bytes"] for item in result["removed"])
            return result

    def asset_file(self, project_id, relative):
        path = self._project_path(project_id)
        pure = PurePosixPath(str(relative).replace("\\", "/"))
        if pure.is_absolute() or ".." in pure.parts or len(pure.parts) != 2 or pure.parts[0] != "assets":
            raise StoreError("BAD_REQUEST", "素材路径无效。", 400)
        file_path = (path.parent / pure).resolve()
        if file_path.parent != (path.parent / "assets").resolve() or not file_path.is_file() or file_path.is_symlink():
            raise StoreError("NOT_FOUND", "素材不存在。", 404)
        return file_path

    @staticmethod
    def range_response(file_path, range_header=None):
        size = file_path.stat().st_size
        start, end = 0, size - 1
        status = 200
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match or (not match.group(1) and not match.group(2)):
                raise StoreError("BAD_REQUEST", "Range 请求无效。", 400)
            if not match.group(1):
                length = int(match.group(2))
                if length <= 0:
                    raise StoreError("BAD_REQUEST", "Range 请求无效。", 400)
                start = max(0, size - length)
            else:
                start = int(match.group(1))
                if match.group(2):
                    end = int(match.group(2))
            if start >= size or end < start:
                raise StoreError("BAD_REQUEST", "Range 超出文件范围。", 416, {"contentRange": f"bytes */{size}"})
            end = min(end, size - 1)
            status = 206
        length = max(0, end - start + 1)
        headers = {"Accept-Ranges": "bytes", "Content-Length": str(length), "Content-Type": mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"}
        if file_path.suffix.lower() == ".json":
            headers["Content-Type"] = "application/octet-stream"
            headers["Content-Disposition"] = 'attachment; filename="report.json"'
        if file_path.suffix.lower() == '.fbx':
            headers['Content-Type'] = 'application/octet-stream'
            headers['Content-Disposition'] = f'attachment; filename="{file_path.name}"'
        if status == 206:
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return status, headers, start, length

    def export(self, project_id):
        path = self._project_path(project_id)
        document = self._read(path)
        exports = path.parent / "exports"
        exports.mkdir(exist_ok=True)
        target = exports / f"{document['name']}-r{document['revision']}.zip"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.write(path, "project.json")
            for folder in ("assets", "outputs"):
                base = path.parent / folder
                if base.is_dir():
                    for item in base.rglob("*"):
                        if item.is_file() and not item.is_symlink():
                            archive.write(item, item.relative_to(path.parent).as_posix())
        return target

    def import_zip(self, archive_path):
        try:
            return self._import_zip(archive_path)
        except (zipfile.BadZipFile, RuntimeError, UnicodeError, ValueError, TypeError) as exc:
            raise StoreError("BAD_REQUEST", "项目包损坏或格式无效，未完成导入。") from exc
        except OSError as exc:
            raise StoreError("IMPORT_IO_ERROR", "项目包无法读取或保存，请检查文件及磁盘空间。", 503) from exc

    def _import_zip(self, archive_path):
        archive_path = Path(archive_path).resolve()
        with zipfile.ZipFile(archive_path) as archive:
            members = archive.infolist()
            if len(members) > MAX_PROJECT_MEMBERS:
                raise StoreError("BAD_REQUEST", "项目包文件数量超过导入限制。")
            if "project.json" not in archive.namelist():
                raise StoreError("BAD_REQUEST", "项目包缺少 project.json。")
            total, names = 0, set()
            for member in members:
                pure = PurePosixPath(member.filename)
                mode = member.external_attr >> 16
                parts = member.filename.rstrip("/").split("/")
                folded = member.filename.rstrip("/").casefold()
                if (
                    pure.is_absolute() or ".." in pure.parts or not pure.parts
                    or member.orig_filename != member.filename or "\\" in member.filename
                    or any(not part or part in {".", ".."} or INVALID_NAME.search(part)
                           or part.endswith((".", " ")) or part.split(".", 1)[0].upper() in RESERVED_NAMES for part in parts)
                    or folded in names or (mode & 0o170000) not in {0, 0o100000, 0o040000}
                    or member.flag_bits & 1
                ):
                    raise StoreError("BAD_REQUEST", "项目包包含不安全路径。")
                names.add(folded)
                total += member.file_size
                if total > MAX_ASSET_BYTES * 4:
                    raise StoreError("BAD_REQUEST", "项目包超过导入大小限制。")
            document = json.loads(archive.read("project.json").decode("utf-8"))
            document, _ = _migrate(document)
            target = (self.root / document["name"]).resolve()
            if self.root not in target.parents or target.exists():
                raise StoreError("BAD_REQUEST", "导入目标无效或同名项目已存在。")
            # A renamed archive can be imported beside its source project. API
            # lookup is by id, so retaining that id would open/save the wrong one.
            try:
                self._project_path(document["id"])
            except StoreError as exc:
                if exc.code != "NOT_FOUND":
                    raise
            else:
                document.update(id=f"prj_{uuid.uuid4().hex}", revision=1, createdAt=utc_now())
            temporary = self.root / f".import-{uuid.uuid4().hex}"
            temporary_root = temporary.resolve()
            try:
                for member in members:
                    if member.is_dir():
                        continue
                    destination = (temporary / PurePosixPath(member.filename)).resolve()
                    if destination == temporary_root or temporary_root not in destination.parents:
                        raise StoreError("BAD_REQUEST", "项目包成员落点超出导入目录。")
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(member) as source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                for folder in ("assets", "backups", "outputs", "exports", ".cache"):
                    (temporary / folder).mkdir(exist_ok=True)
                document["updatedAt"] = utc_now()
                _validated(document)
                atomic_write_json(temporary / "project.json", document)
                os.replace(temporary, target)
                return document
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
