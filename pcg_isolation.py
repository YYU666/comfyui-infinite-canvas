"""Fail-closed execution of the fixed trusted geometry stdio worker.

Only Windows AppContainer is supported. No audit-hook or ordinary-process
fallback exists. Project paths, commands and executable choices are not inputs.
"""
from __future__ import annotations

import functools
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid


class IsolationError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code, self.message = code, message


def _acl(path, sid, rights, *, protect=False):
    # icacls is an OS utility; arguments are never interpreted by a shell.
    arguments = ['icacls', str(path)]
    if protect:
        # Owner Rights + SYSTEM keep host cleanup possible without inheriting
        # broad application/package or user-group permissions from TEMP.
        arguments += ['/inheritance:r', '/grant:r', '*S-1-3-4:(OI)(CI)F',
                      '*S-1-5-18:(OI)(CI)F', f'*{sid}:(OI)(CI){rights}']
    else:
        arguments += ['/grant:r', f'*{sid}:(OI)(CI){rights}']
    result = subprocess.run(arguments,
                            capture_output=True, timeout=10, creationflags=0x08000000)
    if result.returncode:
        raise OSError('Could not grant the owned sandbox staging ACL.')


class _Session:
    def __init__(self):
        self.root = None; self.sid = None; self.name = None

    def __enter__(self):
        if os.name != 'nt':
            raise IsolationError('ISOLATION_UNAVAILABLE', 'Windows AppContainer is required.')
        import pcg_isolation_win as win
        self.win = win
        self.root = Path(tempfile.mkdtemp(prefix='pcg-isolation-'))
        self.name = 'Refmuse.PCG.' + uuid.uuid4().hex
        try:
            self.sid, self.sid_text = win.profile(self.name)
            # Only this newly owned directory is granted to this unique SID.
            _acl(self.root, self.sid_text, 'RX', protect=True)
            self.runtime = self.root / 'runtime'; self.runtime.mkdir()
            self.temp = self.root / 'temp'; self.temp.mkdir()
            _acl(self.temp, self.sid_text, 'M')
            low = subprocess.run(['icacls', str(self.temp), '/setintegritylevel', '(OI)(CI)L'],
                                 capture_output=True, timeout=10, creationflags=0x08000000)
            if low.returncode: raise OSError('Could not set owned temporary directory integrity.')
            # Windows rewrites TEMP beneath LOCALAPPDATA for this profile.
            # Keep that rewritten directory inside our owned, writable subtree.
            (self.temp / 'Packages' / self.name.lower() / 'AC' / 'Temp').mkdir(parents=True)
            base = Path(sys.executable).resolve().parent
            version = f'python{sys.version_info.major}{sys.version_info.minor}'
            files = ['pythonw.exe', 'python3.dll', version + '.dll', version + '.zip',
                     'vcruntime140.dll', 'vcruntime140_1.dll']
            if any(not (base / name).is_file() for name in files):
                raise OSError('A self-contained standard-library interpreter is required.')
            # Explicit standard-library extensions only; never copy site-packages.
            files += [name for name in ('_socket.pyd', 'select.pyd', '_hashlib.pyd', 'libcrypto-3.dll',
                                        '_ctypes.pyd', 'libffi-8.dll') if (base / name).is_file()]
            for name in files: shutil.copyfile(base / name, self.runtime / name)
            (self.runtime / (version + '._pth')).write_text(version + '.zip\n.\n', encoding='ascii')
            # Windowless entry point avoids console initialization unavailable
            # inside the capability-free container. Explicit stdio pipes remain.
            self.executable = self.runtime / 'pythonw.exe'
            self.worker = self.runtime / 'pcg_worker.py'
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def stage(self):
        source = Path(__file__).resolve().parent
        for name in ('pcg_worker.py', 'pcg_contracts.py', 'pcg_graph.py', 'pcg_geometry.py', 'pcg_fields.py', 'pcg_export.py'):
            path = source / name
            if path.is_file(): shutil.copyfile(path, self.runtime / name)
        registry = self.runtime / 'pcg'; registry.mkdir()
        shutil.copyfile(source / 'pcg' / 'registry.json', registry / 'registry.json')

    def run(self, payload, *, timeout, memory_bytes, max_output_bytes, cancelled, cpu_seconds=None):
        environment = {'SystemRoot': os.environ.get('SystemRoot', r'C:\Windows'),
                       'windir': os.environ.get('SystemRoot', r'C:\Windows'),
                       'SystemDrive': Path(os.environ.get('SystemRoot', r'C:\Windows')).drive,
                       'PATH': str(Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32'),
                       'USERPROFILE': str(self.temp), 'LOCALAPPDATA': str(self.temp),
                       'APPDATA': str(self.temp),
                       'TEMP': str(self.temp), 'TMP': str(self.temp)}
        return self.win.launch(self.executable, self.worker, self.temp, self.sid, payload,
                               environment, timeout, memory_bytes, max_output_bytes, cancelled, cpu_seconds)

    def __exit__(self, *_):
        # Everything here is newly created and task-owned, never caller-selected.
        try:
            if self.name and self.sid:
                result = self.win.DeleteProfile(self.name)
                if result < 0: raise OSError(result & 0xffffffff, 'DeleteAppContainerProfile')
        finally:
            if self.sid: self.win.FreeSid(self.sid); self.sid = None
            if self.root: shutil.rmtree(self.root); self.root = None


@functools.lru_cache(maxsize=1)
def preflight():
    """Check native profile creation, staged interpreter and restricted launch."""
    try:
        with _Session() as session:
            session.worker.write_text("import json,sys\nprint(json.dumps({'ready':True}))\n", encoding='utf-8')
            output, _, code, reason = session.run(b'', timeout=5, memory_bytes=128 * 1024**2,
                                                 max_output_bytes=1024, cancelled=None)
            if code or reason or output.strip() != b'{"ready": true}':
                raise OSError(f'Restricted interpreter startup failed ({code}, {reason}).')
        return {'available': True, 'kind': 'windows-appcontainer', 'code': 'READY',
                'message': 'Capability-free AppContainer and resource job are available.'}
    except (OSError, IsolationError, subprocess.SubprocessError, AttributeError, ImportError) as exc:
        return {'available': False, 'kind': 'windows-appcontainer', 'code': 'ISOLATION_UNAVAILABLE',
                'message': str(exc)}


def execute(request: bytes, *, cancelled=None, timeout=15, memory_bytes=268435456,
            max_output_bytes=16777216):
    """Execute one bounded request; terminate only its owned resource job."""
    if type(request) is not bytes or len(request) > 32 * 1024**2:
        raise IsolationError('BUDGET_EXCEEDED', 'Worker input exceeds its byte budget.')
    if not (type(timeout) in (int, float) and type(memory_bytes) is int
            and type(max_output_bytes) is int and 0 < timeout <= 120
            and 64 * 1024**2 <= memory_bytes <= 1024**3
            and 0 < max_output_bytes <= 64 * 1024**2):
        raise IsolationError('BUDGET_EXCEEDED', 'Invalid worker resource budget.')
    if cancelled and cancelled(): raise IsolationError('CANCELLED', 'Worker was cancelled.')
    state = preflight()
    if not state['available']: raise IsolationError('ISOLATION_UNAVAILABLE', state['message'])
    try:
        with _Session() as session:
            session.stage()
            output, _, code, reason = session.run(request, timeout=timeout, memory_bytes=memory_bytes,
                                                  max_output_bytes=max_output_bytes, cancelled=cancelled)
        if reason: raise IsolationError(reason, 'Restricted worker stopped: ' + reason)
        if code: raise IsolationError('WORKER_FAILED', 'Restricted worker exited unsuccessfully: ' + str(code))
        return output
    except (OSError, subprocess.SubprocessError) as exc:
        raise IsolationError('ISOLATION_UNAVAILABLE', str(exc)) from exc
