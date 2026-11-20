"""Bridge boundaries that do not require a running OpenMotion workspace."""
import contextlib
import hashlib
import io
import tempfile
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch

from project_store import ProjectStore, StoreError
from video_edit_jobs import VideoEditJobs
from video_openmotion import OpenMotionBridge, OpenMotionClient


REMOTE = "01010101-0101-4010-a010-010101010101"
OTHER = "02020202-0202-4020-a020-020202020202"
EXPORT = "03030303-0303-4030-a030-030303030303"
ORIGIN = "http://127.0.0.1:49327"
SYNTHETIC_BYTES = b"verified fixture bytes"
SYNTHETIC_SHA = hashlib.sha256(SYNTHETIC_BYTES).hexdigest()


class OpenMotionBridgeTests(unittest.TestCase):
    def test_render_replay_forwards_the_explicit_version_without_refreshing_it(self):
        client = OpenMotionClient(ORIGIN)
        render = {"requestId": EXPORT, "audio": "required", "versionId": OTHER, "expectedRevision": "3" * 64}
        receipt = {"projectId": REMOTE, "job": {"id": EXPORT, "state": "pending"}}
        with patch.object(client, "call", return_value=receipt) as call:
            self.assertEqual(OpenMotionBridge.render(client, REMOTE, render)["renderId"], EXPORT)
            call.assert_called_once_with("openmotion_export_request", {"projectId": REMOTE, **render})

    def test_bridge_rejects_result_not_owned_or_not_verified(self):
        completed = {"id": EXPORT, "projectId": REMOTE, "state": "completed",
                     "verification": {"status": "passed", "sha256": SYNTHETIC_SHA}}
        self.assertTrue(OpenMotionBridge.verified(completed, REMOTE))
        self.assertFalse(OpenMotionBridge.verified(completed, OTHER))
        self.assertFalse(OpenMotionBridge.verified({**completed, "state": "running"}, REMOTE))
        self.assertFalse(OpenMotionBridge.verified({**completed, "verification": {"status": "passed"}}, REMOTE))

    def test_client_verifies_downloaded_bytes_and_requires_literal_loopback(self):
        for invalid in ("https://127.0.0.1:49327", "http://127.0.0.1:49327/another", "http://localhost:49327", "http://example.com:49327"):
            with self.assertRaises(StoreError):
                OpenMotionClient(invalid)
        client = OpenMotionClient(ORIGIN)

        class Response(io.BytesIO):
            def __init__(self, value):
                super().__init__(value)
                self.headers = Message()
                self.headers["Content-Type"] = "video/mp4"

            def getheader(self, name, default):
                return self.headers.get(name, default)

        for value in (SYNTHETIC_BYTES, b"different bytes"):
            response = Response(value)
            with patch.object(client, "request", side_effect=lambda _method, _path, read: read(response)) as request:
                if value == SYNTHETIC_BYTES:
                    target = io.BytesIO()
                    client.fetch_export(EXPORT, SYNTHETIC_SHA, target)
                    self.assertEqual(target.read(), value)
                    self.assertEqual(request.call_args.args, ("GET", f"/api/exports/{EXPORT}/file"))
                else:
                    with self.assertRaises(StoreError) as failure:
                        client.fetch_export(EXPORT, SYNTHETIC_SHA, io.BytesIO())
                    self.assertEqual(failure.exception.code, "OPENMOTION_HASH")

    def test_import_does_not_commit_after_project_revision_or_binding_changes(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as cleanup:
            root = Path(directory)
            store = ProjectStore(root / "projects", "openmotion-test")
            cleanup.callback(store.close)
            jobs = VideoEditJobs(root / "jobs", store)
            cleanup.callback(jobs.close)
            project_id = store.create("Synthetic project")["id"]
            document = store.get(project_id)
            document["canvas"]["nodes"].append({"id": "edit", "type": "videoEdit", "position": {"x": 0, "y": 0},
                                                  "data": {"openMotion": {"remoteProjectId": REMOTE, "origin": ORIGIN}}})
            store.save(project_id, document, document["revision"])
            bridge = OpenMotionBridge(jobs)
            client = OpenMotionClient(ORIGIN)
            job = {"id": EXPORT, "projectId": REMOTE, "state": "completed",
                   "verification": {"status": "passed", "sha256": SYNTHETIC_SHA}}

            def change_during_download(_export_id, _hash, target):
                changed = store.get(project_id)
                changed["canvas"]["nodes"][0]["data"]["openMotion"]["remoteProjectId"] = OTHER
                store.save(project_id, changed, changed["revision"])
                target.write(SYNTHETIC_BYTES)
                target.seek(0)

            with patch.object(client, "get_project", return_value={"exportJob": job}), \
                    patch.object(client, "fetch_export", side_effect=change_during_download):
                with self.assertRaises(StoreError) as failure:
                    bridge.import_export(client, store, project_id, "edit", REMOTE,
                                         {"exportId": EXPORT, "revision": store.get(project_id)["revision"]})
            self.assertEqual(failure.exception.code, "OPENMOTION_LINK")
            self.assertEqual(store.get(project_id)["assets"], [])


if __name__ == "__main__":
    unittest.main()
