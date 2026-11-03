"""Read and bind criterion test nodes. Each node binds one test name to one criterion."""
from pathlib import PurePosixPath
import re

from common import require

NODE_FIELDS = ["title", "parent", "status", "revision"]


def tone(status):
    """List reads give a tone string. Detail reads give {tone, label}."""
    return status.get("tone") if isinstance(status, dict) else status


def test_type(types):
    kinds = [kind for kind, definition in types.items() if definition.get("role") == "test"]
    require(len(kinds) == 1, "schema needs exactly one test type")
    return kinds[0]


def read_nodes(api, workspace, kind, parent, criteria=None):
    """Read every test node below parent. Return {criterion: [node]} sorted by title."""
    grouped = {address: [] for address in criteria or []}
    cursor, seen = None, set()
    while True:
        page = api.call("joppa_objects", {"workspace": workspace, "kind": kind, "parent": parent, "limit": 25,
                                          "fields": NODE_FIELDS, **({"cursor": cursor} if cursor else {})})
        require(isinstance(page.get("items"), list), "test node page is incomplete")
        for item in page["items"]:
            node = {"address": item.get("address"), "title": item.get("title"), "parent": item.get("parent"),
                    "revision": item.get("revision"), "status": tone(item.get("status"))}
            require(isinstance(node["address"], str) and isinstance(node["title"], str) and node["title"]
                    and isinstance(node["parent"], str) and type(node["revision"]) is int,
                    "test node read is incomplete")
            if criteria is None or node["parent"] in grouped:
                grouped.setdefault(node.pop("parent"), []).append(node)
        cursor = page.get("next_cursor")
        if not cursor:
            break
        require(cursor not in seen, "test node pagination did not advance")
        seen.add(cursor)
    for nodes in grouped.values():
        nodes.sort(key=lambda node: (node["title"], node["address"]))
        require(len({node["address"] for node in nodes}) == len(nodes), "test node pages overlap")
    return grouped


def identities(nodes):
    """Freshness view: a bound, renamed or replaced node changes the plan context."""
    return [{key: node[key] for key in ("address", "title", "revision")} for node in nodes]


def node_result(api, workspace, address, parent):
    """Read one node's recorded result. Return None when no result exists."""
    detail = api.call("joppa_objects", {"workspace": workspace, "address": address})
    require(detail.get("parent", detail.get("document", {}).get("parent")) == parent,
            "test evidence belongs to another criterion")
    result = detail.get("result")
    return result if isinstance(result, dict) and result.get("status") else None


def check_name(name, rules, definition):
    """Apply the configured test name rules and the test type title limit."""
    rule = rules.get("name") or {}
    separator = rule.get("separator", " > ")
    parts = name.split(separator)
    require(len(parts) >= rule.get("min_parts", 2) and all(part.strip() for part in parts),
            f"test name does not follow the configured name rule: {name}")
    limit = min(rule.get("max_length", 400), definition.get("title_max_length", 128))
    require(len(name) <= limit, f"test name exceeds the configured {limit}-character limit: {name}")
    require(not re.search(r"[\x00-\x1f\x7f-\x9f]", name), f"test name contains a control character: {name}")
    if rule.get("file_extension"):
        require(PurePosixPath(parts[0]).suffix, f"test name needs a file with an extension: {name}")


def bind_missing(ac, names, nodes, joppa, owner):
    """Create save_object commands only for names without a node. Never touch existing nodes."""
    kind, definition, rules = joppa["test_type"], joppa["test_schema"], joppa.get("test_rules") or {}
    existing = {node["title"] for node in nodes}
    missing = [name for name in dict.fromkeys(names) if name not in existing]
    limit = rules.get("max_tests")
    require(limit is None or len(existing) + len(missing) <= limit,
            f"criterion supports at most {limit} tests")
    required = definition.get("required_fields") or {}
    require(owner or "owner" not in required, "criterion owner is required for new test nodes")
    commands = []
    for name in missing:
        check_name(name, rules, definition)
        data = {"title": name, **({"owner": owner} if owner else {})}
        command = {"op": "save_object", "kind": kind, "revision": 0, "parent": ac, "data": data,
                   "reason": "Bind an existing test after review of every criterion assertion."}
        if definition.get("question"):
            command["question_checked"] = definition["question"]
        commands.append({"command": command})
    return commands
