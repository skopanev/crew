"""Planning context helpers."""
import json
from common import require
from context_reads import object_read, read_remote_links, remote_snapshot
from context_snapshot import source, current_pin, remote_satisfied, snapshot_source, test_list


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
        if address not in objects:
            objects[address] = source(object_read(api, workspace, address))
        return objects[address]
    tests = {}
    for offset in range(0, len(addresses), 100):
        response = api.call("joppa_tests", {"workspace": workspace, "ac": ",".join(addresses[offset:offset + 100])})
        tests.update({item["address"]: {"tests": [], "tests_draft": False, **item} for item in response.get("items", [response])})
    require(all(address in tests for address in addresses), "Requirement test status is incomplete")
    require(all(tests[address].get("status") in ("green", "red", "grey") for address in addresses),
            "Requirement test status is invalid")
    tasks = [item for item in objects.values() if types[item["kind"]].get("role") == "task"
             and item["document"].get("parent") in addresses]
    candidates = []
    for address in addresses:
        # Admission needs live ownership. Authored snapshots exclude planning claims.
        ac = object_read(api, workspace, address)
        objects[address] = source(ac)
        read_remote_links(api, remote, ac)
        work = [item for item in tasks if item["document"]["parent"] == address
                and not item["process"].get("done") and not item["process"].get("retired")]
        if ((not config.get("ac_ids") or address in config["ac_ids"])
                and ac.get("work_ready") is True and ac.get("review_required") is False
                and ac["process"].get("assessment", {}).get("state") == "ready"
                and not ac["process"].get("readiness_blocker")
                and (selected is not None or not ac["process"].get("planning_claim")) and tests[address].get("status") != "green"
                and all(not item["process"].get("assignee") and not item["process"].get("claim")
                        and isinstance(item["process"].get("blocked"), dict) for item in work)):
            candidates.append(address)
    def satisfied(object, seen=None):
        seen = set(seen or [])
        require(object["address"] not in seen, "dependency cycle in Requirement context")
        seen.add(object["address"])
        process = object["process"]
        role = types[object["kind"]].get("role")
        if role == "task":
            return bool(process.get("done")) and not process.get("retired") and not object.get("review_required")
        if role == "ac":
            response = tests.get(object["address"]) or api.call("joppa_tests", {"workspace": workspace, "ac": object["address"]})
            return response.get("status") == "green"
        children, cursor = [], None
        while True:
            response = api.call("joppa_objects", {"workspace": workspace, "parent": object["address"], "limit": 25,
                                                "fields": ["kind", "present"], **({"cursor": cursor} if cursor else {})})
            children.extend(get(item["address"]) for item in response["items"] if item.get("present", True))
            cursor = response.get("next_cursor")
            if not cursor:
                break
        return bool(children) and all(satisfied(item, seen) for item in children)
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
                origin = (dependency["process"].get("origin_revision")
                          if types[dependency["kind"]].get("role") == "task"
                          else dependency.get("contract_revision", dependency["current_revision"]))
                pin = revision is None or current_pin(revision, dependency["current_revision"], origin)
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
        schemas[address] = {"task_type": kind, "task_schema": types[kind], "test_status": tests[address]}
    assignment["ac"] = criteria[0]
    assignment["joppa"].update(scope="requirement", criteria=criteria, criterion_schemas=schemas,
        tasks=[item for item in tasks if item["document"]["parent"] in candidates])
    snapshot["objects"] = {address: snapshot_source(item, types, candidates) for address, item in objects.items()}
    snapshot["tests"] = {address: test_list(tests[address]) for address in candidates}
    snapshot["criteria"] = candidates
    if remote:
        assignment["joppa"]["remote"] = remote
        snapshot["remote"] = remote_snapshot(remote)
    require(api.call("joppa_tree", {"workspace": workspace})["schema"] == tree["schema"],
            "workspace changed during Requirement schema read")
    return assignment, snapshot, req
