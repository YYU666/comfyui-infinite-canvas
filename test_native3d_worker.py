"""CPU-only worker lifecycle/observational instrumentation checks; no weights."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch
import numpy as np
from native3d_meshanything import observe_generate, prepare_legacy_batch, official_batch, advance_legacy_sampling_rng

class TensorFixture:
    def __init__(self,array):self.array=array
    def detach(self):return self
    def cpu(self):return self
    def numpy(self):return self.array

class WorkerTest(unittest.TestCase):
    def test_observer_delegates_once_unchanged_and_records_tokens(self):
        tokens=np.array([[0,5,8,1]],dtype=np.int64)
        result=TensorFixture(tokens)
        original=Mock(return_value=result)
        payload=object()
        with tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()):
            actual=observe_generate(original,folder,np)(inputs_embeds=payload,max_new_tokens=10083,num_beams=1,eos_token_id=1)
            self.assertIs(actual,result)
            original.assert_called_once_with(inputs_embeds=payload,max_new_tokens=10083,num_beams=1,eos_token_id=1)
            np.testing.assert_array_equal(np.load(Path(folder)/'ai_token_ids.npy'),tokens)
            receipt=json.loads((Path(folder)/'ai_generation_receipt.json').read_text())
            self.assertEqual(receipt['rows'],[{'length':4,'firstEosIndex':3,'lastToken':1}])
            self.assertEqual(receipt['maxNewTokens'],10083)
            self.assertEqual(receipt['status'],'completed')
            self.assertGreaterEqual(receipt['seconds'],0)

    def test_observer_failure_is_preserved_without_fake_tokens(self):
        with tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()):
            original=Mock(side_effect=RuntimeError('fixture failure'))
            with self.assertRaisesRegex(RuntimeError,'fixture failure'):
                observe_generate(original,folder,np)(max_new_tokens=10083)
            self.assertEqual(original.call_count,1)
            receipt=json.loads((Path(folder)/'ai_generation_receipt.json').read_text())
            self.assertEqual(receipt['status'],'failed')
            self.assertFalse((Path(folder)/'ai_token_ids.npy').exists())

    def test_success_with_token_save_failure_keeps_result_identity(self):
        result=TensorFixture(np.array([[0,1]],dtype=np.int64))
        original=Mock(return_value=result)
        with tempfile.TemporaryDirectory() as folder,contextlib.redirect_stdout(io.StringIO()) as logs:
            with patch.object(np,'save',side_effect=OSError('C:/private/do-not-log')):
                actual=observe_generate(original,folder,np)(max_new_tokens=10083,eos_token_id=1)
            self.assertIs(actual,result)
            self.assertEqual(original.call_count,1)
            receipt=json.loads((Path(folder)/'ai_generation_receipt.json').read_text())
            self.assertEqual(receipt['status'],'completed')
            self.assertEqual(receipt['observationErrors'][0]['errorType'],'OSError')
            self.assertNotIn('private',logs.getvalue())

    def test_original_exception_survives_receipt_failure(self):
        failure=RuntimeError('original exception identity')
        original=Mock(side_effect=failure)
        with patch.object(Path,'write_text',side_effect=OSError('private path')),contextlib.redirect_stdout(io.StringIO()) as logs:
            with self.assertRaises(RuntimeError) as caught:
                observe_generate(original,'unused',np)(max_new_tokens=10083)
            self.assertIs(caught.exception,failure)
            self.assertEqual(original.call_count,1)
            self.assertNotIn('private path',logs.getvalue())
            self.assertNotIn('original exception identity',logs.getvalue())

    def test_initial_logging_failure_still_delegates_once(self):
        result=TensorFixture(np.array([[0,1]],dtype=np.int64))
        original=Mock(return_value=result)
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(Path,'write_text',side_effect=OSError('private path')),patch('builtins.print',side_effect=BrokenPipeError()):
                actual=observe_generate(original,folder,np)(max_new_tokens=10083)
            self.assertIs(actual,result)
            self.assertEqual(original.call_count,1)

    def test_official_sampling_numpy_rng_fixture(self):
        np.random.seed(0)
        digest=advance_legacy_sampling_rng(np,8192)
        self.assertEqual(digest,'1a1f5f2c7081e3d28240e53b3cef7fc1798abb3e513b539f7297146fb024c062')

    def test_cpu_accelerator_loader_rng_matches_direct_lifecycle(self):
        # Hide CUDA before importing Torch. Tests never instantiate a model/device.
        os.environ['CUDA_VISIBLE_DEVICES']=''
        try:
            import torch
            from accelerate import Accelerator
        except ImportError:
            self.skipTest('Torch/Accelerate optional worker environment unavailable')
        accelerator=Accelerator(cpu=True,mixed_precision='no')
        pc=np.ones((8192,6),dtype=np.float16)
        model=torch.nn.Identity()
        torch.manual_seed(0)
        expected=official_batch(pc,torch)
        expected_state=torch.get_rng_state().clone()
        torch.manual_seed(0)
        actual,prepared=prepare_legacy_batch(pc,model,torch,accelerator)
        self.assertFalse(prepared.training)
        np.testing.assert_array_equal(actual.numpy(),expected.numpy())
        self.assertTrue(torch.equal(torch.get_rng_state(),expected_state))

if __name__=='__main__':unittest.main()
