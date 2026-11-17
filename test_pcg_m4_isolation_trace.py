"""Bounded synthetic failure evidence, never a substitute for real isolation."""
import json
import os
import sys
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts.pcg_m4_isolation_trace import IsolationTrace, MAX_BYTES, NATIVE_PHASES
from scripts.pcg_m4_rpc_trace import write_once


SECRET = 'PRIVATE_PATH_GRAPH_ARGUMENT_CREDENTIAL'


def fixture():
    local = threading.local()
    c = SimpleNamespace(get_last_error=lambda: getattr(local, 'error', 0),
                        set_last_error=lambda n: setattr(local, 'error', n))
    native = SimpleNamespace(C=c)
    def api(*args):
        c.set_last_error(5)
        return 1
    for name in list(NATIVE_PHASES) + ['Wait', 'PeekPipe', 'ReadFile']:
        setattr(native, name, api)
    native.profile = lambda *_: (SECRET, SECRET)
    native.Wait = lambda *_: 258
    module = SimpleNamespace(os=SimpleNamespace(name='nt'), prepare_error=None, run_reason=None)
    class IsolationError(Exception):
        def __init__(self, code): self.code = code; super().__init__(SECRET)
    class Session:
        def __enter__(self):
            native.profile(SECRET)
            module._acl(SECRET, SECRET, SECRET)
            if module.prepare_error is not None: raise module.prepare_error
            return self
        def stage(self): return SECRET
        def run(self, payload, **kwargs):
            native.InitAttrs(None)
            native.CreateJob(SECRET)
            native.SetJob(SECRET)
            native.CreateProcess(SECRET)
            native.AssignJob(SECRET)
            native.Resume(SECRET)
            for _ in range(100): native.Wait(SECRET, 20)
            return SECRET.encode(), SECRET.encode(), 125 if module.run_reason else 0, module.run_reason
        def __exit__(self, *_): return False
    module._Session = Session
    module._acl = lambda *_: None
    def preflight():
        try:
            with Session() as session:
                answer = session.run(b'', timeout=5, memory_bytes=128*1024**2, max_output_bytes=1024, cancelled=None)
                if answer[2] or answer[3]: return {'available': False, 'message': SECRET}
            return {'available': True, 'message': SECRET}
        except (OSError, IsolationError):
            return {'available': False, 'message': SECRET}
    def execute(payload, **kwargs):
        with Session() as session:
            session.stage()
            answer = session.run(payload, timeout=15, memory_bytes=512*1024**2, max_output_bytes=64*1024**2, cancelled=None)
        if answer[3]: raise IsolationError(answer[3])
        return answer[0]
    module.preflight, module.execute = preflight, execute
    return module, native


class IsolationTraceTests(unittest.TestCase):
    def setUp(self):
        self.module, self.native = fixture()
        self.trace = IsolationTrace().install(self.module, self.native)
        self.addCleanup(self.trace.restore)

    def test_preparation_failure_and_timeout_have_distinct_stage_evidence(self):
        failure = PermissionError(5, SECRET)
        self.module.prepare_error = failure
        self.assertFalse(self.module.preflight()['available'])
        self.module.prepare_error = None
        self.module.run_reason = 'TIMEOUT'
        with self.assertRaises(Exception) as caught:
            self.module.execute(SECRET.encode())
        self.assertEqual(caught.exception.code, 'TIMEOUT')
        value = json.loads(self.trace.freeze())
        first, second = value['completed']
        self.assertEqual((first['kind'], first['reason']), ('preflight', 'ISOLATION_UNAVAILABLE'))
        self.assertEqual((second['kind'], second['reason']), ('execute', 'TIMEOUT'))
        self.assertTrue(any(e['phase'] == 'session-prepare' and e['state'] == 'PermissionError' for e in first['events']))
        self.assertFalse(any(e['phase'] == 'process-create' for e in first['events']))
        resource = next(e for e in second['events'] if e['phase'] == 'resource-run' and e['state'] == 'TIMEOUT')
        self.assertEqual(resource['exitCode'], 125)
        self.assertEqual(resource['timeout'], 15)
        self.assertEqual(second['poll']['Wait']['calls'], 100)
        self.assertEqual(second['poll']['Wait']['lastResult'], 258)
        self.assertEqual(value['firstFailure'], first)
        self.assertEqual(value['failures']['ISOLATION_UNAVAILABLE'], first)
        self.assertEqual(value['failures']['TIMEOUT'], second)
        self.assertNotIn(SECRET.encode(), self.trace.freeze())

    def test_last_error_and_original_result_or_exception_are_preserved(self):
        self.assertEqual(self.module.execute(SECRET.encode()), SECRET.encode())
        with mock.patch.object(self.trace, '_native_result', side_effect=lambda *a: self.native.C.set_last_error(999)):
            self.assertEqual(self.native.CreateProcess(SECRET), 1)
            self.assertEqual(self.native.C.get_last_error(), 5)
        with mock.patch.object(self.trace, '_poll', side_effect=lambda *a: self.native.C.set_last_error(999)):
            self.native.C.set_last_error(123)
            self.assertEqual(self.native.Wait(SECRET, 0), 258)
            self.assertEqual(self.native.C.get_last_error(), 123)
        failure = OSError(5, SECRET)
        self.module.prepare_error = failure
        with self.assertRaises(OSError) as caught:
            self.module.execute(SECRET.encode())
        self.assertIs(caught.exception, failure)

    def test_cancel_does_not_pin_first_failure_and_diagnostics_do_not_mask_failure(self):
        self.module.run_reason = 'CANCELLED'
        with self.assertRaises(Exception): self.module.execute(b'')
        self.assertIsNone(json.loads(self.trace.freeze())['firstFailure'])
        # A fresh observer snapshot is not modified after export.
        self.trace.frozen = None
        failure = OSError(5, SECRET)
        self.module.prepare_error = failure
        with mock.patch.object(self.trace, '_mark', side_effect=RuntimeError(SECRET)):
            with self.assertRaises(OSError) as caught: self.module.execute(b'')
        self.assertIs(caught.exception, failure)
        value = json.loads(self.trace.freeze())
        self.assertGreater(value['diagnosticErrors'], 0)
        self.assertEqual(value['firstFailure']['reason'], 'OTHER')
        self.assertNotIn(SECRET.encode(), self.trace.freeze())

    def test_capacity_native_poll_bytes_and_atomic_exclusive_export(self):
        self.module.execute(b'')
        def polling():
            for _ in range(10000): self.native.Wait(SECRET, 20)
            class Count: value = 7
            self.native.PeekPipe(SECRET, None, 0, None, SimpleNamespace(_obj=Count()), None)
            self.native.ReadFile(SECRET, SECRET, 7, SimpleNamespace(_obj=Count()), None)
            return None
        self.trace.call(polling, 'execute')
        for _ in range(40): self.module.preflight()
        self.assertLessEqual(len(self.trace.completed), 16)
        body = self.trace.freeze()
        self.assertLessEqual(len(body), MAX_BYTES)
        self.assertNotIn(SECRET.encode(), body)
        with tempfile.TemporaryDirectory(prefix='pcg-isolation-trace-') as directory:
            target = Path(directory)/'isolation.json'
            write_once(self.trace, target)
            self.assertEqual(target.read_bytes(), body)
            with self.assertRaises(FileExistsError): write_once(self.trace, target)
        self.assertTrue(all(len(r['events']) <= 64 for r in json.loads(body)['completed']))

    def test_subprocess_error_codes_only_and_observer_restore(self):
        import subprocess
        self.trace.restore()
        self.module.subprocess = SimpleNamespace(run=lambda *a, **k: SimpleNamespace(returncode=5))
        self.module.shutil = SimpleNamespace(copyfile=lambda *a: SECRET)
        original = self.module.subprocess.run
        self.trace = IsolationTrace().install(self.module, self.native)
        def action():
            self.module.subprocess.run(['icacls', SECRET, '/setintegritylevel', SECRET])
            self.module.shutil.copyfile(SECRET, SECRET)
            return None
        self.trace.call(action, 'execute')
        result = json.loads(self.trace.freeze())['completed'][0]
        integrity = next(e for e in result['events'] if e['phase'] == 'integrity-command' and e['state'] == 'end')
        self.assertEqual(integrity['exitCode'], 5)
        self.assertTrue(any(e['phase'] == 'staged-file-copy' for e in result['events']))
        self.assertNotIn(SECRET.encode(), self.trace.freeze())
        self.trace.restore()
        self.assertIs(self.module.subprocess.run, original)

    def test_full_active_and_failure_budget_keeps_first_failure_and_phase_summary(self):
        for reason in ('ISOLATION_UNAVAILABLE', 'TIMEOUT'):
            self.module.run_reason = reason
            with self.assertRaises(Exception): self.module.execute(b'')
        for _ in range(10):
            self.trace.local.call = self.trace._begin('execute')
            for _ in range(4):
                for phase in list(NATIVE_PHASES.values()) + ['session-prepare', 'resource-run', 'staged-file-copy', 'acl', 'integrity-command']:
                    self.trace._mark(phase, 'end', lastError=5)
        value = json.loads(self.trace.freeze())
        self.assertLessEqual(len(self.trace.freeze()), MAX_BYTES)
        self.assertLessEqual(len(value['active']), 8)
        self.assertEqual(set(value['failures']), {'ISOLATION_UNAVAILABLE', 'TIMEOUT'})
        self.assertEqual(value['firstFailure']['reason'], 'ISOLATION_UNAVAILABLE')
        self.assertIn('session-prepare', value['failures']['TIMEOUT']['phases'])
        self.assertNotIn(SECRET.encode(), self.trace.freeze())


@unittest.skipUnless(os.name == 'nt', 'Native Windows diagnostic boundary only.')
class NativeIsolationTraceTests(unittest.TestCase):
    def test_real_prepare_rejection_and_owned_native_timeout(self):
        import pcg_isolation as isolation
        import pcg_isolation_win as native
        base = Path(sys.executable).resolve().parent
        if not (base / ('python%d%d.zip' % sys.version_info[:2])).is_file():
            self.skipTest('Native diagnostic probe requires the existing self-contained interpreter; no installation fallback.')
        original_preflight = isolation.preflight
        original_preflight.cache_clear()
        trace = IsolationTrace().install(isolation)
        try:
            self.assertTrue(isolation.preflight()['available'], 'Real isolated launch must be available.')
            original_preflight.cache_clear()
            failure = PermissionError(5, SECRET)
            with mock.patch.object(isolation, '_acl', side_effect=failure):
                self.assertFalse(isolation.preflight()['available'])
            def timed_probe():
                with isolation._Session() as session:
                    session.worker.write_text('import time\ntime.sleep(30)\n', encoding='utf8')
                    output, errors, code, reason = session.run(b'', timeout=.2, memory_bytes=128*1024**2,
                                                              max_output_bytes=1024, cancelled=None)
                self.assertEqual(reason, 'TIMEOUT')
                self.assertNotEqual(code, 0)
                raise isolation.IsolationError(reason, SECRET)
            with self.assertRaises(isolation.IsolationError): trace.call(timed_probe, 'execute')
            value = json.loads(trace.freeze())
            rejected = value['failures']['ISOLATION_UNAVAILABLE']
            timed = value['failures']['TIMEOUT']
            self.assertTrue(any(e['phase'] == 'session-prepare' and e['state'] == 'PermissionError' and e['errno'] == 5 for e in rejected['events']))
            self.assertFalse(any(e['phase'] == 'process-create' for e in rejected['events']))
            self.assertTrue(any(e['phase'] == 'process-create' and e['state'] == 'end' and e['ok'] for e in timed['events']))
            self.assertTrue(any(e['phase'] == 'resource-run' and e['state'] == 'TIMEOUT' for e in timed['events']))
            self.assertGreater(timed['poll']['Wait']['calls'], 0)
            self.assertEqual(value['diagnosticErrors'], 0)
            self.assertNotIn(SECRET.encode(), trace.freeze())
            # Numeric, fixed-schema evidence only. No original exception message.
            print('ISOLATION_DIAG_NATIVE=' + trace.freeze().decode('utf8'))
        finally:
            trace.restore()
            original_preflight.cache_clear()


if __name__ == '__main__': unittest.main()
