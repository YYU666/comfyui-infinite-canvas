"""Field domain, typed math, selection, and managed texture fixtures."""
import copy
import unittest
from pcg_contracts import PCGError
from pcg_geometry import evaluate, validate_value
from pcg_fields import field, validate_field, validate_image


def op(name,p=None,**inputs):return evaluate(name,p or {},inputs)
def plane():return op('primitive',{'kind':'plane'})['geometry']


class FieldTests(unittest.TestCase):
    def test_field_scalar_noise_and_vector_conversions(self):
        g=plane();v=op('noise_field',{'seed':3},geometry=g)['field']
        scalar=op('noise_field',{'seed':3,'output':'scalar'},geometry=g)['field']
        self.assertEqual(scalar['values'],[x[0] for x in v['values']])
        component=op('field_math',{'operation':'component_x'},a=v)['field']
        self.assertEqual(component,scalar)
        lengths=op('field_math',{'operation':'length'},a=v)['field']
        self.assertTrue(all(x>=0 for x in lengths['values']))
        normal=op('field_math',{'operation':'normalize'},a=v)['field']
        self.assertTrue(all(abs(sum(x*x for x in n)-1)<1e-12 for n in normal['values']))
        doubled=op('field_math',{'operation':'add'},a=v,b=v)['field']
        self.assertEqual(doubled['values'],[[2*x for x in n] for n in v['values']])
        multiplied=op('field_math',a=v,b=scalar)['field']
        self.assertEqual(multiplied['values'],[[x*scalar['values'][i] for x in n] for i,n in enumerate(v['values'])])
        self.assertEqual(multiplied,op('field_math',a=scalar,b=v)['field'])

    def test_source_content_invalidation_not_only_topology(self):
        g=plane();f=op('attribute_read',geometry=g)['field'];moved=copy.deepcopy(g);moved['positions'][0][1]=.1
        with self.assertRaises(PCGError):validate_field(f,moved)
        g2=copy.deepcopy(g);g2['uvs'][0]=[.3,.4]
        with self.assertRaises(PCGError):validate_field(f,g2)
        other=op('attribute_read',geometry=moved)['field']
        with self.assertRaises(PCGError):op('field_math',a=f,b=other)

    def test_field_count_and_boolean_strictness(self):
        g=plane();f=field(g,'Point','float',[1,2,3,4]);validate_value(f,g)
        f['values'].pop()
        with self.assertRaises(PCGError):validate_field(f,g)
        selection=op('selection',geometry=g)['selection'];selection['values'][0]=1
        with self.assertRaises(PCGError):validate_value(selection)
        with self.assertRaises(PCGError):field(g,'Corner','float',[1])

    def test_selection_boolean_combinations(self):
        g=plane();a=op('selection',{'mode':'every_n'},geometry=g)['selection'];b=op('selection',{'mode':'none'},geometry=g)['selection']
        self.assertEqual(op('selection',{'mode':'or'},geometry=g,a=a,b=b)['selection'],a)
        inverted=op('selection',{'mode':'not'},geometry=g,a=a)['selection']
        self.assertEqual(inverted['values'],[not x for x in a['values']])
        self.assertEqual(op('selection',{'mode':'and'},geometry=g,a=a,b=inverted)['selection']['values'],[False]*4)
        with self.assertRaises(PCGError):op('selection',{'mode':'and'},geometry=g,a=a)

    def test_sample_texture_bilinear_nearest_and_channels(self):
        points={'contractVersion':1,'type':'PointSet','positions':[[0,0,0],[1,0,0],[0,1,0],[1,1,0],[.5,.5,0]]}
        image={'contractVersion':1,'type':'Image','width':2,'height':2,'pixels':[[0,0,0],[1,0,0],[0,1,0],[1,1,1]]}
        bilinear=op('sample_texture',{'mapping':'xy'},geometry=points,image=image)['field']
        self.assertEqual(bilinear['values'][-1],[.5,.5,.25])
        nearest=op('sample_texture',{'mapping':'xy','interpolation':'nearest','channel':'b'},geometry=points,image=image)['field']
        self.assertEqual(nearest['values'],[0,0,0,1,1])
        self.assertEqual(bilinear['domain'],'Point')
        uv=op('sample_texture',geometry=plane(),image=image)['field']
        self.assertEqual(uv['domain'],'Corner');self.assertEqual(len(uv['values']),6)
        constant=op('sample_texture',{'color':[.1,.2,.3]},geometry=plane())['field']
        self.assertEqual(constant['values'],[[.1,.2,.3]]*6)

    def test_managed_image_budget_and_forbidden_paths(self):
        for image in ({'path':'x.png'}, {'contractVersion':1,'type':'Image','width':1025,'height':1,'pixels':[]}, {'contractVersion':1,'type':'Image','width':1,'height':1,'pixels':[[2,0,0]]}):
            with self.assertRaises(PCGError):validate_image(image)
        with self.assertRaises(PCGError):op('sample_texture',{'color':[2,0,0]},geometry=plane())


if __name__=='__main__':unittest.main()
