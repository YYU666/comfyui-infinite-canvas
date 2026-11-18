"""Synthetic owned-fixture OS boundary tests; no live services or user files."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from unittest import mock

import pcg_isolation as isolation


PROBE = r'''
import ctypes as c, json, os, socket, subprocess, sys
data=json.loads(sys.stdin.buffer.read())
out={}
def denied(name, action):
    try: action(); out[name]={'denied':False}
    except OSError as exc: out[name]={'denied':True,'errno':exc.errno,'winerror':getattr(exc,'winerror',None)}
denied('read_outside', lambda: open(data['outside'],'rb').read())
denied('write_outside', lambda: open(data['outside'],'ab').write(b'x'))
denied('create_outside', lambda: open(data['outside']+'.new','wb').write(b'x'))
denied('write_code', lambda: open(__file__,'ab').write(b'x'))
denied('write_request', lambda: open(os.path.join(os.path.dirname(__file__),'pcg-request.stdin'),'ab').write(b'x'))
with open(os.path.join(os.environ['TEMP'],'owned.txt'),'w') as f: f.write('owned')
out['own_temp']=True
sock=socket.socket(); sock.settimeout(1)
denied('network', lambda: sock.connect(('192.0.2.1',9))); sock.close()
denied('child', lambda: subprocess.run([sys.executable,'-I','-c','pass'],timeout=2,check=True))
out['environment']=sorted(os.environ)
out['sentinel_present']='PCG_PRIVATE_SENTINEL' in os.environ
try:
    huge=bytearray(512*1024*1024)
    out['memory_denied']=False
except MemoryError: out['memory_denied']=True
adv=c.WinDLL('advapi32',use_last_error=True); kernel=c.WinDLL('kernel32',use_last_error=True)
adv.OpenProcessToken.argtypes=[c.c_void_p,c.c_ulong,c.POINTER(c.c_void_p)]
adv.GetTokenInformation.argtypes=[c.c_void_p,c.c_int,c.c_void_p,c.c_ulong,c.POINTER(c.c_ulong)]
kernel.GetCurrentProcess.restype=c.c_void_p; kernel.CloseHandle.argtypes=[c.c_void_p]
token=c.c_void_p(); assert adv.OpenProcessToken(kernel.GetCurrentProcess(),8,c.byref(token))
value=c.c_ulong(); size=c.c_ulong()
assert adv.GetTokenInformation(token,29,c.byref(value),4,c.byref(size))
out['is_appcontainer']=value.value
adv.GetTokenInformation(token,30,None,0,c.byref(size))
groups=c.create_string_buffer(size.value)
assert adv.GetTokenInformation(token,30,groups,size.value,c.byref(size))
out['capability_count']=c.cast(groups,c.POINTER(c.c_ulong)).contents.value
kernel.CloseHandle(token)
print(json.dumps(out))
'''


@unittest.skipUnless(os.name == 'nt', 'Native Windows isolation only.')
class IsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        state = isolation.preflight()
        if not state['available']:
            raise unittest.SkipTest(state['message'])

    def _fixture(self, source, payload=b'', timeout=5, memory_bytes=128*1024**2,
                 max_output_bytes=8192, cancelled=None, cpu_seconds=None):
        with isolation._Session() as session:
            session.worker.write_text(source, encoding='utf-8')
            return session.run(payload, timeout=timeout, memory_bytes=memory_bytes,
                               max_output_bytes=max_output_bytes, cancelled=cancelled, cpu_seconds=cpu_seconds)

    def test_actual_os_denials(self):
        previous = os.environ.get('PCG_PRIVATE_SENTINEL')
        os.environ['PCG_PRIVATE_SENTINEL'] = 'synthetic-must-not-leak'
        try:
            with tempfile.TemporaryDirectory(prefix='pcg-outside-fixture-') as root:
                outside = Path(root) / 'private.txt'; outside.write_text('synthetic')
                output, error, code, reason = self._fixture(PROBE, json.dumps({'outside':str(outside)}).encode())
                self.assertEqual((code, reason), (0, None), error.decode(errors='replace'))
                result = json.loads(output)
                for key in ('read_outside', 'write_outside', 'create_outside', 'write_code', 'write_request', 'network', 'child'):
                    self.assertTrue(result[key]['denied'], (key,result))
                self.assertEqual(result['is_appcontainer'], 1)
                self.assertEqual(result['capability_count'], 0)
                self.assertTrue(result['own_temp'])
                self.assertTrue(result['memory_denied'])
                self.assertFalse(result['sentinel_present'])
                self.assertEqual(outside.read_text(), 'synthetic')
                self.assertFalse(Path(str(outside)+'.new').exists())
                print('OS_ISOLATION_EVIDENCE=' + json.dumps(result, sort_keys=True))
        finally:
            if previous is None: os.environ.pop('PCG_PRIVATE_SENTINEL', None)
            else: os.environ['PCG_PRIVATE_SENTINEL'] = previous

    def test_wall_timeout(self):
        output, error, code, reason = self._fixture('import time\ntime.sleep(30)\n', timeout=.2)
        self.assertEqual(reason, 'TIMEOUT')
        self.assertNotEqual(code, 0)

    def test_actual_crash_does_not_poison_next_owned_job(self):
        output, _, code, reason = self._fixture('import os\nos._exit(37)\n')
        self.assertEqual(output, b'')
        self.assertEqual(code, 37)
        self.assertIsNone(reason)
        output, _, code, reason = self._fixture('print("after-crash")\n')
        self.assertEqual((code, reason), (0, None))
        self.assertEqual(output.strip(), b'after-crash')

    def test_cancel_only_owned_job(self):
        event = threading.Event()
        timer = threading.Timer(.2,event.set); timer.start()
        try:
            _, _, code, reason = self._fixture('import time\ntime.sleep(30)\n', cancelled=event.is_set)
            self.assertEqual(reason,'CANCELLED'); self.assertNotEqual(code,0)
            output, _, code, reason = self._fixture('print("survived")\n')
            self.assertEqual((output.strip(),code,reason),(b'survived',0,None))
        finally: timer.cancel()

    def test_output_budget(self):
        _, _, code, reason = self._fixture('print("x"*100000)\n',max_output_bytes=1024)
        self.assertEqual(reason,'BUDGET_EXCEEDED')

    def test_cpu_budget(self):
        start=time.monotonic()
        _, _, code, reason = self._fixture('while True: pass\n',timeout=10,cpu_seconds=.1)
        self.assertNotEqual(code,0)
        self.assertEqual(reason,'BUDGET_EXCEEDED')  # OS CPU, before host wall timer.
        self.assertLess(time.monotonic()-start,8)
        print('OS_CPU_BUDGET_EXIT=' + str(code))


class FailClosedTests(unittest.TestCase):
    def test_input_budget_before_launch(self):
        with self.assertRaises(isolation.IsolationError) as caught:
            isolation.execute('not bytes')
        self.assertEqual(caught.exception.code,'BUDGET_EXCEEDED')


@unittest.skipUnless(os.name == 'nt', 'Native Windows cleanup contract only.')
class NativeLifetimeTests(unittest.TestCase):
    def test_profile_conversion_failure_releases_created_sid(self):
        import pcg_isolation_win as win
        def create(*args):
            args[-1]._obj.value = 0x1000
            return 0
        with mock.patch.object(win, 'CreateProfile', side_effect=create), \
                mock.patch.object(win, 'SidString', return_value=False), \
                mock.patch.object(win, 'FreeSid') as free, \
                mock.patch.object(win, 'LocalFree') as local:
            with self.assertRaises(OSError): win.profile('synthetic')
            self.assertEqual(free.call_count, 1)
            self.assertEqual(free.call_args.args[0].value, 0x1000)
            local.assert_not_called()

    def _attribute_failure(self, initialize):
        import pcg_isolation_win as win
        def init(buffer, count, flags, size):
            size._obj.value = 128
            return bool(buffer is not None and initialize)
        def pipe(read, write, *_):
            read._obj.value = next(handles)
            write._obj.value = next(handles)
            return True
        handles = iter(range(100, 106))
        with ExitStack() as stack:
            for name, replacement in [('_request_stdin', lambda *_: (106, None)), ('CreatePipe', pipe), ('SetHandle', lambda *_: True),
                                      ('InitAttrs', init), ('UpdateAttr', lambda *_: False),
                                      ('Close', lambda *_: True)]:
                stack.enter_context(mock.patch.object(win, name, side_effect=replacement))
            delete = stack.enter_context(mock.patch.object(win, 'DeleteAttrs'))
            create = stack.enter_context(mock.patch.object(win, 'CreateProcess'))
            with self.assertRaises(OSError):
                win.launch(Path('pythonw.exe'), Path('worker.py'), Path('.'), win.P(1),
                           b'', {}, 1, 64 * 1024**2, 1024, None)
            create.assert_not_called()
            return delete.call_count

    def test_failed_attribute_initialization_never_destroys_uninitialized_storage(self):
        self.assertEqual(self._attribute_failure(False), 0)

    def test_initialized_attributes_destroyed_once_on_later_failure(self):
        self.assertEqual(self._attribute_failure(True), 1)


@unittest.skipUnless(os.name == 'nt', 'Native Windows transport contract only.')
class NativeStdioTests(unittest.TestCase):
    def fixture(self, stdout=(b'abc',), stderr=(), *, limit=1024, partial=65536,
                failure=None, cancelled=None, clock=None):
        import pcg_isolation_win as win
        live, closed, calls = {106}, [], []
        queues = {100: list(stdout), 102: list(stderr)}
        next_pipe = iter((100, 102)); terminated = False
        def owned(handle):
            self.assertIn(handle, live, ('use after close', handle, calls))
        def close(handle):
            owned(handle); live.remove(handle); closed.append(handle); return True
        def pipe(read, write, *_):
            handle = next(next_pipe)
            if failure == 'second-pipe' and handle == 102: return False
            read._obj.value, write._obj.value = handle, handle + 1
            live.update((handle, handle + 1)); return True
        def init(buffer, count, flags, size):
            size._obj.value = 128; return buffer is not None
        def update(_attrs, _flags, key, value, *_):
            if key == 0x20002:
                inherited = list(win.C.cast(value, win.C.POINTER(win.W.HANDLE * 3)).contents)
                self.assertEqual(inherited, [106, 101, 103]); calls.append('allowlist3')
            return True
        def job(*_): live.add(800); return 800
        def process(*args):
            if failure == 'create': return False
            args[-1]._obj.process, args[-1]._obj.thread = 900, 901
            live.update((900, 901)); return True
        def assign(job_handle, process_handle):
            owned(job_handle); owned(process_handle); return failure != 'assign'
        def terminate(job_handle, _code):
            nonlocal terminated
            owned(job_handle); terminated = True; calls.append('terminate'); return True
        def wait(handle, _milliseconds):
            owned(handle)
            return 0xffffffff if failure == 'wait' and not terminated else 0
        def peek(handle, _buf, _size, _read, available, _left):
            owned(handle); calls.append(('peek', handle))
            if failure == 'peek': win.C.set_last_error(6); return False
            queue = queues[handle]
            if not queue: win.C.set_last_error(109); return False
            if queue[0] is None:
                queue.pop(0); available._obj.value = 0; return True
            available._obj.value = len(queue[0]); return True
        def read(handle, buffer, amount, count, _overlapped):
            owned(handle); calls.append(('read', handle))
            if failure == 'read': win.C.set_last_error(6); return False
            body = queues[handle][0]; self.assertIsNotNone(body)
            size = min(amount, len(body), partial); self.assertGreater(size, 0)
            win.C.memmove(buffer, body, size); count._obj.value = size
            if size == len(body): queues[handle].pop(0)
            else: queues[handle][0] = body[size:]
            return True
        def exit_code(handle, code):
            owned(handle); code._obj.value = 125 if terminated else 0
            return failure != 'exit'
        with ExitStack() as stack:
            replacements = {'_request_stdin': lambda *_: (106, None), 'CreatePipe': pipe,
                'SetHandle': lambda *_: True, 'InitAttrs': init, 'UpdateAttr': update,
                'DeleteAttrs': lambda *_: None, 'CreateJob': job, 'SetJob': lambda *_: True,
                'CreateProcess': process, 'AssignJob': assign, 'TerminateJob': terminate,
                'Resume': lambda *_: 0xffffffff if failure == 'resume' else 0,
                'PeekPipe': peek, 'ReadFile': read, 'Wait': wait, 'ExitCode': exit_code,
                'Close': close, 'api': lambda *_: lambda *_: True}
            for name, replacement in replacements.items():
                stack.enter_context(mock.patch.object(win, name, side_effect=replacement))
            if clock is not None:
                stack.enter_context(mock.patch.object(win.time, 'monotonic', side_effect=clock))
            try:
                value = win.launch(Path('trusted/pythonw.exe'), Path('trusted/worker.py'),
                                   Path('owned/temp'), win.P(1), b'{}', {}, .5,
                                   64 * 1024**2, limit, cancelled)
                return value, calls
            finally:
                self.assertEqual(live, set(), ('leaked handles', live))
                self.assertEqual(len(closed), len(set(closed)))

    def test_zero_available_short_reads_and_terminal_tail_are_drained(self):
        value, calls = self.fixture(stdout=(None, b'abcdef', None, b'tail'),
                                    stderr=(None, b'warning'), partial=2)
        self.assertEqual(value, (b'abcdeftail', b'warning', 0, None))
        self.assertEqual(calls[1:3], [('peek', 100), ('peek', 102)])
        self.assertIn('allowlist3', calls)

    def test_exact_limits_and_both_stream_overflows(self):
        self.assertEqual(self.fixture(stdout=(b'abcd',), limit=4)[0], (b'abcd', b'', 0, None))
        for stdout, stderr, limit in [((b'abcde',), (), 4), ((), (b'x' * 65537,), 1024)]:
            with self.subTest(stream='stderr' if stderr else 'stdout'):
                result, _ = self.fixture(stdout, stderr, limit=limit)
                self.assertEqual(result[-1], 'BUDGET_EXCEEDED'); self.assertEqual(result[2], 125)

    def test_busy_stream_does_not_starve_stderr_or_cancellation(self):
        decisions = iter((False, True))
        result, calls = self.fixture(stdout=(b'x' * 100000,), stderr=(b'warning',), limit=200000,
                                     cancelled=lambda: next(decisions))
        self.assertEqual(result[-1], 'CANCELLED')
        self.assertEqual(result[1], b'warning')
        self.assertIn(('read', 102), calls)

    def test_busy_stream_still_checks_wall_deadline(self):
        result, _ = self.fixture(stdout=(b'x' * 100000,), limit=200000, clock=(0, 0, 1))
        self.assertEqual(result[-1], 'TIMEOUT')

    def test_partial_initialization_and_io_failures_release_every_owned_handle(self):
        for failure in ('second-pipe', 'create', 'assign', 'resume', 'peek', 'read', 'wait', 'exit'):
            with self.subTest(failure=failure), self.assertRaises(OSError):
                self.fixture(failure=failure)

    def test_request_bytes_and_read_only_inherited_open(self):
        import pcg_isolation_win as win
        payload = b'\0' + '合成数据'.encode('utf8') + b'x' * 131073
        with tempfile.TemporaryDirectory(prefix='pcg-request-fixture-') as directory:
            worker = Path(directory) / 'worker.py'
            with mock.patch.object(win, 'CreateFile', return_value=106) as create:
                handle, path = win._request_stdin(worker, payload, win.SA())
            self.assertEqual(handle, 106); self.assertEqual(path.read_bytes(), payload)
            self.assertEqual(create.call_args.args[1:3], (0x80000000, 1))
            self.assertEqual(create.call_args.args[4], 3)
            with mock.patch.object(win, 'CreateFile') as create:
                with self.assertRaises(FileExistsError): win._request_stdin(worker, b'other', win.SA())
                create.assert_not_called()
            self.assertEqual(path.read_bytes(), payload)

    def test_failed_open_and_incomplete_write_remove_only_new_request(self):
        import pcg_isolation_win as win
        with tempfile.TemporaryDirectory(prefix='pcg-request-fixture-') as directory:
            worker = Path(directory) / 'worker.py'
            with mock.patch.object(win, 'CreateFile', return_value=win.C.c_void_p(-1).value):
                with self.assertRaises(OSError): win._request_stdin(worker, b'{}', win.SA())
            self.assertFalse((worker.parent / 'pcg-request.stdin').exists())
        stream = mock.MagicMock(); stream.__enter__.return_value.write.return_value = 1
        with mock.patch.object(Path, 'open', return_value=stream), \
                mock.patch.object(Path, 'unlink') as unlink, mock.patch.object(win, 'CreateFile') as create:
            with self.assertRaises(OSError): win._request_stdin(Path('trusted/worker.py'), b'{}', win.SA())
            create.assert_not_called(); unlink.assert_called_once_with(missing_ok=True)

    def test_request_budget_precedes_any_file_or_native_operation(self):
        import pcg_isolation_win as win
        with mock.patch.object(Path, 'open') as opened, mock.patch.object(win, 'CreateFile') as create:
            for payload in ('not-bytes', b'x' * (32 * 1024**2 + 1)):
                with self.assertRaises(OSError): win._request_stdin(Path('trusted/worker.py'), payload, win.SA())
            opened.assert_not_called(); create.assert_not_called()


if __name__ == '__main__': unittest.main()
