from __future__ import annotations

import logging
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

from workbench_doctor import redact_text
from workbench_lifecycle import runtime_dir

LOG_MAX_BYTES = 10 * 1024 * 1024
LOG_BACKUP_COUNT = 5


class RedactingFormatter(logging.Formatter):
    def format(self, record):
        return redact_text(super().format(record))


def rotating_file_handler(path: Path, max_bytes=LOG_MAX_BYTES, backup_count=LOG_BACKUP_COUNT):
    handler = RotatingFileHandler(path, maxBytes=max_bytes, backupCount=backup_count, encoding="utf-8", delay=True)
    handler.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(message)s"))
    return handler


def configure_application_logging(debug=False, runtime=None):
    log_dir = Path(runtime).resolve() / "logs" if runtime else runtime_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    handlers = [rotating_file_handler(log_dir / "app.log")]
    if debug:
        console = logging.StreamHandler()
        console.setFormatter(RedactingFormatter("%(asctime)s %(levelname)s %(message)s"))
        handlers.append(console)
    logging.basicConfig(level=logging.INFO, handlers=handlers, force=True)
    return log_dir


class RotatingTextLog:
    """Thread-safe text sink used by the owned ComfyUI output pump."""

    def __init__(self, path: Path, max_bytes=LOG_MAX_BYTES, backup_count=LOG_BACKUP_COUNT):
        self.logger = logging.getLogger(f"h3-comfy-output-{id(self)}")
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False
        self.handler = rotating_file_handler(path, max_bytes=max_bytes, backup_count=backup_count)
        self.logger.addHandler(self.handler)
        self._close_lock = threading.Lock()
        self._closed = False

    def write(self, text):
        with self._close_lock:
            if self._closed:
                return
            for line in str(text).splitlines():
                self.logger.info("%s", line)

    def close(self):
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
            self.logger.removeHandler(self.handler)
            self.handler.close()


def pump_text_log(stream, sink: RotatingTextLog):
    """Drain a subprocess pipe until EOF so ComfyUI can never block on a full pipe."""
    try:
        for line in iter(stream.readline, ""):
            sink.write(line)
    finally:
        sink.close()
        stream.close()


def cleanup_legacy_comfy_logs(log_dir: Path, keep=LOG_BACKUP_COUNT):
    """Bound logs created by the old timestamp-per-start scheme, newest first."""
    logs = sorted(Path(log_dir).glob("comfyui-2*.log"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in logs[keep:]:
        try:
            path.unlink()
        except OSError:
            # An active or locked old file is left untouched; rotation of the new log still works.
            pass
