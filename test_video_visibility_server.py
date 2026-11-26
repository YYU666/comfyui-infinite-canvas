"""Isolated video visibility fixture. FFmpeg is real; SAM3 is supplied a synthetic mask."""
import os
from pathlib import Path
import sys
from time import monotonic, sleep

def main():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import numpy as np
    import video_workbench_launcher as launcher
    from test_video_plate import write_rgb

    if os.environ.get("H3_WORKBENCH_TEST_MODE") != "1" or os.environ.get("H3_COMFY_URL") != "http://127.0.0.1:1":
        raise SystemExit("This fixture requires a disabled Comfy endpoint and an isolated runtime.")
    gate_dir = Path(os.environ["REFMUSE_VIDEO_TEST_GATE"])
    launcher.workbench_ports = lambda _instance: (0,)
    launcher.INPUT_DIR = gate_dir.parent / "comfy-input"
    launcher.OUTPUT_DIR = gate_dir.parent / "comfy-output"


    def gate_manager(manager):
        original = manager._progress

        def progress(self, job):
            original_callback = original(self, job)
            paused = False

            def callback(value, stage):
                nonlocal paused
                original_callback(value, stage)
                if paused:
                    return
                paused = True
                gate = gate_dir / job["id"]
                deadline = monotonic() + 45
                while not gate.is_file() and job["stage"] != "正在取消":
                    if monotonic() > deadline:
                        raise RuntimeError("Test did not release its video render.")
                    sleep(0.02)

            return callback

        manager._progress = progress


    def mask(video_path, document, info, workdir, progress, cancelled):
        progress(0.35, "正在分析白模区域（合成遮罩）")
        if cancelled():
            from video_edit_ffmpeg import Cancelled
            raise Cancelled()
        width, height = info["width"], info["height"]
        frame = np.zeros((height, width, 3), np.uint8)
        frame[height // 4:height * 3 // 4, width // 4:width * 3 // 4] = 255
        return write_rgb(Path(workdir) / "fixture-mask.mp4", [frame] * info["frameCount"])


    plate_manager = launcher.VideoPlateJobs


    class TestPlateJobs(plate_manager):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs, segmenter=mask)


    launcher.VideoPlateJobs = TestPlateJobs
    for manager in (launcher.VideoEditJobs, launcher.VideoRhythmJobs, launcher.VideoChromaJobs, launcher.VideoPlateJobs):
        gate_manager(manager)
    return launcher.main()


if __name__ == "__main__":
    raise SystemExit(main())
