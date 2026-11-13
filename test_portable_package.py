import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from scripts.assert_package_evidence import assert_packages
from scripts.build_portable_package import assert_portable_dist_path, build_portable
from scripts.build_runtime_package import (
    EMBED_BYTES,
    EMBED_SHA256,
    EMBED_URL,
    build_runtime,
    host_can_build,
    recipe,
    runtime_support,
)
from scripts.build_update_package import assert_public_path, build


ROOT = Path(__file__).resolve().parent


class PortablePackageTests(unittest.TestCase):
    def test_update_gate_still_rejects_dist_and_private_paths(self):
        for path in ("dist/index.html", "dist/assets/app.js", "node_modules/leftpad/index.js",
                     "runtime/instance.json", ".cache/local.bin", "secrets/api-keys.json"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                assert_public_path(path)

    def test_portable_dist_allows_built_files_and_rejects_everything_else(self):
        assert_portable_dist_path("dist/index.html")
        assert_portable_dist_path("dist/assets/index-abc.js")
        for path in ("index.html", "dist", "dist/../secret.txt", "node_modules/pkg/index.js",
                     "public/app.js", "dist/node_modules/pkg/index.js", "dist/.env", "dist/instance.json"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                assert_portable_dist_path(path)

    def test_built_packages_keep_update_and_portable_rules(self):
        version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
        tag = f"v{version}"
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            dist = output / "dist"
            (dist / "assets").mkdir(parents=True)
            (dist / "index.html").write_text("<!doctype html><title>fixture</title>", encoding="utf-8")
            (dist / "assets" / "app.js").write_text("console.log('fixture')", encoding="utf-8")
            (dist / "node_modules").mkdir()
            (dist / "node_modules" / "hidden.js").write_text("nope", encoding="utf-8")
            with self.assertRaises(RuntimeError):
                build_portable(tag, output / "rejected", dist)
            (dist / "node_modules").joinpath("hidden.js").unlink()
            (dist / "node_modules").rmdir()
            build(tag, output)
            build_portable(tag, output, dist)
            assert_packages(output)
            with zipfile.ZipFile(output / f"refmuse-portable-{tag}.zip") as portable:
                self.assertIn("dist/assets/app.js", portable.namelist())
                self.assertNotIn("dist/node_modules/hidden.js", portable.namelist())

    def test_runtime_recipe_is_windows_amd64_only_and_matches_the_doc(self):
        described = recipe()
        self.assertEqual(described["embed"]["url"], EMBED_URL)
        self.assertEqual(described["embed"]["bytes"], EMBED_BYTES)
        self.assertEqual(described["embed"]["sha256"], EMBED_SHA256)
        self.assertEqual(described["support"]["mac"], "detect-only")
        self.assertEqual(described["support"]["bundledRuntime"], "win-amd64")
        self.assertIn("requirements.lock", described["requirementsLock"])
        self.assertEqual(len(described["requirementsLockSha256"]), 64)
        document = (ROOT / "docs" / "OFFICIAL_ISOLATED_LAUNCH.md").read_text(encoding="utf-8")
        self.assertIn(EMBED_URL, document)
        self.assertIn(str(EMBED_BYTES), document)
        self.assertIn(EMBED_SHA256, document)
        self.assertIn("macOS", document)
        support = runtime_support()
        self.assertEqual(support["mac"], "detect-only")
        self.assertEqual(support["canBuildHere"], host_can_build())
        if not host_can_build():
            with self.assertRaisesRegex(RuntimeError, "Windows amd64"):
                build_runtime(Path(tempfile.gettempdir()) / "refmuse-runtime-should-not-build")
