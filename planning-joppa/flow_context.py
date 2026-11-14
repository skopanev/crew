"""Read only the objects and reference fields named by a flow config."""
from common import require
from context_reads import object_read


def pages(api, workspace, query):
    cursor, seen = None, set()
    while True:
        args = {**query, "workspace": workspace, "limit": 25}
        if cursor:
            args["cursor"] = cursor
        page = api.call("joppa_objects", args)
        require(isinstance(page.get("items"), list), "object query returned no items")
        yield from page["items"]
        cursor = page.get("next_cursor")
        if not cursor:
            return
        require(cursor not in seen, "object pagination did not advance")
        seen.add(cursor)


def children(api, config, selected, query):
    rows = pages(api, config["workspace"], {**query, "parent": selected["address"], "depth": 1,
                                         "fields": ["parent", "revision"]})
    result = []
    for row in rows:
        if row.get("parent") != selected["address"]:
            continue
        item = object_read(api, config["workspace"], row["address"])
        require(item["document"].get("parent") == selected["address"], "child moved during its read")
        require(item["current_revision"] == row["revision"], "child changed during selection")
        result.append(item)
    return sorted(result, key=lambda item: item["address"])


def load(api, config, address):
    workspace = config["workspace"]
    schema = api.call("joppa_tree", {"workspace": workspace})["schema"]
    help = api.call("joppa_help", {"workspace": workspace, "op": "save_object"})
    selected = object_read(api, workspace, address)
    row = next((item for item in pages(api, workspace, {**config["selection"], "fields": ["revision"]})
                if item.get("address") == address), None)
    require(row and row.get("revision") == selected["current_revision"], "selected object no longer matches the configured filter")
    if config.get("exclude_children") is not None:
        require(not children(api, config, selected, config["exclude_children"]), "selected object has excluded children")
    refs = {}
    for field in config.get("references", []):
        spec = schema["types"][selected["kind"]].get("references", {}).get(field)
        require(isinstance(spec, dict) and spec.get("target"), "unknown selected reference field: " + field)
        values = selected["document"]["data"].get(field, [])
        values = values if isinstance(values, list) else [values] if values else []
        require(all(isinstance(value, str) and value for value in values), "reference values must be object addresses")
        addresses = [value if ":" in value else spec["target"] + ":" + value for value in values]
        refs[field] = [object_read(api, workspace, value) for value in sorted(set(addresses))]
    return {"workspace": workspace, "selected": selected, "schema": schema, "help": help,
            "references": refs,
            "children": children(api, config, selected, config["children"]) if "children" in config else []}


def objects(assignment):
    return {item["address"]: item for item in [assignment["selected"], *assignment["children"],
            *(item for rows in assignment["references"].values() for item in rows)]}


def verify(api, config, assignment, claim):
    from planning_claims import owned, claimed_revisions
    owned(api, config["workspace"], claim)
    expected = claimed_revisions(claim)
    for address, before in objects(assignment).items():
        current = object_read(api, config["workspace"], address)
        revision = expected.get(address, before["current_revision"])
        require(current["current_revision"] == revision, "flow input changed: " + address)
    schema = api.call("joppa_tree", {"workspace": config["workspace"]})["schema"]
    require(schema == assignment["schema"], "workspace schema changed during the flow")
    # Re-read query membership. A new child can invalidate a no-child selection without editing its parent.
    selected = assignment["selected"]
    if config.get("exclude_children") is not None:
        require(not children(api, config, selected, config["exclude_children"]), "excluded children appeared during the flow")
    if "children" in config:
        current = children(api, config, selected, config["children"])
        require([(item["address"], item["current_revision"]) for item in current] ==
                [(item["address"], item["current_revision"]) for item in assignment["children"]],
                "configured children changed during the flow")
