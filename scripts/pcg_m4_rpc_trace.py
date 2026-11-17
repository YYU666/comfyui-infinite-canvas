"""Test-only bounded RPC phase ledger. Never imported by the product launcher."""
from collections import deque
from contextlib import contextmanager
import functools
import json
import os
from pathlib import Path
import tempfile
import threading
import time


class Ledger:
    def __init__(self):
        self.lock = threading.Lock()
        self.local = threading.local()
        self.origin = time.monotonic()
        self.sequence = 0
        self.active = {}
        self.completed = deque(maxlen=128)
        self.events = deque(maxlen=256)
        self.sockets = {}
        self.frozen = None

    def mark(self, phase, **counts):
        # Callers pass only fixed enumerations and numeric counts, never args.
        with self.lock:
            seq = getattr(self.local, 'seq', 0)
            event = {'seq': seq, 'phase': phase,
                     'ms': round((time.monotonic() - self.origin) * 1000, 3),
                     'thread': threading.get_native_id(), **counts}
            self.events.append(event)
            if seq in self.active:
                self.active[seq].update(lastPhase=phase, lastMs=event['ms'])

    def begin(self, socket):
        with self.lock:
            self.sequence += 1
            seq = self.sequence
            if len(self.active) >= 32:
                return 0
            self.active[seq] = {'seq': seq}
            self.sockets[id(socket)] = seq
            return seq

    def finish(self, socket):
        with self.lock:
            seq = self.sockets.pop(id(socket), 0)
            record = self.active.pop(seq, None)
            if record is not None:
                self.completed.append(record)

    def bind(self, value, allowed_tools):
        if not isinstance(value, dict):
            return
        with self.lock:
            record = self.active.get(getattr(self.local, 'seq', 0))
            if record is None:
                return
            identity = value.get('id')
            if type(identity) is int and 0 <= identity <= 2**53 - 1:
                record['requestId'] = identity
            method = value.get('method')
            if method in ('initialize', 'tools/list', 'tools/call', 'notifications/initialized'):
                record['method'] = method
            params = value.get('params')
            name = params.get('name') if isinstance(params, dict) else None
            if type(name) is str and name in allowed_tools:
                record['tool'] = name

    @contextmanager
    def phase(self, phase):
        self.mark(phase + '-begin')
        try:
            yield
        except BaseException:
            self.mark(phase + '-error')
            raise
        else:
            self.mark(phase + '-end')

    def freeze(self):
        # No session lock, graph copy, or live IO while holding this ledger lock.
        with self.lock:
            if self.frozen is None:
                value = {'contract': 'test-only-rpc-phases-v1',
                         'active': list(self.active.values()),
                         'completed': list(self.completed), 'events': list(self.events)}
                body = json.dumps(value, separators=(',', ':')).encode('utf8')
                while len(body) > 65536:
                    key = 'events' if value['events'] else 'completed'
                    if not value[key]:
                        raise AssertionError('Fixed diagnostic record budget exceeded')
                    value[key].pop(0)
                    body = json.dumps(value, separators=(',', ':')).encode('utf8')
                self.frozen = body
            return self.frozen


class ObservedRLock:
    """Delegate Condition's full recursive-lock protocol without changing it."""
    def __init__(self, lock, ledger):
        self.lock, self.ledger = lock, ledger

    def acquire(self, *args, **kwargs):
        self.ledger.mark('session-lock-request')
        result = self.lock.acquire(*args, **kwargs)
        self.ledger.mark('session-lock-acquired' if result else 'session-lock-unavailable')
        return result

    def release(self):
        self.lock.release()
        self.ledger.mark('session-lock-released')

    def _is_owned(self):
        return self.lock._is_owned()

    def _release_save(self):
        saved = self.lock._release_save()
        self.ledger.mark('condition-released')
        return saved

    def _acquire_restore(self, state):
        self.ledger.mark('condition-reacquire-request')
        self.lock._acquire_restore(state)
        self.ledger.mark('condition-reacquired')

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()


def install(module):
    """Instrument only this imported isolated server inside the test process."""
    ledger = Ledger()

    def wrap(owner, name, phase, before=None):
        original = getattr(owner, name)
        @functools.wraps(original)
        def observed(*args, **kwargs):
            if before is not None:
                before(*args, **kwargs)
            with ledger.phase(phase):
                return original(*args, **kwargs)
        setattr(owner, name, observed)

    session = module.DemoSession
    original_init = session.__init__
    @functools.wraps(original_init)
    def initialize(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        self.lock = ObservedRLock(self.lock, ledger)
        self.changed = threading.Condition(self.lock)
    session.__init__ = initialize
    for name in ('snapshot', 'wait', 'preview', '_register', 'read_asset'):
        wrap(session, name, name.strip('_'))
    wrap(module.DemoApplication, 'call', 'tool')
    handler = module.DemoHandler
    wrap(handler, 'body', 'body')
    wrap(handler, 'execute_request', 'handler')
    wrap(handler, 'mcp', 'mcp', before=lambda self, value: ledger.bind(
        value, {tool['name'] for tool in self.server.app.tools['tools']}))
    wrap(handler, 'send', 'send', before=lambda self, code, body, *a, **k:
         ledger.mark('response-ready', status=code, bytes=len(body)))
    wrap(module, 'canonical', 'encode')
    server = module.DemoHTTPServer
    original_dispatch = server.process_request
    original_thread = server.process_request_thread

    def dispatch(self, request, address):
        previous = getattr(ledger.local, 'seq', 0)
        ledger.local.seq = ledger.begin(request)
        try:
            with ledger.phase('dispatch'):
                return original_dispatch(self, request, address)
        except BaseException:
            ledger.finish(request)
            raise
        finally:
            ledger.local.seq = previous

    def dispatched(self, request, address):
        with ledger.lock:
            ledger.local.seq = ledger.sockets.get(id(request), 0)
        try:
            with ledger.phase('request-thread'):
                return original_thread(self, request, address)
        finally:
            ledger.finish(request)
            ledger.local.seq = 0

    server.process_request = dispatch
    server.process_request_thread = dispatched
    return ledger


def write_once(ledger, target):
    """Caller supplies a test-owned fixed path; never exposed via MCP/HTTP."""
    target = Path(target)
    body = ledger.freeze()
    descriptor, temporary = tempfile.mkstemp(prefix='.rpc-trace-', dir=target.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        # Exclusive atomic publication: readers see either ENOENT or full JSON.
        # A pre-existing target must not be replaced by another exporter.
        os.link(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
