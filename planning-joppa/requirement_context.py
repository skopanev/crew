"""Planning context helpers."""
import json
from common import require
from context_reads import dependency_ready, object_read, read_remote_links, remote_snapshot
from context_snapshot import source, snapshot_source
from test_nodes import identities, read_nodes, tone
from joppa_reads import assignee, blocked, done, ended
import coverage


def json_key(value):
    return json.dumps(value, sort_keys=True)


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
    tasks = [item for item in objects.values() if types[item["kind"]].get("role") == "task"
             and item["document"].get("parent") in addresses]
    specs = {}
    def covers(task):
        """Criteria of this Requirement that the Task covers besides its parent. Archived Tasks keep raw data."""
        if task["kind"] not in specs:
            specs[task["kind"]] = coverage.reference(config, types, task["kind"])
        return [address for address in coverage.covered(task["document"]["data"], specs[task["kind"]])
                if address in addresses and address != task["document"]["parent"]]
    candidates = []
    for address in addresses:
        # Admission needs live ownership. Authored snapshots exclude data.assignee.
        ac = object_read(api, workspace, address)
        objects[address] = source(ac)
        statuses[address] = tone(ac.get("status"))
        require(isinstance(statuses[address], str), f"criterion status is missing: {address}")
        read_remote_links(api, remote, ac)
        # A covering Task owns its covered criteria for readiness. Its parent alone owns update and retirement.
        own = [item for item in tasks if item["document"]["parent"] == address or address in covers(item)]
        work = [item for item in own if not ended(item)]
        failures = [item for item in work if blocked(item) and not assignee(item)]
        # Landed work without a live failure waits for acceptance. Planning again would repeat it.
        completed = any(done(item) for item in own) and not failures
        if ((not config.get("ac_ids") or address in config["ac_ids"])
                and not completed
                and not ac["document"]["data"].get("hold")
                and (selected is not None or not ac["document"]["data"].get("assignee")) and statuses[address] != "green"
                and len(failures) == len(work)):
            candidates.append(address)
    reads = {}
    candidates = [address for address in candidates if dependency_ready(api, workspace, types, address, reads)]
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
        schemas[address] = {"task_type": kind, "task_schema": types[kind], "test_nodes": tests[address]}
        specs.setdefault(kind, coverage.reference(config, types, kind))
    spec = {json_key(specs[schemas[address]["task_type"]]) for address in candidates}
    require(len(spec) == 1, "selected criteria need one covers reference configuration")
    covers_spec = specs[schemas[candidates[0]]["task_type"]]
    assignment["ac"] = criteria[0]
    assignment["joppa"].update(scope="requirement", criteria=criteria, criterion_schemas=schemas,
        tasks=[item for item in tasks if item["document"]["parent"] in candidates])
    if covers_spec:
        assignment["joppa"]["covers"] = covers_spec
    snapshot["objects"] = {address: snapshot_source(item, types, candidates) for address, item in objects.items()}
    snapshot["tests"] = {address: identities(tests[address]) for address in candidates}
    snapshot["criteria"] = candidates
    if remote:
        assignment["joppa"]["remote"] = remote
        snapshot["remote"] = remote_snapshot(remote)
    require(api.call("joppa_tree", {"workspace": workspace})["schema"] == tree["schema"],
            "workspace changed during Requirement schema read")
    return assignment, snapshot, req
