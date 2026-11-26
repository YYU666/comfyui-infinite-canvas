import tempfile
from pathlib import Path
import unittest

import numpy as np
from PIL import Image
import trimesh

from native3d_report import camera_for_bounds, project_vertices, rasterize, render_report, shading_normals


class Native3DReportTests(unittest.TestCase):
    def test_angle_groups_keep_cube_creases_and_do_not_mutate_mesh(self):
        mesh = trimesh.creation.box()
        vertices, faces = mesh.vertices.copy(), mesh.faces.copy()
        normals, receipt = shading_normals(mesh)
        np.testing.assert_allclose(normals, np.repeat(mesh.face_normals[:, None, :], 3, axis=1))
        self.assertEqual(receipt['creaseAngleDegrees'], 45)
        np.testing.assert_array_equal(vertices, mesh.vertices)
        np.testing.assert_array_equal(faces, mesh.faces)
        self.assertNotIn('vertex_normals', mesh._cache.cache)

    def test_shallow_join_smooths_but_split_vertices_remain_hard(self):
        points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, .3]]
        mesh = trimesh.Trimesh(points, [[0, 1, 2], [1, 0, 3]], process=False)
        normals, _ = shading_normals(mesh)
        np.testing.assert_allclose(normals[0, 0], normals[1, 1])
        self.assertGreater(np.linalg.norm(normals[0, 0] - normals[0, 2]), .05)
        split = trimesh.Trimesh(np.asarray(points)[mesh.faces].reshape(-1, 3), [[0, 1, 2], [3, 4, 5]], process=False)
        split_normals, _ = shading_normals(split)
        self.assertGreater(np.linalg.norm(split_normals[0, 0] - split_normals[1, 1]), .1)

    def test_supplied_corner_normals_win_and_buffers_are_unchanged(self):
        mesh = trimesh.creation.icosphere(subdivisions=1)
        supplied = np.tile([0., 0., 2.], (len(mesh.faces), 3, 1))
        mesh.face_attributes['corner_normals'] = supplied
        normals, receipt = shading_normals(mesh, vertex_normals=np.zeros_like(mesh.vertices))
        np.testing.assert_allclose(normals, supplied / 2)
        self.assertEqual(receipt['source'], 'supplied corner normals')
        camera = camera_for_bounds(mesh.bounds, 100, 100)
        flat, depth, owner = rasterize(mesh, camera, return_buffers=True)
        smooth, depth_s, owner_s = rasterize(mesh, camera, smooth=True, return_buffers=True)
        np.testing.assert_array_equal(depth, depth_s)
        np.testing.assert_array_equal(owner, owner_s)
        self.assertGreater(np.count_nonzero(np.asarray(flat) != np.asarray(smooth)), 10)
        np.testing.assert_array_equal(supplied, mesh.face_attributes['corner_normals'])

    def test_stored_vertex_normals_and_invalid_supplied_normals(self):
        mesh = trimesh.creation.box()
        mesh.vertex_normals = np.tile([0., 0., 1.], (len(mesh.vertices), 1))
        normals, receipt = shading_normals(mesh)
        np.testing.assert_allclose(normals, np.tile([0., 0., 1.], (len(mesh.faces), 3, 1)))
        self.assertIn('authorship unverified', receipt['source'])
        with self.assertRaises(ValueError):
            shading_normals(mesh, corner_normals=np.zeros((1, 3)))

    def test_shared_projection_retains_size_translation_and_camera(self):
        bounds = [[-1, -2, -3], [1, 2, 3]]
        front = camera_for_bounds(bounds, 200, 240, 'front')
        side = camera_for_bounds(bounds, 200, 240, 'side')
        self.assertEqual(front['scale'], side['scale'])
        self.assertEqual(front['center'], side['center'])
        original = np.array([[-.5, 0, 0], [.5, 0, 0]])
        projected = project_vertices(original, front)
        small = project_vertices(original * .5, front)
        moved = project_vertices(original + [1, 0, 0], front)
        self.assertAlmostEqual(np.ptp(small[:, 0]), np.ptp(projected[:, 0]) / 2)
        np.testing.assert_allclose(moved[:, 0] - projected[:, 0], front['scale'])
        np.testing.assert_allclose(project_vertices([[0, 0, -1]], side)[0, 0], 100 + side['scale'])

    def test_barycentric_depth_resolves_intersecting_triangles(self):
        # Same screen triangles: sloped triangle crosses a flat triangle.
        # Painter ordering cannot correctly resolve both halves at once.
        points = [[-.8, -.8, -.5], [.8, -.8, .5], [0, .8, 0],
                  [-.8, -.8, 0], [.8, -.8, 0], [0, .8, 0]]
        mesh = trimesh.Trimesh(points, [[0, 1, 2], [3, 4, 5]], process=False)
        camera = camera_for_bounds([[-1, -1, -1], [1, 1, 1]], 100, 100)
        _, depth, owner = rasterize(mesh, camera, return_buffers=True)
        self.assertEqual(owner[65, 32], 1)
        self.assertEqual(owner[65, 68], 0)
        self.assertGreater(depth[65, 68], depth[65, 32])
        reverse = trimesh.Trimesh(points, [[3, 4, 5], [0, 1, 2]], process=False)
        image_a = np.asarray(rasterize(mesh, camera))
        image_b = np.asarray(rasterize(reverse, camera))
        # Exact coplanar intersection pixels may choose either face; depths agree.
        _, depth_b, _ = rasterize(reverse, camera, return_buffers=True)
        np.testing.assert_allclose(depth, depth_b)
        self.assertLess(np.count_nonzero(np.any(image_a != image_b, axis=2)), 100)

    def test_report_missing_stages_are_explicit_and_artifacts_separate(self):
        high = trimesh.creation.box(extents=[1, 2, 3])
        shifted = high.copy()
        shifted.apply_translation([5, 0, 0])
        original = high.vertices.copy()
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'comparison.png'
            receipt = render_report(high, [
                {'name': '原始AI', 'mesh': shifted, 'status': 'diagnostic', 'metrics': {'误差': .12}},
                {'name': '修复', 'mesh': None, 'status': 'blocked', 'metrics': {'原因': '没有真实结果'}},
            ], out, tile_width=160, render_height=160)
            self.assertTrue(out.is_file())
            self.assertNotEqual(receipt['png'], receipt['auditJpeg'])
            with Image.open(out) as official:
                self.assertEqual(official.format, 'PNG')
            with Image.open(receipt['auditJpeg']) as audit:
                self.assertEqual(audit.format, 'JPEG')
                self.assertLessEqual(audit.width, 1280)
                self.assertLessEqual(audit.height, 900)
            self.assertFalse(receipt['columns'][2]['rendered'])
            self.assertEqual(receipt['columns'][2]['status'], 'blocked')
            self.assertNotIn('triangles', receipt['columns'][2])
            self.assertIn('front', receipt['columns'][1]['clippedViews'])
            self.assertEqual(receipt['columns'][0]['triangles'], 12)
            self.assertEqual(receipt['columns'][0]['shading']['creaseAngleDegrees'], 45)
            self.assertFalse(receipt['materialValidation'])
            self.assertEqual(receipt['cameras']['front']['center'], receipt['cameras']['side']['center'])
        np.testing.assert_array_equal(original, high.vertices)

    def test_proxy_is_labelled_with_original_triangle_count(self):
        high = trimesh.creation.icosphere(subdivisions=6)
        original_count = len(high.faces)
        with tempfile.TemporaryDirectory() as directory:
            receipt = render_report(high, [], Path(directory) / 'proxy.png', tile_width=160, render_height=160)
            reference = receipt['columns'][0]
            self.assertTrue(reference['displayProxy'])
            self.assertEqual(reference['triangles'], original_count)
            self.assertLessEqual(reference['displayTriangles'], 20_000)
            self.assertEqual(len(high.faces), original_count)


if __name__ == '__main__':
    unittest.main()
