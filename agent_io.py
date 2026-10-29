from __future__ import annotations

import sys


def configure_utf8():
    """Force protocol/CLI streams to UTF-8, independently of console code page."""
    for name in ("stdin", "stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
