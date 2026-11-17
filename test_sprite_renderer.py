import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("blender_sprite_atlas", ROOT / "scripts" / "blender_sprite_atlas.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class SpriteRendererTests(unittest.TestCase):
    def request(self, **values):
        return {"inputPath": str(ROOT / "synthetic.glb"), "outputDir": str(ROOT / ".cache" / "sprite-test"), **values}

    def test_defaults_and_dimensions(self):
        request = renderer.validate_request(self.request())
        self.assertEqual(request["frameSize"], 192)
        self.assertEqual(renderer.atlas_dimensions(request, 1), (1536, 1536))

    def test_invalid_numbers_actions_and_extension(self):
        for options in ({"directions": 5}, {"frameSize": True}, {"frameSize": 2048}, {"framesPerAction": 0}, {"padding": float("nan")}, {"elevation": -1}, {"pivot": [0, .9]}, {"actions": ["Idle", "Idle"]}, {"inputPath": "bad.blend"}, {"inputPath": "relative.glb"}, {"inputPath": "https://example.org/model.glb"}, {"outputDir": "//server/share"}, {"actions": ["a" * 201]}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                renderer.validate_request(self.request(**options))

    def test_resource_limits_before_render(self):
        request = renderer.validate_request(self.request(frameSize=1024, directions=16, framesPerAction=64))
        with self.assertRaises(ValueError):
            renderer.atlas_dimensions(request, 1)
        with self.assertRaises(ValueError):
            renderer.atlas_dimensions(renderer.validate_request(self.request()), 9)

    def test_rgba_png_roundtrip_preserves_raw_normals(self):
        pixels = bytes([0, 128, 255, 255, 128, 255, 128, 0] * 3)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.png"
            renderer.write_rgba_png(path, 2, 3, pixels)
            width, height, actual = renderer.read_rgba_png(path)
            self.assertEqual((width, height, bytes(actual)), (2, 3, pixels))

    def test_paste_uses_top_left_rectangles(self):
        atlas = bytearray(4 * 4 * 4)
        tile = bytes([17, 33, 99, 255] * 4)
        renderer._paste(atlas, 4, tile, 2, 2, 2)
        self.assertEqual(atlas[(2 * 4 + 2) * 4:(2 * 4 + 4) * 4], tile[:8])
        self.assertEqual(atlas[:(2 * 4 + 2) * 4], bytes((2 * 4 + 2) * 4))


@unittest.skipUnless(os.environ.get("H3_SPRITE_BLENDER"), "Set H3_SPRITE_BLENDER to opt into CPU-only Blender integration.")
class SpriteRendererBlenderTests(unittest.TestCase):
    def test_real_animated_glb_and_fbx(self):
        blender = os.environ["H3_SPRITE_BLENDER"]
        directory = Path(os.environ.get("H3_SPRITE_SAMPLE_DIR", tempfile.mkdtemp(prefix="h3-sprite-samples-"))).resolve()
        directory.mkdir(parents=True, exist_ok=True)
        # Every test run owns a fresh directory; repeating the test must never
        # overwrite a previous sample or be mistaken for a cached success.
        directory = Path(tempfile.mkdtemp(prefix="run-", dir=directory))
        command = [blender, "--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1"]
        generated = subprocess.run([*command, "--python", str(ROOT / "scripts/make_sprite_fixture.py"), "--", "--output-dir", str(directory / "fixture")], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        (directory / "fixture.log").write_text(generated.stdout + generated.stderr, encoding="utf-8")
        self.assertEqual(generated.returncode, 0, generated.stderr[-2000:])
        from PIL import Image
        for extension in ("glb", "fbx"):
            request = {"inputPath": str(directory / "fixture" / f"synthetic-character.{extension}"), "outputDir": str(directory / f"{extension}-8dir"), "directions": 8, "frameSize": 192, "framesPerAction": 4, "actions": []}
            request_path = directory / f"{extension}-request.json"
            request_path.write_text(json.dumps(request), encoding="utf-8")
            completed = subprocess.run([*command, "--python", str(ROOT / "scripts/blender_sprite_atlas.py"), "--", "--request", str(request_path)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=1200)
            (directory / f"{extension}-render.log").write_text(completed.stdout + completed.stderr, encoding="utf-8")
            self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])
            self.assertIn("SPRITE_ATLAS_RESULT=", completed.stdout)
            output = Path(request["outputDir"])
            metadata = json.loads((output / "atlas.json").read_text(encoding="utf-8"))
            color, normal = Image.open(output / "albedo.png"), Image.open(output / "normal.png")
            color.load()
            normal.load()
            self.assertEqual(color.mode, "RGBA")
            self.assertEqual(normal.mode, "RGBA")
            self.assertEqual(color.size, normal.size)
            self.assertEqual(color.size, (metadata["size"]["width"], metadata["size"]["height"]))
            self.assertEqual(metadata["layout"]["columns"], 4)
            self.assertEqual(metadata["sourceFps"], 24 if extension == "glb" else 30)
            self.assertGreaterEqual(len(metadata["actions"]), 2)
            self.assertEqual(len(metadata["frames"]), len(metadata["actions"]) * 8 * 4)
            for clip in metadata["actions"]:
                self.assertAlmostEqual(clip["durationSeconds"], 24 / metadata["sourceFps"])
                self.assertAlmostEqual(clip["playbackFps"], 4 / clip["durationSeconds"])
            self.assertEqual(metadata["frames"][0]["clipTimeSeconds"], 0)
            self.assertEqual(color.getchannel("A").tobytes(), normal.getchannel("A").tobytes(), "Paired atlases must have exactly matching coverage.")
            self.assertEqual(color.getpixel((0, 0))[3], 0)
            # Explicitly prove imported skin animation changes the Wave frame,
            # while one fixed camera/framing rectangle remains valid for all.
            wave = next((index for index, action in enumerate(metadata["actions"]) if "Wave" in action["name"]), None)
            self.assertIsNotNone(wave)
            y = wave * 8 * 192
            self.assertNotEqual(color.crop((0, y, 192, y + 192)).tobytes(), color.crop((192, y, 384, y + 192)).tobytes())
            self.assertNotEqual(color.crop((0, 0, 192, 192)).tobytes(), color.crop((0, 192, 192, 384)).tobytes())
            # Front faces point toward the camera: raw encoded blue near255,
            # red/green near128, never sRGB-gamma encoded ~188.
            normals = [rgb for rgb in normal.crop((0, 0, 192, 192)).getdata() if rgb[3] == 255]
            self.assertTrue(any(abs(r - 128) <= 3 and abs(g - 105) <= 5 and b >= 248 for r, g, b, a in normals), "Expected camera-space front normal with 10deg camera elevation.")
            self.assertTrue(any(abs(r - 128) <= 3 and g >= 248 and abs(b - 150) <= 5 for r, g, b, a in normals), "World up must encode camera +Y, with elevation projected into +Z.")
            diagonal = [rgb for rgb in normal.crop((0, 192, 192, 384)).getdata() if rgb[3] == 255]
            self.assertTrue(any(34 <= r <= 41 and 106 <= g <= 116 and 212 <= b <= 222 for r, g, b, a in diagonal), "Diagonal front-face normal must point toward camera -X.")
            self.assertTrue(any(214 <= r <= 222 and 106 <= g <= 116 and 212 <= b <= 222 for r, g, b, a in diagonal), "Diagonal side-face normal must point toward camera +X.")
            # Texture is red; opaque red pixels prove albedo texture was used.
            colors = list(color.crop((0, 0, 192, 192)).getdata())
            self.assertTrue(any(r > 240 and 15 < g < 125 and b < 100 and a == 255 for r, g, b, a in colors))
            self.assertFalse(any(g > 220 and r < 100 and b < 100 and a == 255 for r, g, b, a in colors), "Green texels have alpha0 and must not render as opaque geometry.")
            for frame in metadata["frames"]:
                rect = frame["rect"]
                alpha = color.getchannel("A").crop((rect["x"], rect["y"], rect["x"] + 192, rect["y"] + 192))
                bbox = alpha.getbbox()
                self.assertIsNotNone(bbox)
                self.assertGreater(bbox[0], 0)
                self.assertGreater(bbox[1], 0)
                self.assertLess(bbox[2], 192)
                self.assertLess(bbox[3], 192)


if __name__ == "__main__":
    unittest.main()
