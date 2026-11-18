"""Test-only worker phase markers, carried on the existing bounded stderr pipe."""
import os
import re
import tempfile

PHASES = (
    'script-enter', 'imports-ready', 'stdin-read-start', 'stdin-read-done',
    'request-parse-start', 'request-parse-done', 'evaluation-start', 'evaluation-done',
    'response-encode-start', 'response-write-start', 'response-flushed',
)

_PREFIX = r'''
import sys as _pcg_trace_sys
from time import monotonic_ns as _pcg_trace_clock, process_time_ns as _pcg_trace_cpu

def _pcg_mark(number):
    try:
        stream = _pcg_trace_sys.stderr.buffer
        stream.write(b'PCG_W1:' + str(number).encode('ascii') + b':' +
                     str(_pcg_trace_clock()).encode('ascii') + b':' +
                     str(_pcg_trace_cpu()).encode('ascii') + b'\n')
        stream.flush()
    except (AttributeError, OSError, ValueError):
        pass

_pcg_mark(0)
'''


def instrument_worker(source):
    """Annotate only known anchors in the trusted staged test copy."""
    anchors = (
        ('from __future__ import annotations\n', 'from __future__ import annotations\n' + _PREFIX),
        ('def diagnose(request):', '_pcg_mark(1)\n\n\ndef diagnose(request):'),
        ('        raw = sys.stdin.buffer.read(32 * MAX_VALUE_BYTES + 1)',
         '        _pcg_mark(2)\n        raw = sys.stdin.buffer.read(32 * MAX_VALUE_BYTES + 1)\n        _pcg_mark(3)'),
        ('        request = parse_json(raw)',
         '        _pcg_mark(4)\n        request = parse_json(raw)\n        _pcg_mark(5)\n        _pcg_mark(6)'),
        ("        output = {'ok': True, 'result': result}",
         "        _pcg_mark(7)\n        output = {'ok': True, 'result': result}"),
        ("    sys.stdout.buffer.write(canonical(output) + b'\\n')\n    sys.stdout.buffer.flush()",
         "    _pcg_mark(8)\n    response = canonical(output) + b'\\n'\n    _pcg_mark(9)\n"
         "    sys.stdout.buffer.write(response)\n    sys.stdout.buffer.flush()\n    _pcg_mark(10)"),
    )
    for old, new in anchors:
        if source.count(old) != 1:
            raise ValueError('Worker test instrumentation anchor changed.')
        source = source.replace(old, new, 1)
    return source


def stage_probe(worker):
    """Leave an intact original worker if test-only staging fails."""
    source = instrument_worker(worker.read_text(encoding='utf8'))
    fd, temp = tempfile.mkstemp(prefix='.pcg-test-worker-', dir=worker.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf8', newline='\n') as handle:
            handle.write(source)
        os.replace(temp, worker)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


_MARKER = re.compile(rb'PCG_W1:(0|[1-9]|10):([0-9]{1,19}):([0-9]{1,19})')


def read_markers(stderr, start_ns, observed_ns):
    """Retain a finite ordered prefix of valid events. Ignore all other bytes."""
    if type(stderr) is not bytes or len(stderr) > 65536:
        return []
    events = []
    last_rank, last_ns, last_cpu = -1, start_ns, 0
    for line in stderr.split(b'\n')[:-1]:
        match = _MARKER.fullmatch(line)
        if match is None:
            continue
        rank, stamp, cpu = map(int, match.groups())
        if rank <= last_rank or not last_ns <= stamp <= observed_ns or not last_cpu <= cpu <= 1_000_000_000_000:
            continue
        events.append({'phase': PHASES[rank], 'ms': round((stamp - start_ns) / 1_000_000, 3),
                       'childCpuMs': round(cpu / 1_000_000, 3)})
        last_rank, last_ns, last_cpu = rank, stamp, cpu
    return events


def cpu_sample(native, process):
    """Read totals from the owned handle already passed to GetExitCodeProcess."""
    c, w = native.C, native.W
    query = native.api(native.k, 'GetProcessTimes', w.BOOL,
                       [w.HANDLE] + [c.POINTER(w.FILETIME)] * 4)
    creation, exit_time, kernel, user = (w.FILETIME() for _ in range(4))
    if not query(process, c.byref(creation), c.byref(exit_time), c.byref(kernel), c.byref(user)):
        return None

    def milliseconds(filetime):
        return round(((filetime.dwHighDateTime << 32) | filetime.dwLowDateTime) / 10_000, 3)

    return {'userMs': milliseconds(user), 'kernelMs': milliseconds(kernel)}
