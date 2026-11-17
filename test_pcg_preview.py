"""Real static geometry projections; no browser or running canvas."""
import unittest
import xml.etree.ElementTree as ET
from pcg_geometry import evaluate
from pcg_preview import render_preview_svg


class PreviewTests(unittest.TestCase):
    def test_real_geometry_deterministic_svg(self):
        mesh = evaluate('rock', {'seed': 17}, {})['geometry']
        svg = render_preview_svg(mesh)
        self.assertEqual(svg, render_preview_svg(mesh))
        root = ET.fromstring(svg)
        self.assertEqual(root.tag, '{http://www.w3.org/2000/svg}svg')
        self.assertIn(b'<polygon', svg)
        self.assertNotIn(b'href=', svg)
        self.assertNotIn(b'<script', svg)

    def test_sample_label_and_instances(self):
        ground = evaluate('primitive', {'kind':'plane','size':[10,1,10]}, {})['geometry']
        points = evaluate('scatter_points', {'count':2000}, {'geometry':ground})['points']
        self.assertIn(b'sampled preview', render_preview_svg(points))
        mesh = evaluate('primitive', {}, {})['geometry']
        instances = evaluate('instance_on_points', {}, {'points':points,'prototype':mesh})['instances']
        svg = render_preview_svg(instances)
        self.assertIn(b'InstanceSet', svg)
        self.assertLessEqual(svg.count(b'<polygon'), 1800)
        self.assertIn(b'sampled preview', svg)


if __name__ == '__main__': unittest.main()
