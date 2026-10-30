from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_update import (
    UpdateError, WorkbenchUpdateManager, compare_versions, parse_version,
    validate_update_request,
)


class Response:
    def __init__(self, data):
        self.stream = io.BytesIO(data if isinstance(data, bytes) else json.dumps(data).encode("utf-8"))
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size=-1): return self.stream.read(size)


def package_bytes(tag="v9.9.9", paths=None):
    files = {
        "video_workbench_launcher.py": b"# launcher\n",
        "workbench_update.py": b"# update\n",
        "workbench_update_helper.py": b"# helper\n",
        "workbench_lifecycle.py": f'APP_VERSION = "{tag.lstrip("v")}"\n'.encode(),
        "package.json": json.dumps({"version": tag.lstrip("v")}).encode(),
        "package-lock.json": b"{}\n",
        "requirements.lock": b"# locked\n",
        "src/App.jsx": b"new app\n",
    }
    if paths is not None:
        files = paths
    manifest = {"format": 1, "version": tag, "files": [{"path": name, "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()]}
    target = io.BytesIO()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items(): archive.writestr(name, data)
        archive.writestr("release-files.json", json.dumps(manifest))
    return target.getvalue()


class UpdateTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "workbench"
        self.root.mkdir()
        self.runtime = Path(self.temporary.name) / "runtime"
        self.archive = package_bytes()
        self.digest = hashlib.sha256(self.archive).hexdigest()
        self.release = {
            "tag_name": "v9.9.9", "name": "Test", "body": "Notes", "html_url": "https://github.com/YYU666/comfyui-infinite-canvas/releases/tag/v9.9.9",
            "draft": False, "published_at": "2026-10-30T00:00:00Z",
            "assets": [
                {"name": "refmuse-update-v9.9.9.zip", "browser_download_url": "https://github.com/YYU666/comfyui-infinite-canvas/releases/download/v9.9.9/refmuse-update-v9.9.9.zip"},
                {"name": "refmuse-update-v9.9.9.zip.sha256", "browser_download_url": "https://github.com/YYU666/comfyui-infinite-canvas/releases/download/v9.9.9/refmuse-update-v9.9.9.zip.sha256"},
            ],
        }
        self.opener = mock.Mock(side_effect=self.open)
        self.process = mock.Mock(pid=4321)
        self.process_launcher = mock.Mock(return_value=self.process)
        self.preflight = mock.Mock()
        self.manager = WorkbenchUpdateManager(self.root, self.preflight, opener=self.opener, process_launcher=self.process_launcher, update_root=self.runtime)

    def tearDown(self): self.temporary.cleanup()

    def open(self, request, timeout):
        url = request.full_url if hasattr(request, "full_url") else request
        if "api.github.com" in url: return Response(self.release)
        if url.endswith(".sha256"): return Response(f"{self.digest}  update.zip\n".encode())
        if url.endswith(".zip"): return Response(self.archive)
        raise AssertionError(url)

    def prepare(self, source):
        (source / "dist").mkdir()
        (source / "dist" / "index.html").write_text("new", encoding="utf-8")


class VersionTests(UpdateTestCase):
    def test_semver_prerelease_order_and_invalid_values(self):
        self.assertLess(compare_versions("1.0.1-rc.1", "1.0.1"), 0)
        self.assertLess(compare_versions("1.0.1-rc.1", "v1.0.1-rc.2"), 0)
        self.assertGreater(compare_versions("1.1.0", "1.0.9"), 0)
        self.assertEqual(compare_versions("v1.0.0", "1.0.0"), 0)
        for value in (None, 1, "1.0", "1.0.01", "1.0.0-rc.01", "1.0.0;rm"):
            with self.subTest(value=value), self.assertRaises(UpdateError): parse_version(value)

    def test_apply_payload_is_exact_and_validated(self):
        self.assertEqual(validate_update_request({"tag": "v1.2.0"}), "v1.2.0")
        for value in ({}, {"tag": 1}, {"tag": "v1.2.0", "url": "https://evil"}, {"tag": "bad"}):
            with self.subTest(value=value), self.assertRaises(UpdateError): validate_update_request(value)


class ReleaseTests(UpdateTestCase):
    def test_check_reports_new_release_without_exposing_asset_internals(self):
        result = self.manager.check()
        self.assertTrue(result["updateAvailable"])
        self.assertTrue(result["canApply"])
        self.assertEqual(result["version"], "v9.9.9")
        self.assertNotIn("package", result)
        self.assertNotIn("checksum", result)

    def test_no_update_and_missing_package(self):
        self.release["tag_name"] = "v1.0.0"
        self.assertFalse(self.manager.check()["updateAvailable"])
        self.release["tag_name"] = "v9.9.9"
        self.release["assets"] = []
        result = self.manager.check()
        self.assertFalse(result["canApply"])
        self.assertIn("缺少安全升级包", result["message"])

    def test_offline_and_invalid_release_are_quiet_statuses(self):
        self.opener.side_effect = urllib.error.URLError("offline")
        result = self.manager.check()
        self.assertEqual(result["status"], "unavailable")
        self.assertFalse(result["updateAvailable"])
        self.opener.side_effect = self.open
        self.release["tag_name"] = 9
        self.assertEqual(self.manager.check()["status"], "unavailable")

    def test_no_published_release_is_distinct_from_connection_failure(self):
        self.opener.side_effect = urllib.error.HTTPError("https://api.github.com/releases/latest", 404, "Not Found", {}, None)
        result = self.manager.check()
        self.assertEqual(result["status"], "no_release")
        self.assertFalse(result["updateAvailable"])
        self.assertIn("尚未发布", result["message"])
        self.opener.side_effect = urllib.error.HTTPError("https://api.github.com/releases/latest", 403, "Forbidden", {}, None)
        self.assertEqual(self.manager.check()["status"], "unavailable")

    def test_apply_downloads_verifies_stages_and_launches_external_helper(self):
        self.manager._prepare_frontend = self.prepare
        result = self.manager.apply("v9.9.9")
        self.assertTrue(result["accepted"])
        self.assertEqual(self.manager.status()["phase"], "restarting")
        self.assertEqual(self.preflight.call_count, 2)
        self.process_launcher.assert_called_once()
        request_path = Path(self.process_launcher.call_args.args[0][-1])
        request = json.loads(request_path.read_text(encoding="utf-8"))
        self.assertEqual(request["root"], str(self.root.resolve()))
        self.assertEqual(request["targetVersion"], "v9.9.9")
        source = Path(request["source"])
        self.assertTrue((source / "dist" / "index.html").is_file())
        self.assertFalse((source / "models").exists())
        self.assertFalse((source / "projects").exists())
        self.assertFalse((source / "outputs").exists())

    def test_checksum_mismatch_never_launches_helper(self):
        self.digest = "0" * 64
        with self.assertRaises(UpdateError) as caught: self.manager.apply("v9.9.9")
        self.assertEqual(caught.exception.code, "CHECKSUM_MISMATCH")
        self.process_launcher.assert_not_called()
        self.assertEqual(self.manager.status()["phase"], "error")

    def test_confirmed_tag_cannot_be_switched(self):
        with self.assertRaises(UpdateError) as caught: self.manager.apply("v8.0.0")
        self.assertEqual(caught.exception.code, "RELEASE_CHANGED")
        self.process_launcher.assert_not_called()

    def test_duplicate_apply_is_rejected(self):
        self.manager._set_state("restarting", "busy")
        with self.assertRaises(UpdateError) as caught: self.manager.apply("v9.9.9")
        self.assertEqual(caught.exception.code, "UPDATE_BUSY")
        self.preflight.assert_not_called()

    def test_concurrent_apply_is_rejected_during_preflight(self):
        entered, release = threading.Event(), threading.Event()
        outcomes = []
        def slow_preflight():
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test preflight was not released")
        self.preflight.side_effect = slow_preflight
        self.manager._prepare_frontend = self.prepare
        def first_apply():
            try:
                outcomes.append(self.manager.apply("v9.9.9"))
            except Exception as exc:
                outcomes.append(exc)
        worker = threading.Thread(target=first_apply)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with self.assertRaises(UpdateError) as caught:
                self.manager.apply("v9.9.9")
            self.assertEqual(caught.exception.code, "UPDATE_BUSY")
            self.assertEqual(self.preflight.call_count, 1)
            self.opener.assert_not_called()
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(outcomes), 1)
        self.assertIsInstance(outcomes[0], dict)
        self.assertTrue(outcomes[0]["accepted"])
        self.process_launcher.assert_called_once()

    def test_failed_preflight_releases_reservation_for_retry(self):
        self.preflight.side_effect = UpdateError("busy", code="QUEUE_BUSY")
        with self.assertRaises(UpdateError):
            self.manager.apply("v9.9.9")
        self.assertEqual(self.manager.status()["phase"], "error")
        self.preflight.side_effect = None
        self.manager._prepare_frontend = self.prepare
        self.assertTrue(self.manager.apply("v9.9.9")["accepted"])

    def test_dirty_git_blocks_before_download(self):
        (self.root / ".git").mkdir()
        result = mock.Mock(returncode=0, stdout=" M src/App.jsx\n")
        with mock.patch("workbench_update.shutil.which", return_value="git"), mock.patch.object(self.manager, "runner", return_value=result):
            with self.assertRaises(UpdateError) as caught: self.manager.apply("v9.9.9")
        self.assertEqual(caught.exception.code, "LOCAL_CHANGES")
        self.opener.assert_not_called()

    def test_installation_records_are_isolated_for_a_shared_runtime(self):
        second = WorkbenchUpdateManager(self.root.parent / "other", self.preflight, update_root=self.runtime)
        self.assertNotEqual(self.manager.installed_manifest_path, second.installed_manifest_path)

    def test_recorded_upgrade_diff_allows_next_upgrade_but_user_edits_do_not(self):
        # The first update installs all package files without changing Git HEAD.
        with zipfile.ZipFile(io.BytesIO(self.archive)) as package:
            package.extractall(self.root)
        manifest = json.loads((self.root / "release-files.json").read_text(encoding="utf-8"))
        manifest["installationRoot"] = self.manager.installation_root
        self.manager.installed_manifest_path.parent.mkdir(parents=True)
        self.manager.installed_manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        (self.root / ".git").mkdir()
        git_status = mock.Mock(returncode=0, stdout=" M src/App.jsx\0 D obsolete.py\0")
        with mock.patch("workbench_update.shutil.which", return_value="git"), mock.patch.object(self.manager, "runner", return_value=git_status):
            self.manager._git_clean()
            (self.root / "src" / "App.jsx").write_text("user edit", encoding="utf-8")
            with self.assertRaises(UpdateError) as caught:
                self.manager._git_clean()
            self.assertEqual(caught.exception.code, "LOCAL_CHANGES")
            (self.root / "src" / "App.jsx").write_bytes(b"new app\n")
            git_status.stdout = "M  src/App.jsx\0"
            with self.assertRaises(UpdateError):
                self.manager._git_clean()


class PackageSecurityTests(UpdateTestCase):
    def verify(self, archive, checksum=None):
        self.runtime.mkdir(parents=True, exist_ok=True)
        folder = Path(tempfile.mkdtemp(prefix="case-", dir=self.runtime))
        package = folder / "update.zip"
        package.write_bytes(archive)
        checksum_path = folder / "update.sha256"
        checksum_path.write_text(checksum or hashlib.sha256(archive).hexdigest(), encoding="ascii")
        source = folder / "source"
        source.mkdir()
        return self.manager._verify_package(package, checksum_path, "v9.9.9", source)

    def test_zip_slip_absolute_and_symlink_are_rejected(self):
        for name in ("../outside.txt", "/absolute.txt", "C:/outside.txt"):
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w") as package: package.writestr(name, b"bad")
            with self.subTest(name=name), self.assertRaises(UpdateError) as caught: self.verify(archive.getvalue())
            self.assertEqual(caught.exception.code, "UNSAFE_PACKAGE")
            self.assertFalse((Path(self.temporary.name) / "outside.txt").exists())
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as package:
            info = zipfile.ZipInfo("link")
            info.external_attr = (0o120777 << 16)
            package.writestr(info, "target")
        with self.assertRaises(UpdateError) as caught: self.verify(archive.getvalue())
        self.assertEqual(caught.exception.code, "UNSAFE_PACKAGE")

    def test_manifest_mismatch_and_wrong_program_version_are_rejected(self):
        archive = package_bytes(paths={"video_workbench_launcher.py": b"only"})
        with self.assertRaises(UpdateError): self.verify(archive)
        archive = package_bytes(tag="v1.0.0")
        with self.assertRaises(UpdateError): self.verify(archive)

    def test_unpacked_size_limit_is_enforced(self):
        with mock.patch("workbench_update.MAX_UNPACKED_BYTES", 10):
            with self.assertRaises(UpdateError) as caught: self.verify(self.archive)
        self.assertEqual(caught.exception.code, "UNSAFE_PACKAGE")


if __name__ == "__main__": unittest.main()
