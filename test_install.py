from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install

ROOT = Path(__file__).resolve().parent


class InstallTests(unittest.TestCase):
    def test_missing_portable_python_never_falls_back_or_writes(self):
        self.assertEqual(install.portable_python(Path("E:/missing")), Path("E:/missing/python_embeded/python.exe"))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            comfy = root / "ComfyUI"
            comfy.mkdir()
            (comfy / "main.py").write_text("# fixture", encoding="utf-8")
            before = sorted(path.relative_to(root) for path in root.rglob("*"))
            result = subprocess.run(
                [sys.executable, str(ROOT / "install.py"), "--comfy-root", str(root)],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=20,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("不会回退系统 Python", result.stderr)
            self.assertEqual(sorted(path.relative_to(root) for path in root.rglob("*")), before)
        batch = (ROOT / "install.bat").read_text(encoding="utf-8")
        self.assertNotIn('set "PYTHON=py"', batch)
        self.assertNotIn("PYTHON_ARGS", batch)

    def test_python_install_uses_hash_locked_requirements(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "ComfyUI").mkdir()
            (root / "ComfyUI" / "main.py").write_text("# fixture", encoding="utf-8")
            (root / "python_embeded").mkdir()
            python = root / "python_embeded" / "python.exe"
            python.write_bytes(b"fixture")
            commands = []
            with mock.patch.object(install, "run", side_effect=lambda command, cwd=None: commands.append(command)), \
                 mock.patch.object(sys, "argv", ["install.py", "--comfy-root", str(root), "--skip-nodes", "--skip-frontend"]):
                self.assertEqual(install.main(), 0)
            self.assertEqual(commands[0][:3], [str(python), "-m", "pip"])
            self.assertIn("--require-hashes", commands[0])
            self.assertEqual(Path(commands[0][-1]).name, "requirements.lock")

    def test_models_source_defaults_to_core_and_explicit_full_is_forwarded(self):
        for extra, expected in (([], "core-h3"), (["--profile", "full"], "full")):
            with self.subTest(profile=expected), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "ComfyUI").mkdir()
                (root / "ComfyUI" / "main.py").write_text("# fixture", encoding="utf-8")
                (root / "python_embeded").mkdir()
                python = root / "python_embeded" / "python.exe"
                python.write_bytes(b"fixture")
                commands = []
                argv = ["install.py", "--comfy-root", str(root), "--models-source", str(root / "models"),
                        "--skip-python", "--skip-nodes", "--skip-frontend", *extra]
                with mock.patch.object(install, "run", side_effect=lambda command, cwd=None: commands.append(command)), \
                     mock.patch.object(sys, "argv", argv):
                    self.assertEqual(install.main(), 0)
                self.assertEqual(len(commands), 1)
                command = commands[0]
                self.assertEqual(Path(command[1]).name, "install_models.py")
                self.assertEqual(command[command.index("--profile") + 1], expected)

    def test_lock_covers_every_pin_with_sha256(self):
        pins = [line.strip() for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.startswith("#")]
        lock = (ROOT / "requirements.lock").read_text(encoding="utf-8")
        self.assertIn("--require-hashes", lock)
        for pin in pins:
            self.assertIn(f"{pin} \\", lock)
        hashes = re.findall(r"--hash=sha256:([0-9a-f]{64})", lock)
        self.assertGreater(len(hashes), len(pins))
        self.assertEqual(len(hashes), len(set(hashes)), "同一哈希可能对应多个文件名，但不应有无意义重复行")

    def test_third_party_repositories_are_commit_pinned(self):
        self.assertEqual(len(install.NODE_PACKAGES), 6)
        for repository, commit in install.NODE_PACKAGES.values():
            self.assertTrue(repository.startswith("https://github.com/"))
            self.assertRegex(commit, r"^[0-9a-f]{40}$")

    def test_existing_conflicting_node_is_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            comfy = Path(temporary)
            custom = comfy / "custom_nodes"
            target = custom / "h3-relay"
            target.mkdir(parents=True)
            (target / ".git").mkdir()
            sentinel = target / "keep.txt"
            sentinel.write_text("do-not-overwrite", encoding="utf-8")
            own = custom / "h3_workbench_refine"
            with mock.patch.object(install, "git_head", return_value="0" * 40):
                with self.assertRaisesRegex(RuntimeError, "已保留原目录"):
                    install.install_nodes(comfy, Path("unused-python.exe"))
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "do-not-overwrite")
            self.assertTrue(own.exists(), "专用节点在冲突检查前同步，冲突节点本身不被修改")


if __name__ == "__main__":
    unittest.main()
