"""Deterministic contracts for the isolated test-only RPC ledger."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock
from scripts.pcg_m4_rpc_trace import Ledger, ObservedRLock, write_once


class RPCTraceTests(unittest.TestCase):
    def test_capacity_and_bytes(self):
        ledger = Ledger()
        sockets = [object() for _ in range(40)]
        for socket in sockets:
            ledger.begin(socket)
        self.assertEqual(len(ledger.active), 32)
        for socket in sockets:
            ledger.finish(socket)
        for _ in range(300):
            socket = object()
            ledger.local.seq = ledger.begin(socket)
            ledger.bind({'id': 10, 'method': 'tools/call', 'params': {'name': 'pcg_demo_wait'}}, {'pcg_demo_wait'})
            for _ in range(20):
                ledger.mark('session-lock-request')
            ledger.finish(socket)
        self.assertLessEqual(len(ledger.completed), 128)
        self.assertLessEqual(len(ledger.events), 256)
        body = ledger.freeze()
        self.assertLessEqual(len(body), 65536)
        self.assertTrue(json.loads(body)['completed'])
        self.assertEqual(ledger.sockets, {})

    def test_no_request_payload_or_strings_retained(self):
        ledger = Ledger()
        socket = object()
        ledger.local.seq = ledger.begin(socket)
        secret = 'SENSITIVE_RAW_VALUE'
        ledger.bind({'id': secret, 'method': secret,
                     'params': {'name': secret, 'arguments': {'token': secret}}}, {'pcg_demo_wait'})
        ledger.mark('body-end')
        self.assertNotIn(secret.encode(), ledger.freeze())

    def test_condition_releases_and_restores_recursive_lock(self):
        ledger = Ledger()
        lock = ObservedRLock(threading.RLock(), ledger)
        condition = threading.Condition(lock)
        notified = threading.Event()
        def signal():
            with condition:
                notified.set()
                condition.notify_all()
        with lock, condition:
            thread = threading.Thread(target=signal)
            thread.start()
            self.assertTrue(condition.wait_for(notified.is_set, 2))
            self.assertTrue(lock._is_owned())
        thread.join(2)
        self.assertFalse(thread.is_alive())
        phases = [event['phase'] for event in ledger.events]
        self.assertIn('condition-released', phases)
        self.assertIn('condition-reacquired', phases)

    def test_failure_frozen_and_single_exclusive_export(self):
        ledger = Ledger()
        ledger.mark('send-error')
        first = ledger.freeze()
        ledger.mark('send-end')
        self.assertEqual(ledger.freeze(), first)
        with tempfile.TemporaryDirectory(prefix='pcg-ledger-') as directory:
            target = Path(directory) / 'trace.json'
            write_once(ledger, target)
            self.assertEqual(target.read_bytes(), first)
            with self.assertRaises(FileExistsError):
                write_once(ledger, target)

    def test_export_publishes_only_complete_json(self):
        ledger = Ledger()
        ledger.mark('body-end')
        ready, resume = threading.Event(), threading.Event()
        import os
        original_link = os.link
        errors = []
        def paused_link(source, target):
            self.assertEqual(Path(source).read_bytes(), ledger.freeze())
            ready.set()
            if not resume.wait(2):
                raise AssertionError('Test did not release publication')
            original_link(source, target)
        with tempfile.TemporaryDirectory(prefix='pcg-ledger-') as directory:
            target = Path(directory) / 'trace.json'
            def export():
                try:
                    write_once(ledger, target)
                except BaseException as error:
                    errors.append(error)
            with mock.patch('scripts.pcg_m4_rpc_trace.os.link', side_effect=paused_link):
                thread = threading.Thread(target=export)
                thread.start()
                try:
                    self.assertTrue(ready.wait(2))
                    self.assertFalse(target.exists())
                finally:
                    resume.set()
                    thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(json.loads(target.read_bytes())['contract'], 'test-only-rpc-phases-v1')
            self.assertEqual(list(Path(directory).iterdir()), [target])


if __name__ == '__main__':
    unittest.main()
