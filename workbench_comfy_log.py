from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from workbench_logging import RotatingTextLog, pump_text_log


def main() -> int:
    parser = argparse.ArgumentParser(description="Drain owned ComfyUI output into the rotating workbench log.")
    parser.add_argument("--log", required=True, type=Path)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
    pump_text_log(sys.stdin, RotatingTextLog(args.log))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
