from __future__ import annotations

import copy
import re

from project_store import StoreError
from workbench_lifecycle import utc_now

COLLECTIONS = {
    "characters": ("c", "角色"),
    "outfits": ("o", "服装"),
    "locations": ("l", "场景"),
    "shots": ("s", "镜头"),
}
DEFAULTS = {
    "characters": {"refs": [], "sheet": None, "defaultOutfitId": None, "voice": None, "notes": ""},
    "outfits": {"refs": [], "prompt": "", "lora": None},
    "locations": {"refs": [], "prompt": "", "notes": ""},
    "shots": {"prompt": "", "characterId": None, "outfitId": None, "locationId": None,
              "takes": [], "status": "draft", "tags": [], "canvasNodeId": None},
}
FIELDS = {
    "characters": {"name", "refs", "sheet", "defaultOutfitId", "voice", "notes"},
    "outfits": {"name", "refs", "prompt", "lora"},
    "locations": {"name", "refs", "prompt", "notes"},
    "shots": {"number", "name", "prompt", "characterId", "outfitId", "locationId", "params", "status", "tags", "canvasNodeId"},
    "takes": {"asset", "poster", "recipe", "rating", "selected", "rejected", "notes", "tags"},
}


def _name(value, label):
    value = str(value or "").strip()
    if not value or len(value) > 120:
        raise StoreError("BAD_REQUEST", f"{label}名称必须为 1–120 个字符。")
    return value


def _tags(value):
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() or len(item.strip()) > 60 for item in value):
        raise StoreError("BAD_REQUEST", "标签必须是由 1–60 个字符组成的字符串数组。")
    return list(dict.fromkeys(item.strip() for item in value))


def _entity(document, collection, entity_id):
    for item in document[collection]:
        if item["id"] == entity_id:
            return item
    raise StoreError("NOT_FOUND", "指定的创作对象不存在。", 404)


def _shot_and_take(document, shot_id, take_id):
    shot = _entity(document, "shots", shot_id)
    take = next((item for item in shot["takes"] if item["id"] == take_id), None)
    if take is None:
        raise StoreError("NOT_FOUND", "指定的 Take 不存在。", 404)
    return shot, take


class ProjectDomain:
    """项目内创作对象。所有修改复用 ProjectStore 的锁、备份、校验和 CAS。"""

    def __init__(self, store):
        self.store = store

    def _update(self, project_id, revision, mutate):
        path = self.store._project_path(project_id)
        self.store.acquire_lock(path)
        with self.store._guard(path):
            document = self.store._read(path)
            item = mutate(document)
            saved = self.store._write(path, document, int(revision))
            return {"project": saved, "item": item}

    @staticmethod
    def _next_id(document, collection):
        prefix = COLLECTIONS[collection][0] if collection in COLLECTIONS else "t"
        key = f"{prefix}Next"
        counters = document["settings"].setdefault("domainCounters", {})
        items = document[collection] if collection in COLLECTIONS else [take for shot in document["shots"] for take in shot["takes"]]
        largest = max([int(item["id"][1:]) for item in items] or [0])
        number = max(int(counters.get(key, 1)), largest + 1)
        counters[key] = number + 1
        return f"{prefix}{number}"

    @staticmethod
    def _check_refs(document, item):
        known = {asset["path"] for asset in document["assets"]}
        external = item.get("recipe", {}).get("output")
        refs = [*item.get("refs", []), item.get("sheet"), item.get("asset"), item.get("poster")]
        missing = [ref for ref in refs if ref and ref not in known and not (external and ref in (item.get("asset"), item.get("poster")))]
        if missing:
            raise StoreError("ASSET_NOT_FOUND", "引用的素材尚未导入当前项目。", 400, {"assets": missing})

    def _validate_links(self, document, item):
        for field, collection in (("defaultOutfitId", "outfits"), ("characterId", "characters"),
                                  ("outfitId", "outfits"), ("locationId", "locations")):
            if field in item and item[field] is not None:
                _entity(document, collection, item[field])
        if "canvasNodeId" in item and item["canvasNodeId"] is not None:
            if not any(str(node.get("id")) == item["canvasNodeId"] for node in document["canvas"]["nodes"]):
                raise StoreError("BAD_REQUEST", "镜头绑定的画布节点不存在。")
        self._check_refs(document, item)

    def create(self, project_id, collection, payload, revision):
        if collection not in COLLECTIONS:
            raise StoreError("NOT_FOUND", "创作对象类型不存在。", 404)
        data = {key: copy.deepcopy(value) for key, value in payload.items() if key in FIELDS[collection]}

        def mutate(document):
            item = {**copy.deepcopy(DEFAULTS[collection]), **data, "id": self._next_id(document, collection)}
            item["name"] = _name(item.get("name"), COLLECTIONS[collection][1])
            if collection == "shots":
                item.setdefault("number", f"S{int(item['id'][1:]):02d}")
                settings = document["settings"]
                item.setdefault("params", {"ratio": settings["ratio"], "resolution": settings["resolution"],
                                           "duration": settings["duration"], "seed": 0, "turbo": False})
                item["tags"] = _tags(item["tags"])
            self._validate_links(document, item)
            document[collection].append(item)
            return item

        return self._update(project_id, revision, mutate)

    def update(self, project_id, collection, entity_id, payload, revision):
        if collection not in COLLECTIONS:
            raise StoreError("NOT_FOUND", "创作对象类型不存在。", 404)
        data = {key: copy.deepcopy(value) for key, value in payload.items() if key in FIELDS[collection]}

        def mutate(document):
            item = _entity(document, collection, entity_id)
            item.update(data)
            if "name" in data:
                item["name"] = _name(item["name"], COLLECTIONS[collection][1])
            if collection == "shots" and "tags" in data:
                item["tags"] = _tags(item["tags"])
            self._validate_links(document, item)
            return item

        return self._update(project_id, revision, mutate)

    def delete(self, project_id, collection, entity_id, revision):
        if collection not in COLLECTIONS:
            raise StoreError("NOT_FOUND", "创作对象类型不存在。", 404)

        def mutate(document):
            item = _entity(document, collection, entity_id)
            reference_fields = {"characters": "characterId", "outfits": "outfitId", "locations": "locationId"}
            if collection in reference_fields and any(shot.get(reference_fields[collection]) == entity_id for shot in document["shots"]):
                raise StoreError("ENTITY_IN_USE", "该对象仍被镜头引用，请先调整相关镜头。", 409)
            if collection == "outfits" and any(character.get("defaultOutfitId") == entity_id for character in document["characters"]):
                raise StoreError("ENTITY_IN_USE", "该服装仍是角色的默认服装，请先调整角色卡。", 409)
            document[collection].remove(item)
            return item

        return self._update(project_id, revision, mutate)

    def create_take(self, project_id, shot_id, payload, revision):
        data = {key: copy.deepcopy(value) for key, value in payload.items() if key in FIELDS["takes"]}

        def mutate(document):
            shot = _entity(document, "shots", shot_id)
            take = {"id": self._next_id(document, "takes"), "asset": data.get("asset"),
                    "poster": data.get("poster"), "recipe": data.get("recipe", {}), "rating": 0,
                    "selected": False, "rejected": False, "notes": "", "tags": [],
                    "createdAt": utc_now()}
            for key in ("rating", "selected", "rejected", "notes", "tags"):
                if key in data:
                    take[key] = data[key]
            self._validate_take(document, shot, take)
            shot["takes"].append(take)
            if take["selected"]:
                for other in shot["takes"][:-1]:
                    other["selected"] = False
            return take

        return self._update(project_id, revision, mutate)

    def update_take(self, project_id, shot_id, take_id, payload, revision):
        data = {key: copy.deepcopy(value) for key, value in payload.items() if key in FIELDS["takes"]}

        def mutate(document):
            shot, take = _shot_and_take(document, shot_id, take_id)
            take.update(data)
            self._validate_take(document, shot, take)
            if take["selected"]:
                for other in shot["takes"]:
                    if other is not take:
                        other["selected"] = False
            return take

        return self._update(project_id, revision, mutate)

    def _validate_take(self, document, shot, take):
        if not take.get("asset"):
            raise StoreError("BAD_REQUEST", "Take 必须引用一个已导入的结果素材。")
        if not isinstance(take.get("rating"), int) or isinstance(take["rating"], bool) or not 0 <= take["rating"] <= 5:
            raise StoreError("BAD_REQUEST", "Take 评级必须为 0–5 的整数。")
        if not isinstance(take.get("recipe"), dict):
            raise StoreError("BAD_REQUEST", "Take recipe 必须是对象。")
        if not isinstance(take.get("notes"), str):
            raise StoreError("BAD_REQUEST", "Take 备注必须是字符串。")
        if take.get("selected") and take.get("rejected"):
            raise StoreError("BAD_REQUEST", "同一条 Take 不能同时选用和淘汰。")
        take["tags"] = _tags(take.get("tags", []))
        self._check_refs(document, take)

    def delete_take(self, project_id, shot_id, take_id, revision):
        def mutate(document):
            shot, take = _shot_and_take(document, shot_id, take_id)
            shot["takes"].remove(take)
            return take

        return self._update(project_id, revision, mutate)

    def metadata(self, project_id, payload, revision):
        def mutate(document):
            if "tags" in payload:
                document["tags"] = _tags(payload["tags"])
            if "favorite" in payload:
                if not isinstance(payload["favorite"], bool):
                    raise StoreError("BAD_REQUEST", "favorite 必须是布尔值。")
                document["favorite"] = payload["favorite"]
            return {"tags": document.get("tags", []), "favorite": document.get("favorite", False)}

        return self._update(project_id, revision, mutate)

    @staticmethod
    def search(document, query, kind=None, limit=50):
        query = str(query or "").strip().casefold()
        if not query:
            return []
        limit = max(1, min(int(limit), 200))
        rows = []

        def add(hit_kind, item, text, title, shot_id=None):
            haystack = " ".join(str(value) for value in text if value is not None).casefold()
            if query in haystack and (not kind or kind == hit_kind):
                rows.append({"kind": hit_kind, "id": item["id"], "shotId": shot_id,
                             "title": title, "excerpt": next((str(value) for value in text if value and query in str(value).casefold()), "")})

        add("project", document, [document["name"], *document.get("tags", [])], document["name"])
        for collection in ("characters", "outfits", "locations"):
            for item in document[collection]:
                add(collection[:-1], item, [item["name"], item.get("notes"), item.get("prompt")], item["name"])
        for shot in document["shots"]:
            add("shot", shot, [shot["number"], shot["name"], shot["prompt"], *shot["tags"]], f"{shot['number']} · {shot['name']}")
            for take in shot["takes"]:
                add("take", take, [take["id"], take.get("notes"), *take.get("tags", [])], f"{shot['number']} · {take['id']}", shot["id"])
        return rows[:limit]
