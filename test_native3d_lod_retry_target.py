import copy
import math
import unittest
from native3d_jobs import SCHEMAS, validate_parameters
from native3d_lod_retry import resolve_retry_target
from project_store import StoreError


class RetryTargetTests(unittest.TestCase):
    def case(self, **extra):
        params={'retryJobId':'n3d_'+'a'*32,'retryStage':'lod3','seed':17,**extra}
        context={'lod0Triangles':99999,'settings':{'lod0KeepPercent':10.,'lodPercentReference':'lod0',
                 'lodKeepPercents':[100.,10.,5.,2.5,1.25],'lodFaceCaps':[100000,10000,None,None,None],
                 'selectedLodLevel':2}}
        return params,context

    def test_omitted_and_explicit_default_are_distinguishable(self):
        params,context=self.case();omitted=validate_parameters('source_lod',params)
        explicit=validate_parameters('source_lod',{**params,'retryKeepPercent':12.5})
        self.assertNotIn('default',SCHEMAS['source_lod']['retryKeepPercent'])
        self.assertNotIn('retryKeepPercent',omitted);self.assertEqual(explicit['retryKeepPercent'],12.5)
        self.assertEqual(omitted['lod3KeepPercent'],12.5)
        self.assertEqual(resolve_retry_target(omitted,context,1998143,4999)[1]['effectiveTargetTriangles'],2499)
        self.assertEqual(resolve_retry_target(explicit,context,1998143,4999)[1]['effectiveTargetTriangles'],4999)

    def test_explicit_three_percent_is2999_not2499(self):
        params,context=self.case(retryKeepPercent=3)
        settings,plan,policy=resolve_retry_target(validate_parameters('source_lod',params),context,1998143,4999)
        self.assertEqual(plan['effectiveTargetTriangles'],2999)
        self.assertEqual(policy['previousKeepPercent'],2.5);self.assertEqual(policy['requestedKeepPercent'],3.)
        self.assertEqual(policy['previousEffectiveTargetTriangles'],2499)
        self.assertEqual(policy['percentageBaseTriangles'],99999);self.assertEqual(policy['percentageReference'],'lod0')
        self.assertEqual(policy['mode'],'explicit_single_stage_override');self.assertFalse(policy['automaticRatioSearch'])

    def test_frozen_settings_and_other_stages_unchanged(self):
        params,context=self.case(retryKeepPercent=3);before=copy.deepcopy(context)
        settings,plan,policy=resolve_retry_target(params,context,1998143,4999)
        self.assertEqual(context,before)
        for i in (0,1,2,4):self.assertEqual(settings['lodKeepPercents'][i],before['settings']['lodKeepPercents'][i])
        self.assertEqual(settings['lodFaceCaps'],before['settings']['lodFaceCaps'])
        self.assertEqual(settings['lod0KeepPercent'],10.);self.assertEqual(settings['selectedLodLevel'],3)

    def test_frozen_face_cap_cannot_be_relaxed_by_request(self):
        params,context=self.case(retryKeepPercent=3,lod3FaceCap=0);context['settings']['lodFaceCaps'][3]=2700
        _,plan,policy=resolve_retry_target(params,context,1998143,4999)
        self.assertEqual(plan['percentageTargetTriangles'],2999);self.assertEqual(plan['effectiveTargetTriangles'],2700)
        self.assertEqual(policy['frozenFaceCap'],2700);self.assertTrue(policy['budgetClampedPercentage'])

    def test_default_filled_scalar_settings_never_override(self):
        params,context=self.case(lod3KeepPercent=4,lod2KeepPercent=6,lod4KeepPercent=2,lod0KeepPercent=90)
        _,plan,policy=resolve_retry_target(validate_parameters('source_lod',params),context,1998143,4999)
        self.assertEqual(plan['effectiveTargetTriangles'],2499);self.assertEqual(policy['mode'],'frozen_single_stage_target')

    def test_nonretry_and_incomplete_retry_rejected(self):
        for values in ({'retryKeepPercent':3},{'retryKeepPercent':3,'retryStage':'lod3'}, {'retryKeepPercent':3,'seed':17}):
            with self.assertRaises(StoreError):validate_parameters('source_lod',values)
            with self.assertRaises(ValueError):resolve_retry_target(values,{},1998143,4999)

    def test_invalid_values_rejected_at_api_and_worker(self):
        for value in (None,True,False,0,-1,.0009,100.1,float('nan'),float('inf'),-float('inf'),'3',[],{}):
            params,context=self.case(retryKeepPercent=value)
            with self.subTest(value=value):
                with self.assertRaises(StoreError):validate_parameters('source_lod',params)
                with self.assertRaises(ValueError):resolve_retry_target(params,context,1998143,4999)

    def test_existing_previous_parent_reference_is_preserved(self):
        params,context=self.case(retryKeepPercent=60);context['settings']['lodPercentReference']='previous'
        _,plan,policy=resolve_retry_target(params,context,1998143,4999)
        self.assertEqual(plan['percentageBaseTriangles'],4999);self.assertEqual(plan['effectiveTargetTriangles'],2999)
        self.assertEqual(policy['percentageReference'],'previous')

    def test_minimum_and_parent_limit_preserved(self):
        for percentage,target in ((.001,4),(100,4999)):
            params,context=self.case(retryKeepPercent=percentage)
            _,plan,_=resolve_retry_target(validate_parameters('source_lod',params),context,1998143,4999)
            self.assertEqual(plan['effectiveTargetTriangles'],target)

if __name__=='__main__':unittest.main()

