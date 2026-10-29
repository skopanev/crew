"""Read one criterion and its current Joppa context."""
import json
import fcntl
import os
import re
from pathlib import Path

from common import digest, read, require, strings, text, validate_input
from mcp import Joppa, Rejected, complete_object


def task_contract(data):
    """Render either stored format without changing the document or claim digest."""
    contract = data.get("contract", "")
    if "steps" not in data:
        return contract if isinstance(contract, str) else ""
    text(contract, "Structured Task contract")
    for key in ("repository", "module"):
        value = text(data.get(key), "Structured Task " + key)
        require("\n" not in value and "\r" not in value, "Structured Task needs a single-line " + key)
    steps = list(strings(data.get("steps"), "Structured Task steps"))
    checks = strings(data.get("checks"), "Structured Task checks")
    lines = [contract, "", f"Repository: {data['repository']}", f"Module: {data['module']}", "", "How:"]
    if steps[0].startswith("0. "):
        lines.append(steps.pop(0))
    lines.extend(f"{number}. " + re.sub(r"^\s*\d+\.\s+", "", step)
                 for number, step in enumerate(steps, 1))
    return "\n".join([*lines, "", "Checks:", *checks])


def configuration(path):
    config = read(path)
    for key in ("workspace", "url", "runs_folder", "cbm_store", "cbm_root", "equill_store"):
        text(config.get(key), "config." + key)
    if config.get("mcp_command") is not None:
        from stdio import validate_command
        validate_command(config["mcp_command"])
    else:
        text(config.get("token_file"), "config.token_file")
    require(isinstance(config.get("repositories"), list) and config["repositories"], "config.repositories required")
    root = Path(path).resolve().parent
    for key in ("token_file", "reader_token_file", "runs_folder", "cbm_store", "cbm_root", "equill_store"):
        if key in ("token_file", "reader_token_file") and key not in config:
            continue
        value = Path(config[key]).expanduser()
        config[key] = str((root / value).resolve() if not value.is_absolute() else value.resolve())
    require(bool(config.get("worktree_root")) == bool(config.get("lane_runs_folder")),
            "worktree_root and lane_runs_folder must be configured together")
    for key in ("worktree_root", "lane_runs_folder"):
        if key not in config:
            continue
        value = Path(text(config[key], "config." + key)).expanduser()
        require(".." not in value.parts, "cleanup path cannot contain parent traversal")
        config[key] = str(value if value.is_absolute() else root / value)
    for repo in config["repositories"]:
        text(repo.get("project"), "repository.project address")
        require(":" in repo["project"], "repository.project must be a full object address")
        value = Path(text(repo.get("path"), "repository.path")).expanduser()
        repo["path"] = str((root / value).resolve() if not value.is_absolute() else value.resolve())
    require(len({r["id"] for r in config["repositories"]}) == len(config["repositories"]), "duplicate repository ID")
    require(len({r["project"] for r in config["repositories"]}) == len(config["repositories"]), "duplicate project mapping")
    if "ac_ids" in config:
        require(isinstance(config["ac_ids"], list) and bool(config["ac_ids"])
                and all(isinstance(address, str) and ":" in address for address in config["ac_ids"])
                and len(set(config["ac_ids"])) == len(config["ac_ids"]),
                "ac_ids must contain distinct full criterion addresses")
    if config.get("worktree_root"):
        require(all(not Path(repo["path"]).is_relative_to(Path(config["worktree_root"]))
                    for repo in config["repositories"]), "worktree_root cannot contain a canonical repository")
    require(all(not Path(config["runs_folder"]).is_relative_to(Path(r["path"])) for r in config["repositories"]),
            "runs_folder must be outside inspected repositories")
    placeholder = {"id": "config-check", "text": "Validate configuration.", "revision": 1}
    validate_input({"workspace": config["workspace"], "domain": placeholder, "capability": placeholder,
                    "requirement": placeholder, "ac": placeholder, "decisions": [], "repositories": config["repositories"]})
    return config


def client(config):
    return Joppa(config["url"], config.get("token_file"), config.get("mcp_command"))


def pending_work(api, config, assignment):
    for attempt in range(3):
        try:
            return pending_work_page(api, config, assignment)
        except Rejected as error:
            if "task queue changed; start again without cursor" not in str(error) or attempt == 2:
                raise


def pending_work_page(api, config, assignment):
    """Locate unfinished work across Requirements. Full reads still bind reuse and dependencies."""
    visible = set(assignment["joppa"]["objects"])
    projects = {name for repo in config["repositories"] for name in (repo["project"], repo["project"].split(":", 1)[1])}
    result, cursor = [], None
    while True:
        args = {"workspace": config["workspace"], "view": "all", "limit": 100}
        if cursor:
            args["cursor"] = cursor
        page = api.call("joppa_tasks", args)
        for task in page["tasks"]:
            address = task.get("address") or f"task:{task['req']}/{task['id']}"
            if task["status"] in ("done", "retired") or address in visible:
                continue
            if not projects.intersection(task.get("projects", [])):
                continue
            contract = task.get("contract", "")
            if not re.search(r"^Repository:[ \t]*\S", contract, re.M):
                document = object_read(api, config["workspace"], address)
                contract = task_contract(document["document"]["data"])
            def field(name):
                match = re.search(r"^" + name + r":[ \t]*([^\r\n]+)$", contract, re.M)
                return match[1].strip() if match else None
            how = re.search(r"^How:\s*\n(.*?)(?:\nChecks:|\Z)", contract, re.M | re.S)
            ac = task.get("parent") or task.get("ac")
            req = task.get("req")
            legacy_ac = task.get("ac")
            if not req and isinstance(legacy_ac, str) and "/" in legacy_ac:
                req = legacy_ac.removeprefix("ac:").split("/", 1)[0]
            result.append({"address": address, "revision": task["revision"], "title": task["title"],
                "ac": ac, "requirement": req, "status": task["status"],
                "repository": field("Repository"), "module": field("Module"),
                "how": " ".join(how[1].split()) if how else None})
        cursor = page.get("next_cursor")
        if not cursor:
            return result


def object_read(api, workspace, address, allow_archived=False):
    result = api.call("joppa_objects", {"workspace": workspace, "address": address})
    result = complete_object(api.call, {"workspace": workspace, "address": address}, result)
    present = result.get("document", {}).get("present")
    require(present is True or allow_archived and present is False, f"object is absent: {address}")
    require(result.get("historical") is False, f"current object required: {address}")
    return result


def requirement_meaning(api, workspace, req, types, get=None):
    """Rebuild the current Requirement verification view without joppa_read."""
    get = get or (lambda address: object_read(api, workspace, address))
    data = req["document"]["data"]
    acs, cursor, seen = [], None, set()
    while True:
        page = api.call("joppa_objects", {"workspace": workspace, "parent": req["address"], "limit": 25,
                                          "fields": ["kind", "present"], **({"cursor": cursor} if cursor else {})})
        acs.extend({"id": item["address"]} for item in page["items"]
                   if item.get("present", True) and types[item["kind"]].get("role") == "ac")
        cursor = page.get("next_cursor")
        if not cursor:
            break
        require(cursor not in seen, "Requirement child pagination did not advance")
        seen.add(cursor)
    notes, cursor, seen = [], None, set()
    while True:
        page = api.call("joppa_objects", {"workspace": workspace, "related_to": req["address"],
                                          "limit": 25, "fields": ["kind", "present"], **({"cursor": cursor} if cursor else {})})
        notes.extend(source(get(item["address"])) for item in page["items"]
                     if item.get("present", True) and types[item["kind"]].get("inbox") is True)
        cursor = page.get("next_cursor")
        if not cursor:
            break
        require(cursor not in seen, "Requirement note pagination did not advance")
        seen.add(cursor)
    return {"number": req["current_revision"], "title": data.get("title"), "body": data.get("body"),
            "owner": data.get("owner"), "reason": req["document"].get("reason"), "acs": acs,
            "summary": req.get("process", {}).get("summary"), "sources": {"notes": notes},
            "comments": (req.get("annotations") or {}).get("comments") or {}}


def current_criteria(api, workspace, revision):
    """Exclude archived criteria from the Requirement revision's roster."""
    return [object for item in revision.get("acs", [])
            if (object := object_read(api, workspace, item["id"], allow_archived=True))["document"]["present"]]


def source(object):
    """Ignore journal position and our own planning claim. Keep meaningful state."""
    process = {key: value for key, value in object.get("process", {}).items() if key != "planning_claim"}
    value = {key: object.get(key) for key in ("address", "item_id", "kind", "current_revision", "document", "annotations",
                                            "files", "references", "review_required", "work_ready")} | {"process": process}
    if "contract_revision" in object:
        value["contract_revision"] = object["contract_revision"]
    if object.get("remote_links") or object.get("remote_links_revision", 0) > 0:
        value["remote_links"] = object.get("remote_links", [])
        value["remote_links_revision"] = object.get("remote_links_revision", 0)
        value["remote_review_required"] = object.get("remote_review_required", False)
    return value


def current_pin(pin, current, contract):
    return (type(pin) is int and type(current) is int and type(contract) is int
            and 1 <= contract <= pin <= current)


def remote_satisfied(link):
    status = link.get("status", {})
    revision = link.get("revision")
    return (current_pin(revision, status.get("current_revision"),
                        status.get("contract_revision", status.get("current_revision")))
            and status.get("access") is True
            and status.get("present") is True and status.get("review_required") is False
            and status.get("satisfied") is True)


def read_remote_links(api, remote, object):
    for link in object.get("remote_links", []):
        if (link.get("status", {}).get("access") is True
                and link.get("status", {}).get("present") is True):
            remote_object(api, remote, link["workspace"], link["target"])


def remote_key(workspace, address):
    return "@" + workspace + "/" + address


def remote_object(api, remote, workspace, address):
    """Keep foreign schemas and addresses outside the execution workspace."""
    schemas = remote.setdefault("schemas", {})
    objects = remote.setdefault("objects", {})
    key = remote_key(workspace, address)
    if workspace not in schemas:
        schemas[workspace] = api.call("joppa_tree", {"workspace": workspace})["schema"]
    if key not in objects:
        value = object_read(api, workspace, address)
        require(value.get("address") == address, "remote read returned a different object")
        require(value.get("workspace_key", workspace) == workspace, "remote read returned a different workspace")
        require(value.get("kind") in schemas[workspace]["types"], "remote object type is absent from its schema")
        objects[key] = {**source(value), "workspace": workspace}
    return objects[key]


def remote_snapshot(remote):
    return {"schemas": remote["schemas"], "objects": {
        key: {**snapshot_source(value, remote["schemas"][value["workspace"]]["types"], []),
              "workspace": value["workspace"]}
        for key, value in remote["objects"].items()}}


def verify_remote(api, remote, expected):
    """Read every captured foreign contract again before publication."""
    current = {}
    for value in expected["objects"].values():
        remote_object(api, current, value["workspace"], value["address"])
    unchanged(expected, remote_snapshot(current))
    remote["schemas"] = {**remote.get("schemas", {}), **current["schemas"]}
    remote["objects"] = {**remote.get("objects", {}), **current["objects"]}


def test_list(status):
    return {"tests": [item["address"] for item in status["tests"]],
            "tests_revision": status.get("tests_revision"), "tests_draft": status["tests_draft"]}


def snapshot_source(object, types, selected_ac=None):
    current = source(object)
    current.pop("item_id", None)
    current.pop("remote_review_required", None)
    if current.get("remote_links"):
        current["remote_links"] = [{key: value for key, value in link.items() if key != "status"}
                                   for link in current["remote_links"]]
    for key in ("verification", "pending_run", "summary", "status"):
        current["process"].pop(key, None)
    role = types[object["kind"]].get("role")
    selected = {selected_ac} if isinstance(selected_ac, str) else set(selected_ac or [])
    if role == "task" or (role == "ac" and selected_ac is not None and object["address"] not in selected):
        # Sibling execution state does not change the authored planning context.
        current.pop("current_revision")
        current.pop("process")
        current.pop("work_ready")
        current.pop("review_required")
        current["document"] = {key: value for key, value in current["document"].items()
                               if key in ("data", "parent", "links", "present", "schema_revision")}
        if role == "task":
            current.pop("contract_revision", None)
        elif "contract_revision" in current:
            current["document"]["data"] = {key: value for key, value in current["document"]["data"].items()
                                           if key != "tests"}
    if role == "task":
        annotations = dict(current.get("annotations") or {})
        comments = annotations.get("comments")
        if isinstance(comments, dict):
            annotations["comments"] = {key: comment for key, comment in comments.items()
                                       if comment.get("actor_type") != "agent"}
        for key in ("comments", "description", "attachments"):
            if not annotations.get(key):
                annotations.pop(key, None)
        current["annotations"] = annotations
    return current


def load(api, config, ac_id):
    for attempt in range(3):
        try:
            return load_once(api, config, ac_id)
        except ValueError as error:
            if not str(error).startswith("workspace changed during ") or attempt == 2:
                raise


def load_once(api, config, ac_id):
    workspace = config["workspace"]
    tree = api.call("joppa_tree", {"workspace": workspace})
    types = tree["schema"]["types"]
    ac_types = [kind for kind, value in types.items() if value.get("role") == "ac"]
    if ":" not in ac_id:
        require(len(ac_types) == 1, "use a full criterion address when the schema has multiple criterion types")
        ac_id = ac_types[0] + ":" + ac_id
    objects, remote = {}, {}
    def get(address):
        if address not in objects:
            objects[address] = object_read(api, workspace, address)
        return objects[address]
    ac = get(ac_id)
    require(types[ac["kind"]]["role"] == "ac", "input must be a criterion")
    parents, seen = [], {ac_id}
    parent = ac["document"].get("parent")
    while parent:
        require(parent not in seen, "parent cycle in criterion context")
        seen.add(parent)
        item = get(parent)
        parents.append(item)
        parent = item["document"].get("parent")
    req = next((item for item in parents if types[item["kind"]].get("role") == "requirement"), None)
    require(req is not None, "criterion needs a requirement ancestor")
    task_types = [kind for kind, value in types.items()
                  if value.get("role") == "task" and ac["kind"] in value.get("parents", [])]
    require(len(task_types) == 1, "criterion needs exactly one direct Task type")
    task_kind = task_types[0]
    require(types[task_kind].get("question"), "Task type needs a configured question")
    project_ref = types[task_kind].get("references", {}).get("projects")
    require(project_ref and project_ref.get("multiple") is True, "Task type needs a projects reference list")
    tasks, cursor = [], None
    while True:
        args = {"workspace": workspace, "parent": ac_id, "kind": task_kind, "limit": 25, "fields": ["address"]}
        if cursor:
            args["cursor"] = cursor
        page = api.call("joppa_objects", args)
        tasks.extend(get(item["address"]) for item in page["items"])
        cursor = page.get("next_cursor")
        if not cursor:
            break
    # Read explicit references. Do not traverse unrelated tickets or infer ownership.
    for item in [ac, *parents, *tasks]:
        for link in item["document"].get("links", []):
            get(link["target"])
        read_remote_links(api, remote, item)
        for reference in item.get("references", []):
            if isinstance(reference, dict) and reference.get("target"):
                get(reference["target"])
    for repo in config["repositories"]:
        project = get(repo["project"])
        require(project["kind"] == project_ref["target"], "repository project type differs from Task schema")
    # Current verification decisions belong to the Requirement, not the AC document revision.
    meaning = requirement_meaning(api, workspace, req, types, get)
    revision = meaning
    siblings = []
    for sibling in current_criteria(api, workspace, revision):
        address = sibling["address"]
        if address == ac_id:
            continue
        objects[address] = sibling
        require(types[sibling["kind"]].get("role") == "ac", "Requirement contains a non-criterion child")
        siblings.append(sibling)
        for kind, definition in types.items():
            if definition.get("role") != "task" or sibling["kind"] not in definition.get("parents", []):
                continue
            cursor = None
            while True:
                args = {"workspace": workspace, "parent": address, "kind": kind, "limit": 25, "fields": ["address"]}
                if cursor:
                    args["cursor"] = cursor
                page = api.call("joppa_objects", args)
                siblings.extend(get(item["address"]) for item in page["items"])
                cursor = page.get("next_cursor")
                if not cursor:
                    break
    for item in siblings:
        for link in item["document"].get("links", []):
            get(link["target"])
        read_remote_links(api, remote, item)
        for reference in item.get("references", []):
            if isinstance(reference, dict) and reference.get("target"):
                get(reference["target"])
    require(all(item["position"] == tree["position"] for item in objects.values()), "workspace changed during object read")
    tests = api.call("joppa_tests", {"workspace": workspace, "ac": ac_id})
    # Compact reads omit an empty test list.
    tests.setdefault("tests", [])
    require(tests.get("address") == ac_id and isinstance(tests.get("tests"), list),
            "criterion test status is incomplete")
    require(api.call("joppa_tree", {"workspace": workspace})["position"] == tree["position"],
            "workspace changed during context read")
    groups = [item for item in parents if types[item["kind"]].get("role") == "group"]
    context = lambda item: {"id": item["address"], "revision": item["current_revision"],
                            "text": json.dumps(source(item), ensure_ascii=False)}
    scope = context(req)
    assignment = {"kind": "joppa", "workspace": workspace, "ac": context(ac), "requirement": scope,
                  "capability": context(groups[0]) if groups else scope,
                  "domain": context(groups[-1]) if groups else scope,
                  "decisions": [json.dumps(meaning, ensure_ascii=False)],
                  "repositories": config["repositories"],
                  "joppa": {"parents": [source(item) for item in parents], "tasks": [source(item) for item in tasks],
                            "test_status": tests,
                            "siblings": [item["address"] for item in siblings],
                            "objects": {key: source(item) for key, item in objects.items()}, "task_type": task_kind,
                            "task_schema": types[task_kind]},
                  "knowledge_query": ac["document"]["data"].get("description") or ac["document"]["data"]["title"]}
    snapshot = {"schema": tree["schema"], "objects": {key: snapshot_source(item, types, ac_id) for key, item in objects.items()},
                "requirement": meaning, "tests": test_list(tests)}
    if remote:
        assignment["joppa"]["remote"] = remote
        snapshot["remote"] = remote_snapshot(remote)
    if tree.get("workspace_key"):
        assignment["joppa"]["workspace_key"] = tree["workspace_key"]
    validate_input(assignment)
    return assignment, snapshot, ac


def selected_criteria(assignment):
    return assignment["joppa"].get("criteria", [assignment["ac"]])


def criterion_assignment(assignment, address):
    """Keep the existing one-AC validator without changing the shared planner."""
    from copy import deepcopy
    result = deepcopy(assignment)
    result["ac"] = next(item for item in selected_criteria(assignment) if item["id"] == address)
    result["joppa"]["tasks"] = [item for item in assignment["joppa"]["tasks"]
                                 if item["document"]["parent"] == address]
    detail = assignment["joppa"].get("criterion_schemas", {}).get(address)
    if detail:
        result["joppa"].update(detail)
    return result


def load_requirement(api, config, req_id, selected=None):
    """Plan one Requirement. Keep unfinished external prerequisites outside this run."""
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
        tests.update({item["address"]: {"tests": [], **item} for item in response.get("items", [response])})
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
                pin = current_pin(revision, dependency["current_revision"], origin)
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
    require(api.call("joppa_tree", {"workspace": workspace})["position"] == tree["position"],
            "workspace changed during Requirement context read")
    return assignment, snapshot, req


def planning_idle(api, config, assignment, expected=None):
    """Do not split one Requirement between concurrent planning runs."""
    expected = expected or {}
    revision = json.loads(assignment["decisions"][0])
    addresses = {item["address"] for item in current_criteria(api, config["workspace"], revision)} | {assignment["ac"]["id"]}
    require(set(expected).issubset(addresses), "planning receipt contains another Requirement criterion")
    for address in addresses:
        object = object_read(api, config["workspace"], address)
        claim = object.get("process", {}).get("planning_claim")
        if address in expected:
            require(isinstance(claim, dict) and all(claim.get(key) == expected[address].get(key) for key in ("actor", "position")),
                    f"this run no longer holds planning claim {address}")
        else:
            require(not claim, f"Requirement already has an active planning run on {address}")


def unchanged(old, new):
    require(digest(old) == digest(new), "Joppa context changed during planning; read the criterion again")


def capture_object(target, workspace, object, api=None):
    """Keep the first full read. Serialize readers on the existing snapshot file."""
    path = Path(target) / "joppa-snapshot.json"
    with path.open("r+") as file:
        fcntl.flock(file, fcntl.LOCK_EX)
        snapshot = json.load(file)
        assignment = read(Path(target) / "input.json")
        require(object.get("document", {}).get("present") is True and object.get("historical") is False,
                "reader requires a full current object")
        address = text(object.get("address"), "object.address")
        scope = snapshot
        local_keys = {assignment["workspace"], assignment["joppa"].get("workspace_key")}
        workspace = object.get("workspace_key") or workspace
        if workspace not in local_keys:
            require(api is not None, "remote capture needs the authenticated reader")
            scope = snapshot.setdefault("remote", {"schemas": {}, "objects": {}})
            if workspace not in scope["schemas"]:
                scope["schemas"][workspace] = api.call("joppa_tree", {"workspace": workspace})["schema"]
            types = scope["schemas"][workspace]["types"]
            key = remote_key(workspace, address)
        else:
            types = snapshot["schema"]["types"]
            key = address
        require(object.get("kind") in types, "object schema changed during planning")
        current = snapshot_source(object, types, [] if scope is not snapshot else
                                  [item["id"] for item in selected_criteria(assignment)])
        if scope is not snapshot:
            current["workspace"] = workspace
        if key in scope["objects"]:
            unchanged(scope["objects"][key], current)
            return
        scope["objects"][key] = current
        # Keep the lock inode stable. Every reader uses this same file.
        file.seek(0)
        json.dump(snapshot, file, ensure_ascii=False, indent=2)
        file.write("\n")
        file.truncate()
        file.flush()
        os.fsync(file.fileno())


def refresh_reads(api, config, assignment, snapshot, original):
    """Check every captured contract and hydrate publication dependencies."""
    for address in original["objects"]:
        if address not in snapshot["objects"]:
            object = object_read(api, config["workspace"], address)
            assignment["joppa"]["objects"][address] = source(object)
            snapshot["objects"][address] = snapshot_source(object, snapshot["schema"]["types"],
                                                          [item["id"] for item in selected_criteria(assignment)])
    if original.get("remote"):
        remote = assignment["joppa"].setdefault("remote", {})
        verify_remote(api, remote, original["remote"])
        snapshot["remote"] = remote_snapshot(remote)
    unchanged(original, snapshot)


def read_assignment(api, config, target):
    """Hydrate additional reads without changing the fixed assessment input."""
    assignment = read(Path(target) / "input.json")
    snapshot = read(Path(target) / "joppa-snapshot.json")
    for address, expected in snapshot["objects"].items():
        if address not in assignment["joppa"]["objects"]:
            object = object_read(api, config["workspace"], address)
            unchanged(expected, snapshot_source(object, snapshot["schema"]["types"],
                                                [item["id"] for item in selected_criteria(assignment)]))
            assignment["joppa"]["objects"][address] = source(object)
    if snapshot.get("remote"):
        remote = assignment["joppa"].setdefault("remote", {})
        verify_remote(api, remote, snapshot["remote"])
    return assignment
