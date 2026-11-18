"""Transcription contract, audio clock alignment, and worker cancellation."""
from fractions import Fraction
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
import wave

from project_store import StoreError
from video_edit_ffmpeg import Cancelled, Runner, probe
from video_edit_jobs import VideoEditJobs
from video_transcript import TranscriptError, _source_segments, _speech_process, transcribe_video


class VideoTranscriptTests(TestCase):
    def test_source_segments_clamp_rounding_and_audio_offset(self):
        speech = {"language": "zh", "segments": [
            {"startMs": 0, "endMs": 400, "text": " 片头 "},
            {"startMs": 1900, "endMs": 2500, "text": "片尾"},
            {"startMs": 2500, "endMs": 3000, "text": "画面结束后的音频"},
        ]}
        self.assertEqual(_source_segments(speech, -200, 2000), {
            "language": "zh", "durationMs": 2000, "segments": [
                {"startMs": 0, "endMs": 200, "text": "片头"},
                {"startMs": 1700, "endMs": 2000, "text": "片尾"},
            ],
        })
        with self.assertRaises(TranscriptError):
            _source_segments({"language": "zh", "segments": [{"startMs": True, "endMs": 400, "text": "片头"}]},
                             0, 1000)

    def test_mono_audio_extraction_keeps_video_relative_offset_and_cleans_up(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "synthetic.mov"
            runner = Runner()
            runner.run([
                "-f", "lavfi", "-i", "color=white:s=128x72:r=30:d=2",
                "-itsoffset", "0.4", "-f", "lavfi", "-i", "sine=440:duration=1",
                "-c:v", "libx264", "-c:a", "pcm_s16le", str(source),
            ])

            def fake_speech(_runner, _interpreter, _model, audio):
                with wave.open(str(audio), "rb") as handle:
                    self.assertEqual((handle.getframerate(), handle.getnchannels(), handle.getsampwidth()),
                                     (16000, 1, 2))
                    self.assertEqual(handle.getnframes(), 16000)
                return {"language": "en", "segments": [{"startMs": 50, "endMs": 600, "text": "test"}]}

            info = probe(runner, source)
            self.assertEqual(info["audioOffset"], Fraction(2, 5))
            with (mock.patch("video_transcript._local_model", return_value=root),
                  mock.patch("video_transcript._runtime", return_value=Path("synthetic-python")),
                  mock.patch("video_transcript._speech_process", side_effect=fake_speech)):
                result = transcribe_video(runner, source, info, root / "job", max_seconds=3600)
            self.assertEqual(result, {"language": "en", "durationMs": 2000, "segments": [
                {"startMs": 450, "endMs": 1000, "text": "test"},
            ]})
            self.assertFalse((root / "job" / "transcript.wav").exists())

    def test_speech_child_runs_offline_and_is_killed_after_cancellation(self):
        runner = Runner(ffmpeg="fixture")
        process = mock.Mock()
        process.poll.return_value = None

        def cancel_during_communication(timeout):
            runner.cancel()
            raise subprocess.TimeoutExpired("local-test", timeout)

        def communicate(timeout=None):
            if timeout is not None:
                cancel_during_communication(timeout)
            return b"", b""

        process.communicate.side_effect = communicate
        with mock.patch("video_transcript.subprocess.Popen", return_value=process) as spawn:
            with self.assertRaises(Cancelled):
                _speech_process(runner, Path("fixture-python"), Path("fixture-model"), Path("fixture.wav"))
        process.kill.assert_called_once()
        self.assertFalse(spawn.call_args.kwargs["shell"])
        self.assertEqual(spawn.call_args.kwargs["env"]["HF_HUB_OFFLINE"], "1")

    def test_transcript_job_stays_bound_to_source_project_without_writes(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            store = mock.Mock()
            store.asset_file.return_value = source
            jobs = VideoEditJobs(root / "jobs", store, runner_factory=mock.Mock())
            payload = {"projectId": "prj_fixture", "nodeId": "edit", "slot": "v1", "mode": "transcript",
                       "assetPath": "assets/" + "a" * 64 + ".mp4"}
            result = {"language": "zh", "durationMs": 1000, "segments": []}
            seconds = Fraction(1, 30)
            info = {"width": 128, "height": 72, "frameCount": 30, "duration": Fraction(1),
                    "timebase": seconds, "frameTimebase": seconds, "audioOffset": Fraction(0)}
            try:
                with (mock.patch("video_edit_jobs.probe", return_value=info),
                      mock.patch("video_edit_jobs.transcribe_video", return_value=result)):
                    with self.assertRaises(StoreError):
                        jobs.submit_auto_cut({**payload, "assetPath": str(source)})
                    job = jobs.submit_auto_cut(payload)
                    done = jobs.wait(job["id"], 2)
                self.assertEqual(done["status"], "completed")
                self.assertEqual(done["inputs"], {"v1": payload["assetPath"]})
                self.assertEqual(done["result"]["source"]["frameCount"], 30)
                self.assertEqual(done["projectId"], "prj_fixture")
                store.asset_file.assert_called_once_with("prj_fixture", payload["assetPath"])
                with self.assertRaises(StoreError):
                    jobs.commit(job["id"], {"projectId": "prj_fixture", "revision": 1})
                with self.assertRaises(StoreError):
                    jobs.cancel(job["id"], "prj_other")
                store.put_asset.assert_not_called()
            finally:
                jobs.close()
