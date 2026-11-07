"""Independent, cached read-only CPU/RAM and NVIDIA whole-device metrics."""
import csv
import io
import math
import os
import shutil
import subprocess
import threading
import time

import psutil

MIB = 1024 ** 2
GPU_UNKNOWN = {'vramUsed': None, 'vramTotal': None, 'gpuPercent': None,
               'gpuName': None, 'gpuIndex': None}
SMI_ARGUMENTS = ('--query-gpu=index,name,memory.used,memory.total,utilization.gpu',
                 '--format=csv,noheader,nounits')


def parse_nvidia_metrics(output):
    """Select the lowest hardware index, never sum or substitute another card."""
    rows = []
    for row in csv.reader(io.StringIO(output)):
        if not row or not any(value.strip() for value in row):
            continue
        if len(row) != 5:
            raise ValueError('Invalid NVIDIA metrics columns')
        index = int(row[0].strip())
        if index < 0:
            raise ValueError('Invalid GPU index')
        rows.append((index, [value.strip() for value in row]))
    if not rows:
        raise ValueError('No NVIDIA devices')
    index, row = min(rows, key=lambda item: item[0])
    used, total, utilization = map(float, row[2:])
    if not row[1] or not all(math.isfinite(value) for value in (used, total, utilization)):
        raise ValueError('Unavailable NVIDIA metrics')
    if not 0 <= used <= total or total <= 0 or not 0 <= utilization <= 100:
        raise ValueError('Invalid NVIDIA metric range')
    return {'gpuIndex': index, 'gpuName': row[1], 'vramUsed': int(used * MIB),
            'vramTotal': int(total * MIB), 'gpuPercent': utilization}


class HardwareMetrics:
    def __init__(self, ttl=2.0):
        self.ttl = max(.1, float(ttl))
        self._lock = threading.Lock()
        self._cached = None
        self._expires = 0.

    def _gpu(self):
        executable = shutil.which('nvidia-smi')
        if not executable:
            return dict(GPU_UNKNOWN)
        options = {'capture_output': True, 'text': True, 'timeout': 1.5,
                   'check': True, 'shell': False}
        if os.name == 'nt':
            options['creationflags'] = subprocess.CREATE_NO_WINDOW
        result = subprocess.run([executable, *SMI_ARGUMENTS], **options)
        return parse_nvidia_metrics(result.stdout)

    def read(self):
        # Single-flight refresh, including failures, prevents spawn storms.
        with self._lock:
            if self._cached is not None and time.monotonic() < self._expires:
                return dict(self._cached)
            metrics = {'cpuPercent': None, 'ramTotal': None, 'ramUsed': None,
                       **GPU_UNKNOWN}
            try:
                # A finite sample avoids psutil's first-call zero per HTTP thread.
                cpu = float(psutil.cpu_percent(interval=.1))
                if math.isfinite(cpu) and 0 <= cpu <= 100:
                    metrics['cpuPercent'] = round(cpu, 1)
            except Exception:
                pass
            try:
                memory = psutil.virtual_memory()
                metrics.update(ramTotal=int(memory.total), ramUsed=int(memory.total-memory.available))
            except Exception:
                pass
            try:
                metrics.update(self._gpu())
            except Exception:
                # Missing/unsupported driver values and timeouts are unknown, not 0.
                pass
            metrics['timestamp'] = int(time.time() * 1000)
            self._cached = metrics
            self._expires = time.monotonic() + self.ttl
            return dict(metrics)


_METRICS = HardwareMetrics()


def hardware_metrics():
    return _METRICS.read()
