"""Regression coverage for Native3D storage inventory's conservative classifications."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from scripts.native3d_storage_inventory import inventory


class StorageInventoryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.jobs_root = self.root / "jobs"
        self.projects_root = self.root / "projects"
        self.jobs_root.mkdir()
        self.projects_root.mkdir()

    def write_json(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def make_job(self, digit, **changes):
        job_id = "n3d_" + digit * 32
        directory = self.jobs_root / job_id
        self.write_json(directory / "manifest.json",
                        {"id": job_id, "status": "succeeded", **changes})
        return job_id, directory

    def report(self):
        result = inventory(self.jobs_root, [self.projects_root])
        rows = {row["jobId"]: row for row in result["jobs"]}
        self.assertEqual(result["logicalBytes"], sum(result["bytesByCategory"].values()))
        return result, rows

    def test_saved_history_missing_and_in_flight_references(self):
        historical, _ = self.make_job("1")
        retried, _ = self.make_job("2")
        parent, _ = self.make_job("3", parameters={"retryJobId": retried})
        pending_save, _ = self.make_job("4", projectId="example", opId="pending-submission")
        no_evidence, _ = self.make_job("5", projectId="example")
        active, _ = self.make_job("6", status="running", parameters={"retryJobId": parent})
        recycled, _ = self.make_job("7")
        conflict, _ = self.make_job("8")
        absent = "n3d_" + "9" * 32
        self.write_json(self.projects_root / "p/project.json",
                        {"id": "example", "canvas": {"nativeRun": {"opId": "pending-submission"}}})
        self.write_json(self.projects_root / "p/backups/project-r1.json", {
            "result": f"https://localhost/api/native3d/jobs/{historical}/files/model.glb",
            "absent": absent,
        })
        self.write_json(self.projects_root / ".trash/old/project.json", {"sourceJobId": recycled})
        self.write_json(self.projects_root / "p/.conflict-date.json", {"sourceJobId": conflict})
        totals, rows = self.report()
        self.assertFalse(totals["issues"])
        self.assertEqual(totals["projectRecordsScanned"], 4)
        self.assertEqual(totals["observedProjectReferencesWithoutJob"], [absent])
        for job_id in (historical, pending_save, recycled, conflict):
            self.assertTrue(rows[job_id]["projectRecords"])
            self.assertEqual(rows[job_id]["bytesByCategory"]["referenced"], rows[job_id]["logicalBytes"])
        self.assertEqual(rows[retried]["referencedByJobs"], [parent])
        self.assertEqual(rows[parent]["referencedByJobs"], [active])
        for job_id in (no_evidence, active):
            self.assertEqual(rows[job_id]["bytesByCategory"]["unproven"], rows[job_id]["logicalBytes"])

    def test_proven_cache_requires_matching_source_and_complete_scan(self):
        source = b"glTF" + bytes(32)
        digest = hashlib.sha256(source).hexdigest()
        job_id, directory = self.make_job("a", operation="uv", result={"files": [
            {"name": "model.glb", "role": "model", "sha256": digest}
        ]})
        model = directory / "output/model.glb"
        model.parent.mkdir()
        model.write_bytes(source)
        cache = directory / "uv-previews" / f"{digest}-seams-v3.png"
        cache.parent.mkdir()
        png = b"\x89PNG\r\n\x1a\n" + bytes(48) + b"\x00\x00\x00\x00IEND\xaeB\x60\x82"
        cache.write_bytes(png)
        other = directory / "uv-previews" / f"{digest}-ao-v3.png"
        other.write_bytes(png)
        project = self.projects_root / "p/project.json"
        self.write_json(project, {"id": "test"})
        totals, rows = self.report()
        self.assertEqual(totals["bytesByCategory"]["regenerable"], len(png))
        self.assertEqual(rows[job_id]["regenerableFiles"], [f"uv-previews/{cache.name}"])

        model.write_bytes(source + b"modified")
        self.assertEqual(self.report()[0]["bytesByCategory"]["regenerable"], 0)
        model.write_bytes(source)
        project.write_text("{", encoding="utf-8")
        totals, _ = self.report()
        self.assertEqual(totals["issues"][0]["reason"], "project_record_unreadable")
        self.assertEqual(totals["bytesByCategory"]["regenerable"], 0)
        self.write_json(project, {"sourceJobId": job_id})
        _, rows = self.report()
        self.assertEqual(rows[job_id]["bytesByCategory"]["referenced"], rows[job_id]["logicalBytes"])
        self.assertEqual(cache.read_bytes(), png)
        self.assertEqual(other.read_bytes(), png)
        self.assertEqual(model.read_bytes(), source)


if __name__ == "__main__":
    unittest.main()
