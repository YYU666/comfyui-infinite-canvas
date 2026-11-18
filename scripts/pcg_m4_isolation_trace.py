"""Test-only bounded preparation, native startup and resource timeline."""
from collections import deque
import copy
import functools
import importlib
import json
import threading
import time

MAX_BYTES = 32768
REASONS = {'ISOLATION_UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'BUDGET_EXCEEDED', 'WORKER_FAILED'}
ERRORS = {'OSError', 'PermissionError', 'FileNotFoundError', 'TimeoutExpired',
          'IsolationError', 'ImportError', 'ModuleNotFoundError', 'AttributeError'}
NATIVE_PHASES = {'profile': 'profile', '_request_stdin': 'request-stdin',
                 'InitAttrs': 'attributes-init', 'UpdateAttr': 'attributes-update',
                 'CreateJob': 'job-create', 'SetJob': 'job-budget',
                 'CreateProcess': 'process-create', 'AssignJob': 'job-assign',
                 'Resume': 'process-resume', 'TerminateJob': 'job-terminate',
                 'ExitCode': 'process-exit-code', 'DeleteAttrs': 'attributes-delete',
                 'DeleteProfile': 'profile-delete', 'FreeSid': 'sid-free'}


class IsolationTrace:
    def __init__(self, *, worker_probe=False):
        self.lock = threading.RLock()
        self.install_lock = threading.Lock()
        self.local = threading.local()
        self.origin = time.monotonic()
        self.sequence = 0
        self.active = {}
        self.completed = deque(maxlen=16)
        self.first_failure = None
        self.failures = {}
        self.frozen = None
        self.diagnostic_errors = 0
        self.patches = []
        self.native = None
        self.worker_probe = worker_probe

    def _safe(self, function, *args, **kwargs):
        try:
            return function(*args, **kwargs)
        except Exception:
            self.diagnostic_errors = min(1000000, self.diagnostic_errors + 1)
            return None

    def _begin(self, kind):
        with self.lock:
            self.sequence += 1
            if len(self.active) >= 8:
                return None
            record = {'call': self.sequence, 'kind': kind,
                      'parent': getattr(self.local, 'call', None),
                      'thread': threading.get_native_id(),
                      'startedMs': round((time.monotonic() - self.origin) * 1000, 3),
                      'events': deque(maxlen=64), 'phases': {}, 'poll': {}}
            self.active[record['call']] = record
            return record['call']

    def _mark(self, phase, state, **numbers):
        with self.lock:
            record = self.active.get(getattr(self.local, 'call', None))
            if record is not None:
                now = round((time.monotonic() - self.origin) * 1000, 3)
                record['events'].append({'phase': phase, 'state': state, 'ms': now, **numbers})
                summary = record['phases'].setdefault(phase, {'firstMs': now, 'count': 0})
                summary.update(lastMs=now, count=min(1000000000, summary['count'] + 1), state=state, **numbers)

    @staticmethod
    def _plain(record):
        return {**copy.deepcopy({k: v for k, v in record.items() if k != 'events'}),
                'events': list(record['events'])}

    def _finish(self, call, state, reason):
        with self.lock:
            record = self.active.pop(call, None)
            if record is None:
                return
            record.update(state=state, reason=reason,
                          elapsedMs=round((time.monotonic() - self.origin) * 1000 - record['startedMs'], 3))
            record = self._plain(record)
            self.completed.append(record)
            if state == 'failed' and reason != 'CANCELLED' and self.first_failure is None:
                self.first_failure = copy.deepcopy(record)
            if reason in ('ISOLATION_UNAVAILABLE', 'TIMEOUT') and reason not in self.failures:
                self.failures[reason] = copy.deepcopy(record)

    def call(self, original, kind, *args, **kwargs):
        previous = getattr(self.local, 'call', None)
        call = self._safe(self._begin, kind)
        self.local.call = call
        state, reason = 'succeeded', 'NONE'
        try:
            answer = original(*args, **kwargs)
            if kind == 'preflight' and isinstance(answer, dict) and answer.get('available') is False:
                state, reason = 'failed', 'ISOLATION_UNAVAILABLE'
            return answer
        except BaseException as error:
            code = self._safe(getattr, error, 'code', None)
            state, reason = 'failed', code if type(code) is str and code in REASONS else 'OTHER'
            self._safe(self._mark, 'call-exception', type(error).__name__ if type(error).__name__ in ERRORS else 'OtherError')
            raise
        finally:
            self._safe(self._finish, call, state, reason)
            self.local.call = previous

    def _poll(self, name, answer, args, last_error):
        with self.lock:
            record = self.active.get(getattr(self.local, 'call', None))
            if record is None:
                return
            value = record['poll'].setdefault(name, {'calls': 0, 'failures': 0, 'bytes': 0})
            value['calls'] = min(1000000000, value['calls'] + 1)
            if name == 'Wait':
                value['lastResult'] = answer if type(answer) is int and answer in (0, 258, 0xffffffff) else -1
                value['failures'] += answer not in (0, 258)
                if self.worker_probe:
                    now = round((time.monotonic() - self.origin) * 1000, 3)
                    if 'lastReturnMs' in value:
                        gap = round(now - value['lastReturnMs'], 3)
                        value['maxReturnGapMs'] = max(value.get('maxReturnGapMs', 0), gap)
                    value.setdefault('firstReturnMs', now)
                    value['lastReturnMs'] = now
            else:
                value['failures'] += not bool(answer)
                if answer:
                    index = 4 if name == 'PeekPipe' else 3
                    number = getattr(getattr(args[index], '_obj', None), 'value', None)
                    if type(number) is int and 0 <= number <= 64 * 1024**2:
                        if name == 'ReadFile': value['bytes'] = min(2**53 - 1, value['bytes'] + number)
                        else: value['lastAvailableBytes'] = number
            value['lastError'] = last_error

    def _patch(self, owner, name, wrapper):
        original = getattr(owner, name)
        observed = functools.wraps(original)(wrapper(original))
        setattr(owner, name, observed)
        self.patches.append((owner, name, original, observed))

    def phase_wrapper(self, phase, before=None):
        def factory(original):
            def observed(*args, **kwargs):
                self._safe(self._mark, phase, 'begin')
                try:
                    if before is not None: self._safe(before)
                    answer = original(*args, **kwargs)
                except BaseException as error:
                    self._safe(self._native_error, phase, error)
                    raise
                self._safe(self._mark, phase, 'end')
                return answer
            return observed
        return factory

    def install_native(self, native):
        with self.install_lock:
            if self.native is not None:
                return
            self.native = native
            for name, phase in NATIVE_PHASES.items():
                def factory(original, name=name, phase=phase):
                    def observed(*args, **kwargs):
                        saved = native.C.get_last_error()
                        self._safe(self._mark, phase, 'begin')
                        native.C.set_last_error(saved)
                        try:
                            answer = original(*args, **kwargs)
                        except BaseException as error:
                            saved = native.C.get_last_error()
                            self._safe(self._native_error, phase, error)
                            native.C.set_last_error(saved)
                            raise
                        saved = native.C.get_last_error()
                        try:
                            self._safe(self._native_result, phase, name, answer, args, saved)
                        finally:
                            native.C.set_last_error(saved)
                        return answer
                    return observed
                self._patch(native, name, factory)
            for name in ('Wait', 'PeekPipe', 'ReadFile'):
                def factory(original, name=name):
                    def observed(*args, **kwargs):
                        answer = original(*args, **kwargs)
                        saved = native.C.get_last_error()
                        try:
                            self._safe(self._poll, name, answer, args, saved)
                        finally:
                            native.C.set_last_error(saved)
                        return answer
                    return observed
                self._patch(native, name, factory)

    def _native_error(self, phase, error):
        values = {}
        for key in ('errno', 'winerror'):
            number = getattr(error, key, None)
            if type(number) is int and -2**31 <= number <= 2**32 - 1:
                values[key] = number
        self._mark(phase, type(error).__name__ if type(error).__name__ in ERRORS else 'OtherError', **values)

    def _native_result(self, phase, name, answer, args, last_error):
        values = {'lastError': last_error}
        if name in ('Resume', 'DeleteProfile') and type(answer) is int:
            values['result'] = answer if -2**31 <= answer <= 2**32 - 1 else -1
        elif name not in ('profile', '_request_stdin', 'FreeSid', 'DeleteAttrs'):
            values['ok'] = bool(answer)
        if name == 'InitAttrs': values['sizeQuery'] = args[0] is None
        self._mark(phase, 'end', **values)
        if name == 'ExitCode' and answer and self.worker_probe:
            from scripts.pcg_m4_worker_trace import cpu_sample
            sample = cpu_sample(self.native, args[0])
            if sample is None:
                self._mark('worker-cpu', 'unavailable')
            else:
                self._mark('worker-cpu', 'observed', **sample)

    def _worker_staged(self, session):
        from scripts.pcg_m4_worker_trace import stage_probe
        stage_probe(session.worker)
        self._mark('worker-probe-stage', 'ready')

    def _worker_observed(self, start_ns, stderr):
        from scripts.pcg_m4_worker_trace import read_markers
        events = read_markers(stderr, start_ns, time.monotonic_ns())
        if not events:
            self._mark('worker-probe', 'no-markers')
        for event in events:
            self._mark('worker-' + event['phase'], 'observed',
                       sinceRunStartMs=event['ms'], childCpuMs=event['childCpuMs'])

    def install(self, module, native=None):
        for name in ('preflight', 'execute'):
            def factory(original, kind=name):
                return lambda *a, **k: self.call(original, kind, *a, **k)
            self._patch(module, name, factory)
        def prepare_native():
            if module.os.name == 'nt' and self.native is None:
                # Import remains inside the original session-enter window.
                self._safe(self._mark, 'native-import', 'begin')
                self.install_native(native if native is not None else importlib.import_module('pcg_isolation_win'))
                self._safe(self._mark, 'native-import', 'end')
        self._patch(module._Session, '__enter__', self.phase_wrapper('session-prepare', prepare_native))
        self._patch(module._Session, 'stage', self.phase_wrapper('fixed-code-stage'))
        self._patch(module._Session, '__exit__', self.phase_wrapper('session-release'))
        if self.worker_probe:
            def stage_wrapper(original):
                def observed(session):
                    result = original(session)
                    self._safe(self._worker_staged, session)
                    return result
                return observed
            self._patch(module._Session, 'stage', stage_wrapper)
        self._patch(module, '_acl', self.phase_wrapper('acl'))
        def subprocess_wrapper(original):
            def observed(*args, **kwargs):
                arguments = args[0] if args else kwargs.get('args')
                tracked = (getattr(self.local, 'call', None) is not None and
                           type(arguments) is list and arguments and arguments[0] == 'icacls')
                if not tracked: return original(*args, **kwargs)
                phase = 'integrity-command' if '/setintegritylevel' in arguments else 'acl-command'
                self._safe(self._mark, phase, 'begin')
                try:
                    answer = original(*args, **kwargs)
                except BaseException as error:
                    self._safe(self._native_error, phase, error)
                    raise
                if type(answer.returncode) is int and -2**31 <= answer.returncode <= 2**32 - 1:
                    self._safe(self._mark, phase, 'end', exitCode=answer.returncode)
                return answer
            return observed
        if hasattr(module, 'subprocess'):
            self._patch(module.subprocess, 'run', subprocess_wrapper)
        if hasattr(module, 'shutil'):
            self._patch(module.shutil, 'copyfile', self.phase_wrapper('staged-file-copy'))
        def run_wrapper(original):
            def observed(*args, **kwargs):
                self._safe(self._mark, 'resource-run', 'begin')
                start_ns = time.monotonic_ns() if self.worker_probe else None
                try:
                    answer = original(*args, **kwargs)
                except BaseException as error:
                    self._safe(self._native_error, 'resource-run', error)
                    raise
                if type(answer) is tuple and len(answer) == 4:
                    output, errors, code, reason = answer
                    if type(output) is bytes and type(errors) is bytes and type(code) is int and -2**31 <= code <= 2**32 - 1:
                        bounded = {'stdoutBytes': len(output), 'stderrBytes': len(errors), 'exitCode': code}
                        for key, high in (('timeout', 120), ('memory_bytes', 1024**3), ('max_output_bytes', 64 * 1024**2)):
                            number = kwargs.get(key)
                            if type(number) in (int, float) and 0 < number <= high:
                                bounded[key] = number
                        self._safe(self._mark_result, reason if type(reason) is str and reason in REASONS else 'NONE' if reason is None else 'OTHER', bounded)
                        if self.worker_probe:
                            self._safe(self._worker_observed, start_ns, errors)
                return answer
            return observed
        self._patch(module._Session, 'run', run_wrapper)
        return self

    def _mark_result(self, reason, numbers):
        self._mark('resource-run', reason, **numbers)

    def freeze(self):
        with self.lock:
            if self.frozen is None:
                value = {'contract': 'test-only-isolation-phases-v1',
                         'active': [self._plain(v) for v in self.active.values()],
                         'completed': list(self.completed), 'firstFailure': self.first_failure,
                         'failures': copy.deepcopy(self.failures),
                         'diagnosticErrors': self.diagnostic_errors, 'omittedActive': 0}
                while True:
                    body = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('utf8')
                    if len(body) <= MAX_BYTES: break
                    if value['completed']: value['completed'].pop(0)
                    else:
                        records = value['active'] + list(value['failures'].values()) + ([value['firstFailure']] if value['firstFailure'] else [])
                        longest = max(records, key=lambda r: len(r['events']))
                        if longest['events']:
                            longest['events'].pop(0)
                        elif value['active']:
                            value['active'].pop(0); value['omittedActive'] += 1
                        else:
                            raise AssertionError('Fixed isolation trace exceeds byte budget')
                self.frozen = body
            return self.frozen

    def restore(self):
        for owner, name, original, observed in reversed(self.patches):
            if getattr(owner, name) is observed: setattr(owner, name, original)
        self.patches.clear()
