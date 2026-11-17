"""Synthetic CPU-only repair acceptance. No service, GPU or user asset."""
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
import numpy as np
from project_store import ProjectStore, StoreError
from video_edit_ffmpeg import Runner, find_ffmpeg, probe
from video_edit_testmedia import make_video
from video_repair_document import RepairDocumentError, normalize_repair_document, plan_repair
from video_repair_ffmpeg import render_export, render_preview
from video_repair_jobs import VideoRepairJobs

SETTINGS = {'schemaVersion': 1, 'rect': {'x': .4, 'y': .4, 'width': .2, 'height': .2}, 'start': 0, 'end': 1}


class RepairTests(TestCase):
    def test_schema_and_bounds(self):
        self.assertEqual(normalize_repair_document(SETTINGS), SETTINGS)
        for bad in [{**SETTINGS, 'path': '../forbidden'}, {**SETTINGS, 'start': -1}, {**SETTINGS, 'end': 0}, {**SETTINGS, 'rect': {'x': .9, 'y': .9, 'width': .2, 'height': .2}}]:
            with self.assertRaises(RepairDocumentError): normalize_repair_document(bad)

    def test_real_cpu_export_preview_audio_and_versioned_jobs(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            clean = make_video(root / 'clean.mp4', frames=24, text=False)
            source = root / 'marked.mp4'
            subprocess.run([find_ffmpeg(), '-hide_banner', '-loglevel', 'error', '-i', str(clean), '-vf', 'drawbox=x=54:y=32:w=19:h=8:color=white:t=fill', '-c:v', 'libx264', '-crf', '10', '-c:a', 'copy', str(source)], check=True, capture_output=True)
            runner = Runner(); info = probe(runner, source); plan_repair(SETTINGS, info)
            previews = [render_preview(runner, SETTINGS, source, mode=mode) for mode in ['original', 'mask', 'repaired']]
            self.assertTrue(all(value['png'].startswith(b'\x89PNG') for value in previews))
            self.assertNotEqual(previews[0]['png'], previews[2]['png'])
            target = root / 'repaired.mp4'; result = render_export(runner, SETTINGS, source, target)
            self.assertEqual(result['frames'], 24); self.assertEqual(result['method'], 'spatial-delogo')
            def pixel(file):
                raw = runner.run(['-i', str(file), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
                return np.frombuffer(raw, np.uint8).reshape(72, 128, 3)[34:38, 58:68].mean()
            self.assertGreater(pixel(source), 220); self.assertLess(pixel(target), 190)
            store = ProjectStore(root / 'projects', 'synthetic-repair-test'); project = store.create('Synthetic repair')
            with source.open('rb') as stream: saved = store.put_asset(project['id'], source.name, stream, 'video/mp4')
            jobs = VideoRepairJobs(root / 'jobs', store)
            try:
                job = jobs.submit({'projectId': project['id'], 'nodeId': 'repair', 'source': saved['asset']['path'], 'settings': SETTINGS})
                self.assertEqual(jobs.wait(job['id'], 15)['status'], 'completed')
                with self.assertRaises(StoreError): jobs.commit(job['id'], {'projectId': project['id'], 'revision': 999})
                committed = jobs.commit(job['id'], {'projectId': project['id'], 'revision': saved['revision']})
                self.assertTrue(committed['asset']['path'].startswith('assets/'))
                jobs.replace_store(store)
                with self.assertRaises(StoreError): jobs.get(job['id'])
            finally: jobs.close(); store.close(); runner.cancel()
