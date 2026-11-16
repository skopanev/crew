"""Read only the objects and reference fields named by a flow config."""
from common import require
from context_reads import object_read
import flow_batch


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
    batch = flow_batch.settings(config)
    fields = ["revision", *([flow_batch.projection(batch[key]) for key in ("by", "unit_field", "age_field") if batch.get(key)] if batch else []),
              *[item["field"] for item in config.get("order", [])]]
    rows = pages(api, workspace, {**config["selection"], "fields": list(dict.fromkeys(fields)) if batch else ["revision"]})
    candidates = list(rows) if batch else None
    row = next((item for item in candidates if item.get("address") == address), None) if batch else \
          next((item for item in rows if item.get("address") == address), None)
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
    assignment = {"workspace": workspace, "selected": selected, "schema": schema, "help": help,
            "references": refs,
            "children": children(api, config, selected, config["children"]) if "children" in config else []}
    if batch:
        group = flow_batch.field(selected, batch["by"]) if batch.get("by") else None
        require(not batch.get("by") or group is not None, "selected item lacks batch.by field")
        items, seen = [selected], {address}
        unit_field = batch.get("unit_field")
        units = {flow_batch.field(selected, unit_field)} if unit_field else set()
        require(not unit_field or None not in units, "selected item lacks batch.unit_field")
        for candidate in flow_batch.ordered(candidates, config):
            if not unit_field and len(items) == batch["size"]:
                break
            if candidate["address"] in seen:
                continue
            if batch.get("by") and flow_batch.field(candidate, batch["by"]) != group:
                continue
            unit = flow_batch.field(candidate, unit_field) if unit_field else None
            if unit_field and unit not in units and len(units) == batch["size"]:
                continue
            item = object_read(api, workspace, candidate["address"])
            require(item["current_revision"] == candidate["revision"], "batch item changed during selection")
            require(not batch.get("by") or flow_batch.field(item, batch["by"]) == group,
                    "batch grouping changed during selection")
            if config.get("exclude_children") is not None and children(api, config, item, config["exclude_children"]):
                continue
            if unit_field:
                require(unit is not None and flow_batch.field(item, unit_field) == unit, "batch unit changed during selection")
                units.add(unit)
            items.append(item)
            seen.add(item["address"])
        require(len(items) <= 50, "batch exceeds the native 50-item claim limit")
        require(flow_batch.ready(batch, items), "batch waits for its configured minimum or age")
        assignment["items"] = items
    return assignment


def objects(assignment):
    return {item["address"]: item for item in [*flow_batch.members(assignment), *assignment["children"],
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
        for item in flow_batch.members(assignment):
            require(not children(api, config, item, config["exclude_children"]), "excluded children appeared during the flow")
    if "children" in config:
        current = children(api, config, selected, config["children"])
        require([(item["address"], item["current_revision"]) for item in current] ==
                [(item["address"], item["current_revision"]) for item in assignment["children"]],
                "configured children changed during the flow")
