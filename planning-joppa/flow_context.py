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
    if isinstance(query, list):
        return sorted({item["address"]: item for child_filter in query
                       for item in children(api, config, selected, child_filter)}.values(), key=lambda item: item["address"])
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


def related_context(api, config, selected, schema):
    spec, cached = config["related"], {}
    def full(address, allow_archived=False):
        require(isinstance(address, str) and ":" in address, "related object needs a full address")
        if address not in cached:
            require(len(cached) < spec["limit"], "related context exceeds its limit")
            cached[address] = object_read(api, config["workspace"], address, allow_archived=allow_archived)
        return cached[address]
    parent = full(selected["document"].get("parent"))
    guard = spec["parent"]
    require(parent["kind"] in ([guard["kind"]] if isinstance(guard["kind"], str) else guard["kind"]), "related parent kind differs")
    require(not parent["document"]["data"].get("assignee") and
            not set(parent["document"]["data"].get("tags") or []) & set(guard.get("exclude_tags", [])), "related parent is held or excluded")
    context = {"parent": parent, "children": [], "references": {}, "incoming": []}
    if guard.get("children"):
        for row in pages(api, config["workspace"], {**guard["children"], "parent": parent["address"], "depth": 1, "fields": ["parent", "revision"]}):
            node = full(row["address"])
            require(node["document"]["parent"] == parent["address"] and node["current_revision"] == row["revision"], "related child changed")
            context["children"].append(node)
    for name in guard.get("references", []):
        target = schema["types"][parent["kind"]]["references"][name]["target"]
        values = parent["document"]["data"].get(name, [])
        values = values if isinstance(values, list) else [values] if values else []
        require(all(isinstance(value, str) and value for value in values), "invalid related reference")
        context["references"][name] = [full(value if ":" in value else target + ":" + value) for value in values]
    incoming = spec.get("incoming")
    if incoming:
        query = {"relations_of": selected["address"], "direction": "incoming", "relation": incoming["relation"]}
        for row in pages(api, config["workspace"], query):
            if row["kind"] not in ([incoming["kind"]] if isinstance(incoming["kind"], str) else incoming["kind"]):
                continue
            node = full(row["address"], allow_archived=True)
            if node["document"]["present"] is False:
                continue
            require(not node["document"]["data"].get("assignee"), "related consumer is held")
            require(any(edge.get("to") == selected["address"] for edge in
                        node.get("relations", {}).get(incoming["relation"], {}).get("edges", [])), "incoming relation changed")
            if node not in context["incoming"]:
                context["incoming"].append(node)
    return context


def load(api, config, address):
    workspace = config["workspace"]
    schema = api.call("joppa_tree", {"workspace": workspace})["schema"]
    help = api.call("joppa_help", {"workspace": workspace, "op": "save_object"})
    selected = object_read(api, workspace, address)
    require(not any(tag in (selected["document"]["data"].get("tags") or []) for tag in config.get("exclude_tags", [])),
            "selected object has an excluded tag")
    batch = flow_batch.settings(config)
    fields = ["revision", *(["data.tags"] if config.get("exclude_tags") else []), *([flow_batch.projection(batch[key]) for key in ("by", "unit_field", "age_field") if batch.get(key)] if batch else []),
              *[item["field"] for item in config.get("order", [])]]
    rows = pages(api, workspace, {**config["selection"], "fields": list(dict.fromkeys(fields)) if batch else ["revision"]})
    rows = (item for item in rows if not any(tag in (flow_batch.field(item, "data.tags") or []) for tag in config.get("exclude_tags", [])))
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
            "children": children(api, config, selected, config["children"]) if config.get("children") else []}
    if "input" in config:
        assignment["input"] = config["input"]
    if config.get("related"):
        assignment["context"] = related_context(api, config, selected, schema)
    if batch:
        group = flow_batch.field(selected, batch["by"]) if batch.get("by") else None
        require(not batch.get("by") or group is not None, "selected item lacks batch.by field")
        candidates = [row, *[candidate for candidate in flow_batch.ordered(candidates, config)
            if candidate["address"] != address and (not batch.get("by") or flow_batch.field(candidate, batch["by"]) == group)]]
        checked = {address}
        while True:
            packed = flow_batch.select(batch, candidates)
            excluded = set()
            if config.get("exclude_children") is not None:
                for candidate in packed:
                    if candidate["address"] not in checked and children(api, config, candidate, config["exclude_children"]):
                        excluded.add(candidate["address"])
                    checked.add(candidate["address"])
            if not excluded:
                break
            candidates = [candidate for candidate in candidates if candidate["address"] not in excluded]
        items = []
        for candidate in packed:
            item = selected if candidate["address"] == address else object_read(api, workspace, candidate["address"])
            require(item["current_revision"] == candidate["revision"], "batch item changed during selection")
            require(not batch.get("by") or flow_batch.field(item, batch["by"]) == group,
                    "batch grouping changed during selection")
            require(not batch.get("unit_field") or flow_batch.field(item, batch["unit_field"]) ==
                    flow_batch.field(candidate, batch["unit_field"]), "batch unit changed during selection")
            items.append(item)
        require(flow_batch.ready(batch, items), "batch waits for its configured minimum or age")
        assignment["items"] = items
    return assignment


def objects(assignment):
    context = assignment.get("context", {})
    return {item["address"]: item for item in [*flow_batch.members(assignment), *assignment["children"],
            *(item for rows in assignment["references"].values() for item in rows),
            *([context["parent"]] if context else []), *context.get("children", []), *context.get("incoming", []),
            *(item for rows in context.get("references", {}).values() for item in rows)]}


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
    if config.get("children"):
        current = children(api, config, selected, config["children"])
        require([(item["address"], item["current_revision"]) for item in current] ==
                [(item["address"], item["current_revision"]) for item in assignment["children"]],
                "configured children changed during the flow")
    if config.get("related"):
        current = related_context(api, config, selected, schema)
        require(objects({**assignment, "context": current}).keys() == objects(assignment).keys(), "related membership changed")
        require({item["address"] for item in current["incoming"]} ==
                {item["address"] for item in assignment["context"]["incoming"]}, "incoming membership changed")


def validate_parent_update(config, assignment, parent, cmd):
    fields, update = config["publication"].get("related_updates", {}).get("parent"), cmd.get("data") or {}
    require(fields in (["stage"], ["stage", "returns"], ["stage", "returns", "tags"]) and
            isinstance(update, dict) and "stage" in update and set(update) <= set(fields) and
            isinstance(update["stage"], str) and update["stage"] and not cmd.get("relations"),
            "parent update exceeds the configured fields")
    if "returns" in update:
        types = assignment["schema"]["types"]
        field = types[parent["kind"]].get("fields", {}).get("returns", {})
        previous = parent["document"]["data"].get("returns", 0)
        require(types[assignment["selected"]["kind"]].get("role") == "task" and
                types[parent["kind"]].get("role") == "ac" and
                field.get("type") == "number" and field.get("from", "own") == "own" and
                type(previous) is int and previous >= 0 and type(update["returns"]) is int and
                update["returns"] == previous + 1, "parent returns permits one guarded increment only")
    if "tags" in update:
        variables = config.get("vars", {})
        limit = str(variables.get("TASKER_RETURN_LIMIT", ""))
        tag = variables.get("STUCK_TAG")
        tags = parent["document"]["data"].get("tags", [])
        field = assignment["schema"]["types"][parent["kind"]].get("fields", {}).get("tags", {})
        require("returns" in update and limit.isascii() and limit.isdecimal() and int(limit) > 0 and
                update["returns"] >= int(limit) and isinstance(tag, str) and tag.strip() == tag and bool(tag) and
                isinstance(tags, list) and all(isinstance(item, str) for item in tags) and
                field.get("type") == "list" and field.get("from", "own") == "own" and
                update["tags"] == (tags if tag in tags else [*tags, tag]),
                "parent tags permits the configured stuck addition at the return limit only")
