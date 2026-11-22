"""Mock-only admission test; only installed feature modules are exercised."""
import importlib
import importlib.util
import threading
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase, mock
from project_store import StoreError


class StoreAdmissionTests(TestCase):
    def test_root_replacement_cannot_split_resolution_from_admission(self):
        for key, cls in [('edit','Edit'),('rhythm','Rhythm'),('chroma','Chroma'),('repair','Repair'),('plate','Plate')]:
            if importlib.util.find_spec(f'video_{key}_jobs') is None: continue
            with self.subTest(feature=key), TemporaryDirectory() as directory:
                module=importlib.import_module(f'video_{key}_jobs')
                jobs=getattr(module,f'Video{cls}Jobs')(directory,mock.Mock())
                entered, release, attempted, finished= [threading.Event() for _ in range(4)]
                errors=[]; replacements=[]
                payload=dict(projectId='prj_test',nodeId='test',settings={})
                if key=='edit': payload.pop('settings'); payload.update(inputs={'v1':'fixture'},document={})
                if key=='rhythm': payload.update(operation='speed',input='fixture')
                if key=='chroma': payload.update(foreground='fixture',background='fixture')
                if key=='repair': payload.update(source='fixture')
                if key=='plate': payload.update(video='fixture')
                def resolve(*args,**kwargs):
                    entered.set()
                    if not release.wait(3): raise TimeoutError('fixture resolution')
                    return ({},Path('fixture'),{}) if key=='repair' else (Path('fg'),Path('bg'),True) if key=='chroma' else Path('fixture')
                def submit():
                    try: jobs.submit(payload)
                    except Exception as error: errors.append(error)
                def replace():
                    attempted.set()
                    try: jobs.replace_store(mock.Mock()); replacements.append(True)
                    except StoreError: replacements.append(False)
                    finally: finished.set()
                target='_request' if key=='repair' else '_sources' if key=='chroma' else '_asset'
                with mock.patch.object(jobs,target,side_effect=resolve), mock.patch.object(jobs,'runner_factory',return_value=mock.Mock()):
                    if key=='edit': patch=mock.patch.object(module,'normalize_document',return_value={'clips':[{'inputSlot':'v1'}],'outputProfile':{'audio':'clips'}})
                    elif key=='rhythm': patch=mock.patch.object(jobs,'_document',return_value={'operation':'speed'})
                    else: patch=mock.patch.object(jobs,'_settings',return_value={}) if hasattr(jobs,'_settings') else mock.patch.object(jobs,'_capacity')
                    with patch:
                        if hasattr(jobs,'worker'): jobs.worker=mock.Mock()
                        else: jobs.pool.submit=mock.Mock()
                        a,b=threading.Thread(target=submit),threading.Thread(target=replace)
                        a.start()
                        try:
                            self.assertTrue(entered.wait(3)); b.start(); self.assertTrue(attempted.wait(3))
                            self.assertFalse(finished.wait(.05),'root switched while source resolution was in flight')
                        finally:
                            release.set(); a.join(3); b.join(3) if b.ident else None
                self.assertFalse(errors)
                self.assertEqual(replacements,[False])
                jobs.close()
