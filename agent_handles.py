from __future__ import annotations


NODE_PREFIXES = {"generator": "g", "media": "m", "prompt": "p", "note": "n"}


def ensure_agent_handles(document):
    """Assign stable short handles without reusing handles from deleted nodes."""
    nodes = document.get("canvas", {}).get("nodes", [])
    if not nodes:
        return False
    settings = document.setdefault("settings", {})
    handles = settings.setdefault("agentHandles", {})
    counters = settings.setdefault("agentCounters", {})
    changed = False
    for node in nodes:
        node_id = str(node.get("id") or "")
        if not node_id or handles.get(node_id):
            continue
        prefix = NODE_PREFIXES.get(node.get("type"), "n")
        number = max(1, int(counters.get(prefix, 1)))
        used = set(handles.values())
        while f"{prefix}{number}" in used:
            number += 1
        handles[node_id] = f"{prefix}{number}"
        counters[prefix] = number + 1
        changed = True
    return changed


def handle_for(document, node_id):
    return document.get("settings", {}).get("agentHandles", {}).get(str(node_id), str(node_id))


def resolve_node(document, reference):
    reference = str(reference or "")
    nodes = document.get("canvas", {}).get("nodes", [])
    for node in nodes:
        if str(node.get("id")) == reference or handle_for(document, node.get("id")) == reference:
            return node
    title = reference[1:] if reference.startswith("@") else None
    if title:
        matches = [node for node in nodes if node.get("data", {}).get("title") == title]
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise ValueError(f"标题不唯一：{title}")
    raise ValueError(f"找不到画布节点：{reference}")
