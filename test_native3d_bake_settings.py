import unittest
import numpy as np
from native3d_engine import resolve_bake_settings
from native3d_jobs import SCHEMAS,validate_parameters
from native3d_bake_ao import sample_high_surface_ao
from project_store import StoreError


class BakeSettingsTests(unittest.TestCase):
    def test_defaults_and_explicit_legacy_values(self):
        queued=validate_parameters('bake',{})
        settings=resolve_bake_settings({},10.)
        self.assertEqual((settings['resolution'],settings['aoSamples'],settings['padding']),(2048,64,16))
        self.assertEqual((settings['aoRadiusFraction'],settings['aoRadius'],settings['aoAttenuation']),(.1,1.,'linear'))
        self.assertEqual(settings['baselineVersion'],'bake-defaults-20261104')
        for key in queued:self.assertEqual(queued[key],settings['paddingRequested'] if key=='padding' else settings[key])
        explicit=resolve_bake_settings({'resolution':1024,'aoSamples':32,'aoAttenuation':'none','padding':7},10.)
        self.assertEqual((explicit['resolution'],explicit['aoSamples'],explicit['padding']),(1024,32,7))
        for resolution,padding in [(1024,8),(2048,16),(4096,32)]:
            self.assertEqual(resolve_bake_settings({'resolution':resolution},10.)['padding'],padding)

    def test_ao_radius_independent_of_cage_and_bias_unchanged(self):
        a=resolve_bake_settings({'rayDistance':.01},10.)
        b=resolve_bake_settings({'rayDistance':.05},10.)
        self.assertEqual(a['aoRadius'],b['aoRadius'])
        self.assertNotEqual(a['cageDistance'],b['cageDistance'])
        for settings in [a,b]:self.assertEqual(settings['aoEpsilon'],max(settings['cageDistance']*1e-4,1e-7))
        custom=resolve_bake_settings({'aoRadiusFraction':.2},10.)
        self.assertEqual(custom['aoRadius'],2.)

    def test_schema_worker_bounds_and_rejections_agree(self):
        for value in [{'aoSamples':8},{'aoSamples':256},{'aoRadiusFraction':.001},{'aoRadiusFraction':1},
                      {'padding':0},{'padding':64},{'aoAttenuation':'none'},{'aoAttenuation':'linear'}]:
            validate_parameters('bake',value);resolve_bake_settings(value,10.)
        invalid=[{'aoSamples':x} for x in [True,8.,7,257,float('nan'),float('inf')]]
        invalid += [{'aoRadiusFraction':x} for x in [True,0,.0009,1.01,float('nan'),float('inf'),-float('inf')]]
        invalid += [{'padding':x} for x in [True,-1,65,8.5,float('nan'),float('inf')]]
        invalid += [{'rayDistance':x} for x in [True,float('nan'),float('inf')]]
        invalid += [{'resolution':True},{'resolution':2048.},{'aoAttenuation':True},{'aoAttenuation':'quadratic'},[],None,{'unknown':1}]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(StoreError):validate_parameters('bake',value)
                with self.assertRaises(ValueError):resolve_bake_settings(value,10.)
        for key in ['resolution','aoSamples','aoRadiusFraction','aoAttenuation','padding']:
            self.assertTrue(SCHEMAS['bake'][key]['title'])

    def test_real_plane_linear_attenuation_and_legacy_none(self):
        import open3d as o3d
        scene=o3d.t.geometry.RaycastingScene()
        vertices=np.array([[-100,-100,.25],[100,-100,.25],[100,100,.25],[-100,100,.25]],np.float32)
        scene.add_triangles(o3d.core.Tensor(vertices),o3d.core.Tensor(np.array([[0,1,2],[0,2,3]],np.uint32)))
        cast=lambda rays:scene.cast_rays(o3d.core.Tensor(rays))['t_hit'].numpy()
        args=(np.array([[0.,0,0]]),np.array([[0.,0,1]]),256,1.,1e-5,cast)
        legacy=sample_high_surface_ao(*args)
        none=sample_high_surface_ao(*args,attenuation='none')
        linear=sample_high_surface_ao(*args,attenuation='linear')
        np.testing.assert_array_equal(legacy,none)
        # Analytic cosine integral for an infinite parallel occluder:
        # none visibility=a^2; linear visibility=2a-a^2, a=height/radius.
        a=.25-1e-5
        self.assertAlmostEqual(none[0],a*a,delta=.005)
        self.assertAlmostEqual(linear[0],2*a-a*a,delta=.005)
        empty=lambda rays:np.full(len(rays),np.inf)
        self.assertEqual(sample_high_surface_ao(*args[:5],empty,attenuation='linear')[0],1.)
        with self.assertRaises(ValueError):sample_high_surface_ao(*args,attenuation='invalid')


if __name__=='__main__':unittest.main()
