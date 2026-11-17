"""Offline publication contract checks; never import the application runtime."""
from __future__ import annotations

import copy
import json
from pathlib import Path, PurePosixPath
import re
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
COMMIT = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
MACHINE_PATH = re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]|file://|\\\\[^\\\s]+\\")
ALLOWED = {".safetensors", ".gguf"}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def public_url(value):
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and bool(parsed.hostname), "HTTPS source required")
    require(not parsed.username and not parsed.password, "URL credentials forbidden")
    require(parsed.hostname not in {"localhost", "127.0.0.1", "0.0.0.0", "::1"},
            "Local service source forbidden")


def relative_file(value):
    require(isinstance(value, str) and bool(value), "Filename required")
    path = PurePosixPath(value)
    require(not path.is_absolute() and ".." not in path.parts, "Relative filename required")
    require("\\" not in value and not MACHINE_PATH.search(value), "Machine path forbidden")
    require(path.suffix.lower() in ALLOWED, "Unsupported model extension")


def validate_models(document):
    require(document["allowedExtensions"] == [".safetensors", ".gguf"], "Format policy changed")
    seen = set()
    for entry in document["models"]:
        relative_file(entry["path"])
        relative_file(entry["filename"])
        require(entry["path"] not in seen, "Duplicate model path")
        seen.add(entry["path"])
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", entry["repository"]),
                "Repository identifier required")
        require(COMMIT.fullmatch(entry["revision"]), "Fixed revision required")
        require(SHA256.fullmatch(entry["sha256"]), "Exact SHA256 required")
        require(type(entry["bytes"]) is int and entry["bytes"] > 0, "Positive byte size required")
        require(bool(entry["license"]["name"].strip()), "License name required")
        public_url(entry["license"]["url"])
        public_url(entry["source"]["modelCard"])
        public_url(entry["source"]["fileMetadata"])
        require(entry["revision"] in entry["source"]["modelCard"], "Pinned model card required")
        require(entry["revision"] in entry["source"]["fileMetadata"], "Pinned file metadata required")
    return seen


def validate_workflows(document, model_paths):
    require(COMMIT.fullmatch(document["baselineCommit"]), "Baseline commit required")
    seen = set()
    for entry in document["workflows"]:
        require(entry["id"] not in seen, "Duplicate workflow id")
        seen.add(entry["id"])
        require(entry["officialMenuEligible"] is False, "Documentation cannot enable menu entries")
        require(entry["interface"]["inputs"] and entry["interface"]["outputs"], "Interface required")
        require(set(entry["modelRefs"]) <= model_paths, "Unknown model reference")
        for source in entry["sources"]:
            public_url(source["url"])
            if "sourceCommit" in source:
                require(source["sourceCommit"] is None or COMMIT.fullmatch(source["sourceCommit"]),
                        "Unknown source commit must remain null")
            if "sha256" in source:
                require(SHA256.fullmatch(source["sha256"]), "Source artifact SHA256 required")
                require(type(source["bytes"]) is int and source["bytes"] > 0,
                        "Source artifact byte size required")


class CatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = json.loads((ROOT / "models.lock.json").read_text(encoding="utf-8"))
        cls.workflows = json.loads((ROOT / "workflows.json").read_text(encoding="utf-8"))
        cls.unresolved = json.loads((ROOT / "unresolved.json").read_text(encoding="utf-8"))

    def test_catalog_and_references(self):
        validate_workflows(self.workflows, validate_models(self.models))

    def test_invalid_model_metadata_is_rejected(self):
        for field, value in [("filename", "helper.onnx"), ("revision", "main"),
                             ("sha256", "unknown"), ("bytes", 0), ("bytes", True),
                             ("path", "../outside.safetensors")]:
            with self.subTest(field=field, value=value):
                changed = copy.deepcopy(self.models)
                changed["models"][0][field] = value
                with self.assertRaises(ValueError):
                    validate_models(changed)

    def test_unlicensed_entry_and_broken_reference_are_rejected(self):
        changed = copy.deepcopy(self.models)
        changed["models"][0]["license"]["name"] = ""
        with self.assertRaises(ValueError):
            validate_models(changed)
        changed = copy.deepcopy(self.workflows)
        changed["workflows"][0]["modelRefs"] = ["missing/model.safetensors"]
        with self.assertRaises(ValueError):
            validate_workflows(changed, validate_models(self.models))

    def test_license_and_format_blockers_remain_explicit(self):
        entries = {entry["id"]: entry for entry in self.workflows["workflows"]}
        self.assertEqual(entries["character-sheet-generic"]["interface"]["outputs"],
                         ["Front portrait cropped above the chest",
                          "Three-quarter portrait cropped above the chest",
                          "Headless front body panel", "Headless back body panel"])
        self.assertEqual(entries["krea-moss-two-pass"]["publicationStatus"],
                         "blocked-upstream-workflow-license")
        self.assertEqual(entries["moss-pose"]["publicationStatus"], "blocked-model-format-policy")
        self.assertEqual(len(self.unresolved["unresolvedAuthorDependencies"]), 9)
        catalog_names = {entry["filename"].split("/")[-1] for entry in self.models["models"]}
        for entry in self.unresolved["unresolvedAuthorDependencies"]:
            self.assertNotIn(entry["filename"], catalog_names)
            self.assertNotIn("sha256", entry)
        self.assertEqual({entry["filename"] for entry in self.unresolved["excludedAuxiliaries"]},
                         {"dw-ll_ucoco_384.onnx", "yolox_l.onnx"})

    def test_public_artifacts_have_no_machine_paths_or_media(self):
        for filename in ["README.md", "models.lock.json", "workflows.json", "unresolved.json"]:
            with self.subTest(filename=filename):
                self.assertIsNone(MACHINE_PATH.search((ROOT / filename).read_text(encoding="utf-8")))
        self.assertFalse(list(ROOT.glob("*.h3pack")))
        for path in ROOT.iterdir():
            self.assertNotIn(path.suffix.lower(), {".png", ".jpg", ".jpeg", ".mp4", ".safetensors", ".gguf"})


if __name__ == "__main__":
    unittest.main()
