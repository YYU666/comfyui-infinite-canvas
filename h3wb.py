from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from project_store import ProjectStore, StoreError, _migrate, _safe_project_file
from agent_io import configure_utf8


def main():
    parser = argparse.ArgumentParser(prog="h3wb", description="H3 视频工作台本地项目工具")
    parser.add_argument("--root", help="项目根目录，默认读取 H3_PROJECTS_ROOT 或 Documents/H3 Workbench")
    commands = parser.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="列出项目")
    listing.add_argument("--json", action="store_true")
    create = commands.add_parser("new", help="新建项目")
    create.add_argument("name")
    create.add_argument("--template", default="blank")
    create.add_argument("--dir")
    validate = commands.add_parser("validate", help="校验 project.json")
    validate.add_argument("directory")
    args = parser.parse_args()
    store = ProjectStore(args.root)
    try:
        if args.command == "list":
            rows = store.list()
            if args.json:
                print(json.dumps(rows, ensure_ascii=False, indent=2))
            else:
                for row in rows:
                    print(f"{row.get('id') or '-'}\t{row['name']}\t{row['path']}")
            return 0
        if args.command == "new":
            document = store.create(args.name, template=args.template, directory=args.dir)
            print(json.dumps({"ok": True, "id": document["id"], "path": str(Path(args.dir).resolve()) if args.dir else str(store.root / document['name'])}, ensure_ascii=False))
            return 0
        path, document = _safe_project_file(Path(args.directory).resolve() / "project.json")
        migrated, changed = _migrate(document)
        print(json.dumps({"ok": True, "schemaVersion": migrated["schemaVersion"], "migrationRequired": changed, "path": str(path)}, ensure_ascii=False))
        return 0
    except StoreError as error:
        print(json.dumps({"ok": False, "code": error.code, "message": error.message, "details": error.details}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    configure_utf8()
    raise SystemExit(main())
