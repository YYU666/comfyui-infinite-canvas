"""No GPU work: mocked NVIDIA/Comfy reports exercise narrow WDDM exception."""
import io
import json
import os
import subprocess
import unittest
import urllib.error
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch
from native3d_partfield import _check_gpu_idle

def xml(driver='WDDM',kind='C+G',memory='N/A',used='1662 MiB',free='22000 MiB',util='25 %',pid=12345):
    return f'<nvidia_smi_log><gpu><driver_model><current_dm>{driver}</current_dm></driver_model><fb_memory_usage><used>{used}</used><free>{free}</free></fb_memory_usage><utilization><gpu_util>{util}</gpu_util></utilization><processes><process_info><pid>{pid}</pid><type>{kind}</type><used_memory>{memory}</used_memory></process_info></processes></gpu></nvidia_smi_log>'

class GPUIdleTests(unittest.TestCase):
    def run_check(self,reports=None,pids='12345',queues=None,returncode=0,free='22000',resident_pid=None):
        reports=iter(reports or [xml(),xml()]);queues=iter(queues or [{'queue_running':[],'queue_pending':[]}]*3)
        calls=[]
        def smi(command,**kwargs):
            calls.append(command)
            output=next(reports) if '-x' in command else pids if '--query-compute-apps=pid' in command else free
            return SimpleNamespace(returncode=returncode,stdout=output)
        def comfy(*args,**kwargs):return io.StringIO(json.dumps(next(queues)))
        with ExitStack() as stack:
            stack.enter_context(patch.dict('os.environ', {'H3_COMFY_URL':'http://127.0.0.1:8188'}))
            stack.enter_context(patch('shutil.which',return_value='nvidia-smi'))
            stack.enter_context(patch('native3d_partfield.subprocess.run',side_effect=smi))
            stack.enter_context(patch('urllib.request.urlopen',side_effect=comfy))
            if resident_pid is None:
                stack.enter_context(patch('gpu_lease.comfy_process',side_effect=RuntimeError('fixture no listener')))
            else:
                stack.enter_context(patch('gpu_lease.comfy_process',return_value={'pid':resident_pid}))
            sleep=stack.enter_context(patch('time.sleep'))
            result=_check_gpu_idle()
        return result,calls,sleep

    def test_desktop_ambiguous_reports_require_two_samples(self):
        result,calls,sleep=self.run_check()
        self.assertEqual(result['mode'],'wddm_ambiguous_desktop_headroom')
        self.assertFalse(result['exclusiveGPU']);self.assertEqual(len(result['samples']),2)
        self.assertEqual(sum('-x' in c for c in calls),2);sleep.assert_called_once_with(.2)

    def test_pure_compute_numeric_memory_and_unknown_driver_rejected(self):
        for kwargs in ({'kind':'C'},{'memory':'512 MiB'},{'driver':'TCC'},{'driver':'N/A'},{'driver':''},{'kind':'G'}):
            with self.subTest(kwargs=kwargs),self.assertRaises(ValueError):self.run_check([xml(**kwargs)])

    def test_headroom_limits_checked_on_both_samples(self):
        for kwargs in ({'used':'2049 MiB'},{'free':'6143 MiB'},{'util':'51 %'}):
            for sample in (0,1):
                reports=[xml(),xml()];reports[sample]=xml(**kwargs)
                with self.subTest(kwargs=kwargs,sample=sample),self.assertRaises(ValueError):self.run_check(reports)
        result,_,_=self.run_check([xml(used='2048 MiB',free='6144 MiB',util='50 %')]*2)
        self.assertEqual(len(result['samples']),2)

    def test_busy_comfy_running_pending_or_late_work_rejected(self):
        empty={'queue_running':[],'queue_pending':[]}
        for key in empty:
            for index in (0,1,2):
                queues=[empty.copy() for _ in range(3)];queues[index][key]=[['real task']]
                with self.subTest(key=key,index=index),self.assertRaisesRegex(ValueError,'ComfyUI has'):self.run_check(queues=queues)

    def test_idle_verified_comfy_residency_is_not_an_external_task(self):
        resident = xml(kind='C', pid=12345, used='4000 MiB')
        extra = '<process_info><pid>54421</pid><type>G</type><used_memory>N/A</used_memory></process_info>'
        report = resident.replace('</processes>', extra+'</processes>')
        result,_,_=self.run_check([report,report],resident_pid=12345)
        self.assertTrue(result['samples'][0]['verifiedIdleComfyResident'])
        with self.assertRaisesRegex(ValueError,'headroom'):
            self.run_check([xml(kind='C',free='5600 MiB')]*2,resident_pid=12345)
        external = extra.replace('<type>G</type>', '<type>C</type>')
        with self.assertRaisesRegex(ValueError,'another GPU compute'):
            self.run_check([resident.replace('</processes>',external+'</processes>')],pids='12345\n54421',resident_pid=12345)

    def test_malformed_unknown_or_missing_information_rejected(self):
        bad=[xml(used='N/A'),xml(free='nan MiB'),xml(util='unknown'),xml(pid=54321),'<bad',xml().replace('<processes>','<missing>').replace('</processes>','</missing>')]
        for report in bad:
            with self.subTest(report=report),self.assertRaises(ValueError):self.run_check([report])
        for pids in ('unknown','12345\nN/A'):
            with self.subTest(pids=pids),self.assertRaises(ValueError):self.run_check(pids=pids)
        for queue in ({},[],{'queue_running':None,'queue_pending':[]}):
            with self.subTest(queue=queue),self.assertRaises(ValueError):self.run_check(queues=[queue])

    def test_normal_mode_unchanged_and_own_pid_ignored(self):
        for pids in ('','No running processes found',str(os.getpid())):
            result,calls,sleep=self.run_check(pids=pids)
            self.assertEqual(result['mode'],'no_external_compute_reported')
            self.assertFalse(any('-x' in c for c in calls));sleep.assert_not_called()
        for free in ('1024','N/A','nan','inf'):
            with self.subTest(free=free),self.assertRaises(ValueError):self.run_check(pids='',free=free)

    def test_own_pid_not_treated_as_external_pure_compute(self):
        own=f'<process_info><pid>{os.getpid()}</pid><type>C</type><used_memory>100 MiB</used_memory></process_info>'
        report=xml().replace('</processes>',own+'</processes>')
        result,_,_=self.run_check([report,report],pids=f'12345\n{os.getpid()}')
        self.assertEqual(result['samples'][0]['externalAmbiguousProcesses'],1)

    def test_query_failure_and_unknown_comfy_availability_rejected(self):
        with self.assertRaises(ValueError):self.run_check(returncode=1)
        with patch('urllib.request.urlopen',side_effect=urllib.error.URLError(TimeoutError('timeout'))):
            with self.assertRaisesRegex(ValueError,'availability'):_check_gpu_idle()
        with patch('urllib.request.urlopen',return_value=io.StringIO('{broken')):
            with self.assertRaises(ValueError):_check_gpu_idle()
        with patch('urllib.request.urlopen',return_value=io.StringIO('{"queue_running":[],"queue_pending":[]}')),patch('shutil.which',return_value='nvidia-smi'),patch('native3d_partfield.subprocess.run',side_effect=subprocess.TimeoutExpired('nvidia-smi',10)):
            with self.assertRaises(subprocess.TimeoutExpired):_check_gpu_idle()

if __name__=='__main__':unittest.main()
