import concurrent.futures
import subprocess
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hardware_metrics import HardwareMetrics, parse_nvidia_metrics, MIB, GPU_UNKNOWN, SMI_ARGUMENTS


class HardwareMetricsTests(unittest.TestCase):
    def setUp(self):
        self.cpu = patch('hardware_metrics.psutil.cpu_percent', return_value=43.7).start()
        self.memory = patch('hardware_metrics.psutil.virtual_memory', return_value=SimpleNamespace(total=16000, available=6000)).start()
        self.which = patch('hardware_metrics.shutil.which', return_value='C:/Windows/System32/nvidia-smi.exe').start()
        self.run = patch('hardware_metrics.subprocess.run', return_value=SimpleNamespace(stdout='0, NVIDIA Test, 1234, 24576, 87\n')).start()
        self.addCleanup(patch.stopall)

    def test_real_schema_units_and_fixed_bounded_command(self):
        result=HardwareMetrics().read()
        self.assertEqual(result['vramUsed'],1234*MIB)
        self.assertEqual(result['vramTotal'],24576*MIB)
        self.assertEqual(result['gpuPercent'],87)
        self.assertEqual(result['gpuIndex'],0)
        self.assertEqual((result['cpuPercent'],result['ramUsed'],result['ramTotal']),(43.7,10000,16000))
        self.cpu.assert_called_once_with(interval=.1)
        args,kwargs=self.run.call_args
        self.assertEqual(args[0],['C:/Windows/System32/nvidia-smi.exe',*SMI_ARGUMENTS])
        self.assertIs(kwargs['shell'],False)
        self.assertLessEqual(kwargs['timeout'],2)
        self.assertIsInstance(result['timestamp'],int)

    def test_multiple_cards_select_lowest_index_without_aggregation(self):
        result=parse_nvidia_metrics('3, Other GPU, 8, 16, 99\n0, First GPU, 2, 10, 12\n')
        self.assertEqual((result['gpuIndex'],result['gpuName'],result['vramUsed']),(0,'First GPU',2*MIB))
        result=parse_nvidia_metrics('7, Other GPU, 1, 2, 3\n2, First Visible GPU, 4, 8, 50\n')
        self.assertEqual(result['gpuIndex'],2)
        with self.assertRaises(ValueError):
            parse_nvidia_metrics('0, Broken Primary, N/A, 8, 5\n1, Secondary, 2, 8, 10\n')

    def test_unknown_driver_timeout_and_malformed_preserve_cpu_ram(self):
        errors=[subprocess.TimeoutExpired('nvidia-smi',1.5),subprocess.CalledProcessError(1,'nvidia-smi'),OSError('missing')]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                self.run.side_effect=error
                result=HardwareMetrics().read()
                self.assertTrue(all(result[k] is None for k in GPU_UNKNOWN))
                self.assertEqual(result['cpuPercent'],43.7)
                self.assertEqual(result['ramUsed'],10000)
        self.run.side_effect=None
        for output in ('','not,csv','0, GPU, nan, 8, 12','0, GPU, 9, 8, 12','0, GPU, 2, 8, N/A'):
            self.run.return_value=SimpleNamespace(stdout=output)
            self.assertTrue(all(HardwareMetrics().read()[k] is None for k in GPU_UNKNOWN))
        self.which.return_value=None
        self.run.reset_mock()
        self.assertIsNone(HardwareMetrics().read()['gpuPercent'])
        self.run.assert_not_called()

    def test_cpu_and_ram_failures_do_not_hide_gpu_or_each_other(self):
        self.cpu.side_effect=RuntimeError('unavailable')
        result=HardwareMetrics().read()
        self.assertIsNone(result['cpuPercent'])
        self.assertEqual(result['ramUsed'],10000)
        self.assertEqual(result['gpuPercent'],87)
        self.cpu.side_effect=None
        self.memory.side_effect=RuntimeError('unavailable')
        result=HardwareMetrics().read()
        self.assertIsNone(result['ramUsed'])
        self.assertEqual(result['cpuPercent'],43.7)
        self.assertEqual(result['gpuPercent'],87)

    def test_ttl_caches_failures_and_returns_independent_snapshots(self):
        metrics=HardwareMetrics(ttl=2)
        with patch('hardware_metrics.time.monotonic',return_value=100) as clock:
            first=metrics.read();first['gpuPercent']=0
            self.assertEqual(metrics.read()['gpuPercent'],87)
            self.assertEqual(self.run.call_count,1)
            clock.return_value=103
            self.run.side_effect=subprocess.TimeoutExpired('nvidia-smi',1.5)
            self.assertIsNone(metrics.read()['gpuPercent'])
            self.assertIsNone(metrics.read()['gpuPercent'])
            self.assertEqual(self.run.call_count,2)

    def test_concurrent_requests_refresh_only_once(self):
        barrier=threading.Barrier(8)
        def slow_run(*args,**kwargs):
            time.sleep(.03)
            return SimpleNamespace(stdout='0, GPU, 2, 8, 10\n')
        self.run.side_effect=slow_run
        metrics=HardwareMetrics()
        def request(_):barrier.wait(timeout=2);return metrics.read()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(request,range(8)))
        self.assertEqual(self.run.call_count,1)
        self.assertEqual(self.cpu.call_count,1)
        self.assertTrue(all(result['gpuPercent']==10 for result in results))

if __name__=='__main__':unittest.main()
