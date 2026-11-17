"""Native, capability-free Windows AppContainer process primitive.

This private module accepts a staged trusted executable. The public wrapper owns
the staging policy; callers must never expose this primitive as an RPC command.
"""
from __future__ import annotations

import ctypes as C
from ctypes import wintypes as W
import os
from pathlib import Path
import time

k = C.WinDLL('kernel32', use_last_error=True)
u = C.WinDLL('userenv', use_last_error=True)
a = C.WinDLL('advapi32', use_last_error=True)


def api(lib, name, restype, args):
    f = getattr(lib, name); f.restype = restype; f.argtypes = args
    return f


P = C.c_void_p
CreateProfile = api(u, 'CreateAppContainerProfile', C.c_long, [W.LPCWSTR, W.LPCWSTR, W.LPCWSTR, P, W.DWORD, C.POINTER(P)])
DeleteProfile = api(u, 'DeleteAppContainerProfile', C.c_long, [W.LPCWSTR])
FreeSid = api(a, 'FreeSid', P, [P])
SidString = api(a, 'ConvertSidToStringSidW', W.BOOL, [P, C.POINTER(P)])
LocalFree = api(k, 'LocalFree', P, [P])
Close = api(k, 'CloseHandle', W.BOOL, [W.HANDLE])
InitAttrs = api(k, 'InitializeProcThreadAttributeList', W.BOOL, [P, W.DWORD, W.DWORD, C.POINTER(C.c_size_t)])
UpdateAttr = api(k, 'UpdateProcThreadAttribute', W.BOOL, [P, W.DWORD, C.c_size_t, P, C.c_size_t, P, P])
DeleteAttrs = api(k, 'DeleteProcThreadAttributeList', None, [P])
CreateJob = api(k, 'CreateJobObjectW', W.HANDLE, [P, W.LPCWSTR])
SetJob = api(k, 'SetInformationJobObject', W.BOOL, [W.HANDLE, C.c_int, P, W.DWORD])
AssignJob = api(k, 'AssignProcessToJobObject', W.BOOL, [W.HANDLE, W.HANDLE])
TerminateJob = api(k, 'TerminateJobObject', W.BOOL, [W.HANDLE, W.UINT])
Resume = api(k, 'ResumeThread', W.DWORD, [W.HANDLE])
Wait = api(k, 'WaitForSingleObject', W.DWORD, [W.HANDLE, W.DWORD])
ExitCode = api(k, 'GetExitCodeProcess', W.BOOL, [W.HANDLE, C.POINTER(W.DWORD)])
CreatePipe = api(k, 'CreatePipe', W.BOOL, [C.POINTER(W.HANDLE), C.POINTER(W.HANDLE), P, W.DWORD])
SetHandle = api(k, 'SetHandleInformation', W.BOOL, [W.HANDLE, W.DWORD, W.DWORD])
ReadFile = api(k, 'ReadFile', W.BOOL, [W.HANDLE, P, W.DWORD, C.POINTER(W.DWORD), P])
PeekPipe = api(k, 'PeekNamedPipe', W.BOOL, [W.HANDLE, P, W.DWORD, P, C.POINTER(W.DWORD), P])
CreateFile = api(k, 'CreateFileW', W.HANDLE, [W.LPCWSTR, W.DWORD, W.DWORD, P, W.DWORD, W.DWORD, W.HANDLE])


class SA(C.Structure):
    _fields_ = [('length', W.DWORD), ('descriptor', P), ('inherit', W.BOOL)]


class SI(C.Structure):
    _fields_ = [('cb', W.DWORD), ('reserved', W.LPWSTR), ('desktop', W.LPWSTR), ('title', W.LPWSTR),
                ('x', W.DWORD), ('y', W.DWORD), ('xs', W.DWORD), ('ys', W.DWORD), ('xc', W.DWORD), ('yc', W.DWORD),
                ('fill', W.DWORD), ('flags', W.DWORD), ('show', W.WORD), ('cb2', W.WORD), ('res2', P),
                ('stdin', W.HANDLE), ('stdout', W.HANDLE), ('stderr', W.HANDLE)]


class SIX(C.Structure):
    _fields_ = [('si', SI), ('attrs', P)]


class PI(C.Structure):
    _fields_ = [('process', W.HANDLE), ('thread', W.HANDLE), ('pid', W.DWORD), ('tid', W.DWORD)]


class CAPS(C.Structure):
    _fields_ = [('sid', P), ('capabilities', P), ('count', W.DWORD), ('reserved', W.DWORD)]


class BASIC(C.Structure):
    _fields_ = [('processTime', C.c_int64), ('jobTime', C.c_int64), ('flags', W.DWORD),
                ('minimum', C.c_size_t), ('maximum', C.c_size_t), ('active', W.DWORD),
                ('affinity', C.c_size_t), ('priority', W.DWORD), ('scheduling', W.DWORD)]


class IO(C.Structure):
    _fields_ = [(n, C.c_uint64) for n in ('readOps', 'writeOps', 'otherOps', 'readBytes', 'writeBytes', 'otherBytes')]


class LIMITS(C.Structure):
    _fields_ = [('basic', BASIC), ('io', IO), ('processMemory', C.c_size_t), ('jobMemory', C.c_size_t),
                ('peakProcessMemory', C.c_size_t), ('peakJobMemory', C.c_size_t)]


CreateProcess = api(k, 'CreateProcessW', W.BOOL, [W.LPCWSTR, W.LPWSTR, P, P, W.BOOL, W.DWORD, P, W.LPCWSTR, C.POINTER(SIX), C.POINTER(PI)])


def check(ok, action):
    if not ok:
        raise OSError(C.get_last_error(), action)


def profile(name):
    sid = P()
    result = CreateProfile(name, name, 'Owned transient geometry worker', None, 0, C.byref(sid))
    if result < 0:
        raise OSError(result & 0xffffffff, 'CreateAppContainerProfile')
    value = P()
    try:
        check(SidString(sid, C.byref(value)), 'ConvertSidToStringSid')
        return sid, C.wstring_at(value)
    except BaseException:
        if sid: FreeSid(sid)
        raise
    finally:
        if value: LocalFree(value)


def _request_stdin(worker, payload, security):
    if type(payload) is not bytes or len(payload) > 32 * 1024**2:
        raise OSError('Worker input exceeds its byte budget.')
    target = Path(worker).parent / 'pcg-request.stdin'
    created = False
    try:
        with target.open('xb') as stream:
            created = True
            if stream.write(payload) != len(payload):
                raise OSError('Incomplete worker request write.')
        handle = CreateFile(str(target), 0x80000000, 1, C.byref(security), 3, 0x80, None)
        if handle in (None, 0, C.c_void_p(-1).value):
            raise OSError(C.get_last_error(), 'CreateFileW(request)')
        return handle, target
    except BaseException:
        if created: target.unlink(missing_ok=True)
        raise


def launch(executable, worker, directory, sid, payload, environment, timeout, memory_bytes, max_output_bytes, cancelled, cpu_seconds=None):
    """Create suspended, attach budgets, then run with only three IPC handles."""
    handles = []
    job = None
    attrs = None
    attrs_initialized = False
    pi = PI()
    assigned = False
    request_path = None
    try:
        sa = SA(C.sizeof(SA), None, True)
        stdin, request_path = _request_stdin(worker, payload, sa)
        handles.append(stdin)
        pipes = []
        for index in range(2):
            read, write = W.HANDLE(), W.HANDLE()
            check(CreatePipe(C.byref(read), C.byref(write), C.byref(sa), 0), 'CreatePipe')
            handles.extend([read.value, write.value]); pipes.append((read.value, write.value))
        child_handles = (W.HANDLE * 3)(stdin, pipes[0][1], pipes[1][1])
        for handle in (pipes[0][0], pipes[1][0]):
            check(SetHandle(handle, 1, 0), 'SetHandleInformation')
        size = C.c_size_t()
        InitAttrs(None, 3, 0, C.byref(size))
        attrs = C.create_string_buffer(size.value)
        check(InitAttrs(attrs, 3, 0, C.byref(size)), 'InitializeProcThreadAttributeList')
        attrs_initialized = True
        caps = CAPS(sid, None, 0, 0)
        child_policy = W.DWORD(1)  # PROCESS_CREATION_CHILD_PROCESS_RESTRICTED
        for key, value in ((0x20009, caps), (0x20002, child_handles), (0x2000e, child_policy)):
            check(UpdateAttr(attrs, 0, key, C.byref(value), C.sizeof(value), None, None), 'UpdateProcThreadAttribute')
        startup = SIX(); startup.si.cb = C.sizeof(SIX); startup.attrs = C.cast(attrs, P)
        startup.si.flags = 0x100  # STARTF_USESTDHANDLES
        startup.si.stdin, startup.si.stdout, startup.si.stderr = child_handles
        job = CreateJob(None, None); check(job, 'CreateJobObject')
        limits = LIMITS()
        limits.basic.flags = 0x2000 | 0x100 | 0x200 | 0x8 | 0x2  # kill, process/job memory, active=1, CPU time
        limits.basic.active = 1
        limits.basic.processTime = int((cpu_seconds if cpu_seconds is not None else max(.1, timeout * .5)) * 10_000_000)
        limits.processMemory = memory_bytes; limits.jobMemory = memory_bytes
        check(SetJob(job, 9, C.byref(limits), C.sizeof(limits)), 'SetInformationJobObject')
        import subprocess
        command = C.create_unicode_buffer(subprocess.list2cmdline([str(executable), '-I', '-S', '-B', str(worker)]))
        env = C.create_unicode_buffer('\0'.join(f'{key}={value}' for key, value in sorted(environment.items())) + '\0\0')
        check(CreateProcess(str(executable), command, None, None, True,
                            0x80000 | 0x400 | 0x4 | 0x08000000, env, str(directory), C.byref(startup), C.byref(pi)), 'CreateProcessW(AppContainer)')
        check(AssignJob(job, pi.process), 'AssignProcessToJobObject')
        assigned = True
        for handle in child_handles:
            Close(handle); handles.remove(handle)
        output, errors = bytearray(), bytearray()
        check(Resume(pi.thread) != 0xffffffff, 'ResumeThread')
        start = time.monotonic(); reason = None
        streams = [(pipes[0][0], output, max_output_bytes), (pipes[1][0], errors, 65536)]
        eof = set()
        block = C.create_string_buffer(65536)
        while True:
            if cancelled and cancelled(): reason = 'CANCELLED'
            elif time.monotonic() - start >= timeout: reason = 'TIMEOUT'
            if reason:
                check(TerminateJob(job, 125), 'TerminateJobObject')
                check(Wait(pi.process, 5000) == 0, 'WaitForSingleObject(termination)')
                break
            progressed = False
            for handle, target, limit in streams:
                if handle in eof: continue
                available = W.DWORD()
                if not PeekPipe(handle, None, 0, None, C.byref(available), None):
                    if C.get_last_error() == 109:
                        eof.add(handle); continue
                    check(False, 'PeekNamedPipe')
                if not available.value: continue
                count = W.DWORD()
                amount = min(available.value, len(block), limit - len(target) + 1)
                if not ReadFile(handle, block, amount, C.byref(count), None):
                    if C.get_last_error() == 109:
                        eof.add(handle); continue
                    check(False, 'ReadFile')
                check(0 < count.value <= amount, 'ReadFile(byte count)')
                if len(target) + count.value > limit:
                    reason = 'BUDGET_EXCEEDED'; break
                target.extend(block.raw[:count.value]); progressed = True
            if reason:
                check(TerminateJob(job, 125), 'TerminateJobObject')
                check(Wait(pi.process, 5000) == 0, 'WaitForSingleObject(termination)')
                break
            waited = Wait(pi.process, 0 if progressed else 20)
            check(waited in (0, 258), 'WaitForSingleObject')
            if waited == 0 and len(eof) == len(streams): break
        code = W.DWORD(); check(ExitCode(pi.process, C.byref(code)), 'GetExitCodeProcess')
        check(code.value != 259, 'Worker is still active')
        if code.value == 0xC0000044:  # STATUS_QUOTA_EXCEEDED from job CPU limit
            reason = 'BUDGET_EXCEEDED'
        return bytes(output), bytes(errors), code.value, reason
    finally:
        if pi.process:
            if assigned: TerminateJob(job, 125)
            else: api(k, 'TerminateProcess', W.BOOL, [W.HANDLE, W.UINT])(pi.process, 125)
            Wait(pi.process, 5000)
        if job: Close(job)
        for handle in handles: Close(handle)
        if pi.thread: Close(pi.thread)
        if pi.process: Close(pi.process)
        if attrs_initialized: DeleteAttrs(attrs)
        if request_path is not None: request_path.unlink(missing_ok=True)
