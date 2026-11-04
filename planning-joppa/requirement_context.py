"""Planning context helpers."""
import json
from common import require
from context_reads import object_read, read_remote_links, remote_snapshot
from context_snapshot import source, current_pin, remote_satisfied, snapshot_source
from test_nodes import identities, read_nodes, tone
from joppa_reads import task_state


def load_requirement(api, config, req_id, selected=None):
    """Plan one Requirement. Keep unfinished external prerequisites outside this run."""
    from context import load, current_criteria, requirement_meaning
    workspace = config["workspace"]
    tree = api.call("joppa_tree", {"workspace": workspace})
    types = tree["schema"]["types"]
    if ":" not in req_id:
        kinds = [kind for kind, definition in types.items() if definition.get("role") == "requirement"]
        require(len(kinds) == 1, "use a full Requirement address when its schema type is ambiguous")
        req_id = kinds[0] + ":" + req_id
    req = object_read(api, workspace, req_id)
    require(types[req["kind"]].get("role") == "requirement", "input must be a Requirement")
    revision = requirement_meaning(api, workspace, req, types)
    addresses = [item["address"] for item in current_criteria(api, workspace, revision)]
    require(addresses, "Requirement has no current criteria")
    assignment, snapshot, _ = load(api, config, addresses[0])
    require(assignment["requirement"]["id"] == req_id, "criterion belongs to another Requirement")
    objects = assignment["joppa"]["objects"]
    remote = assignment["joppa"].get("remote", {})
    def get(address):
        # A done or retired Task is archived. Its document still decides readiness.
        if address not in objects:
            object = object_read(api, workspace, address, allow_archived=True)
            require(object["document"]["present"] or types[object["kind"]].get("role") == "task",
                    f"object is absent: {address}")
            objects[address] = source(object)
        return objects[address]
    # One paginated read below the Requirement gives every criterion's test nodes.
    tests = read_nodes(api, workspace, assignment["joppa"]["test_type"], req_id, addresses)
    statuses = {}
    def status(address):
        """Joppa applies the configured own, children or links status rule. Read the current tone."""
        if address not in statuses:
            statuses[address] = tone(object_read(api, workspace, address).get("status"))
        return statuses[address]
    tasks = [item for item in objects.values() if types[item["kind"]].get("role") == "task"
             and item["document"].get("parent") in addresses]
    candidates = []
    for address in addresses:
        # Admission needs live ownership. Authored snapshots exclude data.assignee.
        ac = object_read(api, workspace, address)
        objects[address] = source(ac)
        statuses[address] = tone(ac.get("status"))
        require(isinstance(statuses[address], str), f"criterion status is missing: {address}")
        read_remote_links(api, remote, ac)
        work = [item for item in tasks if item["document"]["parent"] == address
                and not item["process"].get("done") and not item["process"].get("retired")]
        if ((not config.get("ac_ids") or address in config["ac_ids"])
                and ac.get("work_ready") is True
                and (ac["process"].get("assessment") or {}).get("state") == "ready"
                and (selected is not None or not ac["document"]["data"].get("assignee")) and statuses[address] != "green"
                and all(task_state(item) == "blocked" and not item["process"].get("assignee") for item in work)):
            candidates.append(address)
    def satisfied(object):
        process = object["process"]
        if types[object["kind"]].get("role") == "task":
            return bool(process.get("done"))
        # Every other target is satisfied only by its own current green status.
        return status(object["address"]) == "green"
    def ready(address, trail=None):
        trail = set(trail or [])
        require(address not in trail, "dependency cycle in Requirement context")
        trail.add(address)
        object, seen = get(address), set()
        while object:
            require(object["address"] not in seen, "parent cycle in Requirement context")
            seen.add(object["address"])
            if any(link.get("blocking") is True and not remote_satisfied(link)
                   for link in object.get("remote_links", [])):
                return False
            for link in object["document"].get("links", []):
                if link.get("relation") != "depends_on" or link.get("blocking") is not True:
                    continue
                dependency = get(link["target"])
                revision = link.get("revision")
                # Joppa has no contract pins. Lifecycle saves raise the revision above an earlier pin.
                pin = revision is None or current_pin(revision, dependency["current_revision"])
                if not pin or not satisfied(dependency) or not ready(dependency["address"], trail):
                    return False
            parent = object["document"].get("parent")
            object = get(parent) if parent else None
        return True
    candidates = [address for address in candidates if ready(address)]
    if selected is not None:
        require(set(selected).issubset(candidates), "selected criterion is no longer ready for Requirement planning")
        candidates = list(selected)
    require(candidates, "Requirement has no ready criteria without unmet external dependencies")
    criteria = [{"id": address, "revision": get(address)["current_revision"],
                 "text": json.dumps(get(address), ensure_ascii=False)} for address in candidates]
    schemas = {}
    for address in candidates:
        task_types = [kind for kind, definition in types.items()
                      if definition.get("role") == "task" and get(address)["kind"] in definition.get("parents", [])]
        require(len(task_types) == 1, "criterion needs exactly one direct Task type")
        kind = task_types[0]
        require(types[kind].get("question"), "Task type needs a configured question")
        reference = types[kind].get("references", {}).get("projects")
        require(reference and reference.get("multiple") is True, "Task type needs a projects reference list")
        require(all(get(repo["project"])["kind"] == reference["target"] for repo in config["repositories"]),
                "repository project type differs from Task schema")
        schemas[address] = {"task_type": kind, "task_schema": types[kind], "test_nodes": tests[address]}
    assignment["ac"] = criteria[0]
    assignment["joppa"].update(scope="requirement", criteria=criteria, criterion_schemas=schemas,
        tasks=[item for item in tasks if item["document"]["parent"] in candidates])
    snapshot["objects"] = {address: snapshot_source(item, types, candidates) for address, item in objects.items()}
    snapshot["tests"] = {address: identities(tests[address]) for address in candidates}
    snapshot["criteria"] = candidates
    if remote:
        assignment["joppa"]["remote"] = remote
        snapshot["remote"] = remote_snapshot(remote)
    require(api.call("joppa_tree", {"workspace": workspace})["schema"] == tree["schema"],
            "workspace changed during Requirement schema read")
    return assignment, snapshot, req
