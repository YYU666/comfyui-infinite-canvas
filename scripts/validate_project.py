from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "project.schema.json"


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_project(document: dict) -> list[str]:
    validator = Draft202012Validator(load_schema(), format_checker=FormatChecker())
    errors = [f"{'/'.join(map(str, error.path)) or '<root>'}: {error.message}" for error in validator.iter_errors(document)]
    if errors:
        return sorted(errors)

    for collection in ("characters", "outfits", "locations", "shots", "assets"):
        key = "path" if collection == "assets" else "id"
        values = [item[key] for item in document[collection]]
        if len(values) != len(set(values)):
            errors.append(f"{collection}: {key} 必须唯一")
    takes = [take["id"] for shot in document["shots"] for take in shot["takes"]]
    if len(takes) != len(set(takes)):
        errors.append("shots/takes: id 必须全项目唯一")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description="校验 H3 工作台 project.json（schema v3）")
    parser.add_argument("project", type=Path)
    args = parser.parse_args()
    try:
        document = json.loads(args.project.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"读取项目失败：{exc}", file=sys.stderr)
        return 2
    errors = validate_project(document)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"校验通过：{args.project}（schema v3）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
