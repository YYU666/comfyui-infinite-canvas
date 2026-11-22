from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parent / "scripts"))

from build_update_package import write_checksum
from build_runtime_package import lock_sha256, runtime_asset_name, runtime_identity
from release_candidate import GitHubRelease, publish_release, validate_packages


TAG = "v1.1.0"
SHA = "a" * 40


class DraftRepository:
    def __init__(self, *, draft=None, assets=()):
        self.release = draft
        self.assets = list(assets)
        self.commit_sha = SHA
        self.events = []
        self.fail_upload = False
        self.corrupt_upload = False

    def require_tag(self, tag, sha):
        self.events.append("verify-tag")
        if (tag, sha) != (TAG, self.commit_sha):
            raise RuntimeError("Wrong remote tag")

    def api(self, endpoint, *, method="GET", body=None, paginate=False):
        if method == "POST":
            assert endpoint == "releases" and body["draft"] and body["target_commitish"] == SHA
            self.events.append("create-draft")
            self.release = {**body, "id": 9, "html_url": "https://example.com/releases/9"}
            return self.release
        if endpoint == "releases?per_page=100" and paginate:
            return [self.release] if self.release else []
        if endpoint == "releases/9/assets?per_page=100" and paginate:
            self.events.append("list-assets")
            return self.assets
        assert endpoint == "releases/9"
        if method == "PATCH":
            assert body == {"draft": False}
            self.events.append("publish")
            self.release = {**self.release, **body}
        return self.release

    def upload(self, release_id, path):
        assert release_id == 9 and self.release["draft"]
        if self.fail_upload:
            raise RuntimeError("Upload failed")
        self.events.append(("upload", path.name))
        self.assets.append(self.asset_for(path))
        if self.corrupt_upload:
            self.assets[-1]["digest"] = "sha256:invalid"

    @staticmethod
    def asset_for(path):
        data = path.read_bytes()
        return {"name": path.name, "state": "uploaded", "size": len(data),
                "digest": "sha256:" + hashlib.sha256(data).hexdigest()}


class ReleaseCandidateTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        identity = runtime_identity()
        release_manifest = json.dumps({"version": TAG})
        runtime_manifest = json.dumps({"identity": identity, "requirementsLockSha256": lock_sha256()})
        packages = (
            (f"refmuse-update-{TAG}.zip", {"release-files.json": release_manifest}, False),
            (f"refmuse-portable-{TAG}.zip", {"release-files.json": release_manifest, "dist/index.html": ""}, True),
            (runtime_asset_name(), {f"{identity}/runtime-manifest.json": runtime_manifest,
                                    f"{identity}/python_embeded/pythonw.exe": "",
                                    f"{identity}/LICENSES/PSF-LICENSE.txt": ""}, True),
        )
        for name, members, with_bytes in packages:
            path = self.directory / name
            with ZipFile(path, "w") as archive:
                for member, contents in members.items():
                    archive.writestr(member, contents)
            write_checksum(path, with_bytes=with_bytes)
        self.files = {path.name: path for path in self.directory.iterdir()}

    def draft(self, **changes):
        return {"id": 9, "tag_name": TAG, "target_commitish": "main", "draft": True,
                "prerelease": False, "body": "Manual notes",
                "html_url": "https://example.com/releases/9", **changes}

    def test_candidate_requires_exact_files_and_checksum(self):
        self.assertEqual(validate_packages(self.directory, TAG), self.files)
        checksum = self.files[f"refmuse-update-{TAG}.zip.sha256"]
        checksum.write_text("invalid", encoding="ascii")
        with self.assertRaises(RuntimeError):
            validate_packages(self.directory, TAG)
        checksum.unlink()
        with self.assertRaisesRegex(RuntimeError, "exactly"):
            validate_packages(self.directory, TAG)

    def test_new_release_is_published_only_after_upload_and_remote_checks(self):
        repo = DraftRepository()
        publish_release(repo, TAG, SHA, self.files)
        self.assertEqual(repo.events[:2], ["verify-tag", "create-draft"])
        self.assertEqual(repo.events[-3:], ["list-assets", "verify-tag", "publish"])
        self.assertEqual(len(repo.assets), 6)
        self.assertFalse(repo.release["draft"])

    def test_existing_draft_keeps_manual_notes_and_identical_assets(self):
        existing = DraftRepository.asset_for(next(iter(self.files.values())))
        repo = DraftRepository(draft=self.draft(), assets=[existing])
        publish_release(repo, TAG, SHA, self.files)
        self.assertEqual(repo.release["body"], "Manual notes")
        self.assertNotIn(("upload", existing["name"]), repo.events)

    def test_existing_public_release_and_wrong_draft_target_are_refused(self):
        for draft in (self.draft(draft=False), self.draft(target_commitish="b" * 40)):
            with self.subTest(draft=draft):
                repo = DraftRepository(draft=draft)
                with self.assertRaises(RuntimeError):
                    publish_release(repo, TAG, SHA, self.files)
                self.assertEqual(repo.events, ["verify-tag"])

    def test_wrong_tag_never_creates_draft(self):
        repo = DraftRepository()
        repo.commit_sha = "b" * 40
        with self.assertRaisesRegex(RuntimeError, "Wrong remote tag"):
            publish_release(repo, TAG, SHA, self.files)
        self.assertIsNone(repo.release)

    def test_upload_failure_and_remote_checksum_mismatch_keep_draft(self):
        for failure in ("fail_upload", "corrupt_upload"):
            with self.subTest(failure=failure):
                repo = DraftRepository()
                setattr(repo, failure, True)
                with self.assertRaises(RuntimeError):
                    publish_release(repo, TAG, SHA, self.files)
                self.assertTrue(repo.release["draft"])
                self.assertNotIn("publish", repo.events)

    def test_tag_moved_after_upload_keeps_draft(self):
        repo = DraftRepository()
        with patch.object(repo, "require_tag", side_effect=(None, RuntimeError("Tag moved"))):
            with self.assertRaisesRegex(RuntimeError, "Tag moved"):
                publish_release(repo, TAG, SHA, self.files)
        self.assertTrue(repo.release["draft"])

    def test_tag_resolution_peels_annotated_tags(self):
        repo = GitHubRelease("owner/repo")
        with patch.object(repo, "api", side_effect=(
            {"object": {"type": "tag", "sha": "b" * 40}},
            {"object": {"type": "commit", "sha": SHA}},
        )) as api:
            repo.require_tag(TAG, SHA)
        self.assertEqual(api.call_args_list[0].args, (f"git/ref/tags/{TAG}",))
        self.assertEqual(api.call_args_list[1].args, ("git/tags/" + "b" * 40,))
