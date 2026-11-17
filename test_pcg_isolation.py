"""Synthetic owned-fixture OS boundary tests; no live services or user files."""
from __future__ import annotations

import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest

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
                for key in ('read_outside', 'write_outside', 'create_outside', 'write_code', 'network', 'child'):
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


if __name__ == '__main__': unittest.main()
