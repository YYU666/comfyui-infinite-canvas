"""No processes or servers: exported job identities cannot cross project roots."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
from project_store import StoreError
from video_rhythm_jobs import VideoRhythmJobs
from video_chroma_jobs import VideoChromaJobs
from video_repair_jobs import VideoRepairJobs


class ProcessorLifecycleTests(TestCase):
    def test_finished_jobs_are_invalidated_and_active_jobs_block_root_change(self):
        for job_type, prefix in [(VideoRhythmJobs, 'vry'), (VideoChromaJobs, 'vck'), (VideoRepairJobs, 'vrp')]:
            with self.subTest(job_type=job_type), TemporaryDirectory() as temporary:
                old, new = mock.Mock(), mock.Mock()
                jobs = job_type(Path(temporary), old)
                job_id = prefix + '_' + 'a' * 32
                jobs.jobs[job_id] = {'id': job_id, 'projectId': 'prj_same', 'status': 'running'}
                with self.assertRaises(StoreError): jobs.replace_store(new)
                self.assertIs(jobs.store, old)
                jobs.jobs[job_id]['status'] = 'completed'
                jobs.replace_store(new)
                with self.assertRaises(StoreError): jobs.get(job_id)
                new.put_asset.assert_not_called()
                jobs.close()
